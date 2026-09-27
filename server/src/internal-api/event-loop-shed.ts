import { createLogger } from '../logging/logger.js';
import { getOperationalMetrics, type OperationalMetrics } from '../observability/operational-metrics.js';

const logger = createLogger('EventLoopShed');

/** Lag window exposed to A2 telemetry: the last 60 s at the 500 ms sampling cadence. */
export const EVENT_LOOP_LAG_WINDOW_MS = 60_000;
export const EVENT_LOOP_LAG_WINDOW_SAMPLES = 120;

export interface EventLoopLagWindow {
  windowMs: number;
  sampleCount: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Nearest-rank percentile; total on empty input. */
function nearestRank(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export interface EventLoopShedOptions {
  metrics?: OperationalMetrics;
  now?: () => number;
  intervalMs?: number;
}

export class EventLoopShedMonitor {
  private lagShedding = false;
  private memoryShed = false;
  private readonly metrics: OperationalMetrics;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private recoverSince?: number;
  private timer?: ReturnType<typeof setInterval>;
  /** A2: bounded ring of recent lag samples for p50/p99/max telemetry. */
  private readonly lagSamples: Array<{ at: number; value: number } | undefined> = new Array(EVENT_LOOP_LAG_WINDOW_SAMPLES);
  private lagCursor = 0;

  constructor(options: EventLoopShedOptions = {}) {
    this.metrics = options.metrics ?? getOperationalMetrics();
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 500;
  }

  /** Shedding is armed by sustained event-loop lag OR heap pressure (WS-path memory robustness). */
  get isShedding(): boolean {
    return this.lagShedding || this.memoryShed;
  }

  /**
   * WS-path memory robustness (2026-09-05): heap-pressure input, armed by the
   * MultiSessionManager memory check when heapUsed approaches the real V8
   * heap_size_limit (which can be far below any hardcoded MB constant).
   * While shedding, message_update deliveries degrade to ids-only on both the
   * broker and the browser path; terminal/tool/control events are unaffected.
   */
  observeMemoryPressure(pressure: boolean): void {
    if (pressure && !this.memoryShed) {
      this.memoryShed = true;
      this.metrics.setMemoryShed(true);
      logger.warn('memory-pressure shed mode enabled');
    } else if (!pressure && this.memoryShed) {
      this.memoryShed = false;
      this.metrics.setMemoryShed(false);
      logger.info('memory-pressure shed mode disabled');
    }
  }

  start(): void {
    if (this.timer) return;
    let expectedAt = this.now() + this.intervalMs;
    this.timer = setInterval(() => {
      const now = this.now();
      this.observeLag(Math.max(0, now - expectedAt), now);
      expectedAt = now + this.intervalMs;
    }, this.intervalMs);
    this.timer.unref?.();
  }

  observeLag(lagMs: number, now = this.now()): void {
    this.metrics.recordEventLoopLag(lagMs);
    this.lagSamples[this.lagCursor] = { at: now, value: Math.max(0, Math.round(lagMs)) };
    this.lagCursor = (this.lagCursor + 1) % EVENT_LOOP_LAG_WINDOW_SAMPLES;
    if (!this.lagShedding && lagMs > 1_000) {
      this.lagShedding = true;
      this.recoverSince = undefined;
      logger.warn(`event-loop shed mode enabled: lagMs=${Math.round(lagMs)}`);
      return;
    }
    if (!this.lagShedding) return;
    if (lagMs >= 250) {
      this.recoverSince = undefined;
      return;
    }
    this.recoverSince ??= now;
    if (now - this.recoverSince >= 10_000) {
      this.lagShedding = false;
      this.recoverSince = undefined;
      logger.info(`event-loop shed mode disabled: lagMs=${Math.round(lagMs)}`);
    }
  }

  /**
   * A2 telemetry: p50/p99/max over the recent sampling window. Read-only and
   * side-effect free (it never starts the monitor or mutates shed state).
   */
  readLagWindow(now = this.now()): EventLoopLagWindow {
    const values: number[] = [];
    for (const sample of this.lagSamples) {
      if (!sample) continue;
      if (sample.at <= now - EVENT_LOOP_LAG_WINDOW_MS) continue;
      values.push(sample.value);
    }
    return {
      windowMs: EVENT_LOOP_LAG_WINDOW_MS,
      sampleCount: values.length,
      p50Ms: nearestRank(values, 0.5),
      p99Ms: nearestRank(values, 0.99),
      maxMs: values.length === 0 ? 0 : Math.max(...values),
    };
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

let globalMonitor: EventLoopShedMonitor | undefined;

/**
 * A2 telemetry: the current lag window, or `undefined` when no monitor exists
 * yet. Deliberately does NOT create/start a monitor — a metrics read must have
 * no lifecycle side effects.
 */
export function readEventLoopLagWindow(now?: number): EventLoopLagWindow | undefined {
  return globalMonitor?.readLagWindow(now);
}

export function getEventLoopShedMonitor(): EventLoopShedMonitor {
  globalMonitor ??= new EventLoopShedMonitor();
  globalMonitor.start();
  return globalMonitor;
}
