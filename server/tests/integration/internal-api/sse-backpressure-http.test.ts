import { describe, expect, it } from 'vitest';
import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http';
import { setImmediate as yieldIo } from 'node:timers/promises';
import { createSSEStream, type SSEController } from '../../../src/internal-api/sse-stream.js';

describe('SSE backpressure over disposable HTTP sockets', () => {
  it('disconnects a genuinely paused reader while a draining reader receives completion', async () => {
    const streams = new Map<string, { response: ServerResponse; stream: SSEController }>();
    const requests: ReturnType<typeof get>[] = [];
    const responses: IncomingMessage[] = [];
    const server = createServer((req, res) => {
      streams.set(req.url!, { response: res, stream: createSSEStream(res) });
    });
    let fastBytes = 0;
    let fastTail = '';
    let peakSlowPending = 0;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const connect = (route: string) => new Promise<IncomingMessage>((resolve, reject) => {
        const req = get(`http://127.0.0.1:${port}/${route}`, (res) => {
          responses.push(res);
          // Abrupt slow-reader closure is expected, not an unhandled error.
          res.on('error', () => undefined);
          resolve(res);
        });
        req.on('error', reject);
        requests.push(req);
      });
      const slow = await connect('slow');
      slow.pause();
      const fast = await connect('fast');
      const fastEnded = new Promise<void>((resolve, reject) => {
        fast.on('data', (chunk: Buffer) => {
          fastBytes += chunk.length;
          fastTail = (fastTail + chunk.toString()).slice(-128);
        });
        fast.on('end', resolve);
        fast.on('error', reject);
      });
      const slowServer = streams.get('/slow')!;
      const fastServer = streams.get('/fast')!;
      const payload = { delta: 'x'.repeat(64 * 1024) };
      // Bounded ~19 MiB stream. Yield real network I/O each frame: the fast
      // client can drain; only the deliberately paused socket accumulates.
      for (let i = 0; i < 300; i++) {
        slowServer.stream.write('message_update', payload);
        fastServer.stream.write('message_update', payload);
        peakSlowPending = Math.max(peakSlowPending, slowServer.response.writableLength);
        await yieldIo();
      }
      fastServer.stream.complete();
      await fastEnded;
      expect(slowServer.stream.closed).toBe(true);
      expect(slowServer.response.destroyed).toBe(true);
      expect(peakSlowPending).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(fastBytes).toBeGreaterThan(16 * 1024 * 1024);
      expect(fastTail).toContain('event: done');
      expect(fastServer.response.writableFinished).toBe(true);
    } finally {
      for (const res of responses) res.destroy();
      for (const req of requests) req.destroy();
      for (const entry of streams.values()) entry.response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10000);
});
