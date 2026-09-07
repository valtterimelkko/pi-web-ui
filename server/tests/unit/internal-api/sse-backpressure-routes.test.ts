import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

function request(body?: unknown): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  req.headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function response(stalled = false) {
  const chunks: string[] = [];
  const res = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      if (!stalled) callback();
    },
  }) as unknown as ServerResponse;
  Object.assign(res, { writeHead: vi.fn(), setHeader: vi.fn(), getHeader: vi.fn() });
  return { res, chunks };
}

describe('SSE backpressure at the real session routes', () => {
  let dir: string;
  let routes: ReturnType<typeof createSessionRoutes>;
  let receipts: RunReceiptManager;
  let send: ((event: NormalizedEvent) => void) | undefined;
  let finish: ((error?: Error) => void) | undefined;
  let abort: ReturnType<typeof vi.fn>;
  let outputs: ServerResponse[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sse-routes-'));
    send = undefined;
    finish = undefined;
    outputs = [];
    abort = vi.fn(() => { finish?.(new Error('aborted')); });
    const entry = { id: 'subject', path: 'subject', sdkType: 'claude', model: 'sonnet', cwd: dir, status: 'idle' };
    receipts = new RunReceiptManager({ store: new RunReceiptStore(path.join(dir, 'runs')) });
    routes = createSessionRoutes({
      sessionRegistry: { get: vi.fn(async (id: string) => id === 'subject' ? entry : undefined), listAll: vi.fn(async () => [entry]) },
      claudeService: {
        isRunning: vi.fn(() => false), getBackendMode: vi.fn(async () => 'sdk'),
        isAvailable: vi.fn(async () => true), abort,
        sendPrompt: vi.fn(async (_id: string, _message: string, event: typeof send, complete: typeof finish) => {
          send = event;
          finish = complete;
        }),
      },
      multiSessionManager: {}, piService: {}, opencodeService: {}, antigravityService: {},
      runReceiptManager: receipts,
      admissionController: new AdmissionController({
        memory: () => ({ currentBytes: 0, limitBytes: 16 * 1024 ** 3 }),
        readPids: () => ({ current: 0, max: 1024 }),
        host: () => ({ source: 'host', memAvailableBytes: 16 * 1024 ** 3 }),
      }),
      internalClientId: 'sse-test', watchDir: path.join(dir, 'watches'),
    } as unknown as Parameters<typeof createSessionRoutes>[0]);
    await routes.ready;
  });

  afterEach(async () => {
    for (const res of outputs) res.destroy();
    finish?.();
    await routes.shutdown();
    await receipts.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  function flood() {
    for (let i = 0; i < 100; i++) send!({
      type: 'tool_execution_end', timestamp: Date.now(),
      data: { toolCallId: `tool-${i}`, toolName: 'fixture', result: 'x'.repeat(64 * 1024) },
    } as NormalizedEvent);
  }

  it('closes only a slow event observer while detached execution and a fast observer survive', async () => {
    const dispatch = response(); outputs.push(dispatch.res);
    await routes.handleSendPrompt(request({ message: 'fixture work', detach: true, verbosity: 'answers' }), dispatch.res, 'subject');
    const runId = JSON.parse(dispatch.chunks.join('')).runId;
    await vi.waitFor(() => expect(send).toBeDefined());
    const slow = response(true); const fast = response(); outputs.push(slow.res, fast.res);
    const slowHandler = routes.handleSessionEvents(request(), slow.res, 'subject');
    const fastHandler = routes.handleSessionEvents(request(), fast.res, 'subject');
    await vi.waitFor(() => expect(routes.broker.subscriberCount('subject')).toBe(2));
    flood();
    await slowHandler;
    expect(slow.res.destroyed).toBe(true);
    expect(slow.res.writableLength).toBeLessThanOrEqual(4 * 1024 ** 2);
    expect(abort).not.toHaveBeenCalled();
    expect(routes.broker.subscriberCount('subject')).toBe(1);
    send!({ type: 'agent_end', timestamp: Date.now() } as NormalizedEvent);
    finish!();
    expect((await receipts.waitForTerminal(runId)).status).toBe('completed');
    expect(fast.chunks.filter((chunk) => chunk.startsWith('event: tool_execution_end'))).toHaveLength(100);
    expect(fast.chunks.join('')).toContain('event: agent_end');
    fast.res.destroy(); await fastHandler;
    expect(routes.broker.subscriberCount('subject')).toBe(0);
  });

  it('preserves attached prompt cancellation when its slow response must be disconnected', async () => {
    const slow = response(true); outputs.push(slow.res);
    const handler = routes.handleSendPrompt(request({ message: 'fixture work', verbosity: 'full' }), slow.res, 'subject');
    await vi.waitFor(() => expect(send).toBeDefined());
    flood();
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    await handler;
    expect(slow.res.destroyed).toBe(true);
    expect(slow.res.writableEnded).toBe(false);
    expect(slow.res.writableLength).toBeLessThanOrEqual(4 * 1024 ** 2);
  });
});
