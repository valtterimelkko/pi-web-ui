/**
 * Durable, source-owned Internal API retention leases.
 *
 * `durable` protects recoverability metadata only. `resident` additionally
 * applies an independently keyed runtime keepalive claim. Lease ownership is a
 * cooperative correctness guard for trusted same-host clients, not RBAC.
 */

import { randomUUID } from 'node:crypto';
import { PinExpiryStore, type PersistedApiPin, type RetentionMode } from './pin-expiry-store.js';
import type { SessionRuntime } from './types.js';

export const DEFAULT_PIN_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PIN_EXPIRY_INTERVAL_MS = 5 * 60 * 1000;

export interface PinExpiryManagerDeps {
  dir: string;
  pin: (sessionId: string, claimId?: string) => Promise<boolean> | boolean;
  unpin: (sessionId: string, claimId?: string) => Promise<boolean> | boolean;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  intervalMs?: number;
  logger?: (message: string) => void;
}

export interface ApplyPinOptions {
  ttlSeconds?: number;
  sessionPath?: string;
  runtime?: SessionRuntime;
  label?: string;
  mode?: RetentionMode;
  ownerId?: string;
}

export interface ApplyPinResult {
  pinned: boolean;
  pinnedUntil?: number;
  retentionLeaseId?: string;
  retentionMode?: RetentionMode;
  reason?: 'PIN_LIMIT_REACHED';
}

export interface ExpiryResult { expired: string[] }

function noopLogger(): void { /* silent by default */ }
function runtimeClaim(leaseId: string): string { return `internal-api:${leaseId}`; }

export class PinExpiryManager {
  private readonly store: PinExpiryStore;
  private readonly pin: PinExpiryManagerDeps['pin'];
  private readonly unpin: PinExpiryManagerDeps['unpin'];
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly intervalMs: number;
  private readonly log: (message: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private readonly leaseOperations = new Map<string, Promise<unknown>>();

  constructor(deps: PinExpiryManagerDeps) {
    this.store = new PinExpiryStore(deps.dir);
    this.pin = deps.pin;
    this.unpin = deps.unpin;
    this.defaultTtlMs = deps.defaultTtlMs ?? DEFAULT_PIN_TTL_MS;
    this.maxTtlMs = deps.maxTtlMs ?? MAX_PIN_TTL_MS;
    this.intervalMs = deps.intervalMs ?? DEFAULT_PIN_EXPIRY_INTERVAL_MS;
    this.log = deps.logger ?? noopLogger;
  }

  async init(): Promise<void> {
    await this.store.init();
    const now = Date.now();
    for (const record of this.store.list()) {
      if (record.pinnedUntil <= now) {
        await this.removeLease(record);
        this.log(`Revoked expired API retention lease on restart: ${record.leaseId}`);
      } else if ((record.mode ?? 'resident') === 'resident') {
        // A Pi session may not be materialised yet. Keep the durable lease even
        // when the runtime claim cannot be applied; reapplyForSession() retries
        // after lazy hydration.
        await this.callPin(record.sessionId, runtimeClaim(record.leaseId));
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.expireNow().catch((error) => this.log(`Retention expiry sweep error: ${error instanceof Error ? error.message : String(error)}`));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Legacy pin API: one renewable compatibility lease per session. */
  async applyPin(sessionId: string, options: ApplyPinOptions = {}): Promise<ApplyPinResult> {
    const existing = this.store.listForSession(sessionId)
      .find((record) => record.ownerId === 'legacy-internal-api');
    if (existing) return this.renewLease(sessionId, existing.leaseId, options.ttlSeconds);
    return this.acquireLease(sessionId, { ...options, mode: 'resident', ownerId: 'legacy-internal-api' });
  }

  async acquireLease(sessionId: string, options: ApplyPinOptions = {}): Promise<ApplyPinResult> {
    const leaseId = randomUUID();
    const mode = options.mode ?? 'resident';
    const pinnedUntil = Date.now() + this.resolveTtlMs(options.ttlSeconds);
    if (mode === 'resident') {
      const ok = await this.callPin(sessionId, runtimeClaim(leaseId));
      if (!ok) return { pinned: false, reason: 'PIN_LIMIT_REACHED' };
    }

    const record: PersistedApiPin = {
      leaseId,
      sessionId,
      sessionPath: options.sessionPath,
      runtime: options.runtime,
      mode,
      ownerId: options.ownerId,
      pinnedAt: Date.now(),
      pinnedUntil,
      label: options.label,
    };
    try {
      await this.store.save(record);
    } catch (error) {
      if (mode === 'resident') await this.callUnpin(sessionId, runtimeClaim(leaseId));
      await this.store.deleteLease(leaseId);
      throw error;
    }
    return {
      pinned: mode === 'resident',
      pinnedUntil,
      retentionLeaseId: leaseId,
      retentionMode: mode,
    };
  }

  renewLease(sessionId: string, leaseId: string, ttlSeconds?: number): Promise<ApplyPinResult> {
    return this.withLeaseOperation(leaseId, async () => {
      const record = this.store.getByLeaseId(leaseId);
      if (!record || record.sessionId !== sessionId) throw new Error('RETENTION_CLAIM_NOT_FOUND');
      const pinnedUntil = Date.now() + this.resolveTtlMs(ttlSeconds);
      const updated = { ...record, pinnedUntil };
      if ((record.mode ?? 'resident') === 'resident') {
        const ok = await this.callPin(sessionId, runtimeClaim(leaseId));
        if (!ok) return { pinned: false, reason: 'PIN_LIMIT_REACHED' };
      }
      await this.store.save(updated);
      return {
        pinned: (record.mode ?? 'resident') === 'resident',
        pinnedUntil,
        retentionLeaseId: leaseId,
        retentionMode: record.mode ?? 'resident',
      };
    });
  }

  releaseLease(sessionId: string, leaseId: string, ownerId?: string): Promise<void> {
    return this.withLeaseOperation(leaseId, async () => {
      const record = this.store.getByLeaseId(leaseId);
      if (!record || record.sessionId !== sessionId) throw new Error('RETENTION_CLAIM_NOT_FOUND');
      if (ownerId !== undefined && record.ownerId !== ownerId) throw new Error('RETENTION_CLAIM_OWNER_MISMATCH');
      await this.removeLease(record);
    });
  }

  /** Legacy unpin releases only its compatibility lease. */
  async releaseLegacyLease(sessionId: string): Promise<void> {
    const record = this.store.listForSession(sessionId)
      .find((candidate) => candidate.ownerId === 'legacy-internal-api');
    if (record) await this.releaseLease(sessionId, record.leaseId, 'legacy-internal-api');
  }

  /** Release every Internal API lease for explicit session deletion. */
  async clear(sessionId: string): Promise<void> {
    for (const record of this.store.listForSession(sessionId)) {
      await this.releaseLease(sessionId, record.leaseId);
    }
  }

  listLeases(sessionId: string): PersistedApiPin[] {
    return this.store.listForSession(sessionId);
  }

  async reapplyForSession(sessionId: string): Promise<void> {
    for (const record of this.store.listForSession(sessionId)) {
      if (record.pinnedUntil > Date.now() && (record.mode ?? 'resident') === 'resident') {
        await this.callPin(sessionId, runtimeClaim(record.leaseId));
      }
    }
  }

  getPinnedUntil(sessionId: string): number | undefined {
    const deadlines = this.store.listForSession(sessionId)
      .filter((record) => (record.mode ?? 'resident') === 'resident')
      .map((record) => record.pinnedUntil);
    return deadlines.length ? Math.max(...deadlines) : undefined;
  }

  async expireNow(): Promise<ExpiryResult> {
    const now = Date.now();
    const expired: string[] = [];
    for (const record of this.store.list()) {
      if (record.pinnedUntil <= now) {
        const removed = await this.withLeaseOperation(record.leaseId, async () => {
          const current = this.store.getByLeaseId(record.leaseId);
          if (!current || current.pinnedUntil > now) return false;
          await this.removeLease(current);
          return true;
        });
        if (removed) {
          expired.push(record.sessionId);
          this.log(`Revoked expired API retention lease: ${record.leaseId}`);
        }
      }
    }
    return { expired };
  }

  private withLeaseOperation<T>(leaseId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.leaseOperations.get(leaseId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.leaseOperations.set(leaseId, next);
    void next.then(
      () => { if (this.leaseOperations.get(leaseId) === next) this.leaseOperations.delete(leaseId); },
      () => { if (this.leaseOperations.get(leaseId) === next) this.leaseOperations.delete(leaseId); },
    );
    return next;
  }

  private resolveTtlMs(ttlSeconds?: number): number {
    const requested = typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds)
      ? Math.max(0, Math.floor(ttlSeconds * 1000))
      : this.defaultTtlMs;
    return Math.min(requested, this.maxTtlMs);
  }

  private async removeLease(record: PersistedApiPin): Promise<void> {
    await this.revokeRuntimeClaim(record);
    try {
      await this.store.deleteLease(record.leaseId);
    } catch (error) {
      // The durable record still exists, so restore its resident claim rather
      // than report a release that will silently reappear after restart.
      if ((record.mode ?? 'resident') === 'resident') {
        await this.callPin(record.sessionId, runtimeClaim(record.leaseId));
      }
      throw error;
    }
  }

  private async revokeRuntimeClaim(record: PersistedApiPin): Promise<void> {
    if ((record.mode ?? 'resident') === 'resident') {
      await this.callUnpin(record.sessionId, runtimeClaim(record.leaseId));
    }
  }

  private async callPin(sessionId: string, claimId: string): Promise<boolean> {
    try { return await Promise.resolve(this.pin(sessionId, claimId)); } catch { return false; }
  }

  private async callUnpin(sessionId: string, claimId: string): Promise<void> {
    try { await Promise.resolve(this.unpin(sessionId, claimId)); } catch { /* session may be gone */ }
  }
}
