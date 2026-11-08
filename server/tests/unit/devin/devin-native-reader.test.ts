import { describe, it, expect } from 'vitest';
import { readDevinNativeSessions } from '../../../src/devin/devin-native-reader.js';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node:sqlite via createRequire (vitest's vite resolver cannot resolve the
// builtin directly; see devin-native-reader.ts for the same note).
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Synthetic SQLite fixture with the sessions table columns the real store
 * carries (schema read from the trial store /root/devin-trial/home —
 * sessions.db, v3000.12.28). Values synthetic. The real reader must open the
 * DB READ-ONLY and never write or lock it.
 */

function makeFixtureDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT,
      backend_type TEXT,
      model TEXT,
      agent_mode TEXT,
      created_at INTEGER,
      last_activity_at INTEGER,
      title TEXT,
      main_chain_id INTEGER,
      shell_last_seen_index INTEGER,
      cogs_json TEXT,
      workspace_dirs TEXT,
      hidden INTEGER,
      metadata TEXT
    );
  `);
  const insert = db.prepare(
    'INSERT INTO sessions (id, working_directory, model, title, created_at, last_activity_at, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('brass-akubra', '/ws/a', 'swe-2-flash-medium', 'Probe environment', 1794104205, 1794104262, 0);
  insert.run('flicker-rover', '/ws/b', 'swe-2-flash-medium', 'Describe background tools', 1794104266, 1794104270, 0);
  insert.run('hidden-one', '/ws/c', 'swe-2-medium', 'Deleted session', 1794100000, 1794100001, 1);
  db.close();
}

describe('devin native sessions reader (read-only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devin-native-reader-test-'));
  const dbPath = join(dir, 'sessions.db');
  beforeAll(() => makeFixtureDb(dbPath));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lists every session with id, cwd, model, title, timestamps (epoch seconds → ms)', async () => {
    const items = await readDevinNativeSessions(dbPath);
    // every session — including hidden ones — appears (the brief: every session)
    expect(items.length).toBe(3);
    const first = items.find((i) => i.id === 'brass-akubra')!;
    expect(first.cwd).toBe('/ws/a');
    expect(first.model).toBe('swe-2-flash-medium');
    expect(first.title).toBe('Probe environment');
    expect(first.createdAt).toBe(1794104205000);
    expect(first.lastActivityAt).toBe(1794104262000);
    expect(first.hidden).toBe(false);
  });

  it('orders by last_activity_at descending', async () => {
    const items = await readDevinNativeSessions(dbPath);
    expect(items[0].id).toBe('flicker-rover');
    expect(items[items.length - 1].id).toBe('hidden-one');
  });

  it('supports paging filters since/before on the activity timestamp', async () => {
    const all = await readDevinNativeSessions(dbPath);
    const newest = all[0].lastActivityAt;
    const page = await readDevinNativeSessions(dbPath, { before: new Date(newest) });
    expect(page.some((i) => i.id === 'flicker-rover')).toBe(false);
    expect(page.length).toBe(2);
  });

  it('returns [] for a missing database instead of throwing', async () => {
    const items = await readDevinNativeSessions(join(dir, 'does-not-exist.db'));
    expect(items).toEqual([]);
  });

  it('opens the database READ-ONLY: writes through the same handle are refused', async () => {
    // The reader's connection must reject a write: prove by direct handle parity.
    const { openDevinSessionsDbReadOnly } = await import('../../../src/devin/devin-native-reader.js');
    const db = openDevinSessionsDbReadOnly(dbPath);
    try {
      expect(() => db.prepare("INSERT INTO sessions (id) VALUES ('nope')").run()).toThrow();
    } finally {
      db.close();
    }
  });
});
