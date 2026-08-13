import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Pass-through cookie auth so the handler logic can be exercised without a JWT.
vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { createNotificationsWebRouter } from '../../../src/routes/notifications-web.js';
import type { NotificationManager } from '../../../src/notifications/notification-manager.js';
import type { OptInRecord } from '../../../src/notifications/types.js';

function fakeManager() {
  const optIns = new Map<string, OptInRecord>();
  return {
    optIn: vi.fn(async (r: OptInRecord) => {
      optIns.set(r.sessionId, r);
    }),
    optOut: vi.fn(async (id: string) => {
      optIns.delete(id);
    }),
    getOptIn: (id: string) => optIns.get(id),
    listDeliveriesForSession: vi.fn(() => []),
  } as unknown as NotificationManager & {
    optIn: ReturnType<typeof vi.fn>;
    optOut: ReturnType<typeof vi.fn>;
    listDeliveriesForSession: ReturnType<typeof vi.fn>;
  };
}

function buildApp(manager: NotificationManager | null, resolveSession?: (sessionId: string, runtime: import('../../../src/notifications/types.js').NotificationRuntime, sessionPath: string) => Promise<boolean>) {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createNotificationsWebRouter({ getManager: () => manager, resolveSession }));
  return app;
}

describe('notifications web router (cookie-auth browser surface)', () => {
  it('POST opt-in records the session from client-provided runtime + path', async () => {
    const mgr = fakeManager();
    const app = buildApp(mgr);

    const res = await request(app)
      .post('/api/sessions/s1/notifications/opt-in')
      .send({ runtime: 'claude', sessionPath: '/c/s1', label: 'My job' });

    expect(res.status).toBe(200);
    expect(mgr.optIn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        runtime: 'claude',
        sessionPath: '/c/s1',
        label: 'My job',
      }),
    );
    expect(res.body.optIn.runtime).toBe('claude');
  });

  it('POST opt-in rejects an invalid runtime with 400', async () => {
    const app = buildApp(fakeManager());
    const res = await request(app)
      .post('/api/sessions/s1/notifications/opt-in')
      .send({ runtime: 'nope', sessionPath: '/p' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RUNTIME');
  });

  it('POST opt-in rejects a missing sessionPath with 400', async () => {
    const app = buildApp(fakeManager());
    const res = await request(app)
      .post('/api/sessions/s1/notifications/opt-in')
      .send({ runtime: 'pi' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SESSION_PATH');
  });

  it('DELETE opt-out opts out', async () => {
    const mgr = fakeManager();
    const app = buildApp(mgr);
    const res = await request(app).delete('/api/sessions/s1/notifications/opt-in');
    expect(res.status).toBe(200);
    expect(mgr.optOut).toHaveBeenCalledWith('s1');
  });

  it('GET state returns opt-in + deliveries', async () => {
    const mgr = fakeManager();
    await mgr.optIn({
      sessionId: 's1',
      runtime: 'pi',
      sessionPath: '/p/s1',
      optedInAt: '2026-06-29T00:00:00.000Z',
    });
    const app = buildApp(mgr);
    const res = await request(app).get('/api/sessions/s1/notifications');
    expect(res.status).toBe(200);
    expect(res.body.optIn.runtime).toBe('pi');
    expect(Array.isArray(res.body.deliveries)).toBe(true);
  });

  it('rejects browser Command Code opt-in when the active policy no longer exposes the session', async () => {
    const app = buildApp(fakeManager(), async () => false);
    const res = await request(app)
      .post('/api/sessions/browser-cmd/notifications/opt-in')
      .send({ runtime: 'commandcode', sessionPath: 'browser-cmd' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
  });

  it('rejects a browser Command Code opt-in whose id and sessionPath do not identify the same session', async () => {
    const mgr = fakeManager();
    const app = buildApp(mgr, async () => true);
    const res = await request(app)
      .post('/api/sessions/shadow-cmd/notifications/opt-in')
      .send({ runtime: 'commandcode', sessionPath: 'browser-cmd' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
    expect(mgr.optIn).not.toHaveBeenCalled();
  });

  it('fails closed when the browser Command Code policy resolver is not wired', async () => {
    const mgr = fakeManager();
    const app = buildApp(mgr);
    const post = await request(app)
      .post('/api/sessions/browser-cmd/notifications/opt-in')
      .send({ runtime: 'commandcode', sessionPath: 'browser-cmd' });
    expect(post.status).toBe(404);
    expect(post.body.code).toBe('SESSION_NOT_FOUND');

    await mgr.optIn({
      sessionId: 'browser-cmd',
      runtime: 'commandcode',
      sessionPath: 'browser-cmd',
      optedInAt: '2026-08-13T00:00:00.000Z',
      access: 'browser',
    });
    const get = await request(app).get('/api/sessions/browser-cmd/notifications');
    expect(get.status).toBe(404);
    const deleteResponse = await request(app).delete('/api/sessions/browser-cmd/notifications/opt-in');
    expect(deleteResponse.status).toBe(404);
    expect(mgr.getOptIn('browser-cmd')).toBeDefined();
  });

  it('does not expose a shadow Command Code opt-in through the browser state or opt-out routes', async () => {
    const mgr = fakeManager();
    await mgr.optIn({
      sessionId: 'shadow-cmd',
      runtime: 'commandcode',
      sessionPath: 'shadow-cmd',
      optedInAt: '2026-08-13T00:00:00.000Z',
      access: 'internal',
    });
    const app = buildApp(mgr, async () => false);

    const state = await request(app).get('/api/sessions/shadow-cmd/notifications');
    expect(state.status).toBe(404);
    expect(state.body.code).toBe('SESSION_NOT_FOUND');

    const optOut = await request(app).delete('/api/sessions/shadow-cmd/notifications/opt-in');
    expect(optOut.status).toBe(404);
    expect(optOut.body.code).toBe('SESSION_NOT_FOUND');
    expect(mgr.getOptIn('shadow-cmd')).toBeDefined();
  });

  it('hides shadow Command Code delivery history after its opt-in is removed', async () => {
    const mgr = fakeManager();
    mgr.listDeliveriesForSession.mockReturnValue([{ notification: { runtime: 'commandcode' } }]);
    const app = buildApp(mgr, async () => false);
    const state = await request(app).get('/api/sessions/shadow-cmd/notifications');
    expect(state.status).toBe(404);
    expect(state.body.code).toBe('SESSION_NOT_FOUND');
  });

  it('rejects a mismatched or path-bound stored browser Command Code identity', async () => {
    const mgr = fakeManager();
    await mgr.optIn({
      sessionId: 'shadow-cmd',
      runtime: 'commandcode',
      sessionPath: 'browser-cmd',
      optedInAt: '2026-08-13T00:00:00.000Z',
      access: 'browser',
    });
    const app = buildApp(mgr, async () => true);
    const state = await request(app).get('/api/sessions/shadow-cmd/notifications');
    expect(state.status).toBe(404);
    const optOut = await request(app).delete('/api/sessions/shadow-cmd/notifications/opt-in');
    expect(optOut.status).toBe(404);
    expect(mgr.getOptIn('shadow-cmd')).toBeDefined();
  });

  it('does not treat a mismatched browser record as an active browser session', async () => {
    const mgr = fakeManager();
    await mgr.optIn({
      sessionId: 'shadow-cmd',
      runtime: 'commandcode',
      sessionPath: 'browser-cmd',
      optedInAt: '2026-08-13T00:00:00.000Z',
      access: 'browser',
    });
    const app = buildApp(mgr, async () => true);
    const state = await request(app).get('/api/sessions/shadow-cmd/notifications');
    expect(state.status).toBe(404);

    const browserMgr = fakeManager();
    await browserMgr.optIn({
      sessionId: 'browser-cmd',
      runtime: 'commandcode',
      sessionPath: 'browser-cmd',
      optedInAt: '2026-08-13T00:00:00.000Z',
      access: 'browser',
    });
    const browserApp = buildApp(browserMgr, async () => true);
    const browserState = await request(browserApp).get('/api/sessions/browser-cmd/notifications');
    expect(browserState.status).toBe(200);
  });

  it('hides browser Command Code deliveries if a stored identity is no longer browser-visible', async () => {
    const mgr = fakeManager();
    await mgr.optIn({
      sessionId: 'browser-cmd',
      runtime: 'commandcode',
      sessionPath: 'browser-cmd',
      optedInAt: '2026-08-13T00:00:00.000Z',
      access: 'browser',
    });
    mgr.listDeliveriesForSession.mockReturnValue([{ notification: { runtime: 'commandcode' } }]);
    const app = buildApp(mgr, async () => false);
    const state = await request(app).get('/api/sessions/browser-cmd/notifications');
    expect(state.status).toBe(404);
    expect(state.body.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 503 when notifications are unavailable (no manager)', async () => {
    const app = buildApp(null);
    const res = await request(app).get('/api/sessions/s1/notifications');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOTIFICATIONS_UNAVAILABLE');
  });

  describe('Pi canonical opt-in id (desync fix)', () => {
    // Real prod-derived Pi dual-id shapes (plan §2): the live sidebar posts the
    // basename as `:id` but carries the real `.jsonl` path in the body.
    const UUID = '019f23d5-624d-7ca3-b34c-53b6732c2b44';
    const BASENAME = `2026-07-02T17-16-54-733Z_${UUID}`;
    const PATH = `/root/.pi/agent/sessions/--root-pi-web-ui--/${BASENAME}.jsonl`;

    it('POST opt-in with a Pi basename `:id` records + returns the bare uuid', async () => {
      const mgr = fakeManager();
      const app = buildApp(mgr);
      const res = await request(app)
        .post(`/api/sessions/${BASENAME}/notifications/opt-in`)
        .send({ runtime: 'pi', sessionPath: PATH, label: 'Pi job' });

      expect(res.status).toBe(200);
      // Persisted under the canonical bare uuid, real path preserved.
      expect(mgr.optIn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: UUID, runtime: 'pi', sessionPath: PATH, label: 'Pi job' }),
      );
      // The response surfaces the normalized id the client should use henceforth.
      expect(res.body.optIn.sessionId).toBe(UUID);
      expect(res.body.optIn.runtime).toBe('pi');
    });

    it('POST opt-in with a bare-uuid `:id` is idempotent (stays the uuid)', async () => {
      const mgr = fakeManager();
      const app = buildApp(mgr);
      const res = await request(app)
        .post(`/api/sessions/${UUID}/notifications/opt-in`)
        .send({ runtime: 'pi', sessionPath: PATH });

      expect(res.status).toBe(200);
      expect(mgr.optIn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: UUID, sessionPath: PATH }));
      expect(res.body.optIn.sessionId).toBe(UUID);
    });

    it('POST opt-in leaves a non-Pi runtime `:id` unchanged', async () => {
      const mgr = fakeManager();
      const app = buildApp(mgr);
      const res = await request(app)
        .post('/api/sessions/c1/notifications/opt-in')
        .send({ runtime: 'claude', sessionPath: 'c1' });

      expect(res.status).toBe(200);
      expect(mgr.optIn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'c1' }));
      expect(res.body.optIn.sessionId).toBe('c1');
    });
  });
});
