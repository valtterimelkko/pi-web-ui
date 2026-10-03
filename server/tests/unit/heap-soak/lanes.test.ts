import { describe, expect, it } from 'vitest';
import { applyForcedBadLanes, applyLaneMaxConcurrent, applyLaneSelection, backboneLane, enabledLanes, LANE_DEFINITIONS, pickLane, resolveDriverLanes } from '../../../src/live-validation/heap-soak/lanes.js';
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

describe('applyLaneSelection (HEAP_SOAK_LANES — E2a-1: lane A only, OpenRouter not authorised)', () => {
  it('is a no-op when the env key is unset or blank', () => {
    expect(applyLaneSelection(enabledLanes(LANE_DEFINITIONS), {})).toEqual(enabledLanes(LANE_DEFINITIONS));
    expect(applyLaneSelection(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_LANES: '' })).toEqual(enabledLanes(LANE_DEFINITIONS));
    expect(applyLaneSelection(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_LANES: '  ' })).toEqual(enabledLanes(LANE_DEFINITIONS));
  });

  it('disables every lane not named, keeping named lanes untouched', () => {
    const lanes = applyLaneSelection(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_LANES: 'A' });
    expect(lanes.map((l) => l.name).sort()).toEqual(['A', 'B']); // same lanes, B now disabled
    const a = lanes.find((l) => l.name === 'A')!;
    const b = lanes.find((l) => l.name === 'B')!;
    expect(a.enabled).toBe(true);
    expect(a).toEqual(enabledLanes(LANE_DEFINITIONS).find((l) => l.name === 'A'));
    expect(b.enabled).toBe(false);
    expect(b.disabledReason).toMatch(/HEAP_SOAK_LANES/);
  });

  it('accepts a comma-separated list and ignores whitespace', () => {
    const lanes = applyLaneSelection(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_LANES: ' A , B ' });
    expect(lanes.every((l) => l.enabled)).toBe(true);
  });

  it('refuses unknown lane names', () => {
    expect(() => applyLaneSelection(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_LANES: 'A,Z' })).toThrow(/unknown lane/i);
  });

  it('refuses a selection without the backbone lane (the harness requires one load-bearing lane)', () => {
    expect(() => applyLaneSelection(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_LANES: 'B' })).toThrow(/backbone/);
  });

  it('does not mutate the input definitions', () => {
    const before = JSON.stringify(enabledLanes(LANE_DEFINITIONS));
    applyLaneSelection(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_LANES: 'A' });
    expect(JSON.stringify(enabledLanes(LANE_DEFINITIONS))).toBe(before);
  });
});

describe('applyLaneMaxConcurrent (HEAP_SOAK_MAX_CONCURRENT — E2a-1: lane A at most 4)', () => {
  it('is a no-op when the env key is unset', () => {
    expect(applyLaneMaxConcurrent(enabledLanes(LANE_DEFINITIONS), {})).toEqual(enabledLanes(LANE_DEFINITIONS));
  });

  it('caps a lane whose maxConcurrent is above the cap and leaves lanes already at or below it', () => {
    const lanes = applyLaneMaxConcurrent(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_MAX_CONCURRENT: '4' });
    const byName = Object.fromEntries(lanes.map((l) => [l.name, l]));
    expect(byName.A.maxConcurrent).toBe(4);
    expect(byName.B.maxConcurrent).toBe(1); // already below the cap; untouched
  });

  it('never raises a lane above its own definition', () => {
    const lanes = applyLaneMaxConcurrent(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_MAX_CONCURRENT: '99' });
    const byName = Object.fromEntries(lanes.map((l) => [l.name, l]));
    expect(byName.A.maxConcurrent).toBe(6);
    expect(byName.B.maxConcurrent).toBe(1);
  });

  it('refuses non-positive or non-integer caps', () => {
    expect(() => applyLaneMaxConcurrent(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_MAX_CONCURRENT: '0' })).toThrow(/whole number/);
    expect(() => applyLaneMaxConcurrent(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_MAX_CONCURRENT: '2.5' })).toThrow(/whole number/);
    expect(() => applyLaneMaxConcurrent(enabledLanes(LANE_DEFINITIONS), { HEAP_SOAK_MAX_CONCURRENT: 'x' })).toThrow(/whole number/);
  });
});

describe('resolveDriverLanes (the supervisor\'s composed selection)', () => {
  it('with no env set, equals the old behaviour: enabled lanes, no forced-bad, no cap change', () => {
    const lanes = resolveDriverLanes({});
    expect(lanes.map((l) => l.name).sort()).toEqual(['A', 'B']);
    const byName = Object.fromEntries(lanes.map((l) => [l.name, l]));
    expect(byName.A.maxConcurrent).toBe(6);
    expect(byName.A.modelIds).toEqual(['zai/glm-5.3-flash']);
  });

  it('with the E2a-1 env, only lane A remains enabled and capped at 4', () => {
    const lanes = resolveDriverLanes({ HEAP_SOAK_LANES: 'A', HEAP_SOAK_MAX_CONCURRENT: '4' });
    expect(lanes.filter((l) => l.enabled).map((l) => l.name)).toEqual(['A']);
    expect(lanes.find((l) => l.name === 'A')!.maxConcurrent).toBe(4);
  });

  it('still applies forced-bad lanes on top of the selection (Gate 1 seam keeps working)', () => {
    expect(() => resolveDriverLanes({ HEAP_SOAK_LANES: 'A', HEAP_SOAK_FORCE_BAD_LANE: 'A' })).toThrow(/backbone/);
    const lanes = resolveDriverLanes({ HEAP_SOAK_LANES: 'A,B', HEAP_SOAK_FORCE_BAD_LANE: 'B' });
    expect(lanes.find((l) => l.name === 'B')!.modelIds).toEqual(['invalid-provider/does-not-exist-model']);
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
