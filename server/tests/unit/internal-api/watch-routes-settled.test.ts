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
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as never;
  res.on = vi.fn(() => res) as never;
  return res;
}

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, timestamp: Date.now(), data });

describe('watch routes — contract 1.47.0 fireIfSettled + deadline', () => {
  let dir: string;
  let receiptDir: string;
  let runReceipts: RunReceiptManager;
  let piStatus: string;
  let multiSessionManager: Record<string, ReturnType<typeof vi.fn>>;
  let routes: ReturnType<typeof createSessionRoutes>;

  const piEntry = { id: 'pi-1', path: 'pi-1', sdkType: 'pi', cwd: '/tmp', firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '' };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-settled-routes-'));
    receiptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-settled-receipts-'));
    runReceipts = new RunReceiptManager({ store: new RunReceiptStore(receiptDir) });
    piStatus = 'idle';
    multiSessionManager = {
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      getSessionStatus: vi.fn(() => ({ status: piStatus })),
    };
    routes = createSessionRoutes({
      claudeService: {} as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: multiSessionManager as never,
      sessionRegistry: { get: vi.fn().mockResolvedValue(piEntry) } as never,
      piService: {} as never,
      internalClientId: 'test',
      watchDir: dir,
      runReceiptManager: runReceipts,
    });
  });

  afterEach(async () => {
    await runReceipts.shutdown();
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    await fs.rm(receiptDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function beginRun(): Promise<string> {
    const began = await runReceipts.beginRun({
      sessionId: 'pi-1', runtime: 'pi', executionInstanceId: 'exec-1', message: 'hi', mode: 'prompt', verbosity: 'normal', detach: true,
    });
    return began.receipt.runId;
  }

  async function register(body: unknown) {
    const res = createMockRes();
    await routes.handleRegisterWatch(createJsonReq('POST', '/api/v1/sessions/pi-1/watch', body), res, 'pi-1');
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it('fires agent_end immediately (reconciled) when idle and the last run is terminal', async () => {
    const runId = await beginRun();
    await runReceipts.finish(runId, { status: 'completed' });
    const out = await register({ fireIfSettled: true, conditions: [{ type: 'event_type', eventType: 'agent_end' }] });
    expect(out.status).toBe(201);
    expect(out.body.firingCount).toBe(1);
    expect(out.body.firings[0]).toMatchObject({ eventType: 'agent_end', reconciled: true });
    expect(out.body.fireIfSettled).toMatchObject({ requested: true, settled: true, lastRunId: runId, lastRunStatus: 'completed', firedConditionIds: ['c0'] });
  });

  it('does not fire while the subject is busy', async () => {
    const runId = await beginRun();
    await runReceipts.finish(runId, { status: 'completed' });
    piStatus = 'streaming';
    const out = await register({ fireIfSettled: true, conditions: [{ type: 'event_type', eventType: 'agent_end' }] });
    expect(out.status).toBe(201);
    expect(out.body.firingCount).toBe(0);
    expect(out.body.fireIfSettled).toMatchObject({ settled: false, reason: 'busy' });
  });

  it('does not fire while the most recent run is still active', async () => {
    const first = await beginRun();
    await runReceipts.finish(first, { status: 'completed' });
    await beginRun();
    const out = await register({ fireIfSettled: true, conditions: [{ type: 'event_type', eventType: 'agent_end' }] });
    expect(out.body.firingCount).toBe(0);
    expect(out.body.fireIfSettled.settled).toBe(false);
    expect(['busy', 'last_run_not_terminal']).toContain(out.body.fireIfSettled.reason);
  });

  it('does not fire when the subject has no runs', async () => {
    const out = await register({ fireIfSettled: true, conditions: [{ type: 'event_type', eventType: 'agent_end' }] });
    expect(out.body.firingCount).toBe(0);
    expect(out.body.fireIfSettled).toMatchObject({ settled: false, reason: 'no_runs' });
  });

  it('keeps the default: no fireIfSettled key and no firing on a settled subject', async () => {
    const runId = await beginRun();
    await runReceipts.finish(runId, { status: 'completed' });
    const out = await register({ conditions: [{ type: 'event_type', eventType: 'agent_end' }] });
    expect(out.body.firingCount).toBe(0);
    expect(out.body.fireIfSettled).toBeUndefined();
  });

  it('400s a non-boolean fireIfSettled and an out-of-range deadline', async () => {
    expect((await register({ fireIfSettled: 1, conditions: [{ type: 'event_type', eventType: 'agent_end' }] })).status).toBe(400);
    expect((await register({ conditions: [{ type: 'deadline', afterSeconds: 0 }] })).status).toBe(400);
    const ok = await register({ conditions: [{ type: 'deadline', afterSeconds: 60 }] });
    expect(ok.status).toBe(201);
    expect(typeof ok.body.conditions[0].dueAt).toBe('number');
  });
});
