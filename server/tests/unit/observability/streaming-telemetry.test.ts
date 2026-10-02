import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureStreamingTelemetry,
  observeStreamingChunkDelivered,
  observeStreamingChunkReceipt,
  resetStreamingTelemetry,
  resolveStreamingTelemetryEnv,
  takeStreamingWindow,
  type StreamingWindowSummary,
} from '../../../src/observability/streaming-telemetry.js';
import { collectHealthReadings } from '../../../src/observability/health-readings.js';

/**
 * Hb3 (plan H3 item 2): streaming-path telemetry aggregates, per reading
 * window, the streaming-path span (provider chunk receipt → transport
 * dispatch) and the per-provider chunk rate, plus the largest provider gap
 * (interval between consecutive chunk receipts inside one open message
 * stream). No per-chunk logging; bounded memory; zero cost when disabled.
 */

let t = 0;
const clock = () => t;

function deltaEvent(provider: string, delta: string): {
  type: 'message_update';
  assistantMessageEvent: { type: 'text_delta'; delta: string; partial: { provider: string } };
} {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta, partial: { provider } },
  };
}

function msgStart(): { type: 'message_start' } {
  return { type: 'message_start' };
}

function msgEnd(): { type: 'message_end' } {
  return { type: 'message_end' };
}

describe('streaming telemetry', () => {
  beforeEach(() => {
    t = 1_000_000;
    configureStreamingTelemetry({ enabled: true, now: clock });
  });

  afterEach(() => {
    resetStreamingTelemetry();
  });

  it('is inert when disabled: hooks are no-ops and the window is null', () => {
    configureStreamingTelemetry({ enabled: false, now: clock });
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'abc'));
    t += 100;
    observeStreamingChunkDelivered();
    expect(takeStreamingWindow()).toBeNull();
  });

  it('records one delivered span for a receipt→dispatch pair', () => {
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'abc'));
    t += 7;
    observeStreamingChunkDelivered();
    const w = takeStreamingWindow();
    expect(w).not.toBeNull();
    expect(w!.spans).toEqual({ count: 1, p50Ms: 7, p99Ms: 7, maxMs: 7 });
  });

  it('discards a span that was never delivered and does not count it later', () => {
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'abc'));
    t += 5;
    // No delivery: the window boundary abandons the open span.
    takeStreamingWindow();
    t += 5;
    observeStreamingChunkDelivered(); // stale close: no open span → no count
    const w = takeStreamingWindow();
    expect(w!.spans).toBeNull();
  });

  it('computes nearest-rank p50/p99/max over the observed spans', () => {
    const spans = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const ms of spans) {
      observeStreamingChunkReceipt('s1', deltaEvent('zai', 'x'));
      t += ms;
      observeStreamingChunkDelivered();
    }
    const w = takeStreamingWindow();
    expect(w!.spans!.count).toBe(10);
    // nearest-rank: p50 → sorted[5-1] = 50; p99 → sorted[10-1] = 100
    expect(w!.spans!.p50Ms).toBe(50);
    expect(w!.spans!.p99Ms).toBe(100);
    expect(w!.spans!.maxMs).toBe(100);
  });

  it('bounds span percentile memory with a fixed sample ring while count stays exact', () => {
    configureStreamingTelemetry({ enabled: true, now: clock, maxSpanSamples: 4 });
    for (const ms of [100, 200, 300, 400, 500, 600]) {
      observeStreamingChunkReceipt('s1', deltaEvent('zai', 'x'));
      t += ms;
      observeStreamingChunkDelivered();
    }
    const w = takeStreamingWindow();
    expect(w!.spans!.count).toBe(6);
    // Percentiles come from the newest 4 samples (300,400,500,600): p50 → 500? no:
    // nearest-rank p50 of 4 samples = sorted[2-1] = 400; p99 = sorted[4-1] = 600.
    expect(w!.spans!.p50Ms).toBe(400);
    expect(w!.spans!.p99Ms).toBe(600);
    expect(w!.spans!.maxMs).toBe(600);
  });

  it('counts chunks and bytes per provider and derives chunks/s from the window', () => {
    configureStreamingTelemetry({ enabled: true, now: clock });
    for (let i = 0; i < 10; i++) {
      observeStreamingChunkReceipt('s1', deltaEvent('zai', 'abcd'));
      t += 100; // 10 chunks × 100 ms = 1000 ms window
      observeStreamingChunkDelivered();
    }
    const w = takeStreamingWindow();
    expect(w!.providers['zai']).toEqual({ chunks: 10, bytes: 40, chunksPerSec: 10 });
    expect(w!.windowMs).toBe(1000);
  });

  it('attributes an unknown provider when the event carries no partial provider', () => {
    observeStreamingChunkReceipt('s1', {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'zz' },
    } as unknown as Parameters<typeof observeStreamingChunkReceipt>[1]);
    t += 2;
    observeStreamingChunkDelivered();
    const w = takeStreamingWindow();
    expect(w!.providers['unknown']).toEqual({ chunks: 1, bytes: 2, chunksPerSec: expect.any(Number) });
  });

  it('caps the provider map at maxProviders and flags truncation (top chunks kept)', () => {
    configureStreamingTelemetry({ enabled: true, now: clock, maxProviders: 2 });
    for (let i = 0; i < 5; i++) observeStreamingChunkReceipt('s1', deltaEvent('p-small', 'a'));
    for (let i = 0; i < 50; i++) observeStreamingChunkReceipt('s1', deltaEvent('p-big', 'a'));
    for (let i = 0; i < 10; i++) observeStreamingChunkReceipt('s1', deltaEvent('p-mid', 'a'));
    const w = takeStreamingWindow();
    expect(w!.providersTruncated).toBe(true);
    expect(Object.keys(w!.providers).sort()).toEqual(['p-big', 'p-mid']);
    expect(w!.providers['p-big'].chunks).toBe(50);
    expect(w!.providers['p-mid'].chunks).toBe(10);
  });

  it('records a mid-stream provider gap between consecutive deltas of one open stream', () => {
    observeStreamingChunkReceipt('s1', msgStart());
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'a'));
    t += 43_000; // provider pauses mid-stream
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'b'));
    t += 5;
    observeStreamingChunkDelivered();
    const w = takeStreamingWindow();
    expect(w!.providerGap).toEqual({ count: 1, maxMs: 43_000, provider: 'zai' });
  });

  it('does not count a gap across a message boundary (message_end closes the stream)', () => {
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'a'));
    observeStreamingChunkReceipt('s1', msgEnd());
    t += 60_000; // idle time between messages — not a provider gap
    observeStreamingChunkReceipt('s1', msgStart());
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'b'));
    const w = takeStreamingWindow();
    expect(w!.providerGap).toBeNull();
  });

  it('resets gap state on message_start so an aborted stream cannot leak a gap', () => {
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'a'));
    t += 120_000; // turn aborted mid-message; no message_end ever fires
    observeStreamingChunkReceipt('s1', msgStart());
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'b'));
    const w = takeStreamingWindow();
    expect(w!.providerGap).toBeNull();
  });

  it('takes the window: a second window is empty and reports its own length', () => {
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'abc'));
    t += 10;
    observeStreamingChunkDelivered();
    const w1 = takeStreamingWindow();
    expect(w1!.spans!.count).toBe(1);
    t += 2_000;
    const w2 = takeStreamingWindow();
    expect(w2!.spans).toBeNull();
    expect(w2!.providers).toEqual({});
    expect(w2!.providerGap).toBeNull();
    expect(w2!.windowMs).toBe(2000);
  });

  it('ignores non-chunk events and non-delta assistant message events', () => {
    observeStreamingChunkReceipt('s1', { type: 'agent_start' });
    observeStreamingChunkReceipt('s1', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', partial: { provider: 'zai' } },
    } as unknown as Parameters<typeof observeStreamingChunkReceipt>[1]);
    observeStreamingChunkReceipt('s1', {
      type: 'message_update',
      assistantMessageEvent: { type: 'done', reason: 'stop' },
    } as unknown as Parameters<typeof observeStreamingChunkReceipt>[1]);
    const w = takeStreamingWindow();
    expect(w!.providers).toEqual({});
    expect(w!.spans).toBeNull();
  });

  it('bounds the per-session stream-state map (old sessions dropped, no unbounded growth)', () => {
    configureStreamingTelemetry({ enabled: true, now: clock, maxTrackedSessions: 2 });
    observeStreamingChunkReceipt('s0', deltaEvent('zai', 'a'));
    observeStreamingChunkReceipt('s1', deltaEvent('zai', 'a'));
    observeStreamingChunkReceipt('s2', deltaEvent('zai', 'a')); // evicts s0 (oldest)
    // A late s0 delta starts fresh state: it must not report a gap.
    t += 5000;
    observeStreamingChunkReceipt('s0', deltaEvent('zai', 'b'));
    const w = takeStreamingWindow();
    expect(w!.providerGap).toBeNull();
  });

  it('surfaces the summary as an additive, sampler-only health reading field', () => {
    const summary: StreamingWindowSummary = {
      windowMs: 1000,
      spans: { count: 1, p50Ms: 3, p99Ms: 3, maxMs: 3 },
      providerGap: null,
      providers: { zai: { chunks: 4, bytes: 12, chunksPerSec: 4 } },
      providersTruncated: false,
    };
    const readings = collectHealthReadings({ now: () => 1, streaming: () => summary });
    expect(readings.streaming).toEqual(summary);
    // Without a streaming source the field is null, never undefined.
    const plain = collectHealthReadings({ now: () => 1 });
    expect(plain.streaming).toBeNull();
  });

  it('resolves the env knob: on by default, off disables', () => {
    expect(resolveStreamingTelemetryEnv({}).enabled).toBe(true);
    expect(resolveStreamingTelemetryEnv({ OBSERVABILITY_STREAMING_TELEMETRY: 'off' }).enabled).toBe(false);
    expect(resolveStreamingTelemetryEnv({ OBSERVABILITY_STREAMING_TELEMETRY: 'on' }).enabled).toBe(true);
    expect(resolveStreamingTelemetryEnv({ OBSERVABILITY_STREAMING_TELEMETRY: 'yes' }).enabled).toBe(true);
    expect(resolveStreamingTelemetryEnv({ OBSERVABILITY_STREAMING_TELEMETRY: 'bogus' }).enabled).toBe(true);
  });
});
