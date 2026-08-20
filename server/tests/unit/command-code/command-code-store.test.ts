import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandCodeSessionStore } from '../../../src/command-code/command-code-session-store.js';
import { CommandCodeEventJournal } from '../../../src/command-code/command-code-event-journal.js';

describe('Command Code private state', () => {
  it('persists validated mappings atomically and recovers non-successfully after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-store-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const store = new CommandCodeSessionStore(root);
    await store.init();
    const created = await store.create({
      sessionId: 'cc-1',
      cwd,
      modelSelector: 'qwen/qwen3.8-max',
      effort: 'xhigh',
      eventJournalRef: 'cc-1.jsonl',
    });
    expect(created.runtime).toBe('commandcode');
    expect(created.effort).toBe('xhigh');
    expect(created.cwd).toBe(path.resolve(cwd));
    await store.update('cc-1', { state: 'running', nativeSessionId: 'native-1' });

    const persisted = await readFile(path.join(root, 'sessions', 'cc-1.json'), 'utf8');
    expect(persisted).not.toContain('auth.json');

    const restarted = new CommandCodeSessionStore(root);
    await restarted.init();
    expect((await restarted.get('cc-1'))?.state).toBe('running');
    const recovered = await restarted.reconcileAfterRestart();
    expect(recovered[0]?.state).toBe('failed');
    expect(recovered[0]?.lastResult?.stopReason).toBe('server_restart_unknown');
  });

  it('persists dropped-line diagnostics and rejects malformed samples', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-store-dropped-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const store = new CommandCodeSessionStore(root);
    await store.init();
    await store.create({ sessionId: 'cc-drop', cwd, modelSelector: 'qwen/qwen3.8-max', eventJournalRef: 'cc-drop.jsonl' });
    await store.update('cc-drop', {
      state: 'idle',
      diagnostics: {
        suppressedDuplicateCount: 0,
        unknownEventTypes: [],
        droppedLineCount: 2,
        droppedLineSamples: [{ lineNumber: 173, sample: 'not json at all' }],
      },
    });
    const reloaded = new CommandCodeSessionStore(root);
    await reloaded.init();
    expect(reloaded.get('cc-drop')).resolves.toMatchObject({
      diagnostics: { droppedLineCount: 2, droppedLineSamples: [{ lineNumber: 173, sample: 'not json at all' }] },
    });
  });

  it('loads legacy records that still carry deleted access-control fields', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-store-legacy-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const store = new CommandCodeSessionStore(root);
    await store.init();
    await store.create({ sessionId: 'cc-legacy', cwd, modelSelector: 'qwen/qwen3.8-max', eventJournalRef: 'cc-legacy.jsonl' });
    const file = path.join(root, 'sessions', 'cc-legacy.json');
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    record.permissionProfile = 'browser-contained';
    record.invocationRole = 'conductor-root';
    record.effortCapabilityHash = 'a'.repeat(64);
    await (await import('node:fs/promises')).writeFile(file, JSON.stringify(record));
    const restarted = new CommandCodeSessionStore(root);
    await restarted.init();
    expect(await restarted.get('cc-legacy')).toBeDefined();
  });

  it('quarantines persisted records with malformed lifecycle fields or diagnostic bindings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-store-invalid-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const store = new CommandCodeSessionStore(root);
    await store.init();
    await store.create({ sessionId: 'cc-invalid', cwd, modelSelector: 'qwen/qwen3.8-max', eventJournalRef: 'cc-invalid.jsonl' });
    const file = path.join(root, 'sessions', 'cc-invalid.json');
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    record.messageCount = -1;
    record.diagnostics = { suppressedDuplicateCount: 0, unknownEventTypes: [], nativeSessionId: 'native-different' };
    await (await import('node:fs/promises')).writeFile(file, JSON.stringify(record));
    const restarted = new CommandCodeSessionStore(root);
    await restarted.init();
    expect(await restarted.get('cc-invalid')).toBeUndefined();
  });

  it('does not resurrect a record when delete races a queued update write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-store-race-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const store = new CommandCodeSessionStore(root);
    await store.init();
    await store.create({ sessionId: 'cc-race', cwd, modelSelector: 'qwen/qwen3.8-max', eventJournalRef: 'cc-race.jsonl' });
    const update = store.update('cc-race', { state: 'running', activeRunId: 'run-race' });
    const deletion = store.delete('cc-race');
    await Promise.allSettled([update, deletion]);
    expect(await store.get('cc-race')).toBeUndefined();
    await expect(readFile(path.join(root, 'sessions', 'cc-race.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects duplicate native-session bindings atomically', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-store-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const store = new CommandCodeSessionStore(root);
    await store.init();
    await store.create({ sessionId: 'cc-one', cwd, modelSelector: 'qwen/qwen3.8-max', eventJournalRef: 'cc-one.jsonl' });
    await store.create({ sessionId: 'cc-two', cwd, modelSelector: 'qwen/qwen3.8-max', eventJournalRef: 'cc-two.jsonl' });
    await store.bindNativeSession('cc-one', 'native-shared');
    await expect(store.bindNativeSession('cc-two', 'native-shared')).rejects.toThrow(/already bound/i);
    expect((await store.get('cc-two'))?.nativeSessionId).toBeUndefined();
  });

  it('refuses model/native-session drift', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-store-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const store = new CommandCodeSessionStore(root);
    await store.init();
    await store.create({
      sessionId: 'cc-1', cwd, modelSelector: 'qwen/qwen3.8-max', eventJournalRef: 'cc-1.jsonl',
    });
    await expect(store.bindNativeSession('cc-1', 'native-1')).resolves.toBeDefined();
    await expect(store.bindNativeSession('cc-1', 'native-2')).rejects.toThrow(/drift/i);
  });
});

describe('Command Code event journal', () => {
  it('is append-only, bounded, redacts sensitive values, and replays after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-journal-'));
    const journal = new CommandCodeEventJournal(root, { maxBytes: 20_000 });
    await journal.append('cc-1', { type: 'message_update', sessionId: 'cc-1', timestamp: 1, data: { text: 'hello', token: 'secret-token' } });
    await journal.append('cc-1', { type: 'agent_end', sessionId: 'cc-1', timestamp: 2, data: {} });
    const events = await journal.read('cc-1');
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('secret-token');
    expect((await new CommandCodeEventJournal(root).read('cc-1'))).toHaveLength(2);
  });

  it('preserves numeric usage evidence while still redacting real secrets', async () => {
    // The real CLI emits token usage as numeric strings under token-ish keys
    // (inputTokens: "11") and the authoritative projection lives under a
    // tokenUsage object key. Blanket key-based redaction destroyed all usage
    // evidence in journals (everything read [REDACTED]); numbers and numeric
    // strings are never secrets and must survive.
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-journal-usage-'));
    const journal = new CommandCodeEventJournal(root, { maxBytes: 20_000 });
    await journal.append('cc-usage', {
      type: 'agent_end',
      sessionId: 'cc-usage',
      timestamp: 3,
      data: {
        usage: { inputTokens: '11', outputTokens: '7', cacheReadTokens: '5', cacheWriteTokens: '2', accessToken: 'sk-live-9f2c' },
        tokenUsage: { scope: 'run', source: 'commandcode-terminal-result-v1', input: 11, output: 7, total: 18 },
        note: 'auth token: abc123secret',
      },
    });
    const [event] = await journal.read('cc-usage');
    const data = event.data as Record<string, Record<string, unknown> & { accessToken: unknown }>;
    expect(data.usage.inputTokens).toBe('11');
    expect(data.usage.outputTokens).toBe('7');
    expect(data.usage.accessToken).toBe('[REDACTED]');
    expect((data.tokenUsage as Record<string, unknown>).total).toBe(18);
    expect(JSON.stringify(event)).not.toContain('sk-live-9f2c');
    expect(JSON.stringify(event)).not.toContain('abc123secret');
  });
});
