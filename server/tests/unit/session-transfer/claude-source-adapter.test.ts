import { describe, it, expect } from 'vitest';
import { extractClaudeTranscript } from '../../../src/session-transfer/claude-source-adapter.js';
import type { ClaudeMessageEntry } from '../../../src/claude/claude-session-store.js';
import type { VisibleTranscriptSource, TransferScope } from '../../../src/session-transfer/types.js';

const TS = 1700000000000;

function makeSource(): VisibleTranscriptSource {
  return {
    sessionId: 'claude-1',
    displayName: 'Claude Session',
    sdkType: 'claude',
    cwd: '/home/user/project',
  };
}

function makeEntry(overrides: Partial<ClaudeMessageEntry>): ClaudeMessageEntry {
  return {
    type: 'user',
    sessionId: 'claude-1',
    timestamp: TS,
    ...overrides,
  };
}

async function mockLoadHistory(entries: ClaudeMessageEntry[]): Promise<ClaudeMessageEntry[]> {
  return entries;
}

describe('extractClaudeTranscript', () => {
  it('extracts user and assistant messages', async () => {
    const history = [
      makeEntry({ type: 'user', content: 'Hello Claude' }),
      makeEntry({ type: 'assistant', content: 'Hi!' }),
    ];

    const result = await extractClaudeTranscript(
      () => mockLoadHistory(history),
      'claude-1',
      makeSource(),
      'visible_full',
    );

    expect(result.error).toBeUndefined();
    expect(result.transcript.items.length).toBeGreaterThanOrEqual(2);
    expect(result.transcript.items.some(i => i.kind === 'user')).toBe(true);
    expect(result.transcript.items.some(i => i.kind === 'assistant')).toBe(true);
  });

  it('includes visible tool calls', async () => {
    const history = [
      makeEntry({ type: 'user', content: 'Read the file' }),
      makeEntry({ type: 'tool', toolName: 'Read', toolCallId: 't1', toolInput: { file_path: '/foo.ts' } }),
      makeEntry({ type: 'tool_result', toolCallId: 't1', toolOutput: 'file contents here' }),
      makeEntry({ type: 'assistant', content: 'Here is the file.' }),
    ];

    const result = await extractClaudeTranscript(
      () => mockLoadHistory(history),
      'claude-1',
      makeSource(),
      'visible_full',
    );

    expect(result.error).toBeUndefined();
    const toolItems = result.transcript.items.filter(i => i.kind === 'tool');
    expect(toolItems.length).toBeGreaterThanOrEqual(1);
  });

  it('returns error for empty history', async () => {
    const result = await extractClaudeTranscript(
      () => mockLoadHistory([]),
      'claude-1',
      makeSource(),
      'visible_full',
    );

    expect(result.error).toBe('Nothing visible to transfer');
    expect(result.transcript.items).toHaveLength(0);
  });

  it('returns error when loadHistory throws', async () => {
    const result = await extractClaudeTranscript(
      async () => { throw new Error('disk error'); },
      'claude-1',
      makeSource(),
      'visible_full',
    );

    expect(result.error).toBe('Failed to load Claude history');
  });

  it('handles history with only meta entries', async () => {
    const history = [
      makeEntry({ type: 'meta', model: 'opus', cwd: '/home' }),
    ];

    const result = await extractClaudeTranscript(
      () => mockLoadHistory(history),
      'claude-1',
      makeSource(),
      'visible_full',
    );

    expect(result.error).toBe('Nothing visible to transfer');
  });

  it('coalesces consecutive assistant entries', async () => {
    const history = [
      makeEntry({ type: 'user', content: 'Go' }),
      makeEntry({ type: 'assistant', content: 'Part 1 ' }),
      makeEntry({ type: 'assistant', content: 'Part 2' }),
    ];

    const result = await extractClaudeTranscript(
      () => mockLoadHistory(history),
      'claude-1',
      makeSource(),
      'visible_full',
    );

    expect(result.error).toBeUndefined();
    const assistantItems = result.transcript.items.filter(i => i.kind === 'assistant');
    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0].text).toBe('Part 1 Part 2');
  });

  it('applies recent scope', async () => {
    const history = Array.from({ length: 30 }, (_, i) =>
      makeEntry({ type: 'user', content: `msg ${i}`, timestamp: TS + i })
    );

    const result = await extractClaudeTranscript(
      () => mockLoadHistory(history),
      'claude-1',
      makeSource(),
      'visible_recent',
    );

    expect(result.transcript.items.length).toBeLessThanOrEqual(20);
  });
});
