import { describe, expect, it } from 'vitest';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';

/**
 * B4 seam (shared verbatim with lane b2): admission gains a `draining` state.
 * While draining, new P2/P3 execution is refused with reason `draining`;
 * P0/P1 control keeps being admitted so control and disposal stay available.
 */
function roomyController(): AdmissionController {
  return new AdmissionController({
    maxActiveTurns: 6,
    interactiveReserve: 1,
    minimumHeadroomBytes: 1,
    memoryCriticalBytes: 1,
    reservedBytesPerTurn: 1,
    reservedPidsPerTurn: 1,
    hostMinimumHeadroomBytes: 1,
    memory: () => ({ currentBytes: 0, limitBytes: 1_000_000 }),
    readPids: () => ({ current: 0, max: 10_000 }),
    host: () => ({ memAvailableBytes: 1_000_000 }),
    readMemoryEvents: () => undefined,
  });
}

describe('AdmissionController draining seam (B4)', () => {
  it('is not draining by default', () => {
    expect(roomyController().getDraining()).toBeNull();
  });

  it('refuses P2 and P3 execution with reason draining while draining', async () => {
    const controller = roomyController();
    controller.setDraining({ since: 1_000, reason: 'deploy' });
    expect(controller.getDraining()).toEqual({ since: 1_000, reason: 'deploy' });
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'draining' });
    await expect(controller.acquire('claude', 'P3')).rejects.toMatchObject({ reason: 'draining' });
    expect(controller.snapshot().activeTurns).toBe(0);
  });

  it('keeps admitting P0/P1 control while draining', async () => {
    const controller = roomyController();
    controller.setDraining({ since: 1_000, reason: 'deploy' });
    const control = await controller.acquire('pi', 'P1');
    const browser = await controller.acquire('pi', 'P0');
    expect(controller.snapshot().activeTurns).toBe(2);
    control.release();
    browser.release();
  });

  it('admits execution again once draining is cleared', async () => {
    const controller = roomyController();
    controller.setDraining({ since: 1_000, reason: 'deploy' });
    controller.setDraining(null);
    const lease = await controller.acquire('pi', 'P2');
    expect(controller.snapshot().activeTurns).toBe(1);
    lease.release();
  });
});
