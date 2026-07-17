import { describe, expect, it } from 'vitest';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';

describe('OperationalMetrics', () => {
  it('records bounded low-cardinality turn outcomes and latency buckets', () => {
    const metrics = new OperationalMetrics({ now: () => 10_000 });
    metrics.recordTurnAccepted('claude');
    metrics.recordTurnFinished('claude', 'completed', 1_250);
    metrics.recordTurnFinished('claude', 'failed', 35_000);

    expect(metrics.snapshot()).toMatchObject({
      turns: {
        claude: {
          accepted: 1,
          completed: 1,
          failed: 1,
          cancelled: 0,
          interrupted: 0,
          latency: {
            count: 2,
            totalMs: 36_250,
            maxMs: 35_000,
            buckets: { le1000: 0, le5000: 1, le30000: 1, gt30000: 1 },
          },
        },
      },
    });
  });

  it('caps dynamic categories to keep memory and cardinality bounded', () => {
    const metrics = new OperationalMetrics();
    for (let index = 0; index < 100; index += 1) {
      metrics.recordAdapterDrop('claude', `unknown:future-event-${index}`);
      metrics.recordSubscriberFailure(`subscriber-${index}`);
    }
    const snapshot = metrics.snapshot();
    expect(Object.keys(snapshot.pipeline.adapterDrops.claude ?? {})).toHaveLength(33);
    expect(snapshot.pipeline.adapterDrops.claude?.other).toBe(68);
    expect(Object.keys(snapshot.pipeline.subscriberFailures)).toHaveLength(33);
    expect(snapshot.pipeline.subscriberFailures.other).toBe(68);
  });

  it('records pipeline-integrity counters without session or payload labels', () => {
    const metrics = new OperationalMetrics({ now: () => 20_000 });
    expect(metrics.recordSubscriberFailure('watch')).toBe(1);
    expect(metrics.recordSubscriberFailure('watch')).toBe(2);
    metrics.recordAdapterDrop('claude', 'invalid_json');
    metrics.recordWatchPersistenceFailure();
    metrics.recordWorkerReadinessFallback();
    metrics.recordNotificationQueued();
    metrics.recordNotificationSent();
    metrics.recordNotificationFailure(true);
    metrics.recordEvent(19_500);

    expect(metrics.snapshot()).toMatchObject({
      notifications: { queued: 1, sent: 1, failedAttempts: 1, terminalFailed: 1 },
      pipeline: {
        subscriberFailures: { watch: 2 },
        adapterDrops: { claude: { invalid_json: 1 } },
        watchPersistenceFailures: 1,
        workerReadinessFallbacks: 1,
        lastEventAt: '1970-01-01T00:00:19.500Z',
        lastEventAgeMs: 500,
      },
    });
  });
});
