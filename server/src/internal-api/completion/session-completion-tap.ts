/**
 * C3a (contract 1.58.0): session-level completion observation.
 *
 * Feeds on every broker-published event (the `onPublish` tap fires at
 * `publish()` entry, before rate-limit coalescing, so the full delta stream
 * is visible) and keeps one bounded final-text tracker per session key for
 * the duration of a turn. At `agent_end` — the boundary of every turn,
 * receipted or not — the accumulated final assistant text is parsed; a
 * completion capture (or typed error) is recorded into the registry with a
 * `session_turn` source, and the turn's tracker is dropped.
 *
 * Memory is bounded: trackers exist only mid-turn, at most
 * {@link MAX_LIVE_TRACKERS} concurrently (oldest evicted), each tail-capped
 * at COMPLETION_PARSE_WINDOW_CHARS.
 */
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { COMPLETION_PARSE_WINDOW_CHARS } from './completion-schema.js';
import { parseCompletionBlock } from './completion-parser.js';
import { FinalTextTracker } from '../run-receipts/final-text.js';
import type { SessionCompletionRegistry } from './session-completion-registry.js';

export const MAX_LIVE_TRACKERS = 64;

export interface SessionCompletionTapOptions {
  registry: SessionCompletionRegistry;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class SessionCompletionTap {
  private readonly registry: SessionCompletionRegistry;
  private readonly now: () => number;
  private readonly trackers = new Map<string, FinalTextTracker>();

  constructor(options: SessionCompletionTapOptions) {
    this.registry = options.registry;
    this.now = options.now ?? Date.now;
  }

  /**
   * Observe one broker-published event for one broker key. Never throws.
   * Broker keys are the Internal API id for most runtimes and the session
   * path for Pi; the registry resolves aliases at read time.
   */
  observe(key: string, event: NormalizedEvent): void {
    try {
      if (typeof key !== 'string' || key.length === 0) return;
      const data = record(event?.data);
      if (event?.type === 'message_start') {
        const roleDirect = typeof data?.role === 'string' ? data.role : undefined;
        const message = record(data?.message);
        const roleNested = typeof message?.role === 'string' ? message.role : undefined;
        if (roleDirect === 'user' || roleNested === 'user') return;
        this.tracker(key); // fresh turn: reset (recreate) the tracker
        return;
      }
      if (event?.type === 'agent_end') {
        this.finishTurn(key, event);
        return;
      }
      if (event?.type === 'message_update' || event?.type === 'message_end' || event?.type === 'tool_execution_start') {
        const tracker = this.tracker(key);
        tracker.observe(event);
      }
    } catch {
      /* observation is best-effort; never break publishing */
    }
  }

  /** Drop one key's tracker and any captured entry (session delete/dispose). */
  forget(key: string): void {
    this.trackers.delete(key);
    this.registry.clear([key]);
  }

  get liveTrackerCount(): number {
    return this.trackers.size;
  }

  private tracker(key: string): FinalTextTracker {
    const existing = this.trackers.get(key);
    if (existing) return existing;
    const tracker = new FinalTextTracker({ maxChars: COMPLETION_PARSE_WINDOW_CHARS });
    this.trackers.set(key, tracker);
    while (this.trackers.size > MAX_LIVE_TRACKERS) {
      const oldest = this.trackers.keys().next().value;
      if (oldest === undefined) break;
      this.trackers.delete(oldest);
    }
    return tracker;
  }

  private finishTurn(key: string, event: NormalizedEvent): void {
    const tracker = this.trackers.get(key);
    this.trackers.delete(key);
    if (!tracker) return;
    const snapshot = tracker.snapshot();
    if (!snapshot || snapshot.text.length === 0) return;
    const parsed = parseCompletionBlock(snapshot.text);
    const capturedAt = new Date(this.now()).toISOString();
    const data = record(event.data);
    const agentEndRaw = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? event.timestamp
      : Date.parse(typeof data?.occurredAt === 'string' ? data.occurredAt : '') || this.now();
    const agentEndAt = new Date(agentEndRaw).toISOString();
    if (parsed.ok) {
      this.registry.record(key, {
        source: { kind: 'session_turn', agentEndAt },
        capturedAt,
        completion: parsed.block,
        delimiter: parsed.delimiter,
      });
    } else if (parsed.error.code !== 'NO_BLOCK') {
      // No block at all is the common case: nothing is recorded, and the
      // surface stays absent (the parent falls back to the receipt).
      this.registry.record(key, {
        source: { kind: 'session_turn', agentEndAt },
        capturedAt,
        completionError: parsed.error,
      });
    }
  }
}
