/**
 * Internal API: Notification Routes
 *
 * Opt a session in/out of `agent_end` notifications, inspect a session's
 * opt-in state + recent deliveries, list recent deliveries across all sessions,
 * and emit explicit notifications (Agent OS / operator scripts).
 *
 * Auth: these handlers run inside the server's bearer-token auth middleware
 * (it wraps the dispatcher that calls them), so every route is token-authed
 * identically to the rest of the Internal API.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import { ErrorCode, enrichedErrorBody } from '../error-codes.js';
import { createLogger } from '../../logging/logger.js';
import type { NotificationManager } from '../../notifications/notification-manager.js';
import type { NotificationRuntime, OptInRecord } from '../../notifications/types.js';

const logger = createLogger('NotificationsRoutes');

const NOTIFICATION_RUNTIMES: readonly NotificationRuntime[] = ['pi', 'claude', 'opencode', 'antigravity'];

function isNotificationRuntime(value: unknown): value is NotificationRuntime {
  return typeof value === 'string' && (NOTIFICATION_RUNTIMES as readonly string[]).includes(value);
}

const optInBodySchema = z
  .object({
    label: z.string().trim().max(200).optional(),
  })
  .strict();

const explicitBodySchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    body: z.string().min(1).max(20_000),
    deepLink: z.string().trim().max(2000).optional(),
  })
  .strict();

export interface NotificationsRoutesDeps {
  manager: NotificationManager;
  /** Minimal registry seam: resolve a session's runtime + path. */
  sessionRegistry: {
    get(sessionId: string): Promise<{ sdkType: string; path?: string } | undefined | null>;
  };
}

export function createNotificationsRoutes(deps: NotificationsRoutesDeps) {
  const { manager, sessionRegistry } = deps;

  /** POST /api/v1/sessions/:id/notifications/opt-in */
  async function handleOptIn(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const entry = await sessionRegistry.get(sessionId).catch(() => undefined);
    if (!entry) {
      logger.warn(`opt-in requested for unknown session: ${sessionId} (registry/UI mismatch)`);
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, `Session not found: ${sessionId}`));
      return;
    }
    const runtime = entry.sdkType;
    if (!isNotificationRuntime(runtime)) {
      logger.warn(`opt-in requested for session ${sessionId} with unsupported runtime: ${String(runtime)}`);
      sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, `Unsupported runtime: ${String(runtime)}`));
      return;
    }
    const parsed = optInBodySchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, parsed.error.issues[0]?.message ?? 'invalid request body'));
      return;
    }
    const record: OptInRecord = {
      sessionId,
      runtime,
      sessionPath: entry.path ?? sessionId,
      optedInAt: new Date().toISOString(),
      label: parsed.data.label,
    };
    await manager.optIn(record);
    sendJson(res, 200, {
      status: 'ok',
      optIn: { sessionId, runtime: record.runtime, label: record.label, optedInAt: record.optedInAt },
    });
  }

  /** DELETE /api/v1/sessions/:id/notifications/opt-in */
  async function handleOptOut(_req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    await manager.optOut(sessionId);
    sendJson(res, 200, { status: 'ok', optIn: null });
  }

  /** GET /api/v1/sessions/:id/notifications */
  async function handleGetSessionState(_req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    sendJson(res, 200, {
      status: 'ok',
      optIn: manager.getOptIn(sessionId) ?? null,
      deliveries: manager.listDeliveriesForSession(sessionId),
    });
  }

  /** POST /api/v1/notifications */
  async function handleExplicitNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = explicitBodySchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, parsed.error.issues[0]?.message ?? 'invalid request body'));
      return;
    }
    const notification = await manager.emitExplicit(parsed.data);
    sendJson(res, 200, { status: 'ok', notification: { id: notification.id, createdAt: notification.createdAt } });
  }

  /** GET /api/v1/notifications[?limit=N] */
  async function handleGetRecentDeliveries(
    _req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    const rawLimit = Number.parseInt(query.get('limit') ?? '', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : undefined;
    sendJson(res, 200, { status: 'ok', deliveries: manager.listRecentDeliveries(limit) });
  }

  return { handleOptIn, handleOptOut, handleGetSessionState, handleExplicitNotify, handleGetRecentDeliveries };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
