/**
 * Bounded HTTP server close (2026-09-15).
 *
 * Proved defect, twice in one evening. On 2026-09-14 18:04:17 and again at
 * 21:15:56 the shutdown handler ran, five of its six steps completed in under
 * 25 ms, and the `http-server` step then never completed at all:
 *
 *   21:15:56 [Server] Shutdown step 'internal-api' in 4ms
 *   21:16:21 [Server] Forced shutdown: teardown exceeded the deadline
 *
 * `server.close()` invokes its callback only once every open connection has
 * gone, and this process's WebSocket clients are long-lived by design. So the
 * step blocked until the coordinator's own 25s hard-exit fired and exited 1 —
 * with the whole stop sitting a few seconds inside systemd's
 * `TimeoutStopSec=30`. That margin is the entire difference between a recorded
 * stop and a SIGKILL of the control group, and on 2026-09-15 at 08:30 it was a
 * SIGKILL that took four mid-turn orchestration children with it.
 *
 * Closing must therefore be *bounded*: stop listening, actively drop the
 * remaining connections rather than waiting for clients to hang up, and treat a
 * close that still has not called back as done. The process is exiting anyway,
 * and a step that reports "timed-out" is recorded and keeps its place in the
 * timing record instead of silently eating the deadline.
 */

export interface ClosableHttpServer {
  close: (callback: (err?: Error) => void) => unknown;
  /** Node >= 18.2. Absent on injected fakes and older shapes. */
  closeAllConnections?: () => void;
}

export interface CloseHttpServerOptions {
  /** How long to wait for a graceful close before forcing the issue. */
  timeoutMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  /** Called with how long the close took, for the journal's step timings. */
  onClosed?: (durationMs: number) => void;
}

export type CloseHttpServerOutcome = 'closed' | 'timed-out';

/**
 * Close an HTTP server, bounded.
 *
 * Always resolves. On timeout it has already asked Node to drop the lingering
 * connections, so the sockets do not outlive the process.
 */
export async function closeHttpServer(
  server: ClosableHttpServer,
  options: CloseHttpServerOptions = {},
): Promise<CloseHttpServerOutcome> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  const setTimeoutFn = options.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeout ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const startedAt = now();

  // Stop accepting, then actively drop what is already open. Without this,
  // `close()` waits on WebSocket clients that are still connected on purpose.
  try {
    server.closeAllConnections?.();
  } catch {
    /* An implementation without it, or a already-closed server, is not an error. */
  }

  const closed = await new Promise<boolean>((resolve) => {
    // A promise resolves once, so repeated `finish` calls are harmless and no
    // settled flag is needed.
    const finish = (value: boolean): void => { resolve(value); };

    const timer = setTimeoutFn(() => {
      // The close is not coming. Force the remaining sockets down once more —
      // the server may have accepted a connection after the first sweep — and
      // report the outcome rather than blocking teardown.
      try {
        server.closeAllConnections?.();
      } catch {
        /* nothing further to do */
      }
      finish(false);
    }, timeoutMs);

    try {
      server.close(() => { clearTimeoutFn(timer); finish(true); });
    } catch {
      clearTimeoutFn(timer);
      finish(true); // Already closed, or never listening: nothing to wait for.
    }
  });

  options.onClosed?.(now() - startedAt);
  return closed ? 'closed' : 'timed-out';
}
