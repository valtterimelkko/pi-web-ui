import { describe, expect, it } from 'vitest';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';

describe('AdmissionController', () => {
  it('atomically limits concurrent Internal API turns and releases permits', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 3,
      interactiveReserve: 1,
      memory: () => ({ currentBytes: 100, limitBytes: 10_000 }),
      minimumHeadroomBytes: 100,
      reservedBytesPerTurn: 1,
    });
    const [first, second] = await Promise.all([controller.acquire('pi'), controller.acquire('claude')]);
    await expect(controller.acquire('opencode')).rejects.toMatchObject({ reason: 'global_limit' });
    expect(controller.snapshot().activeTurns).toBe(2);
    first.release();
    const third = await controller.acquire('opencode');
    expect(controller.snapshot().activeTurns).toBe(2);
    second.release();
    third.release();
    expect(controller.snapshot().activeTurns).toBe(0);
  });

  it('refuses admission under measured memory pressure', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 8,
      interactiveReserve: 1,
      memory: () => ({ currentBytes: 9_950, limitBytes: 10_000 }),
      minimumHeadroomBytes: 100,
      reservedBytesPerTurn: 1,
    });
    await expect(controller.acquire('pi')).rejects.toMatchObject({ reason: 'memory_pressure' });
    expect(controller.snapshot()).toMatchObject({ available: false, reason: 'memory_pressure', activeTurns: 0 });
  });

  it('enforces optional runtime-specific limits without fixing session counts', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 6,
      interactiveReserve: 1,
      runtimeMaxActiveTurns: { antigravity: 1 },
      memory: () => ({ currentBytes: 100, limitBytes: 10_000 }),
      minimumHeadroomBytes: 100,
      reservedBytesPerTurn: 1,
    });
    const lease = await controller.acquire('antigravity');
    await expect(controller.acquire('antigravity')).rejects.toMatchObject({ reason: 'runtime_limit' });
    expect(controller.snapshot().runtimes.antigravity).toMatchObject({ activeTurns: 1, maxActiveTurns: 1 });
    lease.release();
  });

  it('makes release idempotent', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 2,
      interactiveReserve: 1,
      memory: () => ({ currentBytes: 0, limitBytes: 10_000 }),
      minimumHeadroomBytes: 100,
      reservedBytesPerTurn: 1,
    });
    const lease = await controller.acquire('pi');
    lease.release();
    lease.release();
    expect(controller.snapshot().activeTurns).toBe(0);
  });
});
