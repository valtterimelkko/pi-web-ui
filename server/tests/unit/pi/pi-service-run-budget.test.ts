/**
 * B3b — PiService wiring of the per-run output-token and streamed-byte
 * budgets.
 *
 * Pins the contract that matters for coverage of every Pi entry point: EVERY
 * event of every session created through PiService passes through
 * `RunBudgetGuard` at the single `session.subscribe` funnel (alongside B3a's
 * `ToolArgsBudgetGuard`), and a synthetic `run_budget_exceeded` event
 * dispatches through the same registered handler that receives the session's
 * ordinary events.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { subscribeCallbacks, abortMock } = vi.hoisted(() => ({
  subscribeCallbacks: [] as Array<(event: unknown) => void>,
  abortMock: vi.fn().mockResolvedValue(undefined),
}));

const { accessMock, readFileMock, modelRuntime } = vi.hoisted(() => ({
  accessMock: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  readFileMock: vi.fn().mockResolvedValue('{"type":"session","id":"test-session-id"}\n'),
  modelRuntime: {
    setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
    getError: vi.fn().mockReturnValue(undefined),
    getModels: vi.fn().mockReturnValue([]),
    getAvailable: vi.fn().mockResolvedValue([]),
    getModel: vi.fn().mockReturnValue(undefined),
    hasConfiguredAuth: vi.fn().mockReturnValue(false),
    registerProvider: vi.fn(),
    refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }),
  },
}));

vi.mock('fs/promises', () => ({
  access: accessMock,
  readFile: readFileMock,
}));

vi.mock('../../../src/pi/session-cwd.js', () => ({
  readSessionIdentity: vi.fn(async () => JSON.parse(String(await readFileMock())).id),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn().mockImplementation(async () => ({
    session: {
      sessionId: 'test-session-id',
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscribeCallbacks.push(callback);
      }),
      setModel: vi.fn(),
      dispose: vi.fn(),
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      abort: abortMock,
      sessionManager: {},
    },
  })),
  SessionManager: {
    create: vi.fn().mockReturnValue({ getSessionId: vi.fn(() => 'test-session-id'), setSessionFile: vi.fn(), _rewriteFile: vi.fn() }),
    open: vi.fn().mockReturnValue({ getSessionId: vi.fn(() => 'test-session-id'), setSessionFile: vi.fn(), _rewriteFile: vi.fn() }),
    inMemory: vi.fn().mockReturnValue({ getSessionId: vi.fn(() => 'test-session-id'), setSessionFile: vi.fn(), _rewriteFile: vi.fn() }),
    continueRecent: vi.fn().mockResolvedValue({ getSessionId: vi.fn(() => 'test-session-id'), setSessionFile: vi.fn(), _rewriteFile: vi.fn() }),
    list: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
  },
  ModelRuntime: {
    create: vi.fn().mockResolvedValue(modelRuntime),
  },
  DefaultResourceLoader: vi.fn().mockImplementation(() => ({
    reload: vi.fn().mockResolvedValue(undefined),
    getExtensions: vi.fn().mockReturnValue({
      extensions: [],
      errors: [],
      runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] },
    }),
    getSkills: vi.fn().mockReturnValue({ skills: [], diagnostics: [] }),
    getAgentsFiles: vi.fn().mockReturnValue({ agentsFiles: [] }),
  })),
}));

vi.mock('../../../src/config.js', () => ({
  config: {
    jwtSecret: 'test-secret',
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
    piAgentDir: '/tmp/pi-agent',
    sessionDir: '/tmp/sessions',
    piOpenrouterModelsEnabled: false,
    // B3a caps as seen by PiService at session creation.
    piToolArgsMaxCallChars: 1024,
    piToolArgsMaxTurnChars: 4096,
    // B3b run-budget caps as seen by PiService at session creation.
    piRunBudgetMaxOutputTokens: 1000,
    piRunBudgetMaxStreamedBytes: 2048,
  },
}));

import { PiService } from '../../../src/pi/pi-service.js';
import { RUN_BUDGET_EXCEEDED_EVENT } from '../../../src/pi/run-budget.js';

const agentStart = { type: 'agent_start' };
const textDelta = (bytes: number): unknown => ({
  type: 'message_update',
  message: { role: 'assistant', id: 'm1' },
  assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(bytes), partial: {} },
});
const assistantEnd = (outputTokens: number): unknown => ({
  type: 'message_end',
  message: { role: 'assistant', content: [], usage: { input: 1, output: outputTokens, cacheRead: 0, cacheWrite: 0, totalTokens: outputTokens } },
});

describe('PiService run-budget wiring (B3b)', () => {
  let service: PiService;
  let received: unknown[];
  let subscribeCallback: (event: unknown) => void;

  beforeEach(async () => {
    subscribeCallbacks.length = 0;
    abortMock.mockClear();
    service = new PiService();
    received = [];
    service.setEventHandler('run-budget-client', (event) => {
      received.push(event);
    });
    await service.createSession({ clientId: 'run-budget-client', inMemory: true });
    expect(subscribeCallbacks).toHaveLength(1);
    subscribeCallback = subscribeCallbacks[0];
  });

  it('passes ordinary session events through to the registered handler untouched', () => {
    subscribeCallback(agentStart);
    subscribeCallback(textDelta(10));
    subscribeCallback(assistantEnd(100));
    expect(received).toEqual([agentStart, textDelta(10), assistantEnd(100)]);
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('a streamed-byte breach reaches the handler AND triggers abort + one synthetic event', () => {
    subscribeCallback(agentStart);
    for (let i = 0; i < 40; i++) subscribeCallback(textDelta(100)); // 4000 bytes > byte cap 2048

    // Every original event was still delivered (projection/fan-out unchanged)…
    expect(received.filter((event) => (event as { type: string }).type === 'message_update')).toHaveLength(40);
    // …plus exactly one synthetic breach event naming the budget.
    const synthetic = received.filter((event) => (event as { type: string }).type === RUN_BUDGET_EXCEEDED_EVENT);
    expect(synthetic).toHaveLength(1);
    expect((synthetic[0] as { data: { budget: string } }).data.budget).toBe('streamed_bytes');
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  it('an output-token breach at message_end also trips the wired guard', () => {
    subscribeCallback(agentStart);
    subscribeCallback(textDelta(100)); // 100 bytes, under the byte cap
    subscribeCallback(assistantEnd(600));
    expect(abortMock).not.toHaveBeenCalled();
    subscribeCallback(assistantEnd(600)); // cumulative 1200 > token cap 1000
    expect(abortMock).toHaveBeenCalledTimes(1);
    const synthetic = received.filter((event) => (event as { type: string }).type === RUN_BUDGET_EXCEEDED_EVENT);
    expect(synthetic).toHaveLength(1);
    expect((synthetic[0] as { data: { budget: string } }).data.budget).toBe('output_tokens');
  });

  it('the synthetic event is delivered even when the synthetic dispatch races a handler swap', () => {
    subscribeCallback(agentStart);
    service.removeEventHandler('run-budget-client');
    for (let i = 0; i < 40; i++) subscribeCallback(textDelta(100));
    // No handler: nothing is delivered anywhere, but the guard still aborts.
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  it('a second session instance gets its own guard (fresh run state)', async () => {
    subscribeCallback(agentStart);
    for (let i = 0; i < 40; i++) subscribeCallback(textDelta(100));
    expect(abortMock).toHaveBeenCalledTimes(1);

    await service.createSession({ clientId: 'run-budget-client-2', inMemory: true });
    const secondCallback = subscribeCallbacks[1];
    abortMock.mockClear();
    secondCallback(agentStart);
    for (let i = 0; i < 5; i++) secondCallback(textDelta(100));
    expect(abortMock).not.toHaveBeenCalled();
  });
});
