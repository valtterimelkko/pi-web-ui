import { describe, expect, it } from 'vitest';
import {
  createBreakerState,
  DEFAULT_BREAKER_CONFIG,
  isLaneAvailable,
  recordFailure,
  recordSuccess,
} from '../../../src/live-validation/heap-soak/circuit-breaker.js';

describe('circuit breaker', () => {
  it('starts closed and available', () => {
    const state = createBreakerState('A');
    expect(state.open).toBe(false);
    expect(isLaneAvailable(state, 0)).toBe(true);
  });

  it('opens after reaching the consecutive-failure threshold', () => {
    let state = createBreakerState('A');
    const config = { failureThreshold: 3, cooldownMs: 1000 };
    state = recordFailure(state, 0, config);
    state = recordFailure(state, 0, config);
    expect(state.open).toBe(false);
    state = recordFailure(state, 0, config);
    expect(state.open).toBe(true);
    expect(state.cooldownUntilMs).toBe(1000);
    expect(isLaneAvailable(state, 0)).toBe(false);
  });

  it('a success resets consecutiveFailures and closes the breaker', () => {
    let state = createBreakerState('A');
    const config = { failureThreshold: 2, cooldownMs: 1000 };
    state = recordFailure(state, 0, config);
    state = recordFailure(state, 0, config);
    expect(state.open).toBe(true);
    state = recordSuccess(state);
    expect(state.open).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.totalSuccesses).toBe(1);
  });

  it('becomes available again once the cooldown has passed, without an explicit close', () => {
    let state = createBreakerState('A');
    const config = { failureThreshold: 1, cooldownMs: 500 };
    state = recordFailure(state, 1000, config);
    expect(isLaneAvailable(state, 1000)).toBe(false);
    expect(isLaneAvailable(state, 1499)).toBe(false);
    expect(isLaneAvailable(state, 1500)).toBe(true);
  });

  it('never throws — failures accumulate as data, not exceptions', () => {
    let state = createBreakerState('B');
    for (let i = 0; i < 50; i++) state = recordFailure(state, i * 100, DEFAULT_BREAKER_CONFIG);
    expect(state.totalFailures).toBe(50);
  });
});
