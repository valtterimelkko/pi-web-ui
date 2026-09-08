import type { SessionRuntime, RunReceiptStatus } from '../internal-api/types.js';

/**
 * Internal API receipt runtime labels (not a census of browser/native turns).
 * The mapped type makes adding a SessionRuntime without adding its metrics
 * projection a compile-time error.
 */
const RUNTIME_ORDER = {
  pi: 'pi',
  claude: 'claude',
  opencode: 'opencode',
  antigravity: 'antigravity',
  commandcode: 'commandcode',
} as const satisfies { [runtime in SessionRuntime]: runtime };
const RUNTIMES = Object.values(RUNTIME_ORDER);

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

const LAG_WINDOW_MS = 60_000;
const LAG_MAX_SAMPLES = 120;

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
    brokerPublishBytesTotal: number;
    brokerEventsTruncatedTotal: number;
    brokerEventsCoalescedTotal: number;
    eventLoopLagMs: number;
    eventLoopLagWindow: {
      windowMs: number; maxSamples: number; sampleCount: number;
      maxMs: number; p95Ms: number; resetAt: string;
    };
    /** WS-path memory robustness (2026-09-05): bounded-send + shed observability. */
    wsUpdatesQueuedTotal: number;
    wsSlowClientsClosedTotal: number;
    memoryShedActive: boolean;
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
  private brokerPublishBytesTotal = 0;
  private brokerEventsTruncatedTotal = 0;
  private brokerEventsCoalescedTotal = 0;
  private eventLoopLagMs = 0;
  private readonly lagSamples: Array<{ at: number; value: number } | undefined> = new Array(LAG_MAX_SAMPLES);
  private lagCursor = 0;
  private readonly lagResetAt: string;
  private wsUpdatesQueuedTotal = 0;
  private wsSlowClientsClosedTotal = 0;
  private memoryShedActive = false;
  private lastEventAt?: number;

  constructor(options: OperationalMetricsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.lagResetAt = new Date(this.now()).toISOString();
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

  recordBrokerPublish(bytes: number, truncated: boolean): void {
    this.brokerPublishBytesTotal += Math.max(0, bytes);
    if (truncated) this.brokerEventsTruncatedTotal += 1;
  }

  recordBrokerCoalesced(count = 1): void {
    this.brokerEventsCoalescedTotal += Math.max(0, count);
  }

  recordEventLoopLag(lagMs: number): void {
    this.eventLoopLagMs = Math.max(0, Math.round(lagMs));
    this.lagSamples[this.lagCursor] = { at: this.now(), value: this.eventLoopLagMs };
    this.lagCursor = (this.lagCursor + 1) % LAG_MAX_SAMPLES;
  }

  /** WS-path memory robustness: a browser message_update was queued under backpressure. */
  recordWsUpdateQueued(count = 1): void {
    this.wsUpdatesQueuedTotal += Math.max(0, count);
  }

  /** WS-path memory robustness: a stuck WebSocket consumer was closed (1013). */
  recordWsSlowClientClosed(_reason: string): void {
    this.wsSlowClientsClosedTotal += 1;
  }

  /** WS-path memory robustness: heap-pressure shed mode armed/disarmed. */
  setMemoryShed(active: boolean): void {
    this.memoryShedActive = active;
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
        brokerPublishBytesTotal: this.brokerPublishBytesTotal,
        brokerEventsTruncatedTotal: this.brokerEventsTruncatedTotal,
        brokerEventsCoalescedTotal: this.brokerEventsCoalescedTotal,
        eventLoopLagMs: this.eventLoopLagMs,
        eventLoopLagWindow: this.lagWindowSnapshot(now),
        wsUpdatesQueuedTotal: this.wsUpdatesQueuedTotal,
        wsSlowClientsClosedTotal: this.wsSlowClientsClosedTotal,
        memoryShedActive: this.memoryShedActive,
        ...(this.lastEventAt !== undefined
          ? {
              lastEventAt: new Date(this.lastEventAt).toISOString(),
              lastEventAgeMs: Math.max(0, now - this.lastEventAt),
            }
          : {}),
      },
    };
  }

  private lagWindowSnapshot(now: number): OperationalSnapshot['pipeline']['eventLoopLagWindow'] {
    const values: number[] = [];
    for (let index = 0; index < this.lagSamples.length; index++) {
      const sample = this.lagSamples[index];
      if (!sample) continue;
      if (sample.at <= now - LAG_WINDOW_MS) {
        this.lagSamples[index] = undefined;
      } else if (sample.at <= now) values.push(sample.value);
    }
    values.sort((a, b) => a - b);
    return {
      windowMs: LAG_WINDOW_MS, maxSamples: LAG_MAX_SAMPLES,
      sampleCount: values.length, maxMs: values.at(-1) ?? 0,
      p95Ms: values[Math.ceil(values.length * 0.95) - 1] ?? 0,
      resetAt: this.lagResetAt,
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
