import { describe, it, expect } from 'vitest';
import { SteerablePromptStream } from '../../../src/claude/claude-steer-stream.js';

async function collect<T>(iter: AsyncIterable<T>, limit: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function msg(text: string): { type: 'user'; text: string } {
  return { type: 'user', text };
}

describe('SteerablePromptStream', () => {
  it('yields pushed messages in order', async () => {
    const s = new SteerablePromptStream();
    s.push(msg('one'));
    s.push(msg('two'));
    s.end();
    expect(await collect(s.stream, 10)).toEqual([msg('one'), msg('two')]);
  });

  it('waits for messages pushed after the drain point', async () => {
    const s = new SteerablePromptStream();
    s.push(msg('one'));
    const collected = collect(s.stream, 3);
    await new Promise((r) => setTimeout(r, 10));
    s.push(msg('two'));
    s.end();
    expect(await collected).toEqual([msg('one'), msg('two')]);
  });

  it('scheduleEnd closes the stream after the delay', async () => {
    const s = new SteerablePromptStream();
    s.push(msg('one'));
    s.scheduleEnd(20);
    const collected = collect(s.stream, 5);
    // Within the grace window the stream is still open for pushes.
    expect(s.hasPending()).toBe(false);
    expect(s.isEndScheduled()).toBe(true);
    expect(await collected).toEqual([msg('one')]);
    expect(s.isEnded()).toBe(true);
  });

  it('a push cancels a scheduled end', async () => {
    const s = new SteerablePromptStream();
    s.push(msg('one'));
    s.scheduleEnd(30);
    await new Promise((r) => setTimeout(r, 5));
    s.push(msg('two')); // cancels the scheduled end
    expect(s.isEndScheduled()).toBe(false);
    await new Promise((r) => setTimeout(r, 40)); // original delay passes
    expect(s.isEnded()).toBe(false);
    s.end();
    expect(await collect(s.stream, 10)).toEqual([msg('one'), msg('two')]);
  });

  it('hasPending tracks pushed-but-not-yet-yielded messages', async () => {
    const s = new SteerablePromptStream();
    expect(s.hasPending()).toBe(false);
    s.push(msg('one'));
    expect(s.hasPending()).toBe(true);
    const it = s.stream[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toEqual(msg('one'));
    expect(s.hasPending()).toBe(false);
    s.end();
    expect((await it.next()).done).toBe(true);
  });

  it('push after end is rejected (returns false) rather than silently dropped', async () => {
    const s = new SteerablePromptStream();
    s.push(msg('one'));
    s.end();
    expect(s.push(msg('two'))).toBe(false);
    expect(await collect(s.stream, 10)).toEqual([msg('one')]);
  });

  it('end() while a consumer is waiting resolves the wait with stream end', async () => {
    const s = new SteerablePromptStream();
    const it = s.stream[Symbol.asyncIterator]();
    const nextPromise = it.next();
    await new Promise((r) => setTimeout(r, 5));
    s.end();
    expect((await nextPromise).done).toBe(true);
  });
});
