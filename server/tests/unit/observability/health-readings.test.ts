import { getHeapStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';
import {
  type AdmissionCountsReading,
  CpuUsageTracker,
  collectHealthReadings,
  percentile,
  readHeapLimitBytes,
  readMainThreadCpuTicks,
} from '../../../src/observability/health-readings.js';

describe('percentile', () => {
  it('uses the nearest-rank definition and stays total on empty input', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.99)).toBe(7);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.99)).toBe(99);
    expect(percentile(values, 1)).toBe(100);
    expect(percentile(values, 0)).toBe(1);
  });
});

describe('readHeapLimitBytes', () => {
  it('reads the real V8 heap_size_limit, not the committed heap', () => {
    const limit = readHeapLimitBytes();
    expect(limit).toBe(getHeapStatistics().heap_size_limit);
    expect(limit).toBeGreaterThan(0);
  });
});

describe('CpuUsageTracker', () => {
  it('turns process CPU deltas into a percentage of one core from the injected clock and reader', () => {
    let usage = { user: 0, system: 0 };
    let ticks: { userTicks: number; systemTicks: number } | null = { userTicks: 0, systemTicks: 0 };
    const tracker = new CpuUsageTracker({ cpuUsage: () => usage, mainThreadCpuTicks: () => ticks });

    expect(tracker.sample(1_000_000)).toEqual({
      cpuPercentOfCore: null,
      mainThreadCpuPercentOfCore: null,
      mainThreadCpuSource: 'proc-thread-self',
    });

    // 0.5 s of process CPU over 1 s wall = 50% of one core; 50 ticks at the
    // Linux USER_HZ of 100 = 0.5 s of main-thread CPU = 50%.
    usage = { user: 400_000, system: 100_000 };
    ticks = { userTicks: 30, systemTicks: 20 };
    expect(tracker.sample(1_001_000)).toEqual({
      cpuPercentOfCore: 50,
      mainThreadCpuPercentOfCore: 50,
      mainThreadCpuSource: 'proc-thread-self',
    });

    // 333.3 ms over 1 s is 33.333…%, rounded to one decimal for the file.
    usage = { user: 733_333, system: 100_000 };
    ticks = { userTicks: 63, systemTicks: 20 };
    expect(tracker.sample(1_002_000)).toMatchObject({ cpuPercentOfCore: 33.3, mainThreadCpuPercentOfCore: 33 });
  });

  it('falls back to the labelled process-wide figure when the main thread is unreadable', () => {
    let usage = { user: 0, system: 0 };
    const tracker = new CpuUsageTracker({ cpuUsage: () => usage, mainThreadCpuTicks: () => null });
    tracker.sample(0);
    usage = { user: 250_000, system: 0 };
    expect(tracker.sample(1_000)).toEqual({
      cpuPercentOfCore: 25,
      mainThreadCpuPercentOfCore: 25,
      mainThreadCpuSource: 'process-cpu',
    });
  });

  it('reports unavailable when neither reader works, instead of inventing a zero', () => {
    const tracker = new CpuUsageTracker({
      cpuUsage: () => { throw new Error('no process cpu'); },
      mainThreadCpuTicks: () => null,
    });
    expect(tracker.sample(0)).toEqual({
      cpuPercentOfCore: null,
      mainThreadCpuPercentOfCore: null,
      mainThreadCpuSource: 'unavailable',
    });
  });

  it('does not divide by a non-advancing clock', () => {
    let usage = { user: 0, system: 0 };
    const tracker = new CpuUsageTracker({ cpuUsage: () => usage, mainThreadCpuTicks: () => null });
    tracker.sample(5_000);
    usage = { user: 100_000, system: 0 };
    expect(tracker.sample(5_000).cpuPercentOfCore).toBeNull();
  });
});

describe('readMainThreadCpuTicks', () => {
  it('reads the main thread tick counters on Linux and stays fail-open elsewhere', () => {
    const ticks = readMainThreadCpuTicks();
    if (process.platform === 'linux') {
      expect(ticks).not.toBeNull();
      expect(ticks?.userTicks).toBeGreaterThanOrEqual(0);
      expect(ticks?.systemTicks).toBeGreaterThanOrEqual(0);
    } else {
      expect(ticks).toBeNull();
    }
  });
});

describe('collectHealthReadings', () => {
  it('computes the heap fraction against the real limit and includes every plan field', () => {
    const readings = collectHealthReadings({
      now: () => 1_700_000_000_000,
      uptimeSec: () => 42,
      memoryUsage: () => ({ heapUsed: 3_000, heapTotal: 4_000, rss: 9_000, external: 500 }),
      heapLimitBytes: () => 4_000,
      lagWindow: () => ({ windowMs: 60_000, sampleCount: 3, p50Ms: 4, p99Ms: 90, maxMs: 120 }),
      admission: () => ({ activeTurns: 3, classes: { P0: { active: 1 }, P1: { active: 0 }, P2: { active: 2 }, P3: { active: 0 } } }),
      residentSessions: () => 5,
      registryEntries: () => 1731,
      cpuReading: () => ({ cpuPercentOfCore: 12.5, mainThreadCpuPercentOfCore: 7.5, mainThreadCpuSource: 'proc-thread-self' }),
    });

    expect(readings).toMatchObject({
      at: '2023-11-14T22:13:20.000Z',
      atMs: 1_700_000_000_000,
      uptimeSec: 42,
      heapUsedBytes: 3_000,
      heapTotalBytes: 4_000,
      heapLimitBytes: 4_000,
      heapFraction: 0.75,
      rssBytes: 9_000,
      externalBytes: 500,
      lagP50Ms: 4,
      lagP99Ms: 90,
      lagMaxMs: 120,
      activeTurns: 3,
      activeTurnsByClass: { P0: 1, P1: 0, P2: 2, P3: 0 },
      residentSessions: 5,
      registryEntries: 1731,
      cpuPercentOfCore: 12.5,
      mainThreadCpuPercentOfCore: 7.5,
      mainThreadCpuSource: 'proc-thread-self',
    });
    expect(Number.isFinite(readings.heapFraction)).toBe(true);
  });

  it('keeps every field total when optional sources are missing or failing', () => {
    const readings = collectHealthReadings({
      now: () => 0,
      memoryUsage: () => ({ heapUsed: 10, heapTotal: 20, rss: 30, external: 1 }),
      heapLimitBytes: () => 0,
      admission: () => { throw new Error('admission unavailable'); },
      residentSessions: () => undefined,
      registryEntries: () => { throw new Error('registry unavailable'); },
      lagWindow: () => undefined,
    });
    expect(readings.heapFraction).toBe(0);
    expect(readings.lagP99Ms).toBe(0);
    expect(readings.lagSampleCount).toBe(0);
    expect(readings.activeTurns).toBe(0);
    expect(readings.activeTurnsByClass).toEqual({});
    expect(readings.residentSessions).toBeNull();
    expect(readings.registryEntries).toBeNull();
    expect(readings.cpuPercentOfCore).toBeNull();
    expect(readings.mainThreadCpuPercentOfCore).toBeNull();
    expect(readings.mainThreadCpuSource).toBe('unavailable');
  });

  it('stays fail-open when the CPU reading source throws', () => {
    const readings = collectHealthReadings({
      now: () => 0,
      cpuReading: () => { throw new Error('cpu unavailable'); },
    });
    expect(readings.cpuPercentOfCore).toBeNull();
    expect(readings.mainThreadCpuPercentOfCore).toBeNull();
    expect(readings.mainThreadCpuSource).toBe('unavailable');
  });

  it('defaults to the process-wide sources and produces a JSON-serialisable sample', () => {
    const readings = collectHealthReadings();
    expect(() => JSON.stringify(readings)).not.toThrow();
    expect(readings.heapLimitBytes).toBe(getHeapStatistics().heap_size_limit);
    expect(readings.heapUsedBytes).toBeGreaterThan(0);
  });

  it('collects placementDegrades and passes bootMs calculated from now and uptimeSec', () => {
    let receivedSinceMs: number | undefined;
    const readings = collectHealthReadings({
      now: () => 1_700_000_050_000,
      uptimeSec: () => 50,
      placementDegrades: (sinceMs) => {
        receivedSinceMs = sinceMs;
        return 3;
      },
    });
    expect(readings.placementDegrades).toBe(3);
    expect(receivedSinceMs).toBe(1_700_000_000_000);
  });

  describe('admissionCounts source (J3)', () => {
    const counts: AdmissionCountsReading = {
      activeTurns: 1,
      classes: { P0: { active: 0 }, P1: { active: 0 }, P2: { active: 1 }, P3: { active: 0 } },
      runtimes: { pi: { activeTurns: 1 }, claude: { activeTurns: 0 }, opencode: { activeTurns: 0 }, antigravity: { activeTurns: 0 }, commandcode: { activeTurns: 0 } },
      oldestActiveRunStartedAt: '2026-10-02T06:35:00.000Z',
    };

    it('records admission counts next to (not instead of) the runtime operational counts', () => {
      const readings = collectHealthReadings({
        now: () => 1_700_000_000_000,
        activeTurnsFromOperationalMetrics: () => ({ pi: 0 }),
        admissionCounts: () => counts,
      });
      // Runtime truth stays in the existing fields (operational metrics).
      expect(readings.activeTurns).toBe(0);
      expect(readings.activeTurnsByClass).toEqual({ pi: 0 });
      // Admission's view lands beside it.
      expect(readings.admissionActiveTurns).toBe(1);
      expect(readings.admissionTurnsByClass).toEqual({ P0: 0, P1: 0, P2: 1, P3: 0 });
      expect(readings.admissionTurnsByRuntime).toEqual({ pi: 1, claude: 0, opencode: 0, antigravity: 0, commandcode: 0 });
      expect(readings.admissionOldestActiveRunStartedAt).toBe('2026-10-02T06:35:00.000Z');
    });

    it('adds no admission fields at all when the source is unwired, so the metrics row is byte-identical in size', () => {
      const readings = collectHealthReadings({ now: () => 1_700_000_000_000 });
      expect(readings.admissionActiveTurns).toBeUndefined();
      expect(readings.admissionTurnsByClass).toBeUndefined();
      expect(readings.admissionTurnsByRuntime).toBeUndefined();
      expect(readings.admissionOldestActiveRunStartedAt).toBeUndefined();
      expect(JSON.stringify(readings)).not.toContain('admission');
    });

    it('stays fail-open when the admission counts source throws or returns junk', () => {
      const throwing = collectHealthReadings({
        now: () => 1_700_000_000_000,
        admissionCounts: () => { throw new Error('admission snapshot unavailable'); },
      });
      expect(throwing.admissionActiveTurns).toBeUndefined();
      const junk = collectHealthReadings({
        now: () => 1_700_000_000_000,
        admissionCounts: () => ({ activeTurns: Number.NaN, classes: {} }),
      });
      expect(junk.admissionActiveTurns).toBeUndefined();
    });

    it('omits optional detail admission does not expose (no runtimes map, no oldest run)', () => {
      const readings = collectHealthReadings({
        now: () => 1_700_000_000_000,
        admissionCounts: () => ({ activeTurns: 2, classes: { P0: { active: 0 }, P1: { active: 0 }, P2: { active: 2 }, P3: { active: 0 } } }),
      });
      expect(readings.admissionActiveTurns).toBe(2);
      expect(readings.admissionTurnsByRuntime).toBeUndefined();
      expect(readings.admissionOldestActiveRunStartedAt).toBeUndefined();
    });
  });
});
