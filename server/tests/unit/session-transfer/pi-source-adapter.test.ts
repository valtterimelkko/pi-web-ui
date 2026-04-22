import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { extractPiTranscript } from '../../../src/session-transfer/pi-source-adapter.js';
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
