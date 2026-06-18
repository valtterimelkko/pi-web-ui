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
  WatchResponse,
  WatchSnapshot,
} from '../types.js';
import { ConditionEngine, resolveConditions, type ResolvedCondition } from './condition-evaluator.js';
import { WatchStore, type PersistedWatch } from './watch-store.js';

export interface WatchManagerDeps {
  broker: InternalApiEventBroker;
  /** Directory for the durable ledger files. */
  storeDir: string;
  /** Pin a session so idle eviction can't kill it mid-watch. Returns whether it is now pinned. */
  pinSession: (sessionId: string) => boolean | Promise<boolean>;
  /**
   * Optional hook to ensure events for a session flow into the broker before
   * any prompt/SSE consumer exists (Pi needs its persistent observer attached).
   */
  ensureObserver?: (sessionPath: string) => void;
  /** Cap on firings recorded per condition (when `once: false`). */
  maxFiringsPerCondition?: number;
  /** Hard cap on total ledger size per watch. */
  maxTotalFirings?: number;
}

interface ActiveWatch {
  record: PersistedWatch;
  engine: ConditionEngine;
  resolved: ResolvedCondition[];
  unsub: Array<() => void>;
  snapshotDirty: boolean;
  flushTimer?: NodeJS.Timeout;
}

const DEFAULT_MAX_PER_CONDITION = 50;
const DEFAULT_MAX_TOTAL = 500;
const SNAPSHOT_FLUSH_MS = 1000;

export class WatchManager {
  private readonly broker: InternalApiEventBroker;
  private readonly store: WatchStore;
  private readonly pinSession: WatchManagerDeps['pinSession'];
  private readonly ensureObserver?: WatchManagerDeps['ensureObserver'];
  private readonly maxPerCondition: number;
  private readonly maxTotal: number;
  /** Live watches keyed by sessionId. */
  private readonly active = new Map<string, ActiveWatch>();
  private initialized = false;

  constructor(deps: WatchManagerDeps) {
    this.broker = deps.broker;
    this.store = new WatchStore(deps.storeDir);
    this.pinSession = deps.pinSession;
    this.ensureObserver = deps.ensureObserver;
    this.maxPerCondition = deps.maxFiringsPerCondition ?? DEFAULT_MAX_PER_CONDITION;
    this.maxTotal = deps.maxTotalFirings ?? DEFAULT_MAX_TOTAL;
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

    // Replace any existing watch for this session.
    this.teardown(sessionId);

    let pinned = false;
    if (request.pin !== false) {
      try {
        pinned = await this.pinSession(sessionId);
      } catch {
        pinned = false;
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
      watchId: `watch-${sessionId}`,
      sessionId,
      sessionPath,
      runtime,
      label: request.label,
      status: 'active',
      pinned,
      createdAt: now,
      updatedAt: now,
      conditions,
      firings: [],
      snapshot: { status: 'idle', eventCount: 0, toolCallCount: 0, sawAgentEnd: false },
    };

    const engine = new ConditionEngine(resolved);
    const handler = (event: NormalizedEvent) => this.handleEvent(sessionId, event);
    const unsub: Array<() => void> = [this.broker.subscribe(sessionId, handler)];
    // Pi publishes events under the session *path*; other runtimes use the id
    // (which equals the path). Subscribe to both distinct keys so the watch
    // sees events regardless of which key the runtime publishes under.
    if (sessionPath && sessionPath !== sessionId) {
      unsub.push(this.broker.subscribe(sessionPath, handler));
    }

    this.active.set(sessionId, {
      record,
      engine,
      resolved,
      unsub,
      snapshotDirty: false,
    });

    await this.store.save(record);
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
    const existed = this.active.has(sessionId) || !!this.store.get(sessionId);
    this.teardown(sessionId);
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
      }
    }

    record.updatedAt = new Date().toISOString();

    if (firedSomething) {
      // Firings are rare and important — persist immediately so they survive a
      // crash a moment later.
      void this.store.save(record);
      if (live.flushTimer) { clearTimeout(live.flushTimer); live.flushTimer = undefined; }
      live.snapshotDirty = false;
    } else {
      // Snapshot-only churn (e.g. streaming deltas) is throttled to avoid disk
      // thrash; the next firing or the timer will flush it.
      live.snapshotDirty = true;
      if (!live.flushTimer) {
        live.flushTimer = setTimeout(() => {
          live.flushTimer = undefined;
          if (live.snapshotDirty) {
            live.snapshotDirty = false;
            void this.store.save(record);
          }
        }, SNAPSHOT_FLUSH_MS);
        if (live.flushTimer.unref) live.flushTimer.unref();
      }
    }
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
