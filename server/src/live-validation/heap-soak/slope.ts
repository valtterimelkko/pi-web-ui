/**
 * Least-squares slope and leak-verdict rules for the heap soak report.
 *
 * All inputs are plain {tMs, valueMB} points (post-GC heapUsed samples, or a
 * sub-range for a phase) so this stays pure and independent of CSV parsing.
 */

export interface SlopePoint {
  tMs: number;
  valueMB: number;
}

export interface SlopeResult {
  /** MB per hour, positive means growing. */
  slopeMBPerHour: number;
  interceptMB: number;
  /** Coefficient of determination, 0..1 (1 = perfect fit). NaN if <2 points. */
  r2: number;
  sampleCount: number;
  spanHours: number;
}

const MS_PER_HOUR = 3_600_000;

/** Ordinary least squares of valueMB against elapsed hours. */
export function leastSquaresSlope(points: readonly SlopePoint[]): SlopeResult {
  const n = points.length;
  if (n === 0) {
    return { slopeMBPerHour: 0, interceptMB: 0, r2: NaN, sampleCount: 0, spanHours: 0 };
  }
  if (n === 1) {
    return { slopeMBPerHour: 0, interceptMB: points[0].valueMB, r2: NaN, sampleCount: 1, spanHours: 0 };
  }
  const t0 = points[0].tMs;
  const xs = points.map((p) => (p.tMs - t0) / MS_PER_HOUR);
  const ys = points.map((p) => p.valueMB);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * xs[i];
    ssRes += (ys[i] - predicted) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return {
    slopeMBPerHour: slope,
    interceptMB: intercept,
    r2,
    sampleCount: n,
    spanHours: xs[xs.length - 1] - xs[0],
  };
}

export type LeakVerdict = 'leak' | 'stable' | 'inconclusive';

export interface VerdictRule {
  /** Sustained post-GC slope above this (MB/h) over the trailing window is a leak. */
  slopeThresholdMBPerHour: number;
  /** The trailing window (hours) the slope must be sustained over. */
  trailingWindowHours: number;
  /** Minimum span of data required to render any verdict other than 'inconclusive'. */
  minSpanHoursForVerdict: number;
}

export const DEFAULT_VERDICT_RULE: VerdictRule = {
  slopeThresholdMBPerHour: 10,
  trailingWindowHours: 12,
  minSpanHoursForVerdict: 1,
};

/**
 * Verdict rule (documented, not hidden in the report prose): a leak is
 * declared when the post-GC heap slope over the trailing `trailingWindowHours`
 * of the run exceeds `slopeThresholdMBPerHour`, sustained (not just the
 * whole-run average — a fast early climb that then flattens is 'stable', not
 * 'leak'). Below `minSpanHoursForVerdict` of data, the verdict is
 * 'inconclusive' rather than a false positive/negative from too few samples.
 */
export function computeVerdict(
  allPoints: readonly SlopePoint[],
  rule: VerdictRule = DEFAULT_VERDICT_RULE,
): { verdict: LeakVerdict; overall: SlopeResult; trailing: SlopeResult; rule: VerdictRule } {
  const overall = leastSquaresSlope(allPoints);
  if (overall.spanHours < rule.minSpanHoursForVerdict || allPoints.length < 3) {
    return { verdict: 'inconclusive', overall, trailing: overall, rule };
  }
  const lastT = allPoints[allPoints.length - 1].tMs;
  const windowStart = lastT - rule.trailingWindowHours * MS_PER_HOUR;
  const trailingPoints = allPoints.filter((p) => p.tMs >= windowStart);
  const trailing = trailingPoints.length >= 3 ? leastSquaresSlope(trailingPoints) : overall;
  const verdict: LeakVerdict = trailing.slopeMBPerHour > rule.slopeThresholdMBPerHour ? 'leak' : 'stable';
  return { verdict, overall, trailing, rule };
}
