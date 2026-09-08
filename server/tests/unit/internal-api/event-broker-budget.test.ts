import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import type { NormalizedEvent } from '../../../src/internal-api/types.js';

afterEach(() => vi.useRealTimers());

function event(type: string, data: Record<string, unknown> = {}, timestamp = '2026-09-08T15:00:00.000Z'): NormalizedEvent {
  return { type, timestamp, data: { [type]: true, ...data } } as unknown as NormalizedEvent;
}

function bigMessageUpdate(fillBytes: number): NormalizedEvent {
  return event('message_update', { text: 'x'.repeat(fillBytes) });
}

describe('aggregate replay budget', () => {
  it('bounds total retained replay bytes across sessions and reports aggregates', () => {
    const metrics = new OperationalMetrics({ now: () => 0 });
    const budget = 64 * 1024;
    const broker = new InternalApiEventBroker({
      metrics,
      replayBufferMaxBytes: 32 * 1024, // per-session stays stricter
      replayBudgetMaxBytes: budget,
    });
    // Eight sessions × ~31 KiB each exceeds the 64 KiB global budget.
    for (let index = 0; index < 8; index++) {
      for (let filler = 0; filler < 10; filler++) {
        broker.publish(`session-${index}`, bigMessageUpdate(3 * 1024));
      }
    }
    const state = metrics.snapshot().pipeline;
    expect(state.brokerReplayRetainedBytes).toBeLessThanOrEqual(budget);
    expect(state.brokerReplayKeys).toBeGreaterThan(0);
    expect(state.brokerReplayKeys).toBeLessThanOrEqual(8);
  });

  it('marks replay incomplete when the global budget evicts history', () => {
    const broker = new InternalApiEventBroker({
      replayBufferMaxBytes: 32 * 1024,
      replayBudgetMaxBytes: 16 * 1024,
    });
    for (let filler = 0; filler < 10; filler++) broker.publish('early-session', bigMessageUpdate(3 * 1024));
    for (let filler = 0; filler < 10; filler++) broker.publish('later-session', bigMessageUpdate(3 * 1024));

    const early = broker.getReplayStatus('early-session');
    const later = broker.getReplayStatus('later-session');
    // The early session's history was evicted under the global budget.
    expect(early.incomplete).toBe(true);
    expect(early.evictedEvents).toBeGreaterThan(0);
    // A session that still holds partial replay reports its own trims honestly.
    expect(later.evictedEvents).toBeGreaterThan(0);
    expect(broker.getRecentEvents('later-session').length).toBeGreaterThan(0);
  });

  it('never drops live terminal/control delivery while evicting replay history', () => {
    const broker = new InternalApiEventBroker({
      replayBufferMaxBytes: 32 * 1024,
      replayBudgetMaxBytes: 8 * 1024,
    });
    const received: string[] = [];
    broker.subscribe('live-session', (evt) => received.push(evt.type), true, 'test');
    for (let filler = 0; filler < 10; filler++) broker.publish('live-session', bigMessageUpdate(3 * 1024));
    broker.publish('live-session', event('agent_end', { runId: 'r1' }));

    expect(received).toContain('agent_end');
    expect(received[received.length - 1]).toBe('agent_end');
    expect(broker.getReplayStatus('live-session').incomplete).toBe(true);
  });
});

describe('cold bookkeeping bound', () => {
  it('caps cold metadata keys and evicts them consistently across all maps', () => {
    const metrics = new OperationalMetrics({ now: () => 0 });
    const broker = new InternalApiEventBroker({ metrics, coldKeyLimit: 100 });
    // 400 subscriber-less sessions churn: only 100 cold keys may remain.
    for (let index = 0; index < 400; index++) {
      broker.publish(`cold-${index}`, bigMessageUpdate(2 * 1024));
      broker.publish(`cold-${index}`, event('message_update', { text: 'delta' }));
    }
    const state = metrics.snapshot().pipeline;
    expect(state.brokerReplayKeys).toBeLessThanOrEqual(100);
    expect(broker.debugColdKeyCount).toBeLessThanOrEqual(100);
    // An evicted cold session reports its history gap rather than empty-as-complete.
    expect(broker.getReplayStatus('cold-0').incomplete).toBe(true);
    expect(broker.getRecentEvents('cold-0')).toEqual([]);
    // Fresh sessions (recently used) keep their replay.
    expect(broker.getRecentEvents('cold-399').length).toBeGreaterThan(0);
  });

  it('flushes or expires pending coalesced deltas for cold sessions (never indefinite)', () => {
    const broker = new InternalApiEventBroker({ coldKeyLimit: 2, replayBufferMaxBytes: 1024, eventRateLimitPerSec: 1 });
    const received: string[] = [];
    // A live session keeps its pending delivery path working.
    broker.subscribe('hot', (evt) => received.push(evt.type), true, 'test');
    for (let index = 0; index < 50; index++) broker.publish('hot', event('message_update', { text: `d${index}` }));
    broker.publish('hot', event('agent_end'));
    expect(received).toContain('agent_end');
    // Churn many cold sessions so pending state for early ones must be gone.
    for (let index = 0; index < 20; index++) {
      for (let filler = 0; filler < 20; filler++) {
        broker.publish(`cold-${index}`, event('message_update', { text: 'x' }));
      }
    }
    expect(broker.debugPendingColdCount).toBeLessThanOrEqual(2);
  });
});

describe('lifecycle integrity under the budget', () => {
  it('exact deletion clears all owned state and late publishes cannot resurrect it', () => {
    const broker = new InternalApiEventBroker({ replayBudgetMaxBytes: 16 * 1024 });
    for (let filler = 0; filler < 5; filler++) broker.publish('doomed', bigMessageUpdate(2 * 1024));
    broker.clear('doomed');
    expect(broker.getRecentEvents('doomed')).toEqual([]);
    expect(broker.getReplayStatus('doomed').incomplete).toBe(false);
    // A late publish after deletion is accepted for live delivery but the
    // session starts from a clean slate (no resurrected pre-delete history).
    const received: string[] = [];
    broker.subscribe('doomed', (evt) => received.push(evt.type), true, 'test');
    broker.publish('doomed', event('agent_start'));
    expect(received).toEqual(['agent_start']);
    expect(broker.getRecentEvents('doomed').length).toBe(1);
  });

  it('reports eviction totals for observability', () => {
    const metrics = new OperationalMetrics({ now: () => 0 });
    const broker = new InternalApiEventBroker({ metrics, replayBudgetMaxBytes: 8 * 1024 });
    for (let filler = 0; filler < 10; filler++) broker.publish('a', bigMessageUpdate(3 * 1024));
    for (let filler = 0; filler < 10; filler++) broker.publish('b', bigMessageUpdate(3 * 1024));
    const state = metrics.snapshot().pipeline;
    expect(state.brokerReplayEvictedEventsTotal).toBeGreaterThan(0);
  });
});
