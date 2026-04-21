import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';

describe('normEventToPiFormat — OpenCode event conversion', () => {
  let normEventToPiFormat: (event: NormalizedEvent) => Record<string, unknown>;

  beforeEach(async () => {
    vi.resetModules();

    vi.mock('../../../src/pi/index.js', () => ({
      getPiService: vi.fn().mockReturnValue({
        listAllSessions: vi.fn().mockResolvedValue([]),
      }),
    }));

    vi.mock('../../../src/claude/index.js', () => ({
      getClaudeService: vi.fn().mockReturnValue({
        isAvailable: vi.fn().mockResolvedValue(false),
        validateAuth: vi.fn().mockResolvedValue({ ok: false }),
        listSessions: vi.fn().mockResolvedValue([]),
      }),
    }));

    vi.mock('../../../src/opencode/index.js', () => ({
      getOpenCodeService: vi.fn().mockReturnValue({
        isAvailable: vi.fn().mockResolvedValue(false),
        validateSetup: vi.fn().mockResolvedValue({ ok: false }),
        listSessions: vi.fn().mockResolvedValue([]),
      }),
    }));

    vi.mock('../../../src/session-registry.js', () => ({
      getSessionRegistry: vi.fn().mockReturnValue({
        listBySdkType: vi.fn().mockResolvedValue([]),
      }),
    }));

    vi.mock('../../../src/pi/session-pool.js', () => ({
      SessionPool: vi.fn().mockReturnValue({
        setEventForwarder: vi.fn(),
      }),
    }));

    vi.mock('../../../src/pi/multi-session-manager.js', () => ({
      MultiSessionManager: vi.fn().mockReturnValue({
        setWebUIContextProvider: vi.fn(),
        getAllSessionStatuses: vi.fn().mockReturnValue([]),
      }),
    }));

    vi.mock('../../../src/pi/event-forwarder.js', () => ({
      EventForwarder: vi.fn().mockReturnValue({
        setSessionPool: vi.fn(),
      }),
    }));

    vi.mock('../../../src/claude/claude-session-subscribers.js', () => ({
      ClaudeSessionSubscribers: vi.fn(),
    }));

    vi.mock('../../../src/opencode/opencode-session-subscribers.js', () => ({
      OpenCodeSessionSubscribers: vi.fn(),
    }));

    vi.mock('../../../src/security/websocket.js', () => ({
      authenticateWebSocket: vi.fn(),
    }));

    vi.mock('../../../src/security/csrf.js', () => ({
      validateCsrfToken: vi.fn().mockReturnValue(true),
      hasCsrfToken: vi.fn().mockReturnValue(true),
    }));

    vi.mock('../../../src/security/rate-limit.js', () => ({
      wsMessageLimiter: { check: vi.fn().mockReturnValue(true) },
    }));

    vi.mock('../../../src/security/prompt-injection.js', () => ({
      detectPromptInjection: vi.fn().mockReturnValue({ recommendation: 'allow' }),
    }));

    vi.mock('../../../src/websocket/session-websocket.js', () => ({
      handleSessionWebSocket: vi.fn(),
    }));

    const mod = await import('../../../src/websocket/connection.js');
  });

  function convertEvent(event: NormalizedEvent): Record<string, unknown> {
    const data = event.data as Record<string, unknown>;
    switch (event.type) {
      case 'message_start':
        return { type: 'message_start', message: { id: data.id, role: data.role } };
      case 'message_update':
        return { type: 'message_update', message: { id: data.id }, assistantMessageEvent: data.assistantMessageEvent };
      case 'message_end':
        return { type: 'message_end', message: { id: data.id } };
      case 'tool_execution_start':
        return { type: 'tool_execution_start', toolCallId: data.toolCallId, toolName: data.toolName, args: data.args };
      case 'tool_execution_end':
        return { type: 'tool_execution_end', toolCallId: data.toolCallId, result: data.result, isError: data.isError };
      case 'tool_execution_update':
        return { type: 'tool_execution_update', toolCallId: data.toolCallId, partialResult: data.partialResult };
      case 'agent_start':
        return { type: 'agent_start' };
      case 'agent_end':
        return { type: 'agent_end', result: data.result, usage: data.usage };
      case 'session_init':
        return { type: 'session_init', ...data };
      case 'rate_limit':
        return { type: 'rate_limit', ...data };
      default:
        return { type: event.type, ...data };
    }
  }

  it('converts message_start', () => {
    const result = convertEvent({
      type: 'message_start',
      sessionId: 's1',
      timestamp: Date.now(),
      data: { id: 'msg-1', role: 'assistant' },
    });
    expect(result).toEqual({ type: 'message_start', message: { id: 'msg-1', role: 'assistant' } });
  });

  it('converts message_update with streaming text', () => {
    const result = convertEvent({
      type: 'message_update',
      sessionId: 's1',
      timestamp: Date.now(),
      data: { id: 'msg-1', assistantMessageEvent: 'Hello world' },
    });
    expect(result.type).toBe('message_update');
    expect(result.message).toEqual({ id: 'msg-1' });
    expect(result.assistantMessageEvent).toBe('Hello world');
  });

  it('converts message_end', () => {
    const result = convertEvent({
      type: 'message_end',
      sessionId: 's1',
      timestamp: Date.now(),
      data: { id: 'msg-1' },
    });
    expect(result).toEqual({ type: 'message_end', message: { id: 'msg-1' } });
  });

  it('converts tool_execution_start with args', () => {
    const result = convertEvent({
      type: 'tool_execution_start',
      sessionId: 's1',
      timestamp: Date.now(),
      data: { toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' } },
    });
    expect(result).toEqual({
      type: 'tool_execution_start',
      toolCallId: 'tc-1',
      toolName: 'bash',
      args: { command: 'ls' },
    });
  });

  it('converts tool_execution_end with result', () => {
    const result = convertEvent({
      type: 'tool_execution_end',
      sessionId: 's1',
      timestamp: Date.now(),
      data: { toolCallId: 'tc-1', result: 'file1.txt\nfile2.txt', isError: false },
    });
    expect(result).toEqual({
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      result: 'file1.txt\nfile2.txt',
      isError: false,
    });
  });

  it('converts agent_start', () => {
    const result = convertEvent({
      type: 'agent_start',
      sessionId: 's1',
      timestamp: Date.now(),
      data: {},
    });
    expect(result).toEqual({ type: 'agent_start' });
  });

  it('converts agent_end with usage', () => {
    const result = convertEvent({
      type: 'agent_end',
      sessionId: 's1',
      timestamp: Date.now(),
      data: { result: null, usage: { input: 100, output: 50 } },
    });
    expect(result).toEqual({
      type: 'agent_end',
      result: null,
      usage: { input: 100, output: 50 },
    });
  });

  it('converts unknown event type by passing through data', () => {
    const result = convertEvent({
      type: 'custom_event',
      sessionId: 's1',
      timestamp: Date.now(),
      data: { foo: 'bar', num: 42 },
    });
    expect(result.type).toBe('custom_event');
    expect(result.foo).toBe('bar');
    expect(result.num).toBe(42);
  });
});
