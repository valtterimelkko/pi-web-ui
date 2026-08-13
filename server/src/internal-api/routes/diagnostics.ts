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
import type { LogRecord } from '../../logging/logger.js';

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
    listAll(): Promise<Array<{ id?: string; sdkType: string; status: string }>>;
  };
  /** Returns true only for sessions exposed through the Internal API shadow path. */
  isVisibleSession?: (sessionId: string) => Promise<boolean>;
  workerSummary?: () => unknown;
}

export function createDiagnosticsRoutes(deps: DiagnosticsRoutesDeps = {}) {
  const metrics = deps.metrics ?? getOperationalMetrics();

  async function operationalSnapshot() {
    const entries = await deps.sessionRegistry?.listAll().catch(() => []) ?? [];
    const byRuntime: Record<SessionRuntime, number> = { pi: 0, claude: 0, opencode: 0, antigravity: 0, commandcode: 0 };
    const byStatus = { running: 0, idle: 0, error: 0 };
    const visibleEntries = deps.isVisibleSession
      ? (await Promise.all(entries.map(async (entry) => entry.id && await deps.isVisibleSession!(entry.id) ? entry : undefined))).filter((entry): entry is typeof entries[number] => entry !== undefined)
      : entries.filter((entry) => entry.sdkType !== 'commandcode');
    for (const entry of visibleEntries) {
      if (entry.sdkType in byRuntime) byRuntime[entry.sdkType as SessionRuntime] += 1;
      if (entry.status in byStatus) byStatus[entry.status as keyof typeof byStatus] += 1;
    }
    return {
      ...metrics.snapshot(),
      sessions: { total: visibleEntries.length, byRuntime, byStatus },
      ...(deps.workerSummary ? { workers: deps.workerSummary() } : {}),
    };
  }

  async function visibleSessionContext(): Promise<Set<string> | undefined> {
    if (!deps.isVisibleSession || !deps.sessionRegistry) return undefined;
    const entries = await deps.sessionRegistry.listAll().catch(() => []);
    const visibleIds = new Set<string>();
    await Promise.all(entries.map(async (entry) => {
      if (entry.id && await deps.isVisibleSession!(entry.id)) visibleIds.add(entry.id);
    }));
    return visibleIds;
  }

  function isVisibleDiagnosticRecord(record: LogRecord, visibleIds: Set<string> | undefined): boolean {
    if (!visibleIds) return record.runtime !== 'commandcode';
    // Any session-correlated record must resolve to an Internal API-visible
    // registry entry. This also fails closed when a browser Command Code
    // registry projection was removed during a policy change or restart.
    if (record.sessionId) return visibleIds.has(record.sessionId);
    // Unscoped Command Code records are never safe to expose. Other runtime
    // logs remain process-level operational evidence.
    return record.runtime !== 'commandcode';
  }

  function diagnosticView(query: ParsedDiagnosticsQuery, records: LogRecord[], visibleIds: Set<string> | undefined): {
    recentLogs: LogRecord[];
    recentErrors: LogRecord[];
    summary: ReturnType<typeof getDiagnosticsSummary>;
  } {
    const logLimit = clampLimit(query.limit, 200);
    const errorLimit = clampLimit(query.limit, 50);
    const visibleRecords = records.filter((record) => isVisibleDiagnosticRecord(record, visibleIds));
    const errors = visibleRecords.filter((record) => record.level === 'error');
    return {
      recentLogs: visibleRecords.slice(-logLimit),
      recentErrors: errors.slice(-errorLimit),
      summary: {
        bufferedRecords: visibleRecords.length,
        errorCount: errors.length,
        warnCount: visibleRecords.filter((record) => record.level === 'warn').length,
        oldestTs: visibleRecords[0]?.ts,
        newestTs: visibleRecords[visibleRecords.length - 1]?.ts,
      },
    };
  }

  async function buildDiagnosticView(query: ParsedDiagnosticsQuery) {
    const sessionContext = await visibleSessionContext();
    // The ring buffer is bounded to 1000 records, so this retrieves the
    // complete filtered candidate set before applying visibility and output
    // limits. This keeps summary counts truthful after redaction.
    const records = getRecentLogs({ ...query, limit: 1000 });
    return diagnosticView(query, records, sessionContext);
  }

  async function handleGetDiagnostics(
    _req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    const view = await buildDiagnosticView(parseQuery(query));
    sendJson(res, 200, { ...view, operational: await operationalSnapshot() });
  }

  async function handleGetSessionDiagnostics(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    query: URLSearchParams,
  ): Promise<void> {
    if (deps.isVisibleSession && !(await deps.isVisibleSession(sessionId))) {
      sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }
    const view = await buildDiagnosticView({ ...parseQuery(query), sessionId });
    sendJson(res, 200, { sessionId, ...view, operational: await operationalSnapshot() });
  }

  return { handleGetDiagnostics, handleGetSessionDiagnostics };
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(1, Math.floor(value as number)));
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
