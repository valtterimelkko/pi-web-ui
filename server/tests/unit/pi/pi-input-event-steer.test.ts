/**
 * Pi mid-run input routing: the extension `input` event.
 *
 * Defect (H2): Web UI mid-run input for Pi sessions called
 * `AgentSession.steer()` directly, and `steer()` never emits the extension
 * `input` event (only `AgentSession.prompt()` does, via the extension runner).
 * Extensions were therefore blind to every operator message delivered as a
 * steer through the Web UI.
 *
 * These tests drive a REAL SDK `AgentSession` (real `Agent`, real
 * `ExtensionRunner`, a real extension `input` handler, and a controllable
 * stream function) through the production call sites:
 *   - `WebSocketConnectionManager.handleSteer` — the Web UI steer path
 *   - `MultiSessionManager.steer` / `.prompt` — the manager facade
 *
 * The delivery-semantics tests are pinned behaviour: they must pass before AND
 * after the routing change. The input-event test is the defect proof (RED
 * before the fix, GREEN after).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AgentSession,
  SessionManager,
  SettingsManager,
  type Extension,
  type InputEvent,
} from '@earendil-works/pi-coding-agent';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';

const { claudeMock, opencodeMock, antigravityMock, piMock, registryMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, {
    get: () => noopRecursive,
    apply: () => undefined,
  });
  return {
    claudeMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn().mockReturnValue(false),
      sendPrompt: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      hasSession: vi.fn().mockReturnValue(false),
      getSessionState: vi.fn(),
      setThinkingLevel: vi.fn(),
      createSession: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      validateAuth: vi.fn().mockResolvedValue({ ok: true }),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    opencodeMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), isPendingPermission: vi.fn().mockReturnValue(false), resolvePermission: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    antigravityMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    piMock: noopRecursive,
    registryMock: { upsert: vi.fn(), updateStatus: vi.fn(), get: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]) },
  };
});

vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({ getPiService: () => piMock }));
vi.mock('../../../src/pi/session-list-cache.js', () => ({ getPiSessionListCache: () => ({ list: () => Promise.resolve([]) }) }));
vi.mock('../../../src/session-registry.js', () => ({
  getSessionRegistry: () => registryMock,
  resolveCanonicalSessionId: vi.fn().mockResolvedValue('canonical'),
}));

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';
import { MultiSessionManager } from '../../../src/pi/multi-session-manager.js';

const STEER_TEXT = 'operator mid-run steer text';

// ---------------------------------------------------------------------------
// Real-SDK harness: a real AgentSession with a gated fake model stream and a
 // real extension `input` handler.
// ---------------------------------------------------------------------------

interface Harness {
  session: AgentSession;
  sessionFile: string;
  /** Extension `input` events observed by the extension (the seam under test). */
  inputEvents: InputEvent[];
  /** Per streamFn call: the last user message text the model was given. */
  modelCalls: string[];
  /** Resolve to let the first (gated) model response finish. */
  releaseFirstResponse: () => void;
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test-api',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { total: 0, components: {} },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function textOf(message: { role: string; content: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join(' ');
  }
  return '';
}

function createHarness(): Harness {
  const inputEvents: InputEvent[] = [];
  const modelCalls: string[] = [];

  // Fixed session file path: MSM requires a truthy sessionFile, which
  // SessionManager.inMemory() does not provide. A subclass keeps `this` (and
  // therefore all run-state bookkeeping) on the single real session instance.
  const SESSION_FILE = '/tmp/pi-input-event-test.jsonl';
  class HarnessSession extends AgentSession {}
  Object.defineProperty(HarnessSession.prototype, 'sessionFile', {
    get: () => SESSION_FILE,
  });

  // A real Extension object with a real `input` handler (the same handler map
  // shape the SDK loader produces for `pi.on('input', ...)`).
  const handlers = new Map<string, ((...args: unknown[]) => Promise<unknown>)[]>();
  handlers.set('input', [
    async (event: unknown) => {
      inputEvents.push(event as InputEvent);
      return { action: 'continue' };
    },
  ]);
  const observerExtension: Extension = {
    path: '/test/input-observer.ts',
    resolvedPath: '/test/input-observer.ts',
    sourceInfo: { path: '/test/input-observer.ts', source: 'test', scope: 'temporary', origin: 'top-level' },
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };

  const extensionRuntime = {
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    pendingNativeProviderRegistrations: [],
    invalidate: () => {},
  };
  const resourceLoader = {
    getExtensions: () => ({ extensions: [observerExtension], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const fakeModel = { provider: 'test', id: 'test-model', api: 'test-api', name: 'Test Model' };
  const modelRuntime = {
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    getAvailableSnapshot: () => [fakeModel],
    getModels: () => [fakeModel],
    getModel: () => fakeModel,
    getError: () => undefined,
    isUsingOAuth: () => false,
    getAuth: async () => undefined,
    registerProvider: () => {},
    unregisterProvider: () => {},
    registerNativeProvider: () => {},
    refresh: async () => ({}),
  } as Record<string, unknown>;

  // First model call blocks on a gate so the session stays streaming while the
  // test delivers a steer; later calls answer immediately.
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const streamFn = async (_model: unknown, context: { messages: Array<{ role: string; content: unknown }> }) => {
    const lastUser = [...context.messages].reverse().find((m) => m.role === 'user');
    const callIndex = modelCalls.push(lastUser ? textOf(lastUser) : '') - 1;
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage(callIndex === 0 ? 'first-response' : 'steered-response');
    stream.push({ type: 'start', partial: message } as never);
    if (callIndex === 0) {
      await gate;
    }
    stream.end(message);
    return stream;
  };

  const agent = new Agent({
    initialState: { systemPrompt: '', model: fakeModel as never, thinkingLevel: 'off' },
    streamFn: streamFn as never,
  });

  const session = new HarnessSession({
    agent,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    cwd: '/tmp',
    resourceLoader: resourceLoader as never,
    modelRuntime: modelRuntime as never,
  });

  return { session, sessionFile: SESSION_FILE, inputEvents, modelCalls, releaseFirstResponse: releaseGate };
}

/** Wait until the predicate holds, with a bounded polling budget. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The user/assistant transcript as plain text turns (via the session manager). */
function transcriptTurns(session: AgentSession): string[] {
  const entries = session.sessionManager.getBranch() as Array<{ type?: string; message?: { role: string; content: unknown } }>;
  return entries
    .filter((entry) => entry.type === 'message' && entry.message && (entry.message.role === 'user' || entry.message.role === 'assistant'))
    .map((entry) => `${entry.message!.role}: ${textOf(entry.message!)}`);
}

// ---------------------------------------------------------------------------
// WebSocketConnectionManager.handleSteer — the Web UI steer path
// ---------------------------------------------------------------------------

describe('Web UI steer and the extension input event (real AgentSession)', () => {
  let harness: Harness;
  let mgr: WebSocketConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = createHarness();
    mgr = new WebSocketConnectionManager();
    (mgr as any).sendMessage = (_clientId: string, _message: unknown) => {};
    (mgr as any).multiSessionManager = {
      getClientSessionPath: () => harness.session.sessionManager.getSessionFile() ?? '/tmp/in-memory.jsonl',
      getAgentSession: () => harness.session,
      getSessionStatus: () => ({ status: harness.session.isStreaming ? 'streaming' : 'idle' }),
      dispose: () => {},
    };
    (mgr as any).clientViewingSession.set('c1', '/pi/session.jsonl');
  });

  afterEach(async () => {
    harness.releaseFirstResponse();
    await harness.session.dispose();
    if (mgr) await (mgr as any).close?.();
  });

  it('defect proof: steer on a busy session bypasses the extension input handler', async () => {
    const { session, inputEvents } = harness;

    const turn = session.prompt('first');
    await waitFor(() => session.isStreaming, 'session to start streaming');

    // prompt() itself emits an input event for the initial prompt; record the
    // baseline so the assertion isolates what the steer delivers.
    const eventsBeforeSteer = inputEvents.length;

    await (mgr as any).handleSteer('c1', { type: 'steer', message: STEER_TEXT });

    // THE DEFECT: the extension never sees the operator's mid-run input.
    expect(inputEvents.length).toBe(eventsBeforeSteer + 1);
    expect(inputEvents.at(-1)?.text).toBe(STEER_TEXT);

    harness.releaseFirstResponse();
    await turn;
  });

  it('pinned: steer on a busy session joins the running turn and the turn completes as one run', async () => {
    const { session, modelCalls } = harness;

    const turn = session.prompt('first');
    await waitFor(() => session.isStreaming, 'session to start streaming');

    await (mgr as any).handleSteer('c1', { type: 'steer', message: STEER_TEXT });

    // Delivery semantics (pinned): the message is queued as a steering message.
    expect(session.getSteeringMessages()).toEqual([STEER_TEXT]);

    harness.releaseFirstResponse();
    await turn;

    // The steering message joined the SAME run (drained before the next model
    // call), and the model received exactly the operator's text.
    expect(modelCalls[1]).toBe(STEER_TEXT);
    expect(modelCalls).toHaveLength(2);
    expect(session.isStreaming).toBe(false);
    expect(transcriptTurns(session)).toEqual([
      'user: first',
      'assistant: first-response',
      'user: ' + STEER_TEXT,
      'assistant: steered-response',
    ]);
  });

  it('pinned: steer on an idle session queues without starting a turn and fires no input event', async () => {
    const { session, inputEvents } = harness;

    await (mgr as any).handleSteer('c1', { type: 'steer', message: 'queued for later' });

    // No turn was started...
    expect(session.isStreaming).toBe(false);
    // ...the message is queued as steering, and the extension saw nothing
    // (identical to today's behaviour for the idle case).
    expect(session.getSteeringMessages()).toEqual(['queued for later']);
    expect(inputEvents).toHaveLength(0);
  });

  it('pinned: follow_up on a busy session queues a follow-up message', async () => {
    const { session } = harness;

    const turn = session.prompt('first');
    await waitFor(() => session.isStreaming, 'session to start streaming');

    await (mgr as any).handleFollowUp('c1', { type: 'follow_up', message: 'after you finish' });

    expect(session.getFollowUpMessages()).toEqual(['after you finish']);

    harness.releaseFirstResponse();
    await turn;
  });
});

// ---------------------------------------------------------------------------
// MultiSessionManager.steer / .prompt — the manager facade
// ---------------------------------------------------------------------------

describe('MultiSessionManager steering and the extension input event (real AgentSession)', () => {
  let harness: Harness;
  let msm: MultiSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = createHarness();

    const fakePiService = {
      createSession: vi.fn().mockResolvedValue(harness.session),
      getSession: vi.fn(),
      setEventHandler: vi.fn(),
      removeEventHandler: vi.fn(),
    };
    msm = new MultiSessionManager(fakePiService as never, () => {});
  });

  afterEach(async () => {
    harness.releaseFirstResponse();
    await harness.session.dispose();
    await msm.dispose();
  });

  it('defect proof: msm.steer on a busy session bypasses the extension input handler', async () => {
    const { session, inputEvents } = harness;
    await msm.createAndSubscribe('client-1', '/tmp');

    const turn = msm.prompt(harness.sessionFile, 'first');
    await waitFor(() => session.isStreaming, 'session to start streaming');
    const eventsBeforeSteer = inputEvents.length;

    await msm.steer(harness.sessionFile, STEER_TEXT);

    expect(inputEvents.length).toBe(eventsBeforeSteer + 1);
    expect(inputEvents.at(-1)?.text).toBe(STEER_TEXT);

    harness.releaseFirstResponse();
    await turn;
  });

  it('pinned: msm.prompt on a busy session still fails fast with the already-busy error', async () => {
    const { session } = harness;
    await msm.createAndSubscribe('client-1', '/tmp');

    // The first turn goes through the manager itself so its busy-bookkeeping
    // is in play, exactly as in production.
    const turn = msm.prompt(harness.sessionFile, 'first');
    await waitFor(() => session.isStreaming, 'session to start streaming');

    await expect(msm.prompt(harness.sessionFile, 'second')).rejects.toThrow(/already busy/);

    harness.releaseFirstResponse();
    await turn;
  });

  it('pinned: msm.prompt on an idle session starts a turn', async () => {
    const { session, modelCalls } = harness;
    await msm.createAndSubscribe('client-1', '/tmp');

    const turn = msm.prompt(harness.sessionFile, 'first');
    await waitFor(() => session.isStreaming, 'session to start streaming');

    harness.releaseFirstResponse();
    await turn;

    expect(modelCalls[0]).toBe('first');
    expect(session.isStreaming).toBe(false);
  });

  it('pinned: msm.steer on an idle session queues without starting a turn', async () => {
    const { session, inputEvents } = harness;
    await msm.createAndSubscribe('client-1', '/tmp');

    await msm.steer(harness.sessionFile, 'queued for later');

    expect(session.isStreaming).toBe(false);
    expect(session.getSteeringMessages()).toEqual(['queued for later']);
    expect(inputEvents).toHaveLength(0);
  });
});
