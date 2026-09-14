/**
 * The systemd watchdog decision, as a pure function.
 *
 * Why this exists (2026-09-14): the service was observed being SIGKILLed after
 * `TimeoutStopSec` four times in one afternoon, and the journal could not say
 * why. Investigating that turned up a structural weakness in the watchdog
 * itself: the `WATCHDOG=1` ping was a `setInterval` **on the event loop it is
 * supposed to be watching**. A ping that lives on the watched loop cannot
 * report that loop's death — when the loop stalls the ping simply stops
 * arriving, and systemd cannot tell "hung" from "busy". The service is then
 * restarted ungracefully, which (because a blocked loop also cannot service
 * SIGTERM) costs a SIGKILL and every in-flight turn with it.
 *
 * The fix is not to disable the watchdog — a hung service must still be
 * detected — but to make it *truthful and observable*:
 *
 *  - the ping is scheduled from a worker thread, so its timing no longer
 *    depends on the main loop's timer scheduling;
 *  - it is gated on a **heartbeat** the main thread writes, so a blocked loop
 *    still stops the pings (systemd's recovery is preserved exactly);
 *  - and the stall is announced *before* the pings stop, so the journal
 *    explains the restart instead of recording only its corpse.
 *
 * This module holds only the decision, deliberately free of timers, threads and
 * I/O, so the policy can be tested directly rather than inferred from
 * behaviour.
 */

/** How often the main thread proves it is alive. */
export const DEFAULT_BEAT_INTERVAL_MS = 2_000;
/** How often the worker thread considers pinging systemd. */
export const DEFAULT_PING_INTERVAL_MS = 5_000;
/**
 * How stale the heartbeat may be before the main thread is treated as stalled.
 *
 * Chosen well below systemd's `WatchdogSec=45` so that the stall warning is
 * emitted, and the pings have already ceased, before systemd acts — the
 * operator gets the reason and the restart, in that order.
 */
export const DEFAULT_STALL_AFTER_MS = 20_000;

export interface WatchdogTickInput {
  /** Wall-clock now, ms since epoch. */
  nowMs: number;
  /** When the main thread last proved liveness; 0 means "has not beaten yet". */
  lastBeatMs: number;
  /** Heartbeat staleness that counts as a stall. */
  stallAfterMs: number;
  /** Whether the previous tick was already stalled, for edge detection. */
  previouslyStalled?: boolean;
}

export interface WatchdogDecision {
  /**
   * Whether this tick may send `WATCHDOG=1`.
   *
   * False during a stall **on purpose**: staying silent is what lets systemd
   * recover a genuinely hung service. Making this true unconditionally would
   * turn the watchdog into a no-op — it would keep certifying a service that
   * had stopped working — which is worse than the bug being fixed.
   */
  ping: boolean;
  /** Observations for logging; the caller decides how loudly to say them. */
  stalled: boolean;
  /** Milliseconds since the last beat (0 when no beat has been seen). */
  stalledMs: number;
  /**
   * True on the first stalled tick of a run, so the caller can announce the
   * stall exactly once instead of flooding the journal every tick.
   */
  stallStarted: boolean;
  /** True when the main thread has beaten recently enough to be trusted. */
  healthy: boolean;
}

/**
 * Decide one watchdog tick.
 *
 * A main thread that has **not beaten yet** is treated as healthy: the worker
 * starts alongside the main thread, and refusing to ping during boot would let
 * systemd kill a service that is simply still starting. The first beat arrives
 * within `DEFAULT_BEAT_INTERVAL_MS`, and a main thread that dies before ever
 * beating stops producing beats, so the stall is still detected on the
 * following tick.
 */
export function decideWatchdogTick(input: WatchdogTickInput): WatchdogDecision {
  const { nowMs, lastBeatMs, stallAfterMs, previouslyStalled = false } = input;

  if (lastBeatMs <= 0) {
    return { ping: true, stalled: false, stalledMs: 0, stallStarted: false, healthy: true };
  }

  const stalledMs = Math.max(0, nowMs - lastBeatMs);
  const stalled = stalledMs > stallAfterMs;
  return {
    ping: !stalled,
    stalled,
    stalledMs,
    // Edge, not level: the caller must be able to announce the stall once
    // rather than repeating it every tick until it clears.
    stallStarted: stalled && !previouslyStalled,
    healthy: !stalled,
  };
}

/**
 * Parse the staleness threshold from the environment, falling back to the
 * default. Kept here so the worker and any test agree on one interpretation.
 *
 * A value at or above systemd's own `WatchdogSec` is still honoured (an
 * operator may deliberately choose "warn but never stop pinging"); the policy
 * does not silently clamp policy the operator has set.
 */
export function parseStallAfterMs(raw: string | undefined, fallback = DEFAULT_STALL_AFTER_MS): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}
