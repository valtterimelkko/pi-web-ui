/**
 * B2 — heap- and lag-aware admission (Orchestration Scaling Readiness Plan, B2).
 *
 * heap_pressure: projected V8 heap (used + one reserve per active execution
 * turn + one for the candidate) against a fraction of heap_size_limit, with a
 * lower recovery fraction (hysteresis). Gates creates as well as prompts.
 *
 * event_loop_lag: A2 readings feed the controller; N consecutive readings at
 * p99 >= threshold latch the refusal, recovery only below the recovery mark.
 *
 * P0/P1 control is never refused by either; the B4 draining seam refuses
 * P2/P3 with reason 'draining'.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AdmissionCapacityError,
  AdmissionController,
  admissionRefusalHttpStatus,
  createValidationPressureOverride,
  resolveAdmissionConfig,
  type AdmissionControllerOptions,
} from '../../../src/internal-api/admission-controller.js';
import { resolveInternalApiAdmissionOptions } from '../../../src/internal-api/server.js';
import { resolveAdmissionHeapLagEnv } from '../../../src/config.js';

const MiB = 1024 * 1024;

/** Plenty of cgroup/host/PID headroom so only the B2 gates can refuse. */
function baseOptions(overrides: AdmissionControllerOptions = {}): AdmissionControllerOptions {
  return {
    maxActiveTurns: 6,
    interactiveReserve: 1,
    memory: () => ({ currentBytes: 0, limitBytes: 100_000 * MiB }),
    minimumHeadroomBytes: 1,
    reservedBytesPerTurn: 1,
    readPids: () => ({}) as never,
    host: () => ({}) as never,
    readMemoryEvents: () => undefined,
    ...overrides,
  };
}

function heapAt(state: { used: number }, limit = 1000 * MiB) {
  return () => ({ usedBytes: state.used, limitBytes: limit });
}

describe('B2 heap_pressure', () => {
  it('refuses P2 at the boundary: projected heap >= pressure fraction x heap_size_limit', async () => {
    // limit 1000 MiB, fraction 0.75 → 750 MiB; reserve 50 MiB per turn.
    const heap = { used: 699 * MiB };
    const controller = new AdmissionController(baseOptions({
      heap: heapAt(heap), heapPressureFraction: 0.75, heapRecoveryFraction: 0.6, reservedHeapBytesPerTurn: 50 * MiB,
    }));
    // 699 + 1×50 = 749 < 750 → admitted.
    const lease = await controller.acquire('pi', 'P2');
    lease.release();
    // 700 + 50 = 750 → exactly at the boundary → refused.
    heap.used = 700 * MiB;
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'heap_pressure' });
  });

  it('projects one reservation per active execution turn plus the candidate', async () => {
    const heap = { used: 600 * MiB };
    const controller = new AdmissionController(baseOptions({
      heap: heapAt(heap), heapPressureFraction: 0.75, heapRecoveryFraction: 0.6, reservedHeapBytesPerTurn: 50 * MiB,
    }));
    const a = await controller.acquire('pi', 'P2'); // 600 + 50 = 650
    const b = await controller.acquire('pi', 'P2'); // 600 + 100 = 700
    // 600 + 150 = 750 → refused because two turns are already running.
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'heap_pressure' });
    expect(controller.snapshot().heap).toMatchObject({ usedBytes: 600 * MiB, projectedBytes: 750 * MiB, pressure: true });
    a.release();
    b.release();
  });

  it('holds the refusal until projected heap falls below the recovery fraction (hysteresis)', async () => {
    const heap = { used: 760 * MiB };
    const controller = new AdmissionController(baseOptions({
      heap: heapAt(heap), heapPressureFraction: 0.75, heapRecoveryFraction: 0.625, reservedHeapBytesPerTurn: 1,
    }));
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'heap_pressure' });
    // Between recovery (625 MiB) and pressure (750 MiB): still latched.
    heap.used = 700 * MiB;
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'heap_pressure' });
    expect(controller.snapshot().heap.pressure).toBe(true);
    // Projected exactly at the recovery mark (used + 1 byte reserve): still latched.
    heap.used = 625 * MiB - 1;
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'heap_pressure' });
    // Strictly below the recovery mark: recovered.
    heap.used = 625 * MiB - 2;
    const lease = await controller.acquire('pi', 'P2');
    expect(controller.snapshot().heap.pressure).toBe(false);
    lease.release();
    // Once recovered, the pressure mark (not the recovery mark) governs again.
    heap.used = 700 * MiB;
    (await controller.acquire('pi', 'P2')).release();
  });

  it('gates creates as well as prompts, but never on turn-slot counts', async () => {
    const heap = { used: 900 * MiB };
    const controller = new AdmissionController(baseOptions({
      maxActiveTurns: 2, interactiveReserve: 1,
      heap: heapAt(heap), heapPressureFraction: 0.75, heapRecoveryFraction: 0.6, reservedHeapBytesPerTurn: 1,
    }));
    expect(() => controller.assertCreateAdmissible('pi')).toThrow(AdmissionCapacityError);
    try {
      controller.assertCreateAdmissible('pi');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'heap_pressure', retryAfterSeconds: 30 });
    }
    // With no pressure, a create is admitted even when execution slots are full
    // (a create holds no turn; the later prompt is what needs a slot).
    heap.used = 100 * MiB;
    const lease = await controller.acquire('pi', 'P2');
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'global_limit' });
    expect(() => controller.assertCreateAdmissible('pi')).not.toThrow();
    lease.release();
  });

  it('keeps P0/P1 control available under heap pressure', async () => {
    const controller = new AdmissionController(baseOptions({
      heap: heapAt({ used: 990 * MiB }), heapPressureFraction: 0.75, heapRecoveryFraction: 0.6,
    }));
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'heap_pressure' });
    await expect(controller.acquire('pi', 'P3')).rejects.toMatchObject({ reason: 'heap_pressure' });
    const p0 = await controller.acquire('pi', 'P0');
    const p1 = await controller.acquire('pi', 'P1');
    expect(controller.snapshot()).toMatchObject({ available: false, reason: 'heap_pressure', controlAvailable: true });
    p0.release();
    p1.release();
  });

  it('exposes the heap state and its inputs on the snapshot', () => {
    const controller = new AdmissionController(baseOptions({
      heap: heapAt({ used: 200 * MiB }, 4096 * MiB), heapPressureFraction: 0.75, heapRecoveryFraction: 0.65, reservedHeapBytesPerTurn: 64 * MiB,
    }));
    expect(controller.snapshot().heap).toEqual({
      usedBytes: 200 * MiB,
      limitBytes: 4096 * MiB,
      projectedBytes: 264 * MiB,
      reservedBytesPerTurn: 64 * MiB,
      pressureFraction: 0.75,
      recoveryFraction: 0.65,
      pressureBytes: Math.floor(4096 * MiB * 0.75),
      recoveryBytes: Math.floor(4096 * MiB * 0.65),
      pressure: false,
      source: 'v8',
    });
  });

  it('fails open when the heap limit is unknown (0)', async () => {
    const controller = new AdmissionController(baseOptions({ heap: () => ({ usedBytes: 5 * MiB, limitBytes: 0 }) }));
    (await controller.acquire('pi', 'P2')).release();
    expect(controller.snapshot().heap.pressure).toBe(false);
  });

  it('defaults to the real V8 heap (heap_size_limit) with a 0.75/0.65 band and 64 MiB per turn', () => {
    const controller = new AdmissionController(baseOptions());
    const heap = controller.snapshot().heap;
    expect(heap.source).toBe('v8');
    expect(heap.limitBytes).toBeGreaterThan(0);
    expect(heap.usedBytes).toBeGreaterThan(0);
    expect(heap).toMatchObject({ pressureFraction: 0.75, recoveryFraction: 0.65, reservedBytesPerTurn: 64 * MiB, pressure: false });
  });
});

describe('B2 event_loop_lag', () => {
  function lagController(overrides: AdmissionControllerOptions = {}) {
    let now = 1_000_000;
    const controller = new AdmissionController(baseOptions({
      heap: heapAt({ used: 1 }),
      lagThresholdMs: 300,
      lagRecoveryMs: 150,
      lagSustainedReadings: 2,
      now: () => now,
      ...overrides,
    }));
    const read = (p99Ms: number) => {
      now += 30_000;
      controller.observeLagReading({ p99Ms, atMs: now, sampleCount: 120 });
    };
    return { controller, read, advance: (ms: number) => { now += ms; } };
  }

  it('one reading at the threshold is not sustained; two consecutive readings latch the refusal', async () => {
    const { controller, read } = lagController();
    read(300);
    (await controller.acquire('pi', 'P2')).release();
    expect(controller.snapshot().eventLoopLag).toMatchObject({ pressure: false, consecutiveHighReadings: 1 });
    read(300);
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'event_loop_lag', retryAfterSeconds: 30 });
    expect(controller.snapshot()).toMatchObject({ available: false, reason: 'event_loop_lag' });
  });

  it('a reading just below the threshold breaks the run', async () => {
    const { controller, read } = lagController();
    read(400);
    read(299);
    read(400);
    (await controller.acquire('pi', 'P2')).release();
    expect(controller.snapshot().eventLoopLag.consecutiveHighReadings).toBe(1);
  });

  it('stays latched between the recovery and trigger marks; recovers strictly below recovery', async () => {
    const { controller, read } = lagController();
    read(500);
    read(500);
    read(200); // below trigger, above recovery → still refusing
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'event_loop_lag' });
    read(150); // at the recovery mark → still refusing
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'event_loop_lag' });
    read(149);
    (await controller.acquire('pi', 'P2')).release();
    expect(controller.snapshot().eventLoopLag).toMatchObject({ pressure: false, consecutiveHighReadings: 0 });
  });

  it('keeps P0/P1 control available and gates creates under lag', async () => {
    const { controller, read } = lagController();
    read(900);
    read(900);
    (await controller.acquire('pi', 'P0')).release();
    (await controller.acquire('pi', 'P1')).release();
    expect(() => controller.assertCreateAdmissible('claude')).toThrow(/event_loop_lag/);
    expect(controller.snapshot().controlAvailable).toBe(true);
  });

  it('ignores readings with no samples, and fails open when the latest reading is stale', async () => {
    const { controller, read, advance } = lagController({ lagReadingStaleMs: 120_000 });
    controller.observeLagReading({ p99Ms: 5000, atMs: 1, sampleCount: 0 });
    expect(controller.snapshot().eventLoopLag.consecutiveHighReadings).toBe(0);
    read(900);
    read(900);
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'event_loop_lag' });
    advance(120_001);
    (await controller.acquire('pi', 'P2')).release();
    expect(controller.snapshot().eventLoopLag).toMatchObject({ stale: true, pressure: false });
  });

  it('exposes the lag state and its inputs on the snapshot', () => {
    const { controller, read } = lagController();
    expect(controller.snapshot().eventLoopLag).toMatchObject({
      thresholdMs: 300, recoveryMs: 150, sustainedReadings: 2,
      pressure: false, consecutiveHighReadings: 0, telemetryAvailable: false, stale: false,
    });
    read(310);
    const lag = controller.snapshot().eventLoopLag;
    expect(lag).toMatchObject({ lastP99Ms: 310, telemetryAvailable: true, consecutiveHighReadings: 1 });
    expect(typeof lag.lastReadingAt).toBe('string');
  });
});

describe('B2 refusal status and draining seam', () => {
  it('maps pressure refusals (including heap, lag, draining) to 503 and slot refusals to 429', () => {
    expect(admissionRefusalHttpStatus('global_limit')).toBe(429);
    expect(admissionRefusalHttpStatus('runtime_limit')).toBe(429);
    for (const reason of ['memory_pressure', 'pid_pressure', 'host_memory_pressure', 'heap_pressure', 'event_loop_lag', 'draining'] as const) {
      expect(admissionRefusalHttpStatus(reason)).toBe(503);
    }
  });

  it('refuses P2/P3 with draining while control stays available, and exposes it on the snapshot', async () => {
    const controller = new AdmissionController(baseOptions({ heap: heapAt({ used: 1 }) }));
    expect(controller.snapshot().draining).toBeNull();
    controller.setDraining({ since: Date.parse('2026-09-29T12:00:00Z'), reason: 'deploy' });
    expect(controller.getDraining()).toEqual({ since: Date.parse('2026-09-29T12:00:00Z'), reason: 'deploy' });
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'draining' });
    await expect(controller.acquire('pi', 'P3')).rejects.toMatchObject({ reason: 'draining' });
    (await controller.acquire('pi', 'P1')).release();
    expect(() => controller.assertCreateAdmissible('pi')).toThrow(/draining/);
    expect(controller.snapshot()).toMatchObject({
      available: false, reason: 'draining', controlAvailable: true,
      draining: { since: '2026-09-29T12:00:00.000Z', reason: 'deploy' },
    });
    controller.setDraining(null);
    (await controller.acquire('pi', 'P2')).release();
  });
});

describe('B2 configuration', () => {
  it('resolves defaults and derives lag recovery from the single threshold knob', () => {
    const c = resolveAdmissionConfig({});
    expect(c).toMatchObject({
      heapPressureFraction: 0.75, heapRecoveryFraction: 0.65, reservedHeapBytesPerTurn: 64 * MiB,
      lagThresholdMs: 300, lagRecoveryMs: 150, lagSustainedReadings: 2, heapLagRetryAfterSeconds: 30,
    });
    expect(resolveAdmissionConfig({ lagThresholdMs: 500 }).lagRecoveryMs).toBe(250);
    expect(resolveAdmissionConfig({ lagThresholdMs: 500, lagRecoveryMs: 200 }).lagRecoveryMs).toBe(200);
  });

  it('clamps an inverted band so recovery never sits above the trigger', () => {
    const c = resolveAdmissionConfig({ heapPressureFraction: 0.5, heapRecoveryFraction: 0.9, lagThresholdMs: 200, lagRecoveryMs: 400 });
    expect(c.heapRecoveryFraction).toBe(0.5);
    expect(c.lagRecoveryMs).toBe(200);
    // Out-of-range fractions fall back to the defaults.
    expect(resolveAdmissionConfig({ heapPressureFraction: 1.5 }).heapPressureFraction).toBe(0.75);
    expect(resolveAdmissionConfig({ heapPressureFraction: 0 }).heapPressureFraction).toBe(0.75);
  });

  it('parses the B2 env knobs (unset → undefined so the controller defaults apply)', () => {
    expect(resolveAdmissionHeapLagEnv({})).toEqual({
      internalApiAdmissionHeapPressureFraction: undefined,
      internalApiAdmissionHeapRecoveryFraction: undefined,
      internalApiAdmissionReservedHeapBytesPerTurn: undefined,
      internalApiAdmissionLagThresholdMs: undefined,
      internalApiAdmissionLagRecoveryMs: undefined,
      internalApiAdmissionLagSustainedReadings: undefined,
    });
    expect(resolveAdmissionHeapLagEnv({
      INTERNAL_API_ADMISSION_HEAP_PRESSURE_FRACTION: '0.8',
      INTERNAL_API_ADMISSION_HEAP_RECOVERY_FRACTION: '0.7',
      INTERNAL_API_ADMISSION_HEAP_RESERVED_MB_PER_TURN: '32',
      INTERNAL_API_ADMISSION_LAG_P99_MS: '400',
      INTERNAL_API_ADMISSION_LAG_RECOVERY_MS: '200',
      INTERNAL_API_ADMISSION_LAG_SUSTAINED_READINGS: '3',
    })).toEqual({
      internalApiAdmissionHeapPressureFraction: 0.8,
      internalApiAdmissionHeapRecoveryFraction: 0.7,
      internalApiAdmissionReservedHeapBytesPerTurn: 32 * MiB,
      internalApiAdmissionLagThresholdMs: 400,
      internalApiAdmissionLagRecoveryMs: 200,
      internalApiAdmissionLagSustainedReadings: 3,
    });
    // Invalid values fail loudly at startup, like the existing admission knobs.
    expect(() => resolveAdmissionHeapLagEnv({ INTERNAL_API_ADMISSION_HEAP_PRESSURE_FRACTION: '1.7' })).toThrow(/INTERNAL_API_ADMISSION_HEAP_PRESSURE_FRACTION/);
    expect(() => resolveAdmissionHeapLagEnv({ INTERNAL_API_ADMISSION_HEAP_RECOVERY_FRACTION: 'abc' })).toThrow(/INTERNAL_API_ADMISSION_HEAP_RECOVERY_FRACTION/);
    expect(() => resolveAdmissionHeapLagEnv({ INTERNAL_API_ADMISSION_LAG_P99_MS: '0' })).toThrow(/INTERNAL_API_ADMISSION_LAG_P99_MS/);
  });

  it('passes the B2 knobs through the server admission wiring', () => {
    const options = resolveInternalApiAdmissionOptions({
      admissionHeapPressureFraction: 0.5,
      admissionHeapRecoveryFraction: 0.4,
      admissionReservedHeapBytesPerTurn: 32 * MiB,
      admissionLagThresholdMs: 250,
      admissionLagRecoveryMs: 100,
      admissionLagSustainedReadings: 3,
    });
    expect(options).toMatchObject({
      heapPressureFraction: 0.5, heapRecoveryFraction: 0.4, reservedHeapBytesPerTurn: 32 * MiB,
      lagThresholdMs: 250, lagRecoveryMs: 100, lagSustainedReadings: 3,
    });
  });
});

describe('B2 validation-only pressure override', () => {
  it('is inert outside validation mode', () => {
    expect(createValidationPressureOverride({ INTERNAL_API_ADMISSION_TEST_PRESSURE_FILE: '/tmp/x.json' })).toBeUndefined();
  });

  it('reads heap and lag overrides from the file each time, falling back to real values when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-override-'));
    const file = path.join(dir, 'pressure.json');
    try {
      const override = createValidationPressureOverride({
        PI_WEB_UI_VALIDATION_MODE: 'true',
        INTERNAL_API_ADMISSION_TEST_PRESSURE_FILE: file,
      });
      expect(override).toBeDefined();
      expect(override!.heapUsedBytes()).toBeUndefined();
      expect(override!.lagP99Ms()).toBeUndefined();
      fs.writeFileSync(file, JSON.stringify({ heapUsedBytes: 123, lagP99Ms: 456 }));
      expect(override!.heapUsedBytes()).toBe(123);
      expect(override!.lagP99Ms()).toBe(456);
      fs.writeFileSync(file, '{not json');
      expect(override!.heapUsedBytes()).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drives the controller: heap override replaces used bytes, lag override replaces observed p99', async () => {
    let heapOverride: number | undefined = 900 * MiB;
    let lagOverride: number | undefined;
    const controller = new AdmissionController(baseOptions({
      heap: heapAt({ used: 1 }),
      pressureOverride: { heapUsedBytes: () => heapOverride, lagP99Ms: () => lagOverride },
    }));
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'heap_pressure' });
    expect(controller.snapshot().heap.source).toBe('validation-override');
    heapOverride = undefined;
    (await controller.acquire('pi', 'P2')).release();
    lagOverride = 1000;
    controller.observeLagReading({ p99Ms: 5, atMs: Date.now(), sampleCount: 10 });
    controller.observeLagReading({ p99Ms: 5, atMs: Date.now(), sampleCount: 10 });
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'event_loop_lag' });
    expect(controller.snapshot().eventLoopLag).toMatchObject({ lastP99Ms: 1000, source: 'validation-override' });
  });
});
