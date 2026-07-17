/**
 * Integration: Notification layer end-to-end lifecycle.
 *
 * Ties together the pieces the unit tests exercise in isolation — route
 * handlers + real NotificationManager + real NotificationStore + capture channel
 * + a fake runtime service that emits the normalized event stream — to prove the
 * full opt-in → agent_end → build → enqueue → deliver → outbox('sent') → visible
 * in GET path, plus restart rehydration through the route surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createNotificationsRoutes } from '../../src/internal-api/routes/notifications.js';
import { NotificationStore } from '../../src/notifications/notification-store.js';
import { ChannelRouter } from '../../src/notifications/channels/notification-channel.js';
import { NotificationManager } from '../../src/notifications/notification-manager.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { Notification, NotificationChannel } from '../../src/notifications/types.js';

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
function createMockRes() {
  const chunks: Buffer[] = [];
  const res = new Writable({ write(c: Buffer, _e, cb) { chunks.push(c); cb(); } }) as unknown as ServerResponse & {
    body: string;
    statusCode: number;
  };
  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
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
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fakeService() {
  const observers = new Map<string, Set<(e: NormalizedEvent) => void>>();
  return {
    addApiObserver(key: string, o: (e: NormalizedEvent) => void): void {
      let set = observers.get(key);
      if (!set) {
        set = new Set();
        observers.set(key, set);
      }
      set.add(o);
    },
    removeApiObserver(key: string): void {
      observers.delete(key);
    },
    emit(key: string, e: NormalizedEvent): void {
      observers.get(key)?.forEach((o) => o(e));
    },
  };
}

describe('notification lifecycle (integration)', () => {
  let dir: string;
  let pi: ReturnType<typeof fakeService>;
  let channel: NotificationChannel & { received: Notification[] };
  let manager: NotificationManager;
  let registry: { get: ReturnType<typeof vi.fn> };
  let routes: ReturnType<typeof createNotificationsRoutes>;

  function buildRoutes(store: NotificationStore, capture: typeof channel, fail = false) {
    const router = new ChannelRouter();
    router.register(capture);
    const mgr = new NotificationManager({
      enabled: true,
      store,
      router,
      services: { pi },
      tailMaxChars: 1200,
      publicBaseUrl: 'https://app.example.com',
      debounceMs: 10,
      maxAttempts: 3,
      retryBackoffMs: 5000,
      now: () => '2026-06-29T00:00:00.000Z',
    });
    return mgr;
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-notif-int-'));
    pi = fakeService();
    const received: Notification[] = [];
    channel = {
      id: 'telegram',
      received,
      isConfigured: () => true,
      async send(n) {
        received.push(n);
      },
    };
    const store = new NotificationStore(dir);
    manager = buildRoutes(store, channel);
    await manager.init();
    registry = { get: vi.fn().mockResolvedValue({ id: 's1', path: '/sessions/s1', sdkType: 'pi', cwd: '/tmp' }) };
    routes = createNotificationsRoutes({ manager, sessionRegistry: registry as never });
  });

  afterEach(async () => {
    manager.shutdown();
    await manager.waitForIdle();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('full lifecycle: route opt-in → service agent_end → delivered and visible in GET', async () => {
    // 1. Opt in via the route.
    const opt = createMockRes();
    await routes.handleOptIn(createJsonReq('POST', '/api/v1/sessions/s1/notifications/opt-in', { label: 'Job' }), opt, 's1');
    expect(opt.statusCode).toBe(200);

    // 2. The runtime service emits the assistant turn + agent_end (origin-independent:
    //    the manager hooks the service, so this is the same path a browser prompt takes).
    pi.emit('/sessions/s1', { type: 'message_start', sessionId: 's1', timestamp: 1, data: { role: 'assistant' } });
    pi.emit('/sessions/s1', {
      type: 'message_update',
      sessionId: 's1',
      timestamp: 2,
      data: { assistantMessageEvent: { type: 'text_delta', delta: 'Integration done.' } },
    });
    pi.emit('/sessions/s1', { type: 'agent_end', sessionId: 's1', timestamp: 3, data: {} });
    await wait(50);
    await manager.drain();

    // 3. The capture channel received a well-formed agent_end notification.
    expect(channel.received).toHaveLength(1);
    expect(channel.received[0].kind).toBe('agent_end');
    expect(channel.received[0].sessionId).toBe('s1');
    expect(channel.received[0].body).toContain('Integration done.');
    expect(channel.received[0].deepLink).toBe('https://app.example.com?session=s1');

    // 4. GET state reflects the sent delivery (outbox drained → 'sent' in the log).
    const state = createMockRes();
    await routes.handleGetSessionState(createJsonReq('GET', '/api/v1/sessions/s1/notifications'), state, 's1');
    const body = json(state) as { optIn: { label: string }; deliveries: { delivery: { status: string } }[] };
    expect(body.optIn.label).toBe('Job');
    expect(body.deliveries.some((d) => d.delivery.status === 'sent')).toBe(true);
  });

  it('Pi desync lifecycle: basename opt-in normalizes to the bare uuid; cross-id read-back + opt-out stops notifications', async () => {
    // Real prod-derived Pi dual-id shapes (plan §2): the live sidebar id is the
    // basename; after reload it is the bare uuid. The fix makes both agree.
    const UUID = '019f23d5-624d-7ca3-b34c-53b6732c2b44';
    const BASENAME = `2026-07-02T17-16-54-733Z_${UUID}`;
    const PATH = `/root/.pi/agent/sessions/--root-pi-web-ui--/${BASENAME}.jsonl`;
    registry.get.mockResolvedValue({ id: BASENAME, path: PATH, sdkType: 'pi', cwd: '/tmp' });

    // 1. Opt in via the LIVE basename id (what the sidebar shows while streaming).
    const opt = createMockRes();
    await routes.handleOptIn(
      createJsonReq('POST', `/api/v1/sessions/${BASENAME}/notifications/opt-in`, { label: 'Desync job' }),
      opt,
      BASENAME,
    );
    expect(opt.statusCode).toBe(200);

    // 2. agent_end fires on the path-keyed observer (origin-independent).
    pi.emit(PATH, { type: 'agent_end', sessionId: BASENAME, timestamp: 1, data: {} });
    await wait(50);
    await manager.drain();
    expect(channel.received).toHaveLength(1);
    expect(channel.received[0].sessionId).toBe(UUID); // notification keyed on the canonical uuid

    // 3. Read state back by the BARE UUID (the reloaded sidebar id) — pre-fix this
    //    returned null because the record was keyed by the basename.
    const state = createMockRes();
    await routes.handleGetSessionState(
      createJsonReq('GET', `/api/v1/sessions/${UUID}/notifications`),
      state,
      UUID,
    );
    const crossBody = json(state) as {
      optIn: { label: string };
      deliveries: { notification: { sessionId?: string; kind?: string }; delivery: { status: string } }[];
    };
    expect(crossBody.optIn.label).toBe('Desync job');
    const agentEnd = crossBody.deliveries.find((d) => d.notification.kind === 'agent_end');
    expect(agentEnd?.notification?.sessionId).toBe(UUID);
    expect(agentEnd?.delivery.status).toBe('sent');

    // 4. Opt out by the UUID (what the reloaded sidebar sends) — clears it.
    const out = createMockRes();
    await routes.handleOptOut(
      createJsonReq('DELETE', `/api/v1/sessions/${UUID}/notifications/opt-in`),
      out,
      UUID,
    );
    expect(out.statusCode).toBe(200);
    expect(manager.getOptIn(UUID)).toBeUndefined();

    // 5. A subsequent agent_end produces NO further delivery (opt-out truly works,
    //    and there is no stale husk still observing).
    pi.emit(PATH, { type: 'agent_end', sessionId: BASENAME, timestamp: 2, data: {} });
    await wait(50);
    await manager.drain();
    expect(channel.received).toHaveLength(1); // still only the first
  });

  it('restart rehydration: a pending delivery is drained by a fresh manager on the same store', async () => {
    // Opt in + emit agent_end, but against a FAILING channel so the item stays pending.
    manager.shutdown();
    const failed: Notification[] = [];
    const failChannel: NotificationChannel & { received: Notification[] } = {
      id: 'telegram',
      received: failed,
      isConfigured: () => true,
      async send() {
        throw new Error('boom');
      },
    };
    const storeA = new NotificationStore(dir);
    const mgrA = buildRoutes(storeA, failChannel);
    await mgrA.init();
    const routesA = createNotificationsRoutes({ manager: mgrA, sessionRegistry: registry as never });
    const opt = createMockRes();
    await routesA.handleOptIn(createJsonReq('POST', '/api/v1/sessions/s1/notifications/opt-in'), opt, 's1');
    pi.emit('/sessions/s1', { type: 'agent_end', sessionId: 's1', timestamp: 1, data: {} });
    await wait(50);
    await mgrA.drain();
    expect(storeA.listPending()).toHaveLength(1);
    mgrA.shutdown();

    // Fresh manager on the same store (simulated restart) + a working channel.
    const working: Notification[] = [];
    const okChannel: NotificationChannel & { received: Notification[] } = {
      id: 'telegram',
      received: working,
      isConfigured: () => true,
      async send(n) {
        working.push(n);
      },
    };
    const storeB = new NotificationStore(dir);
    const mgrB = buildRoutes(storeB, okChannel);
    await mgrB.init(); // rehydrates opt-ins + resumes the outbox
    await wait(40);

    // The pending delivery from before the restart was drained and delivered.
    expect(working).toHaveLength(1);
    expect(storeB.listPending()).toHaveLength(0);
    expect(storeB.listLog()).toHaveLength(1);
    mgrB.shutdown();
  });
});
