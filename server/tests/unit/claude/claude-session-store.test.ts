import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeSessionStore, type ClaudeMessageEntry } from '../../../src/claude/claude-session-store.js';

let tempDir: string;
let store: ClaudeSessionStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claude-session-store-test-'));
  store = new ClaudeSessionStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('ClaudeSessionStore', () => {
  const SESSION_ID = 'session-001';
  const CLAUDE_SESSION_ID = 'claude-sess-abc';

  // ─── initSession ──────────────────────────────────────────────────────────

  it('initSession creates the JSONL file with a meta entry', async () => {
    await store.initSession(SESSION_ID, CLAUDE_SESSION_ID, '/home/user', 'opus');

    const history = await store.loadHistory(SESSION_ID);
    expect(history).toHaveLength(1);
    const meta = history[0];
    expect(meta.type).toBe('meta');
    expect(meta.sessionId).toBe(SESSION_ID);
    expect(meta.claudeSessionId).toBe(CLAUDE_SESSION_ID);
    expect(meta.cwd).toBe('/home/user');
    expect(meta.model).toBe('opus');
    expect(typeof meta.timestamp).toBe('number');
    expect(meta.createdAt).toBeDefined();
  });

  // ─── appendEntry ─────────────────────────────────────────────────────────

  it('appendEntry adds entries to the JSONL file', async () => {
    await store.initSession(SESSION_ID, CLAUDE_SESSION_ID, '/cwd', 'sonnet');

    await store.appendEntry(SESSION_ID, {
      type: 'user',
      content: 'Hello Claude',
      timestamp: Date.now(),
    });

    await store.appendEntry(SESSION_ID, {
      type: 'assistant',
      content: 'Hello! How can I help?',
      timestamp: Date.now(),
    });

    const history = await store.loadHistory(SESSION_ID);
    expect(history).toHaveLength(3); // meta + user + assistant
    expect(history[1].type).toBe('user');
    expect(history[1].content).toBe('Hello Claude');
    expect(history[2].type).toBe('assistant');
    expect(history[2].content).toBe('Hello! How can I help?');
  });

  // ─── loadHistory ─────────────────────────────────────────────────────────

  it('loadHistory reads back entries in order', async () => {
    await store.initSession(SESSION_ID, CLAUDE_SESSION_ID, '/cwd', 'haiku');

    const timestamps = [1000, 2000, 3000];
    for (const ts of timestamps) {
      await store.appendEntry(SESSION_ID, {
        type: 'user',
        content: `msg at ${ts}`,
        timestamp: ts,
      });
    }

    const history = await store.loadHistory(SESSION_ID);
    // meta + 3 user entries
    expect(history).toHaveLength(4);
    expect(history[1].timestamp).toBe(1000);
    expect(history[2].timestamp).toBe(2000);
    expect(history[3].timestamp).toBe(3000);
  });

  // ─── loadHistory non-existent ────────────────────────────────────────────

  it('loadHistory for non-existent session returns empty array', async () => {
    const history = await store.loadHistory('does-not-exist');
    expect(history).toEqual([]);
  });

  // ─── sessionExists ────────────────────────────────────────────────────────

  it('sessionExists returns false when session does not exist', async () => {
    const exists = await store.sessionExists('ghost-session');
    expect(exists).toBe(false);
  });

  it('sessionExists returns true after initSession', async () => {
    await store.initSession(SESSION_ID, CLAUDE_SESSION_ID, '/cwd', 'opus');
    const exists = await store.sessionExists(SESSION_ID);
    expect(exists).toBe(true);
  });

  // ─── deleteSession ────────────────────────────────────────────────────────

  it('deleteSession removes the JSONL file', async () => {
    await store.initSession(SESSION_ID, CLAUDE_SESSION_ID, '/cwd', 'sonnet');
    expect(await store.sessionExists(SESSION_ID)).toBe(true);

    await store.deleteSession(SESSION_ID);
    expect(await store.sessionExists(SESSION_ID)).toBe(false);
  });

  it('deleteSession does not throw if session does not exist', async () => {
    await expect(store.deleteSession('non-existent-session')).resolves.not.toThrow();
  });

  // ─── getFilePath ─────────────────────────────────────────────────────────

  it('getFilePath returns correct path', () => {
    const filePath = store.getFilePath(SESSION_ID);
    expect(filePath).toBe(join(tempDir, `${SESSION_ID}.jsonl`));
  });

  // ─── tool entry ──────────────────────────────────────────────────────────

  it('appendEntry supports tool entries', async () => {
    await store.initSession(SESSION_ID, CLAUDE_SESSION_ID, '/cwd', 'opus');

    await store.appendEntry(SESSION_ID, {
      type: 'tool',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test.txt' },
      toolOutput: 'file contents',
      timestamp: Date.now(),
    });

    const history = await store.loadHistory(SESSION_ID);
    expect(history).toHaveLength(2);
    const toolEntry = history[1];
    expect(toolEntry.type).toBe('tool');
    expect(toolEntry.toolName).toBe('Read');
    expect(toolEntry.toolInput).toEqual({ file_path: '/tmp/test.txt' });
    expect(toolEntry.toolOutput).toBe('file contents');
  });

  // ─── sessionId is set on appended entries ────────────────────────────────

  it('appendEntry sets sessionId on the stored entry', async () => {
    await store.initSession(SESSION_ID, CLAUDE_SESSION_ID, '/cwd', 'opus');
    await store.appendEntry(SESSION_ID, {
      type: 'user',
      content: 'Test',
      timestamp: Date.now(),
    });

    const history = await store.loadHistory(SESSION_ID);
    expect(history[1].sessionId).toBe(SESSION_ID);
  });
});
