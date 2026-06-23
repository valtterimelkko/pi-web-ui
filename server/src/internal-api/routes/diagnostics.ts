/**
 * Internal API: Diagnostics Route (Task 10)
 *
 * Self-service observability over the same Unix socket agents already use:
 *   GET /api/v1/diagnostics                 — recent logs + errors + summary
 *   GET /api/v1/sessions/:id/diagnostics    — same, scoped to one session
 *
 * Authed identically to every other internal-api route (bearer token; only
 * /health is exempt). Additive — no existing endpoint changed. Responses contain
 * only secret-scrubbed records (see ../diagnostics-buffer.ts).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { LogLevel } from '../../config.js';
import {
  getRecentLogs,
  getRecentErrors,
  getDiagnosticsSummary,
} from '../diagnostics-buffer.js';

const VALID_LEVELS: ReadonlySet<string> = new Set(['error', 'warn', 'info', 'debug']);

function parseQuery(q: URLSearchParams): { limit?: number; minLevel?: LogLevel; sessionId?: string } {
  const out: { limit?: number; minLevel?: LogLevel; sessionId?: string } = {};
  const limitRaw = q.get('limit');
  if (limitRaw !== null) {
    const n = parseInt(limitRaw, 10);
    if (Number.isFinite(n)) out.limit = n;
  }
  const levelRaw = q.get('minLevel');
  if (levelRaw !== null && VALID_LEVELS.has(levelRaw)) out.minLevel = levelRaw as LogLevel;
  const sid = q.get('sessionId');
  if (sid) out.sessionId = sid;
  return out;
}

export function createDiagnosticsRoutes() {
  async function handleGetDiagnostics(
    _req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    const q = parseQuery(query);
    sendJson(res, 200, {
      recentLogs: getRecentLogs(q),
      recentErrors: getRecentErrors({ sessionId: q.sessionId, limit: q.limit }),
      summary: getDiagnosticsSummary({ sessionId: q.sessionId }),
    });
  }

  async function handleGetSessionDiagnostics(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    query: URLSearchParams,
  ): Promise<void> {
    const q = parseQuery(query);
    sendJson(res, 200, {
      sessionId,
      recentLogs: getRecentLogs({ ...q, sessionId }),
      recentErrors: getRecentErrors({ sessionId, limit: q.limit }),
      summary: getDiagnosticsSummary({ sessionId }),
    });
  }

  return { handleGetDiagnostics, handleGetSessionDiagnostics };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
