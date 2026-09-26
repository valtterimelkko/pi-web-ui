import { describe, expect, it } from 'vitest';
import { computeVerdict, DEFAULT_VERDICT_RULE, leastSquaresSlope, type SlopePoint } from '../../../src/live-validation/heap-soak/slope.js';

function hoursSeries(hourValues: number[]): SlopePoint[] {
  return hourValues.map((v, i) => ({ tMs: i * 3_600_000, valueMB: v }));
}

describe('leastSquaresSlope', () => {
  it('returns zero slope for 0 or 1 points', () => {
    expect(leastSquaresSlope([]).slopeMBPerHour).toBe(0);
    expect(leastSquaresSlope([{ tMs: 0, valueMB: 100 }]).slopeMBPerHour).toBe(0);
  });

  it('fits an exact linear growth of 10 MB/h perfectly (r2 = 1)', () => {
    const points = hoursSeries([100, 110, 120, 130, 140]);
    const result = leastSquaresSlope(points);
    expect(result.slopeMBPerHour).toBeCloseTo(10, 6);
    expect(result.interceptMB).toBeCloseTo(100, 6);
    expect(result.r2).toBeCloseTo(1, 6);
    expect(result.spanHours).toBeCloseTo(4, 6);
  });

  it('fits a flat series as zero slope', () => {
    const points = hoursSeries([500, 500, 500, 500]);
    const result = leastSquaresSlope(points);
    expect(result.slopeMBPerHour).toBeCloseTo(0, 6);
  });

  it('handles noisy-but-flat data with a slope near zero', () => {
    const points = hoursSeries([500, 505, 495, 502, 498, 501]);
    const result = leastSquaresSlope(points);
    expect(Math.abs(result.slopeMBPerHour)).toBeLessThan(2);
  });
});

describe('computeVerdict', () => {
  it('is inconclusive with too little data span', () => {
    const points = hoursSeries([100, 105]); // 1 hour span, only 2 points
    const { verdict } = computeVerdict(points);
    expect(verdict).toBe('inconclusive');
  });

  it('declares a leak when the trailing window sustains growth above the threshold', () => {
    // 20 hours of growth at 20 MB/h — well above the 10 MB/h default threshold.
    const points = hoursSeries(Array.from({ length: 21 }, (_, h) => 100 + h * 20));
    const { verdict, trailing } = computeVerdict(points, DEFAULT_VERDICT_RULE);
    expect(verdict).toBe('leak');
    expect(trailing.slopeMBPerHour).toBeGreaterThan(10);
  });

  it('declares stable when heap climbs early then flattens for the trailing window', () => {
    const early = Array.from({ length: 4 }, (_, h) => 100 + h * 50); // fast climb hours 0-3
    const flat = Array.from({ length: 14 }, () => early[early.length - 1]); // flat hours 4-17
    const points = hoursSeries([...early, ...flat]);
    const { verdict, trailing } = computeVerdict(points, DEFAULT_VERDICT_RULE);
    expect(trailing.slopeMBPerHour).toBeLessThan(10);
    expect(verdict).toBe('stable');
  });
});
