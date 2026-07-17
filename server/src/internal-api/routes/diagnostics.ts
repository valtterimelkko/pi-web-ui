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
import { getOperationalMetrics, type OperationalMetrics } from '../../observability/operational-metrics.js';
import type { SessionRuntime } from '../types.js';

const VALID_LEVELS: ReadonlySet<string> = new Set(['error', 'warn', 'info', 'debug']);

interface ParsedDiagnosticsQuery {
  limit?: number;
  minLevel?: LogLevel;
  sessionId?: string;
  requestId?: string;
  runId?: string;
  runtime?: string;
  component?: string;
  since?: string;
}

function parseQuery(q: URLSearchParams): ParsedDiagnosticsQuery {
  const out: ParsedDiagnosticsQuery = {};
  const limitRaw = q.get('limit');
  if (limitRaw !== null) {
    const n = parseInt(limitRaw, 10);
    if (Number.isFinite(n)) out.limit = n;
  }
  const levelRaw = q.get('minLevel');
  if (levelRaw !== null && VALID_LEVELS.has(levelRaw)) out.minLevel = levelRaw as LogLevel;
  for (const key of ['sessionId', 'requestId', 'runId', 'runtime', 'component', 'since'] as const) {
    const value = q.get(key)?.trim();
    if (value) out[key] = value;
  }
  return out;
}

interface DiagnosticsRoutesDeps {
  metrics?: OperationalMetrics;
  sessionRegistry?: {
    listAll(): Promise<Array<{ sdkType: string; status: string }>>;
  };
  workerSummary?: () => unknown;
}

export function createDiagnosticsRoutes(deps: DiagnosticsRoutesDeps = {}) {
  const metrics = deps.metrics ?? getOperationalMetrics();

  async function operationalSnapshot() {
    const entries = await deps.sessionRegistry?.listAll().catch(() => []) ?? [];
    const byRuntime: Record<SessionRuntime, number> = { pi: 0, claude: 0, opencode: 0, antigravity: 0 };
    const byStatus = { running: 0, idle: 0, error: 0 };
    for (const entry of entries) {
      if (entry.sdkType in byRuntime) byRuntime[entry.sdkType as SessionRuntime] += 1;
      if (entry.status in byStatus) byStatus[entry.status as keyof typeof byStatus] += 1;
    }
    return {
      ...metrics.snapshot(),
      sessions: { total: entries.length, byRuntime, byStatus },
      ...(deps.workerSummary ? { workers: deps.workerSummary() } : {}),
    };
  }

  async function handleGetDiagnostics(
    _req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    const q = parseQuery(query);
    sendJson(res, 200, {
      recentLogs: getRecentLogs(q),
      recentErrors: getRecentErrors(q),
      summary: getDiagnosticsSummary(q),
      operational: await operationalSnapshot(),
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
      recentErrors: getRecentErrors({ ...q, sessionId }),
      summary: getDiagnosticsSummary({ ...q, sessionId }),
      operational: await operationalSnapshot(),
    });
  }

  return { handleGetDiagnostics, handleGetSessionDiagnostics };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
