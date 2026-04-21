import { describe, it, expect } from 'vitest';
import { opencodeMessagesToReplayEvents } from '../../../src/opencode/opencode-history-replay.js';
import type { OpenCodeMessage } from '../../../src/opencode/opencode-types.js';

const PI_SESSION_ID = 'pi-test-session';

function makeMessage(overrides: Partial<OpenCodeMessage>): OpenCodeMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    parts: [],
    createdAt: '2024-01-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('opencodeMessagesToReplayEvents', () => {
  it('empty messages array → empty events array', () => {
    const events = opencodeMessagesToReplayEvents([], PI_SESSION_ID);
    expect(events).toEqual([]);
  });

  it('single user message → message_start + message_end with correct content', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage({
        id: 'msg_user1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello assistant!' }],
      }),
    ];

    const events = opencodeMessagesToReplayEvents(messages, PI_SESSION_ID);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('message_start');
    expect(events[1].type).toBe('message_end');

    const startMsg = events[0].message as { id: string; role: string; content: string };
    expect(startMsg.role).toBe('user');
    expect(startMsg.content).toBe('Hello assistant!');
    expect(startMsg.id).toBe('msg_user1');
  });

  it('single assistant message with text part → message_start + message_update + message_end', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage({
        id: 'msg_asst1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'I can help with that!' }],
      }),
    ];

    const events = opencodeMessagesToReplayEvents(messages, PI_SESSION_ID);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('message_start');
    expect(events[1].type).toBe('message_update');
    expect(events[2].type).toBe('message_end');

    const startMsg = events[0].message as { role: string };
    expect(startMsg.role).toBe('assistant');

    const updateEvent = events[1] as Record<string, unknown>;
    const assistantEvent = updateEvent.assistantMessageEvent as { type: string; delta: string };
    expect(assistantEvent.type).toBe('text_delta');
    expect(assistantEvent.delta).toBe('I can help with that!');
  });

  it('assistant message with text + tool parts → correct event sequence', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage({
        id: 'msg_mixed',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me read that file.' },
          {
            type: 'tool-invocation',
            toolInvocationId: 'tool_call_1',
            toolName: 'Read',
            args: { file_path: '/tmp/test.txt' },
          },
        ],
      }),
    ];

    const events = opencodeMessagesToReplayEvents(messages, PI_SESSION_ID);
    const types = events.map(e => e.type);

    expect(types).toEqual([
      'message_start',
      'message_update',
      'message_end',
      'tool_execution_start',
    ]);

    const toolStart = events[3] as Record<string, unknown>;
    expect(toolStart.toolName).toBe('Read');
    expect(toolStart.toolCallId).toBe('tool_call_1');
    expect(toolStart.args).toEqual({ file_path: '/tmp/test.txt' });
  });

  it('assistant message with tool-invocation that has result → tool_execution_start + tool_execution_end', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage({
        id: 'msg_tool_result',
        role: 'assistant',
        parts: [
          {
            type: 'tool-invocation',
            toolInvocationId: 'tool_call_2',
            toolName: 'Bash',
            args: { command: 'ls' },
            result: 'file1.txt\nfile2.txt',
          },
        ],
      }),
    ];

    const events = opencodeMessagesToReplayEvents(messages, PI_SESSION_ID);
    const types = events.map(e => e.type);

    expect(types).toEqual(['tool_execution_start', 'tool_execution_end']);

    const endEvent = events[1] as Record<string, unknown>;
    expect(endEvent.toolCallId).toBe('tool_call_2');
    const result = endEvent.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('file1.txt\nfile2.txt');
    expect(endEvent.isError).toBe(false);
  });

  it('tool-invocation with object result → serializes to JSON', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage({
        id: 'msg_obj_result',
        role: 'assistant',
        parts: [
          {
            type: 'tool-invocation',
            toolInvocationId: 'tool_obj',
            toolName: 'Grep',
            args: { pattern: 'TODO' },
            result: { matches: 3, files: ['a.ts', 'b.ts'] },
          },
        ],
      }),
    ];

    const events = opencodeMessagesToReplayEvents(messages, PI_SESSION_ID);
    const endEvent = events[1] as Record<string, unknown>;
    const result = endEvent.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('{"matches":3,"files":["a.ts","b.ts"]}');
  });

  it('multiple messages → events in correct order', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage({
        id: 'msg_u1',
        role: 'user',
        parts: [{ type: 'text', text: 'Read the file' }],
      }),
      makeMessage({
        id: 'msg_a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Here is the file content.' },
          {
            type: 'tool-invocation',
            toolInvocationId: 'tc_1',
            toolName: 'Read',
            args: { file_path: '/tmp/x.txt' },
            result: 'hello world',
          },
        ],
      }),
      makeMessage({
        id: 'msg_u2',
        role: 'user',
        parts: [{ type: 'text', text: 'Thanks!' }],
      }),
    ];

    const events = opencodeMessagesToReplayEvents(messages, PI_SESSION_ID);
    const types = events.map(e => e.type);

    expect(types).toEqual([
      'message_start',
      'message_end',
      'message_start',
      'message_update',
      'message_end',
      'tool_execution_start',
      'tool_execution_end',
      'message_start',
      'message_end',
    ]);
  });

  it('parts are emitted in the order they appear in the message', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage({
        id: 'msg_order',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'First text.' },
          {
            type: 'tool-invocation',
            toolInvocationId: 'tc_order_1',
            toolName: 'Bash',
            args: { command: 'echo hi' },
            result: 'hi',
          },
          { type: 'text', text: 'Second text.' },
        ],
      }),
    ];

    const events = opencodeMessagesToReplayEvents(messages, PI_SESSION_ID);
    const types = events.map(e => e.type);

    expect(types).toEqual([
      'message_start',
      'message_update',
      'message_end',
      'tool_execution_start',
      'tool_execution_end',
      'message_start',
      'message_update',
      'message_end',
    ]);

    const firstTextUpdate = events[1] as Record<string, unknown>;
    const firstDelta = (firstTextUpdate.assistantMessageEvent as { delta: string }).delta;
    expect(firstDelta).toBe('First text.');

    const secondTextUpdate = events[6] as Record<string, unknown>;
    const secondDelta = (secondTextUpdate.assistantMessageEvent as { delta: string }).delta;
    expect(secondDelta).toBe('Second text.');
  });
});
