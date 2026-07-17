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
  /** Injected low-cardinality metrics seam (primarily for tests). */
  metrics?: OperationalMetrics;
}

const DEFAULT_REPLAY_BUFFER_SIZE = 50;

export class InternalApiEventBroker {
  private subscribers: Map<string, Set<EventBrokerSubscriber>> = new Map();
  private subscriberClasses = new WeakMap<EventBrokerSubscriber, string>();
  private replayBuffers: Map<string, NormalizedEvent[]> = new Map();
  private readonly replayBufferSize: number;
  private readonly metrics: OperationalMetrics;

  constructor(options: EventBrokerOptions = {}) {
    this.replayBufferSize = Math.max(0, options.replayBufferSize ?? DEFAULT_REPLAY_BUFFER_SIZE);
    this.metrics = options.metrics ?? getOperationalMetrics();
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
    this.metrics.recordEvent(event.timestamp);
    if (this.replayBufferSize > 0) {
      let buffer = this.replayBuffers.get(sessionId);
      if (!buffer) {
        buffer = [];
        this.replayBuffers.set(sessionId, buffer);
      }
      buffer.push(event);
      if (buffer.length > this.replayBufferSize) {
        const overflow = buffer.length - this.replayBufferSize;
        buffer.splice(0, overflow);
      }
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
  }

  /** Drop everything. */
  clearAll(): void {
    this.subscribers.clear();
    this.replayBuffers.clear();
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
