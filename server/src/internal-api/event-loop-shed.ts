import { createLogger } from '../logging/logger.js';
import { getOperationalMetrics, type OperationalMetrics } from '../observability/operational-metrics.js';

const logger = createLogger('EventLoopShed');

export interface EventLoopShedOptions {
  metrics?: OperationalMetrics;
  now?: () => number;
  intervalMs?: number;
}

export class EventLoopShedMonitor {
  isShedding = false;
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
    if (!this.isShedding && lagMs > 1_000) {
      this.isShedding = true;
      this.recoverSince = undefined;
      logger.warn(`event-loop shed mode enabled: lagMs=${Math.round(lagMs)}`);
      return;
    }
    if (!this.isShedding) return;
    if (lagMs >= 250) {
      this.recoverSince = undefined;
      return;
    }
    this.recoverSince ??= now;
    if (now - this.recoverSince >= 10_000) {
      this.isShedding = false;
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
