import { describe, expect, it } from 'vitest';
import { AdmissionController, admissionStartupStatus, resolveAdmissionConfig } from '../../../src/internal-api/admission-controller.js';

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

describe('AdmissionController — PID admission guard', () => {
  it('refuses P2/P3 execution when pids.current + reservedPidsPerTurn would exceed pids.max', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 8,
      memory: () => ({ currentBytes: 100, limitBytes: 10_000 }),
      readPids: () => ({ current: 800, max: 1024, source: 'service' }),
      reservedPidsPerTurn: 256,
      minimumHeadroomBytes: 1,
      reservedBytesPerTurn: 1,
    });
    await expect(controller.acquire('pi')).rejects.toMatchObject({ reason: 'pid_pressure' });
    const snap = controller.snapshot();
    expect(snap.available).toBe(false);
    expect(snap.reason).toBe('pid_pressure');
    expect(snap.pids).toMatchObject({ current: 800, max: 1024 });
  });

  it('admits when enough PID headroom remains below the ceiling', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 8,
      memory: () => ({ currentBytes: 100, limitBytes: 10_000 }),
      readPids: () => ({ current: 100, max: 1024, source: 'service' }),
      reservedPidsPerTurn: 256,
      minimumHeadroomBytes: 1,
      reservedBytesPerTurn: 1,
    });
    const lease = await controller.acquire('pi');
    expect(lease).toBeDefined();
    expect(controller.snapshot().activeTurns).toBe(1);
    lease.release();
  });

  it('does not block on PID when pids.max is undefined (unbounded)', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 8,
      memory: () => ({ currentBytes: 100, limitBytes: 10_000 }),
      readPids: () => ({ current: 50_000, source: 'service' }),
      reservedPidsPerTurn: 256,
      minimumHeadroomBytes: 1,
      reservedBytesPerTurn: 1,
    });
    const lease = await controller.acquire('pi');
    expect(lease).toBeDefined();
    lease.release();
  });

  it('preserves P0/P1 control under PID pressure (control does not fork)', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 8,
      memory: () => ({ currentBytes: 100, limitBytes: 10_000 }),
      readPids: () => ({ current: 800, max: 1024, source: 'service' }),
      reservedPidsPerTurn: 256,
      minimumHeadroomBytes: 1,
      reservedBytesPerTurn: 1,
    });
    // P2 execution is refused...
    await expect(controller.acquire('pi')).rejects.toMatchObject({ reason: 'pid_pressure' });
    // ...but P0 control still succeeds.
    const control = await controller.acquire('pi', 'P0');
    expect(control).toBeDefined();
    control.release();
  });

  it('projects admitted-but-not-yet-realised turns: blocks before pids.current moves (race)', async () => {
    // pids.current stays low (100) throughout; several turns are admitted
    // before the runtime's child/task usage shows up. The projected guard must
    // still block once accumulated reservations would breach the ceiling.
    const controller = new AdmissionController({
      maxActiveTurns: 8,
      memory: () => ({ currentBytes: 100, limitBytes: 10_000 }),
      readPids: () => ({ current: 100, max: 1024, source: 'service' }),
      reservedPidsPerTurn: 256,
      minimumHeadroomBytes: 1,
      reservedBytesPerTurn: 1,
    });
    const held: Array<{ release: () => void }> = [];
    // 100 + (0+1)*256=356, +512=612, +768=868 → all admit; +(3+1)*256=1124 >= 1024 → block.
    for (let i = 0; i < 3; i += 1) held.push(await controller.acquire('pi'));
    await expect(controller.acquire('pi')).rejects.toMatchObject({ reason: 'pid_pressure' });
    for (const lease of held) lease.release();
    // After release, admission opens again.
    const again = await controller.acquire('pi');
    expect(again).toBeDefined();
    again.release();
  });
});

describe('AdmissionController — host-memory-pressure gate', () => {
  // The service cgroup bounds only THIS process; tmux/external work sits outside
  // it, so the service can show headroom while the host is exhausted.
  it('refuses P2/P3 execution when host-available memory is below the gate', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 8,
      memory: () => ({ currentBytes: 100, limitBytes: 12 * 1024 * 1024 * 1024 }), // service cgroup fine
      host: () => ({ memAvailableBytes: 100 * 1024 * 1024, memTotalBytes: 32 * 1024 * 1024 * 1024, source: 'host' }), // host low
      hostMinimumHeadroomBytes: 512 * 1024 * 1024,
      readPids: () => ({ current: 10, max: 1024, source: 'service' }),
      minimumHeadroomBytes: 1,
      reservedBytesPerTurn: 1,
    });
    await expect(controller.acquire('pi')).rejects.toMatchObject({ reason: 'host_memory_pressure' });
    const snap = controller.snapshot();
    expect(snap.available).toBe(false);
    expect(snap.reason).toBe('host_memory_pressure');
    expect(snap.host?.memAvailableBytes).toBe(100 * 1024 * 1024);
    expect(snap.host?.hostPressure).toBe(true);
  });

  it('admits when host-available memory is healthy', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 8,
      memory: () => ({ currentBytes: 100, limitBytes: 12 * 1024 * 1024 * 1024 }),
      host: () => ({ memAvailableBytes: 8 * 1024 * 1024 * 1024, source: 'host' }),
      hostMinimumHeadroomBytes: 512 * 1024 * 1024,
      readPids: () => ({ current: 10, max: 1024, source: 'service' }),
      minimumHeadroomBytes: 1,
      reservedBytesPerTurn: 1,
    });
    const lease = await controller.acquire('pi');
    expect(lease).toBeDefined();
    expect(controller.snapshot().host?.hostPressure).toBe(false);
    lease.release();
  });

  it('does not gate on host when host telemetry is unavailable', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 8,
      memory: () => ({ currentBytes: 100, limitBytes: 12 * 1024 * 1024 * 1024 }),
      host: () => ({ source: 'host' }), // memAvailableBytes undefined
      hostMinimumHeadroomBytes: 512 * 1024 * 1024,
      readPids: () => ({ current: 10, max: 1024, source: 'service' }),
      minimumHeadroomBytes: 1,
      reservedBytesPerTurn: 1,
    });
    const lease = await controller.acquire('pi');
    expect(lease).toBeDefined();
    lease.release();
  });
});

describe('AdmissionController — Phase 4 priority classes', () => {
  const GiB = 1024 * 1024 * 1024;

  it('saturated P2/P3 cannot consume the reserved P0/P1 control slot', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 6,
      interactiveReserve: 1,
      memory: () => ({ currentBytes: 0, limitBytes: 12 * GiB }),
      minimumHeadroomBytes: 100,
      reservedBytesPerTurn: 1,
    });
    // P2/P3 execution capacity = 6 - controlReserve(1) = 5.
    for (let i = 0; i < 5; i += 1) await controller.acquire('pi'); // default class P2
    // A 6th P2 is refused (execution capacity exhausted) ...
    await expect(controller.acquire('pi')).rejects.toMatchObject({ reason: 'global_limit' });
    // ... but a P0 control acquire still succeeds on the reserved control slot.
    const control = await controller.acquire('pi', 'P0');
    expect(control).toBeDefined();
    expect(controller.snapshot().classes?.P0.active).toBe(1);
    control.release();
  });

  it('bounds P0/P1 by the global turn cap (control cannot starve execution beyond the ceiling)', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 3,
      interactiveReserve: 1,
      memory: () => ({ currentBytes: 0, limitBytes: 10_000 }),
      minimumHeadroomBytes: 100,
      reservedBytesPerTurn: 1,
    });
    const a = await controller.acquire('pi', 'P0');
    const b = await controller.acquire('pi', 'P1');
    const c = await controller.acquire('pi', 'P0'); // totalActive = 3 = maxActiveTurns
    await expect(controller.acquire('pi', 'P0')).rejects.toMatchObject({ reason: 'global_limit' });
    a.release(); b.release(); c.release();
  });

  it('P0/P1 control is preserved under memory pressure and refused only at the critical floor (emergency mode)', async () => {
    // Mere pressure (projected 49 < minHeadroom 100, but > critical 25): execution
    // refused, control preserved (emergency mode).
    const pressured = new AdmissionController({
      maxActiveTurns: 6, interactiveReserve: 1, runtimeMaxActiveTurns: { pi: 6 },
      memory: () => ({ currentBytes: 9_950, limitBytes: 10_000 }),
      minimumHeadroomBytes: 100, reservedBytesPerTurn: 1,
    });
    await expect(pressured.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'memory_pressure' });
    const ctrl = await pressured.acquire('pi', 'P0');
    expect(ctrl).toBeDefined();
    expect(pressured.snapshot().emergencyMode).toBe(true);
    expect(pressured.snapshot().controlAvailable).toBe(true);
    ctrl.release();
    // Critical floor (projected < 25): control is refused too.
    const critical = new AdmissionController({
      maxActiveTurns: 6, interactiveReserve: 1,
      memory: () => ({ currentBytes: 9_980, limitBytes: 10_000 }),
      minimumHeadroomBytes: 100, reservedBytesPerTurn: 1,
    });
    await expect(critical.acquire('pi', 'P0')).rejects.toMatchObject({ reason: 'memory_pressure' });
    expect(critical.snapshot().controlAvailable).toBe(false);
  });

  it('exposes per-class counts, controlReserve, and executionCapacity in the snapshot', () => {
    const controller = new AdmissionController({
      maxActiveTurns: 6,
      interactiveReserve: 1,
      memory: () => ({ currentBytes: 0, limitBytes: 10_000 }),
      minimumHeadroomBytes: 100,
      reservedBytesPerTurn: 1,
    });
    const snap = controller.snapshot();
    expect(snap.classes).toMatchObject({
      P0: { active: 0 }, P1: { active: 0 }, P2: { active: 0 }, P3: { active: 0 },
    });
    expect(snap.controlReserve).toBe(1);
    expect(snap.executionCapacity).toBe(5);
  });

  it('reports controlAvailable=true under P2 saturation and a P1 control acquire still succeeds', async () => {
    const controller = new AdmissionController({
      maxActiveTurns: 6,
      interactiveReserve: 1,
      runtimeMaxActiveTurns: { pi: 6 },
      memory: () => ({ currentBytes: 0, limitBytes: 12 * GiB }),
      minimumHeadroomBytes: 100,
      reservedBytesPerTurn: 1,
    });
    for (let i = 0; i < 5; i += 1) await controller.acquire('pi', 'P2'); // saturate execution
    const snap = controller.snapshot();
    expect(snap.available).toBe(false);        // P2/P3 execution saturated ...
    expect(snap.controlAvailable).toBe(true);  // ... yet control is still served
    const control = await controller.acquire('pi', 'P1');
    expect(control).toBeDefined();
    control.release();
  });

  it('controlAvailable is false only at the critical memory floor', () => {
    const ok = new AdmissionController({
      maxActiveTurns: 6, interactiveReserve: 1,
      memory: () => ({ currentBytes: 0, limitBytes: 12 * GiB }),
      minimumHeadroomBytes: 100, reservedBytesPerTurn: 1,
    });
    expect(ok.snapshot().controlAvailable).toBe(true);
    const critical = new AdmissionController({
      maxActiveTurns: 6, interactiveReserve: 1,
      memory: () => ({ currentBytes: 9_980, limitBytes: 10_000 }),
      minimumHeadroomBytes: 100, reservedBytesPerTurn: 1,
    });
    expect(critical.snapshot().controlAvailable).toBe(false);
  });
});

describe('admissionStartupStatus', () => {
  it('applies conservative production defaults for unset knobs (env-lost-in-prod is SAFE)', () => {
    const { resolved, warning, usingDefaults, explicitKnobs, prodFallbackKnobs, options } = admissionStartupStatus({ isProduction: true });
    // Conservative prod defaults applied — not CPU-derived.
    expect(usingDefaults).toBe(false);
    expect(resolved.maxActiveTurns).toBe(6);
    expect(resolved.apiTurnLimit).toBe(5);
    expect(resolved.minimumHeadroomBytes).toBe(1536 * 1024 * 1024);
    expect(resolved.reservedBytesPerTurn).toBe(768 * 1024 * 1024);
    expect(explicitKnobs).toEqual([]);
    expect(prodFallbackKnobs).toContain('maxActiveTurns');
    expect(prodFallbackKnobs).toContain('hostMinimumHeadroomBytes');
    // The controller is constructed from the defaulted options.
    expect(options.maxActiveTurns).toBe(6);
    expect(warning).toMatch(/conservative fallback/i);
  });

  it('does not apply fallback when the knobs are explicitly configured in production', () => {
    const { resolved, warning, usingDefaults, explicitKnobs, prodFallbackKnobs } = admissionStartupStatus({
      maxActiveTurns: 6, interactiveReserve: 1, minimumHeadroomBytes: 1536 * 1024 * 1024,
      reservedBytesPerTurn: 768 * 1024 * 1024, reservedPidsPerTurn: 256,
      hostMinimumHeadroomBytes: 512 * 1024 * 1024, isProduction: true,
    });
    expect(usingDefaults).toBe(false);
    expect(prodFallbackKnobs).toEqual([]);
    expect(explicitKnobs).toContain('maxActiveTurns');
    expect(warning).toBeUndefined();
    expect(resolved).toMatchObject({ maxActiveTurns: 6, apiTurnLimit: 5, interactiveReserve: 1 });
  });

  it('outside production uses CPU-derived defaults (no fallback, no warning)', () => {
    const { warning, usingDefaults, prodFallbackKnobs } = admissionStartupStatus({ isProduction: false });
    expect(usingDefaults).toBe(true);
    expect(prodFallbackKnobs).toEqual([]);
    expect(warning).toBeUndefined();
  });

  it('resolveAdmissionConfig matches the controller constructor (single source of truth)', () => {
    const opts = { maxActiveTurns: 4, interactiveReserve: 1, minimumHeadroomBytes: 1000, reservedBytesPerTurn: 100 };
    const resolved = resolveAdmissionConfig(opts);
    const controller = new AdmissionController(opts);
    const snap = controller.snapshot();
    expect(resolved.maxActiveTurns).toBe(snap.maxActiveTurns);
    expect(resolved.apiTurnLimit).toBe(snap.apiTurnLimit);
    expect(resolved.minimumHeadroomBytes).toBe(snap.memory.minimumHeadroomBytes);
    expect(resolved.reservedBytesPerTurn).toBe(snap.memory.reservedBytesPerTurn);
  });
});
