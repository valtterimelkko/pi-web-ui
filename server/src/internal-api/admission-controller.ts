import { readFileSync } from 'fs';
import { availableParallelism } from 'os';
import { getHeapStatistics } from 'v8';
import {
  readServiceMemoryCapacity,
  readServicePidsCapacity,
  readServiceMemoryEvents,
  type CgroupMemorySource,
  type ResolvedPidsCapacity,
  type ResolvedMemoryEvents,
} from './cgroup-capacity.js';
import { readHostPressure, type ResolvedHostPressure } from './host-pressure.js';
import type { SessionRuntime } from './types.js';

export type AdmissionRefusalReason = 'global_limit' | 'runtime_limit' | 'memory_pressure' | 'pid_pressure' | 'host_memory_pressure' | 'heap_pressure' | 'event_loop_lag' | 'draining';

/** Turn-slot refusals: retryable throttling (429). Every other reason means the
 * process is under resource pressure or draining (503). */
const SLOT_REFUSALS = new Set<AdmissionRefusalReason>(['global_limit', 'runtime_limit']);

/** HTTP status for an admission refusal: 429 for turn-slot saturation, 503 for
 * pressure (memory, PID, host, heap, event-loop lag) and draining. */
export function admissionRefusalHttpStatus(reason: AdmissionRefusalReason): 429 | 503 {
  return SLOT_REFUSALS.has(reason) ? 429 : 503;
}

/** One V8 heap reading: used bytes against the real `heap_size_limit`. */
export interface HeapReading {
  usedBytes: number;
  limitBytes: number;
}

/** One A2 lag reading (the p99 of the sampler's lag window). */
export interface LagReading {
  p99Ms: number;
  atMs: number;
  /** Samples behind the p99; a reading with no samples carries no information. */
  sampleCount?: number;
}

/** Validation-only pressure injection (see {@link createValidationPressureOverride}). */
export interface AdmissionPressureOverride {
  heapUsedBytes: () => number | undefined;
  lagP99Ms: () => number | undefined;
}

function readV8Heap(): HeapReading {
  const stats = getHeapStatistics();
  return { usedBytes: stats.used_heap_size, limitBytes: stats.heap_size_limit };
}

/**
 * Test-only pressure knob for disposable live validation. Honoured only when
 * `PI_WEB_UI_VALIDATION_MODE=true` and `INTERNAL_API_ADMISSION_TEST_PRESSURE_FILE`
 * names a JSON file `{ "heapUsedBytes"?: number, "lagP99Ms"?: number }`. The
 * file is re-read on every evaluation so a validation run can raise and clear
 * pressure without restarting; a missing or malformed file means "no override"
 * (real readings). Production never enables validation mode.
 */
export function createValidationPressureOverride(env: NodeJS.ProcessEnv = process.env): AdmissionPressureOverride | undefined {
  const file = env.INTERNAL_API_ADMISSION_TEST_PRESSURE_FILE?.trim();
  if (env.PI_WEB_UI_VALIDATION_MODE !== 'true' || !file) return undefined;
  const read = (key: 'heapUsedBytes' | 'lagP99Ms'): number | undefined => {
    try {
      const value = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)[key];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return { heapUsedBytes: () => read('heapUsedBytes'), lagP99Ms: () => read('lagP99Ms') };
}

/**
 * Execution priority class. P0 (browser) and P1 (Agent OS control) are
 * non-execution control with reserved capacity; P2 (ordinary API execution)
 * and P3 (bulk) are execution. Priority is server-derived, never caller-trusted.
 */
export type AdmissionClass = 'P0' | 'P1' | 'P2' | 'P3';
const CONTROL_CLASSES = new Set<AdmissionClass>(['P0', 'P1']);
const ADMISSION_CLASSES: AdmissionClass[] = ['P0', 'P1', 'P2', 'P3'];

export class AdmissionCapacityError extends Error {
  constructor(public readonly reason: AdmissionRefusalReason, public readonly retryAfterSeconds = 2, detail?: string) {
    super(`Internal API admission refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'AdmissionCapacityError';
  }
}

export interface MemoryCapacity {
  currentBytes: number;
  limitBytes: number;
  /** Memory.high soft boundary when readable from the cgroup. */
  highBytes?: number;
  /** Where current/limit were read from: the service cgroup, the cgroup root, or process RSS. */
  source?: CgroupMemorySource;
}

export interface AdmissionSnapshot {
  available: boolean;
  reason?: AdmissionRefusalReason;
  activeTurns: number;
  maxActiveTurns: number;
  interactiveReserve: number;
  apiTurnLimit: number;
  /** Slots reserved for P0/P1 control that P2/P3 execution cannot consume. */
  controlReserve: number;
  /** Concurrent P2/P3 execution turns the arbiter will admit. */
  executionCapacity: number;
  /** Per-class active-turn counts (low cardinality, for diagnostics). */
  classes: Record<AdmissionClass, { active: number }>;
  /**
   * Whether P0/P1 control work can be served right now. Control bypasses the
   * execution capacity (it is never blocked by P2/P3 saturation) and is bounded
   * only by memory pressure. Distinct from `available`, which reflects P2/P3
   * execution availability.
   */
  controlAvailable: boolean;
  /** Emergency mode: memory pressure refusing new execution while control is still preserved. */
  emergencyMode: boolean;
  memory: MemoryCapacity & { headroomBytes: number; minimumHeadroomBytes: number; reservedBytesPerTurn: number; projectedHeadroomBytes: number };
  runtimes: Record<SessionRuntime, { activeTurns: number; maxActiveTurns: number; stalledRuns?: number }>;
  /** Task/PID capacity from the service cgroup, when available. */
  pids?: { current?: number; max?: number; source?: CgroupMemorySource; pressure?: boolean; reservedPidsPerTurn?: number };
  /** Host-level memory + PSI truth (separate from the service cgroup). */
  host?: ResolvedHostPressure & { hostPressure?: boolean; hostMinimumHeadroomBytes?: number; telemetryAvailable?: boolean };
  /** Service cgroup memory.events counters (oom/oom_kill/high), when available. */
  memoryEvents?: ResolvedMemoryEvents;
  /** B2: projected V8 heap against a fraction of `heap_size_limit` (with hysteresis). */
  heap: AdmissionHeapState;
  /** B2: sustained event-loop lag from A2 readings (with hysteresis). */
  eventLoopLag: AdmissionLagState;
  /** B4 seam: non-null while the server drains before a restart. */
  draining: { since: string; reason: string } | null;
  /** Which safety knobs were set explicitly vs applied as conservative prod fallback. */
  admissionConfig?: { explicitKnobs: string[]; prodFallbackKnobs: string[] };
  retryAfterSeconds: number;
  /** Number of runs terminalised as stalled by the watchdog. */
  stalledRuns?: number;
  /** ISO timestamp of the oldest still-active run's start, when any. */
  oldestActiveRunStartedAt?: string;
}

export interface AdmissionHeapState {
  usedBytes: number;
  limitBytes: number;
  /** usedBytes + (active execution turns + 1) × reservedBytesPerTurn. */
  projectedBytes: number;
  reservedBytesPerTurn: number;
  pressureFraction: number;
  recoveryFraction: number;
  pressureBytes: number;
  recoveryBytes: number;
  pressure: boolean;
  source: 'v8' | 'validation-override';
}

export interface AdmissionLagState {
  thresholdMs: number;
  recoveryMs: number;
  sustainedReadings: number;
  consecutiveHighReadings: number;
  pressure: boolean;
  /** False until the first A2 reading with samples has arrived. */
  telemetryAvailable: boolean;
  /** True when the latest reading is older than the staleness window (fails open). */
  stale: boolean;
  lastP99Ms?: number;
  lastReadingAt?: string;
  source?: 'a2' | 'validation-override';
}

export interface AdmissionControllerOptions {
  /** Total process execution budget; one slot remains reserved for Web UI work. */
  maxActiveTurns?: number;
  interactiveReserve?: number;
  /** Slots reserved for P0/P1 control (defaults to interactiveReserve). P2/P3 cannot consume them. */
  controlReserve?: number;
  /**
   * Headroom floor below which even P0/P1 control is refused (emergency floor).
   * Defaults to minimumHeadroomBytes/4 — control stays available under ordinary
   * memory pressure (emergency mode: execution refused, control preserved) and is
   * refused only at this critical floor.
   */
  memoryCriticalBytes?: number;
  runtimeMaxActiveTurns?: Partial<Record<SessionRuntime, number>>;
  minimumHeadroomBytes?: number;
  /** Conservative memory reservation applied before each admitted turn. */
  reservedBytesPerTurn?: number;
  memory?: () => MemoryCapacity;
  /** Injectable PID/task capacity reader for the snapshot; defaults to the service cgroup. */
  readPids?: () => ResolvedPidsCapacity;
  /** Injectable host-pressure reader (host mem + PSI); defaults to readHostPressure. */
  host?: () => ResolvedHostPressure;
  /** Injectable service cgroup memory.events reader; defaults to readServiceMemoryEvents. */
  readMemoryEvents?: () => ResolvedMemoryEvents | undefined;
  /** Conservative PID/task reservation applied before each admitted turn. When
   * `pids.current + reservedPidsPerTurn > pids.max`, execution is refused with
   * `pid_pressure` so a turn near the TasksMax ceiling fails gracefully (503)
   * rather than surfacing as in-tool fork errors. Defaults to 256. */
  reservedPidsPerTurn?: number;
  /** Host-available-memory floor. When host MemAvailable is below this, execution
   * is refused with `host_memory_pressure` (separate from the service cgroup,
   * which bounds only this process; tmux/external work sits outside it). */
  hostMinimumHeadroomBytes?: number;
  /** Per-knob explicitness (set by the startup wiring) surfaced in the snapshot
   * so /capacity shows which safety knobs came from env vs conservative fallback. */
  configExplicitness?: { explicitKnobs: string[]; prodFallbackKnobs: string[] };
  retryAfterSeconds?: number;
  /** B2: injectable V8 heap reader; defaults to `v8.getHeapStatistics()`. */
  heap?: () => HeapReading;
  /** B2: refuse P2/P3 when projected heap ≥ this fraction of heap_size_limit (default 0.75). */
  heapPressureFraction?: number;
  /** B2: once refusing, recover only when projected heap < this fraction (default 0.65). */
  heapRecoveryFraction?: number;
  /** B2: projected heap reserved per active execution turn and for the candidate (default 64 MiB). */
  reservedHeapBytesPerTurn?: number;
  /** B2: A2 lag p99 at or above which a reading counts as high (default 300 ms). */
  lagThresholdMs?: number;
  /** B2: once refusing, recover only when a reading's p99 is below this (default threshold / 2). */
  lagRecoveryMs?: number;
  /** B2: consecutive high readings that latch the refusal (default 2). */
  lagSustainedReadings?: number;
  /** B2: a latched lag refusal older than this with no new reading fails open (default 180 s). */
  lagReadingStaleMs?: number;
  /** B2: Retry-After for heap_pressure / event_loop_lag refusals (default 30 s, the A2 cadence). */
  heapLagRetryAfterSeconds?: number;
  /** Validation-only pressure injection; never set in production. */
  pressureOverride?: AdmissionPressureOverride;
  now?: () => number;
}

const RUNTIMES: SessionRuntime[] = ['pi', 'claude', 'opencode', 'antigravity', 'commandcode'];
const DEFAULT_MINIMUM_HEADROOM_BYTES = 512 * 1024 * 1024;
const DEFAULT_RESERVED_BYTES_PER_TURN = 512 * 1024 * 1024;
const DEFAULT_RESERVED_PIDS_PER_TURN = 96;
const DEFAULT_HOST_MINIMUM_HEADROOM_BYTES = 512 * 1024 * 1024;
/**
 * B2 heap defaults (evidence: B1-confirmation-soak.md — fixed build floor
 * ~200 MB post-GC, 242 MB peak, under a 4 GiB heap cap with PI_MAX_SESSIONS=20).
 * 0.75 × 4 GiB = 3 GiB trips an order of magnitude above the healthy floor, so
 * normal operation never refuses, and still leaves ~1 GiB for in-flight turns
 * and a full mark-compact before the OOM. 0.65 (≈2.6 GiB) is the recovery mark.
 */
export const DEFAULT_HEAP_PRESSURE_FRACTION = 0.75;
export const DEFAULT_HEAP_RECOVERY_FRACTION = 0.65;
/** Projected heap per execution turn: 64 MiB × PI_MAX_SESSIONS-scale concurrency
 * stays well inside the 1 GiB band between the trigger and the cap. */
export const DEFAULT_RESERVED_HEAP_BYTES_PER_TURN = 64 * 1024 * 1024;
/** B2 lag defaults (B1.2.md §"Proposed B2 event_loop_lag threshold"). */
export const DEFAULT_LAG_THRESHOLD_MS = 300;
export const DEFAULT_LAG_SUSTAINED_READINGS = 2;
/** Six 30 s A2 readings: a latched lag refusal with no fresh reading fails open. */
export const DEFAULT_LAG_READING_STALE_MS = 180_000;
/** One A2 reading interval: the lag state cannot change sooner. */
export const DEFAULT_HEAP_LAG_RETRY_AFTER_SECONDS = 30;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

/** A fraction in (0, 1]; anything else falls back. */
function fraction(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 && (value as number) <= 1 ? (value as number) : fallback;
}

/** Fully-resolved admission configuration (the single source of truth used by
 * both the {@link AdmissionController} constructor and {@link admissionStartupStatus}). */
export interface ResolvedAdmissionConfig {
  maxActiveTurns: number;
  interactiveReserve: number;
  apiTurnLimit: number;
  controlReserve: number;
  executionCapacity: number;
  minimumHeadroomBytes: number;
  memoryCriticalBytes: number;
  reservedBytesPerTurn: number;
  reservedPidsPerTurn: number;
  hostMinimumHeadroomBytes: number;
  retryAfterSeconds: number;
  heapPressureFraction: number;
  /** Never above heapPressureFraction (an inverted band is clamped). */
  heapRecoveryFraction: number;
  reservedHeapBytesPerTurn: number;
  lagThresholdMs: number;
  /** Never above lagThresholdMs; defaults to half the threshold. */
  lagRecoveryMs: number;
  lagSustainedReadings: number;
  lagReadingStaleMs: number;
  heapLagRetryAfterSeconds: number;
  /** Whether the primary capacity knob was NOT explicitly provided (CPU-derived default in effect). */
  usingDefaults: boolean;
}

/** Resolve admission options into concrete numbers + a `usingDefaults` flag.
 * Centralised so the controller and the startup logger cannot drift. */
export function resolveAdmissionConfig(options: AdmissionControllerOptions): ResolvedAdmissionConfig {
  // CPU-derived by default rather than a fixed child/session count. Operators
  // can lower this explicitly; measured memory pressure remains authoritative.
  const maxActiveTurns = positiveInteger(options.maxActiveTurns, Math.max(2, availableParallelism()));
  const interactiveReserve = Math.min(
    Math.max(0, Math.floor(options.interactiveReserve ?? 1)),
    Math.max(0, maxActiveTurns - 1),
  );
  const apiTurnLimit = Math.max(1, maxActiveTurns - interactiveReserve);
  const controlReserve = Math.min(
    Math.max(0, Math.floor(options.controlReserve ?? interactiveReserve)),
    Math.max(0, maxActiveTurns - 1),
  );
  const executionCapacity = Math.max(0, maxActiveTurns - controlReserve);
  const minimumHeadroomBytes = positiveInteger(options.minimumHeadroomBytes, DEFAULT_MINIMUM_HEADROOM_BYTES);
  const heapPressureFraction = fraction(options.heapPressureFraction, DEFAULT_HEAP_PRESSURE_FRACTION);
  const lagThresholdMs = positiveInteger(options.lagThresholdMs, DEFAULT_LAG_THRESHOLD_MS);
  return {
    heapPressureFraction,
    heapRecoveryFraction: Math.min(heapPressureFraction, fraction(options.heapRecoveryFraction, DEFAULT_HEAP_RECOVERY_FRACTION)),
    reservedHeapBytesPerTurn: positiveInteger(options.reservedHeapBytesPerTurn, DEFAULT_RESERVED_HEAP_BYTES_PER_TURN),
    lagThresholdMs,
    lagRecoveryMs: Math.min(lagThresholdMs, positiveInteger(options.lagRecoveryMs, Math.max(1, Math.floor(lagThresholdMs / 2)))),
    lagSustainedReadings: positiveInteger(options.lagSustainedReadings, DEFAULT_LAG_SUSTAINED_READINGS),
    lagReadingStaleMs: positiveInteger(options.lagReadingStaleMs, DEFAULT_LAG_READING_STALE_MS),
    heapLagRetryAfterSeconds: positiveInteger(options.heapLagRetryAfterSeconds, DEFAULT_HEAP_LAG_RETRY_AFTER_SECONDS),
    maxActiveTurns,
    interactiveReserve,
    apiTurnLimit,
    controlReserve,
    executionCapacity,
    minimumHeadroomBytes,
    memoryCriticalBytes: positiveInteger(options.memoryCriticalBytes, Math.max(1, Math.floor(minimumHeadroomBytes / 4))),
    reservedBytesPerTurn: positiveInteger(options.reservedBytesPerTurn, DEFAULT_RESERVED_BYTES_PER_TURN),
    reservedPidsPerTurn: positiveInteger(options.reservedPidsPerTurn, DEFAULT_RESERVED_PIDS_PER_TURN),
    hostMinimumHeadroomBytes: positiveInteger(options.hostMinimumHeadroomBytes, DEFAULT_HOST_MINIMUM_HEADROOM_BYTES),
    retryAfterSeconds: positiveInteger(options.retryAfterSeconds, 2),
    usingDefaults: options.maxActiveTurns === undefined,
  };
}

/** Conservative admission defaults forced in production when an env knob is
 * unset, so a missing/mis-loaded .env.production cannot make the server run
 * non-conservative CPU-derived admission. Outside production the looser
 * CPU-derived defaults still apply (dev/test convenience). */
export const PRODUCTION_ADMISSION_DEFAULTS: Required<Pick<AdmissionControllerOptions,
  'maxActiveTurns' | 'interactiveReserve' | 'minimumHeadroomBytes' | 'reservedBytesPerTurn' | 'reservedPidsPerTurn' | 'hostMinimumHeadroomBytes'>> = {
  maxActiveTurns: 6,
  interactiveReserve: 1,
  minimumHeadroomBytes: 1536 * 1024 * 1024,
  reservedBytesPerTurn: 512 * 1024 * 1024,
  reservedPidsPerTurn: 96,
  hostMinimumHeadroomBytes: 512 * 1024 * 1024,
};

const SAFETY_KNOBS = [
  'maxActiveTurns', 'interactiveReserve', 'minimumHeadroomBytes',
  'reservedBytesPerTurn', 'reservedPidsPerTurn', 'hostMinimumHeadroomBytes',
] as const;

/** Startup status for the admission layer. In production, any unset safety knob
 * is filled with a conservative default (so the server never silently runs
 * CPU-derived admission) and the result reports per-knob explicitness. Outside
 * production the CPU-derived defaults apply. */
export function admissionStartupStatus(options: AdmissionControllerOptions & { isProduction?: boolean }): {
  resolved: ResolvedAdmissionConfig;
  /** Options with production defaults applied where unset (construct the controller from this). */
  options: AdmissionControllerOptions;
  explicitKnobs: string[];
  prodFallbackKnobs: string[];
  /** True when NOT in production and the capacity knob was unset (CPU-derived). */
  usingDefaults: boolean;
  warning: string | undefined;
} {
  const isProduction = options.isProduction === true;
  const explicitKnobs: string[] = [];
  const prodFallbackKnobs: string[] = [];
  const resolvedOptions: AdmissionControllerOptions = { ...options };
  for (const key of SAFETY_KNOBS) {
    const explicit = (options as Record<string, unknown>)[key] !== undefined;
    if (explicit) {
      explicitKnobs.push(key);
    } else if (isProduction) {
      (resolvedOptions as Record<string, unknown>)[key] = (PRODUCTION_ADMISSION_DEFAULTS as Record<string, unknown>)[key];
      prodFallbackKnobs.push(key);
    }
  }
  const resolved = resolveAdmissionConfig(resolvedOptions);
  const usingDefaults = !isProduction && options.maxActiveTurns === undefined;
  // In production with fallbacks applied the server is SAFE (conservative), so
  // this is informational, not alarming. The scary case (non-conservative in
  // prod) can no longer happen because prod defaults are applied above.
  const warning = isProduction && prodFallbackKnobs.length > 0
    ? `admission: production safety knobs not set via env — applied conservative fallback for [${prodFallbackKnobs.join(', ')}]. Set INTERNAL_API_ADMISSION_* explicitly to tune.`
    : undefined;
  return { resolved, options: resolvedOptions, explicitKnobs, prodFallbackKnobs, usingDefaults, warning };
}

/**
 * Resolves this process's actual memory capacity from its nested service cgroup
 * (preferred) rather than the cgroup-root/host aggregate. See `cgroup-capacity.ts`.
 */
export function readMemoryCapacity(): MemoryCapacity {
  return readServiceMemoryCapacity();
}

export class AdmissionController {
  private activeTurns = 0;
  private readonly activeByRuntime: Record<SessionRuntime, number> = {
    pi: 0, claude: 0, opencode: 0, antigravity: 0, commandcode: 0,
  };
  private readonly maxActiveTurns: number;
  private readonly interactiveReserve: number;
  private readonly apiTurnLimit: number;
  private readonly controlReserve: number;
  private readonly executionCapacity: number;
  private readonly memoryCriticalBytes: number;
  private readonly activeByClass: Record<AdmissionClass, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  private readonly runtimeLimits: Record<SessionRuntime, number>;
  private readonly minimumHeadroomBytes: number;
  private readonly memory: () => MemoryCapacity;
  private readonly readPids: () => ResolvedPidsCapacity;
  private readonly reservedBytesPerTurn: number;
  private readonly reservedPidsPerTurn: number;
  private readonly hostMinimumHeadroomBytes: number;
  private readonly host: () => ResolvedHostPressure;
  private readonly readMemoryEvents: () => ResolvedMemoryEvents | undefined;
  private readonly configExplicitness?: { explicitKnobs: string[]; prodFallbackKnobs: string[] };
  private readonly retryAfterSeconds: number;
  private readonly heap: () => HeapReading;
  private readonly heapPressureFraction: number;
  private readonly heapRecoveryFraction: number;
  private readonly reservedHeapBytesPerTurn: number;
  private readonly lagThresholdMs: number;
  private readonly lagRecoveryMs: number;
  private readonly lagSustainedReadings: number;
  private readonly lagReadingStaleMs: number;
  private readonly heapLagRetryAfterSeconds: number;
  private readonly pressureOverride?: AdmissionPressureOverride;
  private readonly now: () => number;
  /** Hysteresis latches (B2). */
  private heapLatched = false;
  private lagLatched = false;
  private lagConsecutiveHigh = 0;
  private lastLag?: { p99Ms: number; atMs: number; source: 'a2' | 'validation-override' };

  constructor(options: AdmissionControllerOptions = {}) {
    const c = resolveAdmissionConfig(options);
    this.maxActiveTurns = c.maxActiveTurns;
    this.interactiveReserve = c.interactiveReserve;
    this.apiTurnLimit = c.apiTurnLimit;
    this.controlReserve = c.controlReserve;
    this.executionCapacity = c.executionCapacity;
    this.runtimeLimits = Object.fromEntries(RUNTIMES.map((runtime) => [
      runtime,
      positiveInteger(options.runtimeMaxActiveTurns?.[runtime], c.apiTurnLimit),
    ])) as Record<SessionRuntime, number>;
    this.minimumHeadroomBytes = c.minimumHeadroomBytes;
    this.memoryCriticalBytes = c.memoryCriticalBytes;
    this.reservedBytesPerTurn = c.reservedBytesPerTurn;
    this.reservedPidsPerTurn = c.reservedPidsPerTurn;
    this.hostMinimumHeadroomBytes = c.hostMinimumHeadroomBytes;
    this.memory = options.memory ?? readMemoryCapacity;
    this.readPids = options.readPids ?? readServicePidsCapacity;
    this.host = options.host ?? readHostPressure;
    this.readMemoryEvents = options.readMemoryEvents ?? readServiceMemoryEvents;
    this.configExplicitness = options.configExplicitness;
    this.retryAfterSeconds = c.retryAfterSeconds;
    this.heap = options.heap ?? readV8Heap;
    this.heapPressureFraction = c.heapPressureFraction;
    this.heapRecoveryFraction = c.heapRecoveryFraction;
    this.reservedHeapBytesPerTurn = c.reservedHeapBytesPerTurn;
    this.lagThresholdMs = c.lagThresholdMs;
    this.lagRecoveryMs = c.lagRecoveryMs;
    this.lagSustainedReadings = c.lagSustainedReadings;
    this.lagReadingStaleMs = c.lagReadingStaleMs;
    this.heapLagRetryAfterSeconds = c.heapLagRetryAfterSeconds;
    this.pressureOverride = options.pressureOverride;
    this.now = options.now ?? Date.now;
  }

  private drainingState: { since: number; reason: string } | null = null;

  /** B4 seam: while draining, new P2/P3 execution is refused with reason 'draining'; P0/P1 control and session disposal stay available. */
  setDraining(state: { since: number; reason: string } | null): void {
    this.drainingState = state;
  }

  getDraining(): { since: number; reason: string } | null {
    return this.drainingState;
  }

  /**
   * B2: feed one A2 lag reading. A reading counts as high at p99 ≥ threshold;
   * `lagSustainedReadings` consecutive high readings latch `event_loop_lag`,
   * and only a reading strictly below the recovery mark releases it. Readings
   * without samples carry no information and are ignored.
   */
  observeLagReading(reading: LagReading): void {
    if (reading.sampleCount !== undefined && reading.sampleCount <= 0) return;
    const override = this.pressureOverride?.lagP99Ms();
    const p99Ms = override ?? reading.p99Ms;
    if (!Number.isFinite(p99Ms)) return;
    this.lastLag = { p99Ms, atMs: reading.atMs, source: override === undefined ? 'a2' : 'validation-override' };
    this.lagConsecutiveHigh = p99Ms >= this.lagThresholdMs ? this.lagConsecutiveHigh + 1 : 0;
    if (!this.lagLatched && this.lagConsecutiveHigh >= this.lagSustainedReadings) {
      this.lagLatched = true;
    } else if (this.lagLatched && p99Ms < this.lagRecoveryMs) {
      this.lagLatched = false;
    }
  }

  /**
   * B2: refuse a session create under resource pressure or while draining. A
   * create holds no turn slot, so turn-slot saturation (global/runtime limit)
   * never refuses it; every pressure reason does, because creates grow memory
   * too (R1: refusing prompts alone does not stop create-time growth).
   */
  assertCreateAdmissible(runtime: SessionRuntime, cls: AdmissionClass = 'P2'): void {
    const reason = this.refusalReason(runtime, cls, this.evaluatePressure());
    if (reason && !SLOT_REFUSALS.has(reason)) throw this.refusal(reason);
  }

  private refusal(reason: AdmissionRefusalReason, detail?: string): AdmissionCapacityError {
    const retryAfter = reason === 'heap_pressure' || reason === 'event_loop_lag'
      ? this.heapLagRetryAfterSeconds
      : this.retryAfterSeconds;
    return new AdmissionCapacityError(reason, retryAfter, detail);
  }

  private lagState(): { pressure: boolean; stale: boolean } {
    const stale = this.lastLag !== undefined && this.now() - this.lastLag.atMs > this.lagReadingStaleMs;
    return { pressure: this.lagLatched && !stale, stale };
  }

  async acquire(runtime: SessionRuntime, cls: AdmissionClass = 'P2'): Promise<{ release: () => void }> {
    const pressure = this.evaluatePressure();
    const reason = this.refusalReason(runtime, cls, pressure);
    if (reason) {
      const reservedTasks = (this.activeByClass.P2 + this.activeByClass.P3 + 1) * this.reservedPidsPerTurn;
      const detail = reason === 'pid_pressure'
        ? `currentTasks=${pressure.pids.current} reservedTasks=${reservedTasks} projectedTasks=${pressure.pids.current! + reservedTasks} taskLimit=${pressure.pids.max}`
        : undefined;
      throw this.refusal(reason, detail ?? (reason === 'heap_pressure'
        ? `projectedHeapBytes=${pressure.heap.projectedBytes} pressureBytes=${pressure.heap.pressureBytes} heapLimitBytes=${pressure.heap.limitBytes}`
        : reason === 'event_loop_lag'
          ? `lagP99Ms=${this.lastLag?.p99Ms} thresholdMs=${this.lagThresholdMs} recoveryMs=${this.lagRecoveryMs}`
          : undefined));
    }
    // JavaScript's run-to-completion makes this check+increment atomic within
    // one server process (there is no await between them).
    this.activeTurns += 1;
    this.activeByRuntime[runtime] += 1;
    this.activeByClass[cls] += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeTurns = Math.max(0, this.activeTurns - 1);
        this.activeByRuntime[runtime] = Math.max(0, this.activeByRuntime[runtime] - 1);
        this.activeByClass[cls] = Math.max(0, this.activeByClass[cls] - 1);
      },
    };
  }

  /** Read every capacity source ONCE and derive all pressure flags from that
   * single consistent view. Previously snapshot()/refusalReason() read memory,
   * pids, and host telemetry multiple times each, which could produce an
   * internally inconsistent snapshot under pressure (a value changing between
   * reads). Memory projects against ALL active turns; PID/host project against
   * execution turns only (control ops are lightweight and don't fork/reserve
   * the heavy per-turn budget). */
  private evaluatePressure(): {
    memory: MemoryCapacity;
    headroomBytes: number;
    projectedHeadroomBytes: number;
    memoryPressure: boolean;
    memoryCritical: boolean;
    pids: ResolvedPidsCapacity;
    pidPressure: boolean;
    host: ResolvedHostPressure;
    hostPressure: boolean | undefined;
    heap: AdmissionHeapState;
    lagPressure: boolean;
    lagStale: boolean;
  } {
    const heap = this.evaluateHeap();
    const lag = this.lagState();
    const memory = this.memory();
    const pids = this.readPids();
    const host = this.host();
    const activeExecutionTurns = this.activeByClass.P2 + this.activeByClass.P3;
    const headroomBytes = Math.max(0, memory.limitBytes - memory.currentBytes);
    const projectedHeadroomBytes = Math.max(0, headroomBytes - ((this.activeTurns + 1) * this.reservedBytesPerTurn));
    // Pressure also when the cgroup has reached its soft memory.high boundary
    // (the kernel is reclaiming aggressively) — catches pressure earlier than
    // the headroom floor alone and makes the surfaced memory.high truth actionable.
    const highPressure = memory.highBytes !== undefined && memory.currentBytes >= memory.highBytes;
    const memoryPressure = projectedHeadroomBytes < this.minimumHeadroomBytes || highPressure;
    const memoryCritical = projectedHeadroomBytes < this.memoryCriticalBytes;
    const pidPressure = pids.max !== undefined && pids.current !== undefined
      && pids.current + ((activeExecutionTurns + 1) * this.reservedPidsPerTurn) >= pids.max;
    // hostPressure is undefined (not false) when host telemetry is unreadable,
    // so /capacity distinguishes "no pressure" from "unknown".
    const hostPressure = host.memAvailableBytes === undefined
      ? undefined
      : host.memAvailableBytes - ((activeExecutionTurns + 1) * this.reservedBytesPerTurn) < this.hostMinimumHeadroomBytes;
    return {
      memory, headroomBytes, projectedHeadroomBytes, memoryPressure, memoryCritical, pids, pidPressure, host, hostPressure,
      heap, lagPressure: lag.pressure, lagStale: lag.stale,
    };
  }

  /**
   * B2 heap gate: projected heap = used + (active execution turns + 1) ×
   * reservation, against heap_size_limit. Latches at ≥ pressure fraction and
   * releases only strictly below the recovery fraction. An unknown limit (0)
   * fails open. The heap reader is fail-open too: a throwing reader reports 0.
   */
  private evaluateHeap(): AdmissionHeapState {
    let reading: HeapReading;
    try {
      reading = this.heap();
    } catch {
      reading = { usedBytes: 0, limitBytes: 0 };
    }
    const overrideUsed = this.pressureOverride?.heapUsedBytes();
    const usedBytes = overrideUsed ?? reading.usedBytes;
    const limitBytes = reading.limitBytes > 0 ? reading.limitBytes : 0;
    const executionActive = this.activeByClass.P2 + this.activeByClass.P3;
    const projectedBytes = usedBytes + ((executionActive + 1) * this.reservedHeapBytesPerTurn);
    const pressureBytes = Math.floor(limitBytes * this.heapPressureFraction);
    const recoveryBytes = Math.floor(limitBytes * this.heapRecoveryFraction);
    if (limitBytes === 0) {
      this.heapLatched = false;
    } else if (!this.heapLatched && projectedBytes >= pressureBytes) {
      this.heapLatched = true;
    } else if (this.heapLatched && projectedBytes < recoveryBytes) {
      this.heapLatched = false;
    }
    return {
      usedBytes,
      limitBytes,
      projectedBytes,
      reservedBytesPerTurn: this.reservedHeapBytesPerTurn,
      pressureFraction: this.heapPressureFraction,
      recoveryFraction: this.heapRecoveryFraction,
      pressureBytes,
      recoveryBytes,
      pressure: this.heapLatched,
      source: overrideUsed === undefined ? 'v8' : 'validation-override',
    };
  }

  snapshot(): AdmissionSnapshot {
    const pressure = this.evaluatePressure();
    const { memory, headroomBytes, projectedHeadroomBytes, memoryPressure, memoryCritical, pids, pidPressure, host, hostPressure, heap } = pressure;
    // The same precedence as a P2 acquire, so `reason` is what the next P2
    // request would be refused with (runtime_limit is per-runtime and omitted).
    const refusal = this.refusalReason('pi', 'P2', pressure);
    const reason: AdmissionRefusalReason | undefined = refusal === 'runtime_limit' ? undefined : refusal;
    return {
      available: reason === undefined,
      reason,
      activeTurns: this.activeTurns,
      maxActiveTurns: this.maxActiveTurns,
      interactiveReserve: this.interactiveReserve,
      apiTurnLimit: this.apiTurnLimit,
      controlReserve: this.controlReserve,
      executionCapacity: this.executionCapacity,
      classes: Object.fromEntries(ADMISSION_CLASSES.map((cls) => [cls, { active: this.activeByClass[cls] }])) as Record<AdmissionClass, { active: number }>,
      // Emergency mode: under memory pressure execution is refused, but control
      // stays available unless the critical floor is breached.
      controlAvailable: !memoryCritical,
      emergencyMode: memoryPressure && !memoryCritical,
      memory: { ...memory, headroomBytes, minimumHeadroomBytes: this.minimumHeadroomBytes, reservedBytesPerTurn: this.reservedBytesPerTurn, projectedHeadroomBytes },
      pids: { ...pids, pressure: pidPressure, reservedPidsPerTurn: this.reservedPidsPerTurn },
      host: { ...host, hostPressure, telemetryAvailable: host.memAvailableBytes !== undefined, hostMinimumHeadroomBytes: this.hostMinimumHeadroomBytes },
      memoryEvents: this.readMemoryEvents(),
      heap,
      eventLoopLag: {
        thresholdMs: this.lagThresholdMs,
        recoveryMs: this.lagRecoveryMs,
        sustainedReadings: this.lagSustainedReadings,
        consecutiveHighReadings: this.lagConsecutiveHigh,
        pressure: pressure.lagPressure,
        telemetryAvailable: this.lastLag !== undefined,
        stale: pressure.lagStale,
        ...(this.lastLag ? {
          lastP99Ms: this.lastLag.p99Ms,
          lastReadingAt: new Date(this.lastLag.atMs).toISOString(),
          source: this.lastLag.source,
        } : {}),
      },
      draining: this.drainingState
        ? { since: new Date(this.drainingState.since).toISOString(), reason: this.drainingState.reason }
        : null,
      admissionConfig: this.configExplicitness
        ? { explicitKnobs: this.configExplicitness.explicitKnobs, prodFallbackKnobs: this.configExplicitness.prodFallbackKnobs }
        : undefined,
      runtimes: Object.fromEntries(RUNTIMES.map((runtime) => [runtime, {
        activeTurns: this.activeByRuntime[runtime],
        maxActiveTurns: this.runtimeLimits[runtime],
      }])) as AdmissionSnapshot['runtimes'],
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }

  private refusalReason(
    runtime: SessionRuntime,
    cls: AdmissionClass,
    { memoryPressure, memoryCritical, pidPressure, hostPressure, heap, lagPressure }: ReturnType<AdmissionController['evaluatePressure']>,
  ): AdmissionRefusalReason | undefined {
    if (CONTROL_CLASSES.has(cls)) {
      // P0/P1 control is preserved under ordinary memory pressure (emergency mode:
      // execution is refused, control is kept) and refused only at the critical
      // memory floor or the global turn ceiling. It bypasses the execution
      // capacity and per-runtime limits.
      if (memoryCritical) return 'memory_pressure';
      if (this.activeTurns >= this.maxActiveTurns) return 'global_limit';
    } else {
      if (this.drainingState) return 'draining';
      // P2/P3 execution: refused under memory pressure, host-memory pressure, PID pressure,
      // V8 heap pressure (B2), sustained event-loop lag (B2), execution saturation, or per-runtime ceiling.
      if (memoryPressure) return 'memory_pressure';
      if (hostPressure) return 'host_memory_pressure';
      if (pidPressure) return 'pid_pressure';
      if (heap.pressure) return 'heap_pressure';
      if (lagPressure) return 'event_loop_lag';
      const executionActive = this.activeByClass.P2 + this.activeByClass.P3;
      if (executionActive >= this.executionCapacity) return 'global_limit';
      if (this.activeByRuntime[runtime] >= this.runtimeLimits[runtime]) return 'runtime_limit';
    }
    return undefined;
  }
}
