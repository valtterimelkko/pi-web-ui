/**
 * zai quota guard (owner amendment 2026-09-26): the owner uses zai for other
 * work during the soak, so lane A (which runs on zai/glm-5.3-flash) must stay
 * a polite consumer of the shared zai pool, not compete with them.
 *
 * Source of truth: `agent-os provider-usage --providers zai-glm --json`
 * (read-only, spends no tokens). Real shape (2026-09-26):
 *   { measuredAt, peakWindow: { active, note }, rows: [{ provider: "zai-glm",
 *     state, windows: "5h left 99%", resets: "TIME_LIMIT resets <iso>; 5h resets <iso>",
 *     pool, routes, advisory }] }
 */

export interface ZaiQuotaReading {
  percentLeft?: number;
  resetsAt?: string;
  peakActive: boolean;
  measuredAt?: string;
}

/** Parse the raw `agent-os provider-usage --json` stdout. Returns undefined if the zai-glm row is missing/malformed. */
export function parseProviderUsage(raw: string): ZaiQuotaReading | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object') return undefined;
  const obj = doc as { measuredAt?: unknown; peakWindow?: { active?: unknown }; rows?: unknown };
  const peakActive = obj.peakWindow?.active === true;
  const rows = Array.isArray(obj.rows) ? obj.rows : [];
  const row = rows.find((r): r is { provider: string; windows?: unknown; resets?: unknown } => (
    r && typeof r === 'object' && (r as { provider?: unknown }).provider === 'zai-glm'
  ));
  if (!row) return undefined;

  const windows = typeof row.windows === 'string' ? row.windows : '';
  const percentMatch = windows.match(/5h\s+left\s+(\d+)%/i);
  const percentLeft = percentMatch ? Number(percentMatch[1]) : undefined;

  const resets = typeof row.resets === 'string' ? row.resets : '';
  const resetsMatch = resets.match(/5h\s+resets\s+([0-9T:\-.Z]+)/i);
  const resetsAt = resetsMatch ? resetsMatch[1] : undefined;

  return {
    percentLeft: Number.isFinite(percentLeft) ? percentLeft : undefined,
    resetsAt,
    peakActive,
    measuredAt: typeof obj.measuredAt === 'string' ? obj.measuredAt : undefined,
  };
}

export type QuotaState = 'normal' | 'throttled' | 'paused';

export interface QuotaThresholds {
  /** Enter 'throttled' at or below this percent-left. */
  throttledAtOrBelowPercent: number;
  /** Enter 'paused' at or below this percent-left (or whenever peakWindow.active). */
  pausedAtOrBelowPercent: number;
  /** Only return to 'normal' at or above this percent-left (hysteresis gap vs. throttledAtOrBelowPercent). */
  normalAtOrAbovePercent: number;
}

export const DEFAULT_QUOTA_THRESHOLDS: QuotaThresholds = {
  throttledAtOrBelowPercent: 50,
  pausedAtOrBelowPercent: 30,
  normalAtOrAbovePercent: 60,
};

/**
 * Hysteresis state machine. `nowMs`/`reading.resetsAt` let a paused state also
 * clear once the 5h window has reset and the fresh reading is no longer in
 * paused/throttled territory — not only via crossing `normalAtOrAbovePercent`.
 */
export function nextQuotaState(
  current: QuotaState,
  reading: ZaiQuotaReading,
  thresholds: QuotaThresholds = DEFAULT_QUOTA_THRESHOLDS,
  nowMs: number = Date.now(),
): QuotaState {
  if (reading.peakActive) return 'paused';

  const pct = reading.percentLeft;
  if (pct === undefined) return current; // no usable reading — hold state

  if (pct <= thresholds.pausedAtOrBelowPercent) return 'paused';

  const resetPassed = reading.resetsAt !== undefined && Number.isFinite(Date.parse(reading.resetsAt)) && nowMs >= Date.parse(reading.resetsAt);

  if (current === 'paused') {
    if (pct >= thresholds.normalAtOrAbovePercent) return 'normal';
    if (resetPassed && pct > thresholds.throttledAtOrBelowPercent) return 'normal';
    if (pct <= thresholds.throttledAtOrBelowPercent) return 'throttled';
    return 'paused'; // between throttled and normal thresholds, no reset yet — stay paused (hysteresis)
  }

  if (pct <= thresholds.throttledAtOrBelowPercent) return 'throttled';
  if (pct >= thresholds.normalAtOrAbovePercent) return 'normal';
  return current === 'throttled' ? 'throttled' : 'normal'; // hysteresis band: hold
}

/**
 * Failure handling: a single failed poll keeps the current state (logged,
 * never fatal). 3 consecutive failures move a 'normal' state to 'throttled'
 * until a good reading arrives — an already-degraded state is left alone.
 */
export function nextStateOnPollFailure(current: QuotaState, consecutiveFailures: number): { state: QuotaState; consecutiveFailures: number } {
  const failures = consecutiveFailures + 1;
  if (failures >= 3 && current === 'normal') return { state: 'throttled', consecutiveFailures: failures };
  return { state: current, consecutiveFailures: failures };
}

/** Lane A's effective per-wave target given the current quota state. Paused = 0 (lane A stops entirely this wave). */
export function effectiveBackboneTarget(baseTarget: number, state: QuotaState, minThrottledTarget = 1): number {
  if (state === 'paused') return 0;
  if (state === 'throttled') return Math.min(baseTarget, minThrottledTarget);
  return baseTarget;
}
