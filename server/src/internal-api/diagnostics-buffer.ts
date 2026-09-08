/**
 * In-memory ring buffer of recent structured log records for the
 * `GET /api/v1/diagnostics` and `GET /api/v1/sessions/:id/diagnostics` endpoints.
 *
 * Pure data + accessors: the server wires the central logger's tap to
 * {@link pushDiagnosticsRecord} (see internal-api/server.ts). This module has no
 * import-time side effects, so importing it in tests never disturbs the logger's
 * tap slot.
 *
 * Every record is secret-scrubbed BEFORE it enters the buffer, so the buffer
 * itself (and therefore the diagnostics response) never contains tokens,
 * passwords, or bearer credentials — even under a memory dump.
 */

import { randomUUID } from 'node:crypto';
import type { DiagnosticsRetention } from './types.js';
import type { LogLevel } from '../config.js';
import { getLogTapFailures, type LogRecord } from '../logging/logger.js';
import { safeLogRecord } from '../logging/safe-record.js';

const MAX_RECORDS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const processInstanceId = randomUUID();
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const buffer: LogRecord[] = [];
const recordBytes: number[] = [];
let retainedBytes = 0;
let evictedRecords = 0;
let truncatedRecords = 0;
let insertionFailures = 0;

// ─── Secret scrubbing ────────────────────────────────────────────────────────

/** Both normal logging and direct insertions share the same bounded projection. */
export function scrubRecord(record: LogRecord): LogRecord {
  return safeLogRecord(record);
}

// ─── Buffer API ──────────────────────────────────────────────────────────────

/** Add a (scrubbed) record to the ring buffer. Called by the logger tap. */
export function pushDiagnosticsRecord(record: LogRecord): void {
  try {
    const safe = scrubRecord(record);
    const bytes = Buffer.byteLength(JSON.stringify(safe));
    buffer.push(safe);
    recordBytes.push(bytes);
    retainedBytes += bytes;
    if ((safe.logSafety as { truncated?: boolean } | undefined)?.truncated) truncatedRecords++;
    while (buffer.length > MAX_RECORDS || retainedBytes > MAX_BYTES) {
      buffer.shift();
      retainedBytes -= recordBytes.shift() ?? 0;
      evictedRecords++;
    }
  } catch {
    // Never recurse through the logger when diagnostic insertion itself fails.
    insertionFailures++;
  }
}

export interface DiagnosticsQuery {
  sessionId?: string;
  requestId?: string;
  runId?: string;
  runtime?: string;
  component?: string;
  /** Inclusive ISO timestamp lower bound. Invalid timestamps match no records. */
  since?: string;
  limit?: number;
  minLevel?: LogLevel;
}

function filteredRecords(query: DiagnosticsQuery): LogRecord[] {
  const minOrder = query.minLevel ? LEVEL_ORDER[query.minLevel] : undefined;
  let recs = buffer;
  if (query.sessionId) recs = recs.filter((r) => r.sessionId === query.sessionId);
  if (query.requestId) recs = recs.filter((r) => r.requestId === query.requestId);
  if (query.runId) recs = recs.filter((r) => r.runId === query.runId);
  if (query.runtime) recs = recs.filter((r) => r.runtime === query.runtime);
  if (query.component) recs = recs.filter((r) => r.component === query.component);
  if (query.since) {
    const sinceMs = Date.parse(query.since);
    recs = Number.isFinite(sinceMs)
      ? recs.filter((r) => Date.parse(r.ts) >= sinceMs)
      : [];
  }
  if (minOrder !== undefined) recs = recs.filter((r) => LEVEL_ORDER[r.level] <= minOrder);
  return recs;
}

/** Recent records, optionally filtered by correlation, source, time, and level. */
export function getRecentLogs(query: DiagnosticsQuery = {}): LogRecord[] {
  const limit = clamp(query.limit ?? 200, 1, MAX_RECORDS);
  return filteredRecords(query).slice(-limit).map(record => structuredClone(record));
}

/** Recent error-level records using the same filters as the main log list. */
export function getRecentErrors(query: DiagnosticsQuery = {}): LogRecord[] {
  const limit = clamp(query.limit ?? 50, 1, MAX_RECORDS);
  return filteredRecords(query).filter((r) => r.level === 'error').slice(-limit).map(record => structuredClone(record));
}

export interface DiagnosticsSummary {
  bufferedRecords: number;
  errorCount: number;
  warnCount: number;
  oldestTs?: string;
  newestTs?: string;
  /** Global retained window/loss, deliberately separate from filtered counts. */
  retention: DiagnosticsRetention;
}

export function getDiagnosticsSummary(query: DiagnosticsQuery = {}): DiagnosticsSummary {
  const recs = filteredRecords(query);
  return {
    bufferedRecords: recs.length,
    errorCount: recs.filter((r) => r.level === 'error').length,
    warnCount: recs.filter((r) => r.level === 'warn').length,
    oldestTs: recs[0]?.ts,
    newestTs: recs[recs.length - 1]?.ts,
    retention: { processInstanceId, processStartedAt, retainedRecords: buffer.length, retainedBytes,
      maxRecords: MAX_RECORDS, maxBytes: MAX_BYTES, evictedRecords, truncatedRecords, insertionFailures, tapFailures: getLogTapFailures(),
      oldestTs: buffer[0]?.ts, newestTs: buffer[buffer.length - 1]?.ts,
    },
  };
}

/** Clear the buffer (test helper). */
export function clearDiagnosticsBuffer(): void {
  buffer.length = 0;
  recordBytes.length = 0;
  retainedBytes = 0;
  evictedRecords = 0;
  truncatedRecords = 0;
  insertionFailures = 0;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
