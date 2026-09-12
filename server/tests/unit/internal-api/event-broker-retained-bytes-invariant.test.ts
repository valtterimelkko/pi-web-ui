import { describe, expect, it } from 'vitest';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import type { NormalizedEvent } from '../../../src/internal-api/types.js';

/**
 * Leak-free invariant for the replay-buffer byte accounting (2026-09-12 stall, Defect A).
 *
 * After ANY sequence of broker operations, the global counter `retainedBytesTotal`
 * must equal the summed bytes of the entries actually retained in the per-session
 * replay buffers. The original bug: the count-based trim decremented only the local
 * `bytes` variable and never the global counter, so the counter ratcheted up
 * monotonically; once past the global budget it forced `enforceGlobalBounds()` to run
 * its 10k-iteration eviction scan on every published event, forever (only a process
 * restart cleared it — production showed EvictedEventsTotal: 632022).
 *
 * This property test drives mixed traffic — many sessions (hot and cold), rate-limited
 * deltas, forced count-trims and byte-trims, global-budget evictions, cold-key drops,
 * per-session clears and clearAll — and asserts the invariant after every step.
 */

function event(type: string, fill: number): NormalizedEvent {
  return {
    type,
    timestamp: '2026-09-12T22:00:00.000Z',
    data: { fill: 'x'.repeat(fill) },
  } as unknown as NormalizedEvent;
}

/** Deterministic PRNG (mulberry32) so the mixed-traffic sequence is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('event broker retained-bytes invariant', () => {
  it('count-based trim decrements the global retained-bytes counter', () => {
    // Focused case for the exact original defect: trimming to replayBufferSize
    // removed events from the buffer but left retainedBytesTotal inflated.
    const broker = new InternalApiEventBroker({
      metrics: new OperationalMetrics({ now: () => 0 }),
      replayBufferSize: 2,
      replayBufferMaxBytes: 8 * 1024,
      eventPayloadMaxBytes: 0,
      now: () => 0,
    });
    for (let index = 0; index < 6; index++) {
      broker.publish('s', event('message_end', 40));
      expect(broker.debugRetainedBytesTracked).toBe(broker.debugRetainedBytesActual);
    }
    // The buffer holds only the last 2 events; the counter must say the same.
    expect(broker.getRecentEvents('s')).toHaveLength(2);
    expect(broker.debugRetainedBytesTracked).toBe(broker.debugRetainedBytesActual);
    expect(broker.debugRetainedBytesActual).toBeGreaterThan(0);
  });

  it('clearAll resets the global retained-bytes counter', () => {
    const broker = new InternalApiEventBroker({
      metrics: new OperationalMetrics({ now: () => 0 }),
      replayBufferSize: 10,
      eventPayloadMaxBytes: 0,
      now: () => 0,
    });
    for (let index = 0; index < 10; index++) broker.publish('s', event('message_end', 60));
    expect(broker.debugRetainedBytesActual).toBeGreaterThan(0);
    broker.clearAll();
    expect(broker.debugRetainedBytesActual).toBe(0);
    expect(broker.debugRetainedBytesTracked).toBe(0);
  });

  it('holds tracked == actual under mixed traffic (property)', () => {
    const rand = mulberry32(20260912);
    // Advancing clock keeps the message_update rate limiter refilling deterministically.
    let clock = 0;
    const broker = new InternalApiEventBroker({
      metrics: new OperationalMetrics({ now: () => 0 }),
      replayBufferSize: 3,
      // Per-session byte cap high enough that three small events fit under it —
      // otherwise byte-trims always preempt count-trims and the property would
      // never exercise the count-trim accounting path.
      replayBufferMaxBytes: 500,
      replayBudgetMaxBytes: 400,
      coldKeyLimit: 3,
      eventPayloadMaxBytes: 0,
      now: () => (clock += 7),
    });

    const sessions = ['hot-0', 'hot-1', 'warm-0', 'warm-1', 'cold-0', 'cold-1', 'cold-2', 'cold-3'];
    const unsubs = new Map<string, () => void>();
    unsubs.set('hot-0', broker.subscribe('hot-0', () => {}, true, 'test'));
    unsubs.set('hot-1', broker.subscribe('hot-1', () => {}, true, 'test'));

    const checkInvariant = (step: number): void => {
      const tracked = broker.debugRetainedBytesTracked;
      const actual = broker.debugRetainedBytesActual;
      expect(tracked, `tracked(${tracked}) must equal actual(${actual}) after step ${step}`).toBe(actual);
      expect(tracked, `tracked must stay under the global budget after step ${step}`).toBeLessThanOrEqual(400);
    };

    const pickSession = (): string => sessions[Math.floor(rand() * sessions.length)];
    const pickType = (): string => {
      const roll = rand();
      if (roll < 0.6) return 'message_update';
      if (roll < 0.8) return 'message_end';
      if (roll < 0.9) return 'tool_call';
      return 'agent_end';
    };
    const pickFill = (): number => {
      const roll = rand();
      if (roll < 0.4) return 10 + Math.floor(rand() * 40); // 10–49B: mostly count-trims
      if (roll < 0.75) return 50 + Math.floor(rand() * 100); // 50–149B: at/near per-session byte cap
      return 150 + Math.floor(rand() * 450); // 150–599B: forces byte-trims + global evictions
    };

    let step = 0;
    for (let iteration = 0; iteration < 4000; iteration++) {
      const roll = rand();
      if (roll < 0.85) {
        broker.publish(pickSession(), event(pickType(), pickFill()));
      } else if (roll < 0.93) {
        broker.clear(pickSession());
      } else if (roll < 0.95) {
        broker.clearAll();
      } else if (roll < 0.975) {
        // Warm sessions churn subscribers (hot <-> cold transitions).
        const target = rand() < 0.5 ? 'warm-0' : 'warm-1';
        const existing = unsubs.get(target);
        if (existing) {
          existing();
          unsubs.delete(target);
        } else {
          unsubs.set(target, broker.subscribe(target, () => {}, true, 'test'));
        }
      } else {
        // Occasional replay read must not disturb accounting.
        broker.getRecentEvents(pickSession());
      }
      step += 1;
      checkInvariant(step);
    }

    // Final sanity: after everything, the counter matches ground truth exactly.
    expect(broker.debugRetainedBytesTracked).toBe(broker.debugRetainedBytesActual);
    for (const unsub of unsubs.values()) unsub();
  });
});
