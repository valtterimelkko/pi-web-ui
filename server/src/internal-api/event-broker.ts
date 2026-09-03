/**
 * Internal API Event Broker
 *
 * A per-session event broker that lets long-lived subscribers receive
 * normalized agent events for a session — independent of which client
 * (Internal API, WebSocket, runtime SDK) started the prompt.
 *
 * Why this exists:
 * The runtime services' `sendPrompt` callback model only delivers events
 * to the caller that initiated the prompt. The Internal API's
 * `GET /sessions/:id/events` endpoint needs a *persistent* subscription
 * that survives across prompts and can be opened before any prompt is
 * running. This broker is the single sink that every event fan-out path
 * in the Internal API publishes to.
 *
 * Design notes:
 * - Subscribers are plain callbacks (no client ID, no transport coupling).
 * - All callbacks are invoked synchronously per event but errors are
 *   swallowed per-subscriber so one bad subscriber cannot block the others.
 * - The broker holds no references to req/res objects — SSE/WS endpoints
 *   own their own cleanup and call `unsubscribe` on close.
 * - Optional buffering of recent events lets late subscribers replay a
 *   tail of the stream when they connect mid-turn.
 */

import type { NormalizedEvent } from '@pi-web-ui/shared';
import { createLogger } from '../logging/logger.js';
import { getOperationalMetrics, type OperationalMetrics } from '../observability/operational-metrics.js';
import { config } from '../config.js';
import { measureAndSlim } from './event-payload-budget.js';
import { getEventLoopShedMonitor, type EventLoopShedMonitor } from './event-loop-shed.js';

const logger = createLogger('InternalApiEventBroker');

export type EventBrokerSubscriber = (event: NormalizedEvent) => void;

interface BufferedEvent {
  event: NormalizedEvent;
  bytes: number;
}

interface RateState { tokens: number; lastMs: number }
interface PendingUpdate { event: NormalizedEvent; coalesced: number }

function shedMessageUpdate(event: NormalizedEvent): NormalizedEvent {
  const data = event.data as Record<string, unknown> | undefined;
  const message = data?.message as Record<string, unknown> | undefined;
  return { ...event, data: { message: message?.id === undefined ? {} : { id: message.id } } };
}

export interface EventBrokerOptions {
  /** How many recent events to buffer per session for late subscribers. 0 disables. */
  replayBufferSize?: number;
  /** Max total bytes of the per-session replay buffer (defense against large-event memory growth). */
  replayBufferMaxBytes?: number;
  /** Max serialized bytes delivered/buffered per event. 0 disables. */
  eventPayloadMaxBytes?: number;
  /** Sustained message-update rate; burst capacity is twice this value. */
  eventRateLimitPerSec?: number;
  /** Injected monotonic clock seam (primarily for tests). */
  now?: () => number;
  /** Injected lag monitor seam (primarily for tests). */
  shedMonitor?: Pick<EventLoopShedMonitor, 'isShedding'>;
  /** Injected low-cardinality metrics seam (primarily for tests). */
  metrics?: OperationalMetrics;
  /** Optional disposal predicate: when set and it returns true for a session
   * key, publish/subscribe are dropped so a late runtime callback cannot
   * recreate the replay buffer or subscribers for a deleted session. */
  isSessionDisposed?: (sessionId: string) => boolean;
}

const DEFAULT_REPLAY_BUFFER_SIZE = 50;
const DEFAULT_REPLAY_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

export class InternalApiEventBroker {
  private subscribers: Map<string, Set<EventBrokerSubscriber>> = new Map();
  private subscriberClasses = new WeakMap<EventBrokerSubscriber, string>();
  private replayBuffers: Map<string, BufferedEvent[]> = new Map();
  private replayBufferBytes: Map<string, number> = new Map();
  private warnedOversizedSessions = new Set<string>();
  private rateStates = new Map<string, RateState>();
  private pendingUpdates = new Map<string, PendingUpdate>();
  private readonly replayBufferSize: number;
  private readonly replayBufferMaxBytes: number;
  private readonly eventPayloadMaxBytes: number;
  private readonly eventRateLimitPerSec: number;
  private readonly eventRateBurst: number;
  private readonly now: () => number;
  private readonly shedMonitor: Pick<EventLoopShedMonitor, 'isShedding'>;
  private readonly metrics: OperationalMetrics;
  private readonly disposedCheck?: (sessionId: string) => boolean;

  constructor(options: EventBrokerOptions = {}) {
    this.replayBufferSize = Math.max(0, options.replayBufferSize ?? DEFAULT_REPLAY_BUFFER_SIZE);
    this.replayBufferMaxBytes = Math.max(0, options.replayBufferMaxBytes ?? DEFAULT_REPLAY_BUFFER_MAX_BYTES);
    this.eventPayloadMaxBytes = Math.max(0, options.eventPayloadMaxBytes ?? config.internalApiEventPayloadMaxBytes);
    this.eventRateLimitPerSec = Math.max(1, options.eventRateLimitPerSec ?? config.internalApiEventRateLimitPerSec);
    this.eventRateBurst = this.eventRateLimitPerSec * 2;
    this.now = options.now ?? Date.now;
    this.shedMonitor = options.shedMonitor ?? getEventLoopShedMonitor();
    this.metrics = options.metrics ?? getOperationalMetrics();
    this.disposedCheck = options.isSessionDisposed;
  }

  /**
   * Subscribe to all events for a session.
   * If `replay` is true (default) and buffered events exist, they are
   * delivered to the subscriber synchronously before this returns.
   * Returns an unsubscribe function.
   */
  subscribe(
    sessionId: string,
    subscriber: EventBrokerSubscriber,
    replay = true,
    subscriberClass = 'subscriber',
  ): () => void {
    // A disposed session cannot gain new subscribers or replay buffers.
    if (this.disposedCheck?.(sessionId)) return () => { /* no-op */ };
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(subscriber);
    this.subscriberClasses.set(subscriber, subscriberClass);

    if (replay) {
      const buffer = this.replayBuffers.get(sessionId);
      if (buffer) {
        for (const entry of buffer) {
          this.safeInvoke(sessionId, subscriber, entry.event, subscriberClass);
        }
      }
    }

    return () => this.unsubscribe(sessionId, subscriber);
  }

  /** Remove a single subscriber. */
  unsubscribe(sessionId: string, subscriber: EventBrokerSubscriber): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    set.delete(subscriber);
    if (set.size === 0) {
      this.subscribers.delete(sessionId);
    }
  }

  /** Publish an event to all subscribers for a session. */
  publish(sessionId: string, event: NormalizedEvent): void {
    if (this.disposedCheck?.(sessionId)) return;
    if (event.type === 'message_update' && this.shedMonitor.isShedding) event = shedMessageUpdate(event);
    if (event.type === 'message_update') {
      this.refill(sessionId);
      if (this.pendingUpdates.has(sessionId) && this.availableTokens(sessionId) > 1) this.flushPending(sessionId);
      if (this.availableTokens(sessionId) <= 1) {
        const pending = this.pendingUpdates.get(sessionId);
        if (pending) this.metrics.recordBrokerCoalesced();
        this.pendingUpdates.set(sessionId, { event, coalesced: (pending?.coalesced ?? -1) + 1 });
        return;
      }
      const state = this.rateStates.get(sessionId);
      if (state) state.tokens -= 1;
    } else {
      this.flushPending(sessionId);
    }
    this.deliver(sessionId, event);
  }

  private refill(sessionId: string): void {
    const now = this.now();
    const state = this.rateStates.get(sessionId) ?? { tokens: this.eventRateBurst, lastMs: now };
    state.tokens = Math.min(this.eventRateBurst, state.tokens + ((now - state.lastMs) * this.eventRateLimitPerSec / 1000));
    state.lastMs = now;
    this.rateStates.set(sessionId, state);
  }

  private availableTokens(sessionId: string): number {
    return this.rateStates.get(sessionId)?.tokens ?? this.eventRateBurst;
  }

  private flushPending(sessionId: string): void {
    const pending = this.pendingUpdates.get(sessionId);
    if (!pending) return;
    this.pendingUpdates.delete(sessionId);
    const data = { ...pending.event.data as Record<string, unknown>, ...(pending.coalesced > 0 ? { coalescedDeltas: pending.coalesced } : {}) };
    const state = this.rateStates.get(sessionId);
    if (state) state.tokens = Math.max(0, state.tokens - 1);
    this.deliver(sessionId, { ...pending.event, data });
  }

  private deliver(sessionId: string, event: NormalizedEvent): void {
    const measured = measureAndSlim(event, this.eventPayloadMaxBytes);
    event = measured.event;
    this.metrics.recordBrokerPublish(measured.bytes, measured.truncated);
    if (measured.truncated && !this.warnedOversizedSessions.has(sessionId)) {
      this.warnedOversizedSessions.add(sessionId);
      logger.child({ sessionId }).warn(`event payload truncated: type=${event.type} bytes=${measured.originalBytes} budget=${this.eventPayloadMaxBytes}`);
    }
    this.metrics.recordEvent(event.timestamp);
    if (this.replayBufferSize > 0 || this.replayBufferMaxBytes > 0) {
      let buffer = this.replayBuffers.get(sessionId);
      if (!buffer) {
        buffer = [];
        this.replayBuffers.set(sessionId, buffer);
      }
      buffer.push({ event, bytes: measured.bytes });
      // Bound by count AND bytes: trim oldest events using cached sizes.
      let bytes = (this.replayBufferBytes.get(sessionId) ?? 0) + measured.bytes;
      while (buffer.length > this.replayBufferSize) { const old = buffer.shift(); if (old) bytes -= old.bytes; }
      while (bytes > this.replayBufferMaxBytes && buffer.length > 0) { const old = buffer.shift(); if (old) bytes -= old.bytes; }
      this.replayBufferBytes.set(sessionId, Math.max(0, bytes));
    }

    const set = this.subscribers.get(sessionId);
    if (!set || set.size === 0) return;
    for (const subscriber of set) {
      this.safeInvoke(
        sessionId,
        subscriber,
        event,
        this.subscriberClasses.get(subscriber) ?? 'subscriber',
      );
    }
  }

  /** Drop all subscribers and buffers for a session. */
  clear(sessionId: string): void {
    this.subscribers.delete(sessionId);
    this.replayBuffers.delete(sessionId);
    this.replayBufferBytes.delete(sessionId);
    this.warnedOversizedSessions.delete(sessionId);
    this.rateStates.delete(sessionId);
    this.pendingUpdates.delete(sessionId);
  }

  /** Return a copy of the recent buffered events for a session, oldest first. */
  getRecentEvents(sessionId: string, limit = this.replayBufferSize): NormalizedEvent[] {
    const buffer = this.replayBuffers.get(sessionId);
    if (!buffer) return [];
    return buffer.slice(-Math.max(0, limit)).map((entry) => entry.event);
  }

  /** Drop everything. */
  clearAll(): void {
    this.subscribers.clear();
    this.replayBuffers.clear();
    this.replayBufferBytes.clear();
    this.warnedOversizedSessions.clear();
    this.rateStates.clear();
    this.pendingUpdates.clear();
  }

  /** Number of active subscribers for a session. */
  subscriberCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.size ?? 0;
  }

  /** Whether the broker has any subscribers at all. */
  get hasSubscribers(): boolean {
    for (const set of this.subscribers.values()) {
      if (set.size > 0) return true;
    }
    return false;
  }

  /** Internal: invoke a subscriber without allowing it to break sibling observers. */
  private safeInvoke(
    sessionId: string,
    subscriber: EventBrokerSubscriber,
    event: NormalizedEvent,
    subscriberClass: string,
  ): void {
    try {
      subscriber(event);
    } catch (error) {
      const count = this.metrics.recordSubscriberFailure(subscriberClass);
      // Keep failures visible without turning a hot broken consumer into a log flood.
      if (count === 1 || count % 100 === 0) {
        const errorName = error instanceof Error ? error.name : typeof error;
        logger.child({ sessionId }).warn(
          `event subscriber failed: class=${subscriberClass} count=${count} error=${errorName}`,
        );
      }
    }
  }
}
