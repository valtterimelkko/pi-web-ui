import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createNotificationsRoutes } from '../../../src/internal-api/routes/notifications.js';
import { NotificationStore } from '../../../src/notifications/notification-store.js';
import { ChannelRouter } from '../../../src/notifications/channels/notification-channel.js';
import { NotificationManager } from '../../../src/notifications/notification-manager.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { Notification, NotificationChannel } from '../../../src/notifications/types.js';

// ── mock req/res (same shape as watch-routes.test.ts) ───────────────────────

function createJsonReq(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = url;
  (req as { headers?: Record<string, string> }).headers = { 'content-type': 'application/json', ...headers };
  process.nextTick(() => {
    if (body !== undefined) (req as PassThrough).emit('data', Buffer.from(JSON.stringify(body)));
    (req as PassThrough).emit('end');
  });
  return req;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };
  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  }) as never;
  res.write = vi.fn((chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }) as never;
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as never;
  res.on = vi.fn(() => res) as never;
  return res;
}

const json = (res: { body: string }): unknown => JSON.parse(res.body);

// ── fakes ────────────────────────────────────────────────────────────────────

function fakeService() {
  const observers = new Map<string, Set<(e: NormalizedEvent) => void>>();
  return {
    addCalls: [] as string[],
    removeCalls: [] as string[],
    addApiObserver(key: string, o: (e: NormalizedEvent) => void): void {
      this.addCalls.push(key);
      let set = observers.get(key);
      if (!set) {
        set = new Set();
        observers.set(key, set);
      }
      set.add(o);
    },
    removeApiObserver(key: string): void {
      this.removeCalls.push(key);
      observers.delete(key);
    },
  };
}

function captureChannel() {
  const received: Notification[] = [];
  const channel: NotificationChannel & { received: Notification[] } = {
    id: 'telegram',
    received,
    isConfigured: () => true,
    async send(n) {
      received.push(n);
    },
  };
  return channel;
}

function entry(sdkType: string, id = 's1') {
  return { id, path: sdkType === 'pi' ? `/sessions/${id}` : id, sdkType, cwd: '/tmp' };
}

describe('notifications routes', () => {
  let dir: string;
  let pi: ReturnType<typeof fakeService>;
  let claude: ReturnType<typeof fakeService>;
  let opencode: ReturnType<typeof fakeService>;
  let antigravity: ReturnType<typeof fakeService>;
  let channel: ReturnType<typeof captureChannel>;
  let manager: NotificationManager;
  let registry: { get: ReturnType<typeof vi.fn> };
  let routes: ReturnType<typeof createNotificationsRoutes>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-notif-routes-'));
    pi = fakeService();
    claude = fakeService();
    opencode = fakeService();
    antigravity = fakeService();
    channel = captureChannel();
    const router = new ChannelRouter();
    router.register(channel);
    const store = new NotificationStore(dir);
    manager = new NotificationManager({
      enabled: true,
      store,
      router,
      services: { pi, claude, opencode, antigravity },
      tailMaxChars: 1200,
      publicBaseUrl: 'https://app.example.com',
      debounceMs: 10,
      maxAttempts: 3,
      retryBackoffMs: 5000,
      now: () => '2026-06-29T00:00:00.000Z',
    });
    await manager.init();
    registry = { get: vi.fn() };
    routes = createNotificationsRoutes({ manager, sessionRegistry: registry as never });
  });

  afterEach(async () => {
    manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  describe('POST /sessions/:id/notifications/opt-in', () => {
    it('opts in a Pi session and attaches the observer on its sessionPath', async () => {
      registry.get.mockResolvedValue(entry('pi'));
      const res = createMockRes();
      await routes.handleOptIn(createJsonReq('POST', '/api/v1/sessions/s1/notifications/opt-in', { label: 'Job' }), res, 's1');

      expect(res.statusCode).toBe(200);
      expect(pi.addCalls).toEqual(['/sessions/s1']);
      expect(manager.getOptIn('s1')?.runtime).toBe('pi');
      expect(manager.getOptIn('s1')?.label).toBe('Job');
    });

    it('opts in each runtime and attaches on the sessionId key for non-Pi', async () => {
      for (const rt of ['claude', 'opencode', 'antigravity'] as const) {
        registry.get.mockResolvedValue(entry(rt, `id-${rt}`));
        const res = createMockRes();
        await routes.handleOptIn(createJsonReq('POST', `/api/v1/sessions/id-${rt}/notifications/opt-in`), res, `id-${rt}`);
        expect(res.statusCode).toBe(200);
      }
      expect(claude.addCalls).toEqual(['id-claude']);
      expect(opencode.addCalls).toEqual(['id-opencode']);
      expect(antigravity.addCalls).toEqual(['id-antigravity']);
    });

    it('normalizes a Pi opt-in to the canonical bare-uuid id (derived from entry.path)', async () => {
      // Internal-API Pi sessions already surface the bare uuid as sessionId, but
      // both entry points must agree: key the record on canonicalOptInId(path).
      const UUID = '019f23d5-624d-7ca3-b34c-53b6732c2b44';
      const BASENAME = `2026-07-02T17-16-54-733Z_${UUID}`;
      const PATH = `/root/.pi/agent/sessions/--root-pi-web-ui--/${BASENAME}.jsonl`;
      registry.get.mockResolvedValue({ id: BASENAME, path: PATH, sdkType: 'pi', cwd: '/tmp' });
      const res = createMockRes();
      await routes.handleOptIn(
        createJsonReq('POST', `/api/v1/sessions/${BASENAME}/notifications/opt-in`),
        res,
        BASENAME,
      );
      expect(res.statusCode).toBe(200);
      // Persisted under the bare uuid; observer attached on the real path.
      expect(manager.getOptIn(UUID)?.sessionPath).toBe(PATH);
      expect(pi.addCalls).toEqual([PATH]);
      const body = json(res) as { optIn: { sessionId: string } };
      expect(body.optIn.sessionId).toBe(UUID);
    });

    it('returns 404 SESSION_NOT_FOUND for an unknown session', async () => {
      registry.get.mockResolvedValue(undefined);
      const res = createMockRes();
      await routes.handleOptIn(createJsonReq('POST', '/api/v1/sessions/none/notifications/opt-in'), res, 'none');
      expect(res.statusCode).toBe(404);
      expect((json(res) as { code: string }).code).toBe('SESSION_NOT_FOUND');
    });

    it('warns when opt-in targets an unknown session (registry/UI mismatch signal)', async () => {
      const records: LogRecord[] = [];
      setLogTap((r) => records.push(r));
      try {
        registry.get.mockResolvedValue(undefined);
        const res = createMockRes();
        await routes.handleOptIn(createJsonReq('POST', '/api/v1/sessions/none/notifications/opt-in'), res, 'none');
        const rec = records.find(
          (r) => r.component === 'NotificationsRoutes' && r.level === 'warn' && r.msg.includes('none'),
        );
        expect(rec).toBeDefined();
      } finally {
        setLogTap(null);
      }
    });

    it('warns when opt-in targets a session whose runtime is unsupported', async () => {
      const records: LogRecord[] = [];
      setLogTap((r) => records.push(r));
      try {
        registry.get.mockResolvedValue(entry('opencli', 'weird1'));
        const res = createMockRes();
        await routes.handleOptIn(createJsonReq('POST', '/api/v1/sessions/weird1/notifications/opt-in'), res, 'weird1');
        expect(res.statusCode).toBe(400);
        const rec = records.find(
          (r) => r.component === 'NotificationsRoutes' && r.level === 'warn' && r.msg.includes('opencli'),
        );
        expect(rec).toBeDefined();
      } finally {
        setLogTap(null);
      }
    });

    it('returns 400 INVALID_REQUEST for a malformed body', async () => {
      registry.get.mockResolvedValue(entry('pi'));
      const res = createMockRes();
      await routes.handleOptIn(
        createJsonReq('POST', '/api/v1/sessions/s1/notifications/opt-in', { unexpected: true }),
        res,
        's1',
      );
      expect(res.statusCode).toBe(400);
      expect((json(res) as { code: string }).code).toBe('INVALID_REQUEST');
    });
  });

  describe('DELETE /sessions/:id/notifications/opt-in', () => {
    it('opts out and detaches the observer', async () => {
      registry.get.mockResolvedValue(entry('pi'));
      await routes.handleOptIn(createJsonReq('POST', '/api/v1/sessions/s1/notifications/opt-in'), res_void(), 's1');
      const res = createMockRes();
      await routes.handleOptOut(createJsonReq('DELETE', '/api/v1/sessions/s1/notifications/opt-in'), res, 's1');
      expect(res.statusCode).toBe(200);
      expect(manager.getOptIn('s1')).toBeUndefined();
      expect(pi.removeCalls).toEqual(['/sessions/s1']);
    });
  });

  describe('GET /sessions/:id/notifications', () => {
    it('returns the opt-in record and deliveries', async () => {
      registry.get.mockResolvedValue(entry('pi'));
      await routes.handleOptIn(createJsonReq('POST', '/api/v1/sessions/s1/notifications/opt-in', { label: 'L' }), res_void(), 's1');
      const res = createMockRes();
      await routes.handleGetSessionState(createJsonReq('GET', '/api/v1/sessions/s1/notifications'), res, 's1');
      expect(res.statusCode).toBe(200);
      const body = json(res) as { optIn: { label: string }; deliveries: unknown[] };
      expect(body.optIn.label).toBe('L');
      expect(Array.isArray(body.deliveries)).toBe(true);
    });

    it('canonicalizes Pi identity consistently for POST, GET, and DELETE', async () => {
      const uuid = '019f23d5-624d-7ca3-b34c-53b6732c2b44';
      const basename = `2026-07-02T17-16-54-733Z_${uuid}`;
      const sessionPath = `/sessions/${basename}.jsonl`;
      registry.get.mockResolvedValue({ sdkType: 'pi', path: sessionPath });

      await routes.handleOptIn(createJsonReq('POST', '/opt-in', {}), createMockRes(), basename);
      const state = createMockRes();
      await routes.handleGetSessionState(createJsonReq('GET', '/notifications'), state, basename);
      expect((json(state) as { optIn: { sessionId: string } }).optIn.sessionId).toBe(uuid);

      await routes.handleOptOut(createJsonReq('DELETE', '/opt-in'), createMockRes(), basename);
      expect(manager.getOptIn(uuid)).toBeUndefined();
    });

    it('returns a retryable failure instead of falsely succeeding when identity lookup fails', async () => {
      registry.get.mockRejectedValue(new Error('registry unavailable'));
      const getRes = createMockRes();
      await routes.handleGetSessionState(createJsonReq('GET', '/notifications'), getRes, 'pi-session');
      expect(getRes.statusCode).toBe(503);
      const deleteRes = createMockRes();
      await routes.handleOptOut(createJsonReq('DELETE', '/opt-in'), deleteRes, 'pi-session');
      expect(deleteRes.statusCode).toBe(503);
    });

    it('returns optIn:null when not opted in', async () => {
      const res = createMockRes();
      await routes.handleGetSessionState(createJsonReq('GET', '/api/v1/sessions/s1/notifications'), res, 's1');
      const body = json(res) as { optIn: unknown };
      expect(body.optIn).toBeNull();
    });
  });

  describe('POST /notifications (explicit)', () => {
    it('durably accepts an explicit notification and returns a pollable status URL', async () => {
      const res = createMockRes();
      await routes.handleExplicitNotify(
        createJsonReq('POST', '/api/v1/notifications', { title: 'Deploy', body: 'shipped' }),
        res,
      );
      expect(res.statusCode).toBe(202);
      const body = json(res) as {
        status: string;
        duplicate: boolean;
        notification: { id: string };
        statusUrl: string;
      };
      expect(body.status).toBe('accepted');
      expect(body.duplicate).toBe(false);
      expect(body.notification.id).toBeTruthy();
      expect(body.statusUrl).toBe(`/api/v1/notifications/${body.notification.id}`);
      await manager.drain();
      expect(channel.received[0].title).toBe('Deploy');
      expect(channel.received[0].kind).toBe('explicit');
    });

    it('deduplicates an identical Idempotency-Key and rejects a conflicting payload', async () => {
      const key = '019f23d5-624d-7ca3-b34c-53b6732c2b44';
      const first = createMockRes();
      await routes.handleExplicitNotify(
        createJsonReq('POST', '/api/v1/notifications', { title: 'Deploy', body: 'shipped' }, { 'idempotency-key': key }),
        first,
      );
      const firstBody = json(first) as { notification: { id: string } };

      const duplicate = createMockRes();
      await routes.handleExplicitNotify(
        createJsonReq('POST', '/api/v1/notifications', { title: 'Deploy', body: 'shipped' }, { 'idempotency-key': key }),
        duplicate,
      );
      const duplicateBody = json(duplicate) as { duplicate: boolean; notification: { id: string } };
      expect(duplicate.statusCode).toBe(202);
      expect(duplicateBody.duplicate).toBe(true);
      expect(duplicateBody.notification.id).toBe(firstBody.notification.id);

      const conflict = createMockRes();
      await routes.handleExplicitNotify(
        createJsonReq('POST', '/api/v1/notifications', { title: 'Deploy', body: 'different' }, { 'idempotency-key': key }),
        conflict,
      );
      expect(conflict.statusCode).toBe(409);
      expect((json(conflict) as { code: string }).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('trims explicit content and accepts only app-relative or HTTP(S) deep links', async () => {
      const accepted = createMockRes();
      await routes.handleExplicitNotify(
        createJsonReq('POST', '/api/v1/notifications', {
          title: '  Milestone  ', body: '  phase complete  ', deepLink: '/sessions/current',
        }),
        accepted,
      );
      expect(accepted.statusCode).toBe(202);
      await manager.drain();
      expect(channel.received.at(-1)).toMatchObject({
        title: 'Milestone', body: 'phase complete', deepLink: '/sessions/current',
      });

      for (const payload of [
        { title: 'X', body: '   ' },
        { title: 'X', body: 'ok', deepLink: 'javascript:alert(1)' },
        { title: 'X', body: 'ok', deepLink: '//evil.example/path' },
      ]) {
        const rejected = createMockRes();
        await routes.handleExplicitNotify(createJsonReq('POST', '/api/v1/notifications', payload), rejected);
        expect(rejected.statusCode).toBe(400);
      }
    });

    it('returns one notification delivery by server notification id', async () => {
      const accepted = createMockRes();
      await routes.handleExplicitNotify(
        createJsonReq('POST', '/api/v1/notifications', { title: 'Status', body: 'check' }),
        accepted,
      );
      const id = (json(accepted) as { notification: { id: string } }).notification.id;
      await manager.drain();

      const status = createMockRes();
      await routes.handleGetDeliveryStatus(
        createJsonReq('GET', `/api/v1/notifications/${id}`),
        status,
        id,
      );
      expect(status.statusCode).toBe(200);
      const statusBody = json(status) as { delivery: { notification: { id: string }; delivery: { status: string } } };
      expect(statusBody.delivery.notification.id).toBe(id);
      expect(statusBody.delivery.delivery.status).toBe('sent');

      const missing = createMockRes();
      await routes.handleGetDeliveryStatus(createJsonReq('GET', '/api/v1/notifications/missing'), missing, 'missing');
      expect(missing.statusCode).toBe(404);
    });

    it('returns 400 INVALID_REQUEST when the body is missing required fields', async () => {
      const res = createMockRes();
      await routes.handleExplicitNotify(createJsonReq('POST', '/api/v1/notifications', { title: 'no body' }), res);
      expect(res.statusCode).toBe(400);
      expect((json(res) as { code: string }).code).toBe('INVALID_REQUEST');
      expect(channel.received).toHaveLength(0);
    });
  });

  describe('GET /notifications (recent deliveries)', () => {
    it('returns the recent delivery log', async () => {
      // Produce one delivered notification first.
      await routes.handleExplicitNotify(
        createJsonReq('POST', '/api/v1/notifications', { title: 'A', body: 'b' }),
        res_void(),
      );
      await manager.drain();
      const res = createMockRes();
      await routes.handleGetRecentDeliveries(createJsonReq('GET', '/api/v1/notifications'), res, new URLSearchParams());
      expect(res.statusCode).toBe(200);
      const body = json(res) as { deliveries: { notification: { title: string } }[] };
      expect(body.deliveries.length).toBeGreaterThanOrEqual(1);
      expect(body.deliveries[0].notification.title).toBe('A');
    });
  });
});

/** Throwaway res for setup calls whose response we don't inspect. */
function res_void(): ServerResponse & { body: string; statusCode: number } {
  return createMockRes();
}
