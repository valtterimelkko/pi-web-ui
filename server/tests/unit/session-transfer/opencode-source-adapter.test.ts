import { describe, it, expect } from 'vitest';
import { extractOpenCodeTranscript } from '../../../src/session-transfer/opencode-source-adapter.js';
import type { VisibleTranscriptSource } from '../../../src/session-transfer/types.js';

const TS = 1700000000000;

function makeSource(): VisibleTranscriptSource {
  return {
    sessionId: 'oc-1',
    displayName: 'OpenCode Session',
    sdkType: 'opencode',
    cwd: '/home/user/project',
  };
}

function makeReplayLoader(events: Array<Record<string, unknown>>) {
  return {
    getReplayEvents: async (_sessionId: string) => events,
  };
}

describe('extractOpenCodeTranscript', () => {
  it('extracts user and assistant messages', async () => {
    const events = [
      { type: 'message_start', message: { id: 'u1', role: 'user', content: 'Hello' }, timestamp: TS },
      { type: 'message_end', message: { id: 'u1' } },
      { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: TS + 1 },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'Hi!' } },
      { type: 'message_end', message: { id: 'a1' } },
    ];

    const result = await extractOpenCodeTranscript(makeReplayLoader(events), 'oc-1', makeSource(), 'visible_full');

    expect(result.error).toBeUndefined();
    expect(result.transcript.items).toHaveLength(2);
    expect(result.transcript.items[0].kind).toBe('user');
    expect(result.transcript.items[1].kind).toBe('assistant');
    expect(result.transcript.items[1].text).toBe('Hi!');
  });

  it('includes visible tool calls', async () => {
    const events = [
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { filePath: '/foo.ts' }, timestamp: TS },
      { type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: 'contents' }] }, isError: false },
    ];

    const result = await extractOpenCodeTranscript(makeReplayLoader(events), 'oc-1', makeSource(), 'visible_full');

    expect(result.error).toBeUndefined();
    expect(result.transcript.items).toHaveLength(1);
    expect(result.transcript.items[0].kind).toBe('tool');
    expect(result.transcript.items[0].toolName).toBe('read');
  });

  it('excludes reasoning/thinking from assistant', async () => {
    const events = [
      { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: TS },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'Visible text' } },
      { type: 'message_end', message: { id: 'a1' } },
    ];

    const result = await extractOpenCodeTranscript(makeReplayLoader(events), 'oc-1', makeSource(), 'visible_full');

    expect(result.transcript.items).toHaveLength(1);
    expect(result.transcript.items[0].text).toBe('Visible text');
  });

  it('returns error for empty events', async () => {
    const result = await extractOpenCodeTranscript(makeReplayLoader([]), 'oc-1', makeSource(), 'visible_full');

    expect(result.error).toBe('Nothing visible to transfer');
  });

  it('returns error when getReplayEvents throws', async () => {
    const loader = {
      getReplayEvents: async () => { throw new Error('server down'); },
    };

    const result = await extractOpenCodeTranscript(loader, 'oc-1', makeSource(), 'visible_full');

    expect(result.error).toBe('Failed to load OpenCode history');
  });

  it('applies recent scope', async () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      type: 'message_start',
      message: { id: `u${i}`, role: 'user', content: `msg ${i}` },
      timestamp: TS + i,
    })).flatMap((e, i) => [
      e,
      { type: 'message_end', message: { id: `u${i}` } },
    ]);

    const result = await extractOpenCodeTranscript(makeReplayLoader(events), 'oc-1', makeSource(), 'visible_recent');

    expect(result.transcript.items.length).toBeLessThanOrEqual(20);
  });
});
