/**
 * The B2 lag-gate latch model, mirrored from
 * server/src/internal-api/admission-controller.ts, plus pi-orch retry
 * derivation from its documented transport policy
 * (pi-orch src/transport.ts: maxAttempts 3, maxTotalWaitMs 120 s,
 * capPerWaitMs 30 s, Retry-After waited in full).
 */
import type { LatchWindow } from './types.ts';

export interface LatchConfig {
  thresholdMs: number;
  recoveryMs: number;
  sustainedReadings: number;
}

export interface LagReading {
  atMs: number;
  /** null = the reading had no lag samples; the server ignores these entirely. */
  p99Ms: number | null;
}

/**
 * Replayed latch windows from an A2 p99 series.
 * - streak counts CONSECUTIVE readings with p99 >= thresholdMs;
 *   any reading below the threshold (that does not release) resets it.
 * - latch fires on the reading that completes the sustained streak;
 *   latchedAtMs is that reading's atMs (admission refuses from then on).
 * - release fires on the first reading strictly below recoveryMs.
 */
export function computeLatchWindows(readings: LagReading[], cfg: LatchConfig): LatchWindow[] {
  const windows: LatchWindow[] = [];
  let streak = 0;
  let open: LatchWindow | null = null;
  for (const r of readings) {
    if (r.p99Ms === null) continue; // ignored by the server too
    if (open === null) {
      if (r.p99Ms >= cfg.thresholdMs) {
        streak += 1;
        if (streak >= cfg.sustainedReadings) {
          open = { latchedAtMs: r.atMs, releasedAtMs: null, open: true, peakP99Ms: r.p99Ms };
          windows.push(open);
        }
      } else {
        streak = 0;
      }
    } else {
      if (r.p99Ms >= open.peakP99Ms) open.peakP99Ms = r.p99Ms;
      if (r.p99Ms < cfg.recoveryMs) {
        open.releasedAtMs = r.atMs;
        open.open = false;
        open = null;
        streak = 0;
      }
    }
  }
  return windows;
}

export function isLatchedAt(windows: LatchWindow[], atMs: number): boolean {
  return windows.some((w) => w.latchedAtMs <= atMs && (w.releasedAtMs === null || atMs < w.releasedAtMs));
}

/**
 * pi-orch retries a 429/503-with-Retry-After internally (3 attempts, ≤120 s
 * total wait). The CLI surfaces only the final outcome, so the retry fact is
 * DERIVED, never observed: a successful spawn whose wall time covers at least
 * one full Retry-After wait must have retried; exit 10 means the budget was
 * exhausted; anything else is unknown.
 */
export const RETRY_WAIT_FLOOR_MS = 15_000;

export function deriveRetry(input: { exitCode: number | null; ok: boolean; wallMs: number }): 'no' | 'derived-yes' | 'derived-budget-exhausted' | 'unknown' {
  if (input.exitCode === 10) return 'derived-budget-exhausted';
  if (input.ok && input.exitCode === 0) return input.wallMs >= RETRY_WAIT_FLOOR_MS ? 'derived-yes' : 'no';
  return 'unknown';
}
