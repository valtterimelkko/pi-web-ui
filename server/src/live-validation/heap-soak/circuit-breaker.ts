import type { CircuitBreakerConfig, CircuitBreakerState, LaneName } from './types.js';

export const DEFAULT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 4,
  cooldownMs: 5 * 60_000,
};

export function createBreakerState(lane: LaneName): CircuitBreakerState {
  return {
    lane,
    consecutiveFailures: 0,
    open: false,
    totalSuccesses: 0,
    totalFailures: 0,
  };
}

/** Pure transition: a successful wave iteration on this lane. */
export function recordSuccess(state: CircuitBreakerState): CircuitBreakerState {
  return {
    ...state,
    consecutiveFailures: 0,
    open: false,
    openedAtMs: undefined,
    cooldownUntilMs: undefined,
    totalSuccesses: state.totalSuccesses + 1,
  };
}

/**
 * Pure transition: a failed wave iteration (429, provider error, create
 * failure). Opens the breaker once `consecutiveFailures` reaches the
 * threshold; failures never throw or otherwise become fatal to the harness.
 */
export function recordFailure(
  state: CircuitBreakerState,
  nowMs: number,
  config: CircuitBreakerConfig = DEFAULT_BREAKER_CONFIG,
): CircuitBreakerState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  const totalFailures = state.totalFailures + 1;
  if (consecutiveFailures >= config.failureThreshold) {
    return {
      ...state,
      consecutiveFailures,
      totalFailures,
      open: true,
      openedAtMs: state.open ? state.openedAtMs : nowMs,
      cooldownUntilMs: nowMs + config.cooldownMs,
    };
  }
  return { ...state, consecutiveFailures, totalFailures };
}

/**
 * Whether the lane is currently usable. A breaker that has passed its cooldown
 * is treated as half-open (usable again, but still flagged `open` in state
 * until the next `recordSuccess`/`recordFailure` resolves it) — this function
 * is what callers should consult before picking a lane.
 */
export function isLaneAvailable(state: CircuitBreakerState, nowMs: number): boolean {
  if (!state.open) return true;
  if (state.cooldownUntilMs !== undefined && nowMs >= state.cooldownUntilMs) return true;
  return false;
}
