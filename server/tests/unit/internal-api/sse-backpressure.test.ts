import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { createSSEStream } from '../../../src/internal-api/sse-stream.js';

const CAP = 4 * 1024 * 1024;
const responses: Writable[] = [];
function response(stalled = false) {
  const chunks: string[] = [];
  let held: (() => void) | undefined;
  const res = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      if (stalled) held = callback;
      else callback();
    },
  });
  Object.assign(res, { writeHead: vi.fn() });
  responses.push(res);
  return { res: res as unknown as ServerResponse, chunks, drain: () => { stalled = false; held?.(); } };
}

afterEach(() => {
  for (const res of responses.splice(0)) res.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('SSE bounded transport', () => {
  it('closes a stalled reader before queued UTF-8 bytes exceed 4 MiB', () => {
    const { res } = response(true);
    const stream = createSSEStream(res);
    // Real Writable accounting, not a mocked write(false) or invented length.
    for (let i = 0; i < 20; i++) stream.write('message_update', { delta: 'é'.repeat(256 * 1024) });
    expect(res.writableLength).toBeLessThanOrEqual(CAP);
    expect(res.destroyed).toBe(true);
    expect(stream.closed).toBe(true);
  });

  it('never queues a single oversized event, including completion payloads', () => {
    const { res } = response(true);
    const stream = createSSEStream(res);
    stream.complete({ output: 'x'.repeat(CAP + 1) });
    expect(res.writableLength).toBeLessThanOrEqual(CAP);
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false); // abrupt close, not successful completion
    expect(stream.closed).toBe(true);
  });

  it('preserves ordered data after temporary backpressure drains below the cap', () => {
    const { res, chunks, drain } = response(true);
    const stream = createSSEStream(res);
    stream.write('one', { delta: 'a'.repeat(32 * 1024) });
    expect(res.writableNeedDrain).toBe(true);
    expect(res.destroyed).toBe(false);
    drain();
    stream.write('two', { delta: 'b' });
    stream.complete();
    const text = chunks.join('');
    expect(text.indexOf('event: one')).toBeLessThan(text.indexOf('event: two'));
    expect(text).toContain('event: done');
  });

  it('does not throttle a fast sibling when the slow connection is closed', () => {
    const slow = response(true);
    const fast = response();
    const a = createSSEStream(slow.res);
    const b = createSSEStream(fast.res);
    for (let i = 0; i < 20; i++) {
      const data = { index: i, delta: 'x'.repeat(256 * 1024) };
      a.write('message_update', data);
      b.write('message_update', data);
    }
    b.complete();
    expect(slow.res.destroyed).toBe(true);
    expect(fast.chunks.filter((chunk) => chunk.startsWith('event: message_update'))).toHaveLength(20);
    expect(fast.chunks.join('')).toContain('event: done');
  });

  it('bounds heartbeat bytes too and clears its timer on overflow', () => {
    vi.useFakeTimers();
    const { res } = response(true);
    const stream = createSSEStream(res);
    const frameOverhead = Buffer.byteLength('event: one\ndata: {"delta":""}\n\n');
    stream.write('one', { delta: 'x'.repeat(CAP - res.writableLength - frameOverhead - 1) });
    expect(res.writableLength).toBe(CAP - 1);
    vi.advanceTimersByTime(15000);
    expect(res.writableLength).toBeLessThanOrEqual(CAP);
    expect(res.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
