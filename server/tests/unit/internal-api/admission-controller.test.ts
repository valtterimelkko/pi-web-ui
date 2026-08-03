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

  // Phase 2.3 — locks in the conservative production admission config so a future
  // change cannot silently drift back to a CPU-derived 15+ turn default.
  it('projects the conservative production admission config (6 / 1 / 1536 MiB / 768 MiB)', async () => {
    const MiB = 1024 * 1024;
    const controller = new AdmissionController({
      maxActiveTurns: 6,
      interactiveReserve: 1,
      minimumHeadroomBytes: 1536 * MiB,
      reservedBytesPerTurn: 768 * MiB,
      memory: () => ({ currentBytes: 0, limitBytes: 12 * 1024 * MiB }),
    });
    const snap = controller.snapshot();
    expect(snap.maxActiveTurns).toBe(6);
    expect(snap.apiTurnLimit).toBe(5); // 6 minus 1 interactive reserve
    expect(snap.interactiveReserve).toBe(1);
    expect(snap.memory.minimumHeadroomBytes).toBe(1536 * MiB);
    expect(snap.memory.reservedBytesPerTurn).toBe(768 * MiB);

    for (let i = 0; i < 5; i += 1) await controller.acquire('pi');
    await expect(controller.acquire('pi')).rejects.toMatchObject({
      reason: 'global_limit',
      retryAfterSeconds: expect.any(Number),
    });
  });

  it('exposes the memory source and PID capacity in the snapshot', () => {
    const controller = new AdmissionController({
      maxActiveTurns: 3,
      memory: () => ({ currentBytes: 100, limitBytes: 10_000, source: 'service', highBytes: 8_000 }),
      readPids: () => ({ current: 5, max: 768, source: 'service' }),
      minimumHeadroomBytes: 100,
      reservedBytesPerTurn: 1,
    });
    const snap = controller.snapshot();
    expect(snap.memory.source).toBe('service');
    expect(snap.memory.highBytes).toBe(8_000);
    expect(snap.pids).toMatchObject({ current: 5, max: 768, source: 'service' });
  });
});
