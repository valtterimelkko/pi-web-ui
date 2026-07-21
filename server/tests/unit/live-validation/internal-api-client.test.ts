import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InternalApiClient } from '../../../src/live-validation/internal-api-client.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'validation-client-'));
  dirs.push(dir);
  const socket = path.join(dir, 'api.sock');
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return socket;
}

describe('InternalApiClient request evidence', () => {
  it('times out a stalled request with a bounded actionable error', async () => {
    const socketPath = await listen((_req, _res) => { /* deliberately stalled */ });
    const client = new InternalApiClient({ socketPath, token: 'test', requestTimeoutMs: 20 });
    await expect(client.getCapabilities()).rejects.toThrow(/timed out.*20ms/i);
  });

  it('uses an absolute deadline even while a response keeps producing chunks', async () => {
    const socketPath = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const interval = setInterval(() => res.write(': keepalive\n\n'), 5);
      res.on('close', () => clearInterval(interval));
    });
    const client = new InternalApiClient({ socketPath, token: 'test', promptTimeoutMs: 30 });
    await expect(client.promptStream('session-live', { message: 'hello' })).rejects.toThrow(/timed out.*30ms/i);
  });

  it('retains streaming X-Run-Id and low-cardinality event counts', async () => {
    const socketPath = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-run-id': 'run-123' });
      res.end('event: agent_start\ndata: {"type":"agent_start","timestamp":1,"data":{}}\n\n');
    });
    const client = new InternalApiClient({ socketPath, token: 'test', requestTimeoutMs: 100 });
    await client.promptStream('session-1', { message: 'hello', verbosity: 'full' });
    expect(client.getLastPromptEvidence('session-1')).toEqual({
      runId: 'run-123',
      eventCounts: { agent_start: 1 },
    });
  });

  it('records answers-mode run IDs and clears stale evidence before a failed prompt', async () => {
    let calls = 0;
    const socketPath = await listen((_req, res) => {
      calls += 1;
      res.setHeader('content-type', 'application/json');
      if (calls === 1) {
        res.end(JSON.stringify({ sessionId: 'session-1', runId: 'run-answer', status: 'completed', events: [] }));
      } else {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'failed' }));
      }
    });
    const client = new InternalApiClient({ socketPath, token: 'test' });
    await client.prompt('session-1', { message: 'one' });
    expect(client.getLastPromptEvidence('session-1')?.runId).toBe('run-answer');
    await expect(client.prompt('session-1', { message: 'two' })).rejects.toThrow();
    expect(client.getLastPromptEvidence('session-1')).toBeUndefined();
  });

  it('fetches session evidence with an encoded identifier and bounded expansion query', async () => {
    const socketPath = await listen((req, res) => {
      expect(req.url).toBe('/api/v1/sessions/path%2Fid/evidence?expand=diagnostics');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        sessionId: 'canonical-id',
        runtime: 'pi',
        diagnostics: { processLocal: true, records: [] },
      }));
    });
    const client = new InternalApiClient({ socketPath, token: 'test' });
    const evidence = await client.getSessionEvidence('path/id', ['diagnostics']);
    expect(evidence.sessionId).toBe('canonical-id');
    expect(evidence.diagnostics.processLocal).toBe(true);
  });
});
