import { describe, it, expect, beforeEach } from 'vitest';
import { OpenCodeEventAdapter } from '../../../src/opencode/opencode-event-adapter.js';
import type { OpenCodeSSEEvent, OpenCodeMessage } from '../../../src/opencode/opencode-types.js';

const SID = 'sess-opencode-1';

describe('OpenCodeEventAdapter', () => {
  let adapter: OpenCodeEventAdapter;

  beforeEach(() => {
    adapter = new OpenCodeEventAdapter();
  });

  function sse(type: string, properties?: Record<string, unknown>): OpenCodeSSEEvent {
    return { type, properties };
  }

  it('session:running → agent_start', () => {
    const events = adapter.adaptSSEEvent(sse('session:running'), SID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent_start');
    expect(events[0].sessionId).toBe(SID);
  });

  it('session:idle → agent_end', () => {
    const events = adapter.adaptSSEEvent(sse('session:idle'), SID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent_end');
    expect(events[0].sessionId).toBe(SID);
    const data = events[0].data as Record<string, unknown>;
    expect(data.result).toBeNull();
    expect(data.usage).toEqual({});
  });

  it('message:create with role assistant → message_start', () => {
    const events = adapter.adaptSSEEvent(
      sse('message:create', { id: 'msg-1', role: 'assistant' }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_start');
    const data = events[0].data as Record<string, unknown>;
    expect(data.id).toBe('msg-1');
    expect(data.role).toBe('assistant');
  });

  it('message:update with text → message_update', () => {
    const events = adapter.adaptSSEEvent(
      sse('message:update', { id: 'msg-1', role: 'assistant', text: 'Hello' }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_update');
    const data = events[0].data as Record<string, unknown>;
    expect(data.id).toBe('msg-1');
    const assistantEvent = data.assistantMessageEvent as { type: string; delta: string };
    expect(assistantEvent.delta).toBe('Hello');
  });

  it('message:complete → message_end', () => {
    const events = adapter.adaptSSEEvent(
      sse('message:complete', { id: 'msg-1' }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_end');
    const data = events[0].data as Record<string, unknown>;
    expect(data.id).toBe('msg-1');
  });

  it('message:complete without id → empty', () => {
    const events = adapter.adaptSSEEvent(sse('message:complete', {}), SID);
    expect(events).toHaveLength(0);
  });

  it('tool:call → tool_execution_start', () => {
    const events = adapter.adaptSSEEvent(
      sse('tool:call', { id: 'tool-1', name: 'Read', args: { file_path: '/tmp/a.txt' } }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_start');
    const data = events[0].data as Record<string, unknown>;
    expect(data.toolCallId).toBe('tool-1');
    expect(data.toolName).toBe('Read');
    expect(data.args).toEqual({ file_path: '/tmp/a.txt' });
  });

  it('tool:result → tool_execution_end', () => {
    const events = adapter.adaptSSEEvent(
      sse('tool:result', { toolInvocationId: 'tool-1', result: 'file contents' }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_end');
    const data = events[0].data as Record<string, unknown>;
    expect(data.toolCallId).toBe('tool-1');
    expect(data.isError).toBe(false);
    const result = data.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('file contents');
  });

  it('tool:result with object result → JSON stringified', () => {
    const events = adapter.adaptSSEEvent(
      sse('tool:result', { toolInvocationId: 'tool-2', result: { foo: 'bar' } }),
      SID,
    );
    const data = events[0].data as Record<string, unknown>;
    const result = data.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('{"foo":"bar"}');
  });

  it('unknown event type → opencode_raw', () => {
    const events = adapter.adaptSSEEvent(sse('custom:unknown', { foo: 42 }), SID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('opencode_raw');
    expect(events[0].data).toEqual({ type: 'custom:unknown', properties: { foo: 42 } });
  });

  it('permission:request → permission_request event', () => {
    const events = adapter.adaptSSEEvent(
      sse('permission:request', { id: 'perm-1', toolName: 'Write', args: { path: '/tmp/x' }, description: 'Write file' }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('permission_request');
    const data = events[0].data as Record<string, unknown>;
    expect(data.permissionId).toBe('perm-1');
    expect(data.toolName).toBe('Write');
    expect(data.description).toBe('Write file');
  });

  describe('messageToReplayEvents', () => {
    it('user message → correct message_start/update/end sequence', () => {
      const msg: OpenCodeMessage = {
        id: 'msg-user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello assistant' }],
        createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
      };

      const events = adapter.messageToReplayEvents(msg, SID);
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('message_start');
      expect(events[1].type).toBe('message_update');
      expect(events[2].type).toBe('message_end');

      const startData = events[0].data as Record<string, unknown>;
      expect(startData.role).toBe('user');
      expect(startData.id).toBe('msg-user-1');

      const updateData = events[1].data as Record<string, unknown>;
      const assistantEvent = updateData.assistantMessageEvent as { type: string; delta: string };
      expect(assistantEvent.delta).toBe('Hello assistant');
    });

    it('assistant message with text + tool parts → correct event sequence', () => {
      const msg: OpenCodeMessage = {
        id: 'msg-asst-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me read that file.' },
          { type: 'tool-invocation', toolInvocationId: 'tool-1', toolName: 'Read', args: { file_path: '/tmp/a.txt' }, result: 'file contents here' },
        ],
        createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
      };

      const events = adapter.messageToReplayEvents(msg, SID);

      const types = events.map(e => e.type);
      expect(types).toEqual([
        'message_start',
        'message_update',
        'message_end',
        'tool_execution_start',
        'tool_execution_end',
      ]);

      const toolStart = events[3].data as Record<string, unknown>;
      expect(toolStart.toolCallId).toBe('tool-1');
      expect(toolStart.toolName).toBe('Read');

      const toolEnd = events[4].data as Record<string, unknown>;
      expect(toolEnd.toolCallId).toBe('tool-1');
      const result = toolEnd.result as { content: Array<{ type: string; text: string }> };
      expect(result.content[0].text).toBe('file contents here');
    });

    it('assistant message with tool-result part → tool_execution_start + end', () => {
      const msg: OpenCodeMessage = {
        id: 'msg-asst-2',
        role: 'assistant',
        parts: [
          { type: 'tool-result', toolInvocationId: 'tool-2', toolName: 'Bash', args: { cmd: 'ls' }, result: 'file1\nfile2' },
        ],
        createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
      };

      const events = adapter.messageToReplayEvents(msg, SID);
      const types = events.map(e => e.type);
      expect(types).toEqual(['tool_execution_start', 'tool_execution_end']);
    });

    it('message with no createdAt uses current time', () => {
      const msg: OpenCodeMessage = {
        id: 'msg-no-date',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      };

      const events = adapter.messageToReplayEvents(msg, SID);
      expect(events).toHaveLength(3);
      expect(typeof events[0].timestamp).toBe('number');
      expect(events[0].timestamp).toBeGreaterThan(0);
    });
  });

  describe('reset', () => {
    it('clears internal session state', () => {
      adapter.adaptSSEEvent(
        sse('message:create', { id: 'msg-1', role: 'assistant' }),
        SID,
      );

      adapter.reset();

      const fresh = new OpenCodeEventAdapter();
      expect(adapter).toBeInstanceOf(OpenCodeEventAdapter);
    });
  });

  describe('data fallback (event.data)', () => {
    it('uses event.data when properties is absent', () => {
      const event: OpenCodeSSEEvent = {
        type: 'message:create',
        data: { id: 'msg-d-1', role: 'assistant' },
      };
      const events = adapter.adaptSSEEvent(event, SID);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message_start');
      const data = events[0].data as Record<string, unknown>;
      expect(data.id).toBe('msg-d-1');
    });
  });
});
