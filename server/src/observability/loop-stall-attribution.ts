import { createLogger } from '../logging/logger.js';
import { getCorrelationContext, runOutsideCorrelation } from '../logging/correlation.js';

/**
 * B1.2 event-loop stall attribution.
 *
 * A2 telemetry proved production event-loop lag spikes (up to 919 ms) that the
 * API-only soak never reproduced, and timing correlation alone is not
 * attribution. This module does two bounded, cheap things:
 *
 *   1. **Names the synchronous work.** `span()` / `spanAsync()` wrap a named
 *      operation and record its measured duration, plus the innermost label
 *      that is active.
 *   2. **Measures the stall, not the overlap.** A self-rescheduling timer
 *      measures how late it actually ran. A late tick is a *measured* block of
 *      the event loop (timers could not run); the label stack at that instant
 *      names the operation that was on the loop. Because an overdue tick can
 *      only run after the blocking span has exited, the stall additionally
 *      records `blockedBy`: every recently-completed span whose measured
 *      window contains the instant the tick was due. That window overlap is
 *      direct evidence of the blocker, not a timing coincidence.
 *
 * Cost and bounds (documented in docs/OBSERVABILITY.md):
 *   - enter/exit is a stack push/pop, no allocation on the hot path;
 *   - two `performance.now()` calls per instrumented span;
 *   - only spans at or over `spanThresholdMs` and stalls at or over
 *     `stallThresholdMs` are retained, in fixed-size rings;
 *   - label cardinality is capped (`maxLabels`), so an unexpected label can
 *     never grow the process unboundedly;
 *   - the sampling timer is unref'd, so it never keeps the process alive.
 *
 * It is deliberately provider-free and model-free: every number it reports is
 * measured from the process clock.
 *
 * Correlation hygiene (G2): the sampler's timer chain is scheduled — and every
 * tick runs — outside any logging correlation context, so a session's ids can
 * never stick to later stall lines through the chain (the 2026-09-30 finding:
 * all stall lines since a restart carried the first session's ids). Instead,
 * each span frame captures the ids of the context that entered it, and a stall
 * carries the innermost active frame's ids: correct ids while a run's work is
 * on the loop, none after the run ends.
 */

export type LoopSpanKind = 'sync' | 'async';

/** A measured span whose window contains a missed tick (the direct blocker evidence). */
export interface LoopBlockingSpan {
  name: string;
  durationMs: number;
}

/**
 * Correlation ids captured from the logging context when the span enclosing a
 * stall was entered. Captured at `enter()` time — never read from the ambient
 * context at emit time — so a finished run's ids cannot stick to later stalls
 * (the sampler's timer chain runs detached; see `start()`).
 */
export interface LoopStallContext {
  requestId?: string;
  runId?: string;
  sessionId?: string;
  runtime?: string;
  executionInstanceId?: string;
}

export interface LoopStallEvent {
  kind: 'stall';
  label: string;
  delayMs: number;
  atMs: number;
  stack: string[];
  blockedBy: LoopBlockingSpan[];
  /** Ids of the run whose span was active when the stall fired (absent when none). */
  context?: LoopStallContext;
}

export interface LoopSpanEvent {
  kind: 'span';
  spanKind: LoopSpanKind;
  label: string;
  durationMs: number;
  atMs: number;
}

export type LoopStallRecordEvent = LoopStallEvent | LoopSpanEvent;

export interface LoopStallTimerHandle {
  unref?: () => void;
}

export interface LoopStallAttributorOptions {
  /** Sampling interval. 25 ms is cheap and detects stalls ≥ the threshold. */
  intervalMs?: number;
  /** A tick later than this is a recorded stall (default 50 ms). */
  stallThresholdMs?: number;
  /** A span at or over this is recorded (default 100 ms). */
  spanThresholdMs?: number;
  maxStalls?: number;
  maxSpans?: number;
  maxLabels?: number;
  now?: () => number;
  /** Scheduler seam (defaults to `setTimeout`); tests inject a fake clock. */
  schedule?: (fn: () => void, ms: number) => LoopStallTimerHandle;
  cancel?: (handle: LoopStallTimerHandle) => void;
  /** Bounded, best-effort sink for recorded events (never allowed to throw). */
  onRecord?: (event: LoopStallRecordEvent) => void;
}

export interface LoopStallRecord {
  atMs: number;
  delayMs: number;
  label: string;
  stack: string[];
  blockedBy: LoopBlockingSpan[];
  context?: LoopStallContext;
}

export interface LoopSpanRecord {
  kind: LoopSpanKind;
  name: string;
  durationMs: number;
  atMs: number;
}

export interface LoopLabelStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface LoopSpanLabelStats extends LoopLabelStats {
  overThreshold: number;
}

export interface LoopAttributionSnapshot {
  running: boolean;
  /** Ticks the sampler actually performed. */
  sampledTicks: number;
  /** Recorded stalls (at or over the threshold), including ones evicted from the ring. */
  stallCount: number;
  /** Newest-last bounded ring of stall records. */
  stalls: LoopStallRecord[];
  stallsByLabel: Record<string, LoopLabelStats>;
  /** Recorded over-threshold spans, including ones evicted from the ring. */
  spanCount: number;
  spansOverThreshold: LoopSpanRecord[];
  spansByName: Record<string, LoopSpanLabelStats>;
}

const DEFAULT_INTERVAL_MS = 25;
const DEFAULT_STALL_THRESHOLD_MS = 50;
const DEFAULT_SPAN_THRESHOLD_MS = 100;
const DEFAULT_MAX_STALLS = 50;
const DEFAULT_MAX_SPANS = 50;
const DEFAULT_MAX_LABELS = 64;
const MAX_RECENT_SPANS = 32;
const NO_LABEL = '<none>';
const OTHER_LABEL = '<other>';

/** One active label plus the correlation ids of the context that entered it. */
interface LabelFrame {
  label: string;
  context?: LoopStallContext;
}

/** Snapshot the correlation ids of the context entering a span, if any. */
function captureStallContext(): LoopStallContext | undefined {
  const store = getCorrelationContext();
  if (!store) return undefined;
  const context: LoopStallContext = {};
  if (typeof store.requestId === 'string') context.requestId = store.requestId;
  if (typeof store.runId === 'string') context.runId = store.runId;
  if (typeof store.sessionId === 'string') context.sessionId = store.sessionId;
  if (typeof store.runtime === 'string') context.runtime = store.runtime;
  if (typeof store.executionInstanceId === 'string') context.executionInstanceId = store.executionInstanceId;
  return Object.keys(context).length > 0 ? context : undefined;
}

const logger = createLogger('LoopAttribution');

export class LoopStallAttributor {
  private readonly intervalMs: number;
  private readonly stallThresholdMs: number;
  private readonly spanThresholdMs: number;
  private readonly maxStalls: number;
  private readonly maxSpans: number;
  private readonly maxLabels: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => LoopStallTimerHandle;
  private readonly cancel: (handle: LoopStallTimerHandle) => void;
  private onRecord?: (event: LoopStallRecordEvent) => void;

  private timer?: LoopStallTimerHandle;
  private expectedAt = 0;
  private frames: LabelFrame[] = [];
  private sampledTicks = 0;

  private stallCount = 0;
  private readonly stalls: LoopStallRecord[] = [];
  private readonly stallsByLabel = new Map<string, LoopLabelStats>();

  private spanCount = 0;
  private readonly spans: LoopSpanRecord[] = [];
  /** Every completed span (bounded), so a missed tick can name its cover. */
  private readonly recentSpans: LoopSpanRecord[] = [];
  private readonly spansByName = new Map<string, LoopSpanLabelStats>();

  constructor(options: LoopStallAttributorOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.spanThresholdMs = options.spanThresholdMs ?? DEFAULT_SPAN_THRESHOLD_MS;
    this.maxStalls = options.maxStalls ?? DEFAULT_MAX_STALLS;
    this.maxSpans = options.maxSpans ?? DEFAULT_MAX_SPANS;
    this.maxLabels = options.maxLabels ?? DEFAULT_MAX_LABELS;
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onRecord = options.onRecord;
    this.validate();
  }

  private validate(): void {
    for (const [name, value] of Object.entries({
      intervalMs: this.intervalMs,
      stallThresholdMs: this.stallThresholdMs,
      spanThresholdMs: this.spanThresholdMs,
      maxStalls: this.maxStalls,
      maxSpans: this.maxSpans,
      maxLabels: this.maxLabels,
    })) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`loop-stall-attribution: ${name} must be a positive number (got ${value}).`);
      }
    }
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Outermost-first active label stack (test seam; bounded by `maxLabels`). */
  get currentStack(): string[] {
    return this.frames.map((frame) => frame.label);
  }

  setRecordSink(onRecord: ((event: LoopStallRecordEvent) => void) | undefined): void {
    this.onRecord = onRecord;
  }

  start(): void {
    if (this.timer) return;
    this.expectedAt = this.now() + this.intervalMs;
    // The first start() usually happens inside a session create's
    // withCorrelation scope. This sampler reschedules itself forever; scheduled
    // here as-is, the whole timer chain would capture that session's
    // AsyncLocalStorage context and stamp its ids onto every later stall line,
    // including long after the session ended (the G2 production finding).
    // Schedule — and therefore run every tick — outside any correlation
    // context; stall records carry ids only via the span frames (see enter()).
    this.timer = runOutsideCorrelation(() => this.schedule(() => this.tick(), this.intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }

  /** Entry point kept on the caller's path; the body runs context-free. */
  private tick(): void {
    runOutsideCorrelation(() => this.tickDetached());
  }

  private tickDetached(): void {
    const now = this.now();
    this.sampledTicks += 1;
    const delayMs = Math.max(0, Math.round(now - this.expectedAt));
    if (delayMs >= this.stallThresholdMs) {
      const innermost = this.frames.length > 0 ? this.frames[this.frames.length - 1] : undefined;
      const label = this.normalizeLabel(innermost ? innermost.label : NO_LABEL);
      const stack = this.frames.map((frame) => frame.label);
      // The overdue tick can only run after a blocking synchronous span exits,
      // so the enclosing label is a level too coarse. Any measured span whose
      // window covers the instant the tick was due is the direct evidence.
      const missedAt = this.expectedAt;
      const blockedBy = this.recentSpans
        .filter((span) => span.atMs <= missedAt && span.atMs + span.durationMs >= missedAt)
        .map((span) => ({ name: span.name, durationMs: span.durationMs }));
      const context = innermost?.context;
      this.recordStall({ atMs: now, delayMs, label, stack, blockedBy, context });
      this.emit({ kind: 'stall', label, delayMs, atMs: now, stack, blockedBy, context });
    }
    this.expectedAt = now + this.intervalMs;
    this.timer = this.schedule(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Push a label; the returned function pops it (idempotent). */
  enter(label: string): () => void {
    const frame: LabelFrame = { label, context: captureStallContext() };
    this.frames.push(frame);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.frames.indexOf(frame);
      if (index >= 0) this.frames.splice(index, 1);
    };
  }

  /** Measure one synchronous operation. */
  span<T>(label: string, fn: () => T): T {
    const startedAt = this.now();
    const exit = this.enter(label);
    try {
      return fn();
    } finally {
      exit();
      this.recordSpan({ kind: 'sync', name: label, durationMs: Math.max(0, this.now() - startedAt), atMs: startedAt });
    }
  }

  /** Measure one asynchronous operation (duration includes awaited work). */
  async spanAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    const exit = this.enter(label);
    try {
      return await fn();
    } finally {
      exit();
      this.recordSpan({ kind: 'async', name: label, durationMs: Math.max(0, this.now() - startedAt), atMs: startedAt });
    }
  }

  private recordStall(record: LoopStallRecord): void {
    this.stallCount += 1;
    this.stalls.push(record);
    while (this.stalls.length > this.maxStalls) this.stalls.shift();
    const stats = this.stallsByLabel.get(record.label) ?? { count: 0, totalMs: 0, maxMs: 0 };
    stats.count += 1;
    stats.totalMs += record.delayMs;
    stats.maxMs = Math.max(stats.maxMs, record.delayMs);
    this.stallsByLabel.set(record.label, stats);
  }

  private recordSpan(record: LoopSpanRecord): void {
    this.spanCount += 1;
    this.recentSpans.push(record);
    while (this.recentSpans.length > MAX_RECENT_SPANS) this.recentSpans.shift();
    const name = this.normalizeLabel(record.name);
    const stats = this.spansByName.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, overThreshold: 0 };
    stats.count += 1;
    stats.totalMs += record.durationMs;
    stats.maxMs = Math.max(stats.maxMs, record.durationMs);
    if (record.durationMs >= this.spanThresholdMs) {
      stats.overThreshold += 1;
      this.spans.push({ ...record, name });
      while (this.spans.length > this.maxSpans) this.spans.shift();
      this.emit({ kind: 'span', spanKind: record.kind, label: name, durationMs: record.durationMs, atMs: record.atMs });
    }
    this.spansByName.set(name, stats);
  }

  /**
   * Keep cardinality bounded: labels are static strings in this codebase, but a
   * label injected from data must not be able to grow the maps without limit.
   */
  private normalizeLabel(label: string): string {
    if (this.stallsByLabel.has(label) || this.spansByName.has(label)) return label;
    const known = new Set([...this.stallsByLabel.keys(), ...this.spansByName.keys()]);
    if (known.size >= this.maxLabels) return OTHER_LABEL;
    return label;
  }

  private emit(event: LoopStallRecordEvent): void {
    if (!this.onRecord) return;
    try {
      this.onRecord(event);
    } catch {
      // Measurement must never be able to take down the measured path.
    }
  }

  snapshot(): LoopAttributionSnapshot {
    return {
      running: this.running,
      sampledTicks: this.sampledTicks,
      stallCount: this.stallCount,
      stalls: this.stalls.map((record) => ({ ...record, stack: [...record.stack], blockedBy: record.blockedBy.map((span) => ({ ...span })) })),
      stallsByLabel: Object.fromEntries([...this.stallsByLabel].map(([label, stats]) => [label, { ...stats }])),
      spanCount: this.spanCount,
      spansOverThreshold: this.spans.map((record) => ({ ...record })),
      spansByName: Object.fromEntries([...this.spansByName].map(([name, stats]) => [name, { ...stats }])),
    };
  }

  reset(): void {
    this.stop();
    this.frames = [];
    this.sampledTicks = 0;
    this.stallCount = 0;
    this.stalls.length = 0;
    this.stallsByLabel.clear();
    this.spanCount = 0;
    this.spans.length = 0;
    this.recentSpans.length = 0;
    this.spansByName.clear();
  }
}

export interface LoopStallLogSink {
  warn(message: string): void;
}

export interface LoopStallLogReporterOptions {
  now?: () => number;
  /** Per-label floor between log lines (default 5 s). */
  minIntervalMs?: number;
}

/**
 * Bounded reporter: at most one log line per label per `minIntervalMs`, so a
 * stall storm cannot itself become the stall. The central logger's tap feeds
 * the diagnostics ring buffer, which is where `GET /api/v1/diagnostics` reads.
 */
export function createLoopStallLogReporter(
  sink: LoopStallLogSink = logger,
  options: LoopStallLogReporterOptions = {},
): (event: LoopStallRecordEvent) => void {
  const now = options.now ?? (() => Date.now());
  const minIntervalMs = options.minIntervalMs ?? 5_000;
  const lastLoggedAt = new Map<string, number>();

  return (event) => {
    try {
      const at = now();
      const previous = lastLoggedAt.get(event.label);
      if (previous !== undefined && at - previous < minIntervalMs) return;
      lastLoggedAt.set(event.label, at);
      if (event.kind === 'stall') {
        const blocker = event.blockedBy.length > 0
          ? ` blocked by ${event.blockedBy.map((span) => `${span.name} (${Math.round(span.durationMs)} ms)`).join(', ')}`
          : '';
        sink.warn(
          `event-loop stall ${event.delayMs} ms attributed to ${event.label}` +
          formatStallContextSuffix(event.context) +
          (event.stack.length > 1 ? ` (stack ${event.stack.join(' > ')})` : '') +
          blocker,
        );
      } else {
        sink.warn(`${event.spanKind} span ${event.durationMs} ms: ${event.label}`);
      }
    } catch {
      // A logging failure must never break the instrumented path.
    }
  };
}

/**
 * Render a stall's captured run ids in the central logger's correlation-suffix
 * style (` [req=… run=… sid=… rt=… exec=…]`), so stall lines stay greppable the
 * same way after the sampler itself stopped inheriting the ambient context.
 */
function formatStallContextSuffix(context: LoopStallContext | undefined): string {
  if (!context) return '';
  const parts: string[] = [];
  if (context.requestId) parts.push(`req=${context.requestId}`);
  if (context.runId) parts.push(`run=${context.runId}`);
  if (context.sessionId) parts.push(`sid=${context.sessionId}`);
  if (context.runtime) parts.push(`rt=${context.runtime}`);
  if (context.executionInstanceId) parts.push(`exec=${context.executionInstanceId}`);
  return parts.length ? ` [${parts.join(' ')}]` : '';
}

let globalAttributor: LoopStallAttributor | undefined;

/** The process-wide attributor, started on first use (like the shed monitor). */
export function getLoopStallAttributor(): LoopStallAttributor {
  globalAttributor ??= new LoopStallAttributor({
    // Under the test runner the sampler still runs (unref'd, cheap) but never
    // writes app log output through the central logger.
    onRecord: process.env.VITEST ? undefined : createLoopStallLogReporter(),
  });
  globalAttributor.start();
  return globalAttributor;
}

/** Read-only accessor: never creates or starts the process-wide attributor. */
export function readLoopStallAttribution(): LoopAttributionSnapshot | undefined {
  return globalAttributor?.snapshot();
}

/** Test seam. */
export function resetLoopStallAttributor(): void {
  globalAttributor?.reset();
  globalAttributor = undefined;
}
