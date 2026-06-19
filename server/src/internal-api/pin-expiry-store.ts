/**
 * Pin Expiry Store
 *
 * Durable, disk-backed record of API-initiated session pins and their absolute
 * expiry deadlines. This is what makes an API pin's "this won't be cleaned up"
 * guarantee survive a server restart, and — just as importantly — what lets the
 * pin be *cleaned up* automatically so a long-running agent task can't hog a
 * pin slot forever.
 *
 * Each pinned API session is one JSON file under the pin directory. Writes are
 * serialized per session so a burst of re-pins can't interleave and corrupt the
 * file. This mirrors {@link WatchStore} deliberately: the same durability
 * guarantees that make a long-horizon watch survive a restart apply here.
 *
 * IMPORTANT: this store only tracks *API-initiated* pins. Web-UI pins (managed
 * by humans through the preferences file) are unaffected and keep their existing
 * idle-based auto-unpin behaviour. The two mechanisms are independent and both
 * ultimately call the same per-runtime `unpinSession`.
 */

import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'fs/promises';
import path from 'path';
import type { SessionRuntime } from './types.js';

/** Full on-disk shape — everything needed to re-apply / expire a pin after restart. */
export interface PersistedApiPin {
  sessionId: string;
  sessionPath?: string;
  runtime?: SessionRuntime;
  /** When the pin was granted, in ms since epoch. */
  pinnedAt: number;
  /** Absolute deadline after which the pin is revoked, in ms since epoch. */
  pinnedUntil: number;
  /** Optional human-readable label (e.g. who/why pinned it). */
  label?: string;
}

function sanitize(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export class PinExpiryStore {
  private readonly dir: string;
  private readonly cache = new Map<string, PersistedApiPin>();
  /** Per-session write chain so concurrent saves serialize instead of racing. */
  private readonly writeChains = new Map<string, Promise<void>>();
  private ready = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Load all persisted pins from disk into memory. Idempotent. Merge-only: a
   * pin recorded after construction (e.g. a save that raced init) is preserved. */
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
        const record = JSON.parse(raw) as PersistedApiPin;
        if (record && record.sessionId && !this.cache.has(record.sessionId)) {
          this.cache.set(record.sessionId, record);
        }
      } catch {
        // A single corrupt file must not prevent the rest from loading.
      }
    }
    this.ready = true;
  }

  get(sessionId: string): PersistedApiPin | undefined {
    return this.cache.get(sessionId);
  }

  list(): PersistedApiPin[] {
    return Array.from(this.cache.values());
  }

  private fileFor(sessionId: string): string {
    return path.join(this.dir, `${sanitize(sessionId)}.json`);
  }

  /**
   * Persist (or update) a pin. Updates the in-memory cache synchronously and
   * returns a promise that resolves when the bytes are on disk. Writes for the
   * same session are chained so they never overlap; an atomic temp-file rename
   * avoids leaving a half-written file if the process dies mid-write.
   */
  save(record: PersistedApiPin): Promise<void> {
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
    return next;
  }

  async delete(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
    // Wait for any in-flight write to finish before unlinking.
    await (this.writeChains.get(sessionId) ?? Promise.resolve()).catch(() => {});
    this.writeChains.delete(sessionId);
    try {
      await unlink(this.fileFor(sessionId));
    } catch {
      // Already gone — fine.
    }
  }
}
