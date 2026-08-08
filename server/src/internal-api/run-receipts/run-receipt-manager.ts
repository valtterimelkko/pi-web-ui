import { createHash, randomUUID } from 'node:crypto';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { RUN_TERMINAL_REASON_ALLOWLIST } from '../types.js';
import type {
  Phase7PiShadowClassification,
  PromptMode,
  CommandCodeEffort,
  RunActivityObservation,
  RunReceipt,
  RunReceiptStatus,
  RunStallReason,
  SessionRuntime,
  Verbosity,
} from '../types.js';
import {
  classifyPhase7PiShadow,
  createPhase7PiShadowState,
  finalizePhase7PiShadow,
  observePhase7PiShadowEvent,
  type Phase7PiShadowState,
} from '../phase7-pi-shadow.js';
import { RunReceiptStore, type PersistedRunReceipt } from './run-receipt-store.js';
import { createLogger } from '../../logging/logger.js';
import { getOperationalMetrics, type OperationalMetrics } from '../../observability/operational-metrics.js';

const logger = createLogger('RunReceiptManager');
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TURN_MAX_MS = 6 * 60 * 60 * 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_POLL_MS = 1_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const ACTIVITY_PERSIST_INTERVAL_MS = 1_000;

export interface BeginRunInput {
  sessionId: string;
  runtime: SessionRuntime;
  executionInstanceId: string;
  model?: string;
  modelSelector?: string;
  invocationRole?: 'conductor-root' | 'implementation-child';
  permissionProfile?: 'agent-os-7f-root-readonly' | 'implementation-child-wide';
  message: string;
  mode: PromptMode;
  dispatchMode?: PromptMode;
  verbosity: Verbosity;
  detach: boolean;
  requireActiveTurn?: boolean;
  /** Command Code-native effort binding, distinct from thinkingLevel. */
  effort?: CommandCodeEffort;
  requestedEffort?: CommandCodeEffort;
  effortSource?: 'explicit' | 'default' | 'none';
  defaultEffort?: CommandCodeEffort;
  effortCapabilityHash?: string;
  idempotencyKey?: string;
  /** Server-derived Pi-only shadow evidence; callers cannot provide this field. */
  phase7Shadow?: Phase7PiShadowClassification;
}

export interface RunFinishOutcome {
  status?: Extract<RunReceiptStatus, 'completed' | 'failed' | 'cancelled'>;
  errorCode?: string;
  /** Internal watchdog classification; public callers continue to use TURN_STALLED. */
  stallReason?: RunStallReason;
  /** Explicit adapter-owned completion boundary for synchronous handlers. */
  cessationBasis?: 'documented_handler_return' | 'resource_quiescence';
}

export interface RunReceiptManagerDeps {
  store: RunReceiptStore;
  now?: () => number;
  idFactory?: () => string;
  idempotencyTtlMs?: number;
  metrics?: OperationalMetrics;
  turnIdleTimeoutMs?: number;
  turnMaxMs?: number;
  /** Fired when the watchdog terminalises a run as TURN_STALLED (quarantine signal). */
  onStalled?: (receipt: RunReceipt) => void;
  /** If set, cancel/stall defers admission release until this resolves true (runtime
   *  confirmed quiescent) or drainTimeoutMs elapses (quarantine). §11 fence. */
  isRuntimeQuiescent?: (sessionId: string) => Promise<boolean>;
  /** Hard cap on the drain hold before a forced release (quarantine). Default 30000. */
  drainTimeoutMs?: number;
  /** Drain quiescence poll interval. Default 1000. */
  drainPollMs?: number;
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

interface ActiveRun {
  runId: string;
  sessionId: string;
  runtime: SessionRuntime;
  acceptedAtMs: number;
  startedAtMs?: number;
  lastActivityAtMs: number;
  lastEligibleActivity?: RunActivityObservation;
  lastPersistedActivityAtMs?: number;
  lease?: { release: () => void };
  phase7Shadow?: Phase7PiShadowState;
}

/**
 * Owns durable run identity and the bounded lifetime of every accepted run.
 * Runtime services remain responsible for execution; this manager guarantees
 * that a silent runtime cannot retain admission capacity forever.
 */
export class RunReceiptManager {
  private readonly store: RunReceiptStore;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly idempotencyTtlMs: number;
  private readonly metrics: OperationalMetrics;
  private readonly turnIdleTimeoutMs: number;
  private readonly turnMaxMs: number;
  private readonly activeBySession = new Map<string, Set<string>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly keyLocks = new Map<string, Promise<void>>();
  private readonly runLocks = new Map<string, Promise<void>>();
  private readonly terminalWaiters = new Map<string, Set<(receipt: RunReceipt) => void>>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private watchdogTimer?: NodeJS.Timeout;
  private stalledRunCount = 0;
  private readonly onStalled?: (receipt: RunReceipt) => void;
  private readonly isRuntimeQuiescent?: (sessionId: string) => Promise<boolean>;
  private readonly drainTimeoutMs: number;
  private readonly drainPollMs: number;
  /** Draining runs: terminal but admission slot held pending runtime cessation. */
  private readonly draining = new Map<string, { release: () => void; timer: NodeJS.Timeout; quarantined: boolean }>();

  constructor(deps: RunReceiptManagerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.idFactory = deps.idFactory ?? (() => randomUUID());
    this.metrics = deps.metrics ?? getOperationalMetrics();
    this.idempotencyTtlMs = positiveTimeout(deps.idempotencyTtlMs, undefined, DEFAULT_IDEMPOTENCY_TTL_MS);
    this.turnIdleTimeoutMs = positiveTimeout(
      deps.turnIdleTimeoutMs,
      process.env.INTERNAL_API_TURN_IDLE_TIMEOUT_MS,
      DEFAULT_TURN_IDLE_TIMEOUT_MS,
    );
    this.turnMaxMs = positiveTimeout(
      deps.turnMaxMs,
      process.env.INTERNAL_API_TURN_MAX_MS,
      DEFAULT_TURN_MAX_MS,
    );
    this.onStalled = deps.onStalled;
    this.isRuntimeQuiescent = deps.isRuntimeQuiescent;
    this.drainTimeoutMs = positiveTimeout(deps.drainTimeoutMs, undefined, DEFAULT_DRAIN_TIMEOUT_MS);
    this.drainPollMs = positiveTimeout(deps.drainPollMs, undefined, DEFAULT_DRAIN_POLL_MS);
  }

  async init(): Promise<void> {
    if (!this.initialized) {
      if (!this.initPromise) {
        this.initPromise = this.store.init().then(() => { this.initialized = true; });
      }
      await this.initPromise;
    }
    this.startWatchdog();
  }

  /** Bind an idempotent external lease to this run's terminal lifecycle. */
  attachLease(runId: string, lease: { release: () => void }): void {
    const active = this.activeRuns.get(runId);
    if (active) active.lease = lease;
  }

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
    if (input.phase7Shadow && input.runtime !== 'pi') {
      throw new Error('Phase 7 shadow evidence is limited to Pi Internal API runs');
    }
    if (input.phase7Shadow && input.phase7Shadow.affinity.sessionId !== input.sessionId) {
      throw new Error('Phase 7 shadow affinity must match the run session');
    }
    if (input.phase7Shadow) {
      const expectedShadow = classifyPhase7PiShadow({ sessionId: input.sessionId, message: input.message });
      if (JSON.stringify(input.phase7Shadow) !== JSON.stringify(expectedShadow)) {
        throw new Error('Phase 7 shadow evidence does not match the server classifier');
      }
    }
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
        modelSelector: input.modelSelector,
        effort: input.effort,
        requestedEffort: input.requestedEffort,
        acceptedEffort: input.effort,
        effortSource: input.effortSource,
        defaultEffort: input.defaultEffort,
        effortCapabilityHash: input.effortCapabilityHash,
        invocationRole: input.invocationRole,
        permissionProfile: input.permissionProfile,
        mode: input.mode,
        dispatchMode: input.dispatchMode ?? input.mode,
        status: 'accepted',
        acceptedAt: new Date(acceptedAtMs).toISOString(),
        liveness: {
          activityPolicyVersion: 'run-activity-v1',
          idleTimeoutMs: this.turnIdleTimeoutMs,
          absoluteTimeoutMs: this.turnMaxMs,
          cessation: {
            state: 'unknown',
            basis: 'no_terminal_signal',
            observedAt: new Date(acceptedAtMs).toISOString(),
          },
        },
        idempotencyExpiresAt: keyDigest
          ? new Date(acceptedAtMs + this.idempotencyTtlMs).toISOString()
          : undefined,
        idempotencyKeyDigest: keyDigest,
        requestFingerprint: keyDigest ? fingerprint : undefined,
        ...(input.phase7Shadow ? { phase7Shadow: input.phase7Shadow } : {}),
      };
      await this.store.create(record);
      this.metrics.recordTurnAccepted(record.runtime);
      this.addActive(record, acceptedAtMs);
      return { kind: 'created', receipt: toPublicReceipt(record) };
    };

    return keyDigest ? this.withKeyLock(keyDigest, createOrReplay) : createOrReplay();
  }

  async setDispatchMode(runId: string, dispatchMode: PromptMode): Promise<RunReceipt | undefined> {
    await this.init();
    return this.withRunLock(runId, async () => {
      const updated = await this.store.patch(runId, { dispatchMode });
      return updated ? toPublicReceipt(updated) : undefined;
    });
  }

  async markQueued(runId: string): Promise<RunReceipt | undefined> {
    await this.init();
    return this.withRunLock(runId, async () => {
      const queued = await this.store.transition(runId, 'queued');
      return toPublicReceipt(queued);
    });
  }

  async markStarted(runId: string): Promise<RunReceipt | undefined> {
    await this.init();
    return this.withRunLock(runId, () => this.markStartedUnlocked(runId));
  }

  private async markStartedUnlocked(runId: string): Promise<RunReceipt | undefined> {
    const current = this.store.get(runId);
    if (!current || isTerminal(current.status)) return current ? toPublicReceipt(current) : undefined;
    if (current.status === 'started') return toPublicReceipt(current);
    const startedAtMs = this.now();
    const started = await this.store.transition(runId, 'started', {
      startedAt: current.startedAt ?? new Date(startedAtMs).toISOString(),
    });
    const active = this.activeRuns.get(runId);
    if (active) {
      active.startedAtMs = startedAtMs;
      active.lastActivityAtMs = startedAtMs;
    }
    return toPublicReceipt(started);
  }

  /**
   * Observe one event already correlated to this accepted run by the prompt
   * route. Only explicit run-activity classes advance the watchdog; blind
   * heartbeats and observer/session metadata never do.
   */
  observeEvent(runId: string, event: NormalizedEvent): Promise<void> {
    const observedAtMs = this.now();
    const occurredAtMs = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? event.timestamp
      : observedAtMs;
    const active = this.activeRuns.get(runId);
    const persistPhase7Shadow = Boolean(active?.phase7Shadow && (
      event.type === 'tool_execution_start' || event.type === 'agent_end'
    ));
    if (active?.phase7Shadow) observePhase7PiShadowEvent(active.phase7Shadow, event, observedAtMs);
    const phase7ShadowToPersist = persistPhase7Shadow && active?.phase7Shadow
      ? finalizePhase7PiShadow(active.phase7Shadow, observedAtMs)
      : undefined;
    const isCommandCodeRun = active?.runtime === 'commandcode' || this.store.get(runId)?.runtime === 'commandcode';
    const effortObservation = isCommandCodeRun ? commandCodeEffortObservation(event) : undefined;
    let activityToPersist: RunActivityObservation | undefined;
    if (active && isEligibleRunActivity(event.type)) {
      active.lastActivityAtMs = observedAtMs;
      active.lastEligibleActivity = {
        eventType: event.type,
        occurredAt: new Date(occurredAtMs).toISOString(),
        observedAt: new Date(observedAtMs).toISOString(),
      };
      const persistenceDue = active.lastPersistedActivityAtMs === undefined
        || observedAtMs - active.lastPersistedActivityAtMs >= ACTIVITY_PERSIST_INTERVAL_MS
        || FORCE_PERSIST_ACTIVITY_TYPES.has(event.type);
      if (persistenceDue) activityToPersist = active.lastEligibleActivity;
    }
    if (event.type !== 'agent_end') {
      if ((!activityToPersist && !phase7ShadowToPersist && !effortObservation) || !active) return Promise.resolve();
      // Reserve the write window synchronously before the queued write starts;
      // otherwise a burst can enqueue many snapshots while the first is pending.
      if (activityToPersist) active.lastPersistedActivityAtMs = observedAtMs;
      return this.withRunLock(runId, async () => {
        const current = this.store.get(runId);
        if (!current || isTerminal(current.status)) return;
        const patch: Parameters<RunReceiptStore['patch']>[1] = {};
        if (current.liveness && activityToPersist) {
          patch.liveness = { ...current.liveness, lastEligibleActivity: activityToPersist };
        }
        if (phase7ShadowToPersist) patch.phase7Shadow = phase7ShadowToPersist;
        if (effortObservation) {
          patch.effectiveEffort = effortObservation.effort;
          patch.effortEvidenceMethod = effortObservation.method;
        }
        if (Object.keys(patch).length > 0) await this.store.patch(runId, patch);
      }).catch((error) => {
        if (activityToPersist && active.lastPersistedActivityAtMs === observedAtMs) {
          active.lastPersistedActivityAtMs = undefined;
        }
        logger.warn(`failed to persist activity for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    const provenance = terminalProvenance(event);
    return this.withRunLock(runId, async () => {
      if (phase7ShadowToPersist) await this.store.patch(runId, { phase7Shadow: phase7ShadowToPersist });
      if (effortObservation) await this.store.patch(runId, { effectiveEffort: effortObservation.effort, effortEvidenceMethod: effortObservation.method });
      await this.store.markAgentEnd(
        runId,
        new Date(occurredAtMs).toISOString(),
        {
          type: 'agent_end',
          occurredAt: new Date(occurredAtMs).toISOString(),
          observedAt: new Date(observedAtMs).toISOString(),
          origin: provenance.origin,
          ...(provenance.reason ? { reason: provenance.reason } : {}),
        },
      );
    })
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

    const status = outcome.status ?? (outcome.errorCode ? 'failed' : 'completed');
    if (status === 'completed' && current.status !== 'started') {
      await this.markStartedUnlocked(runId);
      current = this.store.get(runId);
      if (!current) return undefined;
    }
    const terminalAtMs = this.now();
    const terminalAt = new Date(terminalAtMs).toISOString();
    const active = this.activeRuns.get(runId);
    const phase7Shadow = active?.phase7Shadow
      ? finalizePhase7PiShadow(active.phase7Shadow, terminalAtMs)
      : current.phase7Shadow;
    const liveness = current.liveness
      ? {
          ...current.liveness,
          ...(active?.lastEligibleActivity ? { lastEligibleActivity: active.lastEligibleActivity } : {}),
          ...(outcome.stallReason
            ? {
                watchdog: {
                  reason: outcome.stallReason,
                  decidedAt: terminalAt,
                  idleTimeoutMs: this.turnIdleTimeoutMs,
                  absoluteTimeoutMs: this.turnMaxMs,
                },
                cessation: {
                  state: 'unknown' as const,
                  basis: 'watchdog' as const,
                  observedAt: terminalAt,
                },
              }
            : outcome.cessationBasis
              ? {
                  cessation: {
                    state: 'confirmed' as const,
                    basis: outcome.cessationBasis,
                    observedAt: terminalAt,
                  },
                }
              : {}),
        }
      : undefined;
    const terminal = await this.store.transition(runId, status, {
      errorCode: outcome.errorCode,
      terminalAt,
      ...(current.runtime === 'commandcode' && current.effort && !current.effectiveEffort && !current.effortEvidenceMethod
        ? { effortEvidenceMethod: 'unobserved' as const }
        : {}),
      ...(liveness ? { liveness } : {}),
      ...(phase7Shadow ? { phase7Shadow } : {}),
    });
    this.terminalize(terminal);
    return toPublicReceipt(terminal);
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.init();
    const active = Array.from(this.activeBySession.get(sessionId) ?? []);
    await Promise.all(active.map((runId) => this.finish(runId, { status: 'cancelled' })));
  }

  async cancelRun(runId: string): Promise<RunReceipt | undefined> {
    return this.finish(runId, { status: 'cancelled' });
  }

  async rejectBeforeDispatch(
    runId: string,
    outcome: { status: 'failed' | 'cancelled'; errorCode: string },
  ): Promise<RunReceipt | undefined> {
    await this.init();
    return this.withRunLock(runId, async () => {
      const current = this.store.get(runId);
      if (!current) return undefined;
      if (isTerminal(current.status)) {
        const released = await this.store.releaseIdempotency(runId);
        return released ? toPublicReceipt(released) : undefined;
      }
      const terminal = await this.store.transition(runId, outcome.status, {
        errorCode: outcome.errorCode,
        terminalAt: new Date(this.now()).toISOString(),
        clearIdempotency: true,
      });
      this.terminalize(terminal);
      return toPublicReceipt(terminal);
    });
  }

  get(runId: string): RunReceipt | undefined {
    const record = this.store.get(runId);
    return record ? toPublicReceipt(record) : undefined;
  }

  listBySession(sessionId: string): RunReceipt[] {
    return this.store.list().filter((record) => record.sessionId === sessionId).map(toPublicReceipt);
  }

  async waitForTerminal(runId: string): Promise<RunReceipt> {
    await this.init();
    const current = this.get(runId);
    if (!current) throw new Error(`Run receipt not found: ${runId}`);
    if (isTerminal(current.status)) return current;
    return new Promise<RunReceipt>((resolve) => {
      const waiters = this.terminalWaiters.get(runId) ?? new Set<(receipt: RunReceipt) => void>();
      waiters.add(resolve);
      this.terminalWaiters.set(runId, waiters);
      // Close the race where terminalisation happened between get() and add().
      const latest = this.get(runId);
      if (latest && isTerminal(latest.status)) this.resolveTerminalWaiters(latest);
    });
  }

  hasActiveRun(sessionId: string): boolean {
    return (this.activeBySession.get(sessionId)?.size ?? 0) > 0;
  }

  getStalledRunCount(): number {
    return this.stalledRunCount;
  }

  getOldestActiveRunStartedAt(): string | undefined {
    let oldest: number | undefined;
    for (const run of this.activeRuns.values()) {
      const candidate = run.startedAtMs ?? run.acceptedAtMs;
      if (oldest === undefined || candidate < oldest) oldest = candidate;
    }
    return oldest === undefined ? undefined : new Date(oldest).toISOString();
  }

  async shutdown(): Promise<void> {
    this.stopWatchdog();
    await Promise.allSettled([...this.keyLocks.values(), ...this.runLocks.values()]);
    for (const active of this.activeRuns.values()) active.lease?.release();
    for (const entry of this.draining.values()) { clearInterval(entry.timer); entry.release(); }
    this.draining.clear();
    await this.store.flush();
    this.activeBySession.clear();
    this.activeRuns.clear();
    this.keyLocks.clear();
    this.runLocks.clear();
    this.terminalWaiters.clear();
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    const intervalMs = Math.min(1000, Math.max(10, Math.floor(this.turnIdleTimeoutMs / 4)));
    this.watchdogTimer = setInterval(() => { void this.reconcileStalledRuns(); }, intervalMs);
    this.watchdogTimer.unref();
  }

  private stopWatchdog(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  private async reconcileStalledRuns(): Promise<void> {
    const now = this.now();
    for (const [runId, active] of Array.from(this.activeRuns)) {
      const idleExceeded = now - active.lastActivityAtMs >= this.turnIdleTimeoutMs;
      const maxExceeded = now - active.acceptedAtMs >= this.turnMaxMs;
      if (!idleExceeded && !maxExceeded) continue;
      const before = this.store.get(runId);
      if (!before || isTerminal(before.status)) continue;
      logger.warn(`Run ${runId} stalled: ${maxExceeded ? 'absolute ceiling exceeded' : 'idle timeout exceeded'}`);
      const stallReason: RunStallReason = maxExceeded ? 'absolute' : 'idle';
      const terminal = await this.finish(runId, {
        status: 'failed',
        errorCode: 'TURN_STALLED',
        stallReason,
      }).catch((error) => {
        logger.warn(`failed to terminalise stalled run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (terminal?.errorCode === 'TURN_STALLED') {
        this.stalledRunCount += 1;
        // Quarantine signal: the run is terminalised without confirmed runtime
        // cessation. The slot is already released by terminalisation; this only
        // notifies (e.g. operator Telegram ping). No caller action is required.
        this.onStalled?.(terminal);
      }
    }
  }

  private addActive(record: PersistedRunReceipt, acceptedAtMs: number): void {
    const runs = this.activeBySession.get(record.sessionId) ?? new Set<string>();
    runs.add(record.runId);
    this.activeBySession.set(record.sessionId, runs);
    this.activeRuns.set(record.runId, {
      runId: record.runId,
      sessionId: record.sessionId,
      runtime: record.runtime,
      acceptedAtMs,
      startedAtMs: record.startedAt ? Date.parse(record.startedAt) : undefined,
      lastActivityAtMs: acceptedAtMs,
      ...(record.phase7Shadow ? { phase7Shadow: createPhase7PiShadowState(record.phase7Shadow, acceptedAtMs) } : {}),
    });
  }

  private terminalize(record: PersistedRunReceipt): void {
    const active = this.activeRuns.get(record.runId);
    if (!active) return;
    const lease = active.lease;
    this.activeRuns.delete(record.runId);
    const runs = this.activeBySession.get(record.sessionId);
    runs?.delete(record.runId);
    if (runs?.size === 0) this.activeBySession.delete(record.sessionId);
    this.metrics.recordTurnFinished(
      record.runtime,
      record.status as Extract<RunReceiptStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>,
      elapsedMs(record.acceptedAt, record.terminalAt),
    );
    this.resolveTerminalWaiters(toPublicReceipt(record));
    // §11 fence: cancellation/stall leaves runtime cessation unconfirmed, so the
    // admission slot is held (not reusable) until the runtime confirms quiescent
    // or the drain timeout elapses (bounded quarantine). Normal completion
    // (agent_end) already confirms cessation, so it releases immediately.
    if (lease && this.isRuntimeQuiescent && (record.status === 'cancelled' || record.status === 'failed')) {
      this.drainAndRelease(record.runId, record.sessionId, lease);
    } else {
      lease?.release();
    }
  }

  /**
   * Hold an admission lease while polling the runtime for cessation; release as
   * soon as quiescence is confirmed, or at drainTimeoutMs (real-time, bounded
   * quarantine so a missing acknowledgement can never leak a slot permanently).
   */
  private drainAndRelease(runId: string, sessionId: string, lease: { release: () => void }): void {
    const deadline = Date.now() + this.drainTimeoutMs;
    const timer = setInterval(() => {
      Promise.resolve(this.isRuntimeQuiescent!(sessionId))
        .then((quiescent) => { if (quiescent) this.finishDrain(runId); else if (Date.now() >= deadline) this.quarantine(runId); })
        .catch(() => { if (Date.now() >= deadline) this.quarantine(runId); });
    }, this.drainPollMs);
    this.draining.set(runId, { release: lease.release, timer, quarantined: false });
  }

  /** Cessation confirmed -> release the slot. */
  private finishDrain(runId: string): void {
    const entry = this.draining.get(runId);
    if (!entry) return;
    clearInterval(entry.timer);
    this.draining.delete(runId);
    entry.release();
  }

  /**
   * Drain timeout elapsed without confirmed cessation: the admission slot is NOT
   * released (no false capacity release). It is held as quarantined capacity-debt
   * until restart/operator recovery, surfaced via getQuarantinedCount().
   */
  private quarantine(runId: string): void {
    const entry = this.draining.get(runId);
    if (!entry || entry.quarantined) return;
    clearInterval(entry.timer);
    entry.quarantined = true;
  }

  /**
   * Positive runtime/resource cessation evidence from an owning adapter. This
   * closes a draining or quarantined lease immediately; callers must not invoke
   * it from a terminal receipt alone.
   */
  async confirmRuntimeQuiescent(runId: string): Promise<boolean> {
    if (!this.draining.has(runId)) return false;
    const persisted = await this.store.markResourceQuiescent(runId, new Date(this.now()).toISOString());
    if (!persisted || persisted.liveness?.cessation.basis !== 'resource_quiescence') {
      throw new Error(`Failed to persist resource-quiescence evidence for run ${runId}`);
    }
    this.finishDrain(runId);
    return true;
  }

  /** Number of runs terminal but still holding an admission slot pending cessation. */
  getDrainingCount(): number {
    return this.draining.size;
  }

  /** Number of runs quarantined (cessation never confirmed; slot held as debt). */
  getQuarantinedCount(): number {
    let n = 0;
    for (const e of this.draining.values()) if (e.quarantined) n += 1;
    return n;
  }

  private resolveTerminalWaiters(receipt: RunReceipt): void {
    const waiters = this.terminalWaiters.get(receipt.runId);
    if (!waiters) return;
    this.terminalWaiters.delete(receipt.runId);
    for (const resolve of waiters) resolve(receipt);
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
    const receipt = toPublicReceipt(existing);
    return existing.requestFingerprint === fingerprint
      ? { kind: 'duplicate', receipt }
      : { kind: 'conflict', receipt };
  }
}

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') throw new IdempotencyKeyValidationError('idempotencyKey must be a string');
  const normalized = value.trim();
  if (!normalized) throw new IdempotencyKeyValidationError('idempotencyKey must not be empty');
  if (normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new IdempotencyKeyValidationError(`idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (hasControlCharacter) throw new IdempotencyKeyValidationError('idempotencyKey must not contain control characters');
  return normalized;
}

function requestFingerprint(input: BeginRunInput): string {
  return digest(JSON.stringify({
    message: input.message,
    mode: input.mode,
    verbosity: input.verbosity,
    effort: input.effort,
    requestedEffort: input.requestedEffort,
    effortSource: input.effortSource,
    detach: input.detach,
    requireActiveTurn: input.requireActiveTurn === true,
  }));
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isTerminal(status: RunReceiptStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

const FORCE_PERSIST_ACTIVITY_TYPES = new Set([
  'extension_ui_request',
  'permission_request',
  'ask_user_question_request',
]);

const ELIGIBLE_RUN_ACTIVITY_TYPES = new Set([
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'error',
  'session_compaction',
  'permission_request',
  'extension_ui_request',
  'ask_user_question_request',
  'ask_user_question_closed',
  'api_error',
]);

function isEligibleRunActivity(eventType: string): boolean {
  return ELIGIBLE_RUN_ACTIVITY_TYPES.has(eventType);
}

function commandCodeEffortObservation(event: NormalizedEvent): { effort: CommandCodeEffort; method: 'provider-event' | 'provider-result' } | undefined {
  if (event.type !== 'model_request_end' && event.type !== 'agent_end') return undefined;
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined;
  const effort = data?.effort ?? data?.effectiveEffort ?? data?.reasoningEffort;
  if (typeof effort !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return undefined;
  const method = data?.effortEvidenceMethod === 'provider-result' ? 'provider-result' : 'provider-event';
  return { effort: effort as CommandCodeEffort, method };
}

function terminalProvenance(event: NormalizedEvent): {
  origin: 'runtime_or_adapter' | 'synthetic';
  reason?: string;
} {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
  const origin = data.synthetic === true ? 'synthetic' : 'runtime_or_adapter';
  const rawReason = typeof data.reason === 'string' ? data.reason : undefined;
  const reason = rawReason && RUN_TERMINAL_REASON_ALLOWLIST.has(rawReason) ? rawReason : undefined;
  return { origin, ...(reason ? { reason } : {}) };
}

function elapsedMs(startIso: string, endIso?: string): number | undefined {
  if (!endIso) return undefined;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

function toPublicReceipt(record: PersistedRunReceipt): RunReceipt {
  const publicReceipt = { ...record };
  delete publicReceipt.idempotencyKeyDigest;
  delete publicReceipt.requestFingerprint;
  return publicReceipt;
}

function positiveTimeout(explicit: number | undefined, envValue: string | undefined, fallback: number): number {
  const candidate = explicit ?? (envValue === undefined ? undefined : Number(envValue));
  return Number.isFinite(candidate) && (candidate as number) > 0 ? candidate as number : fallback;
}
