/**
 * Watch Manager
 *
 * Owns the lifecycle of every watch: it attaches a standing, server-side
 * subscription to the event broker, evaluates conditions as events arrive,
 * appends matches to the durable ledger, and keeps a lightweight snapshot of
 * session activity. It is the component that decouples *observation* from the
 * *observer's liveness* — events are recorded whether or not any client is
 * connected.
 *
 * There is one watch per session (the route is `/sessions/:id/watch`,
 * singular). Re-registering replaces the previous watch for that session.
 */

import type { InternalApiEventBroker } from '../event-broker.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type {
  RegisterWatchRequest,
  SessionRuntime,
  WatchConditionSpec,
  WatchConditionState,
  WatchFiring,
  WatchOnFireAction,
  WatchResponse,
  WatchSnapshot,
  WatchWakeAttempt,
} from '../types.js';
import { ConditionEngine, resolveConditions, type ResolvedCondition } from './condition-evaluator.js';
import { WatchStore, type PersistedWatch } from './watch-store.js';
import { createLogger } from '../../logging/logger.js';
import { getOperationalMetrics, type OperationalMetrics } from '../../observability/operational-metrics.js';

const logger = createLogger('WatchManager');

/** Input handed to the injected wake dispatcher for one wake attempt. */
export interface WatchWakeDispatchInput {
  watchId: string;
  targetSessionId: string;
  /** Final composed message (placeholders already interpolated). */
  message: string;
  mode: 'prompt' | 'follow_up';
  /** Stable per-attempt key so a retried dispatch cannot double-prompt. */
  idempotencyKey: string;
}

export type WatchWakeDispatchResult =
  | { status: 'dispatched'; runId: string }
  | { status: 'failed'; errorCode: string; detail?: string };

export interface WatchManagerDeps {
  broker: InternalApiEventBroker;
  /** Directory for the durable ledger files. */
  storeDir: string;
  /** Pin a session so idle eviction can't kill it mid-watch. Returns whether it is now pinned. */
  pinSession: (sessionId: string, claimId?: string) => boolean | Promise<boolean>;
  /** Release only this watch's source-owned runtime claim. */
  unpinSession?: (sessionId: string, claimId?: string) => boolean | Promise<boolean>;
  /**
   * Optional hook to ensure events for a session flow into the broker before
   * any prompt/SSE consumer exists (Pi needs its persistent observer attached).
   */
  ensureObserver?: (sessionPath: string) => void;
  /** Cap on firings recorded per condition (when `once: false`). */
  maxFiringsPerCondition?: number;
  /** Hard cap on total ledger size per watch. */
  maxTotalFirings?: number;
  /** Low-cardinality observability seam. */
  metrics?: OperationalMetrics;
  /** Retry delay after a durable ledger write fails. */
  persistenceRetryMs?: number;
  /** Execute one wake dispatch (run receipts, admission, injection checks live in the caller). */
  dispatchWake?: (input: WatchWakeDispatchInput) => Promise<WatchWakeDispatchResult>;
}

interface ActiveWatch {
  record: PersistedWatch;
  engine: ConditionEngine;
  resolved: ResolvedCondition[];
  unsub: Array<() => void>;
  snapshotDirty: boolean;
  flushTimer?: NodeJS.Timeout;
  /** Serialises wake-attempt mutations so async dispatch results can't race. */
  wakeChain: Promise<unknown>;
}

const DEFAULT_MAX_PER_CONDITION = 50;
const DEFAULT_MAX_TOTAL = 500;
const SNAPSHOT_FLUSH_MS = 1000;
const MAX_WAKE_ATTEMPTS_RECORDED = 50;

/** Structural validation + defaults for the opt-in wake action. */
export function validateOnFireAction(sessionId: string, raw: unknown): WatchOnFireAction {
  if (typeof raw !== 'object' || raw === null) {
    throw new WatchValidationError('onFire must be an object');
  }
  const action = raw as Partial<WatchOnFireAction>;
  if (action.type !== 'prompt') {
    throw new WatchValidationError("onFire.type must be 'prompt'");
  }
  if (typeof action.targetSessionId !== 'string' || !action.targetSessionId.trim()) {
    throw new WatchValidationError('onFire.targetSessionId is required');
  }
  if (action.targetSessionId === sessionId) {
    throw new WatchValidationError(
      'onFire.targetSessionId cannot target its own session: an idle session produces no events for a watch to act on, and a streaming one would self-continue. Watch the child, wake the parent.',
    );
  }
  if (typeof action.message !== 'string' || !action.message.trim()) {
    throw new WatchValidationError('onFire.message is required and must be non-empty');
  }
  if (action.message.length > 4000) {
    throw new WatchValidationError('onFire.message must be at most 4000 characters');
  }
  if (action.mode !== undefined && action.mode !== 'prompt' && action.mode !== 'follow_up') {
    throw new WatchValidationError("onFire.mode must be 'prompt' or 'follow_up'");
  }
  const maxWakeups = action.maxWakeups ?? 1;
  if (!Number.isInteger(maxWakeups) || maxWakeups < 1 || maxWakeups > 10) {
    throw new WatchValidationError('onFire.maxWakeups must be an integer between 1 and 10');
  }
  const cooldownSeconds = action.cooldownSeconds ?? 60;
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 3600) {
    throw new WatchValidationError('onFire.cooldownSeconds must be an integer between 0 and 3600');
  }
  return {
    type: 'prompt',
    targetSessionId: action.targetSessionId,
    message: action.message,
    mode: action.mode ?? 'follow_up',
    maxWakeups,
    cooldownSeconds,
    pinTarget: action.pinTarget !== false,
    includeEvidence: action.includeEvidence === true,
  };
}

/** Interpolate the bounded placeholder set for a wake message. */
function composeWakeMessage(
  action: WatchOnFireAction,
  context: { conditionId: string; eventType: string; evidence: string; sessionId: string; firedAt: number },
): string {
  const evidence = action.includeEvidence ? context.evidence : '[evidence excluded]';
  return action.message
    .replaceAll('{{conditionId}}', context.conditionId)
    .replaceAll('{{eventType}}', context.eventType)
    .replaceAll('{{sessionId}}', context.sessionId)
    .replaceAll('{{firedAt}}', new Date(context.firedAt).toISOString())
    .replaceAll('{{evidence}}', evidence);
}

export class WatchManager {
  private readonly broker: InternalApiEventBroker;
  private readonly store: WatchStore;
  private readonly pinSession: WatchManagerDeps['pinSession'];
  private readonly unpinSession?: WatchManagerDeps['unpinSession'];
  private readonly ensureObserver?: WatchManagerDeps['ensureObserver'];
  private readonly maxPerCondition: number;
  private readonly maxTotal: number;
  private readonly metrics: OperationalMetrics;
  private readonly persistenceRetryMs: number;
  private readonly dispatchWake?: WatchManagerDeps['dispatchWake'];
  /** Live watches keyed by sessionId. */
  private readonly active = new Map<string, ActiveWatch>();
  private initialized = false;

  constructor(deps: WatchManagerDeps) {
    this.broker = deps.broker;
    this.store = new WatchStore(deps.storeDir);
    this.pinSession = deps.pinSession;
    this.unpinSession = deps.unpinSession;
    this.ensureObserver = deps.ensureObserver;
    this.maxPerCondition = deps.maxFiringsPerCondition ?? DEFAULT_MAX_PER_CONDITION;
    this.maxTotal = deps.maxTotalFirings ?? DEFAULT_MAX_TOTAL;
    this.metrics = deps.metrics ?? getOperationalMetrics();
    this.persistenceRetryMs = deps.persistenceRetryMs ?? 5_000;
    this.dispatchWake = deps.dispatchWake;
  }

  /**
   * Load persisted watches from disk. Reloaded watches are marked `detached`:
   * their past firings remain readable, but they have no live subscription
   * until re-registered (the runtime/session may be entirely fresh after a
   * restart). This is what the durability guarantee rests on.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    for (const record of this.store.list()) {
      if (record.status === 'active') {
        record.status = 'detached';
      }
    }
    this.initialized = true;
  }

  /** Create or replace the watch for a session. Throws on an invalid condition spec. */
  async register(params: {
    sessionId: string;
    sessionPath: string;
    runtime: SessionRuntime;
    request: RegisterWatchRequest;
  }): Promise<WatchResponse> {
    await this.init();
    const { sessionId, sessionPath, runtime, request } = params;

    const specs = request.conditions ?? [];
    if (specs.length === 0) {
      throw new WatchValidationError('At least one condition is required');
    }
    // Resolve up-front so a bad regex is reported as a 400 at registration.
    let resolved: ResolvedCondition[];
    try {
      resolved = resolveConditions(specs);
    } catch (err) {
      throw new WatchValidationError(err instanceof Error ? err.message : 'Invalid condition');
    }
    // Structural wake-action validation (self-target, bounds, mode) also 400s.
    const onFire = request.onFire !== undefined
      ? validateOnFireAction(sessionId, request.onFire)
      : undefined;

    // Replace any existing watch for this session. Release exactly its prior
    // claims first, including when the replacement opts out of pinning.
    const previous = this.active.get(sessionId)?.record ?? this.store.get(sessionId);
    this.teardown(sessionId);
    if (previous?.pinned && this.unpinSession) {
      await Promise.resolve(this.unpinSession(sessionId, `watch:${previous.watchId}`)).catch(() => false);
    }
    if (previous?.targetPinned && previous.onFire && this.unpinSession) {
      await Promise.resolve(this.unpinSession(previous.onFire.targetSessionId, `watch-target:${previous.watchId}`)).catch(() => false);
    }

    const watchId = `watch-${sessionId}`;
    const claimId = `watch:${watchId}`;
    let pinned = false;
    if (request.pin !== false) {
      try {
        pinned = await this.pinSession(sessionId, claimId);
      } catch {
        pinned = false;
      }
    }

    // The wake target is exactly the session that must survive until the wake
    // fires (Pi rehydrates from disk, but e.g. OpenCode evicts unpinned idle
    // sessions), so claim it with a source-owned target claim by default.
    let targetPinned = false;
    if (onFire && onFire.pinTarget !== false) {
      try {
        targetPinned = await this.pinSession(onFire.targetSessionId, `watch-target:${watchId}`);
      } catch {
        targetPinned = false;
      }
    }

    if (this.ensureObserver) {
      try { this.ensureObserver(sessionPath); } catch { /* non-fatal */ }
    }

    const now = new Date().toISOString();
    const conditions: WatchConditionState[] = resolved.map((c) => ({
      id: c.id,
      type: c.type,
      spec: c.spec,
      fired: false,
      fireCount: 0,
    }));

    const record: PersistedWatch = {
      watchId,
      sessionId,
      sessionPath,
      runtime,
      label: request.label,
      status: 'active',
      pinned,
      targetPinned,
      createdAt: now,
      updatedAt: now,
      conditions,
      ...(onFire ? { onFire } : {}),
      wakeAttempts: [],
      firings: [],
      snapshot: { status: 'idle', eventCount: 0, toolCallCount: 0, sawAgentEnd: false },
    };

    const engine = new ConditionEngine(resolved);
    const handler = (event: NormalizedEvent) => this.handleEvent(sessionId, event);
    const unsub: Array<() => void> = [this.broker.subscribe(sessionId, handler, true, 'watch')];
    // Pi publishes events under the session *path*; other runtimes use the id
    // (which equals the path). Subscribe to both distinct keys so the watch
    // sees events regardless of which key the runtime publishes under.
    if (sessionPath && sessionPath !== sessionId) {
      unsub.push(this.broker.subscribe(sessionPath, handler, true, 'watch'));
    }

    this.active.set(sessionId, {
      record,
      engine,
      resolved,
      unsub,
      snapshotDirty: false,
      wakeChain: Promise.resolve(),
    });

    try {
      await this.store.save(record);
    } catch (error) {
      // Registration is not accepted until its initial ledger exists. Remove
      // the live subscriptions and cache entry so a caller can retry cleanly.
      this.teardown(sessionId);
      if (pinned && this.unpinSession) await Promise.resolve(this.unpinSession(sessionId, claimId)).catch(() => false);
      if (targetPinned && onFire && this.unpinSession) {
        await Promise.resolve(this.unpinSession(onFire.targetSessionId, `watch-target:${watchId}`)).catch(() => false);
      }
      await this.store.delete(sessionId);
      throw error;
    }
    return this.toResponse(record);
  }

  /** Current watch for a session (live or reloaded-detached), if any. */
  get(sessionId: string): WatchResponse | undefined {
    const live = this.active.get(sessionId);
    if (live) return this.toResponse(live.record);
    const persisted = this.store.get(sessionId);
    return persisted ? this.toResponse(persisted) : undefined;
  }

  /** Tear down and delete the watch for a session. */
  async delete(sessionId: string): Promise<boolean> {
    const record = this.active.get(sessionId)?.record ?? this.store.get(sessionId);
    const existed = !!record;
    this.teardown(sessionId);
    if (record?.pinned && this.unpinSession) {
      await Promise.resolve(this.unpinSession(sessionId, `watch:${record.watchId}`)).catch(() => false);
    }
    if (record?.targetPinned && record.onFire && this.unpinSession) {
      await Promise.resolve(this.unpinSession(record.onFire.targetSessionId, `watch-target:${record.watchId}`)).catch(() => false);
    }
    await this.store.delete(sessionId);
    return existed;
  }

  /** Stop all live subscriptions and timers (e.g. on server shutdown). Ledgers stay on disk. */
  close(): void {
    for (const sessionId of Array.from(this.active.keys())) {
      this.teardown(sessionId);
    }
  }

  /** Stop the live subscription for a session without deleting its ledger. */
  private teardown(sessionId: string): void {
    const live = this.active.get(sessionId);
    if (!live) return;
    for (const u of live.unsub) {
      try { u(); } catch { /* non-fatal */ }
    }
    if (live.flushTimer) clearTimeout(live.flushTimer);
    this.active.delete(sessionId);
  }

  private handleEvent(sessionId: string, event: NormalizedEvent): void {
    const live = this.active.get(sessionId);
    if (!live) return;
    const { record, engine } = live;

    // ── Snapshot bookkeeping (event-derived, no service calls) ──
    const snap = record.snapshot;
    snap.eventCount += 1;
    snap.lastEventType = event.type;
    snap.lastEventAt = event.timestamp ?? Date.now();
    if (event.type === 'tool_execution_start') snap.toolCallCount += 1;
    if (event.type === 'agent_start') snap.status = 'running';
    if (event.type === 'agent_end') { snap.status = 'idle'; snap.sawAgentEnd = true; }

    // ── Condition matching + ledger ──
    let firedSomething = false;
    if (record.firings.length < this.maxTotal) {
      const matches = engine.ingest(event);
      for (const match of matches) {
        const cond = record.conditions.find((c) => c.id === match.conditionId);
        if (!cond) continue;
        const isOnce = cond.spec.once !== false;
        if (isOnce && cond.fired) continue;
        if (cond.fireCount >= this.maxPerCondition) continue;
        if (record.firings.length >= this.maxTotal) break;

        const firing: WatchFiring = {
          conditionId: cond.id,
          firedAt: match.eventType === event.type ? (event.timestamp ?? Date.now()) : Date.now(),
          eventType: match.eventType,
          evidence: match.evidence,
        };
        record.firings.push(firing);
        cond.fireCount += 1;
        cond.lastFiredAt = firing.firedAt;
        if (!cond.fired) {
          cond.fired = true;
          cond.firstFiredAt = firing.firedAt;
        }
        firedSomething = true;

        // ── Opt-in wake dispatch (watch the child, wake the parent) ──
        if (record.onFire) {
          this.dispatchWakeForFiring(sessionId, live, {
            conditionId: cond.id,
            eventType: firing.eventType,
            evidence: firing.evidence,
            firedAt: firing.firedAt,
          });
        }
      }
    }

    record.updatedAt = new Date().toISOString();

    if (firedSomething) {
      // Firings are rare and important — persist immediately so they survive a
      // crash a moment later. Failed writes stay dirty and retry with evidence.
      if (live.flushTimer) { clearTimeout(live.flushTimer); live.flushTimer = undefined; }
      live.snapshotDirty = false;
      this.persistLive(sessionId, live, 'firing');
    } else {
      // Snapshot-only churn (e.g. streaming deltas) is throttled to avoid disk
      // thrash; the next firing or the timer will flush it.
      live.snapshotDirty = true;
      this.schedulePersist(sessionId, live, SNAPSHOT_FLUSH_MS, 'snapshot');
    }
  }

  /**
   * Evaluate the wake policy (max attempts, cooldown) and dispatch off the
   * event-loop critical path. The attempt is recorded durably whatever the
   * outcome: dispatched, suppressed (with reason), or failed (with code).
   */
  private dispatchWakeForFiring(
    sessionId: string,
    live: ActiveWatch,
    context: { conditionId: string; eventType: string; evidence: string; firedAt: number },
  ): void {
    const record = live.record;
    const action = record.onFire;
    if (!action) return;

    const now = Date.now();
    const dispatchedCount = record.wakeAttempts.filter((a) => a.status !== 'suppressed').length;
    const lastDispatchedAt = record.wakeAttempts
      .filter((a) => a.status === 'dispatched' || a.status === 'failed' || a.status === 'pending')
      .map((a) => a.attemptedAt)
      .reduce((max, at) => Math.max(max, at), 0);

    if (dispatchedCount >= (action.maxWakeups ?? 1)) {
      this.appendWakeAttempt(record, {
        attemptedAt: now,
        targetSessionId: action.targetSessionId,
        status: 'suppressed',
        conditionId: context.conditionId,
        reason: 'max_wakeups_reached',
      });
      return;
    }
    const cooldownMs = (action.cooldownSeconds ?? 60) * 1000;
    if (lastDispatchedAt > 0 && now - lastDispatchedAt < cooldownMs) {
      this.appendWakeAttempt(record, {
        attemptedAt: now,
        targetSessionId: action.targetSessionId,
        status: 'suppressed',
        conditionId: context.conditionId,
        reason: 'cooldown',
      });
      return;
    }

    const attempt: WatchWakeAttempt = {
      attemptedAt: now,
      targetSessionId: action.targetSessionId,
      status: 'pending',
      conditionId: context.conditionId,
    };
    // Record the attempt synchronously so a concurrent firing's policy check
    // already sees it (maxWakeups/cooldown must not race the async dispatch).
    record.wakeAttempts.push(attempt);
    if (record.wakeAttempts.length > MAX_WAKE_ATTEMPTS_RECORDED) {
      record.wakeAttempts = record.wakeAttempts.slice(-MAX_WAKE_ATTEMPTS_RECORDED);
    }
    record.updatedAt = new Date().toISOString();

    const input: WatchWakeDispatchInput = {
      watchId: record.watchId,
      targetSessionId: action.targetSessionId,
      message: composeWakeMessage(action, { ...context, sessionId }),
      mode: action.mode ?? 'follow_up',
      idempotencyKey: `wake:${record.watchId}:${record.wakeAttempts.length}`,
    };

    // Serialise attempts per watch so async dispatch results cannot interleave
    // with a concurrent firing's policy check.
    live.wakeChain = live.wakeChain
      .catch(() => undefined)
      .then(async () => {
        if (this.active.get(sessionId) !== live) return; // torn down mid-flight
        let result: WatchWakeDispatchResult;
        if (!this.dispatchWake) {
          result = { status: 'failed', errorCode: 'WAKE_DISPATCH_UNAVAILABLE' };
        } else {
          try {
            result = await this.dispatchWake(input);
          } catch (error) {
            result = { status: 'failed', errorCode: 'WAKE_DISPATCH_ERROR', detail: error instanceof Error ? error.message : String(error) };
          }
        }
        if (this.active.get(sessionId) !== live) return;
        // Mutate the already-recorded attempt in place so the ledger keeps the
        // decision order while gaining the durable outcome.
        attempt.attemptedAt = Date.now();
        attempt.status = result.status === 'dispatched' ? 'dispatched' : 'failed';
        if (result.status === 'dispatched') attempt.runId = result.runId;
        else attempt.errorCode = result.errorCode;
        record.updatedAt = new Date().toISOString();
        if (live.flushTimer) { clearTimeout(live.flushTimer); live.flushTimer = undefined; }
        live.snapshotDirty = false;
        this.persistLive(sessionId, live, 'wake-attempt');
      })
      .catch(() => undefined); // persistence failures must not reject the chain
  }

  /** Append a bounded wake-attempt audit entry and persist it immediately. */
  private appendWakeAttempt(record: PersistedWatch, attempt: WatchWakeAttempt): void {
    record.wakeAttempts.push(attempt);
    if (record.wakeAttempts.length > MAX_WAKE_ATTEMPTS_RECORDED) {
      record.wakeAttempts = record.wakeAttempts.slice(-MAX_WAKE_ATTEMPTS_RECORDED);
    }
    record.updatedAt = new Date().toISOString();
    const live = this.active.get(record.sessionId);
    if (live) {
      if (live.flushTimer) { clearTimeout(live.flushTimer); live.flushTimer = undefined; }
      live.snapshotDirty = false;
      this.persistLive(record.sessionId, live, 'wake-attempt');
    }
  }
  private schedulePersist(
    sessionId: string,
    live: ActiveWatch,
    delayMs: number,
    reason: 'snapshot' | 'retry',
  ): void {
    if (live.flushTimer) return;
    live.flushTimer = setTimeout(() => {
      live.flushTimer = undefined;
      if (!live.snapshotDirty || this.active.get(sessionId) !== live) return;
      live.snapshotDirty = false;
      this.persistLive(sessionId, live, reason);
    }, delayMs);
    live.flushTimer.unref?.();
  }

  private persistLive(sessionId: string, live: ActiveWatch, reason: string): void {
    void this.store.save(live.record).catch((error) => {
      if (this.active.get(sessionId) !== live) return;
      live.snapshotDirty = true;
      this.metrics.recordWatchPersistenceFailure();
      logger.child({ sessionId, runtime: live.record.runtime }).warn(
        `watch ledger persistence failed (${reason}); retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.schedulePersist(sessionId, live, this.persistenceRetryMs, 'retry');
    });
  }

  private toResponse(record: PersistedWatch): WatchResponse {
    const pendingConditionIds = record.conditions.filter((c) => !c.fired).map((c) => c.id);
    return {
      watchId: record.watchId,
      sessionId: record.sessionId,
      runtime: record.runtime,
      label: record.label,
      status: record.status,
      pinned: record.pinned,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      conditions: record.conditions,
      firings: record.firings,
      firingCount: record.firings.length,
      pendingConditionIds,
      allFired: pendingConditionIds.length === 0,
      ...(record.onFire ? { onFire: record.onFire } : {}),
      wakeAttempts: record.wakeAttempts ?? [],
      snapshot: { ...record.snapshot } as WatchSnapshot,
    };
  }
}

/** Thrown for invalid registration input so the route layer can return 400. */
export class WatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchValidationError';
  }
}

export type { WatchConditionSpec };
