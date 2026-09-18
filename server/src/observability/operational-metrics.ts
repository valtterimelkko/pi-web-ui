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

export type { LatencySnapshot };

/**
 * Phase 8 operational metrics: audio streamed, live-engine health and proposal
 * lifecycle. All counters are process-local, monotonically increasing, bounded
 * in cardinality and testable without a provider (plan Phase 8).
 */
export interface VoiceAudioMetricsSnapshot {
  /** Accepted-and-sent operator PCM bytes (provider input rate). */
  inputBytes: number;
  /** Model PCM bytes emitted to the client (client playback rate). */
  outputBytes: number;
  /** inputBytes converted at the provider input rate (16 kHz mono PCM16). */
  inputMinutes: number;
  /** outputBytes converted at the client playback rate (24 kHz mono PCM16). */
  outputMinutes: number;
}

export interface VoiceLiveMetricsSnapshot {
  /** The engine selected by the server (plan Phase 8 flag). */
  engine: 'gemini-live' | 'cascade';
  /**
   * The provider seat the live engine opens sessions on (the resolved model
   * constant — the same value the bridge sends in every `connect`). `null`
   * until the server states it at startup, so "which model is actually live?"
   * is answerable from the diagnostics response alone.
   */
  model: string | null;
  /** Unexpected live-connection losses (provider session died while live). */
  connectionDrops: number;
  /** Reconnects attempted after a drop (a drop without a resumption handle attempts none). */
  resumptionAttempts: number;
  resumptionSuccesses: number;
  resumptionFailures: number;
  /** successes / attempts, 0 when no attempt has been made. */
  resumptionSuccessRate: number;
  /** Times a lane degraded from the live engine to the cascade (Phase 8 fallback). */
  engineFallbacks: number;
}

/**
 * Proposal lifecycle counters. `reconciled` = the proposal left its live slot
 * without a release (cancelled or replaced): the slot was reconciled, not
 * delivered.
 */
export interface VoiceProposalMetricsSnapshot {
  created: number;
  released: number;
  refused: number;
  reconciled: number;
}

/**
 * P10 Voice Mode metrics (docs/plans/VOICE-MODE-OBSERVABILITY-DESIGN.md D3).
 * Same doctrine as every other section: process-local, low-cardinality,
 * no session ids, no prompt text. Labels are bounded like the other dynamic
 * maps; gate denials are healthy outcomes, not errors.
 */
export interface VoiceMetricsSnapshot {
  /** voice_turn_total{phase} */
  turnTotal: Record<string, number>;
  /** voice_release_total{mechanism,outcome}, key "${mechanism}:${outcome}"; refusals (no mechanism) use "none:refused". */
  releaseTotal: Record<string, number>;
  /** voice_gate_denied_total{reason} — nothing_pending | lapsed | ambiguous | cancel_classified */
  gateDeniedTotal: Record<string, number>;
  /** voice_receipt_ack_total */
  receiptAckTotal: number;
  /** voice_turn_duration_ms */
  turnDuration: LatencySnapshot;
  /** voice_model_latency_ms */
  modelLatency: LatencySnapshot;
  /** voice_delivery_latency_ms{mechanism} — the delivery-adapter call duration */
  deliveryLatency: Record<string, LatencySnapshot>;
  /** Phase 8: audio streamed in/out. */
  audio: VoiceAudioMetricsSnapshot;
  /** Phase 8: live connection drops, resumption and engine fallback. */
  live: VoiceLiveMetricsSnapshot;
  /** Phase 8: proposal lifecycle. */
  proposals: VoiceProposalMetricsSnapshot;
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

/** PCM16 mono bytes in one minute at the provider input rate (16 kHz). */
const VOICE_INPUT_BYTES_PER_MINUTE = 16_000 * 2 * 60;
/** PCM16 mono bytes in one minute at the client playback rate (24 kHz). */
const VOICE_OUTPUT_BYTES_PER_MINUTE = 24_000 * 2 * 60;

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
    brokerReplayRetainedBytes: number;
    brokerReplayKeys: number;
    brokerReplayEvictedEventsTotal: number;
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
  /** P10 Voice Mode turn/release/gate metrics. Present (zeroed) even before any voice activity. */
  voice: VoiceMetricsSnapshot;
}

export interface OperationalMetricsOptions {
  now?: () => number;
}

function recordLatency(target: LatencySnapshot, latencyMs: number): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  const value = Math.floor(latencyMs);
  target.count += 1;
  target.totalMs += value;
  target.maxMs = Math.max(target.maxMs, value);
  if (value <= 1_000) target.buckets.le1000 += 1;
  if (value <= 5_000) target.buckets.le5000 += 1;
  if (value <= 30_000) target.buckets.le30000 += 1;
  else target.buckets.gt30000 += 1;
}

function newLatencySnapshot(): LatencySnapshot {
  return {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    buckets: { le1000: 0, le5000: 0, le30000: 0, gt30000: 0 },
  };
}

function newTurnMetrics(): TurnMetricsSnapshot {
  return {
    accepted: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    latency: newLatencySnapshot(),
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
  private brokerReplayRetainedBytes = 0;
  private brokerReplayKeys = 0;
  private brokerReplayEvictedEventsTotal = 0;
  private eventLoopLagMs = 0;
  private readonly lagSamples: Array<{ at: number; value: number } | undefined> = new Array(LAG_MAX_SAMPLES);
  private lagCursor = 0;
  private readonly lagResetAt: string;
  private wsUpdatesQueuedTotal = 0;
  private wsSlowClientsClosedTotal = 0;
  private memoryShedActive = false;
  private lastEventAt?: number;
  // P10 voice metrics (low-cardinality; labels bounded via incrementBounded).
  private readonly voiceTurnTotal = new Map<string, number>();
  private readonly voiceReleaseTotal = new Map<string, number>();
  private readonly voiceGateDeniedTotal = new Map<string, number>();
  private voiceReceiptAckTotal = 0;
  private readonly voiceTurnDuration = newLatencySnapshot();
  private readonly voiceModelLatency = newLatencySnapshot();
  private readonly voiceDeliveryLatency = new Map<string, LatencySnapshot>();
  // Phase 8 operational counters (monotonic, no labels, no session ids).
  private voiceEngine: 'gemini-live' | 'cascade' = 'cascade';
  private voiceLiveModel: string | null = null;
  private voiceAudioInputBytes = 0;
  private voiceAudioOutputBytes = 0;
  private voiceConnectionDrops = 0;
  private voiceResumptionAttempts = 0;
  private voiceResumptionSuccesses = 0;
  private voiceResumptionFailures = 0;
  private voiceEngineFallbacks = 0;
  private voiceProposalCreated = 0;
  private voiceProposalReleased = 0;
  private voiceProposalRefused = 0;
  private voiceProposalReconciled = 0;

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

  /** Aggregate broker replay retention (gauge, set by the broker owner). */
  setBrokerReplayState(retainedBytes: number, keys: number): void {
    this.brokerReplayRetainedBytes = Math.max(0, Math.round(retainedBytes));
    this.brokerReplayKeys = Math.max(0, Math.round(keys));
  }

  recordBrokerReplayEviction(events = 1): void {
    this.brokerReplayEvictedEventsTotal += Math.max(0, events);
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

  /** P10 D3: voice_turn_total{phase}. */
  recordVoiceTurn(phase: string): number {
    return incrementBounded(this.voiceTurnTotal, boundedLabel(phase, 'unknown'));
  }

  /** P10 D3: voice_release_total{mechanism,outcome}. */
  recordVoiceRelease(mechanism: string, outcome: string): number {
    return incrementBounded(this.voiceReleaseTotal, boundedLabel(`${mechanism}:${outcome}`, 'unknown'));
  }

  /** P10 D3: voice_gate_denied_total{reason}. Denials are healthy, not errors. */
  recordVoiceGateDenied(reason: string): number {
    return incrementBounded(this.voiceGateDeniedTotal, boundedLabel(reason, 'unknown'));
  }

  /** P10 D3: voice_receipt_ack_total. */
  recordVoiceReceiptAck(): void {
    this.voiceReceiptAckTotal += 1;
  }

  /** P10 D3: voice_turn_duration_ms. */
  recordVoiceTurnDuration(latencyMs: number): void {
    recordLatency(this.voiceTurnDuration, latencyMs);
  }

  /** P10 D3: voice_model_latency_ms. */
  recordVoiceModelLatency(latencyMs: number): void {
    recordLatency(this.voiceModelLatency, latencyMs);
  }

  /** P10 D3: voice_delivery_latency_ms{mechanism} — adapter call duration. */
  recordVoiceDeliveryLatency(mechanism: string, latencyMs: number): void {
    // Bounded label space, same rule as incrementBounded: beyond the cap a new
    // mechanism folds into 'other' instead of growing cardinality.
    const label = boundedLabel(mechanism, 'unknown');
    const key = this.voiceDeliveryLatency.has(label) || this.voiceDeliveryLatency.size < MAX_DYNAMIC_CATEGORIES
      ? label
      : 'other';
    let snapshot = this.voiceDeliveryLatency.get(key);
    if (!snapshot) {
      snapshot = newLatencySnapshot();
      this.voiceDeliveryLatency.set(key, snapshot);
    }
    recordLatency(snapshot, latencyMs);
  }

  // ── Phase 8: live-engine and proposal operational counters ─────────────

  /** The engine selected by the server (config flag); a gauge, last write wins. */
  setVoiceEngine(engine: 'gemini-live' | 'cascade'): void {
    this.voiceEngine = engine;
  }

  /**
   * The live provider model actually in use (server startup states it); a
   * gauge, last write wins. `null` means "not stated", never an assumed seat.
   */
  setVoiceLiveModel(model: string | null): void {
    this.voiceLiveModel = model;
  }

  /** Accepted-and-sent operator PCM bytes (provider input rate). */
  recordVoiceAudioInput(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    this.voiceAudioInputBytes += Math.round(bytes);
  }

  /** Model PCM bytes emitted to the client (client playback rate). */
  recordVoiceAudioOutput(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    this.voiceAudioOutputBytes += Math.round(bytes);
  }

  /** An unexpected live-connection loss. */
  recordVoiceLiveDrop(): void {
    this.voiceConnectionDrops += 1;
  }

  /** A reconnect attempt started after a drop. */
  recordVoiceResumptionAttempt(): void {
    this.voiceResumptionAttempts += 1;
  }

  /** A reconnect attempt that reached setup complete again. */
  recordVoiceResumptionSuccess(): void {
    this.voiceResumptionSuccesses += 1;
  }

  /** A reconnect attempt that ended fatally. */
  recordVoiceResumptionFailure(): void {
    this.voiceResumptionFailures += 1;
  }

  /** A lane degraded from the live engine to the Gemma cascade. */
  recordVoiceEngineFallback(): void {
    this.voiceEngineFallbacks += 1;
  }

  recordVoiceProposalCreated(): void {
    this.voiceProposalCreated += 1;
  }

  recordVoiceProposalReleased(): void {
    this.voiceProposalReleased += 1;
  }

  recordVoiceProposalRefused(): void {
    this.voiceProposalRefused += 1;
  }

  /** A proposal left its live slot without a release (cancelled/replaced). */
  recordVoiceProposalReconciled(): void {
    this.voiceProposalReconciled += 1;
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
        brokerReplayRetainedBytes: this.brokerReplayRetainedBytes,
        brokerReplayKeys: this.brokerReplayKeys,
        brokerReplayEvictedEventsTotal: this.brokerReplayEvictedEventsTotal,
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
      voice: this.voiceSnapshot(),
    };
  }

  private voiceSnapshot(): VoiceMetricsSnapshot {
    const attempts = this.voiceResumptionAttempts;
    return {
      turnTotal: Object.fromEntries(this.voiceTurnTotal),
      releaseTotal: Object.fromEntries(this.voiceReleaseTotal),
      gateDeniedTotal: Object.fromEntries(this.voiceGateDeniedTotal),
      receiptAckTotal: this.voiceReceiptAckTotal,
      turnDuration: structuredClone(this.voiceTurnDuration),
      modelLatency: structuredClone(this.voiceModelLatency),
      deliveryLatency: Object.fromEntries(
        [...this.voiceDeliveryLatency].map(([mechanism, latency]) => [mechanism, structuredClone(latency)]),
      ),
      audio: {
        inputBytes: this.voiceAudioInputBytes,
        outputBytes: this.voiceAudioOutputBytes,
        inputMinutes: roundMinutes(this.voiceAudioInputBytes, VOICE_INPUT_BYTES_PER_MINUTE),
        outputMinutes: roundMinutes(this.voiceAudioOutputBytes, VOICE_OUTPUT_BYTES_PER_MINUTE),
      },
      live: {
        engine: this.voiceEngine,
        model: this.voiceLiveModel,
        connectionDrops: this.voiceConnectionDrops,
        resumptionAttempts: attempts,
        resumptionSuccesses: this.voiceResumptionSuccesses,
        resumptionFailures: this.voiceResumptionFailures,
        resumptionSuccessRate: attempts === 0 ? 0 : round4(this.voiceResumptionSuccesses / attempts),
        engineFallbacks: this.voiceEngineFallbacks,
      },
      proposals: {
        created: this.voiceProposalCreated,
        released: this.voiceProposalReleased,
        refused: this.voiceProposalRefused,
        reconciled: this.voiceProposalReconciled,
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

function roundMinutes(bytes: number, bytesPerMinute: number): number {
  if (bytes === 0) return 0;
  return Math.round((bytes / bytesPerMinute) * 1_000) / 1_000;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

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
