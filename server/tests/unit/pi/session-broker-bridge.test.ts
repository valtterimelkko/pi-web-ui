import { describe, it, expect, vi } from 'vitest';
import { publishSessionUpdateToBroker } from '../../../src/session-broker-bridge.js';

/**
 * B1.1 correction 04: the watcher's `session_update` → Internal API event
 * broker bridge was gated on `event.sessionId`, so an unlink for a genuinely
 * unknown id (no captured header, invalid Pi file name) was dropped. It must
 * still be published under the path alias.
 */
describe('session_update → Internal API event broker bridge', () => {
  it('publishes an id-less unlink under the path alias (does not drop it)', () => {
    const broker = { publish: vi.fn() };

    publishSessionUpdateToBroker(broker, { type: 'unlink', path: '/sessions/x.jsonl', cwd: '/root' });

    expect(broker.publish).toHaveBeenCalledTimes(1);
    expect(broker.publish.mock.calls[0][0]).toBe('/sessions/x.jsonl');
    expect(broker.publish.mock.calls[0][1]).toMatchObject({
      type: 'session_update',
      data: { changeType: 'unlink', path: '/sessions/x.jsonl', cwd: '/root' },
    });
  });

  it('publishes under both the path and the id alias when an id is present', () => {
    const broker = { publish: vi.fn() };

    publishSessionUpdateToBroker(broker, { type: 'add', path: '/sessions/y.jsonl', sessionId: 'sid-1', cwd: '/root' });

    expect(broker.publish.mock.calls.map((call) => call[0]).sort()).toEqual(['/sessions/y.jsonl', 'sid-1']);
  });

  it('never throws when the broker rejects a publish', () => {
    const broker = { publish: vi.fn(() => { throw new Error('closed'); }) };

    expect(() => publishSessionUpdateToBroker(broker, { type: 'unlink', path: '/sessions/z.jsonl' })).not.toThrow();
  });
});
