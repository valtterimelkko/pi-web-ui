import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionFileHistory, SESSION_FILE_HISTORY_LIMITS } from '../../../src/talker/session-file-history.js';

/**
 * Reading the worker's conversation from its session FILE.
 *
 * The live defect (operator-reported 2026-09-18): the operator attached the
 * native voice lane to a worker session that existed on disk but was not loaded
 * in memory, asked the talker to summarise the work, and heard *"I don't have
 * access to the worker's session history"* — while the UI could display that very
 * session, because the UI reads the file. The talker's projection read only the
 * manager's in-memory session, so an idle/evicted/post-restart worker looked like
 * an empty one.
 *
 * These tests pin the file reader itself: what it returns, what it refuses to
 * invent, and the fact that it stays bounded on a pathological file.
 */

const dirs: string[] = [];

function fixture(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'voice-history-'));
  dirs.push(dir);
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

/** One Pi JSONL message entry, in the shape the real session files use. */
function messageLine(role: 'user' | 'assistant' | 'toolResult', text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'message',
    id: `m-${text.slice(0, 8)}-${Math.round(text.length)}`,
    message: { role, content: [{ type: 'text', text }], timestamp: 1_700_000_000_000 },
    ...extra,
  });
}

/** A line the reader must not choke on: session metadata, not a message. */
const metadataLine = JSON.stringify({ type: 'session', id: 'sess-1', cwd: '/root/si' });

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readSessionFileHistory', () => {
  it('reads the conversation the UI would show: user and assistant, oldest first', async () => {
    const path = fixture([
      metadataLine,
      messageLine('user', 'Please inventory the retry paths.'),
      messageLine('assistant', 'Three: the auth wrapper, the socket reopen, the goal resume.'),
      messageLine('toolResult', 'bash output that is harness noise, never spoken material'),
      messageLine('user', 'Good. Now fix the wrapper.'),
    ]);

    const result = await readSessionFileHistory(path);

    expect(result.entries.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user']);
    expect(result.entries[0].text).toBe('Please inventory the retry paths.');
    expect(result.entries[2].text).toBe('Good. Now fix the wrapper.');
    // Tool results are excluded, and the total counts the CONVERSATION, not lines.
    expect(result.entries.some((entry) => entry.text.includes('harness noise'))).toBe(false);
    expect(result.total).toBe(3);
  });

  it('keeps the whole conversation while the count is inside the bound', async () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      messageLine(i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
    );
    const result = await readSessionFileHistory(fixture(lines));

    expect(result.entries).toHaveLength(30);
    expect(result.total).toBe(30);
    expect(result.entries[0].text).toBe('message 0');
  });

  it('keeps the newest entries and still reports the TRUE total when the bound bites', async () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      messageLine(i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
    );
    const result = await readSessionFileHistory(fixture(lines), { maxEntries: 10 });

    expect(result.entries).toHaveLength(10);
    expect(result.entries.at(-1)?.text).toBe('message 59');
    // The count is honest: a bounded view must never claim it holds everything.
    expect(result.total).toBe(60);
  });

  it('survives an interrupted write: one corrupt line never costs the rest', async () => {
    const path = fixture([
      messageLine('user', 'the first real thing'),
      '{"type":"message","message":{"role":"assistant","content":[{"type":"te',
      messageLine('assistant', 'the second real thing'),
    ]);

    const result = await readSessionFileHistory(path);
    expect(result.entries.map((entry) => entry.text)).toEqual(['the first real thing', 'the second real thing']);
    expect(result.total).toBe(2);
  });

  it('returns nothing — never an invented conversation — for a file that is not there', async () => {
    const result = await readSessionFileHistory(join(tmpdir(), 'definitely-not-a-session.jsonl'));
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('returns nothing for an empty file', async () => {
    const result = await readSessionFileHistory(fixture([]));
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('drops empty and whitespace-only messages rather than projecting them', async () => {
    const path = fixture([messageLine('user', '   '), messageLine('assistant', 'real'), messageLine('user', '')]);
    const result = await readSessionFileHistory(path);
    expect(result.entries.map((entry) => entry.text)).toEqual(['real']);
    expect(result.total).toBe(1);
  });

  it('stays bounded on a pathological file: one huge line cannot make the view unbounded', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const path = fixture([messageLine('user', 'the needle before the flood'), messageLine('assistant', huge)]);

    const result = await readSessionFileHistory(path);

    // Both are read (the entry itself is bounded later, by the renderer), but the
    // reader never returns an unbounded number of entries.
    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.entries[0].text).toBe('the needle before the flood');
    expect(result.entries[1].text.length).toBeLessThanOrEqual(huge.length);
    // The reader's own entry ceiling exists and is finite.
    expect(Number.isFinite(SESSION_FILE_HISTORY_LIMITS.maxEntries)).toBe(true);
  });

  it('reads a file larger than the read window without losing the newest entries', async () => {
    const filler = Array.from({ length: 400 }, (_, i) =>
      messageLine(i % 2 === 0 ? 'user' : 'assistant', `old ${i} `.padEnd(2_000, 'y'))
    );
    const path = fixture([...filler, messageLine('assistant', 'THE NEWEST WORDS')]);

    const result = await readSessionFileHistory(path, { maxEntries: 5 });

    expect(result.entries.at(-1)?.text).toBe('THE NEWEST WORDS');
    expect(result.entries).toHaveLength(5);
    // The total is exact even though the file is far larger than any one window.
    expect(result.total).toBe(filler.length + 1);
  });

  it('reads nothing when the path is not a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-history-dir-'));
    dirs.push(dir);
    const result = await readSessionFileHistory(dir);
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });
});
