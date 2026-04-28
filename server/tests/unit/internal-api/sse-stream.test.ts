/**
 * Tests for SSE Stream Helper
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable } from 'stream';
import type { ServerResponse } from 'http';
import { createSSEStream } from '../../../src/internal-api/sse-stream.js';

function createMockRes(): ServerResponse & { writtenChunks: string[] } {
  const chunks: string[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      chunks.push(chunk.toString());
      callback();
    },
  }) as unknown as ServerResponse & { writtenChunks: string[] };

  res.writtenChunks = chunks;
  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  });
  res.write = vi.fn(function (this: typeof res, data: string) {
    chunks.push(data);
    return true;
  });
  res.end = vi.fn(function (this: typeof res) {
    return this;
  });

  // Event emitter methods
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  res.on = vi.fn(function (this: typeof res, event: string, handler: (...args: unknown[]) => void) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(handler);
    return this;
  });
  res.emit = vi.fn(function (this: typeof res, event: string, ...args: unknown[]) {
    (listeners[event] || []).forEach(h => h(...args));
    return true;
  });
  res.removeListener = vi.fn();

  return res;
}

describe('createSSEStream', () => {
  let res: ReturnType<typeof createMockRes>;

  beforeEach(() => {
    res = createMockRes();
  });

  it('sets correct headers for SSE', () => {
    createSSEStream(res as unknown as ServerResponse);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  });

  it('sends initial comment to flush headers', () => {
    createSSEStream(res as unknown as ServerResponse);

    expect(res.write).toHaveBeenCalledWith(':ok\n\n');
  });

  it('writes named events with JSON data', () => {
    const sse = createSSEStream(res as unknown as ServerResponse);

    sse.write('message_start', { type: 'message_start', text: 'Hello' });

    const written = res.writtenChunks.join('');
    expect(written).toContain('event: message_start');
    expect(written).toContain('data: {"type":"message_start","text":"Hello"}');
  });

  it('writes multiple events in sequence', () => {
    const sse = createSSEStream(res as unknown as ServerResponse);

    sse.write('agent_start', { type: 'agent_start' });
    sse.write('message_start', { type: 'message_start', id: 'm1' });
    sse.write('agent_end', { type: 'agent_end' });

    const written = res.writtenChunks.join('');
    expect(written).toContain('event: agent_start');
    expect(written).toContain('event: message_start');
    expect(written).toContain('event: agent_end');
  });

  it('complete sends done event and ends response', () => {
    const sse = createSSEStream(res as unknown as ServerResponse);

    sse.complete({ sessionId: '123', turnComplete: true });

    const written = res.writtenChunks.join('');
    expect(written).toContain('event: complete');
    expect(written).toContain('turnComplete');
    expect(written).toContain('event: done');
    expect(res.end).toHaveBeenCalled();
    expect(sse.closed).toBe(true);
  });

  it('complete without data just sends done event', () => {
    const sse = createSSEStream(res as unknown as ServerResponse);

    sse.complete();

    const written = res.writtenChunks.join('');
    expect(written).toContain('event: done');
    expect(res.end).toHaveBeenCalled();
  });

  it('error sends error event and ends response', () => {
    const sse = createSSEStream(res as unknown as ServerResponse);

    sse.error('Something went wrong', 'RUNTIME_ERROR');

    const written = res.writtenChunks.join('');
    expect(written).toContain('event: error');
    expect(written).toContain('Something went wrong');
    expect(written).toContain('RUNTIME_ERROR');
    expect(res.end).toHaveBeenCalled();
    expect(sse.closed).toBe(true);
  });

  it('handles special characters in JSON data', () => {
    const sse = createSSEStream(res as unknown as ServerResponse);

    sse.write('message_update', {
      text: 'Hello\n"world" with quotes',
    });

    const written = res.writtenChunks.join('');
    expect(written).toContain('Hello\\n\\"world\\"');
  });
});
