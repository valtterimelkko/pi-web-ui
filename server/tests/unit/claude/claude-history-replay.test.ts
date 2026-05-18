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

  it('assistant entry → empty (handled by coalescing in historyToReplayEvents)', () => {
    // Individual assistant entries are NOT emitted by claudeEntryToEvent.
    // They are coalesced into single messages by historyToReplayEvents.
    const entry = makeEntry({
      type: 'assistant',
      content: 'I can help with that!',
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(0);
  });

  it('assistant entry without content → empty', () => {
    const entry = makeEntry({
      type: 'assistant',
      content: undefined,
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(0);
  });

  it('error entry → error event', () => {
    const entry = makeEntry({
      type: 'error',
      content: 'Claude Code authentication expired. Please run /login.',
      code: 'CLAUDE_AUTH_EXPIRED',
      reauthRequired: true,
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      message: 'Claude Code authentication expired. Please run /login.',
      code: 'CLAUDE_AUTH_EXPIRED',
      reauthRequired: true,
    });
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

  it('tool entry with stored toolCallId → uses it as toolCallId', () => {
    const entry = makeEntry({
      type: 'tool',
      toolName: 'Read',
      toolCallId: 'toolu_abc123',
      toolInput: { file_path: '/tmp/test.txt' },
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).toolCallId).toBe('toolu_abc123');
  });

  it('tool entry without toolCallId → generates toolCallId from timestamp', () => {
    const entry = makeEntry({
      type: 'tool',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test.txt' },
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).toolCallId).toBe(`tool_${TS}`);
  });

  // ─── tool_result entry ────────────────────────────────────────────────────

  it('tool_result entry → tool_execution_end event', () => {
    const entry = makeEntry({
      type: 'tool_result',
      toolCallId: 'toolu_abc123',
      toolOutput: 'command output here',
      isError: false,
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_end');

    const endEvent = events[0] as Record<string, unknown>;
    expect(endEvent.toolCallId).toBe('toolu_abc123');
    const result = endEvent.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('command output here');
    expect(endEvent.isError).toBe(false);
  });

  it('tool_result entry with isError → tool_execution_end with error flag', () => {
    const entry = makeEntry({
      type: 'tool_result',
      toolCallId: 'toolu_err',
      toolOutput: 'command failed',
      isError: true,
    });

    const events = claudeEntryToEvent(entry);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_end');
    expect((events[0] as Record<string, unknown>).isError).toBe(true);
  });

  it('tool_result entry without toolCallId → generates from timestamp', () => {
    const entry = makeEntry({
      type: 'tool_result',
      toolOutput: 'output',
    });

    const events = claudeEntryToEvent(entry);
    expect((events[0] as Record<string, unknown>).toolCallId).toBe(`tool_${TS}`);
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

  it('coalesces consecutive assistant entries into a single message', () => {
    const entries: ClaudeMessageEntry[] = [
      makeEntry({ type: 'assistant', content: 'Hello ', timestamp: TS + 1 }),
      makeEntry({ type: 'assistant', content: 'World', timestamp: TS + 2 }),
      makeEntry({ type: 'assistant', content: '!', timestamp: TS + 3 }),
    ];

    const events = historyToReplayEvents(entries);
    const types = events.map((e) => e.type);

    // Should produce exactly one message: start + update + end
    expect(types).toEqual(['message_start', 'message_update', 'message_end']);

    // The text_delta should contain all three parts joined
    const updateEvent = events[1] as Record<string, unknown>;
    const assistantMsgEvent = updateEvent.assistantMessageEvent as { type: string; delta: string };
    expect(assistantMsgEvent.delta).toBe('Hello World!');
  });

  it('separates non-consecutive assistant entries into separate messages', () => {
    const entries: ClaudeMessageEntry[] = [
      makeEntry({ type: 'assistant', content: 'First response', timestamp: TS + 1 }),
      makeEntry({ type: 'tool', toolName: 'Read', toolInput: {}, timestamp: TS + 2 }),
      makeEntry({ type: 'assistant', content: 'Second response', timestamp: TS + 3 }),
    ];

    const events = historyToReplayEvents(entries);
    const types = events.map((e) => e.type);

    // First assistant: start + update + end
    // Tool: start
    // Second assistant: start + update + end
    expect(types).toEqual([
      'message_start', 'message_update', 'message_end',
      'tool_execution_start',
      'message_start', 'message_update', 'message_end',
    ]);
  });

  it('does not coalesce assistant replies across a persisted error entry', () => {
    const entries: ClaudeMessageEntry[] = [
      makeEntry({ type: 'assistant', content: 'Before error', timestamp: TS + 1 }),
      makeEntry({ type: 'error', content: 'Timed out', code: 'CLAUDE_PROMPT_TIMEOUT', timestamp: TS + 2 }),
      makeEntry({ type: 'assistant', content: 'Late answer', timestamp: TS + 3 }),
    ];

    const events = historyToReplayEvents(entries);
    const types = events.map((e) => e.type);

    expect(types).toEqual([
      'message_start', 'message_update', 'message_end',
      'error',
      'message_start', 'message_update', 'message_end',
    ]);
  });

  it('tool + tool_result entries produce start and end with matching IDs', () => {
    const entries: ClaudeMessageEntry[] = [
      makeEntry({
        type: 'tool',
        toolName: 'Bash',
        toolCallId: 'toolu_xyz',
        toolInput: { command: 'ls' },
        timestamp: TS + 1,
      }),
      makeEntry({
        type: 'tool_result',
        toolCallId: 'toolu_xyz',
        toolOutput: 'file1.txt\nfile2.txt',
        isError: false,
        timestamp: TS + 2,
      }),
    ];

    const events = historyToReplayEvents(entries);
    const types = events.map((e) => e.type);

    expect(types).toEqual(['tool_execution_start', 'tool_execution_end']);

    // Both events should reference the same toolCallId
    expect((events[0] as Record<string, unknown>).toolCallId).toBe('toolu_xyz');
    expect((events[1] as Record<string, unknown>).toolCallId).toBe('toolu_xyz');
  });

  it('tool without matching tool_result → only tool_execution_start (pending)', () => {
    // Legacy behavior: tools without results show as "Running"
    const entries: ClaudeMessageEntry[] = [
      makeEntry({
        type: 'tool',
        toolName: 'Bash',
        toolCallId: 'toolu_pending',
        toolInput: { command: 'ls' },
        timestamp: TS + 1,
      }),
    ];

    const events = historyToReplayEvents(entries);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_execution_start');
  });

  it('handles mixed assistant deltas and tool calls correctly', () => {
    const entries: ClaudeMessageEntry[] = [
      makeEntry({ type: 'assistant', content: 'Let me read ', timestamp: TS + 1 }),
      makeEntry({ type: 'assistant', content: 'that file.', timestamp: TS + 2 }),
      makeEntry({
        type: 'tool',
        toolName: 'Read',
        toolCallId: 'toolu_1',
        toolInput: { file_path: '/a.txt' },
        timestamp: TS + 3,
      }),
      makeEntry({
        type: 'tool_result',
        toolCallId: 'toolu_1',
        toolOutput: 'file A content',
        timestamp: TS + 4,
      }),
      makeEntry({ type: 'assistant', content: 'The file contains A.', timestamp: TS + 5 }),
    ];

    const events = historyToReplayEvents(entries);
    const types = events.map((e) => e.type);

    expect(types).toEqual([
      'message_start', 'message_update', 'message_end',  // coalesced "Let me read that file."
      'tool_execution_start',                              // Read /a.txt
      'tool_execution_end',                                // result
      'message_start', 'message_update', 'message_end',  // "The file contains A."
    ]);
  });
});
