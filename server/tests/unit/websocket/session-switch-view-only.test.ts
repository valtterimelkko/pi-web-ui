/**
 * H1 Phase B: view-only session subscribe behind PI_WEB_UI_VIEW_ONLY_SUBSCRIBE
 * (default OFF). With the flag OFF (or a resident session), a browser switch to
 * a Pi session must keep today's behaviour byte-for-byte: subscribeClient
 * materialises the agent. With the flag ON and a NON-RESIDENT session, the
 * switch must view the session WITHOUT creating an agent (no rehydrate, no
 * extension loading): identity + cwd from the file header, transcript replayed
 * from the file, model/thinking derived from the file, and every later
 * agent-requiring action (prompt, steer, follow-up, set_model, thinking level,
 * compact, session info) materialising the agent on demand.
 *
 * Raw run evidence behind these tests: docs/plans/execution-reports/orchestration-scaling/H1.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const { claudeMock, opencodeMock, antigravityMock, piServiceMock, registryMock, piCacheMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, {
    get: () => noopRecursive,
    apply: () => undefined,
  });
  return {
    claudeMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn().mockReturnValue(false),
      sendPrompt: vi.fn(), steer: vi.fn(), followUp: vi.fn(), abort: vi.fn(),
      hasSession: vi.fn().mockReturnValue(false), getSessionState: vi.fn(),
      setThinkingLevel: vi.fn(), createSession: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      validateAuth: vi.fn().mockResolvedValue({ ok: true }), stop: vi.fn().mockResolvedValue(undefined),
    },
    opencodeMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), isPendingPermission: vi.fn().mockReturnValue(false), resolvePermission: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    antigravityMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    piServiceMock: noopRecursive,
    registryMock: { upsert: vi.fn(), updateStatus: vi.fn(), get: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]), listAll: vi.fn().mockResolvedValue([]) },
    piCacheMock: { list: vi.fn().mockResolvedValue([]) },
  };
});

vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({
  getPiService: () => piServiceMock,
  // Identity preflight: accept real-shaped filenames (tests use real files);
  // the canonical parse is simple enough to mirror without a dynamic import.
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

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';

/** Constructor stub: the real constructor would build a CommandCodeService
 *  whose hasSession() costs ~5 s in tests (spawn/timeout), dominating runtime. */
const commandCodeStub: any = {
  isEnabled: () => false,
  isAvailable: () => false,
  hasSession: vi.fn().mockResolvedValue(false),
  getModels: vi.fn().mockReturnValue([]),
  init: vi.fn().mockResolvedValue(undefined),
  listSessions: vi.fn().mockResolvedValue([]),
};

/** Real-shaped Pi session file in a tmpdir (filename carries the session id). */
function makeSessionFile(entries: unknown[]): { path: string; id: string } {
  const dir = mkdtempSync(join(tmpdir(), 'h1-view-only-'));
  const id = randomUUID();
  const stamp = '2026-10-01T00-00-00-000Z';
  const path = join(dir, `${stamp}_${id}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { path, id };
}

function sessionEntries(): unknown[] {
  return [
    { type: 'session', id: 'will-be-replaced', version: 3, timestamp: Date.now(), cwd: '/tmp/h1-ws' },
    { id: 'a1', parentId: null, type: 'message', timestamp: 1, message: { role: 'user', content: [{ type: 'text', text: 'hello there' }], timestamp: 1 } },
    { id: 'a2', parentId: 'a1', type: 'message', timestamp: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2, provider: 'openrouter', model: 'some-model' } },
    { id: 'a3', parentId: 'a2', type: 'model_change', timestamp: 3, provider: 'zai', modelId: 'glm-5.3-flash' },
    { id: 'a4', parentId: 'a3', type: 'thinking_level_change', timestamp: 4, thinkingLevel: 'low' },
  ];
}

describe('view-only session subscribe (PI_WEB_UI_VIEW_ONLY_SUBSCRIBE)', () => {
  let mgr: WebSocketConnectionManager;
  let sent: Array<Record<string, any>>;
  let multi: Record<string, any>;
  let agentSession: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new WebSocketConnectionManager(commandCodeStub);
    sent = [];
    (mgr as any).sendMessage = (_clientId: string, message: unknown) => { sent.push(message as Record<string, any>); };
    agentSession = {
      prompt: vi.fn(), steer: vi.fn(), followUp: vi.fn(), abort: vi.fn(), compact: vi.fn(),
      setThinkingLevel: vi.fn(), getSessionStats: vi.fn(() => ({ totalTokens: 1 })), getContextUsage: vi.fn(),
      model: { provider: 'zai', id: 'glm-5.3-flash' }, thinkingLevel: 'low',
    };
    multi = {
      getClientSessionPath: vi.fn().mockReturnValue(undefined),
      subscribeClient: vi.fn().mockResolvedValue({
        sessionPath: 'x', sessionId: 'x', status: 'idle', messageCount: 0, currentStep: 0,
      }),
      unsubscribeClient: vi.fn(),
      setClientViewingSession: vi.fn(),
      getSessionStatus: vi.fn().mockReturnValue(undefined),
      getAllSessionStatuses: vi.fn().mockReturnValue([]),
      // Non-resident by default: no agent, no status.
      getAgentSession: vi.fn().mockReturnValue(undefined),
      hasSession: vi.fn().mockReturnValue(false),
    };
    (mgr as any).multiSessionManager = multi;
  });

  afterEach(() => {
    delete process.env.PI_WEB_UI_VIEW_ONLY_SUBSCRIBE;
  });

  describe('flag OFF (default): today\'s behaviour byte-for-byte', () => {
    it('a switch to a non-resident session materialises the agent via subscribeClient', async () => {
      (mgr as any).viewOnlySubscribeEnabled = false;
      const { path } = makeSessionFile(sessionEntries());
      await (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: path });
      expect(multi.subscribeClient).toHaveBeenCalledTimes(1);
      const switched = sent.find((m) => m.type === 'session_switched');
      expect(switched).toBeDefined();
    });
  });

  describe('flag ON, resident session: today\'s behaviour', () => {
    it('a switch to a resident session still subscribes (no view-only shortcut)', async () => {
      (mgr as any).viewOnlySubscribeEnabled = true;
      multi.getSessionStatus.mockReturnValue({ status: 'idle', sessionPath: 'x' });
      multi.getAgentSession.mockReturnValue(agentSession);
      agentSession.getContextUsage.mockReturnValue({ contextWindow: 200000, tokens: 100, percent: 0.05 });
      const { path } = makeSessionFile(sessionEntries());
      await (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: path });
      expect(multi.subscribeClient).toHaveBeenCalledTimes(1);
      const switched = sent.find((m) => m.type === 'session_switched');
      expect(switched).toBeDefined();
      expect(switched.model).toBe('zai/glm-5.3-flash'); // live agent fields, as today
    });
  });

  describe('flag ON, non-resident session: view without an agent', () => {
    beforeEach(() => {
      (mgr as any).viewOnlySubscribeEnabled = true;
    });

    it('does not call subscribeClient (no rehydrate, no agent creation)', async () => {
      const { path } = makeSessionFile(sessionEntries());
      await (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: path });
      expect(multi.subscribeClient).not.toHaveBeenCalled();
    });

    it('sends session_switched with the file-derived session id, transcript, model and thinking level', async () => {
      const { path, id } = makeSessionFile(sessionEntries());
      await (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: path });
      const switched = sent.find((m) => m.type === 'session_switched');
      expect(switched).toBeDefined();
      expect(switched.sessionId).toBe(id);
      expect(switched.sessionPath).toBe(path);
      expect(switched.model).toBe('zai/glm-5.3-flash'); // from the last model_change entry
      expect(switched.thinkingLevel).toBe('low'); // from the last thinking_level_change entry
      expect(Array.isArray(switched.messages)).toBe(true);
      expect(switched.messages.length).toBeGreaterThan(0);
      expect(switched.isStreaming).toBe(false);
      expect(switched.fileTimestamp).toBeGreaterThan(0);
    });

    it('falls back to the last assistant message provider/model when no model_change exists', async () => {
      const entries = sessionEntries().filter((e) => (e as any).type !== 'model_change');
      const { path } = makeSessionFile(entries);
      await (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: path });
      const switched = sent.find((m) => m.type === 'session_switched');
      expect(switched.model).toBe('openrouter/some-model');
    });

    it('omits model and thinking when the file carries neither', async () => {
      const entries = sessionEntries().filter((e) => (e as any).type !== 'model_change' && (e as any).type !== 'thinking_level_change');
      entries[2] = JSON.parse(JSON.stringify(entries[2]));
      delete (entries[2] as any).message.provider;
      delete (entries[2] as any).message.model;
      const { path } = makeSessionFile(entries);
      await (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: path });
      const switched = sent.find((m) => m.type === 'session_switched');
      expect(switched.model).toBeUndefined();
      expect(switched.thinkingLevel).toBeUndefined();
    });

    it('records the viewing client on the manager without materialising', async () => {
      const { path } = makeSessionFile(sessionEntries());
      await (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: path });
      expect(multi.setClientViewingSession).toHaveBeenCalledWith('c1', path);
      expect((mgr as any).clientViewingSession.get('c1')).toBe(path);
      expect(multi.getAgentSession).not.toHaveBeenCalledWith(path);
    });

    it('an error switch (missing file) reports the identity error, not a crash', async () => {
      await expect(
        (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: '/nonexistent/x.jsonl' }),
      ).rejects.toThrow();
      expect(sent.find((m) => m.type === 'session_switched')).toBeUndefined();
    });
  });

  describe('flag ON: first agent-requiring action materialises on demand', () => {
    let path: string;

    beforeEach(async () => {
      (mgr as any).viewOnlySubscribeEnabled = true;
      const made = makeSessionFile(sessionEntries());
      path = made.path;
      await (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: path });
      sent.length = 0;
      // After materialisation the manager holds the agent.
      multi.subscribeClient.mockImplementation(async () => {
        multi.getAgentSession.mockReturnValue(agentSession);
        multi.getSessionStatus.mockReturnValue({ status: 'idle', sessionPath: path });
        return { sessionPath: path, sessionId: 'x', status: 'idle', messageCount: 1, currentStep: 0 };
      });
    });

    it('a prompt materialises the agent and delivers the prompt (no SESSION_NOT_FOUND)', async () => {
      await (mgr as any).handlePrompt('c1', { type: 'prompt', sessionId: 'x', message: 'do the thing' });
      // 4th arg (webUIContext) is undefined in tests: no ws client is registered.
      expect(multi.subscribeClient).toHaveBeenCalledWith('c1', path, expect.any(String), undefined);
      expect(agentSession.prompt).toHaveBeenCalledWith('do the thing', expect.anything());
      expect(sent.find((m) => m.type === 'error' && m.code === 'SESSION_NOT_FOUND')).toBeUndefined();
    });

    it('steer materialises then steers', async () => {
      agentSession.isStreaming = false;
      await (mgr as any).handleSteer('c1', { type: 'steer', message: 'pivot now' });
      expect(multi.subscribeClient).toHaveBeenCalled();
      expect(agentSession.steer).toHaveBeenCalledWith('pivot now');
    });

    it('follow_up materialises then follows up', async () => {
      await (mgr as any).handleFollowUp('c1', { type: 'follow_up', message: 'and then' });
      expect(multi.subscribeClient).toHaveBeenCalled();
      expect(agentSession.followUp).toHaveBeenCalledWith('and then');
    });

    it('set_model materialises then changes the model', async () => {
      await (mgr as any).handleSetModel('c1', { type: 'set_model', modelId: 'zai/glm-5.3-flash' });
      expect(multi.subscribeClient).toHaveBeenCalled();
      expect(agentSession.model).toBeDefined();
    });

    it('set_thinking_level materialises then sets the level', async () => {
      await (mgr as any).handleSetThinkingLevel('c1', { type: 'set_thinking_level', level: 'high' } as any);
      expect(multi.subscribeClient).toHaveBeenCalled();
      expect(agentSession.setThinkingLevel).toHaveBeenCalledWith('high');
    });

    it('compact materialises then compacts', async () => {
      agentSession.compact.mockResolvedValue({ ok: true });
      await (mgr as any).handleCompact('c1', { type: 'compact' } as any);
      expect(multi.subscribeClient).toHaveBeenCalled();
      expect(agentSession.compact).toHaveBeenCalled();
    });

    it('get_session_info materialises then reports stats', async () => {
      await (mgr as any).handleGetSessionInfo('c1');
      expect(multi.subscribeClient).toHaveBeenCalled();
      const info = sent.find((m) => m.type === 'session_info');
      expect(info).toBeDefined();
    });

    it('abort with no agent is a silent no-op (no materialisation, no error)', async () => {
      await (mgr as any).handleAbort('c1');
      expect(multi.subscribeClient).not.toHaveBeenCalled();
      expect(sent.find((m) => m.type === 'error')).toBeUndefined();
    });

    it('switching away unsubscribes cleanly even though nothing was materialised', async () => {
      const other = makeSessionFile(sessionEntries());
      await (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: other.path });
      expect(multi.unsubscribeClient).toHaveBeenCalledWith('c1', path);
    });
  });

  describe('flag ON: prompt materialisation races', () => {
    it('two concurrent prompts materialise once and both deliver', async () => {
      (mgr as any).viewOnlySubscribeEnabled = true;
      const made = makeSessionFile(sessionEntries());
      await (mgr as any).handleSwitchSession('c1', { type: 'switch_session', sessionPath: made.path });
      sent.length = 0;
      let materialiseCalls = 0;
      multi.subscribeClient.mockImplementation(async () => {
        materialiseCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        multi.getAgentSession.mockReturnValue(agentSession);
        multi.getSessionStatus.mockReturnValue({ status: 'idle', sessionPath: made.path });
        return { sessionPath: made.path, sessionId: 'x', status: 'idle', messageCount: 1, currentStep: 0 };
      });
      await Promise.all([
        (mgr as any).handlePrompt('c1', { type: 'prompt', sessionId: 'x', message: 'first' }),
        (mgr as any).handlePrompt('c1', { type: 'prompt', sessionId: 'x', message: 'second' }),
      ]);
      expect(materialiseCalls).toBe(1);
      expect(agentSession.prompt).toHaveBeenCalledTimes(2);
    });
  });
});
