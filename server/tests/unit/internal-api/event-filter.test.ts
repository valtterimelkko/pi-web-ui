/**
 * Tests for Internal API Event Filter
 *
 * Covers:
 * - Event collection for verbosity=answers
 * - Task event emission for verbosity=tasks
 * - Full event passthrough for verbosity=full
 * - Tool summary generation
 */

import { describe, it, expect } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import {
  createEventCollector,
  collectAnswerEvent,
  writeTaskEvent,
  writeFullEvent,
  type SSEWriter,
  type EventCollector,
} from '../../../src/internal-api/event-filter.js';

// Helper to capture SSE writes
function captureSSE(): { events: Array<{ type: string; data: unknown }>; writer: SSEWriter } {
  const events: Array<{ type: string; data: unknown }> = [];
  return {
    events,
    writer: (eventType: string, data: unknown) => {
      events.push({ type: eventType, data });
    },
  };
}

function makeEvent(type: string, data: unknown = {}): NormalizedEvent {
  return { type, sessionId: 'test-session', timestamp: Date.now(), data };
}

// ─── verbosity=answers: collectAnswerEvent ─────────────────────────────────

describe('collectAnswerEvent (verbosity=answers)', () => {
  it('collects text from message_update events', () => {
    const collector = createEventCollector();
    const event = makeEvent('message_update', {
      id: 'msg_1',
      assistantMessageEvent: {
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world!' },
        ],
      },
    });

    collectAnswerEvent(collector, event);
    expect(collector.textParts).toEqual(['Hello ', 'world!']);
  });

  it('skips thinking blocks in message_update', () => {
    const collector = createEventCollector();
    const event = makeEvent('message_update', {
      id: 'msg_1',
      assistantMessageEvent: {
        content: [
          { type: 'thinking', thinking: 'Let me think about this...' },
          { type: 'text', text: 'The answer is 42.' },
        ],
      },
    });

    collectAnswerEvent(collector, event);
    expect(collector.textParts).toEqual(['The answer is 42.']);
  });

  it('collects message ID from message_end', () => {
    const collector = createEventCollector();
    const event = makeEvent('message_end', { id: 'msg_final' });

    collectAnswerEvent(collector, event);
    expect(collector.lastMessageId).toBe('msg_final');
  });

  it('marks complete and extracts usage from agent_end', () => {
    const collector = createEventCollector();
    const event = makeEvent('agent_end', {
      result: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    collectAnswerEvent(collector, event);
    expect(collector.complete).toBe(true);
    expect(collector.usage).toEqual({ input: 100, output: 50, total: 150 });
  });

  it('ignores tool, agent_start, turn, and other events', () => {
    const collector = createEventCollector();

    collectAnswerEvent(collector, makeEvent('tool_execution_start'));
    collectAnswerEvent(collector, makeEvent('tool_execution_end'));
    collectAnswerEvent(collector, makeEvent('agent_start'));
    collectAnswerEvent(collector, makeEvent('turn_start'));
    collectAnswerEvent(collector, makeEvent('turn_end'));
    collectAnswerEvent(collector, makeEvent('auto_compaction_start'));

    expect(collector.textParts).toEqual([]);
    expect(collector.complete).toBe(false);
  });

  it('joins multiple text parts in order', () => {
    const collector = createEventCollector();

    collectAnswerEvent(collector, makeEvent('message_update', {
      assistantMessageEvent: { content: [{ type: 'text', text: 'First. ' }] },
    }));
    collectAnswerEvent(collector, makeEvent('message_update', {
      assistantMessageEvent: { content: [{ type: 'text', text: 'Second. ' }] },
    }));
    collectAnswerEvent(collector, makeEvent('message_update', {
      assistantMessageEvent: { content: [{ type: 'text', text: 'Third.' }] },
    }));

    expect(collector.textParts.join('')).toBe('First. Second. Third.');
  });
});

// ─── verbosity=tasks: writeTaskEvent ──────────────────────────────────────

describe('writeTaskEvent (verbosity=tasks)', () => {
  it('emits task_status for tool_execution_start with human-readable summary', () => {
    const { events, writer } = captureSSE();

    writeTaskEvent(writer, makeEvent('tool_execution_start', {
      toolCallId: 'tc_1',
      toolName: 'Bash',
      args: { command: 'npm install' },
    }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task_status');
    expect(events[0].data).toMatchObject({
      type: 'task_status',
      toolName: 'Bash',
      summary: expect.stringContaining('npm install'),
    });
  });

  it('emits task_status for Read tool with filename', () => {
    const { events, writer } = captureSSE();

    writeTaskEvent(writer, makeEvent('tool_execution_start', {
      toolCallId: 'tc_2',
      toolName: 'Read',
      args: { file_path: '/home/user/config.json' },
    }));

    expect(events[0].type).toBe('task_status');
    expect((events[0].data as Record<string, unknown>).summary).toContain('config.json');
  });

  it('emits text from message_update events', () => {
    const { events, writer } = captureSSE();

    writeTaskEvent(writer, makeEvent('message_update', {
      id: 'msg_1',
      assistantMessageEvent: {
        content: [{ type: 'text', text: 'Here is the result.' }],
      },
    }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_update');
    expect((events[0].data as Record<string, unknown>).text).toBe('Here is the result.');
  });

  it('skips thinking blocks in tasks mode', () => {
    const { events, writer } = captureSSE();

    writeTaskEvent(writer, makeEvent('message_update', {
      id: 'msg_1',
      assistantMessageEvent: {
        content: [
          { type: 'thinking', thinking: 'hidden thought' },
          { type: 'text', text: 'visible text' },
        ],
      },
    }));

    // Only the text block should be emitted
    expect(events).toHaveLength(1);
    expect((events[0].data as Record<string, unknown>).text).toBe('visible text');
  });

  it('forwards message_start, message_end, agent_start, agent_end', () => {
    const { events, writer } = captureSSE();

    writeTaskEvent(writer, makeEvent('agent_start'));
    writeTaskEvent(writer, makeEvent('message_start', { id: 'm1', role: 'assistant' }));
    writeTaskEvent(writer, makeEvent('message_end', { id: 'm1' }));
    writeTaskEvent(writer, makeEvent('agent_end', { usage: {} }));

    expect(events).toHaveLength(4);
    expect(events.map(e => e.type)).toEqual([
      'agent_start',
      'message_start',
      'message_end',
      'agent_end',
    ]);
  });

  it('emits error events', () => {
    const { events, writer } = captureSSE();

    writeTaskEvent(writer, makeEvent('api_error', { message: 'Rate limit hit' }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  it('generates summary for subagent tool', () => {
    const { events, writer } = captureSSE();

    writeTaskEvent(writer, makeEvent('tool_execution_start', {
      toolCallId: 'tc_3',
      toolName: 'Task',
      args: { subagent_type: 'architect' },
    }));

    expect((events[0].data as Record<string, unknown>).summary).toContain('architect');
  });

  it('generates summary for unknown tool', () => {
    const { events, writer } = captureSSE();

    writeTaskEvent(writer, makeEvent('tool_execution_start', {
      toolCallId: 'tc_4',
      toolName: 'CustomTool',
      args: {},
    }));

    expect((events[0].data as Record<string, unknown>).summary).toBe('Running CustomTool…');
  });

  it('drops tool_execution_end and tool_execution_update silently', () => {
    const { events, writer } = captureSSE();

    writeTaskEvent(writer, makeEvent('tool_execution_end', { toolCallId: 'tc_1', result: 'output' }));
    writeTaskEvent(writer, makeEvent('tool_execution_update', { toolCallId: 'tc_1', partialResult: 'partial' }));

    expect(events).toHaveLength(0);
  });
});

// ─── verbosity=full: writeFullEvent ───────────────────────────────────────

describe('writeFullEvent (verbosity=full)', () => {
  it('forwards all events unchanged', () => {
    const { events, writer } = captureSSE();

    const evt = makeEvent('tool_execution_start', { toolCallId: 'tc_1', toolName: 'Bash', args: { command: 'ls' } });
    writeFullEvent(writer, evt);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_start');
    expect(events[0].data).toEqual(evt);
  });

  it('forwards tool_execution_end with full data', () => {
    const { events, writer } = captureSSE();

    const evt = makeEvent('tool_execution_end', {
      toolCallId: 'tc_1',
      toolName: 'Bash',
      result: 'file1.txt\nfile2.txt',
      isError: false,
    });
    writeFullEvent(writer, evt);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_end');
    expect(events[0].data).toEqual(evt);
  });
});

// ─── EventCollector lifecycle ──────────────────────────────────────────────

describe('EventCollector', () => {
  it('starts with empty state', () => {
    const collector = createEventCollector();
    expect(collector.textParts).toEqual([]);
    expect(collector.complete).toBe(false);
    expect(collector.usage).toBeUndefined();
    expect(collector.error).toBeUndefined();
  });

  it('collects text from multiple messages', () => {
    const collector = createEventCollector();

    // Simulate a real turn: multiple message_start/update/end cycles
    collectAnswerEvent(collector, makeEvent('message_update', {
      assistantMessageEvent: { content: [{ type: 'text', text: 'Let me check...' }] },
    }));
    // ... tool calls happen (filtered) ...
    collectAnswerEvent(collector, makeEvent('message_update', {
      assistantMessageEvent: { content: [{ type: 'text', text: ' The answer is 42.' }] },
    }));
    collectAnswerEvent(collector, makeEvent('message_end', { id: 'msg_2' }));
    collectAnswerEvent(collector, makeEvent('agent_end', { usage: { input_tokens: 200, output_tokens: 60 } }));

    expect(collector.textParts.join('')).toBe('Let me check... The answer is 42.');
    expect(collector.lastMessageId).toBe('msg_2');
    expect(collector.complete).toBe(true);
    expect(collector.usage).toEqual({ input: 200, output: 60, total: 260 });
  });
});
