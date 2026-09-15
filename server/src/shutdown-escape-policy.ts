/**
 * The shutdown-escape decision, as a pure function (2026-09-15).
 *
 * Why this exists: the service has been SIGKILLed by systemd after
 * `TimeoutStopSec=30` at least seven times, and on two of those occasions the
 * app's own shutdown handler *did* run but wedged on `server.close()`, so the
 * only thing that ended the stop was systemd's escalation. That escalation has
 * `KillMode=control-group`, so it takes every process in the cgroup with it —
 * `npm run validate:server`, `esbuild`, and four mid-turn orchestration
 * children on 2026-09-15 alone.
 *
 * The graceful path therefore needs a bound that the wedged teardown does not
 * get to control. This module holds only the decision, deliberately free of
 * timers, threads and I/O, so the timing can be tested directly rather than
 * inferred from a live stop.
 */

/**
 * How long the process may remain alive after recording a stop signal before
 * the backstop ends it anyway.
 *
 * Must stay comfortably below systemd's `TimeoutStopSec` (30s in the repo unit
 * and on the host). 12s leaves ~18s of margin: enough for a teardown that is
 * merely slow, far too little for the escalation to reach SIGKILL.
 */
export const DEFAULT_ESCAPE_AFTER_MS = 12_000;

/** How often the backstop worker re-evaluates. */
export const DEFAULT_ESCAPE_POLL_INTERVAL_MS = 1_000;

export interface ShutdownEscapeTickInput {
  /**
   * Epoch ms at which the main thread synchronously recorded the received stop
   * signal. 0 means "no stop signal has been recorded yet".
   */
  signalReceivedAtMs: number;
  /** Wall-clock now, ms since epoch. */
  nowMs: number;
  /** Grace window after the signal before the escape fires. */
  escapeAfterMs: number;
  /** Whether this process has already performed the escape (edge guard). */
  previouslyEscaped?: boolean;
}

export interface ShutdownEscapeDecision {
  /**
   * `idle`  — no stop signal has been seen; do nothing.
   * `wait`  — the signal is recorded and the process is still inside its grace
   *           window; the main thread may still finish cleanly.
   * `escape` — the grace window has passed and the process is still alive.
   */
  action: 'idle' | 'wait' | 'escape';
  /** Milliseconds since the signal was recorded (0 while idle). */
  sinceSignalMs: number;
  /**
   * True only on the first escape tick, so the reason is written exactly once
   * rather than on every tick until the process finally dies.
   */
  escapeStarted: boolean;
}

/**
 * Decide one backstop tick.
 *
 * A signal time of 0 is treated as "no stop in progress" rather than as
 * "recorded at the epoch": the buffer is shared with the main thread and starts
 * zeroed, and a zeroed buffer that made the backstop fire would end every
 * healthy process 12s after boot.
 */
export function decideShutdownEscapeTick(input: ShutdownEscapeTickInput): ShutdownEscapeDecision {
  const { signalReceivedAtMs, nowMs, escapeAfterMs, previouslyEscaped = false } = input;

  if (signalReceivedAtMs <= 0) {
    return { action: 'idle', sinceSignalMs: 0, escapeStarted: false };
  }

  const sinceSignalMs = Math.max(0, nowMs - signalReceivedAtMs);
  if (sinceSignalMs <= escapeAfterMs) {
    return { action: 'wait', sinceSignalMs, escapeStarted: false };
  }

  return { action: 'escape', sinceSignalMs, escapeStarted: !previouslyEscaped };
}

/**
 * Parse the grace window from the environment, falling back to the default.
 * Kept here so the worker and the tests agree on one interpretation.
 */
export function parseEscapeAfterMs(
  raw: string | undefined,
  fallback = DEFAULT_ESCAPE_AFTER_MS,
): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
