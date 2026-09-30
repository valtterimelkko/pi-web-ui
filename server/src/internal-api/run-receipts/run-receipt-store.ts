import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RUN_TERMINAL_REASON_ALLOWLIST } from '../types.js';
import type {
  Phase7PiShadowClassification,
  RunLivenessEvidence,
  RunReceipt,
  RunReceiptStatus,
  RunTerminalObservation,
  RunTokenUsage,
  RunOutputEvidence,
} from '../types.js';
import { createLogger } from '../../logging/logger.js';
import { FINAL_TEXT_MAX_CHARS } from './final-text.js';
import { COMPLETION_BLOCK_MAX_CHARS, COMPLETION_SCHEMA_NAME } from '../completion/completion-schema.js';

const logger = createLogger('RunReceiptStore');

export interface PersistedRunReceipt extends RunReceipt {
  /** Digest only; the caller's raw idempotency key is never persisted. */
  idempotencyKeyDigest?: string;
  /** Digest of the request shape used to detect same-key collisions. */
  requestFingerprint?: string;
}

export type RestartInterruptionReason = 'server_restart' | 'drain_timeout';

/** One run this boot recovered from a nonterminal state (B4, contract 1.51.0). */
export interface RecoveredRun {
  runId: string;
  sessionId: string;
  runtime: RunReceipt['runtime'];
  terminalAt: string;
  errorCode: 'SERVER_RESTART';
  interruptionReason: RestartInterruptionReason;
}

export interface RunReceiptStoreOptions {
  now?: () => number;
  maxAgeMs?: number;
  maxCount?: number;
  /**
   * B4: classify a run recovered at boot. `drain_timeout` marks a run a
   * drain-then-restart announced as cut off; anything else is an unplanned
   * `server_restart`. Defaults to `server_restart`.
   */
  classifyRecovery?: (record: PersistedRunReceipt) => RestartInterruptionReason;
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
  'modelSelector',
  'servedModel',
  'modelRebound',
  'effort',
  'defaultEffort',
  'tokenUsage',
  'outputEvidence',
  'finalText',
  'finalTextTruncated',
  'completion',
  'completionDelimiter',
  'completionError',
  'mode',
  'dispatchMode',
  'status',
  'acceptedAt',
  'startedAt',
  'agentEndAt',
  'terminalAt',
  'errorCode',
  'interruptionReason',
  'liveness',
  'phase7Shadow',
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
  private readonly classifyRecovery?: (record: PersistedRunReceipt) => RestartInterruptionReason;
  /** Runs this process recovered at init (B4): the watch layer fires parents' watches for them. */
  private recovered: RecoveredRun[] = [];
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
    this.classifyRecovery = options.classifyRecovery;
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
      if (record.status !== 'accepted' && record.status !== 'queued' && record.status !== 'started') continue;
      let interruptionReason: RestartInterruptionReason = 'server_restart';
      try {
        if (this.classifyRecovery?.(record) === 'drain_timeout') interruptionReason = 'drain_timeout';
      } catch { /* classification is advisory; default to an unplanned restart */ }
      record.status = 'interrupted';
      record.terminalAt = recoveryAt;
      record.errorCode = 'SERVER_RESTART';
      record.interruptionReason = interruptionReason;
      this.recovered.push({
        runId: record.runId,
        sessionId: record.sessionId,
        runtime: record.runtime,
        terminalAt: recoveryAt,
        errorCode: 'SERVER_RESTART',
        interruptionReason,
      });
      if (record.liveness) {
        record.liveness = {
          ...record.liveness,
          cessation: {
            state: 'unknown',
            basis: 'server_restart',
            observedAt: recoveryAt,
          },
        };
      }
      this.recoveryProtected.add(record.runId);
      await this.persist(record);
    }
    await this.prune();
    this.recoveryProtected.clear();
  }

  /** Runs recovered from a nonterminal state by this process's init (B4). */
  getRecoveredRuns(): RecoveredRun[] {
    return this.recovered.map((run) => ({ ...run }));
  }

  get(runId: string): PersistedRunReceipt | undefined {
    const record = this.cache.get(runId);
    return record ? cloneReceipt(record) : undefined;
  }

  list(): PersistedRunReceipt[] {
    return Array.from(this.cache.values(), cloneReceipt);
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
    return matches[0] ? cloneReceipt(matches[0]) : undefined;
  }

  async create(record: PersistedRunReceipt): Promise<void> {
    await this.ensureReady();
    this.validate(record);
    if (this.cache.has(record.runId)) {
      throw new Error(`Run receipt already exists: ${record.runId}`);
    }
    await this.persist(record);
    this.cache.set(record.runId, cloneReceipt(record));
    await this.prune();
  }

  async transition(
    runId: string,
    status: RunReceiptStatus,
    patch: Partial<Pick<PersistedRunReceipt, 'startedAt' | 'agentEndAt' | 'terminalAt' | 'errorCode' | 'interruptionReason' | 'liveness' | 'phase7Shadow' | 'outputEvidence' | 'finalText' | 'finalTextTruncated' | 'completion' | 'completionDelimiter' | 'completionError'>> & {
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
    this.cache.set(runId, cloneReceipt(next));
    await this.prune();
    return cloneReceipt(next);
  }

  async patch(
    runId: string,
    patch: Partial<Pick<PersistedRunReceipt, 'dispatchMode' | 'liveness' | 'phase7Shadow' | 'outputEvidence' | 'servedModel' | 'modelRebound'>>,
  ): Promise<PersistedRunReceipt | undefined> {
    await this.ensureReady();
    const current = this.cache.get(runId);
    if (!current) return undefined;
    if (TERMINAL_STATUSES.has(current.status)) return cloneReceipt(current);
    const next = { ...current, ...patch };
    this.validate(next);
    await this.persist(next);
    this.cache.set(runId, cloneReceipt(next));
    return cloneReceipt(next);
  }

  /** Persist positive resource cessation evidence even after terminalisation. */
  async markResourceQuiescent(runId: string, observedAt: string): Promise<PersistedRunReceipt | undefined> {
    await this.ensureReady();
    const current = this.cache.get(runId);
    if (!current || !current.liveness) return current ? cloneReceipt(current) : undefined;
    const next: PersistedRunReceipt = {
      ...current,
      liveness: {
        ...current.liveness,
        cessation: { state: 'confirmed', basis: 'resource_quiescence', observedAt },
      },
    };
    this.validate(next);
    await this.persist(next);
    this.cache.set(runId, cloneReceipt(next));
    return cloneReceipt(next);
  }

  async releaseIdempotency(runId: string): Promise<PersistedRunReceipt | undefined> {
    await this.ensureReady();
    const current = this.cache.get(runId);
    if (!current) return undefined;
    if (!current.idempotencyKeyDigest && !current.requestFingerprint && !current.idempotencyExpiresAt) {
      return cloneReceipt(current);
    }
    const next = { ...current };
    delete next.idempotencyKeyDigest;
    delete next.requestFingerprint;
    delete next.idempotencyExpiresAt;
    this.validate(next);
    await this.persist(next);
    this.cache.set(runId, cloneReceipt(next));
    return cloneReceipt(next);
  }

  async markAgentEnd(
    runId: string,
    timestamp: string,
    observation?: Omit<RunTerminalObservation, 'late'>,
    tokenUsage?: RunTokenUsage,
    outputEvidence?: RunOutputEvidence,
    finalText?: { text: string; truncated: boolean },
    completion?: { completion?: RunReceipt['completion']; completionDelimiter?: RunReceipt['completionDelimiter']; completionError?: RunReceipt['completionError'] },
  ): Promise<PersistedRunReceipt | undefined> {
    await this.ensureReady();
    const current = this.cache.get(runId);
    if (!current) return undefined;
    // The runtime completion callback and the agent_end event can arrive in
    // either order. Keep the evidence even when the receipt is already
    // terminal; this update is observational and does not reopen the run.
    const next: PersistedRunReceipt = {
      ...current,
      agentEndAt: current.agentEndAt ?? timestamp,
      // The first validated terminal-result observation is authoritative for
      // this run. A late duplicate must never replace it with a cumulative or
      // otherwise different snapshot.
      ...(tokenUsage && current.tokenUsage === undefined ? { tokenUsage } : {}),
      ...(outputEvidence && current.outputEvidence === undefined ? { outputEvidence } : {}),
      // Contract 1.47.0: first observation wins here; finish() refreshes it
      // from the live tracker while the run is still owned in-process.
      ...(finalText && current.finalText === undefined
        ? { finalText: finalText.text, finalTextTruncated: finalText.truncated }
        : {}),
      // Contract 1.58.0 (C3a): completion capture, same first-wins pattern;
      // finish() recomputes it from the live tracker while owned in-process.
      ...(completion?.completion && current.completion === undefined
        ? { completion: completion.completion, ...(completion.completionDelimiter ? { completionDelimiter: completion.completionDelimiter } : {}) }
        : {}),
      ...(completion?.completionError && current.completionError === undefined ? { completionError: completion.completionError } : {}),
    };
    if (observation && current.liveness) {
      const terminalObservation: RunTerminalObservation = {
        ...observation,
        late: TERMINAL_STATUSES.has(current.status),
      };
      const observations = [...(current.liveness.terminalObservations ?? [])];
      const duplicate = observations.some((candidate) =>
        candidate.type === terminalObservation.type
        && candidate.occurredAt === terminalObservation.occurredAt
        && candidate.origin === terminalObservation.origin
        && candidate.reason === terminalObservation.reason);
      if (!duplicate) observations.push(terminalObservation);
      const preserveTerminalCessation = TERMINAL_STATUSES.has(current.status)
        && (current.liveness.cessation.basis === 'watchdog'
          || current.liveness.cessation.basis === 'server_restart');
      next.liveness = {
        ...current.liveness,
        lastEligibleActivity: {
          eventType: 'agent_end',
          occurredAt: observation.occurredAt,
          observedAt: observation.observedAt,
        },
        terminalObservations: observations.slice(-4),
        cessation: preserveTerminalCessation
          ? current.liveness.cessation
          : {
              state: 'unconfirmed',
              basis: observation.origin === 'synthetic' ? 'synthetic_terminal_signal' : 'terminal_signal',
              observedAt: observation.observedAt,
            },
      };
    }
    this.validate(next);
    await this.persist(next);
    this.cache.set(runId, cloneReceipt(next));
    return cloneReceipt(next);
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
    if (!['pi', 'claude', 'opencode', 'antigravity', 'commandcode'].includes(record.runtime)) {
      throw new Error('Invalid receipt runtime');
    }
    if (record.runtime === 'commandcode') {
      if (record.executionInstanceId !== 'commandcode-default') throw new Error('Command Code receipts require the commandcode-default execution instance');
    }
    if (!['accepted', 'queued', 'started', 'completed', 'failed', 'cancelled', 'interrupted'].includes(record.status)) {
      throw new Error('Invalid receipt status');
    }
    if (record.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(record.effort)) throw new Error('Invalid Command Code effort');
    if (record.runtime === 'commandcode') {
      const model = record.model ?? record.modelSelector;
      if (!model) throw new Error('Command Code receipts require a model binding');
      if (record.model !== undefined && record.modelSelector !== undefined && record.model !== record.modelSelector) {
        throw new Error('Command Code receipt model and modelSelector bindings differ');
      }
    }
    if (record.tokenUsage !== undefined) validateTokenUsage(record.tokenUsage, record.runtime);
    if (record.outputEvidence !== undefined) validateOutputEvidence(record.outputEvidence);
    if (record.finalText !== undefined || record.finalTextTruncated !== undefined) {
      if (typeof record.finalText !== 'string' || record.finalText.length > FINAL_TEXT_MAX_CHARS) {
        throw new Error(`Invalid finalText (string of at most ${FINAL_TEXT_MAX_CHARS} characters required)`);
      }
      if (typeof record.finalTextTruncated !== 'boolean') {
        throw new Error('Invalid finalTextTruncated (boolean required alongside finalText)');
      }
    }
    if (record.completion !== undefined) validateStoredCompletion(record.completion);
    if (record.completionDelimiter !== undefined) {
      if (record.completion === undefined) throw new Error('completionDelimiter requires completion');
      if (!['completion', 'json-tagged'].includes(record.completionDelimiter)) throw new Error('Invalid completionDelimiter');
    }
    if (record.completionError !== undefined) validateStoredCompletionError(record.completionError);
    if (record.runtime !== 'commandcode' && ['effort', 'tokenUsage'].some((key) => (record as unknown as Record<string, unknown>)[key] !== undefined)) throw new Error('Native effort/token usage fields require the Command Code runtime');
    if (record.mode !== undefined && !['prompt', 'follow_up', 'steer'].includes(record.mode)) {
      throw new Error('Invalid receipt mode');
    }
    if (record.dispatchMode !== undefined && !['prompt', 'follow_up', 'steer'].includes(record.dispatchMode)) {
      throw new Error('Invalid receipt dispatch mode');
    }
    if (record.servedModel !== undefined && (typeof record.servedModel !== 'string' || record.servedModel.length === 0 || record.servedModel.length > 200)) {
      throw new Error('Invalid servedModel');
    }
    if (record.modelRebound !== undefined && typeof record.modelRebound !== 'boolean') {
      throw new Error('Invalid modelRebound');
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
    if (record.interruptionReason !== undefined && record.interruptionReason !== 'server_restart' && record.interruptionReason !== 'drain_timeout') {
      throw new Error('Invalid interruption reason');
    }
    if (record.liveness !== undefined) validateLiveness(record.liveness);
    if (record.phase7Shadow !== undefined) {
      if (record.runtime !== 'pi') throw new Error('Phase 7 shadow evidence requires the Pi runtime');
      validatePhase7Shadow(record.phase7Shadow);
      if (record.phase7Shadow.affinity.sessionId !== record.sessionId) throw new Error('Phase 7 shadow affinity does not match receipt session');
    }
  }
}

const PHASE7_SHADOW_REASON_CODES = new Set([
  'default_standard',
  'message_tool_signal',
  'message_fork_or_memory_signal',
  'prompt_size_threshold',
  'tool_event_threshold',
  'turn_duration_threshold',
]);
const PHASE7_SHADOW_KEYS = new Set([
  'policyVersion',
  'mode',
  'profile',
  'reasonCodes',
  'affinity',
  'resourceIdentity',
  'evidence',
]);
const PHASE7_AFFINITY_KEYS = new Set(['kind', 'sessionId', 'ownership']);
const PHASE7_RESOURCE_KEYS = new Set(['kind', 'boundary', 'ownership', 'sessionScoped']);
const PHASE7_EVIDENCE_KEYS = new Set(['promptBytes', 'toolEventCount', 'durationMs']);

const LIVENESS_KEYS = new Set([
  'activityPolicyVersion',
  'idleTimeoutMs',
  'absoluteTimeoutMs',
  'lastEligibleActivity',
  'watchdog',
  'terminalObservations',
  'cessation',
]);
const ACTIVITY_KEYS = new Set(['eventType', 'occurredAt', 'observedAt']);
const WATCHDOG_KEYS = new Set(['reason', 'decidedAt', 'idleTimeoutMs', 'absoluteTimeoutMs', 'startWindowMs']);
const TERMINAL_OBSERVATION_KEYS = new Set(['type', 'occurredAt', 'observedAt', 'origin', 'reason', 'late']);
const CESSATION_KEYS = new Set(['state', 'basis', 'observedAt']);
const OUTPUT_EVIDENCE_KEYS = new Set(['policyVersion', 'source', 'assistantMessages', 'assistantTextBlocks', 'assistantTextChars', 'toolCalls', 'disposition']);
const SAFE_EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

function assertOnlyKeys(value: object, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported or unsafe ${label} field: ${key}`);
  }
}

function assertIsoTimestamp(value: string, label: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label}`);
}

function validatePhase7Shadow(value: Phase7PiShadowClassification): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Phase 7 shadow evidence');
  assertOnlyKeys(value, PHASE7_SHADOW_KEYS, 'Phase 7 shadow');
  if (value.policyVersion !== 'phase7-pi-shadow/v1') throw new Error('Invalid Phase 7 shadow policy version');
  if (value.mode !== 'shadow') throw new Error('Invalid Phase 7 shadow mode');
  if (!['standard', 'heavy', 'long-horizon'].includes(value.profile)) throw new Error('Invalid Phase 7 shadow profile');
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.length < 1 || value.reasonCodes.length > 8) {
    throw new Error('Invalid Phase 7 shadow reason codes');
  }
  for (const reason of value.reasonCodes) {
    if (!PHASE7_SHADOW_REASON_CODES.has(reason)) throw new Error('Invalid Phase 7 shadow reason code');
  }
  if (new Set(value.reasonCodes).size !== value.reasonCodes.length) throw new Error('Duplicate Phase 7 shadow reason code');
  if (!value.affinity || typeof value.affinity !== 'object' || Array.isArray(value.affinity)) throw new Error('Invalid Phase 7 shadow affinity');
  assertOnlyKeys(value.affinity, PHASE7_AFFINITY_KEYS, 'Phase 7 shadow affinity');
  if (value.affinity.kind !== 'session' || !value.affinity.sessionId || value.affinity.ownership !== 'server-owned') {
    throw new Error('Invalid Phase 7 shadow affinity identity');
  }
  if (!value.resourceIdentity || typeof value.resourceIdentity !== 'object' || Array.isArray(value.resourceIdentity)) throw new Error('Invalid Phase 7 shadow resource identity');
  assertOnlyKeys(value.resourceIdentity, PHASE7_RESOURCE_KEYS, 'Phase 7 shadow resource identity');
  if (
    value.resourceIdentity.kind !== 'shared-service'
    || value.resourceIdentity.boundary !== 'pi-control-process'
    || value.resourceIdentity.ownership !== 'server-owned'
    || value.resourceIdentity.sessionScoped !== false
  ) throw new Error('Invalid Phase 7 shadow resource identity');
  if (!value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)) throw new Error('Invalid Phase 7 shadow evidence metrics');
  assertOnlyKeys(value.evidence, PHASE7_EVIDENCE_KEYS, 'Phase 7 shadow evidence metrics');
  if (!Number.isSafeInteger(value.evidence.promptBytes) || value.evidence.promptBytes < 0 || value.evidence.promptBytes > 10_000_000) {
    throw new Error('Invalid Phase 7 shadow prompt byte count');
  }
  if (!Number.isSafeInteger(value.evidence.toolEventCount) || value.evidence.toolEventCount < 0 || value.evidence.toolEventCount > 10_000) {
    throw new Error('Invalid Phase 7 shadow tool event count');
  }
  if (value.evidence.durationMs !== undefined && (!Number.isSafeInteger(value.evidence.durationMs) || value.evidence.durationMs < 0 || value.evidence.durationMs > 7 * 24 * 60 * 60 * 1000)) {
    throw new Error('Invalid Phase 7 shadow duration');
  }
}

/**
 * C3a (contract 1.58.0): defence-in-depth structural bounds for a stored
 * completion block. The parser already validated it with the zod schema;
 * these checks keep a hand-edited or corrupted store file from loading an
 * unbounded payload into a receipt.
 */
function validateStoredCompletion(value: NonNullable<RunReceipt['completion']>): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid completion block');
  const record = value as unknown as Record<string, unknown>;
  const keys = new Set(['schema', 'status', 'summary', 'commands', 'tests', 'commits', 'filesChanged', 'openIssues', 'blockedReason']);
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) throw new Error(`Unsupported completion block field: ${key}`);
  }  if (record.schema !== COMPLETION_SCHEMA_NAME) throw new Error('Invalid completion block schema name');
  if (!['done', 'blocked', 'partial'].includes(record.status as string)) throw new Error('Invalid completion block status');
  if (record.summary !== undefined && (typeof record.summary !== 'string' || record.summary.length > 2_000)) throw new Error('Invalid completion block summary');
  if (record.blockedReason !== undefined && (typeof record.blockedReason !== 'string' || record.blockedReason.length > 4_000)) {
    throw new Error('Invalid completion block blockedReason');
  }
  if (record.status === 'blocked' && (typeof record.blockedReason !== 'string' || record.blockedReason.length === 0)) {
    throw new Error('Completion block with status blocked requires blockedReason');
  }
  const boundedArray = (key: string, max: number, itemKeys: Set<string>, itemMax: number) => {
    const arr = record[key];
    if (arr === undefined) return;
    if (!Array.isArray(arr) || arr.length > max) throw new Error(`Invalid completion block ${key}`);
    for (const item of arr) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Invalid completion block ${key} entry`);
      for (const ik of Object.keys(item as Record<string, unknown>)) {
        if (!itemKeys.has(ik)) throw new Error(`Unsupported completion block ${key} field: ${ik}`);
      }
      for (const ik of itemKeys) {
        const iv = (item as Record<string, unknown>)[ik];
        if (iv === undefined) continue;
        if (typeof iv !== 'string' && typeof iv !== 'number') throw new Error(`Invalid completion block ${key}.${ik}`);
        if (typeof iv === 'string' && iv.length > itemMax) throw new Error(`Invalid completion block ${key}.${ik} length`);
      }
    }
  };
  boundedArray('commands', 50, new Set(['command', 'exitCode', 'note']), 2_000);
  boundedArray('tests', 100, new Set(['name', 'result', 'note']), 2_000);
  boundedArray('commits', 50, new Set(['sha', 'repo', 'subject']), 1_024);
  for (const key of ['filesChanged', 'openIssues'] as const) {
    const arr = record[key];
    if (arr === undefined) continue;
    if (!Array.isArray(arr) || arr.length > (key === 'filesChanged' ? 200 : 50)) throw new Error(`Invalid completion block ${key}`);
    for (const item of arr) {
      if (typeof item !== 'string' || item.length === 0 || item.length > 2_000) throw new Error(`Invalid completion block ${key} entry`);
    }
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > COMPLETION_BLOCK_MAX_CHARS * 4) throw new Error('Completion block exceeds the storage bound');
}

function validateStoredCompletionError(value: NonNullable<RunReceipt['completionError']>): void {  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid completionError');
  const record = value as unknown as Record<string, unknown>;
  const keys = new Set(['code', 'message', 'fieldPath']);
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) throw new Error(`Unsupported completionError field: ${key}`);
  }
  if (typeof record.code !== 'string' || !['NO_BLOCK', 'UNCLOSED_FENCE', 'OVERSIZED_BLOCK', 'MALFORMED_JSON', 'SCHEMA_VIOLATION'].includes(record.code)) {
    throw new Error('Invalid completionError code');
  }
  if (typeof record.message !== 'string' || record.message.length === 0 || record.message.length > 2_000) {
    throw new Error('Invalid completionError message');
  }
  if (record.fieldPath !== undefined && (typeof record.fieldPath !== 'string' || record.fieldPath.length > 500)) {
    throw new Error('Invalid completionError fieldPath');
  }
}

function validateTokenUsage(value: RunTokenUsage, runtime: string): void {
  if (runtime !== 'commandcode') throw new Error('Run token usage requires the Command Code runtime');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid run token usage');
  assertOnlyKeys(value, new Set(['scope', 'source', 'input', 'output', 'total']), 'run token usage');
  if (value.scope !== 'run' || value.source !== 'commandcode-terminal-result-v1') throw new Error('Invalid run token usage provenance');
  if (![value.input, value.output, value.total].every((count) => Number.isSafeInteger(count) && count >= 0)) throw new Error('Invalid run token usage count');
  if (value.total !== value.input + value.output || !Number.isSafeInteger(value.input + value.output)) throw new Error('Run token usage total must equal input plus output');
}

function validateOutputEvidence(value: RunOutputEvidence): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid output evidence');
  assertOnlyKeys(value, OUTPUT_EVIDENCE_KEYS, 'output evidence');
  if (value.policyVersion !== 'run-output-v1' || value.source !== 'normalized-events-v1') throw new Error('Invalid output evidence provenance');
  if (!['text', 'no-text', 'unknown'].includes(value.disposition)) throw new Error('Invalid output evidence disposition');
  for (const [label, count, maximum] of [
    ['assistant message', value.assistantMessages, 100_000],
    ['assistant text block', value.assistantTextBlocks, 1_000_000],
    ['assistant text character', value.assistantTextChars, 10_000_000],
    ['tool call', value.toolCalls, 100_000],
  ] as const) {
    if (!Number.isSafeInteger(count) || count < 0 || count > maximum) throw new Error(`Invalid output evidence ${label} count`);
  }
  if (value.disposition === 'text' && value.assistantTextChars < 1) throw new Error('Text output evidence requires text characters');
  if (value.disposition === 'no-text' && value.assistantTextChars !== 0) throw new Error('No-text output evidence cannot carry text characters');
}

function validateLiveness(value: RunLivenessEvidence): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid liveness evidence');
  assertOnlyKeys(value, LIVENESS_KEYS, 'liveness');
  if (value.activityPolicyVersion !== 'run-activity-v1') throw new Error('Invalid activity policy version');
  if (!Number.isFinite(value.idleTimeoutMs) || value.idleTimeoutMs <= 0) throw new Error('Invalid liveness idle timeout');
  if (!Number.isFinite(value.absoluteTimeoutMs) || value.absoluteTimeoutMs <= 0) throw new Error('Invalid liveness absolute timeout');
  if (value.lastEligibleActivity) {
    assertOnlyKeys(value.lastEligibleActivity, ACTIVITY_KEYS, 'activity');
    if (!SAFE_EVENT_TYPE.test(value.lastEligibleActivity.eventType)) throw new Error('Invalid activity event type');
    assertIsoTimestamp(value.lastEligibleActivity.occurredAt, 'activity occurredAt');
    assertIsoTimestamp(value.lastEligibleActivity.observedAt, 'activity observedAt');
  }
  if (value.watchdog) {
    assertOnlyKeys(value.watchdog, WATCHDOG_KEYS, 'watchdog');
    if (!['idle', 'absolute', 'no_activity'].includes(value.watchdog.reason)) throw new Error('Invalid watchdog reason');
    assertIsoTimestamp(value.watchdog.decidedAt, 'watchdog decidedAt');
    if (!Number.isFinite(value.watchdog.idleTimeoutMs) || value.watchdog.idleTimeoutMs <= 0) throw new Error('Invalid watchdog idle timeout');
    if (!Number.isFinite(value.watchdog.absoluteTimeoutMs) || value.watchdog.absoluteTimeoutMs <= 0) throw new Error('Invalid watchdog absolute timeout');
    if (value.watchdog.startWindowMs !== undefined && (!Number.isFinite(value.watchdog.startWindowMs) || value.watchdog.startWindowMs <= 0)) throw new Error('Invalid watchdog start window');
  }
  if (value.terminalObservations) {
    if (!Array.isArray(value.terminalObservations) || value.terminalObservations.length > 4) throw new Error('Invalid terminal observations');
    for (const observation of value.terminalObservations) {
      assertOnlyKeys(observation, TERMINAL_OBSERVATION_KEYS, 'terminal observation');
      if (observation.type !== 'agent_end') throw new Error('Invalid terminal observation type');
      if (!['runtime_or_adapter', 'synthetic'].includes(observation.origin)) throw new Error('Invalid terminal observation origin');
      if (observation.reason !== undefined && !RUN_TERMINAL_REASON_ALLOWLIST.has(observation.reason)) throw new Error('Invalid terminal observation reason');
      if (typeof observation.late !== 'boolean') throw new Error('Invalid terminal observation late flag');
      assertIsoTimestamp(observation.occurredAt, 'terminal observation occurredAt');
      assertIsoTimestamp(observation.observedAt, 'terminal observation observedAt');
    }
  }
  assertOnlyKeys(value.cessation, CESSATION_KEYS, 'cessation');
  if (!['confirmed', 'unconfirmed', 'unknown'].includes(value.cessation.state)) throw new Error('Invalid cessation state');
  if (!['terminal_signal', 'synthetic_terminal_signal', 'documented_handler_return', 'resource_quiescence', 'watchdog', 'server_restart', 'no_terminal_signal'].includes(value.cessation.basis)) throw new Error('Invalid cessation basis');
  assertIsoTimestamp(value.cessation.observedAt, 'cessation observedAt');
}

function cloneReceipt(record: PersistedRunReceipt): PersistedRunReceipt {
  return structuredClone(record);
}

function isLegalTransition(from: RunReceiptStatus, to: RunReceiptStatus): boolean {
  if (from === 'accepted') return to === 'queued' || to === 'started' || to === 'failed' || to === 'cancelled';
  if (from === 'queued') return to === 'started' || to === 'failed' || to === 'cancelled';
  if (from === 'started') return to === 'completed' || to === 'failed' || to === 'cancelled';
  return false;
}

function receiptTime(record: PersistedRunReceipt): number {
  return Date.parse(record.terminalAt ?? record.acceptedAt);
}

function isIdempotencyProtected(record: PersistedRunReceipt, now: number): boolean {
  return !!record.idempotencyExpiresAt && Date.parse(record.idempotencyExpiresAt) > now;
}
