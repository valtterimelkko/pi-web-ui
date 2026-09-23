/**
 * M3 — submission-shaped prompt/steer on the MultiSessionManager.
 *
 * Defect (W4 campaign, C01-standard/attempt-28): the voice delivery adapter
 * awaited `manager.prompt()`, which awaits the WHOLE worker turn
 * (`agentSession.prompt(message)` resolves at turn end). A receipt that waits
 * for the turn makes "bytes delivered" mean "the worker finished" — every real
 * worker turn now delays the receipt past every journey deadline.
 *
 * The contract (VOICE-LIVE-WIRE-CONTRACT.md §4.4/§4.6) keeps three artefacts
 * distinct: audio received, words recognised, BYTES DELIVERED. The trusted
 * chime fires on a `delivered` receipt and nothing else, so the receipt must
 * fire at SUBMISSION.
 *
 * These tests drive a REAL SDK AgentSession (real agent loop, gated model
 * stream) through the manager facade and pin the submission shape:
 *   - `submitPrompt` resolves once the turn has genuinely STARTED
 *     (agent_start observed / session streaming), never waiting for turn end;
 *   - `submitSteer` resolves once queued and reports honestly whether it
 *     joined a RUNNING turn or queues for the next one;
 *   - `prompt()` keeps its existing whole-turn semantics (the Internal API
 *     depends on them) — pinned, not changed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AgentSession,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import { MultiSessionManager } from '../../../src/pi/multi-session-manager.js';

// ---------------------------------------------------------------------------

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

interface Harness {
  session: AgentSession;
  sessionFile: string;
  /** Per streamFn call: the last user message text the model was given. */
  modelCalls: string[];
  /** Resolve to let the first (gated) model response finish. */
  releaseFirstResponse: () => void;
  /** Override the auth preflight (defaults to configured). */
  authConfigured: boolean;
}

let harnessCounter = 0;

function createHarness(overrides: { authConfigured?: boolean } = {}): Harness {
  const authConfigured = overrides.authConfigured ?? true;
  const modelCalls: string[] = [];

  // A fixed, unique session file path per harness: the manager requires a
  // truthy sessionFile, which SessionManager.inMemory() does not provide.
  // A subclass keeps `this` (and therefore all run-state bookkeeping) on the
  // single real session instance.
  const SESSION_FILE = `/tmp/pi-m3-submit-${++harnessCounter}.jsonl`;
  class HarnessSession extends AgentSession {}
  Object.defineProperty(HarnessSession.prototype, 'sessionFile', {
    get: () => SESSION_FILE,
  });

  const resourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: {
        flagValues: new Map(),
        pendingProviderRegistrations: [],
        pendingNativeProviderRegistrations: [],
        invalidate: () => {},
      },
    }),
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
    hasConfiguredAuth: () => authConfigured,
    checkAuth: async () => (authConfigured ? { ok: true } : undefined),
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

  // First model call blocks on a gate so the turn genuinely runs long while
  // the submission is observed; later calls answer immediately.
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const streamFn = async (_model: unknown, context: { messages: Array<{ role: string; content: unknown }> }) => {
    const lastUser = [...context.messages].reverse().find((m) => m.role === 'user');
    const callIndex = modelCalls.push(lastUser ? textOf(lastUser) : '') - 1;
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage(callIndex === 0 ? 'first-response' : 'later-response');
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

  return {
    session,
    sessionFile: SESSION_FILE,
    modelCalls,
    releaseFirstResponse: releaseGate,
    authConfigured,
  };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const waitMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A PiService-shaped double that wires the real session's events to the manager. */
function createFakePiService(harness: Harness) {
  const handlers = new Map<string, (event: unknown) => void>();
  return {
    handlers,
    createSession: vi.fn(async (options: { clientId: string }) => {
      const handler = handlers.get(options.clientId);
      if (handler) {
        harness.session.subscribe(handler as never);
      }
      return harness.session;
    }),
    getSession: vi.fn(),
    setEventHandler: vi.fn((key: string, handler: (event: unknown) => void) => {
      handlers.set(key, handler);
    }),
    removeEventHandler: vi.fn((key: string) => {
      handlers.delete(key);
    }),
  };
}

async function createWiredManager(harnessOverrides: { authConfigured?: boolean } = {}): Promise<{
  harness: Harness;
  manager: MultiSessionManager;
  sessionPath: string;
}> {
  const harness = createHarness(harnessOverrides);
  const fakePiService = createFakePiService(harness);
  const manager = new MultiSessionManager(fakePiService as never, () => {}, {
    cleanupIntervalMs: 3_600_000,
    idleSessionTimeoutMs: 3_600_000,
  });
  await manager.createAndSubscribe('client-1', '/tmp');
  return { harness, manager, sessionPath: harness.sessionFile };
}

// ---------------------------------------------------------------------------

describe('MultiSessionManager — submission-shaped prompt/steer (M3 delivery receipts)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('RED: submitPrompt resolves once the turn has STARTED — a long-running turn does not delay the submission', async () => {
    const { harness, manager, sessionPath } = await createWiredManager();

    const submission = manager.submitPrompt(sessionPath, 'long-running instruction');
    const settled = await Promise.race([
      submission.then(() => true, () => false),
      waitMs(2000).then(() => false),
    ]);

    // THE DEFECT PROOF: the submission settles while the worker is still
    // running the turn — the receipt this enables means "bytes delivered",
    // not "the worker finished".
    expect(settled).toBe(true);
    expect(harness.session.isStreaming).toBe(true);

    // The manager's own projection shows the worker genuinely busy.
    expect(manager.getSessionStatus(sessionPath)?.status).toBe('streaming');

    // The turn continues in the background and completes normally, with the
    // instruction actually reaching the model.
    harness.releaseFirstResponse();
    await waitFor(() => !harness.session.isStreaming, 'the background turn to finish');
    expect(harness.modelCalls).toEqual(['long-running instruction']);
    expect(manager.getSessionStatus(sessionPath)?.status).toBe('idle');
  });

  it('pins: prompt() still awaits the WHOLE worker turn (Internal API callers depend on it)', async () => {
    const { harness, manager, sessionPath } = await createWiredManager();

    const wholeTurn = manager.prompt(sessionPath, 'whole-turn instruction');
    await waitFor(() => harness.session.isStreaming, 'the turn to start');

    // While the gate is closed the prompt has NOT resolved — that is the
    // existing contract the Internal API builds on. Unchanged by M3.
    const resolvedEarly = await Promise.race([
      wholeTurn.then(() => true, () => true),
      waitMs(300).then(() => false),
    ]);
    expect(resolvedEarly).toBe(false);

    harness.releaseFirstResponse();
    await wholeTurn;
    expect(harness.session.isStreaming).toBe(false);
    expect(manager.getSessionStatus(sessionPath)?.status).toBe('idle');
  });

  it('submitPrompt refuses an unresolvable session (the refusal path stays loud)', async () => {
    const { manager } = await createWiredManager();
    await expect(manager.submitPrompt('/no/such/session.jsonl', 'x')).rejects.toThrow(/does not exist/);
  });

  it('submitPrompt refuses when the worker is already busy (never a silent queue)', async () => {
    const { harness, manager, sessionPath } = await createWiredManager();

    const background = manager.prompt(sessionPath, 'first turn');
    await waitFor(() => harness.session.isStreaming, 'the first turn to start');

    await expect(manager.submitPrompt(sessionPath, 'second')).rejects.toThrow(/already busy/);

    harness.releaseFirstResponse();
    await background;
  });

  it('submitPrompt surfaces a preflight refusal (no configured auth) instead of waiting', async () => {
    const { harness, manager, sessionPath } = await createWiredManager({ authConfigured: false });

    await expect(manager.submitPrompt(sessionPath, 'x')).rejects.toThrow();
    expect(harness.session.isStreaming).toBe(false);
  });

  it('submitSteer joins a RUNNING turn and reports it', async () => {
    const { harness, manager, sessionPath } = await createWiredManager();

    const background = manager.prompt(sessionPath, 'first turn');
    await waitFor(() => harness.session.isStreaming, 'the turn to start');

    const steer = await manager.submitSteer(sessionPath, 'mid-run instruction');
    expect(steer).toEqual({ joinedRunningTurn: true });
    expect(harness.session.getSteeringMessages()).toEqual(['mid-run instruction']);

    harness.releaseFirstResponse();
    await background;
    expect(harness.modelCalls[1]).toBe('mid-run instruction');
    expect(manager.getSessionStatus(sessionPath)?.status).toBe('idle');
  });

  it('submitSteer with no turn running queues for the next run and says so', async () => {
    const { harness, manager, sessionPath } = await createWiredManager();

    const steer = await manager.submitSteer(sessionPath, 'for the next turn');
    expect(steer).toEqual({ joinedRunningTurn: false });

    // Nothing is running; the message sits queued, honestly reported.
    expect(harness.session.isStreaming).toBe(false);
    expect(manager.getSessionStatus(sessionPath)?.status).toBe('idle');
  });
});
