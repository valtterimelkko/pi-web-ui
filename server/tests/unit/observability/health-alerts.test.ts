import { describe, expect, it } from 'vitest';
import {
  HealthAlertEvaluator,
  HysteresisLatch,
  validateHealthAlertThresholds,
  type HealthAlertThresholds,
} from '../../../src/observability/health-alerts.js';
import type { HealthReadings } from '../../../src/observability/health-readings.js';

const THRESHOLDS: HealthAlertThresholds = {
  heapFractionHigh: 0.8,
  heapFractionLow: 0.7,
  lagP99HighMs: 500,
  lagP99LowMs: 200,
};

function readings(overrides: Partial<HealthReadings> = {}): HealthReadings {
  return {
    at: '2026-09-27T00:00:00.000Z',
    atMs: 0,
    uptimeSec: 1,
    heapUsedBytes: 0,
    heapTotalBytes: 0,
    heapLimitBytes: 0,
    heapFraction: 0,
    rssBytes: 0,
    externalBytes: 0,
    lagWindowMs: 60_000,
    lagSampleCount: 0,
    lagP50Ms: 0,
    lagP99Ms: 0,
    lagMaxMs: 0,
    activeTurnsByClass: {},
    activeTurns: 0,
    residentSessions: null,
    registryEntries: null,
    ...overrides,
  };
}

describe('HysteresisLatch', () => {
  it('fires once on crossing and only recovers below the low threshold', () => {
    const latch = new HysteresisLatch('heap_pressure', 0.8, 0.7);
    expect(latch.evaluate(0.5)).toBeUndefined();
    expect(latch.alerting).toBe(false);
    expect(latch.evaluate(0.8)).toBe('alert');
    expect(latch.alerting).toBe(true);
    // Inside the band: no transition either way (this is the anti-flap rule).
    expect(latch.evaluate(0.75)).toBeUndefined();
    expect(latch.evaluate(0.79)).toBeUndefined();
    expect(latch.alerting).toBe(true);
    expect(latch.evaluate(0.7)).toBe('recovery');
    expect(latch.alerting).toBe(false);
    expect(latch.evaluate(0.71)).toBeUndefined();
    expect(latch.evaluate(0.799)).toBeUndefined();
  });

  it('does not flap on oscillation inside the band and counts one alert per crossing', () => {
    const latch = new HysteresisLatch('heap_pressure', 0.8, 0.7);
    let alerts = 0;
    let recoveries = 0;
    for (const value of [0.81, 0.79, 0.81, 0.75, 0.79, 0.76, 0.8, 0.71]) {
      const transition = latch.evaluate(value);
      if (transition === 'alert') alerts += 1;
      if (transition === 'recovery') recoveries += 1;
    }
    expect({ alerts, recoveries }).toEqual({ alerts: 1, recoveries: 0 });
    expect(latch.evaluate(0.69)).toBe('recovery');
    // A fresh crossing after a recovery is a new alert (not a flap).
    expect(latch.evaluate(0.85)).toBe('alert');
    expect(recoveries + 1).toBe(1);
  });
});

describe('validateHealthAlertThresholds', () => {
  it('accepts a valid band and rejects a non-hysteretic one', () => {
    expect(() => validateHealthAlertThresholds(THRESHOLDS)).not.toThrow();
    expect(() => validateHealthAlertThresholds({ ...THRESHOLDS, heapFractionLow: 0.9 })).toThrow(/heapFractionLow/);
    expect(() => validateHealthAlertThresholds({ ...THRESHOLDS, lagP99LowMs: 600 })).toThrow(/lagP99LowMs/);
    expect(() => validateHealthAlertThresholds({ ...THRESHOLDS, heapFractionHigh: 0 })).toThrow(/heapFractionHigh/);
  });
});

describe('HealthAlertEvaluator', () => {
  it('produces exactly one heap alert and one heap recovery from real readings', () => {
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    expect(evaluator.evaluate(readings({ heapFraction: 0.5 }))).toEqual([]);
    const alert = evaluator.evaluate(readings({ heapFraction: 0.85, heapUsedBytes: 3_600_000_000, heapLimitBytes: 4_288_000_000 }));
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({ kind: 'heap_pressure', transition: 'alert', value: 0.85, threshold: 0.8 });
    expect(alert[0].message).toContain('heap');
    // Flapping inside the band produces nothing.
    expect(evaluator.evaluate(readings({ heapFraction: 0.79 }))).toEqual([]);
    expect(evaluator.evaluate(readings({ heapFraction: 0.81 }))).toEqual([]);
    const recovery = evaluator.evaluate(readings({ heapFraction: 0.69 }));
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ kind: 'heap_pressure', transition: 'recovery', value: 0.69, threshold: 0.7 });
  });

  it('evaluates heap and lag independently in one pass', () => {
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 2000 });
    const alerts = evaluator.evaluate(readings({ heapFraction: 0.9, lagP99Ms: 900 }));
    expect(alerts.map((entry) => `${entry.kind}:${entry.transition}`).sort()).toEqual([
      'event_loop_lag:alert',
      'heap_pressure:alert',
    ]);
    expect(evaluator.snapshot()).toMatchObject({
      heap: { alerting: true, high: 0.8, low: 0.7 },
      lag: { alerting: true, highMs: 500, lowMs: 200 },
    });
  });
});
