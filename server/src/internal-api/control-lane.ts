/**
 * Bounded concurrency lane for P0/P1 control operations.
 *
 * Control operations (cancel, evidence, run-receipt, session control, approval,
 * delete) bypass execution admission deliberately — they must remain reachable
 * while P2/P3 execution is saturated. But "bypass" must not mean "unbounded": a
 * flood of control requests could monopolise the shared event loop, memory, and
 * sockets that P0/P1 also depend on. This lane caps concurrent control-handler
 * executions and QUEUES excess requests (up to a timeout) rather than refusing
 * them — the explicit guardrail that makes the bypass safe.
 *
 * It does NOT by itself protect control from shared-resource contention caused by
 * in-flight P2 turns (that requires process isolation, Phase 6); it bounds the
 * control side of that shared surface.
 */
export class ControlLaneFullError extends Error {
  constructor() {
    super('control lane full');
    this.name = 'ControlLaneFullError';
  }
}

export class BoundedControlLane {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

  /**
   * @param maxConcurrent hard cap on simultaneous in-flight control operations.
   * @param queueTimeoutMs how long an excess request waits for a slot before failing.
   * @param maxQueued hard cap on queued waiters; excess requests fail fast
   *   (ControlLaneFullError) instead of growing the queue without bound.
   */
  constructor(
    private readonly maxConcurrent: number,
    private readonly queueTimeoutMs: number,
    private readonly maxQueued: number,
  ) {
    if (maxConcurrent < 1) throw new Error('BoundedControlLane maxConcurrent must be >= 1');
    if (maxQueued < 0) throw new Error('BoundedControlLane maxQueued must be >= 0');
  }

  /** Current in-flight control operations (diagnostics). */
  get inFlight(): number {
    return this.active;
  }

  /** Number of control operations queued waiting for a slot (diagnostics). */
  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<{ release: () => void }> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiters.length >= this.maxQueued) throw new ControlLaneFullError();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = this.waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error('control lane queue timeout'));
        }, this.queueTimeoutMs);
        this.waiters.push({ resolve, reject, timer });
      });
    }
    this.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        const next = this.waiters.shift();
        if (next) {
          clearTimeout(next.timer);
          next.resolve();
        }
      },
    };
  }
}
