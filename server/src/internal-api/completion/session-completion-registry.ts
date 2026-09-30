/**
 * C3a (contract 1.58.0): latest completion per session.
 *
 * Goal-driven children end in goal-engine continuation turns that hold no
 * Internal API receipt (C2's accepted boundary), so parents need the latest
 * parsed completion (or parse error) per session regardless of who started
 * the turn. Entries are recorded from two places:
 *
 * - the run-receipt capture (source `{ runId }`), when a receipted run's
 *   output carried a block;
 * - the session observation tap over the event broker (source
 *   `{ kind: 'session_turn', agentEndAt }`), which sees every turn source —
 *   browser, extension (goal engine), and Internal API alike.
 *
 * The registry is bounded: at most `maxEntries` sessions (default 256,
 * LRU-refreshed), each entry a single small capture record.
 */
import type { SessionCompletionSurface } from '../types.js';

export interface SessionCompletionRegistryOptions {
  now?: () => number;
  maxEntries?: number;
}

export const DEFAULT_COMPLETION_REGISTRY_MAX_ENTRIES = 256;

export class SessionCompletionRegistry {
  private readonly entries = new Map<string, SessionCompletionSurface>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: SessionCompletionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries && options.maxEntries > 0
      ? options.maxEntries
      : DEFAULT_COMPLETION_REGISTRY_MAX_ENTRIES;
  }

  /** Record (or replace) the latest completion surface for one key. */
  record(key: string, entry: SessionCompletionSurface): void {
    if (typeof key !== 'string' || key.length === 0 || !entry || typeof entry !== 'object') return;
    this.entries.delete(key); // refresh LRU order on replace
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * Latest entry across the alias keys of one session (Internal API id and,
   * for Pi, the broker's sessionPath key). Newest `capturedAt` wins; a tie
   * prefers the earlier alias (id before path).
   */
  latestFor(aliases: string[]): SessionCompletionSurface | undefined {
    let latest: SessionCompletionSurface | undefined;
    let latestMs = Number.NEGATIVE_INFINITY;
    for (const alias of aliases) {
      const entry = this.entries.get(alias);
      if (!entry) continue;
      const ms = Date.parse(entry.capturedAt);
      if (Number.isFinite(ms) && ms > latestMs) {
        latestMs = ms;
        latest = entry;
      }
    }
    return latest;
  }

  clear(aliases: string[]): void {
    for (const alias of aliases) this.entries.delete(alias);
  }

  get size(): number {
    return this.entries.size;
  }
}
