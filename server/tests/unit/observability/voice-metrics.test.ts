import { describe, expect, it } from 'vitest';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';

/**
 * P10 D3 — the voice_* operational metrics: low-cardinality counters and
 * latency snapshots in the existing registry style. Gate denials are healthy
 * outcomes, not errors; cardinality is bounded like every other dynamic map.
 */
describe('OperationalMetrics — voice section', () => {
  it('reports the live model actually in use, null until the mount states it', () => {
    const metrics = new OperationalMetrics();
    expect(metrics.snapshot().voice.live.model).toBeNull();
    metrics.setVoiceLiveModel('gemini-3.8-live');
    expect(metrics.snapshot().voice.live.model).toBe('gemini-3.8-live');
  });

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
      audio: { inputBytes: 0, outputBytes: 0, inputMinutes: 0, outputMinutes: 0 },
      live: {
        engine: 'cascade',
        // Null means the server has not stated the seat yet — never an assumed model.
        model: null,
        connectionDrops: 0,
        resumptionAttempts: 0,
        resumptionSuccesses: 0,
        resumptionFailures: 0,
        resumptionSuccessRate: 0,
        engineFallbacks: 0,
        // No client has reported a microphone it could not start.
        captureFaultTotal: {},
      },
      proposals: { created: 0, released: 0, refused: 0, reconciled: 0 },
    });
  });

  it('counts audio bytes/minutes, live drops and resumptions, engine fallbacks and proposal lifecycle (Phase 8)', () => {
    const metrics = new OperationalMetrics();
    metrics.setVoiceEngine('gemini-live');
    metrics.recordVoiceAudioInput(1_920_000); // exactly one 16 kHz mono PCM16 minute
    metrics.recordVoiceAudioOutput(1_440_000); // half a 24 kHz mono PCM16 minute
    metrics.recordVoiceLiveDrop();
    metrics.recordVoiceResumptionAttempt();
    metrics.recordVoiceResumptionSuccess();
    metrics.recordVoiceLiveDrop();
    metrics.recordVoiceResumptionAttempt();
    metrics.recordVoiceResumptionFailure();
    metrics.recordVoiceEngineFallback();
    metrics.recordVoiceProposalCreated();
    metrics.recordVoiceProposalCreated();
    metrics.recordVoiceProposalReleased();
    metrics.recordVoiceProposalRefused();
    metrics.recordVoiceProposalReconciled();

    expect(metrics.snapshot().voice).toMatchObject({
      audio: { inputBytes: 1_920_000, outputBytes: 1_440_000, inputMinutes: 1, outputMinutes: 0.5 },
      live: {
        engine: 'gemini-live',
        connectionDrops: 2,
        resumptionAttempts: 2,
        resumptionSuccesses: 1,
        resumptionFailures: 1,
        resumptionSuccessRate: 0.5,
        engineFallbacks: 1,
      },
      proposals: { created: 2, released: 1, refused: 1, reconciled: 1 },
    });
  });

  it('ignores non-finite or negative audio byte counts (monotonic, cheap counters)', () => {
    const metrics = new OperationalMetrics();
    metrics.recordVoiceAudioInput(Number.NaN);
    metrics.recordVoiceAudioInput(-5);
    metrics.recordVoiceAudioOutput(Number.POSITIVE_INFINITY);
    expect(metrics.snapshot().voice?.audio).toEqual({ inputBytes: 0, outputBytes: 0, inputMinutes: 0, outputMinutes: 0 });
  });
});
