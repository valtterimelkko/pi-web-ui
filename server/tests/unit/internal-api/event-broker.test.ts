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

  it('slims oversized message updates before subscriber delivery without losing the delta', () => {
    const bounded = new InternalApiEventBroker({ eventPayloadMaxBytes: 32 * 1024 });
    const event = makeEvent('message_update', {
      message: { id: 'm1', role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'x'.repeat(100_000) }] },
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });
    const sub = vi.fn();
    bounded.subscribe('s1', sub, false);

    bounded.publish('s1', event);

    const delivered = sub.mock.calls[0]?.[0] as NormalizedEvent;
    expect(Buffer.byteLength(JSON.stringify(delivered))).toBeLessThanOrEqual(32 * 1024);
    expect(delivered.data).toMatchObject({
      message: { id: 'm1', role: 'assistant', stopReason: 'stop' },
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
      payloadTruncated: { budgetBytes: 32 * 1024 },
    });
    expect(((event.data as { message: { content: unknown[] } }).message.content)).toHaveLength(1);
  });

  it('replays the bounded form of an oversized event', () => {
    const bounded = new InternalApiEventBroker({ eventPayloadMaxBytes: 1024 });
    bounded.publish('s1', makeEvent('message_update', {
      message: { id: 'm1', content: [{ type: 'text', text: 'x'.repeat(10_000) }] },
      assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
    }));

    const replayed = bounded.getRecentEvents('s1');
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.data).toMatchObject({
      message: { id: 'm1' },
      assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
      payloadTruncated: { budgetBytes: 1024 },
    });
  });

  it('warns only once per session when payloads exceed the budget', () => {
    const bounded = new InternalApiEventBroker({ eventPayloadMaxBytes: 1024 });
    const records: LogRecord[] = [];
    setLogTap((record) => records.push(record));
    try {
      const oversized = makeEvent('message_update', {
        message: { id: 'm1', content: [{ type: 'text', text: 'x'.repeat(10_000) }] },
      });
      bounded.publish('s1', oversized);
      bounded.publish('s1', oversized);

      expect(records.filter((record) => record.msg.includes('event payload truncated'))).toHaveLength(1);
    } finally {
      setLogTap(null);
    }
  });

  it('serializes each published event once even when byte eviction runs', () => {
    const bounded = new InternalApiEventBroker({
      eventPayloadMaxBytes: 0,
      replayBufferSize: 100,
      replayBufferMaxBytes: 150_000,
    });
    const event = makeEvent('message_update', { huge: 'x'.repeat(100_000) });
    const stringify = vi.spyOn(JSON, 'stringify');

    try {
      for (let index = 0; index < 20; index += 1) bounded.publish('s1', event);
      expect(stringify).toHaveBeenCalledTimes(20);
    } finally {
      stringify.mockRestore();
    }
  });

  it('publishes 200 large events within the bounded performance budget', () => {
    const bounded = new InternalApiEventBroker({
      eventPayloadMaxBytes: 0,
      replayBufferSize: 100,
      replayBufferMaxBytes: 8 * 1024 * 1024,
    });
    const event = makeEvent('message_update', { huge: 'x'.repeat(100_000) });
    const startedAt = performance.now();

    for (let index = 0; index < 200; index += 1) bounded.publish('s1', event);

    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('bounds the replay buffer by total bytes (trims oldest large events)', () => {
    const broker = new InternalApiEventBroker({ replayBufferSize: 100, replayBufferMaxBytes: 500 });
    const big = { type: 'message_update', timestamp: 1, data: { huge: 'x'.repeat(400) } } as unknown as NormalizedEvent;
    for (let i = 0; i < 10; i += 1) broker.publish('s1', big);
    const recent = broker.getRecentEvents('s1', 100);
    const totalBytes = recent.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
    expect(recent.length).toBeLessThan(10); // byte cap trims well below the count cap of 100
    expect(totalBytes).toBeLessThanOrEqual(500);
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

  it('drops publish for a disposed session so a late callback cannot recreate the replay buffer', () => {
    let disposed = false;
    const b = new InternalApiEventBroker({
      replayBufferSize: 100,
      isSessionDisposed: () => disposed,
    });
    b.publish('s1', makeEvent('agent_start')); // before dispose: buffered
    expect(b.getRecentEvents('s1')).toHaveLength(1);
    disposed = true; // session deleted after this point
    const sub = vi.fn();
    b.subscribe('s1', sub); // a late subscriber for a disposed session registers nothing
    b.publish('s1', makeEvent('agent_end')); // late runtime callback: MUST be dropped
    expect(b.getRecentEvents('s1')).toHaveLength(1); // not recreated to 2
    expect(sub).not.toHaveBeenCalled(); // late subscriber sees nothing
    expect(b.subscriberCount('s1')).toBe(0);
  });
});
