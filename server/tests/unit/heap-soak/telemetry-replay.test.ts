import { describe, expect, it } from 'vitest';
import {
  consecutiveHighPairs,
  excludeWindows,
  filterWindow,
  heapRangeBytes,
  peakAndMeanActiveTurns,
  replayAdmissionGate,
  spikeMinuteBuckets,
  type TelemetryRow,
} from '../../../src/live-validation/heap-soak/telemetry-replay.js';

/** Minimal A2-shaped rows for tests (atMs from 2026-10-02T16:47:37Z = 1790971657000). */
const T0 = 1790971657000;
const row = (offsetMs: number, lagP99Ms: number, extras: Partial<TelemetryRow> = {}): TelemetryRow => ({
  atMs: T0 + offsetMs,
  lagP99Ms,
  heapUsedBytes: 200_000_000,
  activeTurns: 0,
  ...extras,
});

describe('spikeMinuteBuckets (§2 method: distinct UTC minutes with ≥1 reading at or above the threshold)', () => {
  it('counts one bucket per minute even when several high readings share it', () => {
    const rows = [
      row(0, 100),
      row(5_000, 320),
      row(20_000, 450),
      row(61_000, 100), // next minute, low
    ];
    const buckets = spikeMinuteBuckets(rows, 300);
    expect(buckets.count).toBe(1);
    expect(buckets.minutes).toHaveLength(1);
    expect(buckets.maxSpikeMs).toBe(450);
  });

  it('counts distinct minutes separately', () => {
    const rows = [row(0, 300), row(60_000, 301), row(120_000, 599)];
    expect(spikeMinuteBuckets(rows, 300).count).toBe(3);
  });

  it('returns zero buckets when nothing reaches the threshold', () => {
    expect(spikeMinuteBuckets([row(0, 299), row(30_000, 11)], 300).count).toBe(0);
  });
});

describe('consecutiveHighPairs (the B2 gate view: adjacent readings both at/above the threshold)', () => {
  it('counts adjacent high pairs only', () => {
    const rows = [row(0, 300), row(30_000, 350), row(60_000, 100), row(90_000, 400), row(120_000, 99)];
    expect(consecutiveHighPairs(rows, 300)).toBe(1);
  });

  it('a single high reading is not a pair', () => {
    expect(consecutiveHighPairs([row(0, 100), row(30_000, 500), row(60_000, 100)], 300)).toBe(0);
  });
});

describe('heapRangeBytes / peakAndMeanActiveTurns', () => {
  it('returns min and max sampled heap and the peak/mean active turns', () => {
    const rows = [
      row(0, 10, { heapUsedBytes: 100, activeTurns: 0 }),
      row(30_000, 10, { heapUsedBytes: 300, activeTurns: 4 }),
      row(60_000, 10, { heapUsedBytes: 200, activeTurns: 2 }),
    ];
    expect(heapRangeBytes(rows)).toEqual({ minBytes: 100, maxBytes: 300 });
    expect(peakAndMeanActiveTurns(rows)).toEqual({ peak: 4, mean: 2 });
  });

  it('empty input yields nulls rather than invented numbers', () => {
    expect(heapRangeBytes([])).toEqual({ minBytes: null, maxBytes: null });
    expect(peakAndMeanActiveTurns([])).toEqual({ peak: null, mean: null });
  });
});

describe('replayAdmissionGate (B2: 300 ms sustained over two readings, recovery below 150 ms)', () => {
  it('latches on two consecutive readings at/above 300 and recovers below 150', () => {
    const rows = [
      row(0, 100),
      row(30_000, 320), // first high
      row(60_000, 410), // second high → latch
      row(90_000, 200), // above recovery, still latched
      row(120_000, 140), // recovery
      row(150_000, 100),
    ];
    const episodes = replayAdmissionGate(rows, { tripMs: 300, recoverMs: 150 });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].startAtMs).toBe(T0 + 60_000);
    expect(episodes[0].endAtMs).toBe(T0 + 120_000);
    expect(episodes[0].peakLagMs).toBe(410);
  });

  it('a single isolated high reading does not latch', () => {
    const rows = [row(0, 350), row(30_000, 100), row(60_000, 350), row(90_000, 100)];
    expect(replayAdmissionGate(rows, { tripMs: 300, recoverMs: 150 })).toHaveLength(0);
  });

  it('reports an episode still open when the window ends latched', () => {
    const rows = [row(0, 310), row(30_000, 320), row(60_000, 330)];
    const episodes = replayAdmissionGate(rows, { tripMs: 300, recoverMs: 150 });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].endAtMs).toBeNull();
  });
});

describe('filterWindow / excludeWindows', () => {
  const rows = [row(0, 10), row(30_000, 10), row(60_000, 10), row(90_000, 10), row(120_000, 10)];

  it('filterWindow is inclusive of both bounds', () => {
    expect(filterWindow(rows, T0 + 30_000, T0 + 90_000)).toHaveLength(3);
  });

  it('excludeWindows removes flagged stretches and keeps the rest in order', () => {
    const kept = excludeWindows(rows, [{ fromMs: T0 + 30_000, toMs: T0 + 60_000 }]);
    expect(kept.map((r) => r.atMs)).toEqual([T0, T0 + 90_000, T0 + 120_000]);
  });

  it('excludeWindows with no flags returns the input unchanged', () => {
    expect(excludeWindows(rows, [])).toEqual(rows);
  });
});
