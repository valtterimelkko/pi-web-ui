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

const logger = createLogger('InternalApiEventBroker');

export type EventBrokerSubscriber = (event: NormalizedEvent) => void;

export interface EventBrokerOptions {
  /** How many recent events to buffer per session for late subscribers. 0 disables. */
  replayBufferSize?: number;
  /** Max total bytes of the per-session replay buffer (defense against large-event memory growth). */
  replayBufferMaxBytes?: number;
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
  private replayBuffers: Map<string, NormalizedEvent[]> = new Map();
  private replayBufferBytes: Map<string, number> = new Map();
  private readonly replayBufferSize: number;
  private readonly replayBufferMaxBytes: number;
  private readonly metrics: OperationalMetrics;
  private readonly disposedCheck?: (sessionId: string) => boolean;

  constructor(options: EventBrokerOptions = {}) {
    this.replayBufferSize = Math.max(0, options.replayBufferSize ?? DEFAULT_REPLAY_BUFFER_SIZE);
    this.replayBufferMaxBytes = Math.max(0, options.replayBufferMaxBytes ?? DEFAULT_REPLAY_BUFFER_MAX_BYTES);
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
        for (const event of buffer) {
          this.safeInvoke(sessionId, subscriber, event, subscriberClass);
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
    // Drop late runtime callbacks for a deleted session: this is the fence that
    // prevents a late event from recreating the replay buffer or notifying
    // subscribers after handleDeleteSession has tombstoned the session.
    if (this.disposedCheck?.(sessionId)) return;
    this.metrics.recordEvent(event.timestamp);
    if (this.replayBufferSize > 0 || this.replayBufferMaxBytes > 0) {
      let buffer = this.replayBuffers.get(sessionId);
      if (!buffer) {
        buffer = [];
        this.replayBuffers.set(sessionId, buffer);
      }
      buffer.push(event);
      // Bound by count AND bytes: trim oldest events that exceed either cap.
      let bytes = (this.replayBufferBytes.get(sessionId) ?? 0) + JSON.stringify(event).length;
      while (buffer.length > this.replayBufferSize) { const old = buffer.shift(); if (old) bytes -= JSON.stringify(old).length; }
      while (bytes > this.replayBufferMaxBytes && buffer.length > 0) { const old = buffer.shift(); if (old) bytes -= JSON.stringify(old).length; }
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
  }

  /** Return a copy of the recent buffered events for a session, oldest first. */
  getRecentEvents(sessionId: string, limit = this.replayBufferSize): NormalizedEvent[] {
    const buffer = this.replayBuffers.get(sessionId);
    if (!buffer) return [];
    return buffer.slice(-Math.max(0, limit));
  }

  /** Drop everything. */
  clearAll(): void {
    this.subscribers.clear();
    this.replayBuffers.clear();
    this.replayBufferBytes.clear();
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
