/**
 * Central logger for the Pi Web UI server runtime.
 *
 * Replaces the ~330 ad-hoc `console.*` calls with one greppable, level- and
 * namespace-filterable log shape. Designed so the migration from `console.*`
 * is mechanical (`console.log(x)` → `logger.info(x)`) while gaining:
 *
 * - **Levels** (`LOG_LEVEL=error|warn|info|debug`, default info) — see ../config.ts.
 * - **Namespaces** (`DEBUG=claude,opencode*`) — a component allowlist; when set,
 *   only matching components emit. Unset = all components per LOG_LEVEL.
 * - **Format** (`LOG_FORMAT=pretty|json`, default pretty) — pretty keeps the
 *   human `[Component] msg` convention; json emits one parseable object/line.
 * - **Correlation** — every line is stamped with the current request/session id
 *   from the AsyncLocalStorage correlation context (see ./correlation.ts).
 *
 * Emission rule (deterministic, no surprises):
 *   shouldEmit(component, level) =
 *     (!namespaces.active || namespaces.isEnabled(component))
 *     && levelOrder(level) <= levelOrder(configuredLevel)
 *
 * Pretty rendering preserves existing output for tagged messages: if the
 * formatted message already begins with `[…]` it is emitted unchanged; otherwise
 * `[Component] ` is prepended. This keeps the 330 existing `[Tag] …` lines
 * byte-identical after migration.
 */

import { format } from 'node:util';
import {
  config,
  type LogLevel,
  type LogFormat,
  type DebugNamespaceFilter,
} from '../config.js';
import { getCorrelationContext, type LogContext } from './correlation.js';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Inactive namespace filter used when no `DEBUG` config is available (e.g. when
 * a test mocks `config` partially). "Allow all components per LOG_LEVEL." A plain
 * literal (not derived from config) so it never depends on a possibly-mocked
 * config export at module-eval time.
 */
const INACTIVE_NAMESPACES: DebugNamespaceFilter = {
  active: false,
  patterns: [],
  isEnabled: () => true,
};

// ─── Structured record (also consumed by the diagnostics tap, Task 10) ────────

export interface LogRecordError {
  name: string;
  message: string;
  stack?: string;
}

export interface LogRecord {
  /** ISO timestamp. */
  ts: string;
  level: LogLevel;
  component: string;
  /** Human message (leading `[Component] ` stripped when it matches). */
  msg: string;
  requestId?: string;
  sessionId?: string;
  runtime?: string;
  error?: LogRecordError;
  [key: string]: unknown;
}

// ─── Diagnostic tap (Task 10 wires an in-memory ring buffer here) ─────────────

export type LogTap = (record: LogRecord) => void;

/**
 * The tap lives on `globalThis` (not module scope) so it is shared across every
 * instantiation of this module. Vitest can load the logger under different import
 * specifiers (test path vs app path); module-scoped state would split into
 * per-instance copies, so a tap registered from a test (or by the diagnostics
 * ring buffer) would not see the app code's emits. globalThis keeps one source of
 * truth.
 */
const G = (globalThis as unknown as { __PIWEBUI_LOGGER__?: { tap: LogTap | null } });
if (!G.__PIWEBUI_LOGGER__) G.__PIWEBUI_LOGGER__ = { tap: null };
const loggerGlobals = G.__PIWEBUI_LOGGER__;

/**
 * Register a single global tap that receives every emitted {@link LogRecord}
 * (post-level/namespace filtering, pre-rendering). Used by the diagnostics
 * endpoint ring buffer and by tests asserting on log output. Passing `null`
 * unregisters.
 */
export function setLogTap(tap: LogTap | null): void {
  loggerGlobals.tap = tap;
}

// ─── Logger ──────────────────────────────────────────────────────────────────

export interface LoggerOptions {
  component: string;
  level?: LogLevel;
  namespaces?: DebugNamespaceFilter;
  format?: LogFormat;
  /** Output sink. Default: stdout for info/debug, stderr for warn/error. */
  sink?: (line: string, level: LogLevel) => void;
  /** Clock for timestamps (test seam). Default: real time. */
  clock?: () => Date;
  /** Fixed fields merged into every record (from child()). */
  boundContext?: Record<string, unknown>;
}

export interface Logger {
  readonly component: string;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  /** Log an error object with message + stack + context (Task 8 helper). */
  errorObject(message: string, err: unknown, context?: Record<string, unknown>): void;
  /** Bind fixed fields to every subsequent line from this logger. */
  child(context: Record<string, unknown>): Logger;
  /** Test seam: would this level currently be emitted for this component? */
  isLevelEnabled(level: LogLevel): boolean;
}

export function createLogger(component: string, options?: Partial<LoggerOptions>): Logger {
  // Defensive defaults: config may be mocked partially in tests (missing the
  // logging fields), so never crash if a field is absent — degrade to the safe
  // production default (info / no namespace filter / pretty).
  const level: LogLevel = options?.level ?? config.logLevel ?? 'info';
  const namespaces: DebugNamespaceFilter = options?.namespaces ?? config.debugNamespaces ?? INACTIVE_NAMESPACES;
  const formatMode: LogFormat = options?.format ?? config.logFormat ?? 'pretty';
  // Resolve the default sink lazily at emit time (not creation time) so the
  // env-based test silencing inside realDefaultSink is honoured by loggers that
  // were created without an explicit sink.
  const sink: (line: string, level: LogLevel) => void =
    options?.sink ?? ((line, lvl) => realDefaultSink(line, lvl));
  const clock: () => Date = options?.clock ?? (() => new Date());
  const boundContext: Record<string, unknown> = options?.boundContext ?? {};

  function isLevelEnabled(msgLevel: LogLevel): boolean {
    if (namespaces.active && !namespaces.isEnabled(component)) return false;
    return LEVEL_ORDER[msgLevel] <= LEVEL_ORDER[level];
  }

  function emit(msgLevel: LogLevel, args: unknown[], explicitContext?: Record<string, unknown>): void {
    if (!isLevelEnabled(msgLevel)) return;

    const correlation = getCorrelationContext() ?? {};
    const errArg = args.find((a) => a instanceof Error) as Error | undefined;

    const rawMsg = format(...args);
    const msg = stripComponentPrefix(rawMsg, component);

    const record: LogRecord = {
      ts: clock().toISOString(),
      level: msgLevel,
      component,
      msg,
      ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
      ...(correlation.sessionId ? { sessionId: correlation.sessionId } : {}),
      ...(correlation.runtime ? { runtime: correlation.runtime } : {}),
      ...(errArg
        ? { error: { name: errArg.name, message: errArg.message, stack: errArg.stack } }
        : {}),
      ...boundContext,
      ...(explicitContext ?? {}),
    };

    // Notify the diagnostics tap (if registered) with the structured record.
    try {
      loggerGlobals.tap?.(record);
    } catch {
      // A tap failure must never break logging.
    }

    const line = formatMode === 'json' ? renderJson(record, rawMsg) : renderPretty(record, rawMsg);
    sink(line, msgLevel);
  }

  return {
    component,
    error: (...a: unknown[]) => emit('error', a),
    warn: (...a: unknown[]) => emit('warn', a),
    info: (...a: unknown[]) => emit('info', a),
    debug: (...a: unknown[]) => emit('debug', a),
    errorObject: (message: string, err: unknown, context?: Record<string, unknown>) => {
      const wrapped =
        err instanceof Error
          ? err
          : new Error(typeof err === 'string' ? err : format(err));
      emit('error', [`${message}:`, wrapped], context);
    },
    child: (ctx: Record<string, unknown>) =>
      createLogger(component, {
        level,
        namespaces,
        format: formatMode,
        sink,
        clock,
        boundContext: { ...boundContext, ...ctx },
      }),
    isLevelEnabled,
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** Remove a leading `[component] ` from a message when it matches (for clean JSON). */
function stripComponentPrefix(msg: string, component: string): string {
  const prefix = `[${component}] `;
  if (msg.startsWith(prefix)) return msg.slice(prefix.length);
  return msg;
}

function renderPretty(record: LogRecord, rawMsg: string): string {
  // Preserve existing tagged output: if the raw message begins with `[`, keep
  // it verbatim; otherwise prepend `[Component] `.
  const body = rawMsg.startsWith('[') ? rawMsg : `[${record.component}] ${rawMsg}`;
  const corr = correlationSuffix(record);
  return `${body}${corr}`;
}

function renderJson(record: LogRecord, _rawMsg: string): string {
  return JSON.stringify(record);
}

function correlationSuffix(record: LogRecord): string {
  const parts: string[] = [];
  if (record.requestId) parts.push(`req=${record.requestId}`);
  if (record.sessionId) parts.push(`sid=${record.sessionId}`);
  if (record.runtime) parts.push(`rt=${record.runtime}`);
  return parts.length ? ` [${parts.join(' ')}]` : '';
}

// ─── Default sink ────────────────────────────────────────────────────────────

/**
 * Write a rendered log line to the conventional stream: error/warn → stderr
 * (matches console.error/console.warn), info/debug → stdout. Exported so the
 * routing can be unit-tested in isolation.
 */
export function writeToStreamSink(line: string, level: LogLevel): void {
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line.endsWith('\n') ? line : line + '\n');
}

/**
 * Default sink. During tests (Vitest sets `process.env.VITEST='true'`), app log
 * output is silenced unless `VITEST_LOG=1` so a failing test shows the assertion
 * rather than hundreds of `[Component] …` lines. The env check is shared across
 * module instantiations, so it reliably silences the app code's logger too.
 */
function realDefaultSink(line: string, level: LogLevel): void {
  if (process.env.VITEST === 'true' && process.env.VITEST_LOG !== '1') return;
  writeToStreamSink(line, level);
}

export type { LogContext };
