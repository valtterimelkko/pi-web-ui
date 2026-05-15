import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClaudeChannelEventAdapter, type ChannelEvent } from '../../../src/claude/claude-channel-event-adapter.js';

describe('ClaudeChannelEventAdapter', () => {
  let adapter: ClaudeChannelEventAdapter;
  const SESSION_ID = 'test-session-123';

  beforeEach(() => {
    adapter = new ClaudeChannelEventAdapter();
  });

  describe('normalize', () => {
    it('should convert session_init correctly', () => {
      const event: ChannelEvent = {
        type: 'session_init',
        sessionId: SESSION_ID,
        tools: ['Read', 'Write'],
        model: 'claude-sonnet-4',
        cwd: '/home/user/project',
        permissionMode: 'acceptEdits',
        claudeSessionId: 'claude-sess-456',
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('session_init');
      expect(events[0].sessionId).toBe(SESSION_ID);
      expect(events[0].data).toEqual({
        tools: ['Read', 'Write'],
        model: 'claude-sonnet-4',
        sessionId: 'claude-sess-456',
        cwd: '/home/user/project',
        permissionMode: 'acceptEdits',
      });
    });

    it('should convert agent_start correctly', () => {
      const event: ChannelEvent = {
        type: 'agent_start',
        sessionId: SESSION_ID,
        claudeSessionId: 'claude-sess-456',
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('agent_start');
      expect(events[0].data).toEqual({
        sessionId: SESSION_ID,
        claudeSessionId: 'claude-sess-456',
      });
    });

    it('should convert message_start correctly', () => {
      const event: ChannelEvent = {
        type: 'message_start',
        sessionId: SESSION_ID,
        message: { id: 'msg_001', role: 'assistant' },
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message_start');
      expect(events[0].data).toEqual({
        id: 'msg_001',
        role: 'assistant',
      });
    });

    it('should convert message_update correctly', () => {
      const event: ChannelEvent = {
        type: 'message_update',
        sessionId: SESSION_ID,
        message: { id: 'msg_001' },
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message_update');
      expect(events[0].data).toEqual({
        id: 'msg_001',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      });
    });

    it('should convert message_end correctly', () => {
      const event: ChannelEvent = {
        type: 'message_end',
        sessionId: SESSION_ID,
        message: { id: 'msg_001' },
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message_end');
      expect(events[0].data).toEqual({ id: 'msg_001' });
    });

    it('should convert tool_execution_start correctly', () => {
      const event: ChannelEvent = {
        type: 'tool_execution_start',
        sessionId: SESSION_ID,
        toolCallId: 'toolu_001',
        toolName: 'Read',
        args: { file_path: '/tmp/test.txt' },
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_execution_start');
      expect(events[0].data).toEqual({
        toolCallId: 'toolu_001',
        toolName: 'Read',
        args: { file_path: '/tmp/test.txt' },
      });
    });

    it('should convert tool_execution_end with result correctly', () => {
      const event: ChannelEvent = {
        type: 'tool_execution_end',
        sessionId: SESSION_ID,
        toolCallId: 'toolu_001',
        result: { content: [{ type: 'text', text: 'file contents' }] },
        isError: false,
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_execution_end');
      expect(events[0].data).toEqual({
        toolCallId: 'toolu_001',
        result: { content: [{ type: 'text', text: 'file contents' }] },
        isError: false,
      });
    });

    it('should convert tool_execution_end with error correctly', () => {
      const event: ChannelEvent = {
        type: 'tool_execution_end',
        sessionId: SESSION_ID,
        toolCallId: 'toolu_002',
        result: { content: [{ type: 'text', text: 'File not found' }] },
        isError: true,
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_execution_end');
      expect((events[0].data as Record<string, unknown>).isError).toBe(true);
    });

    it('should convert agent_end with usage stats correctly', () => {
      const event: ChannelEvent = {
        type: 'agent_end',
        sessionId: SESSION_ID,
        result: 'All done!',
        usage: { input_tokens: 100, output_tokens: 50 },
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('agent_end');
      expect(events[0].data).toEqual({
        result: 'All done!',
        usage: { input_tokens: 100, output_tokens: 50 },
      });
    });

    it('should convert rate_limit correctly', () => {
      const event: ChannelEvent = {
        type: 'rate_limit',
        sessionId: SESSION_ID,
        status: 'allowed',
        rateLimitType: 'five_hour',
        isUsingOverage: false,
        resetsAt: 1000000,
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('rate_limit');
      expect(events[0].data).toEqual({
        status: 'allowed',
        rateLimitType: 'five_hour',
        isUsingOverage: false,
        resetsAt: 1000000,
      });
    });

    it('should convert permission_request correctly', () => {
      const event: ChannelEvent = {
        type: 'permission_request',
        sessionId: SESSION_ID,
        requestId: 'req_001',
        toolName: 'Write',
        description: 'Write to file',
        args: { file_path: '/tmp/out.txt' },
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('permission_request');
      expect(events[0].data).toEqual({
        requestId: 'req_001',
        toolName: 'Write',
        description: 'Write to file',
        args: { file_path: '/tmp/out.txt' },
        sessionId: SESSION_ID,
      });
    });

    it('should pass through unknown event types as claude_channel_raw', () => {
      const event: ChannelEvent = {
        type: 'some_future_event',
        sessionId: SESSION_ID,
        customField: 'custom_value',
        nested: { a: 1 },
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('claude_channel_raw');
      expect(events[0].data).toEqual(event);
    });

    it('should convert usage event to usage_report', () => {
      const event: ChannelEvent = {
        type: 'usage',
        sessionId: SESSION_ID,
        input_tokens: 500,
        output_tokens: 200,
      };

      const events = adapter.normalize(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('usage_report');
      expect(events[0].sessionId).toBe(SESSION_ID);
      expect(events[0].data).toEqual({
        inputTokens: 500,
        outputTokens: 200,
      });
    });

    it('should use event timestamp when provided', () => {
      const eventTs = 1700000000000;
      const event: ChannelEvent = {
        type: 'agent_start',
        sessionId: SESSION_ID,
        timestamp: eventTs,
      };

      const events = adapter.normalize(event);
      expect(events[0].timestamp).toBe(eventTs);
    });

    it('should fall back to Date.now() when no timestamp', () => {
      const now = 1700000000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const event: ChannelEvent = {
        type: 'agent_start',
        sessionId: SESSION_ID,
      };

      const events = adapter.normalize(event);
      expect(events[0].timestamp).toBe(now);

      vi.restoreAllMocks();
    });

    it('should prefer explicit timestamp parameter over event timestamp', () => {
      const explicitTs = 1800000000000;
      const event: ChannelEvent = {
        type: 'agent_start',
        sessionId: SESSION_ID,
        timestamp: 1700000000000,
      };

      const events = adapter.normalize(event, explicitTs);
      expect(events[0].timestamp).toBe(explicitTs);
    });
  });

  describe('toPiFormat', () => {
    it('should format message_start identically to normEventToPiFormat', () => {
      const event = { type: 'message_start' as const, sessionId: SESSION_ID, timestamp: Date.now(), data: { id: 'msg_001', role: 'assistant' } };
      expect(adapter.toPiFormat(event)).toEqual({
        type: 'message_start',
        message: { id: 'msg_001', role: 'assistant' },
      });
    });

    it('should format message_update identically to normEventToPiFormat', () => {
      const event = { type: 'message_update' as const, sessionId: SESSION_ID, timestamp: Date.now(), data: { id: 'msg_001', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } } };
      expect(adapter.toPiFormat(event)).toEqual({
        type: 'message_update',
        message: { id: 'msg_001' },
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      });
    });

    it('should format message_end identically to normEventToPiFormat', () => {
      const event = { type: 'message_end' as const, sessionId: SESSION_ID, timestamp: Date.now(), data: { id: 'msg_001' } };
      expect(adapter.toPiFormat(event)).toEqual({
        type: 'message_end',
        message: { id: 'msg_001' },
      });
    });

    it('should format tool_execution_start identically to normEventToPiFormat', () => {
      const event = { type: 'tool_execution_start' as const, sessionId: SESSION_ID, timestamp: Date.now(), data: { toolCallId: 'toolu_001', toolName: 'Read', args: { file_path: '/tmp/test.txt' } } };
      expect(adapter.toPiFormat(event)).toEqual({
        type: 'tool_execution_start',
        toolCallId: 'toolu_001',
        toolName: 'Read',
        args: { file_path: '/tmp/test.txt' },
      });
    });

    it('should format tool_execution_end identically to normEventToPiFormat', () => {
      const event = { type: 'tool_execution_end' as const, sessionId: SESSION_ID, timestamp: Date.now(), data: { toolCallId: 'toolu_001', result: { content: [] }, isError: false } };
      expect(adapter.toPiFormat(event)).toEqual({
        type: 'tool_execution_end',
        toolCallId: 'toolu_001',
        result: { content: [] },
        isError: false,
      });
    });

    it('should format agent_start identically to normEventToPiFormat', () => {
      const event = { type: 'agent_start' as const, sessionId: SESSION_ID, timestamp: Date.now(), data: { sessionId: SESSION_ID } };
      expect(adapter.toPiFormat(event)).toEqual({
        type: 'agent_start',
      });
    });

    it('should format agent_end identically to normEventToPiFormat', () => {
      const event = { type: 'agent_end' as const, sessionId: SESSION_ID, timestamp: Date.now(), data: { result: 'done', usage: { input_tokens: 10 } } };
      expect(adapter.toPiFormat(event)).toEqual({
        type: 'agent_end',
        result: 'done',
        usage: { input_tokens: 10 },
      });
    });

    it('should format session_init identically to normEventToPiFormat', () => {
      const data = { tools: ['Read'], model: 'sonnet', sessionId: 's1', cwd: '/tmp', permissionMode: 'acceptEdits' };
      const event = { type: 'session_init' as const, sessionId: SESSION_ID, timestamp: Date.now(), data };
      expect(adapter.toPiFormat(event)).toEqual({
        type: 'session_init',
        ...data,
      });
    });

    it('should format rate_limit identically to normEventToPiFormat', () => {
      const data = { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false, resetsAt: 1000 };
      const event = { type: 'rate_limit' as const, sessionId: SESSION_ID, timestamp: Date.now(), data };
      expect(adapter.toPiFormat(event)).toEqual({
        type: 'rate_limit',
        ...data,
      });
    });

    it('should format unknown types via default spread', () => {
      const event = { type: 'custom_event' as const, sessionId: SESSION_ID, timestamp: Date.now(), data: { foo: 'bar', num: 42 } };
      expect(adapter.toPiFormat(event)).toEqual({
        type: 'custom_event',
        foo: 'bar',
        num: 42,
      });
    });
  });

  describe('cross-adapter compatibility', () => {
    it('should produce identical NormalizedEvent shapes to ClaudeEventNormalizer for session_init', () => {
      const channelEvent: ChannelEvent = {
        type: 'session_init',
        sessionId: SESSION_ID,
        tools: ['Read', 'Write'],
        model: 'claude-opus-4',
        cwd: '/tmp',
        permissionMode: 'acceptEdits',
        claudeSessionId: 'abc-123',
      };

      const events = adapter.normalize(channelEvent);
      expect(events[0].type).toBe('session_init');
      expect(events[0].data).toMatchObject({
        tools: ['Read', 'Write'],
        model: 'claude-opus-4',
        sessionId: 'abc-123',
        cwd: '/tmp',
        permissionMode: 'acceptEdits',
      });
    });

    it('should produce identical NormalizedEvent shapes to ClaudeEventNormalizer for tool_execution_start', () => {
      const channelEvent: ChannelEvent = {
        type: 'tool_execution_start',
        sessionId: SESSION_ID,
        toolCallId: 'toolu_001',
        toolName: 'Read',
        args: { file_path: '/tmp/test.txt' },
      };

      const events = adapter.normalize(channelEvent);
      expect(events[0].type).toBe('tool_execution_start');
      expect(events[0].data).toEqual({
        toolCallId: 'toolu_001',
        toolName: 'Read',
        args: { file_path: '/tmp/test.txt' },
      });
    });

    it('should produce identical NormalizedEvent shapes to ClaudeEventNormalizer for tool_execution_end', () => {
      const channelEvent: ChannelEvent = {
        type: 'tool_execution_end',
        sessionId: SESSION_ID,
        toolCallId: 'toolu_001',
        result: { content: [{ type: 'text', text: 'file contents' }] },
        isError: false,
      };

      const events = adapter.normalize(channelEvent);
      expect(events[0].type).toBe('tool_execution_end');
      expect(events[0].data).toEqual({
        toolCallId: 'toolu_001',
        result: { content: [{ type: 'text', text: 'file contents' }] },
        isError: false,
      });
    });

    it('should produce identical NormalizedEvent shapes to ClaudeEventNormalizer for message_start/update/end sequence', () => {
      const startEvent: ChannelEvent = {
        type: 'message_start',
        sessionId: SESSION_ID,
        message: { id: 'msg_002', role: 'assistant' },
      };
      const updateEvent: ChannelEvent = {
        type: 'message_update',
        sessionId: SESSION_ID,
        message: { id: 'msg_002' },
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello, world!' },
      };
      const endEvent: ChannelEvent = {
        type: 'message_end',
        sessionId: SESSION_ID,
        message: { id: 'msg_002' },
      };

      const start = adapter.normalize(startEvent);
      expect(start[0].type).toBe('message_start');
      expect(start[0].data).toEqual({ id: 'msg_002', role: 'assistant' });

      const update = adapter.normalize(updateEvent);
      expect(update[0].type).toBe('message_update');
      expect((update[0].data as Record<string, unknown>).assistantMessageEvent).toEqual({
        type: 'text_delta',
        delta: 'Hello, world!',
      });

      const end = adapter.normalize(endEvent);
      expect(end[0].type).toBe('message_end');
      expect(end[0].data).toEqual({ id: 'msg_002' });
    });

    it('should produce identical NormalizedEvent shapes to ClaudeEventNormalizer for rate_limit', () => {
      const channelEvent: ChannelEvent = {
        type: 'rate_limit',
        sessionId: SESSION_ID,
        status: 'allowed',
        rateLimitType: 'five_hour',
        isUsingOverage: false,
        resetsAt: 1000000,
      };

      const events = adapter.normalize(channelEvent);
      expect(events[0].type).toBe('rate_limit');
      expect(events[0].data).toEqual({
        status: 'allowed',
        rateLimitType: 'five_hour',
        isUsingOverage: false,
        resetsAt: 1000000,
      });
    });
  });
});
