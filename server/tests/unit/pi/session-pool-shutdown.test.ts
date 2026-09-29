import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiService } from '../../../src/pi/pi-service.js';
import { MultiSessionManager } from '../../../src/pi/multi-session-manager.js';
import { SessionPool } from '../../../src/pi/session-pool.js';

/**
 * B5 correction 01 (parent adjudication of reviews/b5-luna-review.md):
 *
 * 1. SessionPool dispose paths bypassed `session_shutdown` entirely. Every
 *    pool disposal now runs through the same bounded, exactly-once funnel
 *    with CLI-mapped reasons: extension-driven `newSession` replacement →
 *    `new`; `switchSession` replacement → `resume` + targetSessionFile;
 *    pool teardown (`removeClient`, cleanup drain) → `quit`. The
 *    no-double-emit property must hold when `PiService.cleanup()` drains
 *    the pool.
 *
 * 2. Shutdown race: a session stays mapped with its old status while the
 *    shutdown emission runs, so subscribes and prompts could attach to a
 *    closing session. The session is now fenced as closing synchronously;
 *    a subscribe waits for the teardown and rehydrates fresh (a browser
 *    tab reattaches instead of erroring — same dispose→rehydrate design as
 *    the manager's recovery), and a prompt is refused with the existing
 *    does-not-exist error (busy would advertise a retry that cannot
 *    succeed — the session is being removed). `performUnload` also clears
 *    stale viewing/subscription references.
 *
 * Fake sessions are the only fake (same harness as session-release-paths).
 */

interface FakeRunner {
  hasHandlers: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
}

interface FakeAgentSession {
  sessionId: string;
  sessionFile?: string;
  extensionRunner: FakeRunner;
  dispose: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
  prompt?: ReturnType<typeof vi.fn>;
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

function fakeRunner(emit?: FakeRunner['emit']): FakeRunner {
  return {
    hasHandlers: vi.fn(() => true),
    emit: emit ?? vi.fn(async () => undefined),
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
    const sessionFile = options.sessionPath ?? `/tmp/pi-sessions/${sessionId}.jsonl`;
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

const services: PiService[] = [];
const managers: MultiSessionManager[] = [];
const pools: SessionPool[] = [];

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

function newPool(service: PiService): SessionPool {
  const pool = new SessionPool(service);
  pools.push(pool);
  pool.setWebUIContextProvider((clientId) => ({ clientId, sendToClient: () => {} }));
  return pool;
}

function managerInternals(manager: MultiSessionManager): {
  sessions: Map<string, { status: string; lastActivity: Date; subscribers: Set<string> }>;
  closingSessions: Set<string>;
} {
  return manager as unknown as {
    sessions: Map<string, { status: string; lastActivity: Date; subscribers: Set<string> }>;
    closingSessions: Set<string>;
  };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const pool of pools.splice(0)) {
    for (const clientId of pool.getActiveClients()) await pool.removeClient(clientId);
  }
  for (const service of services.splice(0)) await service.cleanup();
  vi.restoreAllMocks();
});

describe('B5 correction 01 — SessionPool dispose paths emit session_shutdown', () => {
  it('createClientSession replacement emits exactly once, reason new, before dispose', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const pool = newPool(service);

    await pool.createClientSession('client-1', { cwd: '/work' });
    const first = created[0];
    await pool.createClientSession('client-1', { cwd: '/work' });

    expect(first.extensionRunner.emit).toHaveBeenCalledTimes(1);
    const emission = first.extensionRunner.emit.mock.calls[0][0];
    expect(emission.type).toBe('session_shutdown');
    expect(emission.reason).toBe('new');
    const [emitOrder] = first.extensionRunner.emit.mock.invocationCallOrder;
    const [disposeOrder] = first.dispose.mock.invocationCallOrder;
    expect(emitOrder).toBeLessThan(disposeOrder);
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it('switchClientSession replacement emits exactly once, reason resume with targetSessionFile', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const pool = newPool(service);

    await pool.createClientSession('client-1', { cwd: '/work' });
    const first = created[0];
    await pool.switchClientSession('client-1', '/work/other.jsonl');

    expect(first.extensionRunner.emit).toHaveBeenCalledTimes(1);
    const emission = first.extensionRunner.emit.mock.calls[0][0];
    expect(emission.reason).toBe('resume');
    expect(emission.targetSessionFile).toBe('/work/other.jsonl');
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it('removeClient (pool teardown) emits exactly once, reason quit', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const pool = newPool(service);

    const client = await pool.createClientSession('client-1', { cwd: '/work' });
    const session = created[0];
    await pool.removeClient('client-1');

    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit.mock.calls[0][0].reason).toBe('quit');
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(service.getSession(client.sessionId)).toBeUndefined();
  });

  it('removeClient with a sibling pool client sharing the session emits nothing', async () => {
    const service = newService();
    const runner = fakeRunner();
    const shared = fakeAgentSession('sid-shared', '/tmp/pi-sessions/sid-shared.jsonl', runner);
    vi.spyOn(service, 'createSession').mockImplementation(async (options) => {
      internals(service).clientSessionMap.set(options.clientId, 'sid-shared');
      internals(service).sessions.set('sid-shared', shared);
      return shared as never;
    });
    const pool = newPool(service);
    await pool.createClientSession('client-a', { cwd: '/work' });
    await pool.createClientSession('client-b', { cwd: '/work' });

    await pool.removeClient('client-a');

    expect(runner.emit).not.toHaveBeenCalled();
    expect(shared.dispose).not.toHaveBeenCalled();
  });

  it('concurrent removeClient calls for the same client emit exactly once', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const pool = newPool(service);
    await pool.createClientSession('client-1', { cwd: '/work' });
    const session = created[0];

    await Promise.all([pool.removeClient('client-1'), pool.removeClient('client-1')]);

    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('PiService.cleanup() draining the pool emits exactly once per pool session (no double via the remaining-sessions pass)', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const pool = newPool(service);
    await pool.createClientSession('client-1', { cwd: '/work' });
    await pool.createClientSession('client-2', { cwd: '/work' });
    // Also create one NON-pool session so cleanup's remaining pass has work.
    await service.createSession({ clientId: 'direct-client' } as never);
    const poolIds = new Set([created[0].sessionId, created[1].sessionId]);
    const direct = created[2];

    await service.cleanup();

    for (const session of created) {
      expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
      const expectedReason = poolIds.has(session.sessionId) ? 'quit' : 'quit';
      expect(session.extensionRunner.emit.mock.calls[0][0].reason).toBe(expectedReason);
      expect(session.dispose).toHaveBeenCalledTimes(1);
    }
    expect(internals(service).sessions.size).toBe(0);
    void direct;
  });
});

describe('B5 correction 01 — closing-session fence (manager)', () => {
  it('a subscribe arriving during a deferred teardown waits, then rehydrates fresh', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service, { sessionShutdownTimeoutMs: 150 });
    const status = await manager.createAndSubscribe('client-1', '/work');
    const first = created[0];
    const runner = fakeRunner(vi.fn(() => new Promise<void>(() => {}))); // hangs
    first.extensionRunner = runner;

    const teardown = manager.disposeLoadedSession(status.sessionPath);
    // Mid-teardown (emission hanging): a browser client attaches.
    const late = await manager.subscribeClient('late-client', status.sessionPath);
    await teardown;

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(late.status).toBe('idle');
    // The late subscriber is attached to a FRESH session (second create), not the disposed one.
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(manager.getSubscribers(status.sessionPath)).toContain('late-client');
    expect(manager.getSessionStatus(status.sessionPath)?.subscriberCount).toBeGreaterThanOrEqual(1);
  });

  it('a prompt arriving during a deferred teardown is refused with the existing does-not-exist error', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service, { sessionShutdownTimeoutMs: 150 });
    const status = await manager.createAndSubscribe('client-1', '/work');
    created[0].extensionRunner = fakeRunner(vi.fn(() => new Promise<void>(() => {})));

    const teardown = manager.disposeLoadedSession(status.sessionPath);
    await expect(manager.prompt(status.sessionPath, 'hello?')).rejects.toThrow(/does not exist/);
    await expect(manager.submitPrompt(status.sessionPath, 'hello?')).rejects.toThrow(/does not exist/);
    await teardown;
  });

  it('performUnload clears stale viewing references so none point at a removed session', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service, { idleSessionTimeoutMs: 1 });
    const status = await manager.createAndSubscribe('client-1', '/work');
    // A viewing reference whose subscription is then dropped — the stale
    // reference an unload must not leave behind (viewing requires an active
    // subscription when set).
    manager.setClientViewingSession('client-1', status.sessionPath);
    manager.unsubscribeClient('client-1', status.sessionPath);
    const active = managerInternals(manager).sessions.get(status.sessionPath)!;
    active.lastActivity = new Date(Date.now() - 60_000);

    await manager.cleanupIdleSessions();

    expect(manager.hasSession(status.sessionPath)).toBe(false);
    expect(manager.getViewingClients(status.sessionPath)).toEqual([]);
    expect(created[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('the closing fence is set synchronously before the first await and cleared after teardown', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service, { sessionShutdownTimeoutMs: 120 });
    const status = await manager.createAndSubscribe('client-1', '/work');
    created[0].extensionRunner = fakeRunner(vi.fn(() => new Promise<void>(() => {})));

    const teardown = manager.disposeLoadedSession(status.sessionPath);
    // Synchronous check right after initiating the teardown — no awaits yet.
    expect(managerInternals(manager).closingSessions.has(status.sessionPath)).toBe(true);
    await teardown;
    expect(managerInternals(manager).closingSessions.has(status.sessionPath)).toBe(false);
  });
});
