import { describe, expect, it } from 'vitest';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';

/**
 * P10 D3 — the voice_* operational metrics: low-cardinality counters and
 * latency snapshots in the existing registry style. Gate denials are healthy
 * outcomes, not errors; cardinality is bounded like every other dynamic map.
 */
describe('OperationalMetrics — voice section', () => {
  it('counts voice turns by phase and latencies in the shared bucket style', () => {
    const metrics = new OperationalMetrics({ now: () => 10_000 });
    metrics.recordVoiceTurn('answered');
    metrics.recordVoiceTurn('proposed');
    metrics.recordVoiceTurn('released');
    metrics.recordVoiceTurnDuration(1_250);
    metrics.recordVoiceModelLatency(300);
    metrics.recordVoiceReceiptAck();

    expect(metrics.snapshot().voice).toMatchObject({
      turnTotal: { answered: 1, proposed: 1, released: 1 },
      receiptAckTotal: 1,
      turnDuration: { count: 1, totalMs: 1_250, maxMs: 1_250, buckets: { le1000: 0, le5000: 1, le30000: 1, gt30000: 0 } },
      modelLatency: { count: 1, totalMs: 300 },
    });
  });

  it('counts releases by mechanism and outcome, denials by reason, and per-mechanism delivery latency', () => {
    const metrics = new OperationalMetrics();
    metrics.recordVoiceRelease('steer', 'delivered');
    metrics.recordVoiceRelease('steer', 'delivered');
    metrics.recordVoiceRelease('follow_up', 'queued');
    metrics.recordVoiceDeliveryLatency('steer', 42);
    metrics.recordVoiceDeliveryLatency('follow_up', 7);
    metrics.recordVoiceGateDenied('nothing_pending');
    metrics.recordVoiceGateDenied('lapsed');
    metrics.recordVoiceGateDenied('ambiguous');
    metrics.recordVoiceGateDenied('cancel_classified');

    expect(metrics.snapshot().voice).toMatchObject({
      releaseTotal: { 'steer:delivered': 2, 'follow_up:queued': 1 },
      gateDeniedTotal: { nothing_pending: 1, lapsed: 1, ambiguous: 1, cancel_classified: 1 },
      deliveryLatency: {
        steer: { count: 1, totalMs: 42 },
        follow_up: { count: 1, totalMs: 7 },
      },
    });
  });

  it('keeps voice label cardinality bounded like the other dynamic maps', () => {
    const metrics = new OperationalMetrics();
    for (let index = 0; index < 50; index += 1) metrics.recordVoiceTurn(`exotic_phase_${index}` as never);
    metrics.recordVoiceRelease(`mech_${'x'.repeat(200)}` as never, 'delivered');
    const voice = metrics.snapshot().voice;
    expect(Object.keys(voice?.turnTotal ?? {})).toHaveLength(33); // 32 + 'other'
    expect(voice?.turnTotal).toHaveProperty('other');
    expect(Object.keys(voice?.releaseTotal ?? {})).toHaveLength(1);
    expect(Object.keys(voice?.releaseTotal ?? {})[0]).toHaveLength(80);
  });

  it('exposes a deterministic zeroed voice section before any voice activity', () => {
    const metrics = new OperationalMetrics();
    expect(metrics.snapshot().voice).toEqual({
      turnTotal: {},
      releaseTotal: {},
      gateDeniedTotal: {},
      receiptAckTotal: 0,
      turnDuration: { count: 0, totalMs: 0, maxMs: 0, buckets: { le1000: 0, le5000: 0, le30000: 0, gt30000: 0 } },
      modelLatency: { count: 0, totalMs: 0, maxMs: 0, buckets: { le1000: 0, le5000: 0, le30000: 0, gt30000: 0 } },
      deliveryLatency: {},
    });
  });
});
