import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

function createJsonReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = url;
  (req as { headers?: Record<string, string> }).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) (req as PassThrough).emit('data', Buffer.from(JSON.stringify(body)));
    (req as PassThrough).emit('end');
  });
  return req;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) { chunks.push(chunk); cb(); },
  }) as unknown as ServerResponse & { body: string; statusCode: number };
  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) { res.statusCode = code; return this; }) as never;
  res.write = vi.fn(function (chunk: Buffer | string) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; }) as never;
  res.end = vi.fn(function (data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as never;
  res.on = vi.fn(() => res) as never;
  return res;
}

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, timestamp: Date.now(), data });

const flush = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe('watch wake — full chain: firing → wake dispatch → run receipt (integration)', () => {
  let dir: string;
  let receiptDir: string;
  let registry: { get: ReturnType<typeof vi.fn> };
  let observers: Array<(e: unknown) => void>;
  let multiSessionManager: Record<string, ReturnType<typeof vi.fn>>;
  let runReceipts: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;

  const childEntry = { id: 'child-1', path: 'child-1', sdkType: 'pi', cwd: '/tmp', firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '' };
  const parentEntry = { ...childEntry, id: 'parent-1', path: 'parent-1' };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-wake-int-'));
    receiptDir = path.join(dir, 'receipts');
    observers = [];
    registry = { get: vi.fn(async (id: string) => (id === 'child-1' ? childEntry : id === 'parent-1' ? parentEntry : undefined)) };
    multiSessionManager = {
      addApiObserver: vi.fn((_p: string, o: (e: unknown) => void) => observers.push(o)),
      removeApiObserver: vi.fn(),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      subscribeClient: vi.fn(async () => ({ status: 'idle' })),
      unsubscribeClient: vi.fn(async () => undefined),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      getAgentSession: vi.fn(() => undefined), // no live agent session: dispatch will fail honestly after receipt
    };
    runReceipts = new RunReceiptManager({ store: new RunReceiptStore(receiptDir) });
    routes = createSessionRoutes({
      claudeService: {} as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: multiSessionManager as never,
      sessionRegistry: registry as never,
      piService: {} as never,
      internalClientId: 'test',
      watchDir: path.join(dir, 'watches'),
      runReceiptManager: runReceipts,
    });
  });

  afterEach(async () => {
    await flush(150);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('child agent_end wakes the idle parent through the receipted prompt path', async () => {
    // 1. Register the wake watch on the CHILD targeting the PARENT.
    const reg = createMockRes();
    await routes.handleRegisterWatch(
      createJsonReq('POST', '/api/v1/sessions/child-1/watch', {
        conditions: [{ id: 'child-done', type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'Child {{sessionId}} finished ({{conditionId}} at {{firedAt}}) — inspect and continue.' },
      }),
      reg, 'child-1',
    );
    expect(reg.statusCode).toBe(201);
    expect(multiSessionManager.pinSession).toHaveBeenCalledWith('parent-1', 'watch-target:watch-child-1');

    // 2. The child finishes its turn. Nobody is polling.
    for (const o of observers) o(ev('agent_end'));

    // 3. The wake dispatch is receipted and recorded in the ledger.
    await flush();
    const get = createMockRes();
    await routes.handleGetWatch(createJsonReq('GET', '/api/v1/sessions/child-1/watch'), get, 'child-1', new URLSearchParams());
    const watch = JSON.parse(get.body);
    expect(watch.firingCount).toBe(1);
    expect(watch.wakeAttempts).toHaveLength(1);
    const attempt = watch.wakeAttempts[0];
    expect(attempt.status).toBe('dispatched');
    expect(attempt.targetSessionId).toBe('parent-1');
    expect(attempt.runId).toMatch(/^[0-9a-f-]{36}$/);

    // 4. The wake has a durable run receipt (proof of real dispatch, not a log line).
    const receipt = (runReceipts as unknown as { store: { get(id: string): { sessionId: string; runtime: string } | undefined } }).store.get(attempt.runId);
    expect(receipt).toBeDefined();
    expect(receipt!.sessionId).toBe('parent-1');
    expect(receipt!.runtime).toBe('pi');
  });
});
