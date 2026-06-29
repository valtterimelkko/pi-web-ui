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

import { v4 as uuidv4 } from 'uuid';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { InternalApiEventBroker } from '../internal-api/event-broker.js';
import { NotificationStore } from './notification-store.js';
import { ChannelRouter } from './channels/notification-channel.js';
import { formatNotification } from './notification-formatter.js';
import type {
  DeliveryRecord,
  Notification,
  NotificationRuntime,
  OptInRecord,
  QueuedNotification,
} from './types.js';

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
}

interface ObservedSession {
  record: OptInRecord;
  observer: (event: unknown) => void;
  brokerUnsub: () => void;
  /** Accumulated text of the current assistant message (reset on each assistant turn). */
  assistantTail: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export class NotificationManager {
  private readonly deps: NotificationManagerDeps;
  private readonly broker: InternalApiEventBroker;
  private readonly now: () => string;
  private readonly observed = new Map<string, ObservedSession>();
  private draining = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private shutDown = false;

  constructor(deps: NotificationManagerDeps) {
    this.deps = deps;
    this.broker = deps.broker ?? new InternalApiEventBroker();
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async init(): Promise<void> {
    await this.deps.store.init();
    if (!this.deps.enabled) return;
    // Rehydration: re-attach observers for every still-opted-in session.
    for (const record of this.deps.store.listOptIns()) {
      this.attach(record);
    }
    // Resume draining anything left pending from before a restart.
    void this.drain();
  }

  async optIn(record: OptInRecord): Promise<void> {
    await this.deps.store.setOptIn(record);
    if (!this.deps.enabled) return;
    this.attach(record); // idempotent: detaches any prior observation first
  }

  async optOut(sessionId: string): Promise<void> {
    await this.deps.store.removeOptIn(sessionId);
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
    const notification: Notification = {
      id: uuidv4(),
      kind: 'explicit',
      title: input.title,
      body: input.body,
      deepLink: input.deepLink,
      createdAt: this.now(),
    };
    await this.enqueueAndDispatch(notification);
    return notification;
  }

  shutdown(): void {
    this.shutDown = true;
    for (const sessionId of [...this.observed.keys()]) this.detach(sessionId);
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Process pending outbox items. Idempotent / re-entrant-safe. Public for tests. */
  async drain(): Promise<void> {
    if (this.shutDown || this.draining) return;
    this.draining = true;
    try {
      if (this.deps.router.listConfigured().length === 0) return;
      const pending = this.deps.store.listPending();
      for (const item of pending) {
        await this.tryDeliver(item);
      }
      if (this.deps.store.listPending().length > 0) this.scheduleRetry();
    } finally {
      this.draining = false;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async tryDeliver(item: QueuedNotification): Promise<void> {
    const results = await this.deps.router.route(item.notification);
    const ok = results.length > 0 && results.every((r) => r.ok);
    if (ok) {
      await this.deps.store.markSent(item.notification.id, this.now());
      return;
    }
    const attempts = item.delivery.attempts + 1;
    const terminal = attempts >= this.deps.maxAttempts;
    const error = results.find((r) => !r.ok)?.error ?? 'delivery failed';
    await this.deps.store.recordFailure(item.notification.id, error, terminal);
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
    if (!service) return; // runtime service not wired in this build
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
    );
    this.observed.set(sessionId, {
      record,
      observer,
      brokerUnsub,
      assistantTail: '',
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
    this.observed.delete(sessionId);
  }

  private handleEvent(sessionId: string, event: NormalizedEvent): void {
    const obs = this.observed.get(sessionId);
    if (!obs) return;
    switch (event.type) {
      case 'message_start': {
        const data = event.data as { role?: string } | undefined;
        if (data?.role === 'assistant') obs.assistantTail = '';
        break;
      }
      case 'message_update': {
        const delta = extractTextDelta(event.data);
        if (delta) obs.assistantTail += delta;
        break;
      }
      case 'agent_end':
        this.scheduleFlush(sessionId);
        break;
      default:
        break;
    }
  }

  private scheduleFlush(sessionId: string): void {
    const obs = this.observed.get(sessionId);
    if (!obs) return;
    if (obs.debounceTimer) clearTimeout(obs.debounceTimer);
    obs.debounceTimer = setTimeout(() => {
      void this.flush(sessionId).catch(() => {
        /* non-fatal */
      });
    }, this.deps.debounceMs);
  }

  private async flush(sessionId: string): Promise<void> {
    const obs = this.observed.get(sessionId);
    if (!obs) return;
    const tail = obs.assistantTail;
    const formatted = formatNotification(
      {
        sessionId,
        runtime: obs.record.runtime,
        label: obs.record.label,
        kind: 'agent_end',
        tail,
      },
      { tailMaxChars: this.deps.tailMaxChars, publicBaseUrl: this.deps.publicBaseUrl },
    );
    obs.assistantTail = '';
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
  }

  private async enqueueAndDispatch(notification: Notification): Promise<void> {
    const delivery: DeliveryRecord = {
      notificationId: notification.id,
      channel: 'telegram',
      status: 'pending',
      attempts: 0,
      firstQueuedAt: this.now(),
    };
    await this.deps.store.enqueue({ notification, delivery });
    await this.drain();
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
