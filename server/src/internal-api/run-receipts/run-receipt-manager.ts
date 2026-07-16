import { createHash, randomUUID } from 'node:crypto';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type {
  PromptMode,
  RunReceipt,
  RunReceiptStatus,
  SessionRuntime,
  Verbosity,
} from '../types.js';
import { RunReceiptStore, type PersistedRunReceipt } from './run-receipt-store.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('RunReceiptManager');
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export interface BeginRunInput {
  sessionId: string;
  runtime: SessionRuntime;
  executionInstanceId: string;
  model?: string;
  message: string;
  mode: PromptMode;
  verbosity: Verbosity;
  detach: boolean;
  idempotencyKey?: string;
}

export interface RunFinishOutcome {
  status?: Extract<RunReceiptStatus, 'completed' | 'failed' | 'cancelled'>;
  errorCode?: string;
}

export interface RunReceiptManagerDeps {
  store: RunReceiptStore;
  now?: () => number;
  idFactory?: () => string;
  idempotencyTtlMs?: number;
}

export type ExistingRunResult =
  | { kind: 'duplicate'; receipt: RunReceipt }
  | { kind: 'conflict'; receipt: RunReceipt };

export type BeginRunResult =
  | { kind: 'created'; receipt: RunReceipt }
  | ExistingRunResult;

export class IdempotencyKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyKeyValidationError';
  }
}

/**
 * Coordinates a prompt's durable run identity without owning any runtime.
 * Runtime services continue to provide the existing completion callback; this
 * manager records normalized agent_end as evidence and finalizes from that
 * callback so agent_end can never turn an error turn into a success.
 */
export class RunReceiptManager {
  private readonly store: RunReceiptStore;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly idempotencyTtlMs: number;
  private readonly activeBySession = new Map<string, Set<string>>();
  private readonly keyLocks = new Map<string, Promise<void>>();
  private readonly runLocks = new Map<string, Promise<void>>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(deps: RunReceiptManagerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.idFactory = deps.idFactory ?? (() => randomUUID());
    this.idempotencyTtlMs = Number.isFinite(deps.idempotencyTtlMs) && (deps.idempotencyTtlMs as number) > 0
      ? deps.idempotencyTtlMs as number
      : DEFAULT_IDEMPOTENCY_TTL_MS;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.store.init().then(() => {
        this.initialized = true;
      });
    }
    await this.initPromise;
  }

  /**
   * Check for an existing idempotent run without reserving a new run. Routes
   * use this before a session-busy check so a retry of a detached/in-flight
   * run can still receive its receipt instead of a misleading 409 busy error.
   */
  async findExistingRun(input: BeginRunInput): Promise<ExistingRunResult | undefined> {
    await this.init();
    const normalizedKey = input.idempotencyKey === undefined
      ? undefined
      : validateIdempotencyKey(input.idempotencyKey);
    if (normalizedKey === undefined) return undefined;
    return this.findExistingByKey(
      digest(`${input.sessionId}\u0000${normalizedKey}`),
      requestFingerprint(input),
    );
  }

  async beginRun(input: BeginRunInput): Promise<BeginRunResult> {
    await this.init();
    const normalizedKey = input.idempotencyKey === undefined
      ? undefined
      : validateIdempotencyKey(input.idempotencyKey);
    const fingerprint = requestFingerprint(input);
    const keyDigest = normalizedKey === undefined
      ? undefined
      : digest(`${input.sessionId}\u0000${normalizedKey}`);

    const createOrReplay = async (): Promise<BeginRunResult> => {
      const existing = keyDigest ? this.findExistingByKey(keyDigest, fingerprint) : undefined;
      if (existing) return existing;

      const acceptedAtMs = this.now();
      const record: PersistedRunReceipt = {
        runId: this.idFactory(),
        sessionId: input.sessionId,
        runtime: input.runtime,
        executionInstanceId: input.executionInstanceId,
        model: input.model,
        status: 'accepted',
        acceptedAt: new Date(acceptedAtMs).toISOString(),
        idempotencyExpiresAt: keyDigest
          ? new Date(acceptedAtMs + this.idempotencyTtlMs).toISOString()
          : undefined,
        idempotencyKeyDigest: keyDigest,
        requestFingerprint: keyDigest ? fingerprint : undefined,
      };
      await this.store.create(record);
      this.addActive(record.sessionId, record.runId);
      return { kind: 'created', receipt: toPublicReceipt(record) };
    };

    // The lock is per session-scoped key. Without it, two concurrent retries
    // can both observe an empty index before either receipt reaches disk.
    return keyDigest ? this.withKeyLock(keyDigest, createOrReplay) : createOrReplay();
  }

  async markStarted(runId: string): Promise<RunReceipt | undefined> {
    await this.init();
    return this.withRunLock(runId, () => this.markStartedUnlocked(runId));
  }

  private async markStartedUnlocked(runId: string): Promise<RunReceipt | undefined> {
    const current = this.store.get(runId);
    if (!current || isTerminal(current.status)) return current ? toPublicReceipt(current) : undefined;
    const started = await this.store.transition(runId, 'started', {
      startedAt: current.startedAt ?? new Date(this.now()).toISOString(),
    });
    return toPublicReceipt(started);
  }

  /** Record the existing normalized agent_end signal without finalizing success. */
  observeEvent(runId: string, event: NormalizedEvent): Promise<void> {
    if (event.type !== 'agent_end') return Promise.resolve();
    const eventTimestamp = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? event.timestamp
      : this.now();
    const timestamp = new Date(eventTimestamp).toISOString();
    return this.withRunLock(runId, () => this.store.markAgentEnd(runId, timestamp))
      .then(() => undefined)
      .catch((error) => {
        logger.warn(`failed to persist agent_end for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  async finish(runId: string, outcome: RunFinishOutcome = {}): Promise<RunReceipt | undefined> {
    await this.init();
    return this.withRunLock(runId, () => this.finishUnlocked(runId, outcome));
  }

  private async finishUnlocked(runId: string, outcome: RunFinishOutcome): Promise<RunReceipt | undefined> {
    let current = this.store.get(runId);
    if (!current) return undefined;
    if (isTerminal(current.status)) return toPublicReceipt(current);

    // Be defensive for a runtime that completes synchronously before its caller
    // has explicitly marked the run started.
    if (current.status === 'accepted') {
      await this.markStartedUnlocked(runId);
      current = this.store.get(runId);
      if (!current) return undefined;
    }

    const status = outcome.status ?? (outcome.errorCode ? 'failed' : 'completed');
    const terminal = await this.store.transition(runId, status, {
      errorCode: outcome.errorCode,
      terminalAt: new Date(this.now()).toISOString(),
    });
    this.removeActive(terminal.sessionId, terminal.runId);
    return toPublicReceipt(terminal);
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.init();
    const active = Array.from(this.activeBySession.get(sessionId) ?? []);
    await Promise.all(active.map((runId) => this.finish(runId, { status: 'cancelled' })));
  }

  async cancelRun(runId: string): Promise<RunReceipt | undefined> {
    await this.init();
    return this.finish(runId, { status: 'cancelled' });
  }

  get(runId: string): RunReceipt | undefined {
    const record = this.store.get(runId);
    return record ? toPublicReceipt(record) : undefined;
  }

  listBySession(sessionId: string): RunReceipt[] {
    return this.store.list()
      .filter((record) => record.sessionId === sessionId)
      .map(toPublicReceipt);
  }

  /** Flush pending receipt writes before the server process is allowed to exit. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([
      ...this.keyLocks.values(),
      ...this.runLocks.values(),
    ]);
    await this.store.flush();
    this.activeBySession.clear();
    this.keyLocks.clear();
    this.runLocks.clear();
  }

  private addActive(sessionId: string, runId: string): void {
    let runs = this.activeBySession.get(sessionId);
    if (!runs) {
      runs = new Set();
      this.activeBySession.set(sessionId, runs);
    }
    runs.add(runId);
  }

  private removeActive(sessionId: string, runId: string): void {
    const runs = this.activeBySession.get(sessionId);
    if (!runs) return;
    runs.delete(runId);
    if (runs.size === 0) this.activeBySession.delete(sessionId);
  }

  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.runLocks.set(runId, current);
    await previous.catch(() => { /* isolate a failed earlier finalizer */ });
    try {
      return await operation();
    } finally {
      release();
      if (this.runLocks.get(runId) === current) this.runLocks.delete(runId);
    }
  }

  private async withKeyLock<T>(keyDigest: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.keyLocks.get(keyDigest) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.keyLocks.set(keyDigest, current);
    await previous.catch(() => { /* isolate a failed earlier reservation */ });
    try {
      return await operation();
    } finally {
      release();
      if (this.keyLocks.get(keyDigest) === current) this.keyLocks.delete(keyDigest);
    }
  }

  private findExistingByKey(keyDigest: string, fingerprint: string): ExistingRunResult | undefined {
    const existing = this.store.findByIdempotency(keyDigest, this.now());
    if (!existing) return undefined;
    const publicReceipt = toPublicReceipt(existing);
    if (existing.requestFingerprint !== fingerprint) {
      return { kind: 'conflict', receipt: publicReceipt };
    }
    return { kind: 'duplicate', receipt: publicReceipt };
  }
}

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new IdempotencyKeyValidationError('idempotencyKey must be a string');
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new IdempotencyKeyValidationError('idempotencyKey must not be empty');
  }
  if (normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new IdempotencyKeyValidationError(`idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (hasControlCharacter) {
    throw new IdempotencyKeyValidationError('idempotencyKey must not contain control characters');
  }
  return normalized;
}

function requestFingerprint(input: BeginRunInput): string {
  return digest(JSON.stringify({
    message: input.message,
    mode: input.mode,
    verbosity: input.verbosity,
    detach: input.detach,
  }));
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isTerminal(status: RunReceiptStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

function toPublicReceipt(record: PersistedRunReceipt): RunReceipt {
  const {
    idempotencyKeyDigest: _idempotencyKeyDigest,
    requestFingerprint: _requestFingerprint,
    ...publicReceipt
  } = record;
  return { ...publicReceipt };
}
