/**
 * Notification Store
 *
 * Durable, disk-backed persistence for the notification layer. Holds three
 * collections, each its own JSON file written atomically (temp-file + rename)
 * with a serialized write chain, exactly like watch-store.ts:
 *
 *   opt-ins.json      — map sessionId -> OptInRecord
 *   outbox.json       — QueuedNotification[] currently pending delivery
 *   delivery-log.json — QueuedNotification[] terminal delivery/status ledger.
 *                       Recent listing and wider status retention have separate caps.
 *
 * This module knows nothing about runtimes, the broker, or channels. The
 * NotificationManager orchestrates; this store only persists and serves.
 */

import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'fs/promises';
import path from 'path';
import { createLogger } from '../logging/logger.js';
import type {
  OptInRecord,
  QueuedNotification,
  DeliveryRecord,
} from './types.js';

const logger = createLogger('NotificationStore');

const OPTINS_FILE = 'opt-ins.json';
const OUTBOX_FILE = 'outbox.json';
const LOG_FILE = 'delivery-log.json';
const MAX_LEDGER_FILE_BYTES = 32 * 1024 * 1024;

export interface NotificationStoreOptions {
  /** Cap returned by the unbounded recent-deliveries listing. Default 200. */
  maxDeliveryLog?: number;
  /** Wider persisted status/idempotency ledger cap. Default 1000. */
  maxDeliveryRecords?: number;
}

export interface IdempotentEnqueueResult {
  item: QueuedNotification;
  duplicate: boolean;
  conflict: boolean;
}

export class NotificationStore {
  private readonly dir: string;
  private readonly maxLog: number;
  private readonly maxRecords: number;
  private readonly optIns = new Map<string, OptInRecord>();
  private outbox: QueuedNotification[] = [];
  private log: QueuedNotification[] = [];
  /** Per-file write chain so concurrent saves serialize instead of racing. */
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly ingressReservations = new Map<string, {
    item: QueuedNotification;
    durable: Promise<void>;
  }>();
  private ready = false;

  constructor(dir: string, opts: NotificationStoreOptions = {}) {
    this.dir = dir;
    this.maxLog = opts.maxDeliveryLog ?? 200;
    this.maxRecords = Math.max(this.maxLog, opts.maxDeliveryRecords ?? 1000);
  }

  /** Load all collections from disk into memory. Idempotent. */
  async init(): Promise<void> {
    if (this.ready) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);

    const optIns = await this.readJson<Record<string, OptInRecord>>(OPTINS_FILE, {});
    this.optIns.clear();
    for (const rec of Object.values(optIns)) {
      if (rec && rec.sessionId) this.optIns.set(rec.sessionId, rec);
    }
    this.outbox = await this.readJson<QueuedNotification[]>(OUTBOX_FILE, []);
    this.log = (await this.readJson<QueuedNotification[]>(LOG_FILE, [])).slice(0, this.maxRecords);
    // Terminal state wins if a crash happened after the log write but before
    // the corresponding outbox removal write.
    const terminalIds = new Set(this.log.map((item) => item.notification.id));
    const reconciled = this.outbox.filter((item) => !terminalIds.has(item.notification.id));
    if (reconciled.length !== this.outbox.length) {
      this.outbox = reconciled;
      await this.persist(OUTBOX_FILE, this.outbox);
    }
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
    const previous = this.optIns.get(record.sessionId);
    this.optIns.set(record.sessionId, record);
    const snapshot: Record<string, OptInRecord> = {};
    for (const rec of this.optIns.values()) snapshot[rec.sessionId] = rec;
    try {
      await this.persist(OPTINS_FILE, snapshot);
    } catch (error) {
      if (previous) this.optIns.set(record.sessionId, previous);
      else this.optIns.delete(record.sessionId);
      throw error;
    }
  }

  async removeOptIn(sessionId: string): Promise<void> {
    const previous = this.optIns.get(sessionId);
    this.optIns.delete(sessionId);
    const snapshot: Record<string, OptInRecord> = {};
    for (const rec of this.optIns.values()) snapshot[rec.sessionId] = rec;
    try {
      await this.persist(OPTINS_FILE, snapshot);
    } catch (error) {
      if (previous) this.optIns.set(sessionId, previous);
      throw error;
    }
  }

  // ── Outbox ────────────────────────────────────────────────────────

  async enqueue(item: QueuedNotification): Promise<void> {
    this.outbox.push(item);
    try {
      await this.persist(OUTBOX_FILE, this.outbox);
    } catch (error) {
      const index = this.outbox.findIndex((queued) => queued === item);
      if (index !== -1) this.outbox.splice(index, 1);
      throw error;
    }
  }

  /** Reserve one ingress key until its first outbox write is durably complete. */
  async enqueueIdempotent(item: QueuedNotification): Promise<IdempotentEnqueueResult> {
    const ingress = item.ingress;
    if (!ingress) throw new Error('Idempotent enqueue requires ingress metadata.');

    const reserved = this.ingressReservations.get(ingress.keyHash);
    if (reserved) {
      await reserved.durable;
      return {
        item: reserved.item,
        duplicate: true,
        conflict: reserved.item.ingress?.fingerprint !== ingress.fingerprint,
      };
    }

    const existing = this.getByIngressKeyHash(ingress.keyHash);
    if (existing) {
      return {
        item: existing,
        duplicate: true,
        conflict: existing.ingress?.fingerprint !== ingress.fingerprint,
      };
    }

    const durable = this.enqueue(item);
    this.ingressReservations.set(ingress.keyHash, { item, durable });
    try {
      await durable;
      return { item, duplicate: false, conflict: false };
    } catch (error) {
      const idx = this.outbox.findIndex((queued) => queued === item);
      if (idx !== -1) this.outbox.splice(idx, 1);
      throw error;
    } finally {
      if (this.ingressReservations.get(ingress.keyHash)?.durable === durable) {
        this.ingressReservations.delete(ingress.keyHash);
      }
    }
  }

  listPending(): QueuedNotification[] {
    return this.outbox.slice();
  }

  getById(notificationId: string): QueuedNotification | undefined {
    return this.outbox.find((item) => item.notification.id === notificationId)
      ?? this.log.find((item) => item.notification.id === notificationId);
  }

  getByIngressKeyHash(keyHash: string): QueuedNotification | undefined {
    return this.outbox.find((item) => item.ingress?.keyHash === keyHash)
      ?? this.log.find((item) => item.ingress?.keyHash === keyHash);
  }

  /** Mark a pending item delivered: move it to the log as `sent`. */
  async markSent(notificationId: string, deliveredAt: string): Promise<void> {
    const idx = this.outbox.findIndex((q) => q.notification.id === notificationId);
    if (idx === -1) return;
    const item = this.outbox[idx];
    // Snapshot the pre-mutation in-memory state so a failed terminal-log write
    // can be rolled back: the item must remain pending (retryable) and getById
    // must not report a durable terminal state that never reached disk.
    const prevOutbox = this.outbox.slice();
    const prevLog = this.log.slice();
    const delivery: DeliveryRecord = { ...item.delivery, status: 'sent', deliveredAt };
    this.outbox.splice(idx, 1);
    this.pushLog({ notification: item.notification, delivery, ingress: item.ingress });
    // Persist terminal state first. Startup reconciliation removes an old
    // outbox copy if the process exits before the second write completes.
    try {
      await this.persist(LOG_FILE, this.log);
    } catch (err) {
      // Terminal-log write failed: roll back to pending so the item is retried
      // and in-memory matches the (unchanged) durable outbox.
      this.outbox = prevOutbox;
      this.log = prevLog;
      throw err;
    }
    // The terminal state is now durable. If the outbox-cleanup write fails we
    // keep the terminal in-memory state: startup reconciliation ("terminal wins
    // on restart") removes the stale outbox copy.
    await this.persist(OUTBOX_FILE, this.outbox);
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
      // Snapshot so a failed terminal-log write can be rolled back (see markSent).
      const prevOutbox = this.outbox.slice();
      const prevLog = this.log.slice();
      this.outbox.splice(idx, 1);
      this.pushLog({
        notification: item.notification,
        delivery: { ...item.delivery, status: 'failed', attempts, lastError },
        ingress: item.ingress,
      });
      try {
        await this.persist(LOG_FILE, this.log);
      } catch (err) {
        this.outbox = prevOutbox;
        this.log = prevLog;
        throw err;
      }
      await this.persist(OUTBOX_FILE, this.outbox);
    } else {
      this.outbox[idx] = {
        notification: item.notification,
        delivery: { ...item.delivery, status: 'pending', attempts, lastError },
        ingress: item.ingress,
      };
      await this.persist(OUTBOX_FILE, this.outbox);
    }
  }

  // ── Delivery log ──────────────────────────────────────────────────

  listLog(limit?: number): QueuedNotification[] {
    return this.log.slice(0, limit ?? this.maxLog);
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
    if (this.log.length > this.maxRecords) this.log.length = this.maxRecords;
  }

  private async readJson<T>(name: string, fallback: T): Promise<T> {
    try {
      const file = path.join(this.dir, name);
      const stats = await lstat(file);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_LEDGER_FILE_BYTES) {
        throw new Error(`unsafe or oversized notification ledger: ${name}`);
      }
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch (err) {
      // Missing file is normal on first boot — stay quiet. Anything else
      // (corrupt JSON, permission error) must not prevent the rest of the
      // collections from loading, but it must not be silent either: a
      // corrupt opt-ins.json would otherwise reset every opt-in to nothing
      // with zero trace of why.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn(`failed to read ${name}, starting from empty (previous content may be lost):`, err);
      }
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
        await chmod(this.dir, 0o700);
        const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
        const handle = await open(tmp, 'wx', 0o600);
        try {
          try {
            await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(tmp, file);
          await syncDirectory(this.dir);
        } catch (error) {
          await unlink(tmp).catch(() => { /* already renamed or removed */ });
          throw error;
        }
      });
    this.writeChains.set(name, next);
    return next;
  }
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } catch (error) {
    // File fsync + atomic rename still protects against partial JSON. Directory
    // fsync improves power-loss durability where supported but must not turn a
    // completed rename into an ambiguous failed acceptance.
    logger.warn('notification ledger directory fsync was unavailable:', error);
  } finally {
    await handle.close();
  }
}
