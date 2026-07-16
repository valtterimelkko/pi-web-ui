import { createServer, request } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { closeServerWithGrace } from '../../../src/internal-api/server-shutdown.js';

const sockets = new Set<Socket>();

afterEach(() => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
});

describe('closeServerWithGrace', () => {
  it('forces a persistent response closed after a bounded grace period', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: ready\ndata: {}\n\n');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');

    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port }, (res) => {
        res.once('data', () => resolve());
      });
      req.once('error', reject);
      req.end();
    });

    const started = Date.now();
    await closeServerWithGrace(server, sockets, 25);

    expect(Date.now() - started).toBeLessThan(500);
    expect(server.listening).toBe(false);
    expect(sockets.size).toBe(0);
  });
});
