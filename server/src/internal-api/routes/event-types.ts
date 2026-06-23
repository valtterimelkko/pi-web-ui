/**
 * Internal API: Event-Type Registry Route (Task 12)
 *
 *   GET /api/v1/events/types  — machine-readable catalogue of the normalized
 *   event kinds emitted on the `/events` SSE stream.
 *
 * Authed identically to other internal-api routes. Additive — no existing
 * endpoint changed. The registry is derived from SSE_EVENT_TYPES so it cannot
 * drift from the stream (see ../event-types.ts).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { EVENT_TYPE_REGISTRY } from '../event-types.js';

export function createEventTypesRoutes() {
  async function handleGetEventTypes(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    sendJson(res, 200, { eventTypes: EVENT_TYPE_REGISTRY });
  }

  return { handleGetEventTypes };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
