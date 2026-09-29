import { createLogger } from '../logging/logger.js';
import { HealthAlertEvaluator, type HealthAlert } from './health-alerts.js';
import { RotatingMetricsFile } from './health-metrics-file.js';
import {
  collectHealthReadings,
  getRegisteredHealthReadingSources,
  type HealthReadingSources,
  type HealthReadings,
} from './health-readings.js';
import {
  createHealthTelemetryConfig,
  type HealthTelemetryConfig,
} from './health-telemetry-config.js';

const logger = createLogger('HealthTelemetry');

/**
 * A2 telemetry surface for the rest of the server: config resolution and alert
 * delivery live in `health-telemetry-config.ts` (so `config.ts` can import them
 * without closing the logger → config import cycle), the sampler lives here.
 */
export {
  createFileAlertSink,
  createHealthTelemetryConfig,
  createIngressAlertSink,
  createNoopAlertSink,
  resolveHealthAlertThresholds,
  resolveObservabilityMetricsDir,
} from './health-telemetry-config.js';
export type { HealthAlertSink, HealthTelemetryConfig } from './health-telemetry-config.js';

export interface HealthTelemetryOptions {
  config: HealthTelemetryConfig;
  sources?: HealthReadingSources;
  metricsFile?: RotatingMetricsFile;
  now?: () => number;
}

/**
 * Periodic A2 sampler: appends one bounded JSONL reading per interval, and
 * evaluates the hysteresis latches against the same reading. Chain:
 *
 *   readings (process + registered sources)
 *     └─ rotating metrics file (size-bounded)
 *     └─ alert evaluator (hysteresis) → sink (ingress spool | capture file | none)
 */
export class HealthTelemetry {
  private readonly config: HealthTelemetryConfig;
  private readonly file: RotatingMetricsFile;
  private readonly evaluator: HealthAlertEvaluator;
  private readonly now: () => number;
  private sources: HealthReadingSources;
  private timer?: ReturnType<typeof setInterval>;
  private sampling = false;
  private failedAppends = 0;
  private readonly readingListeners = new Set<(readings: HealthReadings) => void>();

  constructor(options: HealthTelemetryOptions) {
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.sources = options.sources ?? {};
    this.file = options.metricsFile ?? new RotatingMetricsFile({
      dir: options.config.dir,
      maxFileBytes: options.config.maxFileBytes,
      maxFiles: options.config.maxFiles,
    });
    this.evaluator = new HealthAlertEvaluator({ thresholds: options.config.thresholds, now: this.now });
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get sinkDescription(): string {
    return this.config.sinkDescription;
  }

  get suppressOperatorNotifications(): boolean {
    return this.config.suppressOperatorNotifications;
  }

  get metricsPath(): string {
    return this.file.currentPath;
  }

  /** Metrics lines that could not be persisted (alerts are unaffected). */
  get appendFailures(): number {
    return this.failedAppends;
  }

  /**
   * B2: read-only observer of each collected reading (admission's
   * event_loop_lag gate consumes the lag p99). Sampling, persistence and
   * alerting are unchanged; a throwing listener is isolated. Returns an
   * unsubscribe function.
   */
  onReading(listener: (readings: HealthReadings) => void): () => void {
    this.readingListeners.add(listener);
    return () => { this.readingListeners.delete(listener); };
  }

  /** Registers process sources (merged; a later registrar cannot drop a field). */
  registerSources(sources: HealthReadingSources): void {
    this.sources = { ...this.sources, ...sources };
  }

  start(): void {
    // The refusal and the knob warnings are logged even when telemetry is
    // disabled: a silently not-running sampler is exactly what the guard must
    // never look like.
    for (const warning of this.config.warnings) {
      logger.warn(`[HealthTelemetry] ${warning}`);
    }
    if (!this.config.enabled) {
      if (this.config.suppressedReason) {
        logger.error(`[HealthTelemetry] disabled: ${this.config.suppressedReason}`);
      }
      return;
    }
    if (this.timer) return;
    logger.info(
      `[HealthTelemetry] metrics → ${this.file.currentPath} every ${this.config.intervalMs}ms; ` +
      `alerts → ${this.config.sinkDescription}${this.config.suppressOperatorNotifications ? ' (operator notifications suppressed)' : ''}`,
    );
    void this.sampleOnce();
    this.timer = setInterval(() => void this.sampleOnce(), this.config.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One reading → one metrics line → any alert transitions. Testable directly. */
  async sampleOnce(): Promise<HealthReadings | undefined> {
    if (!this.config.enabled || this.sampling) return undefined;
    this.sampling = true;
    let readings: HealthReadings | undefined;
    try {
      readings = collectHealthReadings({
        ...getRegisteredHealthReadingSources(),
        ...this.sources,
        ...await this.resolvedAsyncSources(),
      });
    } catch (error) {
      // Reading collection is fail-open by construction; a failure here means a
      // source broke its contract. Telemetry must never take the control plane
      // down, and the sample is skipped.
      logger.warn(`[HealthTelemetry] sample failed: ${error instanceof Error ? error.message : String(error)}`);
      this.sampling = false;
      return undefined;
    }

    for (const listener of this.readingListeners) {
      try {
        listener(readings);
      } catch (error) {
        logger.warn(`[HealthTelemetry] reading listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Persistence and alerting are independent (correction 02, finding 3): a
    // full disk or an unreadable metrics directory must not silence the alert
    // that says the process is in trouble.
    try {
      await this.file.append(JSON.stringify(readings));
    } catch (error) {
      this.failedAppends += 1;
      logger.warn(
        `[HealthTelemetry] metrics append failed (${this.file.currentPath}, ${this.failedAppends} so far): ` +
        `${error instanceof Error ? error.message : String(error)} — alerts continue`,
      );
    }

    try {
      const alerts = this.evaluator.evaluate(readings);
      for (const alert of alerts) await this.deliver(alert);
    } catch (error) {
      logger.warn(`[HealthTelemetry] alert evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sampling = false;
    }
    return readings;
  }

  private async deliver(alert: HealthAlert): Promise<void> {
    const line = `[HealthTelemetry] ${alert.kind} ${alert.transition}: ${alert.message}`;
    if (alert.transition === 'alert') logger.warn(line);
    else logger.info(line);
    try {
      await this.config.sink(alert);
    } catch (error) {
      logger.warn(`[HealthTelemetry] alert delivery failed (${this.config.sinkDescription}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The registry count needs an async provider (the session registry loads
   * lazily); every other reading is synchronous.
   */
  private async resolvedAsyncSources(): Promise<HealthReadingSources> {
    const registry = this.sources.registryEntries;
    if (!registry) return {};
    let count: number | undefined;
    try {
      const value = await registry();
      count = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    } catch {
      count = undefined;
    }
    return { registryEntries: () => count };
  }
}

/** Session-registry entry count; `undefined` when no unique registry exists. */
async function defaultRegistryEntries(): Promise<number | undefined> {
  try {
    const { getSessionRegistry } = await import('../session-registry.js');
    const entries = await getSessionRegistry().listAll();
    return entries.length;
  } catch {
    return undefined;
  }
}

let globalTelemetry: HealthTelemetry | undefined;

/**
 * The process-wide sampler. Inert under the test runner (`VITEST`) so unit
 * tests never write the real metrics directory; the disposable validation
 * server and production both run it for real.
 */
export function getHealthTelemetry(): HealthTelemetry {
  if (!globalTelemetry) {
    const config = createHealthTelemetryConfig(process.env);
    globalTelemetry = new HealthTelemetry({
      config: process.env.VITEST ? { ...config, enabled: false } : config,
      sources: { registryEntries: defaultRegistryEntries },
    });
  }
  return globalTelemetry;
}

/** Test seam. */
export function resetHealthTelemetry(): void {
  globalTelemetry?.stop();
  globalTelemetry = undefined;
}
