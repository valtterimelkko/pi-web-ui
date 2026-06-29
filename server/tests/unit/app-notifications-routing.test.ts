import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { generateSessionToken } from '../../src/security/auth.js';
import type { NotificationManager } from '../../src/notifications/notification-manager.js';

/**
 * Regression guard for a real P7 wiring bug: the notifications web router was
 * originally mounted in index.ts AFTER createApp() had already registered the
 * GET-only SPA fallback (app.get('*')), which shadowed GET /:id/notifications
 * (served index.html instead of JSON) while POST/DELETE still worked.
 *
 * The fix mounts the router inside createApp(), before the SPA fallback. This
 * test asserts the router is reachable through the real createApp() stack with a
 * valid cookie and returns JSON — proving the mount is in place.
 */
describe('createApp() notification routing', () => {
  function stubManager(): NotificationManager {
    return {
      getOptIn: () => null,
      listDeliveriesForSession: () => [],
      optIn: async () => {},
      optOut: async () => {},
    } as unknown as NotificationManager;
  }

  it('GET /api/sessions/:id/notifications returns JSON via createApp (not shadowed by SPA fallback)', async () => {
    const app = createApp({
      getManager: () => stubManager(),
    });
    const token = generateSessionToken('default-user');

    const res = await request(app)
      .get('/api/sessions/s1/notifications')
      .set('Cookie', [`accessToken=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', optIn: null, deliveries: [] });
    // Must be JSON, not the SPA index.html shell.
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('rejects GET without a cookie (auth gate intact at createApp level)', async () => {
    const app = createApp({
      getManager: () => stubManager(),
    });

    const res = await request(app).get('/api/sessions/s1/notifications');
    expect(res.status).toBe(401);
  });
});
