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
 * consecutive readings at or above the high water mark, so a single spike never
 * pages. A reading below the high mark breaks the run; a genuine recovery (at
 * or below the recovery threshold) clears the pending window (start, peak,
 * crossings), while a dead-band reading only breaks the run.
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

  it('anchors the cooldown on the first crossing, not on the debounce completion (reviewer case)', () => {
    const drive = incidentDriver({ quietPeriodMs: 0, cooldownMs: 60_000, debounceReadings: 2 });
    // Incident 1: first high at 0, opens at 1,000 ms, closes at 2,000 ms.
    expect(drive(0, { heapFraction: 0.9 })).toHaveLength(0);
    expect(drive(1_000, { heapFraction: 0.9 })).toHaveLength(1);
    const firstClose = drive(2_000, { heapFraction: 0.5 });
    expect(firstClose).toHaveLength(1);
    expect(firstClose[0].transition).toBe('recovery');
    // The next crossing begins at 61,999 ms (inside the 60 s cooldown) and its
    // second consecutive high at 62,000 ms completes the debounce exactly on the
    // boundary. Anchored on the first crossing it is still suppressed, so it is
    // reported as a silent reopen, not as a new alert.
    expect(drive(61_999, { heapFraction: 0.9 })).toHaveLength(0);
    expect(drive(62_000, { heapFraction: 0.9 })).toHaveLength(0);
    const silentClose = drive(63_000, { heapFraction: 0.5 });
    expect(silentClose).toHaveLength(1);
    expect(silentClose[0]).toMatchObject({ kind: 'heap_pressure', transition: 'recovery' });
    expect(silentClose[0].incident).toMatchObject({
      startedAt: new Date(61_999).toISOString(),
      reopenedDuringCooldown: true,
    });
    expect(silentClose[0].message).toContain('during the cooldown');
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

    // A dead-band reading breaks the consecutive run but keeps the pending
    // window, so the summary still spans the whole excursion.
    const drive2 = incidentDriver({ quietPeriodMs: 0, cooldownMs: 0, debounceReadings: 2 });
    expect(drive2(0, { heapFraction: 0.9 })).toHaveLength(0);
    expect(drive2(30_000, { heapFraction: 0.75 })).toHaveLength(0);
    expect(drive2(60_000, { heapFraction: 0.92 })).toHaveLength(0); // run of one again
    const opened2 = drive2(90_000, { heapFraction: 0.93 });
    expect(opened2).toHaveLength(1);
    expect(opened2[0].incident).toMatchObject({
      startedAt: new Date(0).toISOString(),
      peakValue: 0.93,
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

/**
 * J3 — admission vs runtime turn-count mismatch detector. One-sided by design:
 * admission holding MORE active turns than the runtime telemetry is the leak
 * direction (a permit that is never released shrinks capacity silently); the
 * reverse happens legitimately (receipts joined to another turn's permit). A
 * leaked permit is planted as admission counts 1 / runtime 0.
 */
describe('turn-count mismatch (J3)', () => {
  const leak = (overrides: Partial<HealthReadings> = {}): HealthReadings => readings({
    activeTurnsByClass: { pi: 0 },
    admissionActiveTurns: 1,
    admissionTurnsByClass: { P0: 0, P1: 0, P2: 1, P3: 0 },
    admissionTurnsByRuntime: { pi: 1, claude: 0, opencode: 0, antigravity: 0, commandcode: 0 },
    ...overrides,
  });
  const agree = (overrides: Partial<HealthReadings> = {}): HealthReadings => readings({
    activeTurnsByClass: { pi: 0 },
    admissionActiveTurns: 0,
    admissionTurnsByClass: { P0: 0, P1: 0, P2: 0, P3: 0 },
    admissionTurnsByRuntime: { pi: 0, claude: 0, opencode: 0, antigravity: 0, commandcode: 0 },
    ...overrides,
  });

  it('fires exactly one alert on the Nth consecutive disagreeing reading and names the classes', () => {
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    expect(evaluator.evaluate(leak({ atMs: 1000 }))).toEqual([]);
    expect(evaluator.evaluate(leak({ atMs: 31_000 }))).toEqual([]);
    const alert = evaluator.evaluate(leak({ atMs: 61_000 }));
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({ kind: 'turn_count_mismatch', transition: 'alert', value: 1 });
    expect(alert[0].message).toContain('P2');
    expect(alert[0].message).toContain('1');
    expect(alert[0].message).toContain('pi');
    // Still armed: further disagreeing readings produce nothing.
    expect(evaluator.evaluate(leak({ atMs: 91_000 }))).toEqual([]);
  });

  it('never fires on a genuine turn boundary (one disagreeing reading between agreeing ones)', () => {
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    expect(evaluator.evaluate(agree())).toEqual([]);
    // Turn starts: admission acquired the permit, operational metrics lag one async hop.
    expect(evaluator.evaluate(leak())).toEqual([]);
    // Turn recorded: agreement again.
    expect(evaluator.evaluate(agree({ activeTurnsByClass: { pi: 1 }, admissionActiveTurns: 1, admissionTurnsByClass: { P0: 0, P1: 0, P2: 1, P3: 0 }, admissionTurnsByRuntime: { pi: 1, claude: 0, opencode: 0, antigravity: 0, commandcode: 0 } }))).toEqual([]);
    // Turn ends: release and terminal race the other way.
    expect(evaluator.evaluate(leak())).toEqual([]);
    expect(evaluator.evaluate(agree())).toEqual([]);
    expect(evaluator.snapshot().turnCountMismatch).toMatchObject({ alerting: false });
  });

  it('recovers exactly once after the agreement holds, and a single agreement does not recover', () => {
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    evaluator.evaluate(leak());
    evaluator.evaluate(leak());
    expect(evaluator.evaluate(leak({ atMs: 61_000 }))).toHaveLength(1);
    // One agreeing reading (a boundary race) does NOT recover.
    expect(evaluator.evaluate(agree())).toEqual([]);
    expect(evaluator.evaluate(leak())).toEqual([]);
    // Agreement held for R=2 consecutive readings recovers exactly once.
    expect(evaluator.evaluate(agree())).toEqual([]);
    const recovery = evaluator.evaluate(agree());
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ kind: 'turn_count_mismatch', transition: 'recovery', value: 0 });
    expect(evaluator.evaluate(agree())).toEqual([]);
  });

  it('never fires in the reverse direction (runtime active without a permit is legitimate)', () => {
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    for (let i = 0; i < 6; i += 1) {
      expect(evaluator.evaluate(readings({ activeTurnsByClass: { pi: 2 }, admissionActiveTurns: 0, admissionTurnsByClass: { P0: 0, P1: 0, P2: 0, P3: 0 } }))).toEqual([]);
    }
  });

  it('never evaluates when admission is unwired (fields absent)', () => {
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    for (let i = 0; i < 5; i += 1) {
      expect(evaluator.evaluate(readings())).toEqual([]);
    }
    expect(evaluator.snapshot().turnCountMismatch).toMatchObject({ alerting: false });
  });

  it('catches a per-runtime excess even when the totals agree', () => {
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    const crossed = readings({
      activeTurnsByClass: { pi: 0, claude: 2 },
      admissionActiveTurns: 2,
      admissionTurnsByClass: { P0: 0, P1: 0, P2: 2, P3: 0 },
      admissionTurnsByRuntime: { pi: 1, claude: 1, opencode: 0, antigravity: 0, commandcode: 0 },
    });
    expect(evaluator.evaluate(crossed)).toEqual([]);
    expect(evaluator.evaluate(crossed)).toEqual([]);
    const alert = evaluator.evaluate(crossed);
    expect(alert).toHaveLength(1);
    expect(alert[0].message).toContain('pi');
  });

  it('rejects non-positive reading counts in the thresholds', () => {
    expect(() => validateHealthAlertThresholds({ ...THRESHOLDS, turnCountMismatchAlertReadings: 0 })).toThrow(/turnCountMismatchAlertReadings/);
    expect(() => validateHealthAlertThresholds({ ...THRESHOLDS, turnCountMismatchRecoveryReadings: 0 })).toThrow(/turnCountMismatchRecoveryReadings/);
    expect(() => validateHealthAlertThresholds({ ...THRESHOLDS, turnCountMismatchAlertReadings: 1.5 })).toThrow(/turnCountMismatchAlertReadings/);
  });

  it('folds the mismatch into exactly one incident alert and one recovered notification', () => {
    const grouper = new HealthIncidentGrouper({
      thresholds: THRESHOLDS,
      config: { quietPeriodMs: 0, cooldownMs: 0, debounceReadings: 2 },
    });
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    // Driven exactly as the sampler drives it: evaluator transitions feed the grouper.
    const drive = (r: HealthReadings): HealthAlert[] => grouper.observe(r, evaluator.evaluate(r));
    expect(drive(leak({ atMs: 1000 }))).toEqual([]);
    expect(drive(leak({ atMs: 31_000 }))).toEqual([]);
    const opened = drive(leak({ atMs: 61_000 }));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: 'turn_count_mismatch', transition: 'alert' });
    expect(opened[0].incident).toMatchObject({ alertCrossings: 1 });
    expect(opened[0].message).toContain('P2');
    // Raw alert only at the arm reading; the incident stays open while the excess persists.
    expect(drive(leak({ atMs: 91_000 }))).toEqual([]);
    // quietPeriodMs 0: the first agreeing reading closes the incident — exactly one recovery.
    const closed = drive(agree({ atMs: 121_000 }));
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ kind: 'turn_count_mismatch', transition: 'recovery' });
    expect(closed[0].incident).toMatchObject({ durationMs: 120_000, alertCrossings: 1 });
    expect(drive(agree({ atMs: 151_000 }))).toEqual([]);
    // A lone boundary-race reading after the close must never re-page.
    expect(drive(leak({ atMs: 181_000 }))).toEqual([]);
  });
});

/**
 * Correction 02, finding 2: three states — leak (admission > telemetry),
 * equal, reverse (telemetry > admission). Reverse stays non-alerting but must
 * neither open nor close an incident; only equal readings count towards
 * recovery.
 */
describe('turn-count mismatch tri-state (correction 02)', () => {
  const leak = (overrides: Partial<HealthReadings> = {}): HealthReadings => readings({
    activeTurnsByClass: { pi: 0 },
    admissionActiveTurns: 1,
    admissionTurnsByClass: { P0: 0, P1: 0, P2: 1, P3: 0 },
    admissionTurnsByRuntime: { pi: 1, claude: 0, opencode: 0, antigravity: 0, commandcode: 0 },
    ...overrides,
  });
  const equal = (overrides: Partial<HealthReadings> = {}): HealthReadings => readings({
    activeTurnsByClass: { pi: 0 },
    admissionActiveTurns: 0,
    admissionTurnsByClass: { P0: 0, P1: 0, P2: 0, P3: 0 },
    admissionTurnsByRuntime: { pi: 0, claude: 0, opencode: 0, antigravity: 0, commandcode: 0 },
    ...overrides,
  });
  const reverse = (overrides: Partial<HealthReadings> = {}): HealthReadings => readings({
    activeTurnsByClass: { pi: 1, claude: 1 },
    admissionActiveTurns: 0,
    admissionTurnsByClass: { P0: 0, P1: 0, P2: 0, P3: 0 },
    admissionTurnsByRuntime: { pi: 0, claude: 0, opencode: 0, antigravity: 0, commandcode: 0 },
    ...overrides,
  });

  it('does not recover on reverse readings — only equal readings count (evaluator)', () => {
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    evaluator.evaluate(leak({ atMs: 1000 }));
    evaluator.evaluate(leak({ atMs: 31_000 }));
    expect(evaluator.evaluate(leak({ atMs: 61_000 }))).toHaveLength(1); // armed
    // Two reverse readings: still armed, no recovery, no new alert.
    expect(evaluator.evaluate(reverse({ atMs: 91_000 }))).toEqual([]);
    expect(evaluator.evaluate(reverse({ atMs: 121_000 }))).toEqual([]);
    // Two equal readings recover exactly once.
    expect(evaluator.evaluate(equal({ atMs: 151_000 }))).toEqual([]);
    const recovery = evaluator.evaluate(equal({ atMs: 181_000 }));
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ kind: 'turn_count_mismatch', transition: 'recovery' });
  });

  it('a reverse reading breaks the arm run without recovering (latch tri-state)', () => {
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    expect(evaluator.evaluate(leak({ atMs: 1000 }))).toEqual([]);
    expect(evaluator.evaluate(leak({ atMs: 31_000 }))).toEqual([]);
    // A reverse reading between leaks breaks the consecutive-leak run...
    expect(evaluator.evaluate(reverse({ atMs: 61_000 }))).toEqual([]);
    expect(evaluator.evaluate(leak({ atMs: 91_000 }))).toEqual([]);
    expect(evaluator.evaluate(leak({ atMs: 121_000 }))).toEqual([]);
    // ...so the alert arms on the third CONSECUTIVE leak reading.
    const alert = evaluator.evaluate(leak({ atMs: 151_000 }));
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({ kind: 'turn_count_mismatch', transition: 'alert', value: 1 });
  });

  it('keeps the incident open through a reverse interval longer than the quiet period (grouper)', () => {
    const grouper = new HealthIncidentGrouper({
      thresholds: THRESHOLDS,
      config: { quietPeriodMs: 1000, cooldownMs: 0, debounceReadings: 1 },
    });
    const evaluator = new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1000 });
    const drive = (r: HealthReadings): HealthAlert[] => grouper.observe(r, evaluator.evaluate(r));
    expect(drive(leak({ atMs: 1000 }))).toEqual([]);
    expect(drive(leak({ atMs: 31_000 }))).toEqual([]);
    expect(drive(leak({ atMs: 61_000 }))).toHaveLength(1); // incident opens

    // A reverse interval far longer than the quiet period: the incident must
    // neither close nor page.
    let at = 61_000;
    for (let i = 0; i < 5; i += 1) {
      at += 60_000; // 5 minutes of reverse readings, quiet period is 1s
      expect(drive(reverse({ atMs: at }))).toEqual([]);
    }

    // The leak returns: still the same single open incident, no new alert.
    expect(drive(leak({ atMs: at + 60_000 }))).toEqual([]);

    // Equal readings past the quiet period close it exactly once.
    at += 60_000;
    expect(drive(equal({ atMs: at }))).toEqual([]);
    const closed = drive(equal({ atMs: at + 2_000 }));
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ kind: 'turn_count_mismatch', transition: 'recovery' });
    expect(closed[0].incident).toMatchObject({ reopenedDuringCooldown: false });
    expect(drive(equal({ atMs: at + 4_000 }))).toEqual([]);
  });
});
