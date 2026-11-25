import { describe, expect, it } from 'vitest';
import {
  HealthAlertEvaluator,
  turnCountMismatchDelta,
  type HealthAlertThresholds,
} from '../../../src/observability/health-alerts.js';
import {
  collectHealthReadings,
  type AdmissionCountsReading,
  type HealthReadings,
} from '../../../src/observability/health-readings.js';
import {
  classifyPermitOwnership,
  type LeaseOwnershipSnapshot,
} from '../../../src/observability/permit-ownership.js';

/**
 * R0 (02-answer): the turn-count detector must count the run manager's actual
 * attached leases — active, queued, draining and quarantined — not the
 * accepted-minus-terminal receipt counters. Held terminal debt is not a leak;
 * a permit with no attached receipt lease still is.
 */

const THRESHOLDS: HealthAlertThresholds = {
  heapFractionHigh: 0.8,
  heapFractionLow: 0.7,
  lagP99HighMs: 500,
  lagP99LowMs: 200,
};

const RUNTIMES = ['pi', 'claude', 'opencode', 'antigravity', 'commandcode'] as const;

function snapshot(overrides: Partial<LeaseOwnershipSnapshot> = {}): LeaseOwnershipSnapshot {
  return {
    activeByRuntime: {},
    queuedByRuntime: {},
    drainingByRuntime: {},
    quarantinedByRuntime: {},
    ...overrides,
  };
}

function admissionCounts(byRuntime: Partial<Record<string, number>> = {}): AdmissionCountsReading {
  const runtimes: AdmissionCountsReading['runtimes'] = {} as NonNullable<AdmissionCountsReading['runtimes']>;
  let total = 0;
  for (const runtime of RUNTIMES) {
    const activeTurns = byRuntime[runtime] ?? 0;
    total += activeTurns;
    runtimes[runtime] = { activeTurns };
  }
  return {
    activeTurns: total,
    classes: {
      P0: { active: 0 },
      P1: { active: 0 },
      P2: { active: total },
      P3: { active: 0 },
    },
    runtimes,
  };
}

type OwnershipSource = LeaseOwnershipSnapshot | 'throw' | 'junk';

function reading(options: {
  admission?: Partial<Record<string, number>>;
  counts?: AdmissionCountsReading;
  ownership?: OwnershipSource;
  atMs?: number;
} = {}): HealthReadings {
  const sources: Parameters<typeof collectHealthReadings>[0] = {
    now: () => options.atMs ?? 1_000,
    activeTurnsFromOperationalMetrics: () => ({}),
    admissionCounts: () => options.counts ?? admissionCounts(options.admission ?? {}),
  };
  if (options.ownership === 'throw') {
    sources.permitOwnership = () => { throw new Error('run manager snapshot unavailable'); };
  } else if (options.ownership === 'junk') {
    sources.permitOwnership = () => ({ activeByRuntime: { pi: Number.NaN } } as unknown as LeaseOwnershipSnapshot);
  } else if (options.ownership) {
    sources.permitOwnership = () => options.ownership as LeaseOwnershipSnapshot;
  }
  return collectHealthReadings(sources);
}

function evaluator(): HealthAlertEvaluator {
  return new HealthAlertEvaluator({ thresholds: THRESHOLDS, now: () => 1_000 });
}

describe('classifyPermitOwnership', () => {
  it('counts active + queued + draining + quarantined leases and leaves only the true remainder unexplained', () => {
    const classified = classifyPermitOwnership(
      snapshot({
        activeByRuntime: { pi: 2 },
        queuedByRuntime: { pi: 1 },
        drainingByRuntime: { pi: 1 },
        quarantinedByRuntime: { pi: 1 },
      }),
      { pi: 6 },
    );
    expect(classified.state).toBe('classified');
    expect(classified.knownByRuntime.pi).toBe(5);
    // One injected permit has no attached receipt lease.
    expect(classified.unexplained).toBe(1);
    expect(classified.unexplainedByRuntime).toEqual({ pi: 1 });
    expect(classified.reverse).toBe(0);
  });

  it('holds known terminal debt out of the leak count (debt is not a leak)', () => {
    const classified = classifyPermitOwnership(
      snapshot({ activeByRuntime: { claude: 2 }, drainingByRuntime: { claude: 1 }, quarantinedByRuntime: { claude: 1 } }),
      { claude: 4 },
    );
    expect(classified.unexplained).toBe(0);
    expect(classified.knownByRuntime.claude).toBe(4);
  });

  it('does not let a joined receipt without a permit offset a real leak', () => {
    // Admission holds one permit; the only receipt is joined and holds no lease,
    // so the accepted-minus-terminal counters would have read 1 vs 1 (masked).
    const classified = classifyPermitOwnership(snapshot(), { pi: 1 });
    expect(classified.unexplained).toBe(1);
    expect(classified.unexplainedByRuntime).toEqual({ pi: 1 });
  });

  it('sums per-runtime remainders without letting a reverse runtime cancel a leak', () => {
    const classified = classifyPermitOwnership(
      snapshot({ activeByRuntime: { claude: 2 } }),
      { pi: 1, claude: 0 },
    );
    expect(classified.unexplained).toBe(1);
    expect(classified.reverse).toBe(2);
    expect(classified.unexplainedByRuntime).toEqual({ pi: 1 });
    expect(classified.reverseByRuntime).toEqual({ claude: 2 });
  });

  it('treats an invalid snapshot as unknown rather than a zero mismatch', () => {
    const negative = classifyPermitOwnership(
      { activeByRuntime: { pi: -1 }, queuedByRuntime: {}, drainingByRuntime: {}, quarantinedByRuntime: {} } as unknown as LeaseOwnershipSnapshot,
      { pi: 1 },
    );
    expect(negative).toMatchObject({ state: 'unknown', reason: 'invalid-snapshot' });
    const fractional = classifyPermitOwnership(
      { activeByRuntime: { pi: 0.5 }, queuedByRuntime: {}, drainingByRuntime: {}, quarantinedByRuntime: {} } as unknown as LeaseOwnershipSnapshot,
      { pi: 1 },
    );
    expect(fractional).toMatchObject({ state: 'unknown', reason: 'invalid-snapshot' });
  });
});

describe('permit ownership reading plumbing', () => {
  it('adds no ownership field when the source is unwired (legacy detector unchanged)', () => {
    const readings = reading();
    expect(readings.permitOwnership).toBeUndefined();
    expect(JSON.stringify(readings)).not.toContain('permitOwnership');
  });

  it('records a classified ownership reading in the same tick as admission counts', () => {
    const readings = reading({
      admission: { pi: 3 },
      ownership: snapshot({ activeByRuntime: { pi: 2 }, queuedByRuntime: { pi: 1 } }),
    });
    expect(readings.permitOwnership?.state).toBe('classified');
    expect(readings.permitOwnership?.unexplained).toBe(0);
    expect(readings.admissionTurnsByRuntime?.pi).toBe(3);
  });

  it('stays fail-open and marks a throwing source unknown', () => {
    const readings = reading({ admission: { pi: 1 }, ownership: 'throw' });
    expect(readings.permitOwnership).toMatchObject({ state: 'unknown', reason: 'source-failed' });
  });

  it('marks a malformed snapshot unknown instead of counting it', () => {
    const readings = reading({ admission: { pi: 1 }, ownership: 'junk' });
    expect(readings.permitOwnership).toMatchObject({ state: 'unknown', reason: 'invalid-snapshot' });
  });

  it('marks wired ownership unknown when admission counts are unwired (never absent/legacy)', () => {
    const readings = collectHealthReadings({
      now: () => 1_000,
      permitOwnership: () => snapshot({ activeByRuntime: { pi: 1 } }),
    });
    expect(readings.permitOwnership).toMatchObject({ state: 'unknown', reason: 'invalid-admission-counts' });
    expect(turnCountMismatchDelta(readings)).toBeUndefined();
  });
});

describe('turn-count mismatch with lease ownership', () => {
  it('alerts on the Nth reading for active + queued + debt + one truly unowned permit', () => {
    const value = evaluator();
    const classified = (atMs: number) => reading({
      atMs,
      admission: { pi: 6 },
      ownership: snapshot({
        activeByRuntime: { pi: 2 },
        queuedByRuntime: { pi: 1 },
        drainingByRuntime: { pi: 1 },
        quarantinedByRuntime: { pi: 1 },
      }),
    });
    expect(value.evaluate(classified(1_000))).toEqual([]);
    expect(value.evaluate(classified(31_000))).toEqual([]);
    const alert = value.evaluate(classified(61_000));
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({ kind: 'turn_count_mismatch', transition: 'alert', value: 1 });
    expect(alert[0].message).toContain('pi: 1');
    expect(alert[0].message).toContain('quarantined 1');
    expect(alert[0].message).not.toContain('leaked');
  });

  it('does not open on known debt moving draining -> quarantined -> released', () => {
    const value = evaluator();
    const feed = (atMs: number, ownership: LeaseOwnershipSnapshot, permits: number) => value.evaluate(reading({ atMs, admission: { pi: permits }, ownership }));
    // Active work + a draining terminal lease: everything is owned.
    expect(feed(1_000, snapshot({ activeByRuntime: { pi: 2 }, drainingByRuntime: { pi: 1 } }), 3)).toEqual([]);
    // The draining lease crosses into quarantine.
    expect(feed(31_000, snapshot({ activeByRuntime: { pi: 2 }, quarantinedByRuntime: { pi: 1 } }), 3)).toEqual([]);
    // The L1 reconciler releases it.
    expect(feed(61_000, snapshot({ activeByRuntime: { pi: 2 } }), 2)).toEqual([]);
    expect(feed(91_000, snapshot({ activeByRuntime: { pi: 2 } }), 2)).toEqual([]);
    expect(value.snapshot().turnCountMismatch).toMatchObject({ alerting: false });
  });

  it('still alerts on a real leak and recovers when leases and permits agree', () => {
    const value = evaluator();
    const leak = (atMs: number) => reading({ atMs, admission: { pi: 1 }, ownership: snapshot() });
    const agree = (atMs: number) => reading({
      atMs,
      admission: { pi: 1 },
      ownership: snapshot({ activeByRuntime: { pi: 1 } }),
    });
    value.evaluate(leak(1_000));
    value.evaluate(leak(31_000));
    expect(value.evaluate(leak(61_000))).toHaveLength(1);
    expect(value.snapshot().turnCountMismatch.alerting).toBe(true);
    expect(value.evaluate(agree(91_000))).toEqual([]);
    const recovery = value.evaluate(agree(121_000));
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ kind: 'turn_count_mismatch', transition: 'recovery', value: 0 });
    expect(recovery[0].message).toContain('attached');
  });

  it('cannot be recovered by missing, throwing or invalid ownership data', () => {
    const value = evaluator();
    const leak = (atMs: number) => reading({ atMs, admission: { pi: 1 }, ownership: snapshot() });
    value.evaluate(leak(1_000));
    value.evaluate(leak(31_000));
    expect(value.evaluate(leak(61_000))).toHaveLength(1);
    // Wired source fails: freeze, do not claim recovery or a new cause.
    expect(value.evaluate(reading({ atMs: 91_000, admission: { pi: 1 }, ownership: 'throw' }))).toEqual([]);
    expect(value.evaluate(reading({ atMs: 121_000, admission: { pi: 1 }, ownership: 'junk' }))).toEqual([]);
    expect(value.snapshot().turnCountMismatch.alerting).toBe(true);
    // Real agreement for the full recovery window still recovers exactly once.
    expect(value.evaluate(reading({ atMs: 151_000, admission: { pi: 1 }, ownership: snapshot({ activeByRuntime: { pi: 1 } }) }))).toEqual([]);
    expect(value.evaluate(reading({ atMs: 181_000, admission: { pi: 1 }, ownership: snapshot({ activeByRuntime: { pi: 1 } }) }))).toHaveLength(1);
  });

  it('tolerates the transient acquire-before-attach gap through the existing latch', () => {
    const value = evaluator();
    const settled = (atMs: number) => reading({
      atMs,
      admission: { pi: 1 },
      ownership: snapshot({ activeByRuntime: { pi: 1 } }),
    });
    const gap = (atMs: number) => reading({ atMs, admission: { pi: 1 }, ownership: snapshot() });
    expect(value.evaluate(gap(1_000))).toEqual([]);
    expect(value.evaluate(settled(31_000))).toEqual([]);
    expect(value.evaluate(gap(61_000))).toEqual([]);
    expect(value.evaluate(settled(91_000))).toEqual([]);
    expect(value.evaluate(gap(121_000))).toEqual([]);
    expect(value.snapshot().turnCountMismatch.alerting).toBe(false);
  });

  it('keeps an incident open through a reverse runtime and only equal readings recover it', () => {
    const value = evaluator();
    const leak = (atMs: number) => reading({ atMs, admission: { pi: 1 }, ownership: snapshot() });
    const reverse = (atMs: number) => reading({ atMs, admission: { pi: 1 }, ownership: snapshot({ activeByRuntime: { claude: 2 } }) });
    const equal = (atMs: number) => reading({ atMs, admission: { pi: 1 }, ownership: snapshot({ activeByRuntime: { pi: 1 } }) });
    value.evaluate(leak(1_000));
    value.evaluate(leak(31_000));
    value.evaluate(leak(61_000));
    expect(value.evaluate(reverse(91_000))).toEqual([]);
    expect(value.evaluate(reverse(121_000))).toEqual([]);
    expect(value.snapshot().turnCountMismatch.alerting).toBe(true);
    expect(value.evaluate(equal(151_000))).toEqual([]);
    expect(value.evaluate(equal(181_000))).toHaveLength(1);
  });

  it('leaves the legacy path explicitly unclassified and stops claiming a receipt proves a leak', () => {
    const value = evaluator();
    // No ownership source wired: the raw receipt-counter delta still detects,
    // but the message must not assert that a missing receipt proves a leak.
    const legacy = (atMs: number) => reading({ atMs, admission: { pi: 1 } });
    value.evaluate(legacy(1_000));
    value.evaluate(legacy(31_000));
    const alert = value.evaluate(legacy(61_000));
    expect(alert).toHaveLength(1);
    expect(alert[0].message).toContain('unclassified');
    expect(alert[0].message).not.toContain('leaked');
    expect(alert[0].message).not.toContain('holds no receipt');
  });
});

/**
 * Correction 03 (parent probe, 02:20Z): a wired ownership source must not be
 * classified against an incomplete admission per-runtime view. An empty or
 * partial `runtimes` map makes every permit invisible, so the previous code
 * returned a zero mismatch — which can also claim recovery for an armed
 * incident. Incomplete input is `unknown`: freeze, never recover.
 */
describe('inconsistent admission per-runtime counts (correction 03)', () => {
  const brokenCounts: AdmissionCountsReading[] = [
    { activeTurns: 1, classes: { P2: { active: 1 } }, runtimes: {} as NonNullable<AdmissionCountsReading['runtimes']> },
    { activeTurns: 1, classes: { P2: { active: 1 } } },
    { activeTurns: 2, classes: { P2: { active: 2 } }, runtimes: { pi: { activeTurns: 1 } } as NonNullable<AdmissionCountsReading['runtimes']> },
  ];

  it('exposes unknown instead of a zero mismatch for each incomplete map', () => {
    for (const counts of brokenCounts) {
      const readings = reading({ counts, ownership: snapshot() });
      expect(readings.permitOwnership).toMatchObject({ state: 'unknown', reason: 'invalid-admission-counts' });
      expect(turnCountMismatchDelta(readings)).toBeUndefined();
    }
  });

  it('keeps the parent probe exact: one permit and one complete runtime is unexplained, an empty map is not zero', () => {
    const good = reading({ counts: { activeTurns: 1, classes: { P2: { active: 1 } }, runtimes: { pi: { activeTurns: 1 } } }, ownership: snapshot() });
    expect(turnCountMismatchDelta(good)).toBe(1);
    const broken = reading({ counts: brokenCounts[0], ownership: snapshot() });
    expect(turnCountMismatchDelta(broken)).toBeUndefined();
  });

  it('cannot recover an armed incident on omitted or malformed runtimes', () => {
    const value = evaluator();
    const validLeak = (atMs: number) => reading({ atMs, counts: { activeTurns: 1, classes: { P2: { active: 1 } }, runtimes: { pi: { activeTurns: 1 } } }, ownership: snapshot() });
    value.evaluate(validLeak(1_000));
    value.evaluate(validLeak(31_000));
    expect(value.evaluate(validLeak(61_000))).toHaveLength(1);
    // Two or more readings with an incomplete admission view: previously 0 (recovery).
    for (const [index, counts] of brokenCounts.entries()) {
      expect(value.evaluate(reading({ atMs: 91_000 + index * 30_000, counts, ownership: snapshot({ activeByRuntime: { pi: 1 } }) }))).toEqual([]);
    }
    expect(value.snapshot().turnCountMismatch.alerting).toBe(true);
    // Genuine agreement on a complete map still recovers exactly once.
    const validAgree = (atMs: number) => reading({ atMs, counts: { activeTurns: 1, classes: { P2: { active: 1 } }, runtimes: { pi: { activeTurns: 1 } } }, ownership: snapshot({ activeByRuntime: { pi: 1 } }) });
    expect(value.evaluate(validAgree(181_000))).toEqual([]);
    expect(value.evaluate(validAgree(211_000))).toHaveLength(1);
  });
});
