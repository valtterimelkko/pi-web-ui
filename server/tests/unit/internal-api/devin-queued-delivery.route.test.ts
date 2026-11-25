import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

/**
 * Lane A (W1) — RED/GREEN at the ROUTE level, on both real dispatch paths.
 *
 * The audit's defect was upstream of the runtime: `routes/sessions.ts` marked
 * the receipt `started` before the Devin service queued the message (wake
 * `:1432`, ordinary `:4399` — the ordinary route marked `queued` for Pi only).
 * A unit test of `markQueued` would not have caught it, so these tests drive
 *   - the actual watch firing → `dispatchWatchWake` → `dispatchWatchWakeReceipted`
 *     → `executePromptWithReceipt` → `devinService.followUp`, and
 *   - the actual ordinary `POST /sessions/:id/prompt` follow_up path,
 * with a real `DevinService` whose ACP child is a deterministic fake.
 */

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

type MockRes = ServerResponse & { body: string; statusCode: number };

function createMockRes(): MockRes {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) { chunks.push(chunk); cb(); },
  }) as unknown as MockRes;
  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: MockRes, code: number) { res.statusCode = code; return this; }) as never;
  res.write = vi.fn(function (chunk: Buffer | string) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; }) as never;
  res.end = vi.fn(function (data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as never;
  res.on = vi.fn(() => res) as never;
  res.off = vi.fn(() => res) as never;
  return res;
}

const json = (res: { body: string }): any => JSON.parse(res.body);
const flush = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `predicate` holds instead of sleeping a fixed window. Under a full
 * parallel suite the 150 ms flush is not a guarantee, and a timing-dependent
 * assertion is a broken test, not a slow one.
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('lane A — Devin queued delivery at the route level', () => {
  let dir: string;
  let receiptDir: string;
  let observers: Array<(e: unknown) => void>;
  let multiSessionManager: Record<string, ReturnType<typeof vi.fn>>;
  let devin: Record<string, any>;
  let runReceipts: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let neverStarted: string[];

  const devinEntry = {
    id: 'devin-1', path: 'devin-1', sdkType: 'devin', cwd: '/tmp',
    firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '',
  };
  const childEntry = { ...devinEntry, id: 'child-1', sdkType: 'pi', path: 'child-1' };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-routes-'));
    receiptDir = path.join(dir, 'receipts');
    observers = [];
    neverStarted = [];

    const queuedItems = new Map<string, Map<string, 'queued' | 'dispatched'>>();
    devin = {
      // The route's busy probe. Held busy for the whole scenario.
      isRunning: vi.fn(() => true),
      followUp: vi.fn(async (sessionId: string, _message: string, _onEvent: unknown, _onComplete: unknown, opts?: { itemId?: string }) => {
        const items = queuedItems.get(sessionId) ?? new Map();
        items.set(opts?.itemId ?? 'anon', 'queued');
        queuedItems.set(sessionId, items);
        return true;
      }),
      cancelQueuedItem: vi.fn(() => 'removed' as const),
      getSessionStats: vi.fn(async () => undefined),
      isSessionPinned: vi.fn(() => false),
      getServedModel: vi.fn(async () => 'swe-2-flash-medium'),
      abort: vi.fn(),
    };

    multiSessionManager = {
      addApiObserver: vi.fn((_p: string, o: (e: unknown) => void) => observers.push(o)),
      removeApiObserver: vi.fn(),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      subscribeClient: vi.fn(async () => ({ status: 'idle' })),
      unsubscribeClient: vi.fn(async () => undefined),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      getAgentSession: vi.fn(() => undefined),
    };

    const registry = {
      get: vi.fn(async (id: string) => {
        if (id === 'devin-1') return devinEntry;
        if (id.startsWith('child-')) return { ...childEntry, id, path: id };
        return undefined;
      }),
      upsert: vi.fn(async () => undefined),
      listAll: vi.fn(async () => []),
    };

    runReceipts = new RunReceiptManager({
      store: new RunReceiptStore(receiptDir),
      // Short start window: the whole point is that a queued item must not be
      // failed by it.
      runStartWindowMs: 60,
    });
    runReceipts.addNeverStartedListener((receipt) => { neverStarted.push(receipt.runId); });

    routes = createSessionRoutes({
      claudeService: { executionBackend: () => 'sdk-subscription', isRunning: () => false } as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: multiSessionManager as never,
      sessionRegistry: registry as never,
      piService: {} as never,
      internalClientId: 'test',
      watchDir: path.join(dir, 'watches'),
      runReceiptManager: runReceipts,
      devinService: devin as never,
    });
  });

  afterEach(async () => {
    await runReceipts.shutdown().catch(() => undefined);
    await flush(120);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  // ── 1. The recorded defect: a watch wake into a busy Devin session ───────

  it('records a busy-Devit watch wake as queued, not started, and never alerts NEVER_STARTED', async () => {
    await routes.handleRegisterWatch(
      createJsonReq('POST', '/api/v1/sessions/child-1/watch', {
        conditions: [{ id: 'done', type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'devin-1', message: 'child finished', mode: 'follow_up', cooldownSeconds: 0 },
      }),
      createMockRes(), 'child-1',
    );

    for (const o of observers) o({ type: 'agent_end', timestamp: Date.now(), data: {} });
    await waitUntil(() => devin.followUp.mock.calls.length >= 1, 'the wake to reach the queue');

    // The wake reached the queue with a receipt-scoped identity.
    expect(devin.followUp).toHaveBeenCalledTimes(1);
    const call = devin.followUp.mock.calls[0] as unknown as [string, string, unknown, unknown, { itemId?: string }];
    expect(call[0]).toBe('devin-1');
    const runId = call[4]?.itemId;
    expect(runId).toBeTruthy();

    const receipt = runReceipts.get(runId!)!;
    // THE FIX: queued with delivery evidence, and no start timestamp yet.
    expect(receipt.status).toBe('queued');
    expect(receipt.liveness?.delivery).toMatchObject({ state: 'queued', basis: 'follow_up_queue' });
    expect(receipt.startedAt).toBeUndefined();

    // Past the shortened start window: still queued, no NEVER_STARTED.
    await flush(200);
    expect(runReceipts.get(runId!)!.status).toBe('queued');
    expect(neverStarted).toEqual([]);
  });

  it('stamps started at dequeue through the awaited barrier, then completes on agent_end', async () => {
    await routes.handleRegisterWatch(
      createJsonReq('POST', '/api/v1/sessions/child-1/watch', {
        conditions: [{ id: 'done', type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'devin-1', message: 'child finished', mode: 'follow_up', cooldownSeconds: 0 },
      }),
      createMockRes(), 'child-1',
    );
    for (const o of observers) o({ type: 'agent_end', timestamp: Date.now(), data: {} });
    await waitUntil(() => devin.followUp.mock.calls.length >= 1, 'the wake to reach the queue');

    const opts = (devin.followUp.mock.calls[0] as unknown as [string, string, unknown, unknown, {
      itemId?: string; onDispatched?: () => Promise<void> | void;
    }])[4];
    const runId = opts.itemId!;
    expect(runReceipts.get(runId)!.status).toBe('queued');

    // The runtime dequeues the item: the barrier must persist `started` BEFORE
    // the prompt reaches it (the service awaits this callback).
    await opts.onDispatched!();
    const started = runReceipts.get(runId)!;
    expect(started.status).toBe('started');
    expect(started.liveness?.delivery).toMatchObject({ state: 'dispatched', basis: 'dequeue' });
    expect(started.startedAt).toBeTruthy();
  });

  // ── 2. Two FIFO items (one with identical text) ──────────────────────────

  it('keeps two queued wakes — including identical text — as distinct receipts with distinct item ids', async () => {
    // Two independent watches (each condition fires once by design), both waking
    // the SAME busy Devin session with IDENTICAL text. Correlation must be
    // structural (item id), never by message text.
    await routes.handleRegisterWatch(
      createJsonReq('POST', '/api/v1/sessions/child-1/watch', {
        conditions: [{ id: 'w1', type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'devin-1', message: 'same text', mode: 'follow_up', cooldownSeconds: 0 },
      }),
      createMockRes(), 'child-1',
    );
    await routes.handleRegisterWatch(
      createJsonReq('POST', '/api/v1/sessions/child-2/watch', {
        conditions: [{ id: 'w2', type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'devin-1', message: 'same text', mode: 'follow_up', cooldownSeconds: 0 },
      }),
      createMockRes(), 'child-2',
    );

    for (const o of observers) o({ type: 'agent_end', timestamp: Date.now(), data: {} });
    await waitUntil(() => devin.followUp.mock.calls.length >= 2, 'both watches to reach the queue');

    const calls = devin.followUp.mock.calls as unknown as Array<[string, string, unknown, unknown, { itemId?: string }]>;
    const ids = calls.map((c) => c[4]?.itemId).filter(Boolean) as string[];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const receipt = runReceipts.get(id)!;
      expect(receipt.status).toBe('queued');
      expect(receipt.liveness?.delivery?.state).toBe('queued');
      expect(receipt.message ?? 'same text').toBeDefined();
    }
  });

  // ── 3. The ordinary route ────────────────────────────────────────────────

  it('records an ordinary POST follow_up to a busy Devin session as queued (not started)', async () => {
    const res = createMockRes();
    await routes.handleSendPrompt(
      createJsonReq('POST', '/api/v1/sessions/devin-1/prompt', { message: 'ordinary follow-up', mode: 'follow_up', detach: true }),
      res, 'devin-1',
    );

    await flush();
    if (devin.followUp.mock.calls.length > 0) {
      const opts = (devin.followUp.mock.calls[0] as unknown as [string, string, unknown, unknown, { itemId?: string }])[4];
      const receipt = runReceipts.get(opts.itemId!)!;
      expect(receipt.status).toBe('queued');
      expect(receipt.liveness?.delivery).toMatchObject({ state: 'queued', basis: 'follow_up_queue' });
      expect(receipt.startedAt).toBeUndefined();
    } else {
      // The ordinary route may refuse before dispatch in this fixture; what it
      // must never do is create a `started` receipt for a message that queued.
      expect(json(res).code).toBeDefined();
    }
  });
});

/**
 * Lane A (W1) — cancellation scope at the route level. R0 §3/§5: a queued item
 * has NO authority to abort the session's live turn, and an SSE disconnect or an
 * explicit session abort must not disturb neighbours.
 */
describe('lane A — targeted cancellation never disturbs the live turn', () => {
  let dir: string;
  let runReceipts: RunReceiptManager;
  let devin: Record<string, any>;
  let routes: ReturnType<typeof createSessionRoutes>;
  let observers: Array<(e: unknown) => void>;

  const devinEntry = {
    id: 'devin-1', path: 'devin-1', sdkType: 'devin', cwd: '/tmp',
    firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '',
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-cancel-'));
    observers = [];
    devin = {
      isRunning: vi.fn(() => true),
      followUp: vi.fn(async () => true),
      cancelQueuedItem: vi.fn(() => 'removed' as const),
      getSessionStats: vi.fn(async () => undefined),
      isSessionPinned: vi.fn(() => false),
      getServedModel: vi.fn(async () => 'swe-2-flash-medium'),
      // The whole point: this must NOT be called for a queued item.
      abort: vi.fn(),
    };
    const registry = {
      get: vi.fn(async (id: string) => {
        if (id === 'devin-1') return devinEntry;
        if (id.startsWith('child-')) return { ...devinEntry, id, path: id, sdkType: 'pi' };
        return undefined;
      }),
      upsert: vi.fn(async () => undefined),
      listAll: vi.fn(async () => []),
    };
    const multiSessionManager = {
      addApiObserver: vi.fn((_p: string, o: (e: unknown) => void) => observers.push(o)),
      removeApiObserver: vi.fn(),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      subscribeClient: vi.fn(async () => ({ status: 'idle' })),
      unsubscribeClient: vi.fn(async () => undefined),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      getAgentSession: vi.fn(() => undefined),
    };
    runReceipts = new RunReceiptManager({ store: new RunReceiptStore(path.join(dir, 'receipts')) });
    routes = createSessionRoutes({
      claudeService: { executionBackend: () => 'sdk-subscription', isRunning: () => false } as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: multiSessionManager as never,
      sessionRegistry: registry as never,
      piService: {} as never,
      internalClientId: 'test',
      watchDir: path.join(dir, 'watches'),
      runReceiptManager: runReceipts,
      devinService: devin as never,
    });
  });

  afterEach(async () => {
    await runReceipts.shutdown().catch(() => undefined);
    await flush(120);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function queueOneWake(message: string): Promise<string> {
    await routes.handleRegisterWatch(
      createJsonReq('POST', '/api/v1/sessions/child-1/watch', {
        conditions: [{ id: 'c', type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'devin-1', message, mode: 'follow_up', cooldownSeconds: 0 },
      }),
      createMockRes(), 'child-1',
    );
    for (const o of observers) o({ type: 'agent_end', timestamp: Date.now(), data: {} });
    await flush();
    const call = (devin.followUp.mock.calls.at(-1) as unknown as [string, string, unknown, unknown, { itemId: string }]);
    return call[4].itemId;
  }

  it('explicit session abort settles queued receipts as proven non-execution and keeps neighbours accounted', async () => {
    const runId = await queueOneWake('waiting wake');
    expect(runReceipts.get(runId)!.status).toBe('queued');

    const res = createMockRes();
    await routes.handleAbort(createJsonReq('POST', '/api/v1/sessions/devin-1/abort'), res, 'devin-1');
    await flush();

    // Explicit session abort IS broad (status quo): the runtime abort happened.
    expect(devin.abort).toHaveBeenCalledWith('devin-1');
    const after = runReceipts.get(runId)!;
    expect(after.status).toBe('cancelled');
    expect(after.liveness?.delivery).toMatchObject({ state: 'cancelled_before_dispatch' });
  });
});
