import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { EventLoopShedMonitor } from '../../../src/internal-api/event-loop-shed.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';

function event(type: string, data: Record<string, unknown>): NormalizedEvent {
  return { type, timestamp: 1, data };
}

describe('event-loop shed delivery', () => {
  it('delivers message updates ids-only while shedding without changing control events', () => {
    const broker = new InternalApiEventBroker({
      shedMonitor: { isShedding: true },
      eventRateLimitPerSec: 100,
    });
    const sub = vi.fn();
    broker.subscribe('s1', sub, false);
    const update = event('message_update', {
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'large' }] },
      assistantMessageEvent: { type: 'text_delta', delta: 'large' },
    });
    const terminal = event('agent_end', { reason: 'complete' });

    broker.publish('s1', update);
    broker.publish('s1', terminal);

    expect(sub.mock.calls[0]?.[0]).toEqual(event('message_update', { message: { id: 'm1' } }));
    expect(sub.mock.calls[1]?.[0]).toBe(terminal);
  });

  it('arms above one second and recovers only after ten sustained healthy seconds', () => {
    const metrics = new OperationalMetrics({ now: () => 10_100 });
    const monitor = new EventLoopShedMonitor({ metrics });
    const records: LogRecord[] = [];
    setLogTap((record) => records.push(record));
    try {
      monitor.observeLag(1_001, 0);
      expect(monitor.isShedding).toBe(true);
      monitor.observeLag(100, 100);
      monitor.observeLag(100, 10_099);
      expect(monitor.isShedding).toBe(true);
      monitor.observeLag(100, 10_100);
      expect(monitor.isShedding).toBe(false);
      expect(metrics.snapshot().pipeline.eventLoopLagMs).toBe(100);
      expect(records.map((record) => record.msg)).toEqual([
        'event-loop shed mode enabled: lagMs=1001',
        'event-loop shed mode disabled: lagMs=100',
      ]);
    } finally {
      setLogTap(null);
      monitor.close();
    }
  });
});
