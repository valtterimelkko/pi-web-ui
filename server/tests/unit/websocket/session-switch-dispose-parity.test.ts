/**
 * H1 correction 04, D1 — the dispose re-registration must key off the explicit
 * view-only record, and the REAL connection path must drive it. These tests
 * wire a REAL MultiSessionManager (stub PiService, recording broadcast) into a
 * real WebSocketConnectionManager and drive handleSwitchSession itself:
 *
 * 1. flag OFF: an ordinary materialising browser switch, then dispose, then an
 *    API materialisation → the browser client is NOT attached and receives no
 *    events (master behaviour, parity by construction).
 * 2. flag ON: viewOnlySwitchSession (non-resident) → API materialises → viewer
 *    receives events → dispose → API materialises again → the viewer receives
 *    the NEW lifecycle's events, exactly once each.
 * 3. flag ON: the viewer switches away before the dispose → not re-registered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const { claudeMock, opencodeMock, antigravityMock, piServiceNoop, registryMock, piCacheMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, { get: () => noopRecursive, apply: () => undefined });
  return {
    claudeMock: {
      isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn().mockReturnValue(false),
      sendPrompt: vi.fn(), steer: vi.fn(), followUp: vi.fn(), abort: vi.fn(),
      hasSession: vi.fn().mockReturnValue(false), getSessionState: vi.fn(), setThinkingLevel: vi.fn(),
      createSession: vi.fn(), listSessions: vi.fn().mockResolvedValue([]),
      validateAuth: vi.fn().mockResolvedValue({ ok: true }), stop: vi.fn().mockResolvedValue(undefined),
    },
    opencodeMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), isPendingPermission: vi.fn().mockReturnValue(false), resolvePermission: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    antigravityMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    piServiceNoop: noopRecursive,
    registryMock: { upsert: vi.fn(), updateStatus: vi.fn(), get: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]), listAll: vi.fn().mockResolvedValue([]), getByPath: vi.fn().mockResolvedValue(undefined) },
    piCacheMock: { list: vi.fn().mockResolvedValue([]) },
  };
});

vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({
  getPiService: () => piServiceNoop,
  assertPiSessionFileIdentity: async (sessionPath: string) => {
    const m = sessionPath.split('/').pop()?.match(/_([0-9a-f-]+)\.jsonl$/);
    if (!m) throw new Error('SESSION_IDENTITY_MISMATCH');
    return m[1];
  },
  PiSessionIdentityError: class PiSessionIdentityError extends Error {},
}));
vi.mock('../../../src/pi/session-list-cache.js', () => ({ getPiSessionListCache: () => piCacheMock }));
vi.mock('../../../src/session-registry.js', () => ({
  getSessionRegistry: () => registryMock,
  resolveCanonicalSessionId: vi.fn().mockResolvedValue('canonical'),
}));
vi.mock('../../../src/internal-api/background-children.js', () => ({
  readBackgroundTasksSnapshot: vi.fn().mockResolvedValue([]),
}));
// The manager's SDK imports must be stubbed too (it constructs nothing from
// them in these flows, but the module graph loads them).
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn(),
  SessionManager: { create: vi.fn().mockReturnValue({}), open: vi.fn().mockReturnValue({}), inMemory: vi.fn().mockReturnValue({}) },
  AuthStorage: { create: vi.fn().mockReturnValue({ getAll: vi.fn().mockReturnValue([]) }) },
  ModelRegistry: vi.fn().mockImplementation(() => ({ getAvailable: vi.fn().mockReturnValue([]), getAll: vi.fn().mockReturnValue([]), find: vi.fn().mockReturnValue(null), getError: vi.fn().mockReturnValue(null) })),
  DefaultResourceLoader: vi.fn().mockImplementation(() => ({ reload: vi.fn().mockResolvedValue(undefined), getExtensions: vi.fn().mockReturnValue({ extensions: [], errors: [] }) })),
}));

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';
import { MultiSessionManager } from '../../../src/pi/multi-session-manager.js';

const commandCodeStub: any = {
  isEnabled: () => false, isAvailable: () => false, hasSession: vi.fn().mockResolvedValue(false),
  getModels: vi.fn().mockReturnValue([]), init: vi.fn().mockResolvedValue(undefined), listSessions: vi.fn().mockResolvedValue([]),
};

function makeSessionFile(): { path: string; id: string } {
  const dir = mkdtempSync(join(tmpdir(), 'h1-c4-'));
  const id = randomUUID();
  const path = join(dir, `2026-10-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: 'session', id, version: 3, timestamp: 1, cwd: dir }),
    JSON.stringify({ id: 'a1', parentId: null, type: 'message', timestamp: 1, message: { role: 'user', content: [{ type: 'text', text: 'seed text' }], timestamp: 1 } }),
  ].join('\n') + '\n');
  return { path, id };
}

/** A real manager + stub PiService; broadcast deliveries are recorded per client. */
function makeRealManager() {
  const deliveries: Array<{ client: string; marker: string }> = [];
  const agentSessions: any[] = [];
  const piService: any = {
    createSession: vi.fn().mockImplementation(async () => {
      const agent: any = {
        sessionId: `agent-${agentSessions.length + 1}`, sessionFile: 'x', subscribe: vi.fn(), dispose: vi.fn(),
        setModel: vi.fn(), getContextUsage: vi.fn(() => undefined),
      };
      agentSessions.push(agent);
      return agent;
    }),
    getSession: vi.fn(), setEventHandler: vi.fn(), removeEventHandler: vi.fn(), releaseSessionRefs: vi.fn(),
  };
  const manager = new MultiSessionManager(piService, (client: string, message: any) => {
    const marker = message?.event?.marker ?? message?.marker ?? null;
    if (marker) deliveries.push({ client, marker });
  });
  const fireEvent = (marker: string) => {
    const handler = piService.setEventHandler.mock.calls.at(-1)?.[1] as ((e: unknown) => void) | undefined;
    expect(handler).toBeTypeOf('function');
    handler({ type: 'message', marker, message: { role: 'assistant' } });
  };
  return { manager, piService, deliveries, fireEvent };
}

function makeConnection(realManager: MultiSessionManager) {
  const mgr = new WebSocketConnectionManager(commandCodeStub);
  const sent: any[] = [];
  (mgr as any).sendMessage = (_c: string, m: unknown) => { sent.push(m); };
  (mgr as any).multiSessionManager = realManager;
  return { mgr, sent };
}

describe('correction 04 D1 — dispose re-registration via the REAL connection path', () => {
  it('flag OFF: an ordinary materialising switch, dispose, then an API materialisation does NOT attach the browser client (master parity)', async () => {
    const { manager, deliveries, fireEvent } = makeRealManager();
    const { mgr } = makeConnection(manager);
    (mgr as any).viewOnlySubscribeEnabled = false;
    const { path } = makeSessionFile();

    await (mgr as any).handleSwitchSession('browser-1', { type: 'switch_session', sessionPath: path });
    expect(manager.getSubscribers(path)).toContain('browser-1'); // materialising subscribe + viewing map (as the connection does)

    await manager.disposeLoadedSession(path);
    await manager.subscribeClient('api-worker', path); // a later materialisation
    fireEvent('m1');
    expect(manager.getSubscribers(path)).not.toContain('browser-1'); // master: not re-attached
    expect(deliveries.filter((d) => d.client === 'browser-1')).toEqual([]); // master: no events
  });

  it('flag ON: view-only open → materialise → events → dispose → materialise again → the viewer receives the NEW lifecycle events exactly once', async () => {
    const { manager, deliveries, fireEvent } = makeRealManager();
    const { mgr } = makeConnection(manager);
    (mgr as any).viewOnlySubscribeEnabled = true;
    const { path } = makeSessionFile();

    await (mgr as any).handleSwitchSession('viewer-1', { type: 'switch_session', sessionPath: path });
    expect(manager.getSessionStatus(path)).toBeUndefined(); // genuinely view-only (no agent)

    await manager.subscribeClient('api-worker', path); // materialisation attaches the pending viewer
    expect(manager.getSubscribers(path)).toContain('viewer-1');
    fireEvent('m1');
    expect(deliveries.filter((d) => d.client === 'viewer-1' && d.marker === 'm1').length).toBe(1);

    await manager.disposeLoadedSession(path);
    await manager.subscribeClient('api-worker', path); // a NEW lifecycle
    fireEvent('m2');
    expect(manager.getSubscribers(path)).toContain('viewer-1'); // re-registered as pending, re-attached
    const m2Count = deliveries.filter((d) => d.client === 'viewer-1' && d.marker === 'm2').length;
    expect(m2Count).toBe(1); // exactly once
    expect(deliveries.filter((d) => d.client === 'viewer-1').length).toBe(2); // m1 + m2, nothing extra
  });

  it('flag ON: the viewer switches away before the dispose → not re-registered', async () => {
    const { manager, deliveries, fireEvent } = makeRealManager();
    const { mgr } = makeConnection(manager);
    (mgr as any).viewOnlySubscribeEnabled = true;
    const { path: pathA } = makeSessionFile();
    const { path: pathB } = makeSessionFile();

    await (mgr as any).handleSwitchSession('viewer-1', { type: 'switch_session', sessionPath: pathA });
    await manager.subscribeClient('api-worker', pathA); // materialise + attach
    // switch away (the connection's switch path unsubscribes from the old path)
    await (mgr as any).handleSwitchSession('viewer-1', { type: 'switch_session', sessionPath: pathB });
    await manager.disposeLoadedSession(pathA);
    await manager.subscribeClient('api-worker', pathA); // new lifecycle
    fireEvent('m3');
    expect(manager.getSubscribers(pathA)).not.toContain('viewer-1');
    expect(deliveries.filter((d) => d.client === 'viewer-1' && d.marker === 'm3')).toEqual([]);
  });
});
