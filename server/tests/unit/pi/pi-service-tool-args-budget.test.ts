/**
 * B3a — PiService wiring of the streaming tool-argument budget.
 *
 * Pins the contract that matters for coverage of every Pi entry point: EVERY
 * event of every session created through PiService passes through
 * `ToolArgsBudgetGuard` at the single `session.subscribe` funnel, and a
 * synthetic `tool_args_budget_exceeded` event dispatches through the same
 * registered handler that receives the session's ordinary events.
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
  },
}));

import { PiService } from '../../../src/pi/pi-service.js';
import { TOOL_ARGS_BUDGET_EXCEEDED_EVENT } from '../../../src/pi/tool-args-budget.js';

const agentStart = { type: 'agent_start' };
const delta = (chars: number): unknown => ({
  type: 'message_update',
  message: { role: 'assistant', id: 'm1' },
  assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'x'.repeat(chars), partial: {} },
});

describe('PiService tool-argument budget wiring (B3a)', () => {
  let service: PiService;
  let received: unknown[];
  let subscribeCallback: (event: unknown) => void;

  beforeEach(async () => {
    subscribeCallbacks.length = 0;
    abortMock.mockClear();
    service = new PiService();
    received = [];
    service.setEventHandler('budget-client', (event) => {
      received.push(event);
    });
    await service.createSession({ clientId: 'budget-client', inMemory: true });
    expect(subscribeCallbacks).toHaveLength(1);
    subscribeCallback = subscribeCallbacks[0];
  });

  it('passes ordinary session events through to the registered handler untouched', () => {
    subscribeCallback(agentStart);
    subscribeCallback(delta(10));
    expect(received).toEqual([agentStart, delta(10)]);
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('a breaching stream reaches the handler AND triggers abort + one synthetic event', () => {
    subscribeCallback(agentStart);
    for (let i = 0; i < 40; i++) subscribeCallback(delta(100)); // 4000 chars > call cap 1024

    // Every original event was still delivered (projection/fan-out unchanged)…
    expect(received.filter((event) => (event as { type: string }).type === 'message_update')).toHaveLength(40);
    // …plus exactly one synthetic breach event after the breaching delta.
    const synthetic = received.filter((event) => (event as { type: string }).type === TOOL_ARGS_BUDGET_EXCEEDED_EVENT);
    expect(synthetic).toHaveLength(1);
    expect((synthetic[0] as { data: { scope: string } }).data.scope).toBe('call');
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  it('the synthetic event is delivered even when the synthetic dispatch races a handler swap', () => {
    subscribeCallback(agentStart);
    service.removeEventHandler('budget-client');
    for (let i = 0; i < 40; i++) subscribeCallback(delta(100));
    // No handler: nothing is delivered anywhere, but the guard still aborts.
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  it('a second session instance gets its own guard (fresh run state)', async () => {
    subscribeCallback(agentStart);
    for (let i = 0; i < 40; i++) subscribeCallback(delta(100));
    expect(abortMock).toHaveBeenCalledTimes(1);

    await service.createSession({ clientId: 'budget-client-2', inMemory: true });
    const secondCallback = subscribeCallbacks[1];
    abortMock.mockClear();
    secondCallback(agentStart);
    for (let i = 0; i < 5; i++) secondCallback(delta(100));
    expect(abortMock).not.toHaveBeenCalled();
  });
});
