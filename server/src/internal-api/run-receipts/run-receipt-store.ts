import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunReceipt, RunReceiptStatus } from '../types.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('RunReceiptStore');

export interface PersistedRunReceipt extends RunReceipt {
  /** Digest only; the caller's raw idempotency key is never persisted. */
  idempotencyKeyDigest?: string;
  /** Digest of the request shape used to detect same-key collisions. */
  requestFingerprint?: string;
}

export interface RunReceiptStoreOptions {
  now?: () => number;
  maxAgeMs?: number;
  maxCount?: number;
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_COUNT = 1_000;
const TERMINAL_STATUSES = new Set<RunReceiptStatus>(['completed', 'failed', 'cancelled', 'interrupted']);
const SAFE_RUN_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,100}$/;
const ALLOWED_KEYS = new Set([
  'runId',
  'sessionId',
  'runtime',
  'executionInstanceId',
  'model',
  'status',
  'acceptedAt',
  'startedAt',
  'agentEndAt',
  'terminalAt',
  'errorCode',
  'interruptionReason',
  'idempotencyExpiresAt',
  'idempotencyKeyDigest',
  'requestFingerprint',
]);

export class RunReceiptStore {
  private readonly dir?: string;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly maxCount: number;
  private readonly cache = new Map<string, PersistedRunReceipt>();
  private readonly writeChains = new Map<string, Promise<void>>();
  /** Keep restart-recovered evidence visible through the initial prune pass. */
  private readonly recoveryProtected = new Set<string>();
  private ready = false;

  /**
   * With no directory the store is intentionally memory-only. This is used by
   * direct route unit tests; production always supplies the configured,
   * disk-backed directory.
   */
  constructor(dir?: string, options: RunReceiptStoreOptions = {}) {
    this.dir = dir;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.maxCount = options.maxCount ?? DEFAULT_MAX_COUNT;
  }

  /** Load persisted receipts and recover work interrupted by a server restart. */
  async init(): Promise<void> {
    if (this.ready) return;
    if (!this.dir) {
      this.ready = true;
      return;
    }

    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let files: string[] = [];
    try {
      files = await readdir(this.dir);
    } catch (error) {
      logger.warn(`failed to enumerate receipt directory: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(path.join(this.dir, file), 'utf8');
        const record = JSON.parse(raw) as PersistedRunReceipt;
        this.validate(record);
        this.cache.set(record.runId, record);
      } catch (error) {
        // One corrupt receipt must not make every other receipt disappear. Do
        // not log file contents: a malformed file must never become a secret
        // exfiltration path through diagnostics.
        logger.warn(`ignored invalid receipt file ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.ready = true;
    const recoveryAt = new Date(this.now()).toISOString();
    for (const record of this.cache.values()) {
      if (record.status !== 'accepted' && record.status !== 'started') continue;
      record.status = 'interrupted';
      record.terminalAt = recoveryAt;
      record.errorCode = 'SERVER_RESTART';
      record.interruptionReason = 'server_restart';
      this.recoveryProtected.add(record.runId);
      await this.persist(record);
    }
    await this.prune();
    this.recoveryProtected.clear();
  }

  get(runId: string): PersistedRunReceipt | undefined {
    const record = this.cache.get(runId);
    return record ? { ...record } : undefined;
  }

  list(): PersistedRunReceipt[] {
    return Array.from(this.cache.values(), (record) => ({ ...record }));
  }

  /** Return the newest unexpired receipt for a session-scoped key digest. */
  findByIdempotency(keyDigest: string, now = this.now()): PersistedRunReceipt | undefined {
    const matches = Array.from(this.cache.values())
      .filter((record) => record.idempotencyKeyDigest === keyDigest)
      .filter((record) => {
        const expiresAt = record.idempotencyExpiresAt ? Date.parse(record.idempotencyExpiresAt) : 0;
        return expiresAt > now;
      })
      .sort((a, b) => Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt));
    return matches[0] ? { ...matches[0] } : undefined;
  }

  async create(record: PersistedRunReceipt): Promise<void> {
    await this.ensureReady();
    this.validate(record);
    if (this.cache.has(record.runId)) {
      throw new Error(`Run receipt already exists: ${record.runId}`);
    }
    await this.persist(record);
    this.cache.set(record.runId, { ...record });
    await this.prune();
  }

  async transition(
    runId: string,
    status: RunReceiptStatus,
    patch: Partial<Pick<PersistedRunReceipt, 'startedAt' | 'agentEndAt' | 'terminalAt' | 'errorCode' | 'interruptionReason'>> & {
      /** Release a reservation that failed before runtime dispatch. */
      clearIdempotency?: boolean;
    } = {},
  ): Promise<PersistedRunReceipt> {
    await this.ensureReady();
    const current = this.cache.get(runId);
    if (!current) throw new Error(`Run receipt not found: ${runId}`);
    if (!isLegalTransition(current.status, status)) {
      throw new Error(`Invalid transition ${current.status} -> ${status} for run ${runId}`);
    }

    const { clearIdempotency, ...recordPatch } = patch;
    const next: PersistedRunReceipt = {
      ...current,
      ...recordPatch,
      status,
    };
    if (clearIdempotency) {
      delete next.idempotencyKeyDigest;
      delete next.requestFingerprint;
      delete next.idempotencyExpiresAt;
    }
    if (TERMINAL_STATUSES.has(status) && !next.terminalAt) {
      next.terminalAt = new Date(this.now()).toISOString();
    }
    this.validate(next);
    await this.persist(next);
    this.cache.set(runId, next);
    await this.prune();
    return { ...next };
  }

  async releaseIdempotency(runId: string): Promise<PersistedRunReceipt | undefined> {
    await this.ensureReady();
    const current = this.cache.get(runId);
    if (!current) return undefined;
    if (!current.idempotencyKeyDigest && !current.requestFingerprint && !current.idempotencyExpiresAt) {
      return { ...current };
    }
    const next = { ...current };
    delete next.idempotencyKeyDigest;
    delete next.requestFingerprint;
    delete next.idempotencyExpiresAt;
    this.validate(next);
    await this.persist(next);
    this.cache.set(runId, next);
    return { ...next };
  }

  async markAgentEnd(runId: string, timestamp: string): Promise<PersistedRunReceipt | undefined> {
    await this.ensureReady();
    const current = this.cache.get(runId);
    if (!current) return undefined;
    // The runtime completion callback and the agent_end event can arrive in
    // either order. Keep the evidence even when the receipt is already
    // terminal; this update is observational and does not reopen the run.
    if (!current.agentEndAt) {
      const next = { ...current, agentEndAt: timestamp };
      this.validate(next);
      await this.persist(next);
      this.cache.set(runId, next);
      return { ...next };
    }
    return { ...current };
  }

  /** Wait for atomic writes already queued for any receipt. */
  async flush(): Promise<void> {
    const results = await Promise.allSettled(this.writeChains.values());
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn(`receipt write did not flush before shutdown: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
  }

  /** Prune only terminal receipts; in-flight records must never be silently lost. */
  async prune(): Promise<void> {
    await this.ensureReady();
    const now = this.now();
    const terminal = Array.from(this.cache.values())
      .filter((record) => TERMINAL_STATUSES.has(record.status))
      .sort((a, b) => receiptTime(b) - receiptTime(a));

    for (const record of terminal) {
      if (this.recoveryProtected.has(record.runId)) continue;
      if (now - receiptTime(record) <= this.maxAgeMs) continue;
      if (isIdempotencyProtected(record, now)) continue;
      await this.delete(record.runId);
    }

    const remainingTerminal = Array.from(this.cache.values())
      .filter((record) => TERMINAL_STATUSES.has(record.status))
      .sort((a, b) => receiptTime(b) - receiptTime(a));
    if (remainingTerminal.length <= this.maxCount) return;

    for (const record of remainingTerminal.slice(this.maxCount)) {
      if (this.recoveryProtected.has(record.runId)) continue;
      if (isIdempotencyProtected(record, now)) continue;
      await this.delete(record.runId);
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) await this.init();
  }

  private fileFor(runId: string): string {
    if (!this.dir) throw new Error('RunReceiptStore has no directory');
    return path.join(this.dir, `${runId}.json`);
  }

  private async persist(record: PersistedRunReceipt): Promise<void> {
    if (!this.dir) return;
    const file = this.fileFor(record.runId);
    const payload = JSON.stringify(record, null, 2);
    const previous = this.writeChains.get(record.runId) ?? Promise.resolve();
    const next = previous
      .catch(() => { /* isolate a previous failed write */ })
      .then(async () => {
        await mkdir(this.dir!, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, file);
      });
    this.writeChains.set(record.runId, next);
    // Remove the settled chain entry so the map cannot grow unbounded — but
    // only if no newer write has chained onto this one. Runs on resolve/reject.
    const cleanup = (): void => {
      if (this.writeChains.get(record.runId) === next) {
        this.writeChains.delete(record.runId);
      }
    };
    next.then(cleanup, cleanup);
    await next;
  }

  private async delete(runId: string): Promise<void> {
    this.cache.delete(runId);
    if (!this.dir) return;
    await (this.writeChains.get(runId) ?? Promise.resolve()).catch(() => { /* prior failure is isolated */ });
    this.writeChains.delete(runId);
    try {
      await unlink(this.fileFor(runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private validate(record: PersistedRunReceipt): void {
    if (!record || typeof record !== 'object') throw new Error('Receipt must be an object');
    for (const key of Object.keys(record as unknown as Record<string, unknown>)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new Error(`Unsupported or unsafe receipt field: ${key}`);
      }
    }
    if (!SAFE_RUN_ID.test(record.runId)) throw new Error('Invalid runId');
    if (!record.sessionId || !record.runtime || !record.executionInstanceId) {
      throw new Error('Receipt identity fields are required');
    }
    if (!['pi', 'claude', 'opencode', 'antigravity'].includes(record.runtime)) {
      throw new Error('Invalid receipt runtime');
    }
    if (!['accepted', 'started', 'completed', 'failed', 'cancelled', 'interrupted'].includes(record.status)) {
      throw new Error('Invalid receipt status');
    }
    if (record.idempotencyKeyDigest !== undefined && !SAFE_DIGEST.test(record.idempotencyKeyDigest)) {
      throw new Error('Invalid idempotency key digest');
    }
    if (record.requestFingerprint !== undefined && !SAFE_DIGEST.test(record.requestFingerprint)) {
      throw new Error('Invalid request fingerprint');
    }
    if (record.errorCode !== undefined && !SAFE_ERROR_CODE.test(record.errorCode)) {
      throw new Error('Invalid receipt error code');
    }
    if (record.interruptionReason !== undefined && record.interruptionReason !== 'server_restart') {
      throw new Error('Invalid interruption reason');
    }
  }
}

function isLegalTransition(from: RunReceiptStatus, to: RunReceiptStatus): boolean {
  if (from === 'accepted') return to === 'started' || to === 'failed' || to === 'cancelled';
  if (from === 'started') return to === 'completed' || to === 'failed' || to === 'cancelled';
  return false;
}

function receiptTime(record: PersistedRunReceipt): number {
  return Date.parse(record.terminalAt ?? record.acceptedAt);
}

function isIdempotencyProtected(record: PersistedRunReceipt, now: number): boolean {
  return !!record.idempotencyExpiresAt && Date.parse(record.idempotencyExpiresAt) > now;
}
