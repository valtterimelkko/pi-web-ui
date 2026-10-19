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
import { canonicalOptInId } from '@pi-web-ui/shared';
import { ErrorCode, enrichedErrorBody } from '../error-codes.js';
import { readBoundedJsonBody } from '../request-body.js';
import { createLogger } from '../../logging/logger.js';
import {
  NotificationIdempotencyConflictError,
  type NotificationManager,
} from '../../notifications/notification-manager.js';
import type { NotificationRuntime, OptInRecord } from '../../notifications/types.js';
import { NOTIFICATION_ACTION_LIMITS } from '../../notifications/types.js';
import type { ActionHandlerRegistry } from '../../notifications/action-handlers.js';

const logger = createLogger('NotificationsRoutes');

const NOTIFICATION_RUNTIMES: readonly NotificationRuntime[] = ['pi', 'claude', 'opencode', 'antigravity', 'commandcode'];

function isNotificationRuntime(value: unknown): value is NotificationRuntime {
  return typeof value === 'string' && (NOTIFICATION_RUNTIMES as readonly string[]).includes(value);
}

const optInBodySchema = z
  .object({
    label: z.string().trim().max(200).optional(),
  })
  .strict();

const actionIdPattern = new RegExp(`^[A-Za-z0-9_-]{1,${NOTIFICATION_ACTION_LIMITS.actionIdMaxLength}}$`);
const actionRefPattern = new RegExp(`^[A-Za-z0-9_-]{1,${NOTIFICATION_ACTION_LIMITS.actionRefMaxLength}}$`);

const notificationActionSchema = z.object({
  id: z.string().regex(actionIdPattern, `action id must be 1-${NOTIFICATION_ACTION_LIMITS.actionIdMaxLength} characters of A-Z a-z 0-9 _ -`),
  label: z.string().trim().min(1, 'action label must not be empty').max(NOTIFICATION_ACTION_LIMITS.actionLabelMaxLength, `action label must be at most ${NOTIFICATION_ACTION_LIMITS.actionLabelMaxLength} characters`),
});

const explicitBodySchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    body: z.string().trim().min(1).max(20_000),
    deepLink: z.string().trim().max(2000).refine(isSafeDeepLink, {
      message: 'deepLink must be an app-relative path or an HTTP(S) URL',
    }).optional(),
    // Contract CHANNEL.md §7: tappable actions. All three fields or none.
    actions: z.array(notificationActionSchema).min(1).max(NOTIFICATION_ACTION_LIMITS.maxActions, `at most ${NOTIFICATION_ACTION_LIMITS.maxActions} actions`).optional(),
    actionHandler: z.string().min(1).max(128).optional(),
    actionRef: z.string().regex(actionRefPattern, `actionRef must be 1-${NOTIFICATION_ACTION_LIMITS.actionRefMaxLength} characters of A-Z a-z 0-9 _ -`).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const present = ['actions', 'actionHandler', 'actionRef'].filter((key) => value[key as 'actions'] !== undefined).length;
    if (present !== 0 && present !== 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'actions, actionHandler and actionRef must be provided together (all three or none)',
      });
    }
    if (value.actions && new Set(value.actions.map((a) => a.id)).size !== value.actions.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'action ids must be unique' });
    }
  });

export interface NotificationsRoutesDeps {
  manager: NotificationManager;
  /** Minimal registry seam: resolve a session's runtime + path. */
  sessionRegistry: {
    get(sessionId: string): Promise<{ sdkType: string; path?: string } | undefined | null>;
  };
  /** The server's registered action handlers (CHANNEL.md §7): a caller names one, never a command. */
  actionHandlers: ActionHandlerRegistry;
}

export function createNotificationsRoutes(deps: NotificationsRoutesDeps) {
  const { manager, sessionRegistry, actionHandlers } = deps;

  async function resolveVisibleEntry(sessionId: string): Promise<{ sdkType: string; path?: string } | undefined> {
    return (await sessionRegistry.get(sessionId)) ?? undefined;
  }

  async function resolveCanonicalId(sessionId: string): Promise<string> {
    const entry = await resolveVisibleEntry(sessionId);
    return entry
      ? canonicalOptInId(entry.sdkType as NotificationRuntime, sessionId, entry.path ?? sessionId)
      : sessionId;
  }

  /** POST /api/v1/sessions/:id/notifications/opt-in */
  async function handleOptIn(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const entry = await resolveVisibleEntry(sessionId).catch(() => undefined);
    if (!entry) {
      logger.warn(`opt-in requested for unknown or Internal API-invisible session: ${sessionId} (registry/UI mismatch)`);
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, `Session not found: ${sessionId}`));
      return;
    }
    const runtime = entry.sdkType;
    if (!isNotificationRuntime(runtime)) {
      logger.warn(`opt-in requested for session ${sessionId} with unsupported runtime: ${String(runtime)}`);
      sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, `Unsupported runtime: ${String(runtime)}`));
      return;
    }
    const parsed = optInBodySchema.safeParse((await readBoundedJsonBody(req, { maxBytes: 32 * 1024 })) ?? {});
    if (!parsed.success) {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, parsed.error.issues[0]?.message ?? 'invalid request body'));
      return;
    }
    const sessionPath = entry.path ?? sessionId;
    // Normalize to the canonical opt-in identity (Pi: bare uuid from the path)
    // so Internal-API opt-ins and browser opt-ins land under the same key.
    const canonicalId = canonicalOptInId(runtime, sessionId, sessionPath);
    const record: OptInRecord = {
      sessionId: canonicalId,
      runtime: runtime as NotificationRuntime,
      sessionPath,
      optedInAt: new Date().toISOString(),
      label: parsed.data.label,
      access: 'internal',
    };
    const accepted = await manager.optIn(record);
    if (accepted === false) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session is not available for Internal API notifications'));
      return;
    }
    sendJson(res, 200, {
      status: 'ok',
      optIn: { sessionId: canonicalId, runtime: record.runtime, label: record.label, optedInAt: record.optedInAt },
    });
  }

  /** DELETE /api/v1/sessions/:id/notifications/opt-in */
  async function handleOptOut(_req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    try {
      await manager.optOut(await resolveCanonicalId(sessionId));
      sendJson(res, 200, { status: 'ok', optIn: null });
    } catch (error) {
      logger.errorObject('notification opt-out identity lookup failed', error, { sessionId });
      sendJson(res, 503, enrichedErrorBody(ErrorCode.RUNTIME_UNAVAILABLE, 'Notification identity lookup is temporarily unavailable.'));
    }
  }

  /** GET /api/v1/sessions/:id/notifications */
  async function handleGetSessionState(_req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    try {
      const canonicalId = await resolveCanonicalId(sessionId);
      sendJson(res, 200, {
        status: 'ok',
        optIn: manager.getOptIn(canonicalId) ?? null,
        deliveries: manager.listDeliveriesForSession(canonicalId),
      });
    } catch (error) {
      logger.errorObject('notification state identity lookup failed', error, { sessionId });
      sendJson(res, 503, enrichedErrorBody(ErrorCode.RUNTIME_UNAVAILABLE, 'Notification identity lookup is temporarily unavailable.'));
    }
  }

  /** POST /api/v1/notifications */
  async function handleExplicitNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = explicitBodySchema.safeParse((await readBoundedJsonBody(req, { maxBytes: 32 * 1024 })) ?? {});
    if (!parsed.success) {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, parsed.error.issues[0]?.message ?? 'invalid request body'));
      return;
    }
    if (parsed.data.actionHandler !== undefined && !actionHandlers.has(parsed.data.actionHandler)) {
      sendJson(
        res,
        400,
        enrichedErrorBody(
          ErrorCode.INVALID_REQUEST,
          `actionHandler must be a registered handler (registered: ${actionHandlers.names().join(', ')})`,
        ),
      );
      return;
    }
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, 'Idempotency-Key must be 1-128 safe ASCII characters.'));
      return;
    }

    try {
      const accepted = await manager.acceptExplicit(parsed.data, idempotencyKey);
      const statusUrl = `/api/v1/notifications/${accepted.notification.id}`;
      res.setHeader('Location', statusUrl);
      sendJson(res, 202, {
        status: 'accepted',
        duplicate: accepted.duplicate,
        notification: {
          id: accepted.notification.id,
          createdAt: accepted.notification.createdAt,
        },
        statusUrl,
      });
    } catch (error) {
      if (error instanceof NotificationIdempotencyConflictError) {
        sendJson(res, 409, enrichedErrorBody(ErrorCode.IDEMPOTENCY_KEY_CONFLICT, error.message));
        return;
      }
      logger.errorObject('explicit notification acceptance failed', error);
      sendJson(res, 500, enrichedErrorBody(ErrorCode.INTERNAL_ERROR, 'Failed to persist notification.'));
    }
  }

  /** GET /api/v1/notifications/:notificationId */
  async function handleGetDeliveryStatus(
    _req: IncomingMessage,
    res: ServerResponse,
    notificationId: string,
  ): Promise<void> {
    const delivery = manager.getDeliveryStatus(notificationId);
    if (!delivery) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.NOT_FOUND, `Notification not found: ${notificationId}`));
      return;
    }
    sendJson(res, 200, { status: 'ok', delivery });
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

  return {
    handleOptIn,
    handleOptOut,
    handleGetSessionState,
    handleExplicitNotify,
    handleGetDeliveryStatus,
    handleGetRecentDeliveries,
  };
}

function isSafeDeepLink(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
