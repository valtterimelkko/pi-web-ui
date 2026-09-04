import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { extractPiTranscript, piSessionToReplayEvents } from '../../../src/session-transfer/pi-source-adapter.js';
import { projectDefaultViewFromEvents } from '@pi-web-ui/shared';
import type { VisibleTranscriptSource, TransferScope } from '../../../src/session-transfer/types.js';

const TS = 1700000000000;

function makeSource(overrides: Partial<VisibleTranscriptSource> = {}): VisibleTranscriptSource {
  return {
    sessionId: 'pi-1',
    displayName: 'Pi Session',
    sdkType: 'pi',
    cwd: '/home/user/project',
    ...overrides,
  };
}

function makeEntry(overrides: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: TS, ...overrides });
}

describe('piSessionToReplayEvents — tool parity (contract 1.34.0)', () => {
  let tmpDir: string;
  let sessionFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-replay-tools-'));
    sessionFile = path.join(tmpDir, 'session.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('emits tool_execution_start/end from assistant toolCall blocks and toolResult messages', async () => {
    await fs.writeFile(sessionFile, [
      makeEntry({ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: 'run it' }], timestamp: TS } }),
      makeEntry({ type: 'message', id: 'm2', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'let me look' },
        { type: 'toolCall', id: 'tool_01', name: 'bash', arguments: { command: 'ls -la' } },
      ], timestamp: TS } }),
      makeEntry({ type: 'message', id: 'm3', message: { role: 'toolResult', toolCallId: 'tool_01', toolName: 'bash', content: [{ type: 'text', text: 'file.txt' }], isError: false, timestamp: TS } }),
    ].join('\n'));

    const events = await piSessionToReplayEvents(sessionFile);
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_execution_start');
    expect(types).toContain('tool_execution_end');

    const start = events.find((e) => e.type === 'tool_execution_start');
    expect(start).toMatchObject({ toolCallId: 'tool_01', toolName: 'bash', args: { command: 'ls -la' } });
    // The start must come after the assistant message_end so projection order matches the browser.
    expect(types.indexOf('tool_execution_start')).toBeGreaterThan(types.indexOf('message_end'));

    const end = events.find((e) => e.type === 'tool_execution_end') as Record<string, unknown>;
    expect(end).toMatchObject({ toolCallId: 'tool_01', toolName: 'bash', isError: false });
    expect((end.result as { content: unknown }).content).toEqual([{ type: 'text', text: 'file.txt' }]);
  });

  it('carries toolResult details so background-subagent identity survives replay', async () => {
    await fs.writeFile(sessionFile, [
      makeEntry({ type: 'message', id: 'm2', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'tool_bg', name: 'subagent', arguments: { agent: 'web-researcher', run_in_background: true, task: 'research ETFs' } },
      ], timestamp: TS } }),
      makeEntry({ type: 'message', id: 'm3', message: { role: 'toolResult', toolCallId: 'tool_bg', toolName: 'subagent', content: [{ type: 'text', text: 'Background subagent launched (detached).' }], isError: false, details: {
        mode: 'single', results: [], background: { taskId: 'bg_abc', runId: 'sa_abc', kind: 'bounded' },
      }, timestamp: TS } }),
    ].join('\n'));

    const events = await piSessionToReplayEvents(sessionFile);
    const end = events.find((e) => e.type === 'tool_execution_end') as Record<string, unknown>;
    const details = (end.result as { details?: { background?: unknown } }).details;
    expect(details?.background).toEqual({ taskId: 'bg_abc', runId: 'sa_abc', kind: 'bounded' });
  });

  it('end-to-end: the shared screen projection renders tool cards from the replayed events', async () => {
    await fs.writeFile(sessionFile, [
      makeEntry({ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: TS } }),
      makeEntry({ type: 'message', id: 'm2', message: { role: 'assistant', content: [
        { type: 'text', text: 'Dispatching three research children.' },
        { type: 'toolCall', id: 't1', name: 'subagent', arguments: { agent: 'web-researcher', task: 'ETF pack', run_in_background: true } },
        { type: 'toolCall', id: 't2', name: 'subagent', arguments: { agent: 'web-researcher', task: 'HL costs', run_in_background: true } },
        { type: 'toolCall', id: 't3', name: 'subagent', arguments: { agent: 'web-researcher', task: 'performance', run_in_background: true } },
      ], timestamp: TS } }),
      makeEntry({ type: 'message', id: 'm3', message: { role: 'toolResult', toolCallId: 't1', toolName: 'subagent', content: [{ type: 'text', text: 'Background subagent launched (detached).' }], isError: false, details: { mode: 'single', results: [], background: { taskId: 'bg_1', runId: 'sa_1', kind: 'bounded' } }, timestamp: TS } }),
      makeEntry({ type: 'message', id: 'm4', message: { role: 'toolResult', toolCallId: 't2', toolName: 'subagent', content: [{ type: 'text', text: 'Background subagent launched (detached).' }], isError: false, details: { mode: 'single', results: [], background: { taskId: 'bg_2', runId: 'sa_2', kind: 'bounded' } }, timestamp: TS } }),
      makeEntry({ type: 'message', id: 'm5', message: { role: 'toolResult', toolCallId: 't3', toolName: 'subagent', content: [{ type: 'text', text: 'Background subagent launched (detached).' }], isError: false, details: { mode: 'single', results: [], background: { taskId: 'bg_3', runId: 'sa_3', kind: 'bounded' } }, timestamp: TS } }),
    ].join('\n'));

    const events = await piSessionToReplayEvents(sessionFile);
    const view = projectDefaultViewFromEvents(events, { expand: { tools: true, thinking: false } });
    const toolItems = view.items.filter((i) => i.kind === 'tool');
    expect(toolItems).toHaveLength(3);
    expect(toolItems.every((i) => i.toolName === 'subagent')).toBe(true);
  });

  it('skips orphan toolResult entries with no matching start (projection drops them)', async () => {
    await fs.writeFile(sessionFile, [
      makeEntry({ type: 'message', id: 'm3', message: { role: 'toolResult', toolCallId: 'ghost', toolName: 'bash', content: [{ type: 'text', text: 'x' }], isError: false, timestamp: TS } }),
    ].join('\n'));
    const events = await piSessionToReplayEvents(sessionFile);
    // Emitted for completeness; the shared projection ignores ends without starts.
    expect(events.filter((e) => e.type === 'tool_execution_end')).toHaveLength(1);
    const view = projectDefaultViewFromEvents(events, { expand: { tools: true, thinking: false } });
    expect(view.items.filter((i) => i.kind === 'tool')).toHaveLength(0);
  });
});

describe('extractPiTranscript', () => {
  let tmpDir: string;
  let sessionFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-transfer-test-'));
    sessionFile = path.join(tmpDir, 'session.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts user and assistant messages', async () => {
    await fs.writeFile(sessionFile, [
      makeEntry({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } }),
      makeEntry({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] } }),
    ].join('\n'));

    const result = await extractPiTranscript(sessionFile, makeSource(), 'visible_full');
    expect(result.error).toBeUndefined();
    expect(result.transcript.items).toHaveLength(2);
    expect(result.transcript.items[0]).toEqual({ kind: 'user', text: 'Hello', timestamp: TS });
    expect(result.transcript.items[1]).toEqual({ kind: 'assistant', text: 'Hi there!', timestamp: TS });
  });

  it('transforms skill content in user messages', async () => {
    await fs.writeFile(sessionFile, [
      makeEntry({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '<skill name="my-skill">big content here</skill>' }] } }),
    ].join('\n'));

    const result = await extractPiTranscript(sessionFile, makeSource(), 'visible_full');
    expect(result.transcript.items).toHaveLength(1);
    expect(result.transcript.items[0].text).toContain('Skill loaded: my-skill');
    expect(result.transcript.items[0].text).not.toContain('big content here');
  });

  it('includes visible tool entries', async () => {
    await fs.writeFile(sessionFile, [
      makeEntry({ type: 'tool_execution_start', toolName: 'read', args: { filePath: '/foo.ts' } }),
      makeEntry({ type: 'tool_execution_end', toolName: 'read', result: { content: [{ type: 'text', text: 'file contents' }] } }),
    ].join('\n'));

    const result = await extractPiTranscript(sessionFile, makeSource(), 'visible_full');
    expect(result.transcript.items).toHaveLength(2);
    expect(result.transcript.items[0].toolName).toBe('read');
    expect(result.transcript.items[1].toolName).toBe('read');
  });

  it('excludes invisible tool entries', async () => {
    await fs.writeFile(sessionFile, [
      makeEntry({ type: 'tool_execution_start', toolName: 'internal_handler', args: {} }),
      makeEntry({ type: 'tool_execution_end', toolName: 'internal_handler', result: 'x' }),
    ].join('\n'));

    const result = await extractPiTranscript(sessionFile, makeSource(), 'visible_full');
    expect(result.transcript.items).toHaveLength(0);
    expect(result.error).toBe('Nothing visible to transfer');
  });

  it('returns error for missing file', async () => {
    const result = await extractPiTranscript('/nonexistent/path.jsonl', makeSource(), 'visible_full');
    expect(result.error).toBe('Session file not found');
    expect(result.transcript.items).toHaveLength(0);
  });

  it('returns error for empty session', async () => {
    await fs.writeFile(sessionFile, '');

    const result = await extractPiTranscript(sessionFile, makeSource(), 'visible_full');
    expect(result.error).toBe('Nothing visible to transfer');
  });

  it('returns error for session with only system messages', async () => {
    await fs.writeFile(sessionFile, [
      makeEntry({ type: 'message', message: { role: 'system', content: [{ type: 'text', text: 'init' }] } }),
    ].join('\n'));

    const result = await extractPiTranscript(sessionFile, makeSource(), 'visible_full');
    expect(result.error).toBe('Nothing visible to transfer');
  });

  it('skips malformed JSON lines', async () => {
    await fs.writeFile(sessionFile, [
      'not valid json',
      makeEntry({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } }),
    ].join('\n'));

    const result = await extractPiTranscript(sessionFile, makeSource(), 'visible_full');
    expect(result.transcript.items).toHaveLength(1);
    expect(result.transcript.items[0].text).toBe('Hello');
  });

  it('handles string content in messages', async () => {
    await fs.writeFile(sessionFile, [
      makeEntry({ type: 'message', message: { role: 'user', content: 'plain string content' } }),
    ].join('\n'));

    const result = await extractPiTranscript(sessionFile, makeSource(), 'visible_full');
    expect(result.transcript.items).toHaveLength(1);
    expect(result.transcript.items[0].text).toBe('plain string content');
  });

  it('applies recent scope correctly', async () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      makeEntry({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `msg ${i}` }] }, timestamp: TS + i })
    );
    await fs.writeFile(sessionFile, entries.join('\n'));

    const result = await extractPiTranscript(sessionFile, makeSource(), 'visible_recent');
    expect(result.transcript.items).toHaveLength(20);
    expect(result.transcript.truncated).toBe(true);
  });
});
