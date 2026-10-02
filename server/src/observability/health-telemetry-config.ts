import { appendFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_HEALTH_INCIDENT_COOLDOWN_MS,
  DEFAULT_HEALTH_INCIDENT_DEBOUNCE_READINGS,
  DEFAULT_HEALTH_INCIDENT_QUIET_PERIOD_MS,
  validateHealthAlertThresholds,
  validateHealthIncidentConfig,
  type HealthAlert,
  type HealthAlertThresholds,
  type HealthIncidentConfig,
} from './health-alerts.js';

/**
 * A2 telemetry configuration and alert delivery.
 *
 * Deliberately free of the logger and of `config.ts`: `config.ts` imports this
 * module, while `logging/logger.ts` imports `config.ts`, so importing the logger
 * here would close an import cycle and leave `createLogger` undefined. Warnings
 * are therefore collected into `HealthTelemetryConfig.warnings` and emitted by
 * the sampler at start-up.
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
  /** Incident-grouping pacing (quiet period, cooldown, debounce). */
  incident: HealthIncidentConfig;
  sink: HealthAlertSink;
  /** Human-readable sink target, logged at startup (proves where alerts go). */
  sinkDescription: string;
  /** True when this process deliberately does not notify the operator. */
  suppressOperatorNotifications: boolean;
  /** Set when telemetry was disabled by a safety guard, for the startup log. */
  suppressedReason?: string;
  /** Non-fatal problems resolved at build time (out-of-range knobs, overrides). */
  warnings: string[];
}

export const DEFAULT_HEALTH_METRICS_INTERVAL_MS = 30_000;
export const DEFAULT_HEALTH_METRICS_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_HEALTH_METRICS_MAX_FILES = 5;

/**
 * Sane bounds for the sampling/rotation knobs (correction 02, finding 4).
 *
 * The upper interval bound is not cosmetic: Node clamps a `setInterval` delay
 * above 2**31-1 ms to 1 ms (`TimeoutOverflowWarning`), so an absurd value would
 * turn a 30-second sampler into a busy loop. The file bounds keep rotation
 * cheap (`maxFiles` iterations per rotation) and the directory finite.
 */
export const MIN_HEALTH_METRICS_INTERVAL_MS = 1_000;
export const MAX_HEALTH_METRICS_INTERVAL_MS = 3_600_000;
export const MIN_HEALTH_METRICS_MAX_FILE_BYTES = 1_024;
export const MAX_HEALTH_METRICS_MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MIN_HEALTH_METRICS_MAX_FILES = 1;
export const MAX_HEALTH_METRICS_MAX_FILES = 100;

/** The longest quiet period or cooldown a grouping knob may name (24 h). */
export const MAX_HEALTH_INCIDENT_PACING_MS = 86_400_000;
export const MAX_HEALTH_INCIDENT_DEBOUNCE_READINGS = 100;

const DEFAULT_HEAP_ALERT_FRACTION = 0.85;
const DEFAULT_HEAP_RECOVER_FRACTION = 0.75;
const DEFAULT_LAG_ALERT_MS = 500;
const DEFAULT_LAG_RECOVER_MS = 200;
const INGRESS_RECORD_TTL_MS = 15 * 60 * 1000;

/**
 * The real production metrics directory, independent of `HOME`.
 *
 * `os.homedir()` follows the mutable `HOME`, and a disposable validation child
 * is given a fake `HOME`, so homedir-based comparisons say "this is not
 * production" about the actual production path. `os.userInfo()` reads the
 * account database (getpwuid) instead, so it names the same directory the
 * production service would use no matter what the environment says.
 */
export function realProductionMetricsDir(): string {
  let home = '/root';
  try {
    home = os.userInfo().homedir || home;
  } catch {
    // No account database (rare containers): keep the conventional root home.
  }
  return path.join(home, '.pi-web-ui', 'metrics');
}

/** Back-compat alias: the production metrics directory (HOME-independent). */
export function productionMetricsDir(): string {
  return realProductionMetricsDir();
}

/**
 * Canonicalises a path for containment checks: resolves symlinks on the longest
 * existing prefix and appends the not-yet-existing remainder lexically. This is
 * what stops a symlink inside the run directory from aliasing a path outside it.
 */
export function canonicalisePath(target: string): string {
  let current = path.resolve(target);
  const remainder: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return remainder.length === 0 ? real : path.join(real, ...remainder.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      remainder.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `child` is `ancestor` or lives below it (canonical paths). */
export function isPathInside(child: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The disposable run directory a validation server is confined to. */
export function validationRunDir(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.PI_WEB_UI_VALIDATION_RECORD_DIR, env.PI_WEB_UI_VALIDATION_DIR]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) return candidate;
  }
  return path.join(os.tmpdir(), 'pi-web-ui-validation');
}

function isValidationMode(env: NodeJS.ProcessEnv): boolean {
  return env.PI_WEB_UI_VALIDATION_MODE === 'true';
}

/**
 * Where the metrics file lives.
 *
 * Production default is `~/.pi-web-ui/metrics`. With
 * `PI_WEB_UI_VALIDATION_MODE=true` the default moves inside the run's own record
 * directory; an explicit absolute `OBSERVABILITY_METRICS_DIR` is honoured but
 * must canonicalise inside that directory, or `createHealthTelemetryConfig`
 * refuses it. A relative value is a configuration error either way.
 */
export function resolveObservabilityMetricsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OBSERVABILITY_METRICS_DIR?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('OBSERVABILITY_METRICS_DIR must be an absolute path.');
    return explicit;
  }
  if (isValidationMode(env)) return path.join(validationRunDir(env), 'metrics');
  return realProductionMetricsDir();
}

/**
 * Bounded positive integer: only an in-range safe integer is accepted.
 * Anything else falls back to the default **and records a warning**, so a typo
 * degrades to the documented behaviour instead of an unbounded or clamped one.
 */
function boundedPositiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
  warnings: string[],
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value < min || value > max) {
    warnings.push(
      `${name}=${trimmed} is not an integer within [${min}, ${max}]; using the default ${fallback}.`,
    );
    return fallback;
  }
  return value;
}

function parseNonNegativeNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

function parseRatio(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a fraction within (0, 1].`);
  }
  return value;
}

/**
 * Incident-grouping pacing. Like the sampling/rotation knobs, an out-of-range
 * value falls back to the documented default with a warning rather than
 * disabling grouping: a typo must degrade to the safe behaviour, not to a page
 * storm.
 */
export function resolveHealthIncidentConfig(env: NodeJS.ProcessEnv = process.env, warnings: string[] = []): HealthIncidentConfig {
  const config: HealthIncidentConfig = {
    quietPeriodMs: boundedNonNegativeInteger(
      env.OBSERVABILITY_HEALTH_ALERT_QUIET_PERIOD_MS,
      DEFAULT_HEALTH_INCIDENT_QUIET_PERIOD_MS,
      'OBSERVABILITY_HEALTH_ALERT_QUIET_PERIOD_MS',
      warnings,
    ),
    cooldownMs: boundedNonNegativeInteger(
      env.OBSERVABILITY_HEALTH_ALERT_COOLDOWN_MS,
      DEFAULT_HEALTH_INCIDENT_COOLDOWN_MS,
      'OBSERVABILITY_HEALTH_ALERT_COOLDOWN_MS',
      warnings,
    ),
    debounceReadings: boundedPositiveInteger(
      env.OBSERVABILITY_HEALTH_ALERT_DEBOUNCE_READINGS,
      DEFAULT_HEALTH_INCIDENT_DEBOUNCE_READINGS,
      'OBSERVABILITY_HEALTH_ALERT_DEBOUNCE_READINGS',
      1,
      MAX_HEALTH_INCIDENT_DEBOUNCE_READINGS,
      warnings,
    ),
  };
  validateHealthIncidentConfig(config);
  return config;
}

/**
 * Non-negative whole milliseconds within the pacing bound; anything else falls
 * back to the default with a warning.
 */
function boundedNonNegativeInteger(raw: string | undefined, fallback: number, name: string, warnings: string[]): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value < 0 || value > MAX_HEALTH_INCIDENT_PACING_MS) {
    warnings.push(
      `${name}=${trimmed} is not an integer within [0, ${MAX_HEALTH_INCIDENT_PACING_MS}]; using the default ${fallback}.`,
    );
    return fallback;
  }
  return value;
}

/** Heap + lag hysteresis bands. Fail-fast: a band that cannot be hysteretic is an error. */
export function resolveHealthAlertThresholds(env: NodeJS.ProcessEnv = process.env, warnings: string[] = []): HealthAlertThresholds {
  const thresholds: HealthAlertThresholds = {
    heapFractionHigh: parseRatio(env.OBSERVABILITY_HEALTH_ALERT_HEAP_FRACTION, DEFAULT_HEAP_ALERT_FRACTION, 'OBSERVABILITY_HEALTH_ALERT_HEAP_FRACTION'),
    heapFractionLow: parseRatio(env.OBSERVABILITY_HEALTH_ALERT_HEAP_RECOVER_FRACTION, DEFAULT_HEAP_RECOVER_FRACTION, 'OBSERVABILITY_HEALTH_ALERT_HEAP_RECOVER_FRACTION'),
    lagP99HighMs: parseNonNegativeNumber(env.OBSERVABILITY_HEALTH_ALERT_LAG_P99_MS, DEFAULT_LAG_ALERT_MS, 'OBSERVABILITY_HEALTH_ALERT_LAG_P99_MS'),
    lagP99LowMs: parseNonNegativeNumber(env.OBSERVABILITY_HEALTH_ALERT_LAG_RECOVER_MS, DEFAULT_LAG_RECOVER_MS, 'OBSERVABILITY_HEALTH_ALERT_LAG_RECOVER_MS'),
    // J3: optional — unset means the evaluator's defaults (3 / 2 consecutive readings).
    // Correction 02, finding 3: the run-length knob is bounded to 2–100 — 1 would
    // page on a single boundary-race reading, and an unbounded ceiling invites
    // silently-never-arming configs; out-of-range values fall back with a warning.
    turnCountMismatchAlertReadings: boundedMismatchReadings(env.OBSERVABILITY_HEALTH_ALERT_TURN_MISMATCH_READINGS, 'OBSERVABILITY_HEALTH_ALERT_TURN_MISMATCH_READINGS', warnings, 2, 100),
    turnCountMismatchRecoveryReadings: optionalPositiveReadings(env.OBSERVABILITY_HEALTH_ALERT_TURN_MISMATCH_RECOVERY_READINGS, 'OBSERVABILITY_HEALTH_ALERT_TURN_MISMATCH_RECOVERY_READINGS', warnings),
  };
  validateHealthAlertThresholds(thresholds);
  return thresholds;
}

/** J3: optional consecutive-reading count; unset stays unset, a bad value warns and stays unset. */
function optionalPositiveReadings(raw: string | undefined, name: string, warnings: string[]): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value < 1) {
    warnings.push(`${name}=${trimmed} is not a positive integer; using the default.`);
    return undefined;
  }
  return value;
}

/** J3 (correction 02): optional reading count bounded to [min, max]; outside the bound warns and stays unset. */
function boundedMismatchReadings(raw: string | undefined, name: string, warnings: string[], min: number, max: number): number | undefined {
  const trimmed = (raw ?? '').trim();
  const parsed = optionalPositiveReadings(raw, name, warnings);
  if (parsed === undefined) return undefined;
  if (parsed < min || parsed > max) {
    warnings.push(`${name}=${trimmed} is outside [${min}, ${max}]; using the default.`);
    return undefined;
  }
  return parsed;
}

function resolveNotificationsDir(env: NodeJS.ProcessEnv): string {
  // Mirrors config.notificationsDir; kept local so observability never imports
  // the config module (which would be an import cycle).
  return env.NOTIFICATIONS_DIR?.trim() || path.join(os.homedir(), '.pi-web-ui', 'notifications');
}

function captureSink(metricsDir: string, warnings: string[], overrideNote?: string): {
  sink: HealthAlertSink;
  description: string;
  suppressOperatorNotifications: boolean;
} {
  if (overrideNote) warnings.push(overrideNote);
  const capturePath = path.join(metricsDir, 'alerts.jsonl');
  return { sink: createFileAlertSink(capturePath), description: `file:${capturePath}`, suppressOperatorNotifications: true };
}

function ingressSink(env: NodeJS.ProcessEnv): {
  sink: HealthAlertSink;
  description: string;
  suppressOperatorNotifications: boolean;
} {
  const ingressDir = path.join(resolveNotificationsDir(env), 'ingress');
  return { sink: createIngressAlertSink({ ingressDir }), description: `ingress:${ingressDir}`, suppressOperatorNotifications: false };
}

interface SinkResolution {
  sink: HealthAlertSink;
  description: string;
  suppressOperatorNotifications: boolean;
  /** Set when a configured sink was refused outright (validation mode). */
  refusedReason?: string;
}

/**
 * Resolves the alert sink.
 *
 * Validation mode forces a **non-delivering** sink whatever the environment
 * says (correction 02, finding 2): an explicit `notifications` request is
 * overridden to the run-directory capture file, so a disposable server that
 * inherits Telegram credentials and `NOTIFICATIONS_ENABLED` still cannot message
 * the operator. A `file:` target is honoured only when it canonicalises inside
 * the run directory; anything else is refused (correction 02, finding 1).
 */
function resolveAlertSink(
  env: NodeJS.ProcessEnv,
  metricsDir: string,
  warnings: string[],
  productionMetricsRoot: string,
): SinkResolution {
  const configured = env.OBSERVABILITY_HEALTH_ALERT_SINK?.trim();
  const validationMode = isValidationMode(env);

  if (validationMode) {
    const canonicalRoot = canonicalisePath(validationRunDir(env));
    if (!configured) return captureSink(metricsDir, warnings);
    if (configured === 'none') return { sink: createNoopAlertSink(), description: 'none', suppressOperatorNotifications: true };
    if (configured === 'notifications') {
      return captureSink(
        metricsDir,
        warnings,
        'OBSERVABILITY_HEALTH_ALERT_SINK=notifications is ignored in validation mode: alerts are captured to a file and operator notifications are suppressed.',
      );
    }
    if (configured.startsWith('file:')) {
      const filePath = configured.slice('file:'.length).trim();
      if (!path.isAbsolute(filePath)) throw new Error('OBSERVABILITY_HEALTH_ALERT_SINK file: target must be an absolute path.');
      const canonical = canonicalisePath(filePath);
      if (!isPathInside(canonical, canonicalRoot)) {
        return {
          sink: createNoopAlertSink(),
          description: 'none',
          suppressOperatorNotifications: true,
          refusedReason: `refusing alert sink ${canonical} from a validation server: it is outside the validation run directory (${canonicalRoot})`,
        };
      }
      // Defence in depth (correction 03): even inside the run directory, a sink
      // inside the production metrics root is production state.
      if (isPathInside(canonical, productionMetricsRoot)) {
        return {
          sink: createNoopAlertSink(),
          description: 'none',
          suppressOperatorNotifications: true,
          refusedReason: `refusing alert sink ${canonical} from a validation server: it is inside the production metrics root (${productionMetricsRoot})`,
        };
      }
      return { sink: createFileAlertSink(filePath), description: `file:${filePath}`, suppressOperatorNotifications: true };
    }
    throw new Error(`OBSERVABILITY_HEALTH_ALERT_SINK must be 'none', 'notifications' or 'file:<absolute path>' (got '${configured}').`);
  }

  if (configured === 'none') return { sink: createNoopAlertSink(), description: 'none', suppressOperatorNotifications: true };
  if (configured === 'notifications') return ingressSink(env);
  if (configured?.startsWith('file:')) {
    const filePath = configured.slice('file:'.length).trim();
    if (!path.isAbsolute(filePath)) throw new Error('OBSERVABILITY_HEALTH_ALERT_SINK file: target must be an absolute path.');
    return { sink: createFileAlertSink(filePath), description: `file:${filePath}`, suppressOperatorNotifications: true };
  }
  if (configured) {
    throw new Error(`OBSERVABILITY_HEALTH_ALERT_SINK must be 'none', 'notifications' or 'file:<absolute path>' (got '${configured}').`);
  }
  return ingressSink(env);
}

/**
 * Builds the A2 telemetry configuration from the environment.
 *
 * - out-of-range or unsafe sampling/rotation knobs fall back to their defaults
 *   with a recorded warning (correction 02, finding 4);
 * - in validation mode both the metrics directory and a configured `file:`
 *   alert sink must canonicalise inside the run directory, and the real
 *   production metrics directory is refused outright (correction 02, finding 1);
 * - a refused path disables telemetry entirely, with a reason the sampler logs.
 */
export function createHealthTelemetryConfig(env: NodeJS.ProcessEnv = process.env): HealthTelemetryConfig {
  const warnings: string[] = [];
  const dir = resolveObservabilityMetricsDir(env);
  const enabledByEnv = env.OBSERVABILITY_METRICS_ENABLED !== 'false';
  const intervalMs = boundedPositiveInteger(
    env.OBSERVABILITY_METRICS_INTERVAL_MS, DEFAULT_HEALTH_METRICS_INTERVAL_MS, 'OBSERVABILITY_METRICS_INTERVAL_MS',
    MIN_HEALTH_METRICS_INTERVAL_MS, MAX_HEALTH_METRICS_INTERVAL_MS, warnings,
  );
  const maxFileBytes = boundedPositiveInteger(
    env.OBSERVABILITY_METRICS_MAX_FILE_BYTES, DEFAULT_HEALTH_METRICS_MAX_FILE_BYTES, 'OBSERVABILITY_METRICS_MAX_FILE_BYTES',
    MIN_HEALTH_METRICS_MAX_FILE_BYTES, MAX_HEALTH_METRICS_MAX_FILE_BYTES, warnings,
  );
  const maxFiles = boundedPositiveInteger(
    env.OBSERVABILITY_METRICS_MAX_FILES, DEFAULT_HEALTH_METRICS_MAX_FILES, 'OBSERVABILITY_METRICS_MAX_FILES',
    MIN_HEALTH_METRICS_MAX_FILES, MAX_HEALTH_METRICS_MAX_FILES, warnings,
  );
  const thresholds = resolveHealthAlertThresholds(env, warnings);
  const incident = resolveHealthIncidentConfig(env, warnings);
  const canonicalProductionRoot = canonicalisePath(realProductionMetricsDir());
  const sink = resolveAlertSink(env, dir, warnings, canonicalProductionRoot);

  if (isValidationMode(env)) {
    const canonicalRoot = canonicalisePath(validationRunDir(env));
    const canonicalDir = canonicalisePath(dir);
    const refusals: string[] = [];

    if (canonicalDir === canonicalProductionRoot) {
      refusals.push(`refusing to write ${canonicalDir} from a validation server: it is the production metrics path`);
    } else if (isPathInside(canonicalDir, canonicalProductionRoot)) {
      // Correction 03: a validation root inside the production metrics root must
      // not make production state "inside the run directory".
      refusals.push(`refusing to write ${canonicalDir} from a validation server: it is inside the production metrics root (${canonicalProductionRoot})`);
    } else if (!isPathInside(canonicalDir, canonicalRoot)) {
      refusals.push(`refusing to write ${canonicalDir} from a validation server: it is outside the validation run directory (${canonicalRoot})`);
    }
    // Defence in depth: the production metrics root is refused even when the run
    // directory itself overlaps it (the sink check runs on canonical paths).
    if (sink.refusedReason) refusals.push(sink.refusedReason);

    if (refusals.length > 0) {
      const overridden = warnings.find((warning) => warning.includes('OBSERVABILITY_HEALTH_ALERT_SINK=notifications'));
      return {
        enabled: false,
        dir,
        intervalMs,
        maxFileBytes,
        maxFiles,
        thresholds,
        incident,
        sink: createNoopAlertSink(),
        sinkDescription: 'none',
        suppressOperatorNotifications: true,
        suppressedReason: overridden ? `${refusals.join('; ')}; ${overridden}` : refusals.join('; '),
        warnings,
      };
    }
  }

  return {
    enabled: enabledByEnv,
    dir,
    intervalMs,
    maxFileBytes,
    maxFiles,
    thresholds,
    incident,
    sink: sink.sink,
    sinkDescription: sink.description,
    suppressOperatorNotifications: sink.suppressOperatorNotifications,
    warnings,
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
    const kindLabel = alert.kind === 'heap_pressure' ? 'heap pressure' : alert.kind === 'turn_count_mismatch' ? 'turn-count mismatch' : 'event-loop lag';
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
