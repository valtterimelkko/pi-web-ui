import { describe, expect, it } from 'vitest';
import {
  SOCKET_UNREACHABLE_STRIKES,
  classifyServerLiveness,
  decideServerDeath,
  recordServerDeath,
  resolveReportedRunOutcome,
  shouldSendFinalNotice,
  shouldTerminaliseOnStartupRecovery,
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

describe('recordServerDeath', () => {
  it('terminalises a nonterminal run with the death evidence', () => {
    const state = runState();
    recordServerDeath(state, { reason: 'unit gone', detectedAt: '2026-09-27T13:53:36Z', elapsedMs: 45_585, activeState: 'deactivating', exitStatus: 'signal/9', journalLines: ['line'] });
    expect(state.terminalState).toBe('server_died');
    expect(state.serverDeath).toMatchObject({ reason: 'unit gone', elapsedMs: 45_585, activeState: 'deactivating', exitStatus: 'signal/9', journalLines: ['line'] });
  });

  it('is idempotent: an existing death is never overwritten', () => {
    const state = runState();
    state.terminalState = 'server_died';
    state.serverDeath = { detectedAt: 'first', elapsedMs: 1, reason: 'first' };
    recordServerDeath(state, { reason: 'second', detectedAt: 'second', elapsedMs: 2 });
    expect(state.serverDeath.reason).toBe('first');
    expect(state.serverDeath.detectedAt).toBe('first');
  });

  it('never reclassifies an already-completed run as a death (correction 03)', () => {
    const state = runState();
    state.terminalState = 'complete';
    recordServerDeath(state, { reason: 'unit stopped later', detectedAt: 'later', elapsedMs: 99 });
    expect(state.terminalState).toBe('complete');
    expect(state.serverDeath).toBeUndefined();
  });
});

describe('shouldTerminaliseOnStartupRecovery (correction 03)', () => {
  it('terminalises a nonterminal run', () => {
    expect(shouldTerminaliseOnStartupRecovery(runState())).toBe(true);
  });
  it('does not reclassify a completed run', () => {
    const state = runState();
    state.terminalState = 'complete';
    expect(shouldTerminaliseOnStartupRecovery(state)).toBe(false);
  });
  it('does not re-terminalise an already-recorded death', () => {
    const state = runState();
    state.terminalState = 'server_died';
    state.serverDeath = { detectedAt: 'd', elapsedMs: 1, reason: 'r' };
    expect(shouldTerminaliseOnStartupRecovery(state)).toBe(false);
  });
  it('does terminalise a server_died state that is missing its evidence', () => {
    const state = runState();
    state.terminalState = 'server_died';
    expect(shouldTerminaliseOnStartupRecovery(state)).toBe(true);
  });
});

describe('shouldSendFinalNotice — at-least-once semantics (correction 03)', () => {
  it('sends when no marker is persisted (so a pre-persist crash re-sends: at least once)', () => {
    expect(shouldSendFinalNotice('death', runState())).toBe(true);
    expect(shouldSendFinalNotice('completion', runState())).toBe(true);
  });
  it('does not send again once the marker is persisted (normally once)', () => {
    const death = runState();
    death.deathNoticeSentAt = 't';
    expect(shouldSendFinalNotice('death', death)).toBe(false);
    const completion = runState();
    completion.completionNoticeSentAt = 't';
    expect(shouldSendFinalNotice('completion', completion)).toBe(false);
  });
});

describe('resolveReportedRunOutcome', () => {
  const obsGone = { loadState: 'not-found', activeState: 'inactive', mainPid: undefined };
  const obsAlive = { loadState: 'active', activeState: 'active', mainPid: 4242 };
  const evidence = { detectedAt: '2026-09-27T13:53:36Z', elapsedMs: 45_585, reason: 'server unit gone' };

  it('uses a persisted server death', () => {
    const state = runState();
    state.terminalState = 'server_died';
    state.serverDeath = { detectedAt: 'd', elapsedMs: 5, reason: 'r' };
    expect(resolveReportedRunOutcome(state, obsGone, evidence).terminalState).toBe('server_died');
  });

  it('keeps a completed run complete even after its server has since stopped', () => {
    const state = runState();
    state.terminalState = 'complete';
    expect(resolveReportedRunOutcome(state, obsGone, evidence).terminalState).toBe('complete');
  });

  it('renders a nonterminal run whose server is gone as server_died, never complete', () => {
    const outcome = resolveReportedRunOutcome(runState(), obsGone, evidence);
    expect(outcome.terminalState).toBe('server_died');
    expect(outcome.serverDeath?.reason).toBe('server unit gone');
    expect(outcome.coveredWindowMs).toBe(45_585);
  });

  it('renders a nonterminal run whose server is still the recorded process as complete', () => {
    expect(resolveReportedRunOutcome(runState(), obsAlive, evidence).terminalState).toBe('complete');
  });
});
