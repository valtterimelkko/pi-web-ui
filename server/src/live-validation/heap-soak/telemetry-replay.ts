/**
 * Pure replay of the A2 health telemetry (E2a-1's production comparison and
 * the H1 burst's latch record). Reads nothing, writes nothing: every function
 * takes parsed row objects so the numbers are unit-testable and the IO layer
 * stays separate (scripts/e2a-soak/*).
 *
 * Methods are the §2 baseline's, exactly:
 * - a spike minute is a distinct UTC minute containing ≥ 1 reading with
 *   lag p99 ≥ the threshold (300 ms; the B2 gate value);
 * - the heap floor / ceiling are the min/max SAMPLED heapUsedBytes
 *   (production telemetry is not forced-GC — §2 rows state sampled ranges);
 * - a latch is replayed with B2's rule: two consecutive readings ≥ tripMs
 *   latch admission's lag gate; a reading < recoverMs ends the episode.
 */

export interface TelemetryRow {
  atMs: number;
  lagP99Ms: number;
  heapUsedBytes: number;
  activeTurns: number;
}

export interface SpikeMinuteSummary {
  count: number;
  /** ISO UTC minute keys (e.g. "2026-10-02T17:03") with at least one high reading, sorted. */
  minutes: string[];
  /** The highest single reading inside a spike minute (0 when none). */
  maxSpikeMs: number;
}

/** Distinct UTC minutes containing at least one reading at/above `thresholdMs`. */
export function spikeMinuteBuckets(rows: readonly TelemetryRow[], thresholdMs: number): SpikeMinuteSummary {
  const buckets = new Map<number, number>(); // minuteKey → max lag seen in it
  for (const row of rows) {
    if (row.lagP99Ms < thresholdMs) continue;
    const minuteKey = Math.floor(row.atMs / 60_000);
    const seen = buckets.get(minuteKey);
    if (seen === undefined || row.lagP99Ms > seen) buckets.set(minuteKey, row.lagP99Ms);
  }
  const minutes = [...buckets.keys()].sort((a, b) => a - b).map(isoMinute);
  return {
    count: minutes.length,
    minutes,
    maxSpikeMs: buckets.size > 0 ? Math.max(...buckets.values()) : 0,
  };
}

function isoMinute(minuteKey: number): string {
  return new Date(minuteKey * 60_000).toISOString().slice(0, 16);
}

/** Adjacent-row pairs (the sampling cadence apart) where BOTH readings are at/above the threshold. */
export function consecutiveHighPairs(rows: readonly TelemetryRow[], thresholdMs: number): number {
  let pairs = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].lagP99Ms >= thresholdMs && rows[i].lagP99Ms >= thresholdMs) pairs += 1;
  }
  return pairs;
}

export interface HeapRange { minBytes: number | null; maxBytes: number | null }

export function heapRangeBytes(rows: readonly TelemetryRow[]): HeapRange {
  if (rows.length === 0) return { minBytes: null, maxBytes: null };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.heapUsedBytes < min) min = row.heapUsedBytes;
    if (row.heapUsedBytes > max) max = row.heapUsedBytes;
  }
  return { minBytes: min, maxBytes: max };
}

export interface ActiveTurnsSummary { peak: number | null; mean: number | null }

export function peakAndMeanActiveTurns(rows: readonly TelemetryRow[]): ActiveTurnsSummary {
  if (rows.length === 0) return { peak: null, mean: null };
  let peak = 0;
  let sum = 0;
  for (const row of rows) {
    if (row.activeTurns > peak) peak = row.activeTurns;
    sum += row.activeTurns;
  }
  return { peak, mean: sum / rows.length };
}

export interface GateOptions { tripMs: number; recoverMs: number }

export interface LatchEpisode {
  /** atMs of the SECOND high reading (the one that completes the trip condition). */
  startAtMs: number;
  /** atMs of the recovery reading; null when the window ends still latched. */
  endAtMs: number | null;
  peakLagMs: number;
}

/**
 * Replay B2's admission lag gate over a reading series: two consecutive
 * readings ≥ tripMs latch; a reading < recoverMs ends the episode. Pure —
 * this is how the H1 arms decided "latch: no" from A2 metrics lines.
 */
export function replayAdmissionGate(rows: readonly TelemetryRow[], options: GateOptions): LatchEpisode[] {
  const episodes: LatchEpisode[] = [];
  let open: LatchEpisode | null = null;
  let highStreak = 0;
  for (const row of rows) {
    if (open === null) {
      highStreak = row.lagP99Ms >= options.tripMs ? highStreak + 1 : 0;
      if (highStreak >= 2) {
        open = { startAtMs: row.atMs, endAtMs: null, peakLagMs: Math.max(row.lagP99Ms, rows[rows.indexOf(row) - 1]?.lagP99Ms ?? row.lagP99Ms) };
        episodes.push(open);
        highStreak = 0;
      }
    } else if (row.lagP99Ms < options.recoverMs) {
      open.endAtMs = row.atMs;
      open = null;
      highStreak = 0;
    } else if (row.lagP99Ms > open.peakLagMs) {
      open.peakLagMs = row.lagP99Ms;
    }
  }
  return episodes;
}

/** Rows with `fromMs ≤ atMs ≤ toMs` (inclusive bounds; from/to optional). */
export function filterWindow(rows: readonly TelemetryRow[], fromMs?: number, toMs?: number): TelemetryRow[] {
  return rows.filter((row) => (fromMs === undefined || row.atMs >= fromMs) && (toMs === undefined || row.atMs <= toMs));
}

/** Removes flagged stretches (e.g. the E2 stress windows) from a reading series. */
export function excludeWindows(rows: readonly TelemetryRow[], windows: readonly { fromMs: number; toMs: number }[]): TelemetryRow[] {
  if (windows.length === 0) return [...rows];
  return rows.filter((row) => !windows.some((w) => row.atMs >= w.fromMs && row.atMs <= w.toMs));
}
