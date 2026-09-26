import { describe, expect, it } from 'vitest';
import { decideReattach, parseRunState, serializeRunState, type RunState } from '../../../src/live-validation/heap-soak/run-state.js';

function baseState(): RunState {
  return {
    runId: 'run-1',
    mode: 'micro',
    startedAt: new Date(0).toISOString(),
    endsAt: new Date(1_200_000).toISOString(),
    runDir: '/root/.pi-web-ui/validation/heap-soak/run-1',
    server: { unitName: 'pi-web-ui-soak-server-run-1', socketPath: '/x/internal-api.sock', tokenPath: '/x/internal-api-token', inspectorPort: 9230, mainPid: 4242, httpPort: 3456 },
    supervisor: { unitName: 'pi-web-ui-soak-supervisor-run-1' },
    cycleCount: 3,
    laneBreakers: {
      A: { lane: 'A', consecutiveFailures: 0, open: false, totalSuccesses: 5, totalFailures: 0 },
      B: { lane: 'B', consecutiveFailures: 0, open: false, totalSuccesses: 2, totalFailures: 1 },
      C: { lane: 'C', consecutiveFailures: 0, open: false, totalSuccesses: 0, totalFailures: 0 },
    },
    csvPath: '/x/samples.csv',
    eventsLogPath: '/x/events.jsonl',
  };
}

describe('run-state serialization', () => {
  it('round-trips through serialize/parse', () => {
    const state = baseState();
    const parsed = parseRunState(serializeRunState(state));
    expect(parsed).toEqual(state);
  });

  it('rejects a state missing required identity fields', () => {
    expect(() => parseRunState('{}')).toThrow(/required fields/);
  });
});

describe('decideReattach', () => {
  it('reattaches when the server unit is active with the recorded MainPID', () => {
    const decision = decideReattach(baseState(), { loadState: 'active', mainPid: 4242 });
    expect(decision.action).toBe('reattach');
  });

  it('says server-gone when the unit is not loaded/active', () => {
    const decision = decideReattach(baseState(), { loadState: 'not-found' });
    expect(decision.action).toBe('server-gone');
  });

  it('says server-gone when there is no live MainPID', () => {
    const decision = decideReattach(baseState(), { loadState: 'active', mainPid: 0 });
    expect(decision.action).toBe('server-gone');
  });

  it('refuses (pid-mismatch) rather than silently reattaching to a different process', () => {
    const decision = decideReattach(baseState(), { loadState: 'active', mainPid: 9999 });
    expect(decision.action).toBe('pid-mismatch');
    expect(decision.reason).toMatch(/9999/);
  });
});
