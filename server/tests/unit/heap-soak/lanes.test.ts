import { describe, expect, it } from 'vitest';
import { applyForcedBadLanes, backboneLane, enabledLanes, LANE_DEFINITIONS, pickLane } from '../../../src/live-validation/heap-soak/lanes.js';
import { createBreakerState, recordFailure } from '../../../src/live-validation/heap-soak/circuit-breaker.js';
import type { CircuitBreakerState, LaneName } from '../../../src/live-validation/heap-soak/types.js';

describe('lane definitions', () => {
  it('lane C is disabled with a documented reason, A and B are enabled', () => {
    const byName = Object.fromEntries(LANE_DEFINITIONS.map((l) => [l.name, l]));
    expect(byName.A.enabled).toBe(true);
    expect(byName.B.enabled).toBe(true);
    expect(byName.C.enabled).toBe(false);
    expect(byName.C.disabledReason).toMatch(/commandcode/i);
    expect(enabledLanes(LANE_DEFINITIONS).map((l) => l.name).sort()).toEqual(['A', 'B']);
  });

  it('lane A is the sole backbone lane; B/C are never load-bearing', () => {
    const byName = Object.fromEntries(LANE_DEFINITIONS.map((l) => [l.name, l]));
    expect(byName.A.isBackbone).toBe(true);
    expect(byName.B.isBackbone).toBe(false);
    expect(byName.C.isBackbone).toBe(false);
    expect(backboneLane(LANE_DEFINITIONS).name).toBe('A');
  });

  it('non-backbone lanes have a small concurrency cap so slow free models cannot pile up sessions', () => {
    const byName = Object.fromEntries(LANE_DEFINITIONS.map((l) => [l.name, l]));
    expect(byName.B.maxConcurrent).toBeLessThanOrEqual(2);
    expect(byName.C.maxConcurrent).toBeLessThanOrEqual(2);
    expect(byName.A.maxConcurrent).toBeGreaterThan(byName.B.maxConcurrent);
  });

  it('lane A and B use the exact model ids from the spec', () => {
    const byName = Object.fromEntries(LANE_DEFINITIONS.map((l) => [l.name, l]));
    expect(byName.A.modelIds).toEqual(['zai/glm-5.3-flash']);
    expect(byName.B.modelIds).toEqual([
      'openrouter/poolside/laguna-s-2.1:free',
      'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
      'openrouter/qwen/qwen3.8-27b:free',
    ]);
  });
});

describe('applyForcedBadLanes', () => {
  it('is a no-op when the env key is unset', () => {
    const lanes = applyForcedBadLanes(enabledLanes(LANE_DEFINITIONS), {});
    expect(lanes).toEqual(enabledLanes(LANE_DEFINITIONS));
  });

  it('replaces the forced lane\'s model ids with an invalid model id', () => {
    const lanes = applyForcedBadLanes(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_FORCE_BAD_LANE: 'B' });
    const b = lanes.find((l) => l.name === 'B')!;
    expect(b.modelIds).toEqual(['invalid-provider/does-not-exist-model']);
    const a = lanes.find((l) => l.name === 'A')!;
    expect(a.modelIds).toEqual(['zai/glm-5.3-flash']); // untouched
  });

  it('refuses to force-fail the backbone lane', () => {
    expect(() => applyForcedBadLanes(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_FORCE_BAD_LANE: 'A' })).toThrow(/backbone/);
  });
});

describe('pickLane', () => {
  const lanes = enabledLanes(LANE_DEFINITIONS); // A weight 0.6, B weight 0.25

  it('is deterministic given an rng and picks proportionally to weight', () => {
    const breakers = new Map<LaneName, CircuitBreakerState>();
    // roll 0 -> first candidate by weight order (A)
    expect(pickLane(lanes, breakers, 0, () => 0)?.name).toBe('A');
    // roll just above A's weight share should land on B
    const totalWeight = lanes.reduce((s, l) => s + l.weight, 0);
    const justPastA = (lanes[0].weight + 1e-9) / totalWeight;
    expect(pickLane(lanes, breakers, 0, () => justPastA)?.name).toBe('B');
  });

  it('excludes an open-circuit lane entirely', () => {
    const breakerB = recordFailure(recordFailure(recordFailure(recordFailure(createBreakerState('B'), 0), 0), 0), 0);
    const breakers = new Map<LaneName, CircuitBreakerState>([['B', breakerB]]);
    for (let roll = 0; roll <= 1; roll += 0.1) {
      expect(pickLane(lanes, breakers, 0, () => roll)?.name).toBe('A');
    }
  });

  it('returns undefined when every lane is unavailable', () => {
    const breakerA = recordFailure(recordFailure(recordFailure(recordFailure(createBreakerState('A'), 0), 0), 0), 0);
    const breakerB = recordFailure(recordFailure(recordFailure(recordFailure(createBreakerState('B'), 0), 0), 0), 0);
    const breakers = new Map<LaneName, CircuitBreakerState>([['A', breakerA], ['B', breakerB]]);
    expect(pickLane(lanes, breakers, 0, () => 0.5)).toBeUndefined();
  });
});
