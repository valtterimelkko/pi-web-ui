/**
 * Hb3 streaming-path telemetry (plan H3 item 2, G2's R4 proposal).
 *
 * Aggregates, per reading window, three bounded numbers about the Pi streaming
 * path, so an 11:43-type stall can be attributed without per-chunk logging:
 *
 * - **Span summary** — time from provider chunk receipt (the pi-service event
 *   funnel) to transport dispatch (the delivery boundary inside the pi path:
 *   `handleAgentEvent`'s broadcast/observer fan-out, or the single-client
 *   `EventForwarder` send). A span that grows with per-chunk delivery work
 *   (projection, enrichment, subscriber fan-out) names the server side.
 * - **Per-provider chunk rate** — chunks/s and bytes/s per provider, from the
 *   delta events the provider actually sent. G2: "turns 'provider degraded'
 *   from a story into a number".
 * - **Provider gap** — the largest interval between consecutive chunk receipts
 *   inside one open message stream. A provider that pauses mid-stream shows a
 *   large gap with flat spans; a server-side stall shows large spans (or gap
 *   + rising lag/CPU, both already in this metrics stream).
 *
 * Boundaries (documented in docs/OBSERVABILITY.md): receipt is stamped when
 * the pi event funnel runs — a blocked main thread delays receipts too, so a
 * gap must be joint-read with the lag and main-thread CPU fields of the same
 * reading; the span ends at dispatch, before the WebSocket governor's
 * backpressure queue (that queue delay is observable through the existing
 * queued-frame counters and is the WebSocket lane's path, not this one).
 *
 * Cost: per delta chunk the hooks do O(1) map/counter work and no logging;
 * percentiles are computed at window-take time over a bounded sample ring.
 * When disabled, both hooks are one boolean check and the window is never
 * taken (no source is registered).
 */

export interface StreamingSpanSummary {
  /** Exact number of delivered spans observed in the window. */
  count: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface StreamingProviderRate {
  chunks: number;
  bytes: number;
  /** chunks / (windowMs / 1000), rounded to 0.1. */
  chunksPerSec: number;
}

export interface StreamingGapSummary {
  /** Inter-chunk intervals observed inside open message streams. */
  count: number;
  maxMs: number;
  /** Provider of the chunk that closed the max gap. */
  provider: string | null;
}

export interface StreamingWindowSummary {
  windowMs: number;
  /** `null` when no chunk was delivered in the window. */
  spans: StreamingSpanSummary | null;
  /** `null` when no inter-chunk interval was observed in the window. */
  providerGap: StreamingGapSummary | null;
  providers: Record<string, StreamingProviderRate>;
  providersTruncated: boolean;
}

export interface StreamingTelemetryConfig {
  enabled: boolean;
  now: () => number;
  /** Bounded percentile sample ring per window (memory bound, not a rate limit). */
  maxSpanSamples: number;
  /** Provider keys kept per window (highest chunk counts win). */
  maxProviders: number;
  /** Per-session stream-state entries (open-message tracking) kept across windows. */
  maxTrackedSessions: number;
}

export const STREAMING_TELEMETRY_DEFAULTS = {
  maxSpanSamples: 512,
  maxProviders: 8,
  maxTrackedSessions: 128,
} as const;

interface SessionStreamState {
  /** A delta stream is open for this session (message_start seen, no boundary since). */
  streamOpen: boolean;
  lastDeltaAtMs: number;
}

interface OpenSpan {
  sessionId: string;
  provider: string;
  atMs: number;
}

const DELTA_TYPES = new Set(['text_delta', 'thinking_delta', 'toolcall_delta']);

/**
 * Reserved fold bucket (review of 2026-10-02, correction 02 item 1): when a NEW
 * provider key would exceed `maxProviders`, its chunks fold into `other` and
 * `providersTruncated` is set — at INSERT time, so the live map is bounded by
 * construction (at most `maxProviders` real keys + the reserved bucket), never
 * only in the emitted summary. A real provider literally named `other` merges
 * into the fold bucket (documented in docs/OBSERVABILITY.md).
 */
const OTHER_BUCKET = 'other';

let config: StreamingTelemetryConfig | null = null;

// Window accumulators (reset by takeStreamingWindow).
let windowStartedAtMs = 0;
let spanSamples: number[] = [];
let spanCount = 0;
let spanMax = 0;
let gapCount = 0;
let gapMax = 0;
let gapProvider: string | null = null;
let providers = new Map<string, { chunks: number; bytes: number }>();
let providersFolded = false;

// Cross-window state (kept between takes).
const sessionStreams = new Map<string, SessionStreamState>();
let openSpan: OpenSpan | null = null;

/** Resolve `OBSERVABILITY_STREAMING_TELEMETRY` (default on; `off`/`false`/`0`/`no` disable). */
export function resolveStreamingTelemetryEnv(
  env: NodeJS.ProcessEnv,
): { enabled: boolean } {
  const raw = env.OBSERVABILITY_STREAMING_TELEMETRY;
  if (raw === undefined || raw === null || raw === '') return { enabled: true };
  const value = raw.trim().toLowerCase();
  return { enabled: !(value === 'off' || value === 'false' || value === '0' || value === 'no') };
}

/**
 * Configure (or reconfigure) the module. The A2 sampler consumes windows
 * through the sampler-scoped `streaming` reading source, which the health
 * telemetry singleton registers explicitly when it enables this module —
 * never through the shared registered-source map, so the reusable
 * `getHealthReadings()` accessor cannot drain windows as a side effect.
 */
export function configureStreamingTelemetry(options: {
  enabled: boolean;
  now?: () => number;
  maxSpanSamples?: number;
  maxProviders?: number;
  maxTrackedSessions?: number;
}): void {
  config = {
    enabled: options.enabled,
    now: options.now ?? Date.now,
    maxSpanSamples: options.maxSpanSamples ?? STREAMING_TELEMETRY_DEFAULTS.maxSpanSamples,
    maxProviders: options.maxProviders ?? STREAMING_TELEMETRY_DEFAULTS.maxProviders,
    maxTrackedSessions: options.maxTrackedSessions ?? STREAMING_TELEMETRY_DEFAULTS.maxTrackedSessions,
  };
  windowStartedAtMs = config.now();
}

/** Test/ops seam: number of provider buckets currently held in the live window state. */
export function liveStreamingProviderBuckets(): number {
  return providers.size;
}

/** Test seam: whether the hooks currently do aggregation work (module configured enabled). */
export function isStreamingTelemetryEnabled(): boolean {
  return config?.enabled ?? false;
}

/** Test/process teardown seam. */
export function resetStreamingTelemetry(): void {
  config = null;
  windowStartedAtMs = 0;
  spanSamples = [];
  spanCount = 0;
  spanMax = 0;
  gapCount = 0;
  gapMax = 0;
  gapProvider = null;
  providers = new Map();
  providersFolded = false;
  sessionStreams.clear();
  openSpan = null;
}

/** True when a chunk type is a provider delta (one provider chunk each). */
function isDeltaEvent(event: unknown): event is { assistantMessageEvent: { type: string; delta?: string; partial?: { provider?: unknown } } } {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as { type?: unknown; assistantMessageEvent?: { type?: unknown } };
  if (e.type !== 'message_update' || typeof e.assistantMessageEvent !== 'object' || e.assistantMessageEvent === null) {
    return false;
  }
  const eventType = e.assistantMessageEvent.type;
  return typeof eventType === 'string' && DELTA_TYPES.has(eventType);
}

function readProvider(event: { assistantMessageEvent: { partial?: { provider?: unknown } } }): string {
  const provider = event.assistantMessageEvent.partial?.provider;
  return typeof provider === 'string' && provider.length > 0 ? provider : 'unknown';
}

function touchSession(sessionId: string): SessionStreamState {
  let state = sessionStreams.get(sessionId);
  if (!state) {
    state = { streamOpen: false, lastDeltaAtMs: 0 };
    sessionStreams.set(sessionId, state);
    while (sessionStreams.size > (config?.maxTrackedSessions ?? STREAMING_TELEMETRY_DEFAULTS.maxTrackedSessions)) {
      // Map preserves insertion order: drop the oldest entry.
      const oldest = sessionStreams.keys().next();
      if (oldest.done) break;
      sessionStreams.delete(oldest.value);
    }
  }
  return state;
}

function clearSessionStream(sessionId: string): void {
  const state = sessionStreams.get(sessionId);
  if (state) {
    state.streamOpen = false;
    state.lastDeltaAtMs = 0;
  }
}

function closeOpenSpan(): void {
  openSpan = null;
}

/**
 * Hook (pi event funnel, receipt side). Called for EVERY session event; only
 * provider deltas and message boundaries do work. One boolean check when the
 * module is disabled.
 */
export function observeStreamingChunkReceipt(sessionId: string, event: unknown): void {
  if (!config?.enabled) return;
  const type = (event as { type?: unknown } | null | undefined)?.type;

  if (type === 'message_start' || type === 'message_end' || type === 'agent_start') {
    // A new message stream (or a new turn) invalidates any half-open stream:
    // a gap is only meaningful between deltas of one open stream.
    clearSessionStream(sessionId);
    if (type === 'agent_start') closeOpenSpan();
    return;
  }
  if (!isDeltaEvent(event)) return;

  const nowMs = config.now();
  const provider = readProvider(event);
  const bytes = typeof event.assistantMessageEvent.delta === 'string' ? event.assistantMessageEvent.delta.length : 0;

  // Per-provider window rate — capped ON INSERT: the first `maxProviders`
  // distinct providers keep their buckets; every later provider folds into the
  // reserved `other` bucket, so the live map stays bounded by construction.
  let key = provider;
  let bucket = providers.get(key);
  if (!bucket && key !== OTHER_BUCKET && providers.size >= config.maxProviders) {
    key = OTHER_BUCKET;
    bucket = providers.get(key);
    providersFolded = true;
  }
  if (!bucket) {
    bucket = { chunks: 0, bytes: 0 };
    providers.set(key, bucket);
  }
  bucket.chunks += 1;
  bucket.bytes += bytes;

  // Provider gap: interval since the previous delta of this open stream.
  const state = touchSession(sessionId);
  if (state.streamOpen && state.lastDeltaAtMs > 0) {
    const gap = Math.max(0, nowMs - state.lastDeltaAtMs);
    gapCount += 1;
    if (gap >= gapMax) {
      gapMax = gap;
      gapProvider = provider;
    }
  }
  state.streamOpen = true;
  state.lastDeltaAtMs = nowMs;

  // Open the delivery span; an unterminated previous span is abandoned.
  openSpan = { sessionId, provider, atMs: nowMs };
}

/**
 * Hook (delivery side). Closes the open span for the chunk that is being
 * dispatched right now. Receipt→delivery is synchronous (single JS thread),
 * so at most one span is open at any moment; a call with no open span is a
 * no-op (non-chunk events, or a window boundary abandoned the span).
 */
export function observeStreamingChunkDelivered(): void {
  if (!config?.enabled) return;
  const span = openSpan;
  if (!span) return;
  closeOpenSpan();
  const nowMs = config.now();
  const duration = Math.max(0, nowMs - span.atMs);
  spanCount += 1;
  if (duration > spanMax) spanMax = duration;
  spanSamples.push(duration);
  if (spanSamples.length > config.maxSpanSamples) {
    spanSamples.splice(0, spanSamples.length - config.maxSpanSamples);
  }
}

/** Nearest-rank percentile over ascending-sorted input (bounded ring). */
function percentileFromSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Close the current window and return its summary (the sampler calls this
 * once per reading). `null` when the module is disabled. An open (never
 * delivered) span is abandoned without being counted.
 */
export function takeStreamingWindow(): StreamingWindowSummary | null {
  if (!config?.enabled) return null;
  const nowMs = config.now();
  const windowMs = Math.max(1, nowMs - windowStartedAtMs);
  windowStartedAtMs = nowMs;

  closeOpenSpan();

  const sorted = [...spanSamples].sort((a, b) => a - b);
  const spans: StreamingSpanSummary | null = spanCount > 0
    ? {
        count: spanCount,
        p50Ms: percentileFromSorted(sorted, 0.5),
        p99Ms: percentileFromSorted(sorted, 0.99),
        maxMs: spanMax,
      }
    : null;

  const providerGap: StreamingGapSummary | null = gapCount > 0
    ? { count: gapCount, maxMs: gapMax, provider: gapProvider }
    : null;

  const seconds = windowMs / 1000;
  // The live map is already bounded (insert-time fold); emit it as-is.
  const providersSummary: Record<string, StreamingProviderRate> = {};
  for (const [name, bucket] of providers) {
    providersSummary[name] = {
      chunks: bucket.chunks,
      bytes: bucket.bytes,
      chunksPerSec: Math.round((bucket.chunks / seconds) * 10) / 10,
    };
  }

  // Reset window accumulators; cross-window session/stream state is kept.
  spanSamples = [];
  spanCount = 0;
  spanMax = 0;
  gapCount = 0;
  gapMax = 0;
  gapProvider = null;
  providers = new Map();
  const providersTruncated = providersFolded;
  providersFolded = false;

  return { windowMs, spans, providerGap, providers: providersSummary, providersTruncated };
}
