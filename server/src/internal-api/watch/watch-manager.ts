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

import { randomUUID } from 'node:crypto';
import type { InternalApiEventBroker } from '../event-broker.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { describeWatchCondition } from '@pi-web-ui/shared';
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
  WatchWakeDeliveryKind,
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
  mode: 'prompt' | 'follow_up' | 'steer';
  /** Stable per-attempt key so a retried dispatch cannot double-prompt. */
  idempotencyKey: string;
}

export type WatchWakeDispatchResult =
  | { status: 'dispatched'; runId?: string; deliveryKind?: WatchWakeDeliveryKind }
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
  /** Contract 1.34.0 surfacing: called on watch_registered / watch_fired when the watch has parent linkage. */
  surface?: (record: PersistedWatch, event: { type: 'watch_registered' | 'watch_fired'; timestamp: number; data: Record<string, unknown> }) => void;
}

export interface RegisterWatchParams {
  sessionId: string;
  sessionPath: string;
  runtime: SessionRuntime;
  request: RegisterWatchRequest;
  /** Contract 1.34.0 surfacing: the arming (parent) session, resolved by the route. */
  sourceSessionId?: string;
  /** Broker publish key for the source session (pi = path). */
  sourceBrokerKey?: string;
}

export interface WatchDeleteResult {
  deleted: boolean;
  generation?: string;
  watchId?: string;
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
  /** At most one bounded transient retry timer per firing; cleared on teardown. */
  wakeRetryTimers: Set<NodeJS.Timeout>;
}

const DEFAULT_MAX_PER_CONDITION = 50;
const DEFAULT_MAX_TOTAL = 500;
const SNAPSHOT_FLUSH_MS = 1000;
const MAX_WAKE_ATTEMPTS_RECORDED = 50;
const TRANSIENT_WAKE_ERRORS = new Set([
  'SESSION_BUSY',
  'ADMISSION_CAPACITY_EXHAUSTED',
  'WAKE_DISPATCH_UNAVAILABLE',
  'WAKE_DISPATCH_ERROR',
  'SESSION_NOT_STREAMING',
]);

function consumesWakeBudget(attempt: WatchWakeAttempt): boolean {
  return attempt.status === 'dispatched'
    || (attempt.status === 'failed' && !TRANSIENT_WAKE_ERRORS.has(attempt.errorCode ?? ''))
    || attempt.status === 'pending';
}

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
  const targetSessionId = action.targetSessionId.trim();
  if (targetSessionId === sessionId) {
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
  if (action.mode !== undefined && action.mode !== 'prompt' && action.mode !== 'follow_up' && action.mode !== 'steer') {
    throw new WatchValidationError("onFire.mode must be 'prompt', 'follow_up', or 'steer'");
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
    targetSessionId,
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
  private readonly surface?: WatchManagerDeps['surface'];
  /** Live watches keyed by sessionId. */
  private readonly active = new Map<string, ActiveWatch>();
  /** Minimal cross-watch backpressure: one in-flight steer dispatch per target. */
  private readonly pendingSteerTargets = new Set<string>();
  /** Per-session mutation chains make generation checks and destructive steps atomic. */
  private readonly mutationChains = new Map<string, Promise<unknown>>();
  private initialized = false;
  private initialization?: Promise<void>;

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
    this.surface = deps.surface;
  }

  /**
   * Load persisted watches from disk. Reloaded watches are marked `detached`:
   * their past firings remain readable, but they have no live subscription
   * until re-registered (the runtime/session may be entirely fresh after a
   * restart). This is what the durability guarantee rests on.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = (async () => {
        await this.store.init();
        for (const record of this.store.list()) {
          let changed = false;
          const migrated: PersistedWatch = { ...record };
          if (!migrated.generation) {
            migrated.generation = randomUUID();
            changed = true;
          }
          if (migrated.status === 'active') {
            migrated.status = 'detached';
            changed = true;
          }
          // Never mutate the cache-owned legacy object before durability. A
          // failed save must leave the migration visible for the next init.
          if (changed) await this.store.save(migrated);
        }
        this.initialized = true;
      })();
    }
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  private withSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChains.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.mutationChains.set(sessionId, next);
    void next.finally(() => {
      if (this.mutationChains.get(sessionId) === next) this.mutationChains.delete(sessionId);
    }).catch(() => undefined);
    return next;
  }

  /** Create or replace the watch for a session. Throws on an invalid condition spec. */
  async register(params: RegisterWatchParams): Promise<WatchResponse> {
    await this.init();
    return this.withSessionMutation(params.sessionId, () => this.registerLocked(params));
  }

  private async registerLocked(params: RegisterWatchParams): Promise<WatchResponse> {
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

    // The check and every destructive step below execute inside the same
    // per-session mutation chain. A route-level pre-read would not be CAS.
    const previousLive = this.active.get(sessionId);
    const previous = previousLive?.record ?? this.store.get(sessionId);
    const expectedGeneration = request.expectedGeneration;
    if (expectedGeneration !== undefined) {
      const currentGeneration = previous?.generation ?? null;
      const matches = expectedGeneration === null
        ? previous === undefined
        : previous !== undefined && currentGeneration === expectedGeneration;
      if (!matches) {
        throw new WatchGenerationMismatchError({
          expectedGeneration,
          currentGeneration,
          watchId: previous?.watchId ?? `watch-${sessionId}`,
        });
      }
    }

    const watchId = `watch-${sessionId}`;
    const claimId = `watch:${watchId}`;

    // Prepare only claims the prior generation does not already own. The old
    // observer and its claims remain intact until the candidate is durable, so
    // a rejected replacement requires no lossy re-registration rollback.
    const reuseSubjectClaim = request.pin !== false && previous?.pinned === true;
    let pinned = reuseSubjectClaim;
    let newSubjectClaim = false;
    if (request.pin !== false && !reuseSubjectClaim) {
      try {
        pinned = await this.pinSession(sessionId, claimId);
        newSubjectClaim = pinned;
      } catch {
        pinned = false;
      }
    }

    const previousTargetId = previous?.targetPinned && previous.onFire
      ? previous.onFire.targetSessionId
      : undefined;
    const desiredTargetId = onFire && onFire.pinTarget !== false
      ? onFire.targetSessionId
      : undefined;
    const reuseTargetClaim = desiredTargetId !== undefined && desiredTargetId === previousTargetId;
    let targetPinned = reuseTargetClaim;
    let newTargetClaim = false;
    if (desiredTargetId && !reuseTargetClaim) {
      try {
        targetPinned = await this.pinSession(desiredTargetId, `watch-target:${watchId}`);
        newTargetClaim = targetPinned;
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
      generation: randomUUID(),
      sessionId,
      sessionPath,
      runtime,
      label: request.label,
      ...(params.sourceSessionId ? { sourceSessionId: params.sourceSessionId } : {}),
      ...(params.sourceBrokerKey ? { sourceBrokerKey: params.sourceBrokerKey } : {}),
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

    try {
      await this.store.save(record);
    } catch (error) {
      // The old generation is still live/durable. Release only claims newly
      // prepared for this rejected candidate; reused old claims stay intact.
      if (newSubjectClaim && this.unpinSession) {
        await Promise.resolve(this.unpinSession(sessionId, claimId)).catch(() => false);
      }
      if (newTargetClaim && desiredTargetId && this.unpinSession) {
        await Promise.resolve(this.unpinSession(desiredTargetId, `watch-target:${watchId}`)).catch(() => false);
      }
      throw error;
    }

    // Durability commits the replacement. Only now rotate the old generation's
    // claims. Even same-id claims are explicitly released/reacquired under this
    // session mutation, preserving existing claim lifecycle semantics.
    if (previous?.pinned && this.unpinSession) {
      await Promise.resolve(this.unpinSession(sessionId, `watch:${previous.watchId}`)).catch(() => false);
      if (reuseSubjectClaim) {
        record.pinned = await Promise.resolve(this.pinSession(sessionId, claimId)).catch(() => false);
      }
    }
    if (previous?.targetPinned && previousTargetId && this.unpinSession) {
      await Promise.resolve(this.unpinSession(previousTargetId, `watch-target:${previous.watchId}`)).catch(() => false);
      if (reuseTargetClaim && desiredTargetId) {
        record.targetPinned = await Promise.resolve(this.pinSession(desiredTargetId, `watch-target:${watchId}`)).catch(() => false);
      }
    }
    if (previousLive) this.teardown(sessionId);
    this.activateWatch(record, resolved);

    // Contract 1.34.0 surfacing: announce the registration to the arming
    // session's surfaces (never fatal, and only when linkage exists).
    if (this.surface && record.sourceSessionId) {
      try {
        this.surface(record, {
          type: 'watch_registered',
          timestamp: Date.now(),
          data: {
            sessionId: record.sourceSessionId,
            watch: {
              watchId: record.watchId,
              targetSessionId: record.sessionId,
              ...(record.label ? { label: record.label } : {}),
              status: record.status,
              conditions: record.conditions.map((c) => ({
                id: c.id,
                type: c.type,
                description: describeWatchCondition(c.spec as never),
              })),
            },
          },
        });
      } catch { /* surfacing is best-effort */ }
    }

    return { ...this.toResponse(record), replaced: previous !== undefined };
  }

  /** Current watch for a session (live or reloaded-detached), if any. */
  get(sessionId: string): WatchResponse | undefined {
    const live = this.active.get(sessionId);
    if (live) return this.toResponse(live.record);
    const persisted = this.store.get(sessionId);
    return persisted ? this.toResponse(persisted) : undefined;
  }

  /** Legacy delete projection retained for internal callers that do not need the generation receipt. */
  async delete(sessionId: string): Promise<boolean> {
    return (await this.deleteWithPrecondition(sessionId)).deleted;
  }

  /** Generation-aware delete; precondition check and teardown are one atomic manager mutation. */
  async deleteWithPrecondition(sessionId: string, expectedGeneration?: string): Promise<WatchDeleteResult> {
    await this.init();
    return this.withSessionMutation(sessionId, async () => {
      const record = this.active.get(sessionId)?.record ?? this.store.get(sessionId);
      if (expectedGeneration !== undefined && record?.generation !== expectedGeneration) {
        throw new WatchGenerationMismatchError({
          expectedGeneration,
          currentGeneration: record?.generation ?? null,
          watchId: record?.watchId ?? `watch-${sessionId}`,
        });
      }
      if (!record) return { deleted: false };
      if (!record.generation) throw new Error('Watch generation missing after initialization');
      const generation = record.generation;
      this.teardown(sessionId);
      if (record.pinned && this.unpinSession) {
        await Promise.resolve(this.unpinSession(sessionId, `watch:${record.watchId}`)).catch(() => false);
      }
      if (record.targetPinned && record.onFire && this.unpinSession) {
        await Promise.resolve(this.unpinSession(record.onFire.targetSessionId, `watch-target:${record.watchId}`)).catch(() => false);
      }
      await this.store.delete(sessionId);
      return { deleted: true, generation, watchId: record.watchId };
    });
  }

  private activateWatch(record: PersistedWatch, resolved: ResolvedCondition[]): ActiveWatch {
    const live: ActiveWatch = {
      record,
      engine: new ConditionEngine(resolved),
      resolved,
      unsub: [],
      snapshotDirty: false,
      wakeChain: Promise.resolve(),
      wakeRetryTimers: new Set(),
    };
    const handler = (event: NormalizedEvent) => {
      if (this.active.get(record.sessionId) === live) this.handleEvent(record.sessionId, event);
    };
    // Match the historical publication order: replay delivered during subscribe
    // predates this accepted generation and must not seed its fresh ledger.
    live.unsub.push(this.broker.subscribe(record.sessionId, handler, true, 'watch'));
    if (record.sessionPath && record.sessionPath !== record.sessionId) {
      live.unsub.push(this.broker.subscribe(record.sessionPath, handler, true, 'watch'));
    }
    this.active.set(record.sessionId, live);
    return live;
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
    for (const timer of live.wakeRetryTimers) clearTimeout(timer);
    live.wakeRetryTimers.clear();
    this.active.delete(sessionId);
  }

  private handleEvent(sessionId: string, event: NormalizedEvent): void {
    const live = this.active.get(sessionId);
    if (!live) return;
    const { record, engine } = live;
    if (record.status !== 'active') return;

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

        // Contract 1.34.0 surfacing: a pure-observer watch (no onFire — e.g.
        // the watch-wake extension's local-delivery flow) still announces its
        // firing to the arming session's surfaces. onFire watches announce at
        // successful dispatch instead, so deliveryKind can be included.
        if (!record.onFire && this.surface && record.sourceSessionId) {
          try {
            this.surface(record, {
              type: 'watch_fired',
              timestamp: Date.now(),
              data: {
                sessionId: record.sourceSessionId,
                watchId: record.watchId,
                targetSessionId: record.sessionId,
                conditionId: cond.id,
                firedAt: firing.firedAt,
              },
            });
          } catch { /* surfacing is best-effort */ }
        }

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
    if (firedSomething && !record.onFire && this.allOneShotConditionsFired(record)) {
      this.completeWatch(sessionId, live);
    }

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
    isRetry = false,
  ): void {
    const record = live.record;
    const action = record.onFire;
    if (!action) return;

    const now = Date.now();
    const dispatchedCount = record.wakeAttempts.filter(consumesWakeBudget).length;
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
      if (this.allOneShotConditionsFired(record)) this.completeWatch(sessionId, live);
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
      if (this.allOneShotConditionsFired(record)) this.completeWatch(sessionId, live);
      return;
    }

    if (action.mode === 'steer' && this.pendingSteerTargets.has(action.targetSessionId)) {
      this.appendWakeAttempt(record, {
        attemptedAt: now,
        targetSessionId: action.targetSessionId,
        status: 'suppressed',
        conditionId: context.conditionId,
        reason: 'steer_pending',
      });
      if (this.allOneShotConditionsFired(record)) this.completeWatch(sessionId, live);
      return;
    }
    if (action.mode === 'steer') this.pendingSteerTargets.add(action.targetSessionId);

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
      // The watch id is deterministic per session and survives replacement;
      // give each actual dispatch attempt a fresh receipt identity.
      idempotencyKey: `wake:${record.watchId}:${randomUUID()}`,
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
        if (result.status === 'dispatched') {
          if (result.runId) attempt.runId = result.runId;
          if (result.deliveryKind) attempt.deliveryKind = result.deliveryKind;
        } else attempt.errorCode = result.errorCode;
        record.updatedAt = new Date().toISOString();

        // Contract 1.34.0 surfacing: announce a successful wake to the arming
        // session's surfaces (once per firing, success only).
        if (result.status === 'dispatched' && this.surface && record.sourceSessionId) {
          try {
            this.surface(record, {
              type: 'watch_fired',
              timestamp: Date.now(),
              data: {
                sessionId: record.sourceSessionId,
                watchId: record.watchId,
                targetSessionId: record.sessionId,
                conditionId: attempt.conditionId,
                firedAt: context.firedAt,
                ...(attempt.deliveryKind ? { deliveryKind: attempt.deliveryKind } : {}),
              },
            });
          } catch { /* surfacing is best-effort */ }
        }
        if (live.flushTimer) { clearTimeout(live.flushTimer); live.flushTimer = undefined; }
        live.snapshotDirty = false;
        this.persistLive(sessionId, live, 'wake-attempt');

        const shouldRetry = result.status === 'failed'
          && TRANSIENT_WAKE_ERRORS.has(result.errorCode)
          && !isRetry;
        if (shouldRetry) {
          // Add 1 ms so the retry cannot land fractionally inside its own
          // cooldown window because of timer granularity.
          const delayMs = Math.max(1, (action.cooldownSeconds ?? 60) * 1000 + 1);
          const timer = setTimeout(() => {
            live.wakeRetryTimers.delete(timer);
            if (this.active.get(sessionId) === live) this.dispatchWakeForFiring(sessionId, live, context, true);
          }, delayMs);
          timer.unref?.();
          live.wakeRetryTimers.add(timer);
        } else if (this.allOneShotConditionsFired(record)) {
          this.completeWatch(sessionId, live);
        }
      })
      .finally(() => {
        if (action.mode === 'steer') this.pendingSteerTargets.delete(action.targetSessionId);
      })
      .catch(() => undefined); // persistence failures must not reject the chain
  }

  private allOneShotConditionsFired(record: PersistedWatch): boolean {
    return record.conditions.length > 0
      && record.conditions.every((condition) => condition.spec.once !== false && condition.fired);
  }

  /** Mark a terminal one-shot watch done, then release claims under session mutation authority. */
  private completeWatch(sessionId: string, live: ActiveWatch): void {
    const { record } = live;
    if (record.status === 'done'
      || !this.allOneShotConditionsFired(record)
      || record.wakeAttempts.some((attempt) => attempt.status === 'pending')
      || live.wakeRetryTimers.size > 0) return;
    record.status = 'done';
    record.updatedAt = new Date().toISOString();
    for (const unsubscribe of live.unsub.splice(0)) {
      try { unsubscribe(); } catch { /* non-fatal */ }
    }
    for (const timer of live.wakeRetryTimers) clearTimeout(timer);
    live.wakeRetryTimers.clear();

    void this.withSessionMutation(sessionId, async () => {
      if (this.active.get(sessionId) !== live) return;
      if (record.pinned && this.unpinSession) {
        const released = await Promise.resolve(this.unpinSession(sessionId, `watch:${record.watchId}`)).catch(() => false);
        if (this.active.get(sessionId) !== live) return;
        if (released) record.pinned = false;
      }
      if (record.targetPinned && record.onFire && this.unpinSession) {
        const released = await Promise.resolve(this.unpinSession(record.onFire.targetSessionId, `watch-target:${record.watchId}`)).catch(() => false);
        if (this.active.get(sessionId) !== live) return;
        if (released) record.targetPinned = false;
      }
      await this.persistLiveNow(sessionId, live, 'wake-attempt');
    }).catch(() => undefined);
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
    void this.persistLiveNow(sessionId, live, reason);
  }

  private async persistLiveNow(sessionId: string, live: ActiveWatch, reason: string): Promise<boolean> {
    if (this.active.get(sessionId) !== live || !live.record.generation) return false;
    try {
      await this.store.save(live.record, { expectedGeneration: live.record.generation });
      return this.active.get(sessionId) === live;
    } catch (error) {
      if (this.active.get(sessionId) !== live) return false;
      live.snapshotDirty = true;
      this.metrics.recordWatchPersistenceFailure();
      logger.child({ sessionId, runtime: live.record.runtime }).warn(
        `watch ledger persistence failed (${reason}); retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.schedulePersist(sessionId, live, this.persistenceRetryMs, 'retry');
      return false;
    }
  }

  private toResponse(record: PersistedWatch): WatchResponse {
    if (!record.generation) throw new Error('Watch generation missing after initialization');
    const pendingConditionIds = record.conditions.filter((c) => !c.fired).map((c) => c.id);
    return {
      watchId: record.watchId,
      generation: record.generation,
      sessionId: record.sessionId,
      runtime: record.runtime,
      label: record.label,
      status: record.status,
      pinned: record.pinned,
      ...(record.sourceSessionId ? { sourceSessionId: record.sourceSessionId } : {}),
      ...(record.sourceBrokerKey ? { sourceBrokerKey: record.sourceBrokerKey } : {}),
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

export class WatchGenerationMismatchError extends Error {
  readonly expectedGeneration: string | null;
  readonly currentGeneration: string | null;
  readonly watchId: string;

  constructor(input: { expectedGeneration: string | null; currentGeneration: string | null; watchId: string }) {
    super('Watch generation precondition did not match the current watch');
    this.name = 'WatchGenerationMismatchError';
    this.expectedGeneration = input.expectedGeneration;
    this.currentGeneration = input.currentGeneration;
    this.watchId = input.watchId;
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
