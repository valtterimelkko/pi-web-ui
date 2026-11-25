import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { DevinQueuedItemCancelled } from '../../../src/devin/devin-service.js';

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
  /** The route-supplied onComplete per queued item (contract-faithful fakes). */
  let callbackByItem: Map<string, (e?: Error) => void>;

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
    callbackByItem = new Map();

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
      // Contract-faithful (correction 07): the real service invokes the
      // ROUTE-SUPPLIED onComplete synchronously, before returning `removed`.
      // A fake that only returns `'removed'` cannot see the ownership bug.
      cancelQueuedItem: vi.fn((sessionId: string, itemId: string) => {
        const onComplete = callbackByItem.get(itemId);
        callbackByItem.delete(itemId);
        onComplete?.(new DevinQueuedItemCancelled(itemId));
        return 'removed' as const;
      }),
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
    // Correction §2: this must be NON-VACUOUS. The parent's probe showed the
    // ordinary route DOES reach the queue for a detached busy follow-up, so the
    // previous "if refused, assert a code" fallback would have hidden a genuine
    // regression. Failure/refusal must fail this test.
    const res = createMockRes();
    await routes.handleSendPrompt(
      createJsonReq('POST', '/api/v1/sessions/devin-1/prompt', { message: 'ordinary follow-up', mode: 'follow_up', detach: true }),
      res, 'devin-1',
    );

    // 1. Successful detached acceptance.
    expect(res.statusCode, res.body).toBe(202);
    const body = json(res);
    expect(body).toMatchObject({ status: 'accepted', detached: true, mode: 'follow_up' });
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);

    // 2. The message really reached the FIFO queue, under this run's identity.
    await waitUntil(() => devin.followUp.mock.calls.length >= 1, 'the ordinary route to reach the queue');
    expect(devin.followUp).toHaveBeenCalledTimes(1);
    const opts = (devin.followUp.mock.calls[0] as unknown as [string, string, unknown, unknown, { itemId?: string }])[4];
    expect(opts.itemId).toBe(body.runId);

    // 3. Receipt: QUEUED (not started), with delivery evidence, no start stamp.
    const queued = runReceipts.get(body.runId)!;
    expect(queued.status).toBe('queued');
    expect(queued.liveness?.delivery).toMatchObject({ state: 'queued', basis: 'follow_up_queue' });
    expect(queued.startedAt).toBeUndefined();

    // 4. The awaited barrier stamps `started` at the real dequeue...
    await opts.onDispatched!();
    const started = runReceipts.get(body.runId)!;
    expect(started.status).toBe('started');
    expect(started.liveness?.delivery).toMatchObject({ state: 'dispatched', basis: 'dequeue' });

    // 5. ...and the run completes when the runtime's turn ends.
    await runReceipts.finish(body.runId, { status: 'completed' });
    expect(runReceipts.get(body.runId)!.status).toBe('completed');
  });

  it('negative: a lost enqueue race is proven non-delivery, never left queued', async () => {
    // The other half of §2: when delivery genuinely fails, the receipt must not
    // sit in `queued` pretending it is still pending. The service reports the
    // session stopped running between the route's busy check and the enqueue —
    // a KNOWN undelivered message, which is the one outcome where a retry is
    // actually safe.
    devin.followUp.mockResolvedValue(false);
    const res = createMockRes();
    await routes.handleSendPrompt(
      createJsonReq('POST', '/api/v1/sessions/devin-1/prompt', { message: 'raced follow-up', mode: 'follow_up', detach: true }),
      res, 'devin-1',
    );

    await waitUntil(() => devin.followUp.mock.calls.length >= 1, 'the route to attempt the enqueue');
    const opts = (devin.followUp.mock.calls[0] as unknown as [string, string, unknown, unknown, { itemId?: string }])[4];
    const runId = opts.itemId!;

    // Settle the dispatch chain, then inspect what the receipt claims.
    await waitUntil(() => {
      const status = runReceipts.get(runId)?.status;
      return status !== 'queued' && status !== 'accepted' && status !== 'started';
    }, 'the raced receipt to terminalise');

    const after = runReceipts.get(runId)!;
    expect(after.status).toBe('cancelled');
    expect(after.liveness?.delivery).toMatchObject({ state: 'cancelled_before_dispatch', basis: 'follow_up_race' });
    // Proven non-execution confirms cessation, so the permit is not held.
    expect(runReceipts.getDrainingCount()).toBe(0);
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
  /** The route-supplied onComplete per queued item (contract-faithful fakes). */
  let callbackByItem: Map<string, (e?: Error) => void>;

  const devinEntry = {
    id: 'devin-1', path: 'devin-1', sdkType: 'devin', cwd: '/tmp',
    firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '',
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-cancel-'));
    observers = [];
    callbackByItem = new Map();
    devin = {
      isRunning: vi.fn(() => true),
      followUp: vi.fn(async (
        _sessionId: string, _m: string, _e: unknown,
        onComplete: (e?: Error) => void, opts?: { itemId?: string },
      ) => { callbackByItem.set(opts?.itemId ?? 'anon', onComplete); return true; }),
      // Contract-faithful (correction 07): the real service invokes the
      // ROUTE-SUPPLIED onComplete synchronously, before returning `removed`.
      // A fake that only returns `'removed'` cannot see the ownership bug.
      cancelQueuedItem: vi.fn((sessionId: string, itemId: string) => {
        const onComplete = callbackByItem.get(itemId);
        callbackByItem.delete(itemId);
        onComplete?.(new DevinQueuedItemCancelled(itemId));
        return 'removed' as const;
      }),
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

/**
 * Lane A correction (03-parent-correction.md §3) — the general terminal-cleanup
 * gap admitted as B6.
 *
 * The ceiling, the disconnect and explicit abort each remove only their own item,
 * but they do not cover EVERY route that can terminalise a receipt. A terminal
 * receipt whose queue entry is still executable is exactly the "silently
 * executable while advising retry" hazard: a caller reads a terminal outcome and
 * the message runs anyway.
 *
 * The fix is receipt-scoped and identity-based (`cancelQueuedItem(runId)`), so it
 * can only ever remove that one item: it never aborts the session's executing
 * turn and never touches a FIFO neighbour.
 */
describe('lane A — receipt-scoped terminal cleanup (correction §3)', () => {
  let dir: string;
  let runReceipts: RunReceiptManager;
  let devin: Record<string, any>;
  let routes: ReturnType<typeof createSessionRoutes>;
  let observers: Array<(e: unknown) => void>;
  /** The route-supplied onComplete per queued item (contract-faithful fakes). */
  let callbackByItem: Map<string, (e?: Error) => void>;
  /** Items the fake service currently holds, per session. */
  let held: Map<string, Map<string, 'queued' | 'dispatched'>>;

  const devinEntry = {
    id: 'devin-1', path: 'devin-1', sdkType: 'devin', cwd: '/tmp',
    firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '',
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-cleanup-'));
    observers = [];
    held = new Map();
    callbackByItem = new Map();
    devin = {
      isRunning: vi.fn(() => true),
      followUp: vi.fn(async (
        sessionId: string, _m: string, _e: unknown,
        onComplete: (e?: Error) => void, opts?: { itemId?: string },
      ) => {
        const items = held.get(sessionId) ?? new Map<string, 'queued' | 'dispatched'>();
        items.set(opts?.itemId ?? 'anon', 'queued');
        held.set(sessionId, items);
        callbackByItem.set(opts?.itemId ?? 'anon', onComplete);
        return true;
      }),
      // Mirrors the real service: only a QUEUED item can be removed. An item that
      // already left the queue answers `dispatched` and is left alone; an id that
      // exists nowhere is `unknown` (never guessed into a non-execution claim).
      cancelQueuedItem: vi.fn((sessionId: string, itemId: string) => {
        const items = held.get(sessionId);
        const state = items?.get(itemId);
        if (state === undefined) return 'unknown' as const;
        if (state === 'dispatched') return 'dispatched' as const;
        items!.delete(itemId);
        // Contract-faithful: fire the route's callback before returning, as the
        // real service does (correction 07).
        const onComplete = callbackByItem.get(itemId);
        callbackByItem.delete(itemId);
        onComplete?.(new DevinQueuedItemCancelled(itemId));
        return 'removed' as const;
      }),
      getSessionStats: vi.fn(async () => undefined),
      isSessionPinned: vi.fn(() => false),
      getServedModel: vi.fn(async () => 'swe-2-flash-medium'),
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

  /** Queue one wake from a DISTINCT child session (each watch fires once). */
  async function queueWake(message: string, childId: string): Promise<string> {
    const before = devin.followUp.mock.calls.length;
    await routes.handleRegisterWatch(
      createJsonReq('POST', `/api/v1/sessions/${childId}/watch`, {
        conditions: [{ id: 'c', type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'devin-1', message, mode: 'follow_up', cooldownSeconds: 0 },
      }),
      createMockRes(), childId,
    );
    for (const o of observers) o({ type: 'agent_end', timestamp: Date.now(), data: {} });
    await waitUntil(() => devin.followUp.mock.calls.length > before, `the ${childId} wake to reach the queue`);
    const call = (devin.followUp.mock.calls.at(-1) as unknown as [string, string, unknown, unknown, { itemId: string }]);
    return call[4].itemId;
  }

  it('removes ONLY the terminal receipt\'s own still-queued item, leaving the neighbour and the live turn alone', async () => {
    const victim = await queueWake('first wake', 'child-1');
    const neighbour = await queueWake('second wake', 'child-2');
    expect(held.get('devin-1')?.size).toBe(2);

    // Terminalise the FIRST receipt by a route outside the ceiling/disconnect
    // paths: an explicit run cancel. Its queue entry is still waiting.
    await runReceipts.cancelRun(victim);
    expect(runReceipts.get(victim)!.status).toBe('cancelled');

    // The receipt-scoped cleanup must now remove exactly that item.
    await waitUntil(() => held.get('devin-1')?.has(victim) === false, 'the terminal receipt\'s own item to be removed');
    expect(held.get('devin-1')?.has(victim)).toBe(false);
    // The neighbour is untouched — it is a different item with a different id.
    expect(held.get('devin-1')?.has(neighbour)).toBe(true);
    expect(runReceipts.get(neighbour)!.status).toBe('queued');
    // Nothing aborted the session's executing turn.
    expect(devin.abort).not.toHaveBeenCalled();
    // Only the victim's own item was removed: exactly one cancel call, for it.
    expect(devin.cancelQueuedItem.mock.calls.map((c: unknown[]) => c[1])).toEqual([victim]);
  });

  it('negative control: an already-dispatched item is never "removed" by the cleanup', async () => {
    const runId = await queueWake('shifted wake', 'child-1');
    // The dequeue wins: the item is no longer queued when the receipt terminals.
    const items = held.get('devin-1')!;
    items.set(runId, 'dispatched');

    await runReceipts.cancelRun(runId);
    await flush(200);

    // Honest outcome: the cancel reports dispatched and the item is NOT removed.
    expect(held.get('devin-1')?.get(runId)).toBe('dispatched');
    // An item that was already executing is never silently deleted.
    expect(devin.cancelQueuedItem.mock.calls.some((c: unknown[]) => c[1] === runId)).toBe(true);
    expect(held.get('devin-1')?.has(runId)).toBe(true);
  });

  it('does not touch a queued item when the receipt is still live', async () => {
    const runId = await queueWake('live wake', 'child-1');
    expect(runReceipts.get(runId)!.status).toBe('queued');
    await flush(200);
    // A queued (nonterminal) receipt must keep its item: cleanup is terminal-only.
    expect(held.get('devin-1')?.has(runId)).toBe(true);
    expect(devin.cancelQueuedItem).not.toHaveBeenCalled();
  });
});

/**
 * Lane A correction 05 §2 — a terminal receipt must not pass the dispatch barrier.
 *
 * The parent's probe (`../reviews/a-parent-terminal-barrier-probe.patch`) showed
 * that `cancelRun` followed by the queued item's `onDispatched()` RESOLVED
 * instead of rejecting: `markStarted` returns an already-terminal receipt
 * unchanged, and the callback ignored the returned state. The item, having been
 * shifted out of the queue, could then execute after cancellation or expiry.
 *
 * The barrier must positively verify that the receipt it just stamped is
 * STARTED. Terminal or missing means the run has already been decided, so the
 * barrier rejects and the service performs NO runtime side effect — while
 * unrelated neighbours survive.
 */
describe('lane A correction 05 §2 — terminal receipts cannot pass the barrier', () => {
  let dir: string;
  let runReceipts: RunReceiptManager;
  let devin: Record<string, any>;
  let routes: ReturnType<typeof createSessionRoutes>;
  /** Runtime side-effect witness: every prompt that actually reached the runtime. */
  let executed: string[];
  let held: Map<string, Map<string, 'queued' | 'dispatched'>>;
  /** The route-supplied onComplete per queued item (contract-faithful fakes). */
  const callbackByItem = new Map<string, (e?: Error) => void>();
  let barriers: Map<string, { sessionId: string; message: string; opts?: { itemId?: string; onDispatched?: () => Promise<void> | void } }>;

  const devinEntry = {
    id: 'devin-1', path: 'devin-1', sdkType: 'devin', cwd: '/tmp',
    firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '',
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-barrier-'));
    executed = [];
    held = new Map();
    barriers = new Map();
    devin = {
      isRunning: vi.fn(() => true),
      // Models the REAL boundary: the item is reserved in the queue and its
      // awaited barrier runs at DEQUEUE time, not at enqueue time, so the test
      // can decide in between whether that item may still execute.
      followUp: vi.fn(async (
        sessionId: string, message: string, _b: unknown, _c: unknown,
        opts?: { itemId?: string; onDispatched?: () => Promise<void> | void },
      ) => {
        const items = held.get(sessionId) ?? new Map<string, 'queued' | 'dispatched'>();
        const itemId = opts?.itemId ?? 'anon';
        items.set(itemId, 'queued');
        held.set(sessionId, items);
        barriers.set(itemId, { sessionId, message, opts });
        return true;
      }),
      cancelQueuedItem: vi.fn((sessionId: string, itemId: string) => {
        const items = held.get(sessionId);
        const state = items?.get(itemId);
        if (state === undefined) return 'unknown' as const;
        if (state === 'dispatched') return 'dispatched' as const;
        items!.delete(itemId);
        // Contract-faithful: fire the route's callback before returning, as the
        // real service does (correction 07).
        const onComplete = callbackByItem.get(itemId);
        callbackByItem.delete(itemId);
        onComplete?.(new DevinQueuedItemCancelled(itemId));
        return 'removed' as const;
      }),
      getSessionStats: vi.fn(async () => undefined),
      isSessionPinned: vi.fn(() => false),
      getServedModel: vi.fn(async () => 'swe-2-flash-medium'),
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
    runReceipts = new RunReceiptManager({ store: new RunReceiptStore(path.join(dir, 'receipts')) });
    routes = createSessionRoutes({
      claudeService: { executionBackend: () => 'sdk-subscription', isRunning: () => false } as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: {
        addApiObserver: vi.fn(), removeApiObserver: vi.fn(), pinSession: vi.fn(() => true),
        unpinSession: vi.fn(() => true), subscribeClient: vi.fn(async () => ({ status: 'idle' })),
        unsubscribeClient: vi.fn(async () => undefined), getSessionStatus: vi.fn(() => ({ status: 'idle' })),
        getAgentSession: vi.fn(() => undefined),
      } as never,
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
    await flush(150);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  /** Dequeue the way the service does: awaited barrier FIRST, side effect second. */
  const dequeue = async (runId: string) => {
    const entry = barriers.get(runId)!;
    await entry.opts!.onDispatched!(); // rejects on a terminal receipt
    held.get(entry.sessionId)!.set(runId, 'dispatched');
    executed.push(entry.message);
  };

  const queueOne = async (message: string) => {
    const res = createMockRes();
    await routes.handleSendPrompt(
      createJsonReq('POST', '/api/v1/sessions/devin-1/prompt', { message, mode: 'follow_up', detach: true }),
      res, 'devin-1',
    );
    expect(res.statusCode).toBe(202);
    await waitUntil(() => devin.followUp.mock.calls.length >= 1, 'the message to reach the queue');
    const call = devin.followUp.mock.calls.at(-1) as unknown as [
      string, string, unknown, unknown, { itemId: string; onDispatched: () => Promise<void> },
    ];
    return { runId: call[4].itemId, opts: call[4] };
  };

  it('PARENT PROBE: onDispatched rejects after cancelRun, and the message never executes', async () => {
    const { runId } = await queueOne('cancelled before dispatch');
    await runReceipts.cancelRun(runId);
    expect(runReceipts.get(runId)!.status).toBe('cancelled');

    await expect(dequeue(runId)).rejects.toThrow();

    await flush(300);
    expect(executed).not.toContain('cancelled before dispatch');
    // The terminal decision is preserved, not overwritten by a late `started`.
    expect(runReceipts.get(runId)!.status).toBe('cancelled');
  });

  it('rejects after an acceptance-ceiling expiry, with no late execution', async () => {
    const { runId } = await queueOne('expired before dispatch');
    // Terminalise through the ceiling's own terminal shape, not only cancelRun.
    await runReceipts.finish(runId, { status: 'cancelled', cessationBasis: 'documented_handler_return' });
    expect(runReceipts.get(runId)!.status).toBe('cancelled');

    await expect(dequeue(runId)).rejects.toThrow();
    await flush(300);
    expect(executed).not.toContain('expired before dispatch');
  });

  it('a DELAYED legitimate barrier still dispatches, and the neighbour survives', async () => {
    const first = await queueOne('slow but legitimate');
    const second = await queueOne('the neighbour');
    expect(held.get('devin-1')?.has(second.runId)).toBe(true);

    // The barrier is genuinely delayed, not skipped.
    await new Promise((r) => setTimeout(r, 60));
    await dequeue(first.runId);

    expect(runReceipts.get(first.runId)!.status).toBe('started');
    expect(runReceipts.get(first.runId)!.liveness?.delivery).toMatchObject({ state: 'dispatched', basis: 'dequeue' });
    expect(executed).toContain('slow but legitimate');
    // The neighbour is untouched by the first item's barrier; nothing was aborted.
    expect(held.get('devin-1')?.has(second.runId)).toBe(true);
    expect(runReceipts.get(second.runId)!.status).not.toBe('cancelled');
    expect(devin.abort).not.toHaveBeenCalled();
  });

  it('rejects a MISSING receipt (deleted between queue and dequeue)', async () => {
    const { runId } = await queueOne('vanished');
    const spy = vi.spyOn(runReceipts, 'markStarted').mockResolvedValueOnce(undefined);
    await expect(dequeue(runId)).rejects.toThrow();
    expect(executed).not.toContain('vanished');
    spy.mockRestore();
  });
});

/**
 * Lane A correction 07 §2 (parent answers 06-q1/q2/q3) — DevinQueuedItemCancelled
 * ownership, with a CONTRACT-FAITHFUL fake for the removal API.
 *
 * The real service invokes the ROUTE-SUPPLIED `onComplete` SYNCHRONOUSLY, with the
 * real `DevinQueuedItemCancelled`, BEFORE returning `removed`
 * (`devin-service.ts` `cancelQueuedItem`, `abort`, `disposeSession`). A fake that
 * merely returns `'removed'` cannot see the bug this suite guards: the route's
 * `complete()` used to write `failed / RUNTIME_ERROR` first, so the removal
 * owner's later write was a no-op on an already-terminal receipt.
 *
 * The fix discriminates by `name` + `source`: a TARGETED removal is settled by its
 * owner (the route writes nothing), while abort/dispose have no other owner and
 * settle here as proven non-execution.
 */
describe('lane A correction 07 §2 — cancellation ownership at the route', () => {
  let dir: string;
  let runReceipts: RunReceiptManager;
  let devin: Record<string, any>;
  let routes: ReturnType<typeof createSessionRoutes>;
  /** Per session, the queued items and the callbacks the ROUTE supplied. */
  let queues: Map<string, Map<string, { onComplete: (e?: Error) => void }>>;
  let now: number;

  const devinEntry = {
    id: 'devin-1', path: 'devin-1', sdkType: 'devin', cwd: '/tmp',
    firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '',
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-owner-'));
    now = Date.now();
    queues = new Map();
    devin = {
      isRunning: vi.fn(() => true),
      followUp: vi.fn(async (
        sessionId: string, _m: string, _e: unknown,
        onComplete: (e?: Error) => void, opts?: { itemId?: string },
      ) => {
        const q = queues.get(sessionId) ?? new Map();
        q.set(opts?.itemId ?? 'anon', { onComplete });
        queues.set(sessionId, q);
        return true;
      }),
      // CONTRACT-FAITHFUL: the route's callback runs synchronously, with the real
      // error class, BEFORE the outcome is returned.
      cancelQueuedItem: vi.fn((sessionId: string, itemId: string) => {
        const q = queues.get(sessionId);
        const item = q?.get(itemId);
        if (!item) return 'unknown' as const;
        q!.delete(itemId);
        item.onComplete(new DevinQueuedItemCancelled(itemId));
        return 'removed' as const;
      }),
      abort: vi.fn((sessionId: string) => {
        for (const [itemId, item] of queues.get(sessionId) ?? []) {
          item.onComplete(new DevinQueuedItemCancelled(itemId, 'session aborted', 'session_abort'));
        }
        queues.delete(sessionId);
      }),
      disposeSession: vi.fn((sessionId: string) => {
        for (const [itemId, item] of queues.get(sessionId) ?? []) {
          item.onComplete(new DevinQueuedItemCancelled(itemId, 'session disposed', 'session_disposed'));
        }
        queues.delete(sessionId);
      }),
      getSessionStats: vi.fn(async () => undefined),
      isSessionPinned: vi.fn(() => false),
      getServedModel: vi.fn(async () => 'swe-2-flash-medium'),
    };
    const registry = {
      get: vi.fn(async (id: string) => (id === 'devin-1' ? devinEntry : undefined)),
      upsert: vi.fn(async () => undefined),
      listAll: vi.fn(async () => [devinEntry]),
    };
    runReceipts = new RunReceiptManager({
      store: new RunReceiptStore(path.join(dir, 'receipts'), { now: () => now }),
      now: () => now,
      turnMaxMs: 60_000,
      runStartWindowMs: 600_000,
      dispatchBarrierGraceMs: 1,
    });
    routes = createSessionRoutes({
      claudeService: { executionBackend: () => 'sdk-subscription', isRunning: () => false } as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: {
        addApiObserver: vi.fn(), removeApiObserver: vi.fn(), pinSession: vi.fn(() => true),
        unpinSession: vi.fn(() => true), subscribeClient: vi.fn(async () => ({ status: 'idle' })),
        unsubscribeClient: vi.fn(async () => undefined), getSessionStatus: vi.fn(() => ({ status: 'idle' })),
        getAgentSession: vi.fn(() => undefined),
      } as never,
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

  const queueOne = async (message: string): Promise<string> => {
    const res = createMockRes();
    await routes.handleSendPrompt(
      createJsonReq('POST', '/api/v1/sessions/devin-1/prompt', { message, mode: 'follow_up', detach: true }),
      res, 'devin-1',
    );
    expect(res.statusCode).toBe(202);
    await waitUntil(() => devin.followUp.mock.calls.length >= 1, 'the message to reach the queue');
    const call = devin.followUp.mock.calls.at(-1) as unknown as [string, string, unknown, unknown, { itemId: string }];
    return call[4].itemId;
  };

  it('(a) targeted removal is settled by its owner, not by the route', async () => {
    const runId = await queueOne('disconnect victim');

    // Exactly the real service's ordering: the callback fires inside the call.
    const outcome = devin.cancelQueuedItem('devin-1', runId);
    expect(outcome).toBe('removed');

    // The owner's write follows, as the SSE-disconnect path does it.
    await runReceipts.markItemRemoved(runId);
    await flush(60);

    const after = runReceipts.get(runId)!;
    expect(after.status).toBe('cancelled');
    expect(after.liveness?.delivery).toMatchObject({ state: 'cancelled_before_dispatch', basis: 'targeted_removal' });
    // The generic runtime failure must NOT be what the caller sees.
    expect(after.errorCode).not.toBe('RUNTIME_ERROR');
    // Only that item's lease was released: it held the only one.
    expect(runReceipts.getDrainingCount()).toBe(0);
    const snap = runReceipts.getLeaseOwnershipSnapshot();
    expect((snap.queuedByRuntime.devin ?? 0) + (snap.activeByRuntime.devin ?? 0)).toBe(0);
  });

  it('(b) ceiling expiry removal keeps the proven-removal outcome', async () => {
    const runId = await queueOne('ceiling victim');
    runReceipts.setCancelQueuedDelivery(async (id, sessionId) => devin.cancelQueuedItem(sessionId, id));

    const manager = runReceipts as unknown as { reconcileStalledRuns(): Promise<void> };
    now += 70_000;
    await manager.reconcileStalledRuns(); // past the acceptance ceiling: reserved
    now += 100_000;
    await manager.reconcileStalledRuns(); // grace elapsed: targeted removal
    await flush(60);

    const after = runReceipts.get(runId)!;
    // The removal owner's proven-removal outcome, not a generic failure.
    expect(after.status).toBe('cancelled');
    expect(after.liveness?.delivery).toMatchObject({ state: 'cancelled_before_dispatch', basis: 'targeted_removal' });
    expect(after.errorCode).not.toBe('RUNTIME_ERROR');
  });

  it('(c) session abort settles per item as proven non-execution (no other owner)', async () => {
    const runId = await queueOne('abort victim');

    devin.abort('devin-1'); // callback fires synchronously, source=session_abort
    await waitUntil(() => runReceipts.get(runId)?.status !== 'queued', 'the aborted item to settle');

    const after = runReceipts.get(runId)!;
    expect(after.status).toBe('cancelled');
    expect(after.liveness?.delivery).toMatchObject({ state: 'cancelled_before_dispatch', basis: 'targeted_removal' });
    expect(after.errorCode).not.toBe('RUNTIME_ERROR');
  });

  it('(c2) session dispose settles the same way as abort', async () => {
    const runId = await queueOne('dispose victim');
    devin.disposeSession('devin-1');
    await waitUntil(() => runReceipts.get(runId)?.status !== 'queued', 'the disposed item to settle');

    const after = runReceipts.get(runId)!;
    expect(after.status).toBe('cancelled');
    expect(after.errorCode).not.toBe('RUNTIME_ERROR');
  });
});
