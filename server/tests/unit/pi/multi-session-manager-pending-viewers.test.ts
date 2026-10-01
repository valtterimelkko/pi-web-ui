/**
 * H1 correction 02, M1: a view-only viewer must receive live events.
 *
 * A view-only open registers a PENDING VIEWER in the real MultiSessionManager.
 * When the agent is (or becomes) resident — through this manager, the Internal
 * API, a goal continuation, a worker or another tab — the pending viewer is
 * attached as a real subscriber and receives every broadcast event. Leaving
 * the session, switching away or disconnecting removes the registration.
 *
 * These tests drive the REAL manager with a stub PiService (the earlier
 * connection-level mock hid the viewing-guard defect this correction fixes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn(),
  SessionManager: {
    create: vi.fn().mockReturnValue({}),
    open: vi.fn().mockReturnValue({}),
    inMemory: vi.fn().mockReturnValue({}),
  },
  AuthStorage: { create: vi.fn().mockReturnValue({ getAll: vi.fn().mockReturnValue([]) }) },
  ModelRegistry: vi.fn().mockImplementation(() => ({
    getAvailable: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    find: vi.fn().mockReturnValue(null),
    getError: vi.fn().mockReturnValue(null),
  })),
  DefaultResourceLoader: vi.fn().mockImplementation(() => ({
    reload: vi.fn().mockResolvedValue(undefined),
    getExtensions: vi.fn().mockReturnValue({ extensions: [], errors: [] }),
  })),
}));

import { MultiSessionManager } from '../../../src/pi/multi-session-manager.js';

const PATH = '/tmp/sessions/2026-10-01T00-00-00-000Z_pending-viewer-test.jsonl';

function makeAgentSession(id = 'agent-1') {
  return { sessionId: id, sessionFile: PATH, subscribe: vi.fn(), dispose: vi.fn(), setModel: vi.fn(), getContextUsage: vi.fn(() => undefined) };
}

function makeManager(broadcast: ReturnType<typeof vi.fn>) {
  const piService: any = {
    createSession: vi.fn().mockResolvedValue(makeAgentSession()),
    getSession: vi.fn(),
    setEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    releaseSessionRefs: vi.fn(),
  };
  const manager = new MultiSessionManager(piService, broadcast);
  return { manager, piService };
}

/** Fire one agent event into the manager the way the real PiService would. */
function fireAgentEvent(manager: MultiSessionManager, piService: any, event: unknown): void {
  const handler = piService.setEventHandler.mock.calls.at(-1)?.[1] as ((e: unknown) => void) | undefined;
  expect(handler).toBeTypeOf('function');
  handler(event);
}

/** True when the path has no materialised agent (pending-only). */
function this_hasNoAgent(manager: MultiSessionManager, path: string): boolean {
  return (manager as unknown as { getSessionStatus(p: string): unknown }).getSessionStatus(path) === undefined;
}

describe('MultiSessionManager pending viewers (H1 correction M1)', () => {
  let broadcast: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    broadcast = vi.fn();
  });

  it('(a) agent already resident: the pending viewer is attached immediately and receives events', async () => {
    const { manager, piService } = makeManager(broadcast);
    await manager.subscribeClient('owner', PATH); // materialises the agent
    manager.registerPendingViewer('viewer', PATH);
    expect(manager.getSubscribers(PATH)).toContain('viewer');
    fireAgentEvent(manager, piService, { type: 'message', message: { role: 'assistant' } });
    const recipients = broadcast.mock.calls.map((c) => c[0]);
    expect(recipients).toContain('owner');
    expect(recipients).toContain('viewer');
  });

  it('(b) another path materialises the agent AFTER the view-only open: the viewer is attached and receives events without any action of its own', async () => {
    const { manager, piService } = makeManager(broadcast);
    manager.registerPendingViewer('viewer', PATH);
    // Before materialisation there is no agent, so nothing can be broadcast —
    // the pending registration is bookkeeping only (getSubscribers derives
    // from the subscription map; the broadcast set is the active session's).
    expect(this_hasNoAgent(manager, PATH)).toBe(true);
    // Another path (Internal API / another tab) materialises the session:
    await manager.subscribeClient('api-client', PATH);
    expect(piService.createSession).toHaveBeenCalledTimes(1);
    const subscribers = manager.getSubscribers(PATH);
    expect(subscribers).toContain('api-client');
    expect(subscribers).toContain('viewer'); // attached by materialisation
    expect(manager.getClientSubscriptions('viewer')).toContain(PATH);
    fireAgentEvent(manager, piService, { type: 'message', message: { role: 'assistant' } });
    const recipients = broadcast.mock.calls.map((c) => c[0]);
    expect(recipients).toContain('viewer');
  });

  it('(b, own materialisation) the viewer materialising the session itself also attaches exactly once', async () => {
    const { manager } = makeManager(broadcast);
    manager.registerPendingViewer('viewer', PATH);
    await manager.subscribeClient('viewer', PATH);
    const subscribers = manager.getSubscribers(PATH);
    expect(subscribers.filter((s) => s === 'viewer').length).toBe(1);
  });

  it('(c) switching away / leaving removes the pending registration: a later materialisation does not attach the stale viewer', async () => {
    const { manager } = makeManager(broadcast);
    manager.registerPendingViewer('viewer', PATH);
    expect(manager.getClientSubscriptions('viewer')).toContain(PATH); // disconnect loop sees it
    manager.unsubscribeClient('viewer', PATH);
    expect(manager.getClientSubscriptions('viewer')).not.toContain(PATH);
    await manager.subscribeClient('api-client', PATH);
    expect(manager.getSubscribers(PATH)).not.toContain('viewer');
  });

  it('(c, disconnect coverage) pending registrations are listed so the connection disconnect loop cleans them', async () => {
    const { manager } = makeManager(broadcast);
    manager.registerPendingViewer('viewer', '/tmp/a.jsonl');
    manager.registerPendingViewer('viewer', '/tmp/b.jsonl');
    const subs = manager.getClientSubscriptions('viewer');
    expect(subs).toContain('/tmp/a.jsonl');
    expect(subs).toContain('/tmp/b.jsonl');
    for (const p of [...subs]) manager.unsubscribeClient('viewer', p);
    expect(manager.getClientSubscriptions('viewer')).toEqual([]);
  });

  it('a pending registration consumed by attach does not resurrect after a deliberate dispose (no stale events, no leak)', async () => {
    const { manager } = makeManager(broadcast);
    manager.registerPendingViewer('viewer', PATH);
    await manager.subscribeClient('api-client', PATH); // materialise + attach
    expect(manager.getSubscribers(PATH)).toContain('viewer');
    await manager.disposeLoadedSession(PATH); // dispose clears subscribers + subscriptions
    await manager.subscribeClient('api-client', PATH); // later re-materialisation
    expect(manager.getSubscribers(PATH)).not.toContain('viewer'); // same guarantee as a regular subscriber
  });
});
