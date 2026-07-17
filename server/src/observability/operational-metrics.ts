import type { SessionRuntime, RunReceiptStatus } from '../internal-api/types.js';

const RUNTIMES: readonly SessionRuntime[] = ['pi', 'claude', 'opencode', 'antigravity'];

type TerminalStatus = Extract<RunReceiptStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>;

interface LatencySnapshot {
  count: number;
  totalMs: number;
  maxMs: number;
  buckets: { le1000: number; le5000: number; le30000: number; gt30000: number };
}

export interface TurnMetricsSnapshot extends Record<TerminalStatus | 'accepted', number | LatencySnapshot> {
  accepted: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  latency: LatencySnapshot;
}

export interface OperationalSnapshot {
  generatedAt: string;
  turns: Partial<Record<SessionRuntime, TurnMetricsSnapshot>>;
  notifications: {
    queued: number;
    sent: number;
    failedAttempts: number;
    terminalFailed: number;
  };
  pipeline: {
    subscriberFailures: Record<string, number>;
    adapterDrops: Partial<Record<SessionRuntime, Record<string, number>>>;
    watchPersistenceFailures: number;
    workerReadinessFallbacks: number;
    lastEventAt?: string;
    lastEventAgeMs?: number;
  };
}

export interface OperationalMetricsOptions {
  now?: () => number;
}

function newTurnMetrics(): TurnMetricsSnapshot {
  return {
    accepted: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    latency: {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      buckets: { le1000: 0, le5000: 0, le30000: 0, gt30000: 0 },
    },
  };
}

/**
 * Process-local, low-cardinality operational counters for the single-operator
 * deployment. It deliberately stores no session IDs, paths, model IDs, prompt
 * text, event payloads, or tool data.
 */
export class OperationalMetrics {
  private readonly now: () => number;
  private readonly turns = new Map<SessionRuntime, TurnMetricsSnapshot>();
  private readonly subscriberFailures = new Map<string, number>();
  private readonly adapterDrops = new Map<SessionRuntime, Map<string, number>>();
  private watchPersistenceFailures = 0;
  private workerReadinessFallbacks = 0;
  private notificationQueued = 0;
  private notificationSent = 0;
  private notificationFailedAttempts = 0;
  private notificationTerminalFailed = 0;
  private lastEventAt?: number;

  constructor(options: OperationalMetricsOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  recordTurnAccepted(runtime: SessionRuntime): void {
    this.turn(runtime).accepted += 1;
  }

  recordTurnFinished(runtime: SessionRuntime, status: TerminalStatus, latencyMs?: number): void {
    const turn = this.turn(runtime);
    turn[status] += 1;
    if (latencyMs === undefined || !Number.isFinite(latencyMs) || latencyMs < 0) return;
    const value = Math.floor(latencyMs);
    const latency = turn.latency;
    latency.count += 1;
    latency.totalMs += value;
    latency.maxMs = Math.max(latency.maxMs, value);
    if (value <= 1_000) latency.buckets.le1000 += 1;
    if (value <= 5_000) latency.buckets.le5000 += 1;
    if (value <= 30_000) latency.buckets.le30000 += 1;
    else latency.buckets.gt30000 += 1;
  }

  recordSubscriberFailure(subscriberClass: string): number {
    return incrementBounded(this.subscriberFailures, boundedLabel(subscriberClass, 'subscriber'));
  }

  recordAdapterDrop(runtime: SessionRuntime, category: string): number {
    let categories = this.adapterDrops.get(runtime);
    if (!categories) {
      categories = new Map();
      this.adapterDrops.set(runtime, categories);
    }
    return incrementBounded(categories, boundedLabel(category, 'unknown'));
  }

  recordWatchPersistenceFailure(): void {
    this.watchPersistenceFailures += 1;
  }

  recordWorkerReadinessFallback(): void {
    this.workerReadinessFallbacks += 1;
  }

  recordNotificationQueued(): void {
    this.notificationQueued += 1;
  }

  recordNotificationSent(): void {
    this.notificationSent += 1;
  }

  recordNotificationFailure(terminal: boolean): void {
    this.notificationFailedAttempts += 1;
    if (terminal) this.notificationTerminalFailed += 1;
  }

  recordEvent(timestamp = this.now()): void {
    if (Number.isFinite(timestamp)) this.lastEventAt = Math.max(this.lastEventAt ?? 0, timestamp);
  }

  snapshot(): OperationalSnapshot {
    const now = this.now();
    const turns: OperationalSnapshot['turns'] = {};
    for (const runtime of RUNTIMES) {
      const value = this.turns.get(runtime);
      if (value) turns[runtime] = structuredClone(value);
    }
    const adapterDrops: OperationalSnapshot['pipeline']['adapterDrops'] = {};
    for (const [runtime, categories] of this.adapterDrops) {
      adapterDrops[runtime] = Object.fromEntries(categories);
    }
    return {
      generatedAt: new Date(now).toISOString(),
      turns,
      notifications: {
        queued: this.notificationQueued,
        sent: this.notificationSent,
        failedAttempts: this.notificationFailedAttempts,
        terminalFailed: this.notificationTerminalFailed,
      },
      pipeline: {
        subscriberFailures: Object.fromEntries(this.subscriberFailures),
        adapterDrops,
        watchPersistenceFailures: this.watchPersistenceFailures,
        workerReadinessFallbacks: this.workerReadinessFallbacks,
        ...(this.lastEventAt !== undefined
          ? {
              lastEventAt: new Date(this.lastEventAt).toISOString(),
              lastEventAgeMs: Math.max(0, now - this.lastEventAt),
            }
          : {}),
      },
    };
  }

  private turn(runtime: SessionRuntime): TurnMetricsSnapshot {
    let current = this.turns.get(runtime);
    if (!current) {
      current = newTurnMetrics();
      this.turns.set(runtime, current);
    }
    return current;
  }
}

const MAX_DYNAMIC_CATEGORIES = 32;

function incrementBounded(values: Map<string, number>, requestedKey: string): number {
  const key = values.has(requestedKey) || values.size < MAX_DYNAMIC_CATEGORIES ? requestedKey : 'other';
  const count = (values.get(key) ?? 0) + 1;
  values.set(key, count);
  return count;
}

function boundedLabel(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
  return cleaned || fallback;
}

const globalMetrics = new OperationalMetrics();

export function getOperationalMetrics(): OperationalMetrics {
  return globalMetrics;
}
