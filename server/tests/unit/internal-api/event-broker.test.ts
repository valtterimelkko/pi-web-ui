import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

function makeEvent(type: string, data?: Record<string, unknown>): NormalizedEvent {
  return { type, sessionId: 's1', timestamp: Date.now(), data: data ?? {} };
}

describe('InternalApiEventBroker', () => {
  let broker: InternalApiEventBroker;

  beforeEach(() => {
    broker = new InternalApiEventBroker();
  });

  it('delivers published events to active subscribers', () => {
    const subA = vi.fn();
    const subB = vi.fn();
    broker.subscribe('s1', subA);
    broker.subscribe('s1', subB);

    const event = makeEvent('agent_start');
    broker.publish('s1', event);

    expect(subA).toHaveBeenCalledTimes(1);
    expect(subA).toHaveBeenCalledWith(event);
    expect(subB).toHaveBeenCalledTimes(1);
    expect(subB).toHaveBeenCalledWith(event);
  });

  it('only delivers events for the matching session', () => {
    const subS1 = vi.fn();
    const subS2 = vi.fn();
    broker.subscribe('s1', subS1);
    broker.subscribe('s2', subS2);

    broker.publish('s1', makeEvent('agent_start'));
    expect(subS1).toHaveBeenCalledTimes(1);
    expect(subS2).not.toHaveBeenCalled();
  });

  it('unsubscribe stops further delivery', () => {
    const sub = vi.fn();
    const unsub = broker.subscribe('s1', sub);

    broker.publish('s1', makeEvent('agent_start'));
    expect(sub).toHaveBeenCalledTimes(1);

    unsub();
    broker.publish('s1', makeEvent('agent_end'));
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe via the broker method also works', () => {
    const sub = vi.fn();
    broker.subscribe('s1', sub);
    broker.unsubscribe('s1', sub);

    broker.publish('s1', makeEvent('agent_start'));
    expect(sub).not.toHaveBeenCalled();
  });

  it('does not deliver events published before subscription (without replay)', () => {
    const sub = vi.fn();
    broker.publish('s1', makeEvent('agent_start'));
    broker.subscribe('s1', sub, false);
    expect(sub).not.toHaveBeenCalled();
  });

  it('replays buffered events to late subscribers when replay=true', () => {
    const sub = vi.fn();
    broker.publish('s1', makeEvent('agent_start'));
    broker.publish('s1', makeEvent('message_start'));
    broker.subscribe('s1', sub, true);
    expect(sub).toHaveBeenCalledTimes(2);
    expect((sub.mock.calls[0] as unknown[])[0]).toMatchObject({ type: 'agent_start' });
    expect((sub.mock.calls[1] as unknown[])[0]).toMatchObject({ type: 'message_start' });
  });

  it('caps the replay buffer to the configured size', () => {
    const capped = new InternalApiEventBroker({ replayBufferSize: 3 });
    capped.publish('s1', makeEvent('e1'));
    capped.publish('s1', makeEvent('e2'));
    capped.publish('s1', makeEvent('e3'));
    capped.publish('s1', makeEvent('e4'));
    capped.publish('s1', makeEvent('e5'));

    const sub = vi.fn();
    capped.subscribe('s1', sub, true);
    expect(sub).toHaveBeenCalledTimes(3);
    const types = sub.mock.calls.map((c) => (c[0] as NormalizedEvent).type);
    expect(types).toEqual(['e3', 'e4', 'e5']);
  });

  it('supports disabling the replay buffer entirely', () => {
    const noBuffer = new InternalApiEventBroker({ replayBufferSize: 0 });
    noBuffer.publish('s1', makeEvent('agent_start'));
    const sub = vi.fn();
    noBuffer.subscribe('s1', sub, true);
    expect(sub).not.toHaveBeenCalled();
  });

  it('one subscriber throwing does not block others and leaves bounded evidence', () => {
    const metrics = new OperationalMetrics();
    const observed = new InternalApiEventBroker({ metrics });
    const records: LogRecord[] = [];
    setLogTap((record) => records.push(record));
    try {
      const broken = vi.fn(() => {
        throw new Error('boom');
      });
      const good = vi.fn();
      observed.subscribe('s1', broken, true, 'watch');
      observed.subscribe('s1', good, true, 'sse');

      observed.publish('s1', makeEvent('agent_start'));
      expect(broken).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledTimes(1);
      expect(metrics.snapshot().pipeline.subscriberFailures).toEqual({ watch: 1 });
      expect(records.some((record) =>
        record.level === 'warn'
        && record.component === 'InternalApiEventBroker'
        && record.msg.includes('watch'),
      )).toBe(true);
    } finally {
      setLogTap(null);
    }
  });

  it('subscriberCount returns 0 when no subscribers', () => {
    expect(broker.subscriberCount('s1')).toBe(0);
  });

  it('subscriberCount reflects active subscribers', () => {
    broker.subscribe('s1', vi.fn());
    broker.subscribe('s1', vi.fn());
    expect(broker.subscriberCount('s1')).toBe(2);
  });

  it('hasSubscribers is false when empty and true when populated', () => {
    expect(broker.hasSubscribers).toBe(false);
    broker.subscribe('s1', vi.fn());
    expect(broker.hasSubscribers).toBe(true);
  });

  it('clear removes subscribers and buffer for one session only', () => {
    const subA = vi.fn();
    const subB = vi.fn();
    broker.subscribe('s1', subA);
    broker.subscribe('s2', subB);
    broker.publish('s1', makeEvent('agent_start'));
    broker.publish('s2', makeEvent('agent_start'));

    broker.clear('s1');

    broker.publish('s1', makeEvent('agent_end'));
    broker.publish('s2', makeEvent('agent_end'));
    expect(subA).toHaveBeenCalledTimes(1); // only the pre-clear event
    expect(subB).toHaveBeenCalledTimes(2);
  });

  it('clearAll removes everything', () => {
    const subA = vi.fn();
    broker.subscribe('s1', subA);
    broker.publish('s1', makeEvent('agent_start'));
    broker.clearAll();
    const subB = vi.fn();
    broker.subscribe('s1', subB, true); // should get no replay after clearAll
    expect(subB).not.toHaveBeenCalled();
  });
});
