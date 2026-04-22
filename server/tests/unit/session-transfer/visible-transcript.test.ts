import { describe, it, expect } from 'vitest';
import { replayEventsToVisibleItems, applyScope, buildVisibleTranscript } from '../../../src/session-transfer/visible-transcript.js';
import type { VisibleTranscriptItem, VisibleTranscriptSource, TransferScope } from '../../../src/session-transfer/types.js';

const TS = 1700000000000;

function makeSource(overrides: Partial<VisibleTranscriptSource> = {}): VisibleTranscriptSource {
  return {
    sessionId: 'src-1',
    displayName: 'Test Session',
    sdkType: 'pi',
    cwd: '/home/user/project',
    ...overrides,
  };
}

describe('replayEventsToVisibleItems', () => {
  it('extracts user messages from message_start with content', () => {
    const events = [
      { type: 'message_start', message: { id: 'u1', role: 'user', content: 'Hello' }, timestamp: TS },
      { type: 'message_end', message: { id: 'u1' } },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ kind: 'user', text: 'Hello', timestamp: TS });
  });

  it('extracts assistant messages from message_start + message_update + message_end', () => {
    const events = [
      { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: TS },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'Hi ' } },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'there' } },
      { type: 'message_end', message: { id: 'a1' } },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ kind: 'assistant', text: 'Hi there', timestamp: TS });
  });

  it('includes visible tool calls with truncated results', () => {
    const longResult = 'x'.repeat(300);
    const events = [
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { filePath: '/foo.ts' }, timestamp: TS },
      { type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: longResult }] }, isError: false },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('tool');
    expect(items[0].toolName).toBe('read');
    expect(items[0].toolPrimaryArg).toBe('/foo.ts');
    expect(items[0].text!.length).toBeLessThan(300);
    expect(items[0].text).toContain('...');
  });

  it('excludes invisible tool calls', () => {
    const events = [
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'internal_approval', args: {}, timestamp: TS },
      { type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: 'approved' }] }, isError: false },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(0);
  });

  it('transforms skill content in user messages', () => {
    const events = [
      { type: 'message_start', message: { id: 'u1', role: 'user', content: '<skill name="my-skill">big content</skill>' }, timestamp: TS },
      { type: 'message_end', message: { id: 'u1' } },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain('Skill loaded: my-skill');
    expect(items[0].text).not.toContain('big content');
  });

  it('handles mixed user, assistant, and tool events in order', () => {
    const events = [
      { type: 'message_start', message: { id: 'u1', role: 'user', content: 'Read foo.ts' }, timestamp: TS },
      { type: 'message_end', message: { id: 'u1' } },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { filePath: 'foo.ts' }, timestamp: TS + 1 },
      { type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: 'file contents' }] }, isError: false },
      { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: TS + 2 },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'Here is the file.' } },
      { type: 'message_end', message: { id: 'a1' } },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(3);
    expect(items[0].kind).toBe('user');
    expect(items[1].kind).toBe('tool');
    expect(items[2].kind).toBe('assistant');
  });

  it('skips system messages', () => {
    const events = [
      { type: 'message_start', message: { id: 's1', role: 'system', content: 'init' }, timestamp: TS },
      { type: 'message_end', message: { id: 's1' } },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(0);
  });

  it('skips agent_start, agent_end, session_init events', () => {
    const events = [
      { type: 'agent_start' },
      { type: 'session_init', model: 'foo' },
      { type: 'agent_end', result: {} },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(0);
  });

  it('handles tool result as plain string', () => {
    const events = [
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'echo hi' }, timestamp: TS },
      { type: 'tool_execution_end', toolCallId: 't1', result: 'hi\n', isError: false },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('hi\n');
  });

  it('handles tool with no matching start', () => {
    const events = [
      { type: 'tool_execution_end', toolCallId: 't1', result: 'x', isError: false },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(0);
  });

  it('handles message with no matching start', () => {
    const events = [
      { type: 'message_update', message: { id: 'unknown' }, assistantMessageEvent: { type: 'text_delta', delta: 'orphan' } },
      { type: 'message_end', message: { id: 'unknown' } },
    ];

    const items = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(items).toHaveLength(0);
  });

  it('is deterministic: same input always yields same output', () => {
    const events = [
      { type: 'message_start', message: { id: 'u1', role: 'user', content: 'test' }, timestamp: TS },
      { type: 'message_end', message: { id: 'u1' } },
      { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: TS + 1 },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'reply' } },
      { type: 'message_end', message: { id: 'a1' } },
    ];

    const run1 = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    const run2 = replayEventsToVisibleItems(events as Array<Record<string, unknown>>);
    expect(run1).toEqual(run2);
  });
});

describe('applyScope', () => {
  it('returns all items for visible_full', () => {
    const items = Array.from({ length: 50 }, (_, i): VisibleTranscriptItem => ({
      kind: 'user',
      text: `msg ${i}`,
    }));
    const result = applyScope(items, 'visible_full');
    expect(result).toHaveLength(50);
  });

  it('returns last 20 items for visible_recent when more than 20', () => {
    const items = Array.from({ length: 50 }, (_, i): VisibleTranscriptItem => ({
      kind: 'user',
      text: `msg ${i}`,
    }));
    const result = applyScope(items, 'visible_recent');
    expect(result).toHaveLength(20);
    expect(result[0].text).toBe('msg 30');
    expect(result[19].text).toBe('msg 49');
  });

  it('returns all items for visible_recent when 20 or fewer', () => {
    const items = Array.from({ length: 15 }, (_, i): VisibleTranscriptItem => ({
      kind: 'user',
      text: `msg ${i}`,
    }));
    const result = applyScope(items, 'visible_recent');
    expect(result).toHaveLength(15);
  });
});

describe('buildVisibleTranscript', () => {
  it('builds full transcript', () => {
    const items: VisibleTranscriptItem[] = [
      { kind: 'user', text: 'Hello', timestamp: TS },
      { kind: 'assistant', text: 'Hi', timestamp: TS + 1 },
    ];

    const transcript = buildVisibleTranscript(items, makeSource(), 'visible_full');

    expect(transcript.scope).toBe('visible_full');
    expect(transcript.itemCount).toBe(2);
    expect(transcript.truncated).toBe(false);
    expect(transcript.items).toHaveLength(2);
    expect(transcript.source.displayName).toBe('Test Session');
  });

  it('marks truncated when recent scope cuts items', () => {
    const items = Array.from({ length: 50 }, (_, i): VisibleTranscriptItem => ({
      kind: 'user',
      text: `msg ${i}`,
    }));

    const transcript = buildVisibleTranscript(items, makeSource(), 'visible_recent');

    expect(transcript.truncated).toBe(true);
    expect(transcript.itemCount).toBe(20);
  });

  it('does not mark truncated when recent scope does not cut', () => {
    const items: VisibleTranscriptItem[] = [
      { kind: 'user', text: 'Hello' },
      { kind: 'assistant', text: 'Hi' },
    ];

    const transcript = buildVisibleTranscript(items, makeSource(), 'visible_recent');

    expect(transcript.truncated).toBe(false);
    expect(transcript.itemCount).toBe(2);
  });
});
