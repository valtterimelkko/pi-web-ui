import { describe, expect, it } from 'vitest';
import {
  SOCKET_UNREACHABLE_STRIKES,
  classifyServerLiveness,
  decideServerDeath,
  type ServerLivenessObservation,
} from '../../../src/live-validation/heap-soak/server-death.js';
import type { RunState } from '../../../src/live-validation/heap-soak/run-state.js';

function runState(): RunState {
  return {
    runId: 'full-test',
    mode: 'full',
    startedAt: new Date(0).toISOString(),
    endsAt: new Date(24 * 3_600_000).toISOString(),
    runDir: '/root/.pi-web-ui/validation/heap-soak/full-test',
    server: {
      unitName: 'pi-web-ui-soak-server-full-test',
      socketPath: '/x/internal-api.sock',
      tokenPath: '/x/internal-api-token',
      inspectorPort: 9230,
      mainPid: 4242,
      httpPort: 3456,
    },
    supervisor: { unitName: 'pi-web-ui-soak-supervisor-full-test' },
    cycleCount: 0,
    laneBreakers: {} as RunState['laneBreakers'],
    csvPath: '/x/samples.csv',
    eventsLogPath: '/x/events.jsonl',
  };
}

function obs(overrides: Partial<ServerLivenessObservation> = {}): ServerLivenessObservation {
  return { loadState: 'active', activeState: 'active', mainPid: 4242, socketReachable: true, ...overrides };
}

describe('classifyServerLiveness', () => {
  it('is alive when the unit is active, the MainPID matches and the socket is reachable', () => {
    expect(classifyServerLiveness(runState(), obs()).status).toBe('alive');
  });

  it('is dead when the transient unit is no longer loaded/active', () => {
    const decision = classifyServerLiveness(runState(), obs({ loadState: 'not-found', mainPid: undefined }));
    expect(decision.status).toBe('dead');
    expect(decision.reason).toMatch(/not loaded\/active|not-found/);
  });

  it('is dead when the unit has no live MainPID', () => {
    const decision = classifyServerLiveness(runState(), obs({ mainPid: 0 }));
    expect(decision.status).toBe('dead');
  });

  it('is dead when the MainPID changed (a restarted process is not silently believed alive)', () => {
    const decision = classifyServerLiveness(runState(), obs({ mainPid: 9999 }));
    expect(decision.status).toBe('dead');
    expect(decision.reason).toMatch(/9999/);
  });

  it('is unconfirmed (not dead) when the unit/PID look right but the socket is unreachable', () => {
    expect(classifyServerLiveness(runState(), obs({ socketReachable: false })).status).toBe('unconfirmed');
  });
});

describe('decideServerDeath', () => {
  it('does not declare death while liveness is alive', () => {
    expect(decideServerDeath(runState(), obs(), 0).died).toBe(false);
  });

  it('declares death immediately on a unit/PID change, regardless of socket state', () => {
    const decision = decideServerDeath(runState(), obs({ mainPid: 1 }), 0);
    expect(decision.died).toBe(true);
  });

  it('tolerates a transient socket blip below the strike threshold', () => {
    expect(decideServerDeath(runState(), obs({ socketReachable: false }), SOCKET_UNREACHABLE_STRIKES - 1).died).toBe(false);
  });

  it('declares death once the socket has been unreachable for the strike threshold', () => {
    const decision = decideServerDeath(runState(), obs({ socketReachable: false }), SOCKET_UNREACHABLE_STRIKES);
    expect(decision.died).toBe(true);
    expect(decision.reason).toMatch(/socket is unreachable/i);
  });
});
