import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

// NOTE: this file intentionally does NOT mock cookieAuthMiddleware — it verifies
// the real cookie-auth gate on the browser notification surface.
import { createNotificationsWebRouter } from '../../../src/routes/notifications-web.js';
import type { NotificationManager } from '../../../src/notifications/notification-manager.js';

describe('notifications web router — auth (real cookieAuthMiddleware)', () => {
  it('rejects an unauthenticated request (no cookie) with 401', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/sessions',
      createNotificationsWebRouter({
        // Should never be reached: auth rejects before the handler.
        getManager: () => ({} as NotificationManager),
      }),
    );

    const res = await request(app).get('/api/sessions/s1/notifications');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/cookie/i);
  });
});
