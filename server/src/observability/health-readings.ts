import { getHeapStatistics } from 'node:v8';
import { readEventLoopLagWindow, type EventLoopLagWindow } from '../internal-api/event-loop-shed.js';
import { getOperationalMetrics, type OperationalMetrics } from './operational-metrics.js';

/**
 * A2 heap/event-loop telemetry: one reading of the process health that matters
 * for orchestration admission (A2 in the Orchestration Scaling Readiness Plan).
 *
 * Deliberately small, synchronous and dependency-light so that
 * `getHealthReadings()` is a reusable accessor: B2's admission controller
 * imports `getHealthReadings()` / `readHeapPressure()` rather than re-deriving
 * heap pressure from `process.memoryUsage()` itself.
 */
export interface HealthReadings {
  /** ISO timestamp of the reading. */
  at: string;
  /** Epoch milliseconds of the reading. */
  atMs: number;
  /** Process uptime in seconds (the leak-relevant axis). */
  uptimeSec: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  /** Real V8 `heap_size_limit` — the cap that actually binds, not the committed heap. */
  heapLimitBytes: number;
  /** heapUsedBytes / heapLimitBytes, 0 when the limit is unknown. */
  heapFraction: number;
  rssBytes: number;
  externalBytes: number;
  /** Window the lag percentiles cover (ms). */
  lagWindowMs: number;
  lagSampleCount: number;
  lagP50Ms: number;
  lagP99Ms: number;
  lagMaxMs: number;
  /** Active turns by class/runtime label; `{}` when no source can see them. */
  activeTurnsByClass: Record<string, number>;
  activeTurns: number;
  /** Resident (loaded) sessions, `null` when no source reports them. */
  residentSessions: number | null;
  /** Session-registry entries, `null` when no source reports them. */
  registryEntries: number | null;
}

/** The narrow accessor B2's admission work needs. */
export interface HeapPressureReading {
  heapUsedBytes: number;
  heapLimitBytes: number;
  heapFraction: number;
  lagP99Ms: number;
  lagMaxMs: number;
  atMs: number;
}

export interface AdmissionReading {
  activeTurns: number;
  classes: Record<string, { active: number }>;
}

/**
 * Injectable seams. Every source is optional and fail-open: a missing or
 * throwing source yields a null/zero field, never an exception, so telemetry
 * can never take the control plane down.
 */
export interface HealthReadingSources {
  now?: () => number;
  uptimeSec?: () => number;
  memoryUsage?: () => { heapUsed: number; heapTotal: number; rss: number; external: number };
  heapLimitBytes?: () => number;
  lagWindow?: () => EventLoopLagWindow | undefined;
  admission?: () => AdmissionReading | undefined;
  residentSessions?: () => number | undefined;
  /** Registry entry count; the session registry loads lazily, so this may be async. */
  registryEntries?: () => number | undefined | Promise<number | undefined>;
  /** Default active-turn classes: terminal turn counters from the operational metrics. */
  activeTurnsFromOperationalMetrics?: () => Record<string, number>;
}

/** Real V8 heap ceiling. Falls back to 0 rather than guessing a limit. */
export function readHeapLimitBytes(): number {
  try {
    return getHeapStatistics().heap_size_limit;
  } catch {
    return 0;
  }
}

/**
 * Nearest-rank percentile: `sorted[ceil(p * n) - 1]`. Total on empty input
 * (returns 0) so a lag window with no samples cannot make the maths NaN.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

function safe<T>(read: (() => T | undefined | null) | undefined, fallback: T): T {
  if (!read) return fallback;
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function positiveOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Active turns per runtime, inferred from the operational turn counters. */
function activeTurnsFromOperationalMetrics(metrics: OperationalMetrics = getOperationalMetrics()): Record<string, number> {
  const snapshot = metrics.snapshot();
  const active: Record<string, number> = {};
  for (const [runtime, turn] of Object.entries(snapshot.turns)) {
    if (!turn) continue;
    const terminal = turn.completed + turn.failed + turn.cancelled + turn.interrupted;
    active[runtime] = Math.max(0, turn.accepted - terminal);
  }
  return active;
}

/**
 * Collect one reading from the provided sources (defaults = the real process:
 * `process.memoryUsage()`, the V8 heap limit, the shared lag window and the
 * global operational metrics).
 */
export function collectHealthReadings(sources: HealthReadingSources = {}): HealthReadings {
  const now = safe(sources.now, Date.now());
  const uptimeSec = Math.round(safe(sources.uptimeSec, process.uptime()));
  const processMemory = process.memoryUsage();
  const memory = safe(sources.memoryUsage, {
    heapUsed: processMemory.heapUsed,
    heapTotal: processMemory.heapTotal,
    rss: processMemory.rss,
    external: processMemory.external,
  });
  const heapLimitBytes = Math.max(0, safe(sources.heapLimitBytes, readHeapLimitBytes()));
  const lagWindow = safe(sources.lagWindow, readEventLoopLagWindow());
  const admission = safe<AdmissionReading | undefined>(sources.admission, undefined);

  const classes = admission
    ? Object.fromEntries(Object.entries(admission.classes ?? {}).map(([name, entry]) => [name, entry.active]))
    : safe(sources.activeTurnsFromOperationalMetrics, activeTurnsFromOperationalMetrics());
  const classTotal = Object.values(classes).reduce((sum, value) => sum + value, 0);
  const activeTurns = admission ? admission.activeTurns : classTotal;

  const registryEntriesSource = sources.registryEntries;
  let registryEntries: number | undefined;
  if (registryEntriesSource) {
    try {
      const value = registryEntriesSource();
      // A promise here has not been resolved yet (the sampler resolves async
      // sources first); report it as unmeasured rather than as zero.
      registryEntries = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    } catch {
      registryEntries = undefined;
    }
  }

  return {
    at: new Date(now).toISOString(),
    atMs: now,
    uptimeSec,
    heapUsedBytes: Math.max(0, memory.heapUsed),
    heapTotalBytes: Math.max(0, memory.heapTotal),
    heapLimitBytes,
    heapFraction: heapLimitBytes > 0
      ? Math.round((Math.max(0, memory.heapUsed) / heapLimitBytes) * 1_000_000) / 1_000_000
      : 0,
    rssBytes: Math.max(0, memory.rss),
    externalBytes: Math.max(0, memory.external),
    lagWindowMs: lagWindow?.windowMs ?? 0,
    lagSampleCount: lagWindow?.sampleCount ?? 0,
    lagP50Ms: lagWindow?.p50Ms ?? 0,
    lagP99Ms: lagWindow?.p99Ms ?? 0,
    lagMaxMs: lagWindow?.maxMs ?? 0,
    activeTurnsByClass: classes,
    activeTurns,
    residentSessions: positiveOrNull(safe<number | undefined>(sources.residentSessions, undefined)),
    registryEntries: positiveOrNull(registryEntries),
  };
}

/**
 * Sources registered by process owners (the Pi `MultiSessionManager` registers
 * the resident-session count). Merged, never replaced wholesale, so a second
 * registrar cannot silently drop another's field.
 */
let registeredSources: HealthReadingSources = {};

export function setHealthReadingSources(sources: HealthReadingSources): void {
  registeredSources = { ...registeredSources, ...sources };
}

export function getRegisteredHealthReadingSources(): HealthReadingSources {
  return { ...registeredSources };
}

/** Test seam: drop every registered source. */
export function clearHealthReadingSources(): void {
  registeredSources = {};
}

/** The reusable process-wide accessor (B2 imports this). */
export function getHealthReadings(): HealthReadings {
  return collectHealthReadings(registeredSources);
}

/** The B2-shaped projection: heap pressure and lag, nothing else. */
export function readHeapPressure(): HeapPressureReading {
  const readings = getHealthReadings();
  return {
    heapUsedBytes: readings.heapUsedBytes,
    heapLimitBytes: readings.heapLimitBytes,
    heapFraction: readings.heapFraction,
    lagP99Ms: readings.lagP99Ms,
    lagMaxMs: readings.lagMaxMs,
    atMs: readings.atMs,
  };
}
