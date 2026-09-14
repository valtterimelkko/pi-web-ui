/**
 * Single-flight, resilient process shutdown.
 *
 * The entry-point `shutdown()` previously had no shared-promise guard: two
 * signals arriving close together (SIGINT during SIGTERM, or an uncaught
 * exception during shutdown) re-ran teardown and stacked `process.exit(1)`
 * force-timers labelled "Forced shutdown". This coordinator guarantees:
 *
 * - one in-flight teardown (extra triggers return the same promise);
 * - every owner is attempted even if an earlier step throws;
 * - normal completion exits 0 and cancels the force timer;
 * - a hard exit(1) fires only if teardown exceeds a deadline kept below
 *   systemd's `TimeoutStopSec` window.
 *
 * Timers and `exit` are injectable so the behaviour is unit-testable without
 * terminating the test runner.
 */

export interface ShutdownStep {
  name: string;
  run: () => Promise<void> | void;
}

export interface ShutdownCoordinatorOptions {
  steps: ShutdownStep[];
  /** Hard exit(1) after this many ms if teardown hasn't completed. Default 25000 (below systemd 30s). */
  forceExitAfterMs?: number;
  /** Injectable; default `process.exit`. */
  exit?: (code: number) => void;
  /** Injectable; default Node `setTimeout`. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Injectable; default Node `clearTimeout`. */
  clearTimeout?: (timer: unknown) => void;
  /** Called (non-fatal) when a step throws; teardown continues. */
  onStepError?: (name: string, err: unknown) => void;
  /** Called when the deadline fires before teardown completes. */
  onForceExit?: () => void;
  /**
   * Called after each step settles, with how long it took (2026-09-14).
   *
   * Added because four systemd SIGKILLs in one afternoon could not be
   * explained: teardown either completed or it did not, and the journal said
   * nothing about which owner was slow. Timing every step turns "shutdown
   * exceeded the deadline" into "websocket-clients took 26s".
   */
  onStepComplete?: (name: string, durationMs: number, failed: boolean) => void;
  /** Called once when teardown finishes, with the total duration. */
  onComplete?: (totalMs: number) => void;
  /** Injectable clock; default `Date.now`. */
  now?: () => number;
}

/** Default deadline: below systemd's `TimeoutStopSec=30`. */
export const DEFAULT_FORCE_EXIT_AFTER_MS = 25000;

export class ShutdownCoordinator {
  private promise: Promise<void> | null = null;
  private readonly steps: ShutdownStep[];
  private readonly forceExitAfterMs: number;
  private readonly exit: (code: number) => void;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (timer: unknown) => void;
  private readonly onStepError?: (name: string, err: unknown) => void;
  private readonly onForceExit?: () => void;
  private readonly onStepComplete?: (name: string, durationMs: number, failed: boolean) => void;
  private readonly onComplete?: (totalMs: number) => void;
  private readonly now: () => number;

  constructor(opts: ShutdownCoordinatorOptions) {
    this.steps = opts.steps;
    this.forceExitAfterMs = opts.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_AFTER_MS;
    this.exit = opts.exit ?? ((code) => process.exit(code));
    this.setTimeoutFn = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeout ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.onStepError = opts.onStepError;
    this.onForceExit = opts.onForceExit;
    this.onStepComplete = opts.onStepComplete;
    this.onComplete = opts.onComplete;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Begin (or join) the single in-flight teardown. */
  shutdown(): Promise<void> {
    if (this.promise) return this.promise;
    this.promise = this.run();
    return this.promise;
  }

  private async run(): Promise<void> {
    const startedAt = this.now();
    const timer = this.setTimeoutFn(() => {
      this.onForceExit?.();
      this.exit(1);
    }, this.forceExitAfterMs);
    try {
      for (const step of this.steps) {
        const stepStartedAt = this.now();
        let failed = false;
        try {
          await step.run();
        } catch (err) {
          // An owner failing must not skip the remaining owners.
          failed = true;
          this.onStepError?.(step.name, err);
        } finally {
          // In `finally` so a slow FAILING step is timed too — otherwise the
          // worst offenders are exactly the ones that go unmeasured.
          this.onStepComplete?.(step.name, this.now() - stepStartedAt, failed);
        }
      }
      this.clearTimeoutFn(timer);
      this.onComplete?.(this.now() - startedAt);
      this.exit(0);
    } catch {
      this.clearTimeoutFn(timer);
      this.exit(1);
    }
  }
}
