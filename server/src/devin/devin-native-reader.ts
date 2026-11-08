/**
 * Devin native session listing — read-only access to the CLI's SQLite store
 * `<DEVIN_HOME>/.local/share/devin/cli/sessions.db` (brief §9).
 *
 * The DB is opened READ-ONLY (`node:sqlite` DatabaseSync `readOnly: true`),
 * never written and never locked; a busy WAL is tolerated by retrying the
 * bounded read briefly before failing open with []. The `sessions` table's
 * timestamps are epoch SECONDS (live-verified against the trial store).
 */

import { createRequire } from 'node:module';

// `node:sqlite` via createRequire: vitest's vite resolver cannot resolve the
// newer `node:` builtin ("Failed to load url sqlite"), while the runtime
// require path is plain Node. @types/node (v20) has no node:sqlite typings,
// so the surface this module uses is declared structurally below.
const require = createRequire(import.meta.url);

/** Minimal structural surface of node:sqlite's DatabaseSync (readOnly open,
 *  prepared statements, close). Real shape: node:sqlite (Node >= 22.5). */
export interface SqliteDatabase {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
  close(): void;
}
interface SqliteDatabaseSyncConstructor {
  new (path: string, options?: { readOnly?: boolean }): SqliteDatabase;
}
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: SqliteDatabaseSyncConstructor };

export interface DevinNativeSession {
  id: string;
  cwd?: string;
  model?: string;
  title?: string;
  /** epoch milliseconds (converted from the store's epoch seconds). */
  createdAt?: number;
  /** epoch milliseconds (converted from the store's epoch seconds). */
  lastActivityAt?: number;
  hidden: boolean;
}

export interface DevinNativeReadOptions {
  since?: Date;
  /** Exclusive upper bound on lastActivityAt — the paging cursor. */
  before?: Date;
}

const BUSY_RETRIES = 3;
const BUSY_RETRY_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Open the sessions.db strictly read-only. Throws when the file is missing —
 *  callers translate that to an empty listing. */
export function openDevinSessionsDbReadOnly(dbPath: string): SqliteDatabase {
  return new DatabaseSync(dbPath, { readOnly: true });
}

interface SessionsRow {
  id: string;
  working_directory: string | null;
  model: string | null;
  title: string | null;
  created_at: number | null;
  last_activity_at: number | null;
  hidden: number | null;
}

function toNativeSession(row: SessionsRow): DevinNativeSession {
  return {
    id: row.id,
    ...(row.working_directory ? { cwd: row.working_directory } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.created_at !== null && row.created_at !== undefined ? { createdAt: row.created_at * 1000 } : {}),
    ...(row.last_activity_at !== null && row.last_activity_at !== undefined ? { lastActivityAt: row.last_activity_at * 1000 } : {}),
    hidden: row.hidden === 1,
  };
}

/**
 * List every session in the store, newest first (last_activity_at DESC).
 * Read-only, bounded retries on a busy WAL, fail-open [] when the DB is
 * missing or unreadable.
 */
export async function readDevinNativeSessions(
  dbPath: string,
  options: DevinNativeReadOptions = {},
): Promise<DevinNativeSession[]> {
  let db: SqliteDatabase;
  try {
    db = openDevinSessionsDbReadOnly(dbPath);
  } catch {
    return [];
  }
  try {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (options.since) {
      clauses.push('last_activity_at >= ?');
      args.push(Math.floor(options.since.getTime() / 1000));
    }
    if (options.before) {
      clauses.push('last_activity_at < ?');
      args.push(Math.floor(options.before.getTime() / 1000));
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT id, working_directory, model, title, created_at, last_activity_at, hidden FROM sessions${where} ORDER BY last_activity_at DESC`;
    for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
      try {
        const rows = db.prepare(sql).all(...args) as unknown as SessionsRow[];
        return rows.map(toNativeSession);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const busy = /locked|busy/i.test(message);
        if (!busy || attempt === BUSY_RETRIES) return [];
        await sleep(BUSY_RETRY_DELAY_MS);
      }
    }
    return [];
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}
