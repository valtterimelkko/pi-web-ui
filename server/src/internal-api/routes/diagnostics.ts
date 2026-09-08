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
import type { SessionRuntime, DiagnosticsResponseTruncation } from '../types.js';
import type { LogRecord } from '../../logging/logger.js';
import { ErrorCode } from '../error-codes.js';

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
    getLoadStatus?(): { state: string };
  };
  /** Returns true only for sessions exposed through the Internal API shadow path. */
  isVisibleSession?: (sessionId: string) => Promise<boolean>;
  workerSummary?: () => unknown;
}

export function createDiagnosticsRoutes(deps: DiagnosticsRoutesDeps = {}) {
  const metrics = deps.metrics ?? getOperationalMetrics();

  type Entry = { id?: string; sdkType: string; status: string };
  type Context = { entries: Entry[]; visibleIds?: Set<string>; sourceState: string; unavailable?: 'registry' | 'visibility' };

  async function readContext(): Promise<Context> {
    if (!deps.sessionRegistry) return { entries: [], sourceState: 'unconfigured' };
    let entries: Entry[];
    try { entries = await deps.sessionRegistry.listAll(); }
    catch { return { entries: [], visibleIds: new Set(), sourceState: 'unavailable', unavailable: 'registry' }; }
    const sourceState = deps.sessionRegistry.getLoadStatus?.().state === 'missing' ? 'missing' : 'available';
    try {
      const visiblePredicate = deps.isVisibleSession;
      const visible = visiblePredicate
        ? (await Promise.all(entries.map(async entry => entry.id && await visiblePredicate(entry.id) ? entry : undefined))).filter((entry): entry is Entry => entry !== undefined)
        : entries.filter(entry => entry.sdkType !== 'commandcode');
      return { entries: visible, sourceState,
        ...(deps.isVisibleSession ? { visibleIds: new Set(visible.flatMap(entry => entry.id ? [entry.id] : [])) } : {}),
      };
    } catch { return { entries: [], visibleIds: new Set(), sourceState, unavailable: 'visibility' }; }
  }

  function unavailable(res: ServerResponse, context: Context): boolean {
    if (!context.unavailable) return false;
    sendJson(res, 503, { code: ErrorCode.DIAGNOSTIC_SOURCE_UNAVAILABLE, error: 'Diagnostic source unavailable',
      sources: { registry: { state: context.sourceState }, ...(context.unavailable === 'visibility' ? { visibility: { state: 'unavailable' } } : {}) },
    });
    return true;
  }

  function operationalSnapshot(context: Context) {
    const byRuntime: Record<SessionRuntime, number> = { pi: 0, claude: 0, opencode: 0, antigravity: 0, commandcode: 0 };
    const byStatus = { running: 0, idle: 0, error: 0 };
    const visibleEntries = context.entries;
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
        retention: getDiagnosticsSummary().retention,
        bufferedRecords: visibleRecords.length,
        errorCount: errors.length,
        warnCount: visibleRecords.filter((record) => record.level === 'warn').length,
        oldestTs: visibleRecords[0]?.ts,
        newestTs: visibleRecords[visibleRecords.length - 1]?.ts,
      },
    };
  }

  function buildDiagnosticView(query: ParsedDiagnosticsQuery, context: Context) {
    const sessionContext = context.visibleIds;
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
    const context = await readContext();
    if (unavailable(res, context)) return;
    const view = buildDiagnosticView(parseQuery(query), context);
    sendDiagnosticJson(res, { ...view, sources: { registry: { state: context.sourceState } }, operational: operationalSnapshot(context) });
  }

  async function handleGetSessionDiagnostics(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    query: URLSearchParams,
  ): Promise<void> {
    const context = await readContext();
    if (unavailable(res, context)) return;
    if (deps.isVisibleSession && !(await deps.isVisibleSession(sessionId))) {
      sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }
    const view = buildDiagnosticView({ ...parseQuery(query), sessionId }, context);
    sendDiagnosticJson(res, { sessionId, ...view, sources: { registry: { state: context.sourceState } }, operational: operationalSnapshot(context) });
  }

  return { handleGetDiagnostics, handleGetSessionDiagnostics };
}

const MAX_DIAGNOSTICS_RESPONSE_BYTES = 1024 * 1024;

function sendDiagnosticJson(res: ServerResponse, payload: Record<string, unknown> & {
  recentLogs: LogRecord[]; recentErrors: LogRecord[];
}): void {
  const encoded = JSON.stringify(payload);
  let bytes = Buffer.byteLength(encoded);
  if (bytes <= MAX_DIAGNOSTICS_RESPONSE_BYTES) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(encoded);
    return;
  }
  const counts: DiagnosticsResponseTruncation = { omittedLogs: 0, omittedErrors: 0, limitBytes: MAX_DIAGNOSTICS_RESPONSE_BYTES };
  // Reserve the largest possible loss-marker encoding once. Each removed
  // record is sized once; never repeatedly stringify the whole response.
  bytes += Buffer.byteLength(JSON.stringify({ responseTruncation: {
    ...counts, omittedLogs: payload.recentLogs.length, omittedErrors: payload.recentErrors.length,
  } }));
  while (bytes > MAX_DIAGNOSTICS_RESPONSE_BYTES) {
    const logsRemain = counts.omittedLogs < payload.recentLogs.length;
    const errorsRemain = counts.omittedErrors < payload.recentErrors.length;
    if (!logsRemain && !errorsRemain) {
      sendJson(res, 500, { code: ErrorCode.INTERNAL_ERROR, error: 'Diagnostics metadata exceeds response byte budget' });
      return;
    }
    const removeLog = logsRemain && (!errorsRemain || counts.omittedLogs <= counts.omittedErrors);
    const record = removeLog ? payload.recentLogs[counts.omittedLogs++] : payload.recentErrors[counts.omittedErrors++];
    bytes -= Buffer.byteLength(JSON.stringify(record));
    // Keeping comma bytes in the estimate is conservative, never underbudget.
  }
  sendJson(res, 200, { ...payload,
    recentLogs: payload.recentLogs.slice(counts.omittedLogs),
    recentErrors: payload.recentErrors.slice(counts.omittedErrors), responseTruncation: counts,
  });
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(1, Math.floor(value as number)));
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
