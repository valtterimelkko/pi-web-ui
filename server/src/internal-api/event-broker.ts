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
  /** Global cross-session budget on serialised retained replay bytes. */
  replayBudgetMaxBytes?: number;
  /** Max retained bookkeeping keys for subscriber-less (cold) sessions. */
  coldKeyLimit?: number;
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
const DEFAULT_REPLAY_BUDGET_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_COLD_KEY_LIMIT = 1_000;

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
  /** Global cross-session budget on serialised retained replay bytes. */
  private readonly replayBudgetMaxBytes: number;
  /** Maximum retained bookkeeping keys for sessions with no subscribers. */
  private readonly coldKeyLimit: number;
  /** Serialised replay bytes retained across all sessions (running total). */
  private retainedBytesTotal = 0;
  /** Bounded record of sessions whose replay history was evicted. */
  private readonly evictedEventsBySession = new Map<string, number>();
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
    this.replayBudgetMaxBytes = Math.max(0, options.replayBudgetMaxBytes ?? DEFAULT_REPLAY_BUDGET_MAX_BYTES);
    this.coldKeyLimit = Math.max(1, options.coldKeyLimit ?? DEFAULT_COLD_KEY_LIMIT);
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
      while (bytes > this.replayBufferMaxBytes && buffer.length > 0) {
        const old = buffer.shift();
        if (old) {
          bytes -= old.bytes;
          this.retainedBytesTotal = Math.max(0, this.retainedBytesTotal - old.bytes);
          this.markEvicted(sessionId, 1);
        }
      }
      this.replayBufferBytes.set(sessionId, Math.max(0, bytes));
      this.retainedBytesTotal += measured.bytes;
      this.enforceGlobalBounds();
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

  /** Number of cold (subscriber-less) sessions still holding bookkeeping. */
  get debugColdKeyCount(): number {
    let cold = 0;
    for (const sessionId of this.replayBuffers.keys()) {
      if (!this.subscribers.has(sessionId)) cold += 1;
    }
    return cold;
  }

  /** Pending coalesced deltas held for subscriber-less sessions. */
  get debugPendingColdCount(): number {
    let pending = 0;
    for (const sessionId of this.pendingUpdates.keys()) {
      if (!this.subscribers.has(sessionId)) pending += 1;
    }
    return pending;
  }

  /** Whether a session's retained replay history is known-incomplete. */
  getReplayStatus(sessionId: string): { incomplete: boolean; evictedEvents: number } {
    const evictedEvents = this.evictedEventsBySession.get(sessionId) ?? 0;
    return { incomplete: evictedEvents > 0, evictedEvents };
  }

  /** Drop every bookkeeping entry owned by a session key. */
  private dropSessionState(sessionId: string, evictedEvents: number): void {
    const bytes = this.replayBufferBytes.get(sessionId) ?? 0;
    const buffer = this.replayBuffers.get(sessionId);
    const count = evictedEvents > 0 ? evictedEvents : (buffer?.length ?? 0);
    this.replayBuffers.delete(sessionId);
    this.replayBufferBytes.delete(sessionId);
    this.rateStates.delete(sessionId);
    this.pendingUpdates.delete(sessionId);
    this.warnedOversizedSessions.delete(sessionId);
    this.retainedBytesTotal = Math.max(0, this.retainedBytesTotal - bytes);
    if (count > 0) this.markEvicted(sessionId, count);
  }

  private markEvicted(sessionId: string, events: number): void {
    this.evictedEventsBySession.set(sessionId, (this.evictedEventsBySession.get(sessionId) ?? 0) + events);
    this.metrics.recordBrokerReplayEviction(events);
    // Bound the marker map itself; oldest markers age out (documented imprecision).
    while (this.evictedEventsBySession.size > Math.max(this.coldKeyLimit, 1_000)) {
      const oldest = this.evictedEventsBySession.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.evictedEventsBySession.delete(oldest);
    }
  }

  /** Enforce the global replay budget and the cold-key bound after a publish. */
  private enforceGlobalBounds(): void {
    // 1. Global byte budget: evict cold sessions whole first, then trim oldest
    //    events across sessions. Live delivery is never affected — only history.
    let guard = 0;
    while (this.retainedBytesTotal > this.replayBudgetMaxBytes && (this.replayBuffers.size > 0) && guard++ < 10_000) {
      let coldKey: string | undefined;
      for (const sessionId of this.replayBuffers.keys()) {
        if (!this.subscribers.has(sessionId)) { coldKey = sessionId; break; }
      }
      if (coldKey !== undefined) {
        this.dropSessionState(coldKey, 0);
        continue;
      }
      // No cold sessions: trim the oldest buffered event of the first session.
      const sessionId = this.replayBuffers.keys().next().value as string | undefined;
      if (sessionId === undefined) break;
      const buffer = this.replayBuffers.get(sessionId);
      const old = buffer?.shift();
      if (!buffer || !old) { this.replayBuffers.delete(sessionId); continue; }
      const bytes = Math.max(0, (this.replayBufferBytes.get(sessionId) ?? 0) - old.bytes);
      this.replayBufferBytes.set(sessionId, bytes);
      this.retainedBytesTotal = Math.max(0, this.retainedBytesTotal - old.bytes);
      this.markEvicted(sessionId, 1);
    }
    // 2. Cold-key bound: at most coldKeyLimit subscriber-less sessions may hold
    //    replay/rate/pending bookkeeping. Oldest cold keys are dropped whole.
    guard = 0;
    while (this.debugColdKeyCount > this.coldKeyLimit && guard++ < 10_000) {
      let coldKey: string | undefined;
      for (const sessionId of this.replayBuffers.keys()) {
        if (!this.subscribers.has(sessionId)) { coldKey = sessionId; break; }
      }
      if (coldKey === undefined) break;
      this.dropSessionState(coldKey, 0);
    }
    this.metrics.setBrokerReplayState(this.retainedBytesTotal, this.replayBuffers.size);
  }

  clear(sessionId: string): void {
    this.subscribers.delete(sessionId);
    this.dropSessionState(sessionId, 0);
    // Exact deletion clears owned state completely: no incompleteness marker.
    this.evictedEventsBySession.delete(sessionId);
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
