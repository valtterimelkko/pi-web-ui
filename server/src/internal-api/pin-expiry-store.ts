/**
 * Durable store for source-owned Internal API retention leases.
 *
 * Historical files were keyed by session id and represented one API pin. The
 * current format is keyed by lease id so several conductors can independently
 * retain the same session. Legacy records are migrated on init.
 */

import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'fs/promises';
import path from 'path';
import type { SessionRuntime } from './types.js';

export type RetentionMode = 'durable' | 'resident';

export interface PersistedApiPin {
  leaseId: string;
  sessionId: string;
  sessionPath?: string;
  runtime?: SessionRuntime;
  mode?: RetentionMode;
  ownerId?: string;
  pinnedAt: number;
  pinnedUntil: number;
  label?: string;
}

type LegacyApiPin = Omit<PersistedApiPin, 'leaseId'> & { leaseId?: string };

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export class PinExpiryStore {
  private readonly dir: string;
  private readonly cache = new Map<string, PersistedApiPin>();
  private readonly writeChains = new Map<string, Promise<void>>();
  private ready = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let files: string[] = [];
    try { files = await readdir(this.dir); } catch { files = []; }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const oldFile = path.join(this.dir, file);
      try {
        const raw = JSON.parse(await readFile(oldFile, 'utf8')) as LegacyApiPin;
        if (!raw?.sessionId) continue;
        const leaseId = raw.leaseId || `legacy-${sanitize(raw.sessionId)}`;
        const record: PersistedApiPin = {
          ...raw,
          leaseId,
          mode: raw.mode ?? 'resident',
          ownerId: raw.ownerId ?? 'legacy-internal-api',
        };
        if (!this.cache.has(leaseId)) this.cache.set(leaseId, record);
        const canonical = this.fileFor(leaseId);
        if (canonical !== oldFile) {
          await this.writeAtomic(canonical, JSON.stringify(record, null, 2));
          await unlink(oldFile).catch(() => undefined);
        }
      } catch {
        // One corrupt record must not prevent the remaining leases loading.
      }
    }
    this.ready = true;
  }

  /** Compatibility lookup: newest lease for a session. */
  get(sessionId: string): PersistedApiPin | undefined {
    return this.listForSession(sessionId).sort((a, b) => b.pinnedUntil - a.pinnedUntil)[0];
  }

  getByLeaseId(leaseId: string): PersistedApiPin | undefined {
    return this.cache.get(leaseId);
  }

  listForSession(sessionId: string): PersistedApiPin[] {
    return [...this.cache.values()].filter((record) => record.sessionId === sessionId);
  }

  list(): PersistedApiPin[] {
    return [...this.cache.values()];
  }

  private fileFor(leaseId: string): string {
    return path.join(this.dir, `${sanitize(leaseId)}.json`);
  }

  private async writeAtomic(file: string, payload: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, file);
  }

  save(record: PersistedApiPin): Promise<void> {
    const file = this.fileFor(record.leaseId);
    const payload = JSON.stringify(record, null, 2);
    const prev = this.writeChains.get(record.leaseId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        await this.writeAtomic(file, payload);
        // Publish to readers only after the durable write succeeds.
        this.cache.set(record.leaseId, record);
      });
    this.writeChains.set(record.leaseId, next);
    void next.then(
      () => { if (this.writeChains.get(record.leaseId) === next) this.writeChains.delete(record.leaseId); },
      () => { if (this.writeChains.get(record.leaseId) === next) this.writeChains.delete(record.leaseId); },
    );
    return next;
  }

  deleteLease(leaseId: string): Promise<void> {
    const prev = this.writeChains.get(leaseId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        try {
          await unlink(this.fileFor(leaseId));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.cache.delete(leaseId);
      });
    this.writeChains.set(leaseId, next);
    void next.then(
      () => { if (this.writeChains.get(leaseId) === next) this.writeChains.delete(leaseId); },
      () => { if (this.writeChains.get(leaseId) === next) this.writeChains.delete(leaseId); },
    );
    return next;
  }

  /** Compatibility helper: remove all leases for one session. */
  async delete(sessionId: string): Promise<void> {
    await Promise.all(this.listForSession(sessionId).map((record) => this.deleteLease(record.leaseId)));
  }
}
