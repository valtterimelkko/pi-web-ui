/**
 * Watch Store
 *
 * Durable, disk-backed persistence for watches. This is what makes a watch
 * survive the validator disconnecting and — crucially — a server restart. The
 * ledger of condition firings lives on disk, keyed by session, so a poller can
 * always learn what fired even if nobody was connected when it happened.
 *
 * Each watch is one JSON file under the watch directory. Writes are serialized
 * per file so a burst of firings can't interleave and corrupt the file.
 */

import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'fs/promises';
import path from 'path';
import type {
  SessionRuntime,
  WatchConditionState,
  WatchFiring,
  WatchSnapshot,
  WatchStatus,
} from '../types.js';

/** Full on-disk shape — everything needed to reconstruct a watch after restart. */
export interface PersistedWatch {
  watchId: string;
  sessionId: string;
  sessionPath: string;
  runtime: SessionRuntime;
  label?: string;
  status: WatchStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  conditions: WatchConditionState[];
  firings: WatchFiring[];
  snapshot: WatchSnapshot;
}

function sanitize(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export class WatchStore {
  private readonly dir: string;
  private readonly cache = new Map<string, PersistedWatch>();
  /** Per-session write chain so concurrent saves serialize instead of racing. */
  private readonly writeChains = new Map<string, Promise<void>>();
  private ready = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Load all persisted watches from disk into memory. Idempotent. */
  async init(): Promise<void> {
    if (this.ready) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let files: string[] = [];
    try {
      files = await readdir(this.dir);
    } catch {
      files = [];
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(path.join(this.dir, file), 'utf8');
        const record = JSON.parse(raw) as PersistedWatch;
        if (record && record.sessionId) {
          this.cache.set(record.sessionId, record);
        }
      } catch {
        // A single corrupt file must not prevent the rest from loading.
      }
    }
    this.ready = true;
  }

  get(sessionId: string): PersistedWatch | undefined {
    return this.cache.get(sessionId);
  }

  list(): PersistedWatch[] {
    return Array.from(this.cache.values());
  }

  private fileFor(sessionId: string): string {
    return path.join(this.dir, `${sanitize(sessionId)}.json`);
  }

  /**
   * Persist a watch. Updates the in-memory cache synchronously and returns a
   * promise that resolves when the bytes are on disk. Writes for the same
   * session are chained so they never overlap; an atomic temp-file rename
   * avoids leaving a half-written file if the process dies mid-write.
   */
  save(record: PersistedWatch): Promise<void> {
    this.cache.set(record.sessionId, record);
    const file = this.fileFor(record.sessionId);
    const payload = JSON.stringify(record, null, 2);
    const prev = this.writeChains.get(record.sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => { /* don't let a prior failure break the chain */ })
      .then(async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, payload, { mode: 0o600 });
        await rename(tmp, file);
      });
    this.writeChains.set(record.sessionId, next);
    // Remove the settled chain entry so the map cannot grow unbounded — but
    // only if no newer write has chained onto this one (else we'd drop the
    // in-flight entry). Runs on resolve and reject.
    const cleanup = (): void => {
      if (this.writeChains.get(record.sessionId) === next) {
        this.writeChains.delete(record.sessionId);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async delete(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
    // Wait for any in-flight write to finish before unlinking.
    await (this.writeChains.get(sessionId) ?? Promise.resolve()).catch(() => { /* legitimate: isolate the write chain — a prior failure is already handled/logged */ });
    this.writeChains.delete(sessionId);
    try {
      await unlink(this.fileFor(sessionId));
    } catch {
      // Already gone — fine.
    }
  }
}
