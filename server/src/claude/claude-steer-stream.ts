/**
 * Steerable prompt stream for the Claude Agent SDK streaming-input mode.
 *
 * `query()` accepts an `AsyncIterable<SDKUserMessage>` as its prompt. Keeping
 * that iterable open for the duration of a turn is what makes mid-turn
 * steering possible: each `push()` writes another user message to the CLI's
 * stdin while the current turn is still running.
 *
 * The stream never ends on its own — the caller decides when to close stdin:
 * - `end()` closes immediately (turn finished, nothing queued).
 * - `scheduleEnd(ms)` closes after a grace delay; any push cancels it, so a
 *   follow-up arriving right after a result still lands in the same query.
 */

interface ScheduledEnd {
  timer: NodeJS.Timeout;
}

export class SteerablePromptStream<Message> {
  private queue: Message[] = [];
  private resolveNext: (() => void) | null = null;
  private ended = false;
  private scheduledEnd: ScheduledEnd | null = null;

  /** The async iterable handed to `query({ prompt })`. */
  readonly stream: AsyncIterable<Message> = (async function* (self: SteerablePromptStream<Message>) {
    for (;;) {
      while (self.queue.length === 0) {
        if (self.ended) return;
        await new Promise<void>((resolve) => {
          self.resolveNext = resolve;
        });
        self.resolveNext = null;
      }
      while (self.queue.length > 0) {
        const item = self.queue.shift()!;
        yield item;
      }
      if (self.ended) return;
    }
  })(this);

  /** True when at least one pushed message has not been yielded yet. */
  hasPending(): boolean {
    return this.queue.length > 0;
  }

  /** True once `scheduleEnd` is armed and no push has cancelled it. */
  isEndScheduled(): boolean {
    return this.scheduledEnd !== null;
  }

  /** True once the stream is closed for good. */
  isEnded(): boolean {
    return this.ended;
  }

  /**
   * Queue a message for the CLI. Returns false (and drops nothing silently —
   * the caller must treat false as "not delivered") when the stream already
   * ended. A push cancels any scheduled end so the consumer stays alive.
   */
  push(message: Message): boolean {
    if (this.ended) return false;
    this.cancelScheduledEnd();
    this.queue.push(message);
    this.resolveNext?.();
    return true;
  }

  /** Close the stream as soon as queued messages are drained. */
  end(): void {
    this.cancelScheduledEnd();
    this.ended = true;
    this.resolveNext?.();
  }

  /**
   * Close the stream after `delayMs` unless another push arrives first. Used
   * after a turn result: the CLI goes idle but stdin stays open briefly so an
   * immediately-following steer/follow-up can still be delivered without a
   * whole new query/subprocess.
   */
  scheduleEnd(delayMs: number): void {
    if (this.ended) return;
    this.cancelScheduledEnd();
    this.scheduledEnd = {
      timer: setTimeout(() => {
        this.scheduledEnd = null;
        this.end();
      }, delayMs),
    };
    this.scheduledEnd.timer.unref?.();
  }

  private cancelScheduledEnd(): void {
    if (this.scheduledEnd) {
      clearTimeout(this.scheduledEnd.timer);
      this.scheduledEnd = null;
    }
  }
}
