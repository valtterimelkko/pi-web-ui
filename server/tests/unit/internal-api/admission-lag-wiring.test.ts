/**
 * B2: the event_loop_lag gate consumes A2 readings. HealthTelemetry exposes a
 * read-only `onReading` listener (sampling and alerting unchanged), and
 * `connectAdmissionToLagReadings` feeds each reading's lag p99 into admission.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthTelemetry, createNoopAlertSink } from '../../../src/observability/health-telemetry.js';
import { AdmissionController, connectAdmissionToLagReadings } from '../../../src/internal-api/admission-controller.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function telemetryWithLag(lag: { p99Ms: number }): Promise<HealthTelemetry> {
  const dir = await mkdtemp(path.join(tmpdir(), 'b2-lag-wiring-'));
  dirs.push(dir);
  let now = 1_790_000_000_000;
  return new HealthTelemetry({
    config: {
      enabled: true,
      dir,
      intervalMs: 1_000,
      maxFileBytes: 100_000,
      maxFiles: 3,
      thresholds: { heapFractionHigh: 0.8, heapFractionLow: 0.7, lagP99HighMs: 60_000, lagP99LowMs: 30_000 },
      sink: createNoopAlertSink(),
      sinkDescription: 'test',
      suppressOperatorNotifications: false,
      warnings: [],
    },
    sources: {
      now: () => (now += 30_000),
      uptimeSec: () => 1,
      memoryUsage: () => ({ heapUsed: 1, heapTotal: 2, rss: 3, external: 0 }),
      heapLimitBytes: () => 100_000,
      lagWindow: () => ({ windowMs: 60_000, sampleCount: 120, p50Ms: 1, p99Ms: lag.p99Ms, maxMs: lag.p99Ms }),
      residentSessions: () => 0,
    },
  } as never);
}

describe('A2 → admission lag wiring', () => {
  it('HealthTelemetry.onReading delivers each reading; unsubscribe stops delivery; a throwing listener cannot break sampling', async () => {
    const telemetry = await telemetryWithLag({ p99Ms: 42 });
    const seen: number[] = [];
    const off = telemetry.onReading(() => { throw new Error('listener bug'); });
    const unsubscribe = telemetry.onReading((r) => { seen.push(r.lagP99Ms); });
    const first = await telemetry.sampleOnce();
    expect(first?.lagP99Ms).toBe(42);
    expect(seen).toEqual([42]);
    unsubscribe();
    off();
    await telemetry.sampleOnce();
    expect(seen).toEqual([42]);
  });

  it('two consecutive high A2 readings refuse P2 with event_loop_lag; a low reading recovers', async () => {
    const lag = { p99Ms: 450 };
    const telemetry = await telemetryWithLag(lag);
    const admission = new AdmissionController({
      maxActiveTurns: 4,
      interactiveReserve: 1,
      memory: () => ({ currentBytes: 0, limitBytes: 1e12 }),
      minimumHeadroomBytes: 1,
      reservedBytesPerTurn: 1,
      heap: () => ({ usedBytes: 1, limitBytes: 1e12 }),
      readPids: () => ({}) as never,
      host: () => ({}) as never,
      readMemoryEvents: () => undefined,
      // Readings are stamped by the fake clock; keep the staleness check on it.
      now: () => 1_790_000_000_000,
      lagReadingStaleMs: 10 * 60_000,
    });
    const disconnect = connectAdmissionToLagReadings(admission, telemetry);
    await telemetry.sampleOnce();
    expect(admission.snapshot().eventLoopLag).toMatchObject({ consecutiveHighReadings: 1, pressure: false, source: 'a2' });
    await telemetry.sampleOnce();
    await expect(admission.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'event_loop_lag' });
    lag.p99Ms = 100;
    await telemetry.sampleOnce();
    (await admission.acquire('pi', 'P2')).release();
    disconnect();
    lag.p99Ms = 900;
    await telemetry.sampleOnce();
    await telemetry.sampleOnce();
    expect(admission.snapshot().eventLoopLag.pressure).toBe(false);
  });
});
