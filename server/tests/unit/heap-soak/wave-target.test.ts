import { describe, expect, it } from 'vitest';
import { computeTopUpCount, isBackboneDownAnomaly } from '../../../src/live-validation/heap-soak/wave-target.js';
import { DEFAULT_WAVE_TARGET_CONFIG } from '../../../src/live-validation/heap-soak/types.js';

describe('computeTopUpCount', () => {
  it('needs no top-up when B/C alone already hit the target', () => {
    const config = { targetPerWave: 4, childTurnDeadlineMs: 1000 };
    expect(computeTopUpCount({ completedByLane: { B: 3, C: 1 } }, config, 'A')).toBe(0);
  });

  it('tops up the exact shortfall when B/C under-deliver', () => {
    const config = { targetPerWave: 4, childTurnDeadlineMs: 1000 };
    expect(computeTopUpCount({ completedByLane: { A: 1, B: 1 } }, config, 'A')).toBe(2);
  });

  it('tops up the full target when every lane fails (B/C forced-fail scenario)', () => {
    const config = { targetPerWave: 4, childTurnDeadlineMs: 1000 };
    expect(computeTopUpCount({ completedByLane: { B: 0, C: 0 } }, config, 'A')).toBe(4);
  });

  it('never returns a negative top-up', () => {
    const config = { targetPerWave: 4, childTurnDeadlineMs: 1000 };
    expect(computeTopUpCount({ completedByLane: { A: 6 } }, config, 'A')).toBe(0);
  });

  it('matches the default config shape', () => {
    expect(computeTopUpCount({ completedByLane: {} }, DEFAULT_WAVE_TARGET_CONFIG, 'A')).toBe(DEFAULT_WAVE_TARGET_CONFIG.targetPerWave);
  });
});

describe('isBackboneDownAnomaly', () => {
  const config = { targetPerWave: 4, childTurnDeadlineMs: 1000 };

  it('is NOT an anomaly when B/C fail but A (backbone) tops up to target', () => {
    expect(isBackboneDownAnomaly({ completedByLane: { A: 4, B: 0, C: 0 } }, config, 'A')).toBe(false);
  });

  it('is NOT an anomaly when B/C fail but A partially covers and target is still met by A alone', () => {
    expect(isBackboneDownAnomaly({ completedByLane: { A: 5 } }, config, 'A')).toBe(false);
  });

  it('IS an anomaly when the backbone itself delivers nothing and target is missed', () => {
    expect(isBackboneDownAnomaly({ completedByLane: { A: 0, B: 1 } }, config, 'A')).toBe(true);
  });

  it('B/C alone failing (backbone untouched, target still met) is not an anomaly', () => {
    expect(isBackboneDownAnomaly({ completedByLane: { A: 4, B: 0 } }, config, 'A')).toBe(false);
  });
});
