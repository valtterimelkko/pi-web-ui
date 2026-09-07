import { describe, expect, it, vi } from 'vitest';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';

describe('admission refusal explanation', () => {
  it('explains actual, reserved and projected task usage from the deciding sample', async () => {
    const readPids = vi.fn(() => ({ current: 285, max: 1024, source: 'service' as const }));
    const admission = new AdmissionController({
      maxActiveTurns: 6, reservedPidsPerTurn: 256,
      memory: () => ({ currentBytes: 0, limitBytes: 10_000 }),
      minimumHeadroomBytes: 1, reservedBytesPerTurn: 1,
      hostMinimumHeadroomBytes: 1,
      host: () => ({ memAvailableBytes: 10_000, source: 'host' }),
      readPids,
    });
    const first = await admission.acquire('pi');
    const second = await admission.acquire('claude');
    readPids.mockClear();
    try {
      await expect(admission.acquire('pi')).rejects.toMatchObject({
        reason: 'pid_pressure',
        message: expect.stringContaining('currentTasks=285 reservedTasks=768 projectedTasks=1053 taskLimit=1024'),
      });
      expect(readPids).toHaveBeenCalledTimes(1);
    } finally {
      first.release(); second.release();
    }
  });
});
