/**
 * Pin Expiry Manager
 *
 * Owns the lifecycle of API-initiated session pins: granting a pin with an
 * absolute TTL, re-applying non-expired pins after a server restart, revoking
 * pins whose deadline has passed, and surfacing the deadline so agents can see
 * when their pin expires.
 *
 * Design notes:
 *  - A pin is *time-bounded by default*. Default 24h, hard cap 7d. This is the
 *    "don't hog a pin slot forever" safety valve the feature exists to provide.
 *  - The deadline is absolute (`pinnedUntil`), not idle-based, so even a pin on
 *    a session that stays busy is guaranteed to be revoked eventually.
 *  - Re-pinning (calling {@link applyPin} again) extends the deadline.
 *  - The disk-backed {@link PinExpiryStore} makes the guarantee survive a
 *    restart: on init, non-expired pins are re-applied in memory and already-
 *    expired ones are revoked immediately.
 *
 * This manager only tracks API-initiated pins. Web-UI pins are managed via the
 * preferences file and their own idle-based auto-unpin, independently.
 */

import { PinExpiryStore } from './pin-expiry-store.js';
import type { SessionRuntime } from './types.js';

/** Default pin lifetime: 24 hours. */
export const DEFAULT_PIN_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard maximum pin lifetime: 7 days. A longer requested TTL is clamped to this. */
export const MAX_PIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the expiry sweep runs. */
export const DEFAULT_PIN_EXPIRY_INTERVAL_MS = 5 * 60 * 1000;

export interface PinExpiryManagerDeps {
  /** Directory for the durable pin ledger. */
  dir: string;
  /** Pin a session in its runtime (in-memory). Returns false if at the pin limit. */
  pin: (sessionId: string) => Promise<boolean> | boolean;
  /** Revoke a session's pin in its runtime. */
  unpin: (sessionId: string) => Promise<boolean> | boolean;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  intervalMs?: number;
  logger?: (message: string) => void;
}

export interface ApplyPinOptions {
  /** Requested lifetime in seconds. Defaults to {@link DEFAULT_PIN_TTL_MS}; clamped to the max. */
  ttlSeconds?: number;
  sessionPath?: string;
  runtime?: SessionRuntime;
  label?: string;
}

export interface ApplyPinResult {
  pinned: boolean;
  /** Absolute deadline in ms since epoch (only when pinned). */
  pinnedUntil?: number;
  /** Why a pin was not granted, when pinned is false. */
  reason?: 'PIN_LIMIT_REACHED';
}

export interface ExpiryResult {
  expired: string[];
}

function noopLogger(): void { /* silent by default */ }

export class PinExpiryManager {
  private readonly store: PinExpiryStore;
  private readonly pin: (sessionId: string) => Promise<boolean> | boolean;
  private readonly unpin: (sessionId: string) => Promise<boolean> | boolean;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly intervalMs: number;
  private readonly log: (message: string) => void;
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: PinExpiryManagerDeps) {
    this.store = new PinExpiryStore(deps.dir);
    this.pin = deps.pin;
    this.unpin = deps.unpin;
    this.defaultTtlMs = deps.defaultTtlMs ?? DEFAULT_PIN_TTL_MS;
    this.maxTtlMs = deps.maxTtlMs ?? MAX_PIN_TTL_MS;
    this.intervalMs = deps.intervalMs ?? DEFAULT_PIN_EXPIRY_INTERVAL_MS;
    this.log = deps.logger ?? noopLogger;
  }

  /**
   * Load the ledger from disk, revoke any pins that already expired while the
   * server was down, and re-apply still-valid pins in memory (runtimes lose
   * their in-memory pin state on restart). Must be called before {@link start}.
   */
  async init(): Promise<void> {
    await this.store.init();
    const now = Date.now();
    for (const record of this.store.list()) {
      if (record.pinnedUntil <= now) {
        await this.callUnpin(record.sessionId);
        await this.store.delete(record.sessionId);
        this.log(`Revoked expired API pin on restart: ${record.sessionId}`);
      } else {
        await this.callPin(record.sessionId);
      }
    }
  }

  /** Start the periodic expiry sweep. Safe to call once after {@link init}. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.expireNow().catch((err) => {
        this.log(`Pin expiry sweep error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Grant (or refresh) an API pin with an absolute deadline and record it.
   * Re-pinning an already-pinned session extends its deadline.
   */
  async applyPin(sessionId: string, options: ApplyPinOptions = {}): Promise<ApplyPinResult> {
    const ttlMs = this.resolveTtlMs(options.ttlSeconds);
    const pinnedUntil = Date.now() + ttlMs;

    const ok = await this.callPin(sessionId);
    if (!ok) {
      return { pinned: false, reason: 'PIN_LIMIT_REACHED' };
    }

    await this.store.save({
      sessionId,
      sessionPath: options.sessionPath,
      runtime: options.runtime,
      pinnedAt: Date.now(),
      pinnedUntil,
      label: options.label,
    });

    return { pinned: true, pinnedUntil };
  }

  /** Remove a pin's ledger record (e.g. after a manual unpin or session delete). */
  async clear(sessionId: string): Promise<void> {
    await this.store.delete(sessionId);
  }

  /** The absolute deadline (ms since epoch) for a session's API pin, if any. */
  getPinnedUntil(sessionId: string): number | undefined {
    return this.store.get(sessionId)?.pinnedUntil;
  }

  /** Revoke every pin whose deadline has passed. Runs on the timer; also callable directly. */
  async expireNow(): Promise<ExpiryResult> {
    const now = Date.now();
    const expired: string[] = [];
    for (const record of this.store.list()) {
      if (record.pinnedUntil <= now) {
        await this.callUnpin(record.sessionId);
        await this.store.delete(record.sessionId);
        expired.push(record.sessionId);
        this.log(`Revoked expired API pin: ${record.sessionId}`);
      }
    }
    return { expired };
  }

  /** Resolve a requested TTL (seconds) to a clamped millisecond duration. */
  private resolveTtlMs(ttlSeconds?: number): number {
    let ttlMs: number;
    if (typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds)) {
      ttlMs = Math.max(0, Math.floor(ttlSeconds * 1000));
    } else {
      ttlMs = this.defaultTtlMs;
    }
    return Math.min(ttlMs, this.maxTtlMs);
  }

  /** Invoke the pin callback, normalizing sync/async and swallowing errors. */
  private async callPin(sessionId: string): Promise<boolean> {
    try {
      return await Promise.resolve(this.pin(sessionId));
    } catch {
      return false;
    }
  }

  /** Invoke the unpin callback, normalizing sync/async and swallowing errors. */
  private async callUnpin(sessionId: string): Promise<void> {
    try {
      await Promise.resolve(this.unpin(sessionId));
    } catch {
      /* session may be gone */
    }
  }
}
