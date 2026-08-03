import { describe, it, expect, vi } from 'vitest';
import { SessionDisposalRegistry } from '../../../src/internal-api/session-disposal.js';

describe('SessionDisposalRegistry', () => {
  it('disposes every registered handle for a session, idempotently, and tombstones late callbacks', () => {
    const reg = new SessionDisposalRegistry();
    const timer = vi.fn();
    const correlation = vi.fn();
    const snapshot = vi.fn();
    reg.register('s1', 'ask-user-question-timer', timer);
    reg.register('s1', 'queue-correlation', correlation);
    reg.register('s1', 'extension-snapshot', snapshot);
    expect(reg.getCounts()['s1']).toBe(3);
    reg.dispose('s1');
    expect(timer).toHaveBeenCalledTimes(1);
    expect(correlation).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(reg.getCounts()['s1']).toBeUndefined();
    expect(reg.isDisposed('s1')).toBe(true);
    reg.dispose('s1'); // idempotent
    expect(timer).toHaveBeenCalledTimes(1);
    const late = vi.fn(); // late registration after dispose runs immediately
    reg.register('s1', 'late', late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('unregister removes a specific handle without disposing others', () => {
    const reg = new SessionDisposalRegistry();
    const a = vi.fn();
    const b = vi.fn();
    const unregA = reg.register('s2', 'a', a);
    reg.register('s2', 'b', b);
    unregA();
    expect(reg.getCounts()['s2']).toBe(1);
    reg.dispose('s2');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('disposeAll disposes every session (shutdown)', () => {
    const reg = new SessionDisposalRegistry();
    const a = vi.fn();
    const b = vi.fn();
    reg.register('x', 'a', a);
    reg.register('y', 'b', b);
    reg.disposeAll();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('one owner throwing does not skip the rest', () => {
    const reg = new SessionDisposalRegistry();
    const a = vi.fn(() => { throw new Error('boom'); });
    const b = vi.fn();
    reg.register('z', 'a', a);
    reg.register('z', 'b', b);
    reg.dispose('z');
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('dispose is robust to a handle unregistering itself during disposal (no handle skipped)', () => {
    const reg = new SessionDisposalRegistry();
    let unregA: () => void = () => {};
    const a = vi.fn(() => { unregA(); }); // A unregisters itself mid-disposal (mutates the live array)
    const b = vi.fn();
    unregA = reg.register('s3', 'a', a);
    reg.register('s3', 'b', b);
    reg.dispose('s3');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1); // MUST not be skipped by the mid-iteration splice
    expect(reg.isDisposed('s3')).toBe(true);
  });
});
