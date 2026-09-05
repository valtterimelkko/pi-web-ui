import { createLogger } from '../logging/logger.js';
import { getOperationalMetrics, type OperationalMetrics } from '../observability/operational-metrics.js';

const logger = createLogger('EventLoopShed');

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

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

let globalMonitor: EventLoopShedMonitor | undefined;

export function getEventLoopShedMonitor(): EventLoopShedMonitor {
  globalMonitor ??= new EventLoopShedMonitor();
  globalMonitor.start();
  return globalMonitor;
}
