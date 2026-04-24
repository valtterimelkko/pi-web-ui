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

  it('session.status busy → agent_start', () => {
    const events = adapter.adaptSSEEvent(
      sse('session.status', { sessionID: SID, status: { type: 'busy' } }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent_start');
    expect(events[0].sessionId).toBe(SID);
  });

  it('session.status idle → agent_end', () => {
    const events = adapter.adaptSSEEvent(
      sse('session.status', { sessionID: SID, status: { type: 'idle' } }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent_end');
    expect(events[0].sessionId).toBe(SID);
    const data = events[0].data as Record<string, unknown>;
    expect(data.result).toBeNull();
    expect(data.usage).toEqual({});
  });

  it('session.idle → agent_end', () => {
    const events = adapter.adaptSSEEvent(
      sse('session.idle', { sessionID: SID }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent_end');
    expect(events[0].sessionId).toBe(SID);
    const data = events[0].data as Record<string, unknown>;
    expect(data.result).toBeNull();
    expect(data.usage).toEqual({});
  });

  it('message.updated (assistant, no finish) → message_start', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.updated', {
        sessionID: SID,
        info: { id: 'msg-1', role: 'assistant' },
      }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_start');
    const data = events[0].data as Record<string, unknown>;
    expect(data.id).toBe('msg-1');
    expect(data.role).toBe('assistant');
  });

  it('message.updated (assistant, with finish) → message_end', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.updated', {
        sessionID: SID,
        info: { id: 'msg-1', role: 'assistant', finish: 'stop' },
      }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_end');
    const data = events[0].data as Record<string, unknown>;
    expect(data.id).toBe('msg-1');
  });

  it('message.updated without info → empty', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.updated', {}),
      SID,
    );
    expect(events).toHaveLength(0);
  });

  it('message.part.delta → message_update with text delta', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.delta', {
        sessionID: SID,
        messageID: 'msg-1',
        partID: 'prt-1',
        field: 'text',
        delta: 'Hello',
      }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_update');
    const data = events[0].data as Record<string, unknown>;
    expect(data.id).toBe('msg-1');
    const assistantEvent = data.assistantMessageEvent as { type: string; delta: string };
    expect(assistantEvent.delta).toBe('Hello');
  });

  it('message.part.delta with omitted field → message_update with text delta', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.delta', {
        sessionID: SID,
        messageID: 'msg-1',
        partID: 'prt-1',
        delta: 'Hello without explicit field',
      }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_update');
    const data = events[0].data as Record<string, unknown>;
    const assistantEvent = data.assistantMessageEvent as { type: string; delta: string };
    expect(assistantEvent.delta).toBe('Hello without explicit field');
  });

  it('message.part.updated completed text part → message_update fallback', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-text-1',
          messageID: 'msg-1',
          type: 'text',
          text: 'Completed text body',
          time: { start: 1, end: 2 },
        },
      }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_update');
    const data = events[0].data as Record<string, unknown>;
    expect(data.id).toBe('msg-1');
    const assistantEvent = data.assistantMessageEvent as { type: string; delta: string };
    expect(assistantEvent.delta).toBe('Completed text body');
  });

  it('message.part.delta without delta → empty', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.delta', { messageID: 'msg-1' }),
      SID,
    );
    expect(events).toHaveLength(0);
  });

  it('message.part.delta without messageID → empty', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.delta', { delta: 'Hello' }),
      SID,
    );
    expect(events).toHaveLength(0);
  });

  it('message.part.updated step-start → empty', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {
        sessionID: SID,
        part: { id: 'prt-1', messageID: 'msg-1', type: 'step-start' },
      }),
      SID,
    );
    expect(events).toHaveLength(0);
  });

  it('message.part.updated tool with running state → tool_execution_start', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-tool-running',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'read',
          callID: 'call-read-1',
          state: {
            status: 'running',
            input: { filePath: '/tmp/example.txt' },
          },
        },
      }),
      SID,
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_start');
    const data = events[0].data as Record<string, unknown>;
    expect(data.toolCallId).toBe('call-read-1');
    expect(data.toolName).toBe('read');
    expect(data.input).toEqual({ filePath: '/tmp/example.txt' });
  });

  it('message.part.updated tool with completed state → tool_execution_end', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-tool-complete',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'bash',
          callID: 'call-bash-1',
          state: {
            status: 'completed',
            input: { command: 'pwd' },
            output: '/root/pi-web-ui',
          },
        },
      }),
      SID,
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_end');
    const data = events[0].data as Record<string, unknown>;
    expect(data.toolCallId).toBe('call-bash-1');
    expect(data.isError).toBe(false);
    const result = data.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('/root/pi-web-ui');
  });

  it('message.part.updated tool with error state → errored tool_execution_end', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-tool-error',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'read',
          callID: 'call-read-error',
          state: {
            status: 'error',
            input: { filePath: '/root/secret' },
            error: 'Access denied',
          },
        },
      }),
      SID,
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_end');
    const data = events[0].data as Record<string, unknown>;
    expect(data.toolCallId).toBe('call-read-error');
    expect(data.isError).toBe(true);
    const result = data.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('Access denied');
  });

  it('message.part.updated step-finish with tool reason → tool_execution_end', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-tool-1',
          messageID: 'msg-1',
          type: 'step-finish',
          reason: 'tool',
          snapshot: 'Read file contents',
        },
      }),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_end');
    const data = events[0].data as Record<string, unknown>;
    expect(data.toolCallId).toBe('prt-tool-1');
    expect(data.isError).toBe(false);
    const result = data.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('Read file contents');
  });

  it('step-finish tool extracts result field when available', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-tool-2',
          type: 'step-finish',
          reason: 'tool',
          result: 'the file content',
        },
      }),
      SID,
    );
    const data = events[0].data as Record<string, unknown>;
    const result = data.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('the file content');
  });

  it('step-finish tool extracts result object as JSON', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-tool-3',
          type: 'step-finish',
          reason: 'tool',
          result: { files: ['a.ts', 'b.ts'] },
        },
      }),
      SID,
    );
    const data = events[0].data as Record<string, unknown>;
    const result = data.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('{"files":["a.ts","b.ts"]}');
  });

  it('step-finish tool falls back to empty string when no result or snapshot', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-tool-4',
          type: 'step-finish',
          reason: 'tool',
        },
      }),
      SID,
    );
    const data = events[0].data as Record<string, unknown>;
    const result = data.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('');
  });

  it('message.part.updated step-finish with stop reason → empty', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {
        sessionID: SID,
        part: { id: 'prt-1', messageID: 'msg-1', type: 'step-finish', reason: 'stop' },
      }),
      SID,
    );
    expect(events).toHaveLength(0);
  });

  it('message.part.updated without part → empty', () => {
    const events = adapter.adaptSSEEvent(
      sse('message.part.updated', {}),
      SID,
    );
    expect(events).toHaveLength(0);
  });

  it('unknown event type → empty by default (debug off)', () => {
    const events = adapter.adaptSSEEvent(sse('server.heartbeat', {}), SID);
    expect(events).toHaveLength(0);
  });

  it('unknown event type → opencode_raw when debug enabled', () => {
    const debugAdapter = new OpenCodeEventAdapter(true);
    const events = debugAdapter.adaptSSEEvent(sse('server.heartbeat', {}), SID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('opencode_raw');
  });

  it('full text streaming lifecycle', () => {
    const step1 = adapter.adaptSSEEvent(
      sse('session.status', { sessionID: SID, status: { type: 'busy' } }),
      SID,
    );
    expect(step1[0].type).toBe('agent_start');

    const step2 = adapter.adaptSSEEvent(
      sse('message.updated', { sessionID: SID, info: { id: 'msg-1', role: 'assistant' } }),
      SID,
    );
    expect(step2[0].type).toBe('message_start');

    const step3 = adapter.adaptSSEEvent(
      sse('message.part.delta', { sessionID: SID, messageID: 'msg-1', partID: 'prt-1', field: 'text', delta: 'Hello' }),
      SID,
    );
    expect(step3[0].type).toBe('message_update');

    const step4 = adapter.adaptSSEEvent(
      sse('message.updated', { sessionID: SID, info: { id: 'msg-1', role: 'assistant', finish: 'stop' } }),
      SID,
    );
    expect(step4[0].type).toBe('message_end');

    const step5 = adapter.adaptSSEEvent(
      sse('session.status', { sessionID: SID, status: { type: 'idle' } }),
      SID,
    );
    expect(step5).toHaveLength(1);
    expect(step5[0].type).toBe('agent_end');

    const step6 = adapter.adaptSSEEvent(
      sse('session.idle', { sessionID: SID }),
      SID,
    );
    expect(step6[0].type).toBe('agent_end');
  });

  describe('messageToReplayEvents', () => {
    function makeMsg(overrides: Partial<OpenCodeMessage> & { id?: string; role?: 'user' | 'assistant' }): OpenCodeMessage {
      const id = overrides.id ?? `msg_${Math.random().toString(36).slice(2, 8)}`;
      const role = overrides.role ?? 'user';
      return {
        info: {
          id,
          sessionID: 'ses-test',
          role,
          time: { created: 1735689600000 },
          ...((overrides.info as Record<string, unknown>) ?? {}),
        },
        parts: overrides.parts ?? [],
      };
    }

    it('user message → correct message_start/update/end sequence', () => {
      const msg = makeMsg({
        id: 'msg-user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello assistant', id: 'prt-u1', sessionID: 'ses-test', messageID: 'msg-user-1' }],
      });

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

    it('assistant message with text parts → correct event sequence', () => {
      const msg = makeMsg({
        id: 'msg-asst-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me read that file.', id: 'prt-1', sessionID: 'ses-test', messageID: 'msg-asst-1' },
          { type: 'text', text: 'Here is more text.', id: 'prt-2', sessionID: 'ses-test', messageID: 'msg-asst-1' },
        ],
      });

      const events = adapter.messageToReplayEvents(msg, SID);

      const types = events.map(e => e.type);
      expect(types).toEqual([
        'message_start',
        'message_update',
        'message_end',
        'message_start',
        'message_update',
        'message_end',
      ]);

      const firstStart = events[0].data as Record<string, unknown>;
      expect(firstStart.id).toBe('prt-1');
      expect(firstStart.role).toBe('assistant');

      const secondStart = events[3].data as Record<string, unknown>;
      expect(secondStart.id).toBe('prt-2');
    });

    it('message with empty parts → no events', () => {
      const msg = makeMsg({
        id: 'msg-empty',
        role: 'assistant',
        parts: [],
      });

      const events = adapter.messageToReplayEvents(msg, SID);
      expect(events).toHaveLength(0);
    });

    it('preserves timestamp from info.time.created', () => {
      const msg = makeMsg({
        id: 'msg-ts',
        role: 'user',
        parts: [{ type: 'text', text: 'hi', id: 'prt-ts', sessionID: 'ses-test', messageID: 'msg-ts' }],
      });

      const events = adapter.messageToReplayEvents(msg, SID);
      expect(events[0].timestamp).toBe(1735689600000);
    });
  });

  describe('tool event deduplication', () => {
    it('suppresses duplicate tool_execution_start for same toolCallId', () => {
      const toolEvent = sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-read-1',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'read',
          callID: 'call-read-dup',
          state: { status: 'running', input: { filePath: '/tmp/a.txt' } },
        },
      });

      const first = adapter.adaptSSEEvent(toolEvent, SID);
      expect(first).toHaveLength(1);
      expect(first[0].type).toBe('tool_execution_start');

      const second = adapter.adaptSSEEvent(toolEvent, SID);
      expect(second).toHaveLength(0);

      const third = adapter.adaptSSEEvent(toolEvent, SID);
      expect(third).toHaveLength(0);
    });

    it('emits tool_execution_start once and tool_execution_end once for a full lifecycle', () => {
      const startEvent = sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-read-1',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'read',
          callID: 'call-read-lifecycle',
          state: { status: 'running', input: { filePath: '/tmp/a.txt' } },
        },
      });

      const events1 = adapter.adaptSSEEvent(startEvent, SID);
      expect(events1).toHaveLength(1);
      expect(events1[0].type).toBe('tool_execution_start');

      const duplicateStart = adapter.adaptSSEEvent(startEvent, SID);
      expect(duplicateStart).toHaveLength(0);

      const endEvent = sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-read-1',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'read',
          callID: 'call-read-lifecycle',
          state: { status: 'completed', input: { filePath: '/tmp/a.txt' }, output: 'file content' },
        },
      });

      const events2 = adapter.adaptSSEEvent(endEvent, SID);
      expect(events2).toHaveLength(1);
      expect(events2[0].type).toBe('tool_execution_end');

      const duplicateEnd = adapter.adaptSSEEvent(endEvent, SID);
      expect(duplicateEnd).toHaveLength(0);
    });

    it('deduplicates step-finish tool_execution_end against tool-invocation completion', () => {
      const toolComplete = sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-dedup-1',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'read',
          callID: 'prt-dedup-1',
          state: { status: 'completed', output: 'contents' },
        },
      });

      const events1 = adapter.adaptSSEEvent(toolComplete, SID);
      expect(events1).toHaveLength(1);
      expect(events1[0].type).toBe('tool_execution_end');

      const stepFinish = sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-dedup-1',
          type: 'step-finish',
          reason: 'tool',
          snapshot: 'contents',
        },
      });

      const events2 = adapter.adaptSSEEvent(stepFinish, SID);
      expect(events2).toHaveLength(0);
    });

    it('allows different toolCallIds to emit independently', () => {
      const tool1 = sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-1',
          type: 'tool',
          tool: 'read',
          callID: 'call-1',
          state: { status: 'running', input: { filePath: '/a.txt' } },
        },
      });

      const tool2 = sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-2',
          type: 'tool',
          tool: 'bash',
          callID: 'call-2',
          state: { status: 'running', input: { command: 'ls' } },
        },
      });

      const e1 = adapter.adaptSSEEvent(tool1, SID);
      const e2 = adapter.adaptSSEEvent(tool2, SID);
      expect(e1).toHaveLength(1);
      expect(e2).toHaveLength(1);
      expect((e1[0].data as Record<string, unknown>).toolCallId).toBe('call-1');
      expect((e2[0].data as Record<string, unknown>).toolCallId).toBe('call-2');
    });

    it('reset clears dedup state so same toolCallId can emit again', () => {
      const toolEvent = sse('message.part.updated', {
        sessionID: SID,
        part: {
          id: 'prt-1',
          type: 'tool',
          tool: 'read',
          callID: 'call-reset-test',
          state: { status: 'running', input: { filePath: '/a.txt' } },
        },
      });

      const e1 = adapter.adaptSSEEvent(toolEvent, SID);
      expect(e1).toHaveLength(1);

      const e2 = adapter.adaptSSEEvent(toolEvent, SID);
      expect(e2).toHaveLength(0);

      adapter.reset();

      const e3 = adapter.adaptSSEEvent(toolEvent, SID);
      expect(e3).toHaveLength(1);
    });
  });

  describe('reset', () => {
    it('clears internal session state', () => {
      adapter.adaptSSEEvent(
        sse('message.updated', { sessionID: SID, info: { id: 'msg-1', role: 'assistant' } }),
        SID,
      );

      adapter.reset();

      const fresh = new OpenCodeEventAdapter();
      expect(adapter).toBeInstanceOf(OpenCodeEventAdapter);
      expect(fresh).toBeInstanceOf(OpenCodeEventAdapter);
    });
  });
});
