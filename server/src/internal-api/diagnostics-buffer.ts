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

import type { LogLevel } from '../config.js';
import type { LogRecord } from '../logging/logger.js';

const MAX_RECORDS = 1000;
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const buffer: LogRecord[] = [];

// ─── Secret scrubbing ────────────────────────────────────────────────────────

const SENSITIVE_KEY_RE =
  /^(pass(word|wd)?|secret|secrets|token|tokens|api[_-]?key|apikey|authToken|authorization|auth|cookie|cookies|bearer|credential|credentials)$/i;

const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, // Authorization: Bearer <token>
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google API keys
  /\bxox[bpoa]-[A-Za-z0-9-]{10,}/g, // Slack tokens
];

function scrubString(value: string): string {
  let out = value;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

function scrubValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrubValue(v, k);
  }
  return out;
}

/** Return a deep-cloned copy of `record` with secrets redacted. */
export function scrubRecord(record: LogRecord): LogRecord {
  return scrubValue(record) as LogRecord;
}

// ─── Buffer API ──────────────────────────────────────────────────────────────

/** Add a (scrubbed) record to the ring buffer. Called by the logger tap. */
export function pushDiagnosticsRecord(record: LogRecord): void {
  buffer.push(scrubRecord(record));
  if (buffer.length > MAX_RECORDS) {
    buffer.splice(0, buffer.length - MAX_RECORDS);
  }
}

export interface DiagnosticsQuery {
  sessionId?: string;
  limit?: number;
  minLevel?: LogLevel;
}

/** Recent records, optionally filtered by session and/or minimum level. */
export function getRecentLogs(query: DiagnosticsQuery = {}): LogRecord[] {
  const limit = clamp(query.limit ?? 200, 1, MAX_RECORDS);
  const minOrder = query.minLevel ? LEVEL_ORDER[query.minLevel] : undefined;
  let recs = buffer;
  if (query.sessionId) recs = recs.filter((r) => r.sessionId === query.sessionId);
  if (minOrder !== undefined) recs = recs.filter((r) => LEVEL_ORDER[r.level] <= minOrder);
  return recs.slice(-limit);
}

/** Recent error-level records (optionally per session). */
export function getRecentErrors(query: { sessionId?: string; limit?: number } = {}): LogRecord[] {
  const limit = clamp(query.limit ?? 50, 1, MAX_RECORDS);
  let recs = buffer.filter((r) => r.level === 'error');
  if (query.sessionId) recs = recs.filter((r) => r.sessionId === query.sessionId);
  return recs.slice(-limit);
}

export interface DiagnosticsSummary {
  bufferedRecords: number;
  errorCount: number;
  warnCount: number;
  oldestTs?: string;
  newestTs?: string;
}

export function getDiagnosticsSummary(query: { sessionId?: string } = {}): DiagnosticsSummary {
  const recs = query.sessionId ? buffer.filter((r) => r.sessionId === query.sessionId) : buffer;
  return {
    bufferedRecords: recs.length,
    errorCount: recs.filter((r) => r.level === 'error').length,
    warnCount: recs.filter((r) => r.level === 'warn').length,
    oldestTs: recs[0]?.ts,
    newestTs: recs[recs.length - 1]?.ts,
  };
}

/** Clear the buffer (test helper). */
export function clearDiagnosticsBuffer(): void {
  buffer.length = 0;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
