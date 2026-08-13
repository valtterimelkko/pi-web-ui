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
import { canonicalOptInId } from '@pi-web-ui/shared';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import type { NotificationManager } from '../notifications/notification-manager.js';
import type { NotificationRuntime, OptInRecord } from '../notifications/types.js';

const RUNTIMES: readonly NotificationRuntime[] = ['pi', 'claude', 'opencode', 'antigravity', 'commandcode'];

export interface NotificationsWebDeps {
  getManager: () => NotificationManager | null;
  /** Resolves the browser-visible runtime identity; Command Code uses this to prevent shadow-only exposure. */
  resolveSession?: (sessionId: string, runtime: NotificationRuntime, sessionPath: string) => Promise<boolean>;
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
    const rawId = req.params.id;
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
    // Normalize the opt-in key to the canonical identity (Pi: bare uuid from the
    // path; others: the id unchanged). The sidebar's session.id is the basename
    // while a Pi session is live but the bare uuid after reload; keying on the
    // canonical id here (defense in depth — the client already sends it) keeps
    // the persisted record findable by GET after a reload. The POST body still
    // carries the real sessionPath for the Pi observer's serviceKey.
    const sessionId = canonicalOptInId(runtime as NotificationRuntime, rawId, sessionPath);
    if (runtime === 'commandcode' && (!deps.resolveSession
      || rawId !== sessionPath
      || !(await deps.resolveSession(sessionId, runtime as NotificationRuntime, sessionPath)))) {
      res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 200) : undefined;
    const record: OptInRecord = {
      sessionId,
      runtime: runtime as NotificationRuntime,
      sessionPath,
      optedInAt: new Date().toISOString(),
      label,
      access: runtime === 'commandcode' ? 'browser' : 'internal',
    };
    const accepted = await manager.optIn(record);
    if (accepted === false) {
      res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }
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
    const existing = manager.getOptIn(req.params.id);
    if (existing?.runtime === 'commandcode' && !isBoundBrowserCommandCodeRecord(existing, req.params.id)) {
      res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }
    if (existing?.runtime === 'commandcode' && (!deps.resolveSession || !(await deps.resolveSession(req.params.id, existing.runtime, existing.sessionPath)))) {
      res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
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
    const existing = manager.getOptIn(req.params.id);
    if (existing?.runtime === 'commandcode' && !isBoundBrowserCommandCodeRecord(existing, req.params.id)) {
      res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }
    if (existing?.runtime === 'commandcode' && (!deps.resolveSession || !(await deps.resolveSession(req.params.id, existing.runtime, existing.sessionPath)))) {
      res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }
    const allDeliveries = manager.listDeliveriesForSession(req.params.id);
    if (!existing && allDeliveries.some((item) => item.notification.runtime === 'commandcode')) {
      if (!deps.resolveSession || !(await deps.resolveSession(req.params.id, 'commandcode', req.params.id))) {
        res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
    }
    const deliveries = existing?.runtime === 'commandcode'
      ? allDeliveries
      : allDeliveries.filter((item) => item.notification.runtime !== 'commandcode');
    res.json({
      status: 'ok',
      optIn: existing ?? null,
      deliveries,
    });
  });

  return router;
}

function isBoundBrowserCommandCodeRecord(record: OptInRecord, requestedId: string): boolean {
  return record.access === 'browser'
    && record.sessionId === requestedId
    && record.sessionPath === record.sessionId;
}
