import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateHealthAlertThresholds, type HealthAlert, type HealthAlertThresholds } from './health-alerts.js';

/**
 * A2 telemetry configuration and alert delivery.
 *
 * Deliberately free of the logger and of `config.ts`: `config.ts` imports this
 * module, while `logging/logger.ts` imports `config.ts`, so importing the logger
 * here would close an import cycle and leave `createLogger` undefined.
 */

/** A2 alert delivery seam. Every implementation is fail-open (never throws out). */
export type HealthAlertSink = (alert: HealthAlert) => Promise<void> | void;

export interface HealthTelemetryConfig {
  enabled: boolean;
  /** Directory the size-bounded metrics time series is written to. */
  dir: string;
  intervalMs: number;
  maxFileBytes: number;
  maxFiles: number;
  thresholds: HealthAlertThresholds;
  sink: HealthAlertSink;
  /** Human-readable sink target, logged at startup (proves where alerts go). */
  sinkDescription: string;
  /** True when this process deliberately does not notify the operator. */
  suppressOperatorNotifications: boolean;
  /** Set when telemetry was disabled by a safety guard, for the startup log. */
  suppressedReason?: string;
}

export const DEFAULT_HEALTH_METRICS_INTERVAL_MS = 30_000;
export const DEFAULT_HEALTH_METRICS_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_HEALTH_METRICS_MAX_FILES = 5;
const DEFAULT_HEAP_ALERT_FRACTION = 0.85;
const DEFAULT_HEAP_RECOVER_FRACTION = 0.75;
const DEFAULT_LAG_ALERT_MS = 500;
const DEFAULT_LAG_RECOVER_MS = 200;
const INGRESS_RECORD_TTL_MS = 15 * 60 * 1000;

export function productionMetricsDir(): string {
  return path.join(os.homedir(), '.pi-web-ui', 'metrics');
}

/**
 * Where the metrics file lives.
 *
 * Production default is `~/.pi-web-ui/metrics`. A disposable validation server
 * must never write that path: with `PI_WEB_UI_VALIDATION_MODE=true` the default
 * moves inside the run's own record directory, so the A2 live proof and every
 * later validation run write their own file. An explicit absolute
 * `OBSERVABILITY_METRICS_DIR` always wins (and is additionally guarded in
 * `createHealthTelemetryConfig`).
 */
export function resolveObservabilityMetricsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OBSERVABILITY_METRICS_DIR?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('OBSERVABILITY_METRICS_DIR must be an absolute path.');
    return explicit;
  }
  if (env.PI_WEB_UI_VALIDATION_MODE === 'true') {
    const recordDir = env.PI_WEB_UI_VALIDATION_RECORD_DIR?.trim();
    if (recordDir && path.isAbsolute(recordDir)) return path.join(recordDir, 'metrics');
    return path.join(env.PI_WEB_UI_VALIDATION_DIR?.trim() || path.join(os.tmpdir(), 'pi-web-ui-validation'), 'metrics');
  }
  return productionMetricsDir();
}

function parseNonNegativeNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[1-9]\d*$/.test(raw.trim())) throw new Error(`${name} must be a positive integer.`);
  return Number(raw);
}

function parseRatio(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a fraction within (0, 1].`);
  }
  return value;
}

/** Heap + lag hysteresis bands. Fail-fast: a band that cannot be hysteretic is an error. */
export function resolveHealthAlertThresholds(env: NodeJS.ProcessEnv = process.env): HealthAlertThresholds {
  const thresholds: HealthAlertThresholds = {
    heapFractionHigh: parseRatio(env.OBSERVABILITY_HEALTH_ALERT_HEAP_FRACTION, DEFAULT_HEAP_ALERT_FRACTION, 'OBSERVABILITY_HEALTH_ALERT_HEAP_FRACTION'),
    heapFractionLow: parseRatio(env.OBSERVABILITY_HEALTH_ALERT_HEAP_RECOVER_FRACTION, DEFAULT_HEAP_RECOVER_FRACTION, 'OBSERVABILITY_HEALTH_ALERT_HEAP_RECOVER_FRACTION'),
    lagP99HighMs: parseNonNegativeNumber(env.OBSERVABILITY_HEALTH_ALERT_LAG_P99_MS, DEFAULT_LAG_ALERT_MS, 'OBSERVABILITY_HEALTH_ALERT_LAG_P99_MS'),
    lagP99LowMs: parseNonNegativeNumber(env.OBSERVABILITY_HEALTH_ALERT_LAG_RECOVER_MS, DEFAULT_LAG_RECOVER_MS, 'OBSERVABILITY_HEALTH_ALERT_LAG_RECOVER_MS'),
  };
  validateHealthAlertThresholds(thresholds);
  return thresholds;
}

function resolveNotificationsDir(env: NodeJS.ProcessEnv): string {
  // Mirrors config.notificationsDir; kept local so observability never imports
  // the config module (which would be an import cycle).
  return env.NOTIFICATIONS_DIR?.trim() || path.join(os.homedir(), '.pi-web-ui', 'notifications');
}

/** Resolves the alert sink from the environment (and the validation-mode default). */
function resolveAlertSink(env: NodeJS.ProcessEnv, metricsDir: string): {
  sink: HealthAlertSink;
  description: string;
  suppressOperatorNotifications: boolean;
} {
  const configured = env.OBSERVABILITY_HEALTH_ALERT_SINK?.trim();
  const validationMode = env.PI_WEB_UI_VALIDATION_MODE === 'true';

  if (configured === 'none') return { sink: createNoopAlertSink(), description: 'none', suppressOperatorNotifications: true };
  if (configured === 'notifications') {
    const ingressDir = path.join(resolveNotificationsDir(env), 'ingress');
    return { sink: createIngressAlertSink({ ingressDir }), description: `ingress:${ingressDir}`, suppressOperatorNotifications: false };
  }
  if (configured?.startsWith('file:')) {
    const filePath = configured.slice('file:'.length).trim();
    if (!path.isAbsolute(filePath)) throw new Error('OBSERVABILITY_HEALTH_ALERT_SINK file: target must be an absolute path.');
    return { sink: createFileAlertSink(filePath), description: `file:${filePath}`, suppressOperatorNotifications: true };
  }
  if (configured) {
    throw new Error(`OBSERVABILITY_HEALTH_ALERT_SINK must be 'none', 'notifications' or 'file:<absolute path>' (got '${configured}').`);
  }

  // Validation default: capture into the run directory. A disposable server
  // must never message the operator, and the capture file is the proof.
  if (validationMode) {
    const capturePath = path.join(metricsDir, 'alerts.jsonl');
    return { sink: createFileAlertSink(capturePath), description: `file:${capturePath}`, suppressOperatorNotifications: true };
  }

  const ingressDir = path.join(resolveNotificationsDir(env), 'ingress');
  return { sink: createIngressAlertSink({ ingressDir }), description: `ingress:${ingressDir}`, suppressOperatorNotifications: false };
}

/**
 * Builds the A2 telemetry configuration from the environment. Fail-fast on
 * invalid values; fail-closed (disabled, with a reason) when a validation
 * server is somehow pointed at the production metrics path.
 */
export function createHealthTelemetryConfig(env: NodeJS.ProcessEnv = process.env): HealthTelemetryConfig {
  const dir = resolveObservabilityMetricsDir(env);
  const enabledByEnv = env.OBSERVABILITY_METRICS_ENABLED !== 'false';
  const intervalMs = parsePositiveInteger(env.OBSERVABILITY_METRICS_INTERVAL_MS, DEFAULT_HEALTH_METRICS_INTERVAL_MS, 'OBSERVABILITY_METRICS_INTERVAL_MS');
  const maxFileBytes = parsePositiveInteger(env.OBSERVABILITY_METRICS_MAX_FILE_BYTES, DEFAULT_HEALTH_METRICS_MAX_FILE_BYTES, 'OBSERVABILITY_METRICS_MAX_FILE_BYTES');
  const maxFiles = parsePositiveInteger(env.OBSERVABILITY_METRICS_MAX_FILES, DEFAULT_HEALTH_METRICS_MAX_FILES, 'OBSERVABILITY_METRICS_MAX_FILES');
  const thresholds = resolveHealthAlertThresholds(env);
  const sink = resolveAlertSink(env, dir);

  if (env.PI_WEB_UI_VALIDATION_MODE === 'true' && path.resolve(dir) === path.resolve(productionMetricsDir())) {
    return {
      enabled: false,
      dir,
      intervalMs,
      maxFileBytes,
      maxFiles,
      thresholds,
      sink: createNoopAlertSink(),
      sinkDescription: 'none',
      suppressOperatorNotifications: true,
      suppressedReason: `refusing to write the production metrics path (${dir}) from a validation server`,
    };
  }

  return {
    enabled: enabledByEnv,
    dir,
    intervalMs,
    maxFileBytes,
    maxFiles,
    thresholds,
    sink: sink.sink,
    sinkDescription: sink.description,
    suppressOperatorNotifications: sink.suppressOperatorNotifications,
  };
}

/** JSONL capture sink (disposable validation runs and tests). */
export function createFileAlertSink(filePath: string): HealthAlertSink {
  let ready = false;
  return async (alert) => {
    if (!ready) {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      ready = true;
    }
    await appendFile(filePath, `${JSON.stringify(alert)}\n`, { mode: 0o600 });
  };
}

/**
 * Operator sink: writes one delivery-ready notification-ingress record, exactly
 * the mechanism `scripts/notify.sh` uses when the server is unavailable. The
 * server's own NotificationManager claims it and delivers it over the normal
 * Telegram channel — A2 creates no second notification client.
 */
export function createIngressAlertSink(options: { ingressDir: string; now?: () => number }): HealthAlertSink {
  const now = options.now ?? Date.now;
  let ready = false;
  return async (alert) => {
    if (!ready) {
      await mkdir(options.ingressDir, { recursive: true, mode: 0o700 });
      ready = true;
    }
    const at = now();
    const kindLabel = alert.kind === 'heap_pressure' ? 'heap pressure' : 'event-loop lag';
    const record = {
      version: 1,
      idempotencyKey: `health-alert-${alert.kind}-${alert.transition}-${at}`,
      title: `Pi Web UI health: ${kindLabel} ${alert.transition === 'alert' ? 'alert' : 'recovered'}`,
      body: alert.message,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + INGRESS_RECORD_TTL_MS).toISOString(),
    };
    const file = path.join(options.ingressDir, `${record.idempotencyKey}-${randomBytes(4).toString('hex')}.json`);
    await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };
}

export function createNoopAlertSink(): HealthAlertSink {
  return () => {};
}
