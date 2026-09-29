import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AgentSession as AgentSessionType } from '@earendil-works/pi-coding-agent';
import { PiService } from '../../../src/pi/pi-service.js';
import { MultiSessionManager } from '../../../src/pi/multi-session-manager.js';
import { emitSessionShutdown } from '../../../src/pi/session-shutdown.js';

/**
 * B5 (plan finding F1): Pi Web UI never emitted `session_shutdown` when it
 * disposed a Pi session — only the CLI's new/resume/fork/quit/reload did — so
 * extensions' shutdown cleanup (background-shell process teardown, goal-engine
 * and watch-wake timers, memory save, auto-compact-75 heartbeats) never ran in
 * Web UI sessions.
 *
 * These tests drive the REAL `PiService` and `MultiSessionManager` teardown
 * paths with fake `AgentSession` objects whose `extensionRunner` records
 * `session_shutdown` emissions, and assert per dispose/unload path:
 *   - the event is emitted EXACTLY ONCE,
 *   - with the mapped reason (quit everywhere; the dispose→rehydrate recovery
 *     uses `resume` + targetSessionFile so extension state is adopted by the
 *     successor runtime, exactly like a CLI session switch),
 *   - BEFORE `agentSession.dispose()` invalidates the runner (the SDK's own
 *     teardownCurrent order: emit → dispose),
 *   - a hanging handler is bounded by the emission timeout, and a throwing
 *     handler does not block disposal.
 *
 * Fake sessions are the only fake (same harness as session-release-paths.test.ts).
 */

interface FakeRunner {
  hasHandlers: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
}

interface FakeAgentSession {
  sessionId: string;
  sessionFile?: string;
  sessionPath?: string;
  extensionRunner: FakeRunner;
  dispose: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
}

interface PiServiceInternals {
  sessions: Map<string, unknown>;
  clientSessionMap: Map<string, string>;
  eventHandlers: Map<string, unknown>;
  clientWebUIContexts: Map<string, unknown>;
}

function internals(service: PiService): PiServiceInternals {
  return service as unknown as PiServiceInternals;
}

function fakeRunner(options: { hasHandlers?: boolean; emit?: FakeRunner['emit'] } = {}): FakeRunner {
  return {
    hasHandlers: vi.fn(() => options.hasHandlers ?? true),
    emit: options.emit ?? vi.fn(async () => undefined),
  };
}

let sessionCounter = 0;

function fakeAgentSession(sessionId: string, sessionFile?: string, runner?: FakeRunner): FakeAgentSession {
  return {
    sessionId,
    sessionFile,
    extensionRunner: runner ?? fakeRunner(),
    dispose: vi.fn(),
    abort: vi.fn(),
    subscribe: vi.fn(),
    setModel: vi.fn(),
    getContextUsage: vi.fn(() => undefined),
  };
}

function installFakeCreateSession(service: PiService): FakeAgentSession[] {
  const created: FakeAgentSession[] = [];
  vi.spyOn(service, 'createSession').mockImplementation(async (options) => {
    sessionCounter += 1;
    const sessionId = `sid-${sessionCounter}`;
    const sessionFile =
      options.sessionPath ?? (options.inMemory ? undefined : `/tmp/pi-sessions/${sessionId}.jsonl`);
    const session = fakeAgentSession(sessionId, sessionFile);
    internals(service).clientSessionMap.set(options.clientId, sessionId);
    if (options.webUIContext) {
      internals(service).clientWebUIContexts.set(options.clientId, options.webUIContext);
    }
    internals(service).sessions.set(sessionId, session);
    created.push(session);
    return session as never;
  });
  return created;
}

function soleHandlerKey(service: PiService): string {
  const keys = [...internals(service).clientSessionMap.keys()];
  expect(keys).toHaveLength(1);
  return keys[0];
}

const services: PiService[] = [];
const managers: MultiSessionManager[] = [];

function newService(): PiService {
  const service = new PiService();
  services.push(service);
  return service;
}

function newManager(service: PiService, options: Record<string, unknown> = {}): MultiSessionManager {
  const manager = new MultiSessionManager(service, vi.fn(), {
    enableMemoryMonitoring: false,
    cleanupIntervalMs: 3_600_000,
    ...options,
  } as never);
  managers.push(manager);
  return manager;
}

function managerInternals(manager: MultiSessionManager): {
  sessions: Map<string, { status: string; lastActivity: Date; lastEventTimestamp: number; pinned: boolean }>;
} {
  return manager as unknown as {
    sessions: Map<string, { status: string; lastActivity: Date; lastEventTimestamp: number; pinned: boolean }>;
  };
}

/** The emitted session_shutdown payload of a fake session (exactly-once asserted). */
function soleEmission(session: FakeAgentSession): { type: string; reason: string; targetSessionFile?: string } {
  expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
  return session.extensionRunner.emit.mock.calls[0][0];
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const service of services.splice(0)) await service.cleanup();
  vi.restoreAllMocks();
});

describe('B5 — every dispose/unload path emits session_shutdown', () => {
  it('DELETE (disposeLoadedSession) emits exactly once, reason quit, before dispose', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    const status = await manager.createAndSubscribe('client-1', '/work');
    const session = created[0];
    soleHandlerKey(service);

    await expect(manager.disposeLoadedSession(status.sessionPath)).resolves.toBe(true);

    const emission = soleEmission(session);
    expect(emission.type).toBe('session_shutdown');
    expect(emission.reason).toBe('quit');
    expect(session.extensionRunner.hasHandlers).toHaveBeenCalledWith('session_shutdown');
    const [emitOrder] = session.extensionRunner.emit.mock.invocationCallOrder;
    const [disposeOrder] = session.dispose.mock.invocationCallOrder;
    expect(emitOrder).toBeLessThan(disposeOrder);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
  });

  it('idle unload (cleanupIdleSessions) emits exactly once, reason quit', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service, { idleSessionTimeoutMs: 1 });
    const status = await manager.createAndSubscribe('client-1', '/work');
    const session = created[0];

    const active = managerInternals(manager).sessions.get(status.sessionPath)!;
    active.lastActivity = new Date(Date.now() - 60_000);
    manager.unsubscribeClient('client-1', status.sessionPath);

    await expect(manager.cleanupIdleSessions()).resolves.toBeGreaterThanOrEqual(1);

    expect(soleEmission(session).reason).toBe('quit');
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
  });

  it('eviction to enforce maxSessions emits exactly once, reason quit', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service, { maxSessions: 1 });
    const first = await manager.createAndSubscribe('client-1', '/work');
    const firstSession = created[0];
    manager.unsubscribeClient('client-1', first.sessionPath);

    await manager.subscribeClient('client-2', '/work/second.jsonl');

    expect(soleEmission(firstSession).reason).toBe('quit');
    expect(firstSession.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(first.sessionPath)).toBe(false);
  });

  it('stopSession emits exactly once, reason quit, before dispose', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    const status = await manager.createAndSubscribe('client-1', '/work');
    const session = created[0];

    await expect(manager.stopSession(status.sessionPath)).resolves.toBe(true);

    expect(soleEmission(session).reason).toBe('quit');
    const [emitOrder] = session.extensionRunner.emit.mock.invocationCallOrder;
    const [disposeOrder] = session.dispose.mock.invocationCallOrder;
    expect(emitOrder).toBeLessThan(disposeOrder);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('manager.dispose() (server shutdown) emits exactly once per session', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    await manager.createAndSubscribe('client-1', '/work');
    await manager.createAndSubscribe('client-2', '/work');

    await manager.dispose();

    for (const session of created) {
      expect(soleEmission(session).reason).toBe('quit');
      expect(session.dispose).toHaveBeenCalledTimes(1);
    }
    expect(internals(service).sessions.size).toBe(0);
  });

  it('a failed create (no session file) emits exactly once, reason quit', async () => {
    const service = newService();
    const manager = newManager(service);
    const runner = fakeRunner();
    vi.spyOn(service, 'createSession').mockImplementation(async (options) => {
      const session = fakeAgentSession('sid-no-file', undefined, runner);
      internals(service).clientSessionMap.set(options.clientId, 'sid-no-file');
      internals(service).eventHandlers.set(options.clientId, () => {});
      internals(service).sessions.set('sid-no-file', session);
      return session as never;
    });

    await expect(manager.createAndSubscribe('client-1', '/work')).rejects.toThrow(/Failed to create session file/);

    expect(runner.emit).toHaveBeenCalledTimes(1);
    expect(runner.emit.mock.calls[0][0].reason).toBe('quit');
  });

  it('aggressive cleanup (memory pressure) emits exactly once, reason quit', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    const status = await manager.createAndSubscribe('client-1', '/work');
    const session = created[0];
    manager.unsubscribeClient('client-1', status.sessionPath);
    const active = managerInternals(manager).sessions.get(status.sessionPath)!;
    active.status = 'idle';

    await (manager as unknown as { aggressiveCleanup(): Promise<void> }).aggressiveCleanup();

    expect(soleEmission(session).reason).toBe('quit');
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
  });

  it('stale-stream reset (non-pinned, dispose for fresh rehydration) emits exactly once, reason quit', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service, { staleStreamingThresholdMs: 1_000 });
    const status = await manager.createAndSubscribe('client-1', '/work');
    const session = created[0];
    const active = managerInternals(manager).sessions.get(status.sessionPath)!;
    active.status = 'streaming';
    active.lastEventTimestamp = Date.now() - 60_000;

    await manager.cleanupIdleSessions();

    expect(soleEmission(session).reason).toBe('quit');
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
  });

  it('recoverSession (dispose→rehydrate same file) emits reason resume with targetSessionFile', async () => {
    // Recovery-style harness: mocked PiService whose session carries a runner.
    const session = fakeAgentSession('recovery-1', '/tmp/recovery/recovery-1.jsonl');
    let createSessionCalls = 0;
    const piService = {
      createSession: vi.fn(async () => {
        createSessionCalls += 1;
        return session;
      }),
      getSession: vi.fn(() => (createSessionCalls > 0 ? session : undefined)),
      setEventHandler: vi.fn(),
      removeEventHandler: vi.fn(),
      releaseSessionRefs: vi.fn(),
    };
    const manager = new MultiSessionManager(piService as never, () => {}, { idleSessionTimeoutMs: 600_000 });
    managers.push(manager);
    await manager.subscribeClient('first-client', session.sessionFile!);
    expect(createSessionCalls).toBe(1);

    await manager.recoverSession(session.sessionFile!);

    const emission = soleEmission(session);
    expect(emission.type).toBe('session_shutdown');
    expect(emission.reason).toBe('resume');
    expect(emission.targetSessionFile).toBe(session.sessionFile);
  });

  it('concurrent teardown of the same session emits exactly once', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    const status = await manager.createAndSubscribe('client-1', '/work');
    const session = created[0];

    const [a, b] = await Promise.all([
      manager.disposeLoadedSession(status.sessionPath),
      manager.disposeLoadedSession(status.sessionPath),
    ]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
  });

  it('a stop racing a concurrent dispose shares ONE emission (teardown funnel)', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    const status = await manager.createAndSubscribe('client-1', '/work');
    const session = created[0];

    const [stopped, disposed] = await Promise.all([
      manager.stopSession(status.sessionPath),
      manager.disposeLoadedSession(status.sessionPath),
    ]);

    expect(stopped).toBe(true);
    expect(disposed).toBe(true);
    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
  });

  it('a session without shutdown handlers is disposed without emission', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    const status = await manager.createAndSubscribe('client-1', '/work');
    const runner = fakeRunner({ hasHandlers: false });
    created[0].extensionRunner = runner;

    await expect(manager.disposeLoadedSession(status.sessionPath)).resolves.toBe(true);

    expect(runner.emit).not.toHaveBeenCalled();
    expect(created[0].dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
  });

  it('a hanging shutdown handler is bounded by the configured emission timeout and does not block disposal', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service, { sessionShutdownTimeoutMs: 30 });
    const status = await manager.createAndSubscribe('client-1', '/work');
    const runner = fakeRunner({ emit: vi.fn(() => new Promise<void>(() => {})) });
    created[0].extensionRunner = runner;
    const session = created[0];

    await manager.disposeLoadedSession(status.sessionPath);

    expect(runner.emit).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
  });

  it('a throwing shutdown handler does not block disposal', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    const status = await manager.createAndSubscribe('client-1', '/work');
    const runner = fakeRunner({ emit: vi.fn(async () => { throw new Error('handler exploded'); }) });
    created[0].extensionRunner = runner;
    const session = created[0];

    await expect(manager.disposeLoadedSession(status.sessionPath)).resolves.toBe(true);

    expect(runner.emit).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
  });
});

describe('B5 — PiService dispose paths emit session_shutdown', () => {
  it('removeClient emits exactly once, reason quit, when it disposes (last owner)', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    await service.createSession({ clientId: 'client-1' } as never);
    const session = created[0];

    await service.removeClient('client-1');

    expect(soleEmission(session).reason).toBe('quit');
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('removeClient with a sibling owner emits nothing and disposes nothing', async () => {
    const service = newService();
    const runner = fakeRunner();
    const shared = fakeAgentSession('sid-shared', '/tmp/pi-sessions/sid-shared.jsonl', runner);
    vi.spyOn(service, 'createSession').mockImplementation(async (options) => {
      internals(service).clientSessionMap.set(options.clientId, 'sid-shared');
      internals(service).sessions.set('sid-shared', shared);
      return shared as never;
    });
    await service.createSession({ clientId: 'client-1' } as never);
    await service.createSession({ clientId: 'client-2' } as never);

    await service.removeClient('client-1');

    expect(runner.emit).not.toHaveBeenCalled();
    expect(shared.dispose).not.toHaveBeenCalled();
  });

  it('a createSession extension-bind failure emits exactly once, reason quit', async () => {
    const service = newService();
    // Drive the REAL createSession far enough to reach its bindExtensions
    // catch: only the AgentSession bind and runner getter are mocked, so the
    // catch's emit+dispose cleanup is the production one.
    const runner = fakeRunner();
    const bindSpy = vi.spyOn(AgentSession.prototype as unknown as { bindExtensions: unknown }, 'bindExtensions')
      .mockRejectedValue(new Error('bind failed'));
    const runnerSpy = vi.spyOn(AgentSession.prototype, 'extensionRunner', 'get').mockReturnValue(runner as never);
    try {
      await expect(service.createSession({ clientId: 'client-1', cwd: '/tmp' } as never)).rejects.toThrow(/bind failed/);
    } finally {
      runnerSpy.mockRestore();
      bindSpy.mockRestore();
    }

    expect(runner.emit).toHaveBeenCalledTimes(1);
    expect(runner.emit.mock.calls[0][0].reason).toBe('quit');
  });

  it('cleanup() emits exactly once per remaining session', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    await service.createSession({ clientId: 'client-1' } as never);
    await service.createSession({ clientId: 'client-2' } as never);

    await service.cleanup();

    for (const session of created) {
      expect(soleEmission(session).reason).toBe('quit');
      expect(session.dispose).toHaveBeenCalledTimes(1);
    }
  });
});

describe('B5 — emitSessionShutdown helper', () => {
  function sessionWith(runner: FakeRunner): AgentSessionType {
    return fakeAgentSession('helper-1', undefined, runner) as unknown as AgentSessionType;
  }

  it('returns false and never emits when there are no handlers', async () => {
    const runner = fakeRunner({ hasHandlers: false });
    await expect(emitSessionShutdown(sessionWith(runner), { reason: 'quit' })).resolves.toBe(false);
    expect(runner.emit).not.toHaveBeenCalled();
  });

  it('returns true when handlers exist and the emission completes', async () => {
    const runner = fakeRunner();
    await expect(emitSessionShutdown(sessionWith(runner), { reason: 'quit' })).resolves.toBe(true);
    expect(runner.emit).toHaveBeenCalledWith({ type: 'session_shutdown', reason: 'quit' });
  });

  it('bounds a hanging emission by the timeout and still resolves true', async () => {
    const runner = fakeRunner({ emit: vi.fn(() => new Promise<void>(() => {})) });
    const started = Date.now();
    await expect(emitSessionShutdown(sessionWith(runner), { reason: 'quit' }, 25)).resolves.toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('survives a rejecting emission without propagating', async () => {
    const runner = fakeRunner({ emit: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(emitSessionShutdown(sessionWith(runner), { reason: 'reload' })).resolves.toBe(true);
  });

  it('tolerates a session without an extensionRunner (never throws)', async () => {
    const bare = { sessionId: 'bare', dispose: vi.fn() } as unknown as AgentSessionType;
    await expect(emitSessionShutdown(bare, { reason: 'quit' })).resolves.toBe(false);
  });
});
