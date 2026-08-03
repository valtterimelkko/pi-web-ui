import { describe, it, expect } from 'vitest';
import { BoundedControlLane, ControlLaneFullError } from '../../../src/internal-api/control-lane.js';

describe('BoundedControlLane', () => {
  it('caps concurrent control ops and queues excess FIFO, releasing on free', async () => {
    const lane = new BoundedControlLane(2, 5000, 8);
    const a = await lane.acquire();
    const b = await lane.acquire();
    expect(lane.inFlight).toBe(2);
    let thirdResolved = false;
    const thirdP = lane.acquire().then((slot) => { thirdResolved = true; return slot; });
    await new Promise((r) => setImmediate(r));
    expect(thirdResolved).toBe(false);
    expect(lane.queued).toBe(1);
    a.release();
    const c = await thirdP;
    expect(thirdResolved).toBe(true);
    expect(lane.inFlight).toBe(2);
    b.release();
    c.release();
    expect(lane.inFlight).toBe(0);
  });

  it('rejects an excess acquire after the queue timeout', async () => {
    const lane = new BoundedControlLane(1, 40, 8);
    const a = await lane.acquire();
    await expect(lane.acquire()).rejects.toThrow('control lane queue timeout');
    expect(lane.queued).toBe(0);
    a.release();
  });

  it('fails fast (ControlLaneFullError) once the queue cap is reached', async () => {
    const lane = new BoundedControlLane(1, 50, 2); // short timeout so queued waiters settle cleanly
    const a = await lane.acquire(); // active=1
    const queued = [lane.acquire(), lane.acquire()]; // queued #1, #2 (== maxQueued)
    await new Promise((r) => setImmediate(r));
    expect(lane.queued).toBe(2);
    // one more must fail fast, not grow the queue
    await expect(lane.acquire()).rejects.toBeInstanceOf(ControlLaneFullError);
    expect(lane.queued).toBe(2);
    // let the queued waiters time out (settle their timers; no dangling rejection)
    await Promise.allSettled(queued);
    a.release();
  });

  it('release is idempotent and the slot stays reusable', async () => {
    const lane = new BoundedControlLane(1, 1000, 4);
    const a = await lane.acquire();
    a.release();
    a.release();
    expect(lane.inFlight).toBe(0);
    const b = await lane.acquire();
    b.release();
  });
});
