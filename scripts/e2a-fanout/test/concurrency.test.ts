/**
 * 08-correction Phase 2: own concurrency is counted from receipt intervals
 * (startedAt → terminalAt) with the same sweep method as the parent's and the
 * reviewer's recomputation — never from first-to-last spans.
 */
import { describe, expect, it } from 'vitest';
import { peakConcurrentOwnTurns } from '../lib/concurrency.ts';

describe('peakConcurrentOwnTurns', () => {
  it('finds the peak and its instant from overlapping receipt intervals', () => {
    const out = peakConcurrentOwnTurns([
      { start: 10, end: 100 },
      { start: 20, end: 40 },
      { start: 30, end: 90 },
      { start: 35, end: 60 },
    ]);
    expect(out.peak).toBe(4);
    expect(out.at).toBe(35);
  });

  it('reproduces the parent\'s run-2 recompute shape (7 at the 8th start, 5 GLM + 2 Luna)', () => {
    // Synthetic miniatures of run2-concurrency.txt: at the last start, 7 overlap.
    const t = 41_723;
    const out = peakConcurrentOwnTurns([
      { start: t - 12_000, end: t - 11_900 },
      { start: t - 4_029, end: t + 158_596 },
      { start: t - 3_834, end: t + 232_180 },
      { start: t - 3_597, end: t + 203_178 },
      { start: t - 3_278, end: t + 273_231 },
      { start: t - 3_234, end: t + 230_708 },
      { start: t - 2_344, end: t + 159_108 },
      { start: t, end: t + 166_454 },
    ]);
    expect(out.peak).toBe(7);
    expect(out.at).toBe(t);
  });

  it('returns 0 for an empty set', () => {
    expect(peakConcurrentOwnTurns([])).toEqual({ peak: 0, at: null });
  });

  it('counts an interval as open at its own start (closed at end)', () => {
    const out = peakConcurrentOwnTurns([{ start: 5, end: 10 }, { start: 10, end: 20 }]);
    expect(out.peak).toBe(1); // [5,10) and [10,20) do not overlap
  });
});
