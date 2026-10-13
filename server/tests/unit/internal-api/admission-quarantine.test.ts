import { describe, expect, it } from 'vitest';
import { AdmissionController, admissionRefusalFields } from '../../../src/internal-api/admission-controller.js';

/** W2-f (contract 1.62.0): a refusal tipped over by quarantined leases says so. */

function controller(extra: Record<string, unknown> = {}) {
  return new AdmissionController({
    maxActiveTurns: 6,
    interactiveReserve: 1,
    memory: () => ({ currentBytes: 100, limitBytes: 10_000_000 }),
    minimumHeadroomBytes: 100,
    reservedBytesPerTurn: 1,
    ...extra,
  });
}

async function fillAndRefuse(c: AdmissionController, runtime: 'pi' | 'claude' = 'pi') {
  const leases: Array<{ release: () => void }> = [];
  for (;;) {
    try { leases.push(await c.acquire(runtime)); } catch (error) { return { leases, error: error as { reason: string; quarantine?: unknown } }; }
  }
}

describe('admission refusal names quarantined debt', () => {
  it('global_limit tipped over by quarantined leases carries reason quarantined_debt + counts, keeping the original status mapping', async () => {
    const c = controller();
    c.setQuarantineSource(() => ({ byRuntime: { pi: 2 }, oldestAgeMs: 123_000 }));
    const { error } = await fillAndRefuse(c);
    expect(error.reason).toBe('global_limit'); // original reason unchanged: 429 mapping stays
    expect(admissionRefusalFields(error as never)).toMatchObject({
      reason: 'quarantined_debt',
      admissionReason: 'global_limit',
      quarantinedRuns: 2,
      quarantinedOldestAgeMs: 123_000,
    });
  });

  it('no quarantined leases (or none that explain the refusal) leaves the plain reason', async () => {
    const none = controller();
    none.setQuarantineSource(() => ({ byRuntime: {}, oldestAgeMs: undefined }));
    const { error: plain } = await fillAndRefuse(none);
    expect(admissionRefusalFields(plain as never)).toEqual({ reason: 'global_limit' });
  });

  it('with no quarantine source configured the body fields are the plain reason', async () => {
    const { error } = await fillAndRefuse(controller());
    expect(admissionRefusalFields(error as never)).toEqual({ reason: 'global_limit' });
  });

  it('runtime_limit is attributed using the quarantined leases of THAT runtime only', async () => {
    const c = controller({ runtimeMaxActiveTurns: { claude: 2 } });
    c.setQuarantineSource(() => ({ byRuntime: { pi: 3 }, oldestAgeMs: 1 }));
    const a = await c.acquire('claude');
    const b = await c.acquire('claude');
    await expect(c.acquire('claude')).rejects.toMatchObject({ reason: 'runtime_limit' });
    const refused = await c.acquire('claude').catch((e) => e);
    expect(admissionRefusalFields(refused).reason).toBe('runtime_limit'); // pi debt does not explain a claude limit
    c.setQuarantineSource(() => ({ byRuntime: { claude: 1 }, oldestAgeMs: 9 }));
    const refused2 = await c.acquire('claude').catch((e) => e);
    expect(admissionRefusalFields(refused2)).toMatchObject({ reason: 'quarantined_debt', admissionReason: 'runtime_limit', quarantinedRuns: 1 });
    a.release(); b.release();
  });

  it('memory_pressure that clears once quarantined reservations are returned is attributed', async () => {
    // headroom 1000, reserve 100/turn, floor 500: 4 active +1 => projected 500 (ok)... 5 active => 400 (<500)
    const c = new AdmissionController({
      maxActiveTurns: 20,
      interactiveReserve: 1,
      memory: () => ({ currentBytes: 9_000, limitBytes: 10_000 }),
      minimumHeadroomBytes: 500,
      memoryCriticalBytes: 0,
      reservedBytesPerTurn: 100,
    });
    c.setQuarantineSource(() => ({ byRuntime: { pi: 2 }, oldestAgeMs: 60_000 }));
    const held: Array<{ release: () => void }> = [];
    let refusal: unknown;
    for (let i = 0; i < 10 && !refusal; i += 1) {
      try { held.push(await c.acquire('pi')); } catch (error) { refusal = error; }
    }
    expect((refusal as { reason: string }).reason).toBe('memory_pressure');
    expect(admissionRefusalFields(refusal as never)).toMatchObject({ reason: 'quarantined_debt', admissionReason: 'memory_pressure', quarantinedRuns: 2 });
  });

  it('draining and heap/lag refusals are never attributed to quarantine', async () => {
    const c = controller();
    c.setQuarantineSource(() => ({ byRuntime: { pi: 5 }, oldestAgeMs: 1 }));
    c.setDraining({ since: Date.now(), reason: 'deploy' });
    const error = await c.acquire('pi').catch((e) => e);
    expect(admissionRefusalFields(error).reason).toBe('draining');
  });
});
