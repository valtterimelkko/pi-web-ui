import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HealthAlertEvaluator,
  HealthIncidentGrouper,
  HysteresisLatch,
  validateHealthAlertThresholds,
  type HealthAlert,
  type HealthAlertThresholds,
  type HealthIncidentConfig,
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
    cpuPercentOfCore: null,
    mainThreadCpuPercentOfCore: null,
    mainThreadCpuSource: 'unavailable',
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

/**
 * The grouper's debounce semantics under test: an incident opens after N
 * readings at or above the high water mark inside one un-recovered window, so a
 * single spike never pages; a reading at or below the recovery threshold clears
 * the window. A reading in the dead band is neither high nor recovered, so it
 * neither counts nor clears.
 */
describe('HealthIncidentGrouper', () => {
  // Copied verbatim from the parent's l1/today-sequence.json (sha256
  // 8a6cdc341ea2b4073fb4d44debba040a5e22e50cab461d38f0245cb00e914c35).
  const REPLAY = JSON.parse(readFileSync(
    new URL('../../fixtures/observability/l1-today-lag-sequence.json', import.meta.url),
    'utf8',
  )) as Array<{ at: string; transition: 'alert' | 'recovery'; kind: 'event_loop_lag'; p99Ms: number }>;

  function incidentDriver(config: HealthIncidentConfig, thresholds: HealthAlertThresholds = THRESHOLDS) {
    const evaluator = new HealthAlertEvaluator({ thresholds });
    const grouper = new HealthIncidentGrouper({ thresholds, config });
    return (atMs: number, overrides: Partial<HealthReadings> = {}): HealthAlert[] => {
      const sample = readings({ at: new Date(atMs).toISOString(), atMs, ...overrides });
      return grouper.observe(sample, evaluator.evaluate(sample));
    };
  }

  it('rejects a grouping configuration that cannot group', () => {
    expect(() => new HealthIncidentGrouper({ thresholds: THRESHOLDS, config: { quietPeriodMs: -1, cooldownMs: 0, debounceReadings: 1 } })).toThrow(/quietPeriodMs/);
    expect(() => new HealthIncidentGrouper({ thresholds: THRESHOLDS, config: { quietPeriodMs: 0, cooldownMs: -1, debounceReadings: 1 } })).toThrow(/cooldownMs/);
    expect(() => new HealthIncidentGrouper({ thresholds: THRESHOLDS, config: { quietPeriodMs: 0, cooldownMs: 0, debounceReadings: 0 } })).toThrow(/debounceReadings/);
    expect(() => new HealthIncidentGrouper({ thresholds: THRESHOLDS, config: { quietPeriodMs: 0, cooldownMs: 0, debounceReadings: 1.5 } })).toThrow(/debounceReadings/);
  });

  it('replays the real 2026-09-30 incident as exactly one alert and one recovered message', () => {
    const grouper = new HealthIncidentGrouper({
      thresholds: THRESHOLDS,
      config: { quietPeriodMs: 600_000, cooldownMs: 1_800_000, debounceReadings: 1 },
    });
    const notifications: HealthAlert[] = [];
    for (const event of REPLAY) {
      const sample = readings({ at: event.at, atMs: Date.parse(event.at), lagP99Ms: event.p99Ms });
      notifications.push(...grouper.observe(sample, [{
        kind: 'event_loop_lag',
        transition: event.transition,
        at: event.at,
        value: event.p99Ms,
        threshold: event.transition === 'alert' ? THRESHOLDS.lagP99HighMs : THRESHOLDS.lagP99LowMs,
        message: 'raw evaluator transition',
      }]));
    }
    // The real notification log ends on the last recovery. The quiet period has
    // to elapse before the incident can close, so one more normal reading
    // arrives ten minutes later.
    const closingAt = Date.parse('2026-09-30T07:26:19.535Z');
    notifications.push(...grouper.observe(
      readings({ at: '2026-09-30T07:26:19.535Z', atMs: closingAt, lagP99Ms: 190 }),
      [],
    ));

    expect(notifications.map((entry) => `${entry.kind}:${entry.transition}`)).toEqual([
      'event_loop_lag:alert',
      'event_loop_lag:recovery',
    ]);
    expect(notifications[0].incident).toMatchObject({
      kind: 'event_loop_lag',
      startedAt: REPLAY[0].at,
      peakValue: 1176,
      alertCrossings: 1,
      reopenedDuringCooldown: false,
    });
    expect(notifications[1].incident).toEqual({
      kind: 'event_loop_lag',
      startedAt: REPLAY[0].at,
      endedAt: '2026-09-30T07:26:19.535Z',
      durationMs: closingAt - Date.parse(REPLAY[0].at),
      peakValue: 12_064,
      alertCrossings: 6,
      reopenedDuringCooldown: false,
    });
    expect(notifications[1].message).toContain('12064 ms');
    expect(notifications[1].message).toContain('6 alert crossings');
    expect(notifications[1].message).toContain('29m 29s');
  });

  it('closes only after the metric stayed at or below recovery for the whole quiet period', () => {
    const drive = incidentDriver({ quietPeriodMs: 60_000, cooldownMs: 0, debounceReadings: 1 });
    expect(drive(0, { heapFraction: 0.9 })).toHaveLength(1); // alert
    expect(drive(30_000, { heapFraction: 0.5 })).toHaveLength(0); // below low: quiet clock starts
    expect(drive(45_000, { heapFraction: 0.75 })).toHaveLength(0); // dead band: quiet clock resets
    expect(drive(75_000, { heapFraction: 0.5 })).toHaveLength(0); // quiet clock starts again
    expect(drive(134_999, { heapFraction: 0.5 })).toHaveLength(0); // 59.999 s below low: not yet
    const closed = drive(135_000, { heapFraction: 0.5 }); // exactly 60 s: closes
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ kind: 'heap_pressure', transition: 'recovery' });
    expect(closed[0].incident).toMatchObject({
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(135_000).toISOString(),
      durationMs: 135_000,
    });
  });

  it('suppresses a new alert inside the cooldown and reports the silent reopen on recovery', () => {
    const drive = incidentDriver({ quietPeriodMs: 10_000, cooldownMs: 60_000, debounceReadings: 1 });
    // Incident 1: opens at 0, recovers at 20 s, closes at 30 s.
    expect(drive(0, { heapFraction: 0.9 })).toHaveLength(1);
    expect(drive(20_000, { heapFraction: 0.5 })).toHaveLength(0);
    const firstClosed = drive(30_000, { heapFraction: 0.5 });
    expect(firstClosed).toHaveLength(1);
    expect(firstClosed[0].incident?.reopenedDuringCooldown).toBe(false);

    // Incident 2 opens 10 s into the 60 s cooldown: no alert message.
    expect(drive(40_000, { heapFraction: 0.9 })).toHaveLength(0);
    expect(drive(50_000, { heapFraction: 0.5 })).toHaveLength(0);
    const silentClose = drive(60_000, { heapFraction: 0.5 });
    expect(silentClose).toHaveLength(1);
    expect(silentClose[0]).toMatchObject({ kind: 'heap_pressure', transition: 'recovery' });
    expect(silentClose[0].incident).toMatchObject({ reopenedDuringCooldown: true, startedAt: new Date(40_000).toISOString() });
    expect(silentClose[0].message).toContain('during the cooldown');

    // Incident 3 opens after the cooldown (60 s close + 60 s cooldown = 120 s): alerts again.
    const third = drive(130_000, { heapFraction: 0.9 });
    expect(third).toHaveLength(1);
    expect(third[0]).toMatchObject({ kind: 'heap_pressure', transition: 'alert' });
    expect(third[0].incident).toMatchObject({ reopenedDuringCooldown: false, startedAt: new Date(130_000).toISOString() });
  });

  it('debounces a single spike and opens after N high readings inside one un-recovered window', () => {
    const drive = incidentDriver({ quietPeriodMs: 0, cooldownMs: 0, debounceReadings: 2 });
    expect(drive(0, { heapFraction: 0.9 })).toHaveLength(0); // one high reading: pending
    expect(drive(30_000, { heapFraction: 0.5 })).toHaveLength(0); // recovered: window clears
    expect(drive(60_000, { heapFraction: 0.9 })).toHaveLength(0); // streak restarts
    const opened = drive(90_000, { heapFraction: 0.91 }); // second high reading: opens
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: 'heap_pressure', transition: 'alert' });
    expect(opened[0].incident).toMatchObject({
      startedAt: new Date(60_000).toISOString(),
      peakValue: 0.91,
      alertCrossings: 1,
    });

    // A dead-band reading neither counts as high nor clears the window.
    const drive2 = incidentDriver({ quietPeriodMs: 0, cooldownMs: 0, debounceReadings: 2 });
    expect(drive2(0, { heapFraction: 0.9 })).toHaveLength(0);
    expect(drive2(30_000, { heapFraction: 0.75 })).toHaveLength(0);
    const opened2 = drive2(60_000, { heapFraction: 0.92 });
    expect(opened2).toHaveLength(1);
    expect(opened2[0].incident).toMatchObject({
      startedAt: new Date(0).toISOString(),
      peakValue: 0.92,
      alertCrossings: 1,
    });
  });

  it('groups heap and lag independently in one reading', () => {
    const drive = incidentDriver({ quietPeriodMs: 60_000, cooldownMs: 0, debounceReadings: 1 });
    const both = drive(0, { heapFraction: 0.9, lagP99Ms: 900 });
    expect(both.map((entry) => `${entry.kind}:${entry.transition}`)).toEqual([
      'heap_pressure:alert',
      'event_loop_lag:alert',
    ]);
    // While both incidents are open nothing else is sent.
    expect(drive(30_000, { heapFraction: 0.91, lagP99Ms: 950 })).toHaveLength(0);
    // Heap recovers at 60 s (quiet clock starts) while lag stays high.
    expect(drive(60_000, { heapFraction: 0.5, lagP99Ms: 900 })).toHaveLength(0);
    // The heap incident closes after its own quiet period, with lag still open.
    const heapClosed = drive(120_000, { heapFraction: 0.5, lagP99Ms: 900 });
    expect(heapClosed.map((entry) => `${entry.kind}:${entry.transition}`)).toEqual(['heap_pressure:recovery']);
    // Lag keeps its own clock: quiet starts at 150 s, closes at 210 s.
    expect(drive(150_000, { heapFraction: 0.5, lagP99Ms: 50 })).toHaveLength(0);
    const lagClosed = drive(210_000, { heapFraction: 0.5, lagP99Ms: 50 });
    expect(lagClosed.map((entry) => `${entry.kind}:${entry.transition}`)).toEqual(['event_loop_lag:recovery']);
  });
});
