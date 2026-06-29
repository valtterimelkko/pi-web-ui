/**
 * Notification Store
 *
 * Durable, disk-backed persistence for the notification layer. Holds three
 * collections, each its own JSON file written atomically (temp-file + rename)
 * with a serialized write chain, exactly like watch-store.ts:
 *
 *   opt-ins.json      — map sessionId -> OptInRecord
 *   outbox.json       — QueuedNotification[] currently pending delivery
 *   delivery-log.json — QueuedNotification[] most-recent terminal deliveries
 *                       (sent / failed), capped to `maxDeliveryLog`
 *
 * This module knows nothing about runtimes, the broker, or channels. The
 * NotificationManager orchestrates; this store only persists and serves.
 */

import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import path from 'path';
import type {
  OptInRecord,
  QueuedNotification,
  DeliveryRecord,
} from './types.js';

const OPTINS_FILE = 'opt-ins.json';
const OUTBOX_FILE = 'outbox.json';
const LOG_FILE = 'delivery-log.json';

export interface NotificationStoreOptions {
  /** Cap on the persisted delivery log (most recent kept). Default 200. */
  maxDeliveryLog?: number;
}

export class NotificationStore {
  private readonly dir: string;
  private readonly maxLog: number;
  private readonly optIns = new Map<string, OptInRecord>();
  private outbox: QueuedNotification[] = [];
  private log: QueuedNotification[] = [];
  /** Per-file write chain so concurrent saves serialize instead of racing. */
  private readonly writeChains = new Map<string, Promise<void>>();
  private ready = false;

  constructor(dir: string, opts: NotificationStoreOptions = {}) {
    this.dir = dir;
    this.maxLog = opts.maxDeliveryLog ?? 200;
  }

  /** Load all collections from disk into memory. Idempotent. */
  async init(): Promise<void> {
    if (this.ready) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });

    const optIns = await this.readJson<Record<string, OptInRecord>>(OPTINS_FILE, {});
    this.optIns.clear();
    for (const rec of Object.values(optIns)) {
      if (rec && rec.sessionId) this.optIns.set(rec.sessionId, rec);
    }
    this.outbox = await this.readJson<QueuedNotification[]>(OUTBOX_FILE, []);
    this.log = await this.readJson<QueuedNotification[]>(LOG_FILE, []);
    this.ready = true;
  }

  // ── Opt-ins ───────────────────────────────────────────────────────

  getOptIn(sessionId: string): OptInRecord | undefined {
    return this.optIns.get(sessionId);
  }

  listOptIns(): OptInRecord[] {
    return Array.from(this.optIns.values());
  }

  async setOptIn(record: OptInRecord): Promise<void> {
    this.optIns.set(record.sessionId, record);
    const snapshot: Record<string, OptInRecord> = {};
    for (const rec of this.optIns.values()) snapshot[rec.sessionId] = rec;
    await this.persist(OPTINS_FILE, snapshot);
  }

  async removeOptIn(sessionId: string): Promise<void> {
    this.optIns.delete(sessionId);
    const snapshot: Record<string, OptInRecord> = {};
    for (const rec of this.optIns.values()) snapshot[rec.sessionId] = rec;
    await this.persist(OPTINS_FILE, snapshot);
  }

  // ── Outbox ────────────────────────────────────────────────────────

  async enqueue(item: QueuedNotification): Promise<void> {
    this.outbox.push(item);
    await this.persist(OUTBOX_FILE, this.outbox);
  }

  listPending(): QueuedNotification[] {
    return this.outbox.slice();
  }

  /** Mark a pending item delivered: move it to the log as `sent`. */
  async markSent(notificationId: string, deliveredAt: string): Promise<void> {
    const idx = this.outbox.findIndex((q) => q.notification.id === notificationId);
    if (idx === -1) return;
    const [item] = this.outbox.splice(idx, 1);
    const delivery: DeliveryRecord = { ...item.delivery, status: 'sent', deliveredAt };
    this.pushLog({ notification: item.notification, delivery });
    await Promise.all([
      this.persist(OUTBOX_FILE, this.outbox),
      this.persist(LOG_FILE, this.log),
    ]);
  }

  /**
   * Record a delivery failure. Non-terminal: bump attempts, keep pending (the
   * manager retries). Terminal: move to the log as `failed`.
   */
  async recordFailure(
    notificationId: string,
    lastError: string,
    terminal: boolean,
  ): Promise<void> {
    const idx = this.outbox.findIndex((q) => q.notification.id === notificationId);
    if (idx === -1) return;
    const item = this.outbox[idx];
    const attempts = item.delivery.attempts + 1;
    if (terminal) {
      this.outbox.splice(idx, 1);
      this.pushLog({
        notification: item.notification,
        delivery: { ...item.delivery, status: 'failed', attempts, lastError },
      });
      await Promise.all([
        this.persist(OUTBOX_FILE, this.outbox),
        this.persist(LOG_FILE, this.log),
      ]);
    } else {
      this.outbox[idx] = {
        notification: item.notification,
        delivery: { ...item.delivery, status: 'pending', attempts, lastError },
      };
      await this.persist(OUTBOX_FILE, this.outbox);
    }
  }

  // ── Delivery log ──────────────────────────────────────────────────

  listLog(limit?: number): QueuedNotification[] {
    return limit === undefined ? this.log.slice() : this.log.slice(0, limit);
  }

  /** Pending + terminal deliveries for one session (pending first). */
  listForSession(sessionId: string): QueuedNotification[] {
    const pending = this.outbox.filter((q) => q.notification.sessionId === sessionId);
    const logged = this.log.filter((q) => q.notification.sessionId === sessionId);
    return [...pending, ...logged];
  }

  // ── Internals ─────────────────────────────────────────────────────

  private pushLog(item: QueuedNotification): void {
    this.log.unshift(item);
    if (this.log.length > this.maxLog) this.log.length = this.maxLog;
  }

  private async readJson<T>(name: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(path.join(this.dir, name), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      // Missing file or corrupt JSON — start empty. A corrupt file must not
      // prevent the rest of the collections from loading.
      return fallback;
    }
  }

  /**
   * Persist a collection atomically. Writes for the same file are chained so
   * they never overlap; a temp-file rename avoids leaving a half-written file
   * if the process dies mid-write. The payload is stringified lazily, inside
   * the chain, so every write reflects the latest in-memory state.
   */
  private persist(name: string, data: unknown): Promise<void> {
    const file = path.join(this.dir, name);
    const prev = this.writeChains.get(name) ?? Promise.resolve();
    const next = prev
      .catch(() => {
        /* don't let a prior failure break the chain */
      })
      .then(async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
        await rename(tmp, file);
      });
    this.writeChains.set(name, next);
    return next;
  }
}
