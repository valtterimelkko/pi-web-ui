import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { EventLoopShedMonitor } from '../../../src/internal-api/event-loop-shed.js';

afterEach(() => vi.useRealTimers());

describe('bounded event-loop history', () => {
  it('keeps a spike after quiet samples, expires it, and preserves shed recovery', () => {
    let now = 0;
    const metrics = new OperationalMetrics({ now: () => now });
    const monitor = new EventLoopShedMonitor({ metrics, now: () => now });
    monitor.observeLag(1200);
    now = 500;
    monitor.observeLag(0);
    expect(metrics.snapshot().pipeline).toMatchObject({ eventLoopLagMs: 0, eventLoopLagWindow: {
      sampleCount: 2, maxMs: 1200, p95Ms: 1200, windowMs: 60000, maxSamples: 120,
    } });
    expect(monitor.isShedding).toBe(true);
    now = 10500;
    monitor.observeLag(0);
    expect(monitor.isShedding).toBe(false);
    now = 60000;
    expect(metrics.snapshot().pipeline.eventLoopLagWindow).toMatchObject({ sampleCount: 2, maxMs: 0 });
    now = 70500;
    expect(metrics.snapshot().pipeline.eventLoopLagWindow).toMatchObject({ sampleCount: 0, maxMs: 0, p95Ms: 0 });
  });

  it('retains at most 120 samples and resets for a new metrics owner', () => {
    const metrics = new OperationalMetrics({ now: () => 1000 });
    for (let value = 0; value < 500; value++) metrics.recordEventLoopLag(value);
    expect(metrics.snapshot().pipeline.eventLoopLagWindow).toMatchObject({ sampleCount: 120, maxMs: 499, p95Ms: 493 });
    expect(new OperationalMetrics({ now: () => 2000 }).snapshot().pipeline.eventLoopLagWindow)
      .toMatchObject({ sampleCount: 0, resetAt: new Date(2000).toISOString() });
  });

  it('uses the existing 500ms monitor without adding another sampler', () => {
    vi.useFakeTimers();
    let now = 0;
    const metrics = new OperationalMetrics({ now: () => now });
    const monitor = new EventLoopShedMonitor({ metrics, now: () => now });
    try {
      monitor.start();
      monitor.start();
      expect(vi.getTimerCount()).toBe(1);
      now = 500;
      vi.advanceTimersByTime(500);
      expect(metrics.snapshot().pipeline.eventLoopLagWindow.sampleCount).toBe(1);
    } finally { monitor.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });
});
