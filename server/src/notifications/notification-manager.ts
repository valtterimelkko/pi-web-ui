/**
 * Notification Manager
 *
 * The orchestration core of the notification layer. It owns a private
 * InternalApiEventBroker (subscribed-to exactly like WatchManager) and, for
 * every opted-in session, attaches a service-level observer on that session's
 * runtime service. The observer publishes the session's normalized events into
 * the broker; the manager reacts to `agent_end` by building a Notification
 * (tail of what the agent last said + deep link) and dispatching it through the
 * ChannelRouter, with a durable outbox + retry that survives restart.
 *
 * Origin-independence (the §4 gap): because the manager attaches the observer
 * directly to the service — not via the Internal-API prompt path — it sees
 * `agent_end` for sessions started in the browser on ALL FOUR runtimes
 * (Claude/Antigravity observers are added in Phase 3; Pi/OpenCode already had
 * the method). Self-contained: no reference to routes/sessions.ts or its broker.
 */

import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { canonicalOptInId } from '@pi-web-ui/shared';
import { InternalApiEventBroker } from '../internal-api/event-broker.js';
import { NotificationStore } from './notification-store.js';
import { ChannelRouter } from './channels/notification-channel.js';
import { formatNotification } from './notification-formatter.js';
import { createLogger } from '../logging/logger.js';
import type { NotificationIngressSpool } from './notification-ingress-spool.js';
import { getOperationalMetrics, type OperationalMetrics } from '../observability/operational-metrics.js';
import type {
  DeliveryRecord,
  Notification,
  NotificationRuntime,
  OptInRecord,
  QueuedNotification,
} from './types.js';

const logger = createLogger('NotificationManager');

/** The observer-attach seam every runtime service exposes (Pi/OpenCode native; Claude/AG added in P3). */
export interface NotificationServiceObserver {
  addApiObserver(key: string, observer: (event: unknown) => void): void;
  removeApiObserver(key: string, observer: (event: unknown) => void): void;
}

export interface NotificationServices {
  pi?: NotificationServiceObserver;
  claude?: NotificationServiceObserver;
  opencode?: NotificationServiceObserver;
  antigravity?: NotificationServiceObserver;
}

export interface NotificationManagerDeps {
  /** Master switch. When false, no observers are attached and the outbox is not drained. */
  enabled: boolean;
  store: NotificationStore;
  router: ChannelRouter;
  /** Inject for tests; a private broker is created otherwise. */
  broker?: InternalApiEventBroker;
  services: NotificationServices;
  tailMaxChars: number;
  publicBaseUrl?: string;
  debounceMs: number;
  maxAttempts: number;
  retryBackoffMs?: number;
  /** Injectable clock (ISO string) for deterministic tests. */
  now?: () => string;
  /**
   * Resolves the operator-facing session name live at flush time — the renamed
   * display name persisted in web-ui-prefs.json. Injected so the manager stays
   * decoupled from the preferences module and tests stay deterministic. When
   * omitted, or when it returns nothing usable, the manager falls back to the
   * opt-in record's snapshot `label`, then the runtime label.
   */
  resolveLabel?: (sessionPath: string) => Promise<string | undefined>;
  /** Optional durable terminal-ingress spool, isolated per server instance. */
  ingressSpool?: NotificationIngressSpool;
  ingressPollMs?: number;
  metrics?: OperationalMetrics;
}

export class NotificationIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT' as const;

  constructor() {
    super('The Idempotency-Key was already used for a different notification payload.');
    this.name = 'NotificationIdempotencyConflictError';
  }
}

export interface ExplicitNotificationAcceptance {
  notification: Notification;
  duplicate: boolean;
}

interface ObservedSession {
  record: OptInRecord;
  observer: (event: unknown) => void;
  brokerUnsub: () => void;
  /** Accumulated text of the current assistant message (reset on each assistant turn). */
  assistantTail: string;
  /** Guards against clearing text from a newer turn while durable enqueue awaits I/O. */
  tailVersion: number;
  /** Agent-end snapshots waiting for durable outbox acceptance, oldest first. */
  pendingTails: Array<{ tail: string; version: number }>;
  /** Latest snapshot inside the debounce window (duplicate agent_end coalescing). */
  debouncedTail: { tail: string; version: number } | null;
  flushPromise: Promise<void> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export class NotificationManager {
  private readonly deps: NotificationManagerDeps;
  private readonly broker: InternalApiEventBroker;
  private readonly now: () => string;
  private readonly metrics: OperationalMetrics;
  private readonly observed = new Map<string, ObservedSession>();
  private drainPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private ingressTimer: ReturnType<typeof setInterval> | null = null;
  private ingressDrainPromise: Promise<void> | null = null;
  private shutdownFlushPromise: Promise<void> | null = null;
  private shutdownFlushError: unknown = null;
  private shutDown = false;

  constructor(deps: NotificationManagerDeps) {
    this.deps = deps;
    this.broker = deps.broker ?? new InternalApiEventBroker();
    this.now = deps.now ?? (() => new Date().toISOString());
    this.metrics = deps.metrics ?? getOperationalMetrics();
  }

  async init(): Promise<void> {
    await this.deps.store.init();
    if (this.deps.ingressSpool) {
      await this.deps.ingressSpool.init();
      await this.drainIngress();
      this.ingressTimer = setInterval(() => {
        void this.drainIngress().catch((error) => logger.errorObject('notification ingress drain failed', error));
      }, this.deps.ingressPollMs ?? 5000);
      this.ingressTimer.unref?.();
    }
    if (!this.deps.enabled) return;
    // One-time canonical-id normalization (desync self-heal) BEFORE rehydration,
    // so observers attach from the normalized records only (no duplicate husk).
    await this.migrateOptIns();
    // Rehydration: re-attach observers for every still-opted-in session.
    const optIns = this.deps.store.listOptIns();
    for (const record of optIns) {
      this.attach(record);
    }
    logger.info(`rehydrated ${optIns.length} opted-in session(s)`);
    if (this.deps.router.listConfigured().length === 0) {
      logger.warn('notifications enabled but no delivery channel is configured (queued notifications will never drain)');
    }
    // Resume draining anything left pending from before a restart.
    void this.drain();
  }

  /**
   * Re-key legacy opt-ins to the stable canonical identity (Pi: bare uuid from
   * the path), so the bell stays in sync after a reload and turning it off
   * actually stops notifications. Dedupes records that collapse to the same
   * canonical id, keeping the newest `optedInAt` — this removes the stale husk
   * that would otherwise double-notify. Superset-preserving: every distinct
   * session survives, only divergent/duplicate keys are reconciled. Idempotent.
   */
  private async migrateOptIns(): Promise<void> {
    const optIns = this.deps.store.listOptIns();
    if (optIns.length === 0) return;
    const canonical = new Map<string, OptInRecord>();
    let normalized = 0;
    let deduped = 0;
    for (const record of optIns) {
      const id = canonicalOptInId(record.runtime, record.sessionId, record.sessionPath);
      if (id !== record.sessionId) normalized++;
      const incoming: OptInRecord = id === record.sessionId ? record : { ...record, sessionId: id };
      const existing = canonical.get(id);
      if (!existing) {
        canonical.set(id, incoming);
      } else {
        // Two records collapse to the same canonical id (a basename + a uuid for
        // the same session). Keep the newest optedInAt; the loser is the stale
        // husk that would double-notify.
        deduped++;
        canonical.set(id, isNewer(incoming, existing) ? incoming : existing);
      }
    }
    if (normalized === 0 && deduped === 0) return; // already canonical
    const canonicalKeys = new Set(canonical.keys());
    // Remove every old key that did not survive (re-keyed or deduped away), then
    // (re)write each canonical record. setOptIn overwrites by key, so a surviving
    // uuid key whose payload changed is replaced in place.
    for (const record of optIns) {
      if (!canonicalKeys.has(record.sessionId)) {
        await this.deps.store.removeOptIn(record.sessionId);
      }
    }
    for (const rec of canonical.values()) {
      await this.deps.store.setOptIn(rec);
    }
    logger.info(
      `normalized ${normalized} legacy opt-in id(s)${deduped > 0 ? `, deduped ${deduped} duplicate husk(s)` : ''}`,
    );
  }

  async optIn(record: OptInRecord): Promise<void> {
    const existing = this.deps.store.getOptIn(record.sessionId);
    if (
      existing
      && (existing.runtime !== record.runtime || existing.sessionPath !== record.sessionPath)
    ) {
      logger.child({ sessionId: record.sessionId, runtime: record.runtime }).warn(
        'notification opt-in identity replaced an existing runtime/path binding',
      );
    }
    await this.deps.store.setOptIn(record);
    const log = logger.child({ sessionId: record.sessionId, runtime: record.runtime });
    log.info('opted in for agent_end notifications');
    if (!this.deps.enabled) {
      log.debug('notifications globally disabled; opt-in persisted but no observer attached');
      return;
    }
    this.attach(record); // idempotent: detaches any prior observation first
  }

  async optOut(sessionId: string): Promise<void> {
    await this.deps.store.removeOptIn(sessionId);
    logger.child({ sessionId }).info('opted out of agent_end notifications');
    this.detach(sessionId);
  }

  getOptIn(sessionId: string): OptInRecord | undefined {
    return this.deps.store.getOptIn(sessionId);
  }

  listOptIns(): OptInRecord[] {
    return this.deps.store.listOptIns();
  }

  listDeliveriesForSession(sessionId: string): QueuedNotification[] {
    return this.deps.store.listForSession(sessionId);
  }

  listRecentDeliveries(limit?: number): QueuedNotification[] {
    return this.deps.store.listLog(limit);
  }

  /**
   * Emit a notification directly (Agent OS / operator scripts). Deterministic —
   * independent of model behavior and of the agent_end pathway. No session
   * required. Dispatched through the same durable outbox.
   */
  async emitExplicit(input: {
    title: string;
    body: string;
    deepLink?: string;
  }): Promise<Notification> {
    return (await this.acceptExplicit(input)).notification;
  }

  async acceptExplicit(
    input: { title: string; body: string; deepLink?: string },
    idempotencyKey?: string,
  ): Promise<ExplicitNotificationAcceptance> {
    const ingress = idempotencyKey
      ? {
          keyHash: sha256(idempotencyKey),
          fingerprint: sha256(JSON.stringify({
            title: input.title,
            body: input.body,
            deepLink: input.deepLink ?? null,
          })),
        }
      : undefined;

    const notification: Notification = {
      id: uuidv4(),
      kind: 'explicit',
      title: input.title,
      body: input.body,
      deepLink: input.deepLink,
      createdAt: this.now(),
    };

    if (ingress) {
      const delivery: DeliveryRecord = {
        notificationId: notification.id,
        channel: 'telegram',
        status: 'pending',
        attempts: 0,
        firstQueuedAt: this.now(),
      };
      const accepted = await this.deps.store.enqueueIdempotent({ notification, delivery, ingress });
      if (accepted.conflict) throw new NotificationIdempotencyConflictError();
      if (!accepted.duplicate) this.metrics.recordNotificationQueued();
      this.kickDrain();
      if (!accepted.duplicate) logger.info(`explicit notification queued: ${accepted.item.notification.id}`);
      return { notification: accepted.item.notification, duplicate: accepted.duplicate };
    }

    await this.enqueue(notification);
    logger.info(`explicit notification queued: ${notification.id}`);
    return { notification, duplicate: false };
  }

  getDeliveryStatus(notificationId: string): QueuedNotification | undefined {
    return this.deps.store.getById(notificationId);
  }

  shutdown(): void {
    if (this.shutDown) return;
    this.shutDown = true;
    const pendingFlushes: Promise<void>[] = [];
    for (const [sessionId, observed] of this.observed) {
      const hadTimer = Boolean(observed.debounceTimer);
      if (observed.debounceTimer) {
        clearTimeout(observed.debounceTimer);
        observed.debounceTimer = null;
      }
      if (
        hadTimer
        || observed.flushPromise
        || observed.pendingTails.length > 0
        || observed.debouncedTail
      ) {
        // Join an in-flight flush or start the pending one while the observed
        // record is still available. Shutdown persists but never sends it.
        pendingFlushes.push(this.flush(sessionId));
      }
    }
    this.shutdownFlushPromise = Promise.allSettled(pendingFlushes).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        this.shutdownFlushError = new AggregateError(
          failures.map((result) => (result as PromiseRejectedResult).reason),
          'Failed to persist pending notification flushes during shutdown',
        );
      }
    });
    for (const sessionId of [...this.observed.keys()]) this.detach(sessionId);
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ingressTimer) {
      clearInterval(this.ingressTimer);
      this.ingressTimer = null;
    }
  }

  /** Await already-started disk/network work after shutdown has stopped new work. */
  async waitForIdle(): Promise<void> {
    if (this.shutdownFlushPromise) await this.shutdownFlushPromise;
    if (this.shutdownFlushError) throw this.shutdownFlushError;
    await Promise.allSettled([
      this.drainPromise ?? Promise.resolve(),
      this.ingressDrainPromise ?? Promise.resolve(),
    ]);
  }

  async drainIngress(): Promise<void> {
    if (!this.deps.ingressSpool || this.shutDown) return;
    if (this.ingressDrainPromise) return this.ingressDrainPromise;
    this.ingressDrainPromise = this.drainIngressBatch().finally(() => {
      this.ingressDrainPromise = null;
    });
    return this.ingressDrainPromise;
  }

  private async drainIngressBatch(): Promise<void> {
    const spool = this.deps.ingressSpool;
    if (!spool) return;
    const claims = await spool.claimBatch();
    for (let index = 0; index < claims.length; index += 1) {
      const claim = claims[index];
      try {
        await this.acceptExplicit({
          title: claim.record.title,
          body: claim.record.body,
          deepLink: claim.record.deepLink,
        }, claim.record.idempotencyKey);
        await spool.complete(claim);
      } catch (error) {
        if (error instanceof NotificationIdempotencyConflictError) {
          logger.warn(`discarded conflicting notification ingress key hash: ${sha256(claim.record.idempotencyKey).slice(0, 12)}`);
          await spool.complete(claim);
        } else {
          const retryFailures: unknown[] = [];
          // Every claim was renamed before processing began. Restore the current
          // and all later claims so one transient failure cannot strand them.
          for (const unprocessed of claims.slice(index)) {
            await spool.retry(unprocessed).catch((retryError) => retryFailures.push(retryError));
          }
          if (retryFailures.length > 0) {
            throw new AggregateError([error, ...retryFailures], 'Notification ingress recovery failed');
          }
          throw error;
        }
      }
    }
  }

  /** Process pending outbox items. Concurrent callers join one drain operation. */
  async drain(): Promise<void> {
    if (this.shutDown || !this.deps.enabled) return;
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainPending().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drainPending(): Promise<void> {
    if (this.deps.router.listConfigured().length === 0) return;
    // Include items durably enqueued while this drain is already active. Failed
    // items are attempted at most once per drain and left for bounded retry.
    const attempted = new Set<string>();
    let batch = this.deps.store.listPending()
      .filter((item) => !attempted.has(item.notification.id));
    while (batch.length > 0) {
      for (const item of batch) {
        attempted.add(item.notification.id);
        await this.tryDeliver(item);
      }
      batch = this.deps.store.listPending()
        .filter((item) => !attempted.has(item.notification.id));
    }
    if (this.deps.store.listPending().length > 0) this.scheduleRetry();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async tryDeliver(item: QueuedNotification): Promise<void> {
    const results = await this.deps.router.route(item.notification);
    const ok = results.length > 0 && results.every((r) => r.ok);
    const log = logger.child({
      sessionId: item.notification.sessionId,
      runtime: item.notification.runtime,
    });
    if (ok) {
      await this.deps.store.markSent(item.notification.id, this.now());
      this.metrics.recordNotificationSent();
      log.info(`notification delivered: ${item.notification.id}`);
      return;
    }
    const attempts = item.delivery.attempts + 1;
    const terminal = attempts >= this.deps.maxAttempts;
    const error = results.find((r) => !r.ok)?.error ?? 'delivery failed';
    log.warn(
      `notification delivery attempt ${attempts} failed${terminal ? ' (terminal, giving up)' : ''}: ${item.notification.id} — ${error}`,
    );
    await this.deps.store.recordFailure(item.notification.id, error, terminal);
    this.metrics.recordNotificationFailure(terminal);
  }

  private serviceFor(runtime: NotificationRuntime): NotificationServiceObserver | undefined {
    return this.deps.services[runtime];
  }

  /** Pi identifies sessions by path; the others by id. */
  private serviceKey(record: OptInRecord): string {
    return record.runtime === 'pi' ? record.sessionPath : record.sessionId;
  }

  private attach(record: OptInRecord): void {
    if (this.observed.has(record.sessionId)) this.detach(record.sessionId);
    const service = this.serviceFor(record.runtime);
    const log = logger.child({ sessionId: record.sessionId, runtime: record.runtime });
    if (!service) {
      // Silent-failure blind spot otherwise: the opt-in persists and the UI
      // shows "on" forever, but no observer is ever attached.
      log.warn('cannot attach observer: runtime service not wired for this build');
      return;
    }
    log.debug('observer attached');
    const sessionId = record.sessionId;
    const observer = (event: unknown) => {
      try {
        this.broker.publish(sessionId, event as NormalizedEvent);
      } catch {
        /* non-fatal */
      }
    };
    service.addApiObserver(this.serviceKey(record), observer);
    const brokerUnsub = this.broker.subscribe(
      sessionId,
      (event) => this.handleEvent(sessionId, event),
      false, // no replay: we only react to live agent_end
      'notification',
    );
    this.observed.set(sessionId, {
      record,
      observer,
      brokerUnsub,
      assistantTail: '',
      tailVersion: 0,
      pendingTails: [],
      debouncedTail: null,
      flushPromise: null,
      debounceTimer: null,
    });
  }

  private detach(sessionId: string): void {
    const obs = this.observed.get(sessionId);
    if (!obs) return;
    const service = this.serviceFor(obs.record.runtime);
    if (service) {
      try {
        service.removeApiObserver(this.serviceKey(obs.record), obs.observer);
      } catch {
        /* non-fatal */
      }
    }
    try {
      obs.brokerUnsub();
    } catch {
      /* non-fatal */
    }
    if (obs.debounceTimer) clearTimeout(obs.debounceTimer);
    logger.child({ sessionId, runtime: obs.record.runtime }).debug('observer detached');
    this.observed.delete(sessionId);
  }

  private handleEvent(sessionId: string, event: NormalizedEvent): void {
    const obs = this.observed.get(sessionId);
    if (!obs) return;
    switch (event.type) {
      case 'message_start': {
        const data = event.data as { role?: string } | undefined;
        if (data?.role === 'assistant') {
          obs.assistantTail = '';
          obs.tailVersion += 1;
        }
        break;
      }
      case 'message_update': {
        const delta = extractTextDelta(event.data);
        if (delta) {
          obs.assistantTail += delta;
          obs.tailVersion += 1;
        }
        break;
      }
      case 'agent_end':
        logger
          .child({ sessionId, runtime: obs.record.runtime })
          .debug('agent_end observed; scheduling notification flush');
        this.scheduleFlush(sessionId);
        break;
      default:
        break;
    }
  }

  private scheduleFlush(
    sessionId: string,
    delayMs = this.deps.debounceMs,
    captureCurrentTail = true,
  ): void {
    const obs = this.observed.get(sessionId);
    if (!obs) return;
    // Snapshot only for a real agent_end. Retries must not turn partial text
    // from a newer in-flight turn into a notification.
    if (captureCurrentTail) {
      obs.debouncedTail = { tail: obs.assistantTail, version: obs.tailVersion };
    }
    if (obs.debounceTimer) clearTimeout(obs.debounceTimer);
    obs.debounceTimer = setTimeout(() => {
      obs.debounceTimer = null;
      void this.flush(sessionId).catch((err) => {
        logger.child({ sessionId }).errorObject('notification flush failed', err);
        if (!this.shutDown && this.observed.get(sessionId) === obs) {
          this.scheduleFlush(sessionId, this.deps.retryBackoffMs ?? 5000, false);
        }
      });
    }, delayMs);
    obs.debounceTimer.unref?.();
  }

  private async flush(sessionId: string): Promise<void> {
    const obs = this.observed.get(sessionId);
    if (!obs) return;
    if (obs.flushPromise) return obs.flushPromise;
    obs.flushPromise = this.flushPending(sessionId, obs).finally(() => {
      obs.flushPromise = null;
    });
    return obs.flushPromise;
  }

  private async flushPending(sessionId: string, obs: ObservedSession): Promise<void> {
    if (obs.debouncedTail) {
      obs.pendingTails.push(obs.debouncedTail);
      obs.debouncedTail = null;
    }
    let pending = obs.pendingTails[0];
    while (pending) {
      const { tail, version: tailVersion } = pending;
      // Live-resolve the operator-facing session name (the renamed display name)
      // so a rename after opt-in is reflected. Falls back to the opt-in snapshot
      // label, then the formatter's runtime label. A resolver failure must never
      // break a notification.
      const liveLabel = await this.resolveLabelSafe(obs.record.sessionPath);
      const label = (liveLabel && liveLabel.trim()) || obs.record.label;
      const formatted = formatNotification(
        {
          sessionId,
          runtime: obs.record.runtime,
          label,
          kind: 'agent_end',
          tail,
        },
        { tailMaxChars: this.deps.tailMaxChars, publicBaseUrl: this.deps.publicBaseUrl },
      );
      const notification: Notification = {
        id: uuidv4(),
        sessionId,
        runtime: obs.record.runtime,
        kind: 'agent_end',
        title: formatted.title,
        body: formatted.body,
        deepLink: formatted.deepLink,
        createdAt: this.now(),
      };
      await this.enqueueAndDispatch(notification);
      // Clear only after durable acceptance, and never erase a newer turn that
      // arrived while label resolution or the outbox write was in flight.
      obs.pendingTails.shift();
      if (obs.tailVersion === tailVersion) obs.assistantTail = '';
      logger
        .child({ sessionId, runtime: obs.record.runtime })
        .info(`agent_end notification queued: ${notification.id}`);
      if (obs.debouncedTail) {
        obs.pendingTails.push(obs.debouncedTail);
        obs.debouncedTail = null;
      }
      pending = obs.pendingTails[0];
    }
  }

  /** Runs the injected label resolver, swallowing errors (best-effort enrichment). */
  private async resolveLabelSafe(sessionPath: string): Promise<string | undefined> {
    if (!this.deps.resolveLabel) return undefined;
    try {
      return await this.deps.resolveLabel(sessionPath);
    } catch {
      return undefined;
    }
  }

  private async enqueueAndDispatch(notification: Notification): Promise<void> {
    await this.enqueue(notification);
  }

  private async enqueue(
    notification: Notification,
    ingress?: QueuedNotification['ingress'],
  ): Promise<void> {
    const delivery: DeliveryRecord = {
      notificationId: notification.id,
      channel: 'telegram',
      status: 'pending',
      attempts: 0,
      firstQueuedAt: this.now(),
    };
    await this.deps.store.enqueue({ notification, delivery, ingress });
    this.metrics.recordNotificationQueued();
    this.kickDrain();
  }

  private kickDrain(): void {
    void this.drain().catch((error) => logger.errorObject('notification drain failed', error));
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.shutDown) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, this.deps.retryBackoffMs ?? 5000);
  }
}

/** Best-effort extraction of an assistant text delta from a normalized event payload. */
function extractTextDelta(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const ame = d.assistantMessageEvent as Record<string, unknown> | undefined;
  if (ame && ame.type === 'text_delta' && typeof ame.delta === 'string') {
    return ame.delta;
  }
  if (typeof d.text === 'string') return d.text;
  return null;
}

/** Whether `a` is at least as recent as `b` by optedInAt (used to pick the survivor on dedupe). */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNewer(a: OptInRecord, b: OptInRecord): boolean {
  // Routes persist fixed-width UTC ISO stamps from Date#toISOString, for which
  // lexical ordering is chronological. Legacy missing values sort oldest.
  return (a.optedInAt ?? '') >= (b.optedInAt ?? '');
}