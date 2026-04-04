import { describe, it, expect } from 'vitest';
import {
  claudeEntryToEvent,
  historyToReplayEvents,
} from '../../../src/claude/claude-history-replay.js';
import type { ClaudeMessageEntry } from '../../../src/claude/claude-session-store.js';

const SESSION_ID = 'test-session';
const TS = 1700000000000;

function makeEntry(overrides: Partial<ClaudeMessageEntry>): ClaudeMessageEntry {
  return {
    type: 'meta',
    sessionId: SESSION_ID,
    timestamp: TS,
    ...overrides,
  };
}

describe('claudeEntryToEvent', () => {
  // ─── meta entry ──────────────────────────────────────────────────────────

  it('meta entry → session_init event', () => {
    const entry = makeEntry({
      type: 'meta',
      model: 'claude-opus-4',
      cwd: '/home/user',
      claudeSessionId: 'claude-abc',
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_init');
    expect(events[0]).toMatchObject({
      model: 'claude-opus-4',
      cwd: '/home/user',
      claudeSessionId: 'claude-abc',
      timestamp: TS,
    });
  });

  // ─── user entry ──────────────────────────────────────────────────────────

  it('user entry → message_start + message_end events', () => {
    const entry = makeEntry({
      type: 'user',
      content: 'Hello Claude!',
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('message_start');
    expect(events[1].type).toBe('message_end');

    const startMsg = (events[0] as Record<string, unknown>).message as {
      role: string;
      content: string;
    };
    expect(startMsg.role).toBe('user');
    expect(startMsg.content).toBe('Hello Claude!');
  });

  // ─── assistant entry ──────────────────────────────────────────────────────

  it('assistant entry → message_start + message_update + message_end events', () => {
    const entry = makeEntry({
      type: 'assistant',
      content: 'I can help with that!',
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('message_start');
    expect(events[1].type).toBe('message_update');
    expect(events[2].type).toBe('message_end');

    const updateEvent = events[1] as Record<string, unknown>;
    const assistantMsgEvent = updateEvent.assistantMessageEvent as {
      type: string;
      delta: string;
    };
    expect(assistantMsgEvent.type).toBe('text_delta');
    expect(assistantMsgEvent.delta).toBe('I can help with that!');
  });

  it('assistant entry without content → message_start + message_end (no update)', () => {
    const entry = makeEntry({
      type: 'assistant',
      content: undefined,
    });

    const events = claudeEntryToEvent(entry);
    // No content → no message_update
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('message_start');
    expect(events[1].type).toBe('message_end');
  });

  // ─── tool entry ──────────────────────────────────────────────────────────

  it('tool entry → tool_execution_start + tool_execution_end events', () => {
    const entry = makeEntry({
      type: 'tool',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test.txt' },
      toolOutput: 'file contents here',
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('tool_execution_start');
    expect(events[1].type).toBe('tool_execution_end');

    const startEvent = events[0] as Record<string, unknown>;
    expect(startEvent.toolName).toBe('Read');
    expect(startEvent.args).toEqual({ file_path: '/tmp/test.txt' });

    const endEvent = events[1] as Record<string, unknown>;
    const result = endEvent.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('file contents here');
    expect(endEvent.isError).toBe(false);
  });

  it('tool entry without toolOutput → only tool_execution_start', () => {
    const entry = makeEntry({
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolOutput: undefined,
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_start');
  });
});

// ─── historyToReplayEvents ────────────────────────────────────────────────────

describe('historyToReplayEvents', () => {
  it('empty history → empty array', () => {
    const events = historyToReplayEvents([]);
    expect(events).toEqual([]);
  });

  it('full history array produces correct ordered sequence', () => {
    const entries: ClaudeMessageEntry[] = [
      makeEntry({ type: 'meta', model: 'opus', cwd: '/cwd', claudeSessionId: 'c-abc' }),
      makeEntry({ type: 'user', content: 'hi', timestamp: TS + 1 }),
      makeEntry({
        type: 'tool',
        toolName: 'Read',
        toolInput: { file_path: '/f' },
        toolOutput: 'content',
        timestamp: TS + 2,
      }),
      makeEntry({ type: 'assistant', content: 'The file says: content', timestamp: TS + 3 }),
    ];

    const events = historyToReplayEvents(entries);
    const types = events.map((e) => e.type);

    // meta → session_init
    expect(types[0]).toBe('session_init');
    // user → message_start, message_end
    expect(types[1]).toBe('message_start');
    expect(types[2]).toBe('message_end');
    // tool → tool_execution_start, tool_execution_end
    expect(types[3]).toBe('tool_execution_start');
    expect(types[4]).toBe('tool_execution_end');
    // assistant → message_start, message_update, message_end
    expect(types[5]).toBe('message_start');
    expect(types[6]).toBe('message_update');
    expect(types[7]).toBe('message_end');

    expect(events).toHaveLength(8);
  });
});
