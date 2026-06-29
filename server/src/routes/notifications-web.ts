/**
 * Browser-facing notification opt-in (cookie-auth REST).
 *
 * The browser cannot reach the Internal API's Unix socket, so this thin router
 * exposes the same opt-in/opt-out/state surface over the main app's cookie-auth
 * REST API. It lazily resolves the NotificationManager that the internal API
 * server constructs (the manager may be null if the Internal API is disabled or
 * not yet started → 503).
 */

import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import type { NotificationManager } from '../notifications/notification-manager.js';
import type { NotificationRuntime, OptInRecord } from '../notifications/types.js';

const RUNTIMES: readonly NotificationRuntime[] = ['pi', 'claude', 'opencode', 'antigravity'];

export interface NotificationsWebDeps {
  getManager: () => NotificationManager | null;
}

export function createNotificationsWebRouter(deps: NotificationsWebDeps): Router {
  const router = Router();
  router.use(cookieAuthMiddleware);

  /** POST /api/sessions/:id/notifications/opt-in */
  router.post('/:id/notifications/opt-in', async (req: Request, res: Response) => {
    const manager = deps.getManager();
    if (!manager) {
      res.status(503).json({ error: 'Notifications unavailable', code: 'NOTIFICATIONS_UNAVAILABLE' });
      return;
    }
    const sessionId = req.params.id;
    // The session list (and thus the toggle) already carries each session's
    // runtime + path. The registry is NOT a reliable lookup key here: its ids
    // are generated UUIDs that do not match the sidebar's session id (notably
    // for Pi CLI sessions). Trust the cookie-auth'd client's server-sourced
    // values, validating only their shape.
    const runtime = req.body?.runtime as unknown;
    if (!RUNTIMES.includes(runtime as NotificationRuntime)) {
      res.status(400).json({ error: 'Invalid or missing runtime', code: 'INVALID_RUNTIME' });
      return;
    }
    const sessionPath =
      typeof req.body?.sessionPath === 'string' ? req.body.sessionPath.slice(0, 1024) : '';
    if (!sessionPath) {
      res.status(400).json({ error: 'Missing sessionPath', code: 'MISSING_SESSION_PATH' });
      return;
    }
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 200) : undefined;
    const record: OptInRecord = {
      sessionId,
      runtime: runtime as NotificationRuntime,
      sessionPath,
      optedInAt: new Date().toISOString(),
      label,
    };
    await manager.optIn(record);
    res.json({
      status: 'ok',
      optIn: { sessionId, runtime: record.runtime, label: record.label },
    });
  });

  /** DELETE /api/sessions/:id/notifications/opt-in */
  router.delete('/:id/notifications/opt-in', async (req: Request, res: Response) => {
    const manager = deps.getManager();
    if (!manager) {
      res.status(503).json({ error: 'Notifications unavailable', code: 'NOTIFICATIONS_UNAVAILABLE' });
      return;
    }
    await manager.optOut(req.params.id);
    res.json({ status: 'ok', optIn: null });
  });

  /** GET /api/sessions/:id/notifications */
  router.get('/:id/notifications', async (req: Request, res: Response) => {
    const manager = deps.getManager();
    if (!manager) {
      res.status(503).json({ error: 'Notifications unavailable', code: 'NOTIFICATIONS_UNAVAILABLE' });
      return;
    }
    res.json({
      status: 'ok',
      optIn: manager.getOptIn(req.params.id) ?? null,
      deliveries: manager.listDeliveriesForSession(req.params.id),
    });
  });

  return router;
}
