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
    listDeliveriesForSession: () => [],
  } as unknown as NotificationManager & {
    optIn: ReturnType<typeof vi.fn>;
    optOut: ReturnType<typeof vi.fn>;
  };
}

function buildApp(manager: NotificationManager | null) {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createNotificationsWebRouter({ getManager: () => manager }));
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

  it('returns 503 when notifications are unavailable (no manager)', async () => {
    const app = buildApp(null);
    const res = await request(app).get('/api/sessions/s1/notifications');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOTIFICATIONS_UNAVAILABLE');
  });
});
