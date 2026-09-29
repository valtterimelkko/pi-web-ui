/**
 * B2 correction 01 (Luna review r1):
 *  1. the validation pressure override must be impossible in the production
 *     service — it needs the validation child's identity record (pid match),
 *     the validation-child flag, and the socket + pressure file inside the
 *     validation record dir; NODE_ENV alone is not the guard because the
 *     compiled validation server may itself run with NODE_ENV=production;
 *  2. a stale gap resets the lag streak and the latch — latching again needs
 *     fresh consecutive readings;
 *  3. lag knobs: invalid values/combinations warn and fall back to the
 *     derived defaults (recovery = trigger / 2, sustained = 2).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdmissionController,
  createValidationPressureOverride,
  resolveAdmissionConfig,
  type AdmissionControllerOptions,
} from '../../../src/internal-api/admission-controller.js';
import { resolveAdmissionHeapLagEnv } from '../../../src/config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A validation record dir as scripts/validation-server-child.ts leaves it. */
function validationRecordDir(pid = 4242): { dir: string; env: NodeJS.ProcessEnv; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-corr01-record-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'server-process.json'), JSON.stringify({ identityVersion: 1, pid, validationDir: dir }));
  const file = path.join(dir, 'pressure.json');
  return {
    dir,
    file,
    env: {
      NODE_ENV: 'production', // the compiled validation server may inherit this
      PI_WEB_UI_VALIDATION_MODE: 'true',
      PI_WEB_UI_VALIDATION_SERVER_CHILD: '1',
      PI_WEB_UI_VALIDATION_RECORD_DIR: dir,
      INTERNAL_API_SOCKET_PATH: path.join(dir, 'internal-api.sock'),
      INTERNAL_API_ADMISSION_TEST_PRESSURE_FILE: file,
    },
  };
}

describe('correction 01 — the validation pressure override cannot activate in the production service', () => {
  it('production-shaped env (NODE_ENV=production + validation flag + file, no validation child) → no override, refusal reported', () => {
    const refusals: string[] = [];
    const override = createValidationPressureOverride({
      NODE_ENV: 'production',
      PI_WEB_UI_VALIDATION_MODE: 'true',
      INTERNAL_API_ADMISSION_TEST_PRESSURE_FILE: '/tmp/not-needed.json',
    }, { pid: 4242, onRefused: (reason) => refusals.push(reason) });
    expect(override).toBeUndefined();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/validation server child/);
  });

  it('refuses without the validation child identity record, or when its pid is not this process', () => {
    const { dir, env } = validationRecordDir(4242);
    expect(createValidationPressureOverride(env, { pid: 9999 })).toBeUndefined();
    fs.rmSync(path.join(dir, 'server-process.json'));
    expect(createValidationPressureOverride(env, { pid: 4242 })).toBeUndefined();
  });

  it('refuses when the Internal API socket is not inside the validation record dir (e.g. the production default)', () => {
    const { env } = validationRecordDir(4242);
    expect(createValidationPressureOverride({ ...env, INTERNAL_API_SOCKET_PATH: undefined }, { pid: 4242 })).toBeUndefined();
    expect(createValidationPressureOverride({ ...env, INTERNAL_API_SOCKET_PATH: '/root/.pi-web-ui/internal-api.sock' }, { pid: 4242 })).toBeUndefined();
  });

  it('refuses a pressure file outside the validation record dir', () => {
    const { env } = validationRecordDir(4242);
    expect(createValidationPressureOverride({ ...env, INTERNAL_API_ADMISSION_TEST_PRESSURE_FILE: path.join(os.tmpdir(), 'elsewhere.json') }, { pid: 4242 })).toBeUndefined();
  });

  it('refuses a record dir that is (or contains) the production state root', () => {
    const { dir, env } = validationRecordDir(4242);
    expect(createValidationPressureOverride(env, { pid: 4242, productionStateRoot: dir })).toBeUndefined();
    expect(createValidationPressureOverride(env, { pid: 4242, productionStateRoot: path.join(dir, 'nested-prod') })).toBeUndefined();
  });

  it('a real validation child (even with NODE_ENV=production) gets the override, re-read on every evaluation', () => {
    const { env, file } = validationRecordDir(4242);
    const override = createValidationPressureOverride(env, { pid: 4242, productionStateRoot: '/nonexistent/prod/.pi-web-ui' });
    expect(override).toBeDefined();
    expect(override!.heapUsedBytes()).toBeUndefined(); // file not written yet → real readings
    fs.writeFileSync(file, JSON.stringify({ heapUsedBytes: 123, lagP99Ms: 456 }));
    expect(override!.heapUsedBytes()).toBe(123);
    expect(override!.lagP99Ms()).toBe(456);
    fs.writeFileSync(file, '{not json');
    expect(override!.heapUsedBytes()).toBeUndefined();
  });
});

describe('correction 01 — stale lag telemetry resets the streak and the latch', () => {
  function controller(overrides: AdmissionControllerOptions = {}) {
    let now = 10_000;
    const c = new AdmissionController({
      maxActiveTurns: 4, interactiveReserve: 1,
      memory: () => ({ currentBytes: 0, limitBytes: 1e12 }), minimumHeadroomBytes: 1, reservedBytesPerTurn: 1,
      heap: () => ({ usedBytes: 1, limitBytes: 1e12 }),
      readPids: () => ({}) as never, host: () => ({}) as never, readMemoryEvents: () => undefined,
      lagThresholdMs: 300, lagRecoveryMs: 150, lagSustainedReadings: 2, lagReadingStaleMs: 100,
      now: () => now,
      ...overrides,
    });
    return {
      c,
      read: (p99Ms: number) => c.observeLagReading({ p99Ms, atMs: now, sampleCount: 10 }),
      advance: (ms: number) => { now += ms; },
    };
  }

  it('a high reading before a stale gap does not combine with one after it (Luna repro)', async () => {
    const { c, read, advance } = controller();
    read(400);
    advance(101);
    read(400);
    expect(c.snapshot().eventLoopLag).toMatchObject({ consecutiveHighReadings: 1, pressure: false, stale: false });
    (await c.acquire('pi', 'P2')).release();
    advance(50);
    read(400); // a second FRESH consecutive high reading latches
    await expect(c.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'event_loop_lag' });
  });

  it('latched → stale gap → one high reading is not latched until sustained again', async () => {
    const { c, read, advance } = controller();
    read(400);
    advance(50);
    read(400);
    await expect(c.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'event_loop_lag' });
    advance(101);
    read(400);
    expect(c.snapshot().eventLoopLag).toMatchObject({ consecutiveHighReadings: 1, pressure: false });
    (await c.acquire('pi', 'P2')).release();
    advance(50);
    read(400);
    await expect(c.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'event_loop_lag' });
  });

  it('staleness observed while latched: admission is not refused, and the latch and streak are cleared', async () => {
    const { c, read, advance } = controller();
    read(400);
    advance(50);
    read(400);
    advance(101);
    (await c.acquire('pi', 'P2')).release();
    expect(c.snapshot().eventLoopLag).toMatchObject({ stale: true, pressure: false, consecutiveHighReadings: 0 });
  });
});

describe('correction 01 — lag knobs warn and fall back to the derived defaults (brief amendment)', () => {
  it('recovery >= trigger → derived recovery (trigger / 2) with a warning', () => {
    const c = resolveAdmissionConfig({ lagThresholdMs: 200, lagRecoveryMs: 400 });
    expect(c.lagRecoveryMs).toBe(100);
    expect(c.warnings.join('\n')).toMatch(/lagRecoveryMs=400 .*lagThresholdMs=200/);
    expect(resolveAdmissionConfig({ lagThresholdMs: 200, lagRecoveryMs: 200 }).lagRecoveryMs).toBe(100);
    expect(resolveAdmissionConfig({}).warnings).toEqual([]);
  });

  it('sustained < 1 → default 2 with a warning', () => {
    const c = resolveAdmissionConfig({ lagSustainedReadings: 0 });
    expect(c.lagSustainedReadings).toBe(2);
    expect(c.warnings.join('\n')).toMatch(/lagSustainedReadings/);
  });

  it('non-numeric or non-positive lag env values warn and fall back (never stop startup)', () => {
    const r = resolveAdmissionHeapLagEnv({
      INTERNAL_API_ADMISSION_LAG_P99_MS: 'fast',
      INTERNAL_API_ADMISSION_LAG_RECOVERY_MS: 'abc',
      INTERNAL_API_ADMISSION_LAG_SUSTAINED_READINGS: '0',
    });
    expect(r.internalApiAdmissionLagThresholdMs).toBeUndefined();
    expect(r.internalApiAdmissionLagRecoveryMs).toBeUndefined();
    expect(r.internalApiAdmissionLagSustainedReadings).toBeUndefined();
    expect(r.internalApiAdmissionConfigWarnings).toHaveLength(3);
    expect(r.internalApiAdmissionConfigWarnings!.join('\n')).toMatch(/INTERNAL_API_ADMISSION_LAG_P99_MS/);
    expect(r.internalApiAdmissionConfigWarnings!.join('\n')).toMatch(/INTERNAL_API_ADMISSION_LAG_SUSTAINED_READINGS/);
  });
});
