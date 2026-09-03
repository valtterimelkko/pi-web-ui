import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { InternalApiEventBroker } from '../../src/internal-api/event-broker.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const request = http.get({ host: '127.0.0.1', port, path }, (response) => {
      response.resume();
      response.once('end', () => resolve(performance.now() - startedAt));
    });
    request.once('error', reject);
  });
}

describe('Internal API broker flood containment', () => {
  it('keeps health and session-list probes responsive through the incident-shaped storm', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(request.url === '/health' ? '{"status":"ok"}' : '{"sessions":[]}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');

    const broker = new InternalApiEventBroker({
      eventPayloadMaxBytes: 256 * 1024,
      eventRateLimitPerSec: 1_000,
      replayBufferSize: 100,
      replayBufferMaxBytes: 8 * 1024 * 1024,
      shedMonitor: { isShedding: false },
    });
    const delivered: NormalizedEvent[] = [];
    broker.subscribe('incident', (event) => delivered.push(event), false);
    const huge = 'x'.repeat(2_900_000);
    const rssBefore = process.memoryUsage().rss;
    const healthLatencies: number[] = [];
    const listLatencies: number[] = [];

    for (let chunk = 0; chunk < 20; chunk += 1) {
      const health = get(address.port, '/health');
      const sessions = get(address.port, '/sessions');
      for (let index = 0; index < 10; index += 1) {
        broker.publish('incident', {
          type: 'message_update',
          timestamp: Date.now(),
          data: {
            message: { id: `message-${chunk}-${index}`, content: [{ type: 'text', text: huge }] },
            assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
          },
        });
      }
      healthLatencies.push(await health);
      listLatencies.push(await sessions);
    }
    broker.publish('incident', { type: 'message_end', timestamp: Date.now(), data: {} });
    broker.publish('incident', { type: 'agent_end', timestamp: Date.now(), data: {} });

    expect(Math.max(...healthLatencies)).toBeLessThan(500);
    expect(Math.max(...listLatencies)).toBeLessThan(1_000);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(100 * 1024 * 1024);
    expect(delivered.filter((event) => event.type === 'message_end')).toHaveLength(1);
    expect(delivered.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(delivered.every((event) => Buffer.byteLength(JSON.stringify(event)) <= 256 * 1024)).toBe(true);
    expect(broker.getRecentEvents('incident', 100)
      .reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0))
      .toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(delivered.some((event) => (event.data as Record<string, unknown>).payloadTruncated)).toBe(true);
    expect(vi.isMockFunction(JSON.stringify)).toBe(false);
  }, 20_000);
});
