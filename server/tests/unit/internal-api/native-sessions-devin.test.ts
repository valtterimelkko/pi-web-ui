import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanNativeSessions } from '../../../src/internal-api/native-sessions.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Contract 1.69.0: every devin native item names its session (`sessionName`),
 *  because all devin sessions share one store path and a bare path cannot be
 *  read back as one session (Agent OS ledger rows were unreadable). */
describe('native devin items carry their session name (contract 1.69.0)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-devin-'));
  const dbPath = join(dir, 'sessions.db');
  beforeAll(() => {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, backend_type TEXT, model TEXT, agent_mode TEXT, created_at INTEGER, last_activity_at INTEGER, title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER, metadata TEXT);');
    const insert = db.prepare('INSERT INTO sessions (id, working_directory, model, title, created_at, last_activity_at, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('brass-akubra', '/ws/a', 'swe-2-flash-medium', 'Probe environment', 1794104205, 1794104262, 0);
    insert.run('flicker-rover', '/ws/b', 'swe-2-flash-medium', 'Describe tools', 1794104266, 1794104270, 0);
    db.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('emits sessionName per devin item; nativePath stays the store path', async () => {
    const known = { claudeSessionIds: new Map(), commandCodeNativeSessionIds: new Map(), opencodeSessionIds: new Map(), antigravityConversationIds: new Map(), devinSessionIds: new Map([['flicker-rover', { id: 'reg-1' }]]) };
    const { items } = await scanNativeSessions({ runtimes: ['devin'], limit: 10, roots: { devinNativeSessionsDb: dbPath }, known });
    expect(items.map((i) => i.sessionName)).toEqual(['flicker-rover', 'brass-akubra']);
    expect(items.every((i) => i.nativePath === dbPath)).toBe(true);
    expect(items[0].registrySessionId).toBe('reg-1');
  });
});
