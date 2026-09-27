import { getHeapStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';
import {
  collectHealthReadings,
  percentile,
  readHeapLimitBytes,
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
  });

  it('defaults to the process-wide sources and produces a JSON-serialisable sample', () => {
    const readings = collectHealthReadings();
    expect(() => JSON.stringify(readings)).not.toThrow();
    expect(readings.heapLimitBytes).toBe(getHeapStatistics().heap_size_limit);
    expect(readings.heapUsedBytes).toBeGreaterThan(0);
  });
});
