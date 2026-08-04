import { availableParallelism } from 'os';
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

export type AdmissionRefusalReason = 'global_limit' | 'runtime_limit' | 'memory_pressure' | 'pid_pressure' | 'host_memory_pressure';

/**
 * Execution priority class. P0 (browser) and P1 (Agent OS control) are
 * non-execution control with reserved capacity; P2 (ordinary API execution)
 * and P3 (bulk) are execution. Priority is server-derived, never caller-trusted.
 */
export type AdmissionClass = 'P0' | 'P1' | 'P2' | 'P3';
const CONTROL_CLASSES = new Set<AdmissionClass>(['P0', 'P1']);
const ADMISSION_CLASSES: AdmissionClass[] = ['P0', 'P1', 'P2', 'P3'];

export class AdmissionCapacityError extends Error {
  constructor(public readonly reason: AdmissionRefusalReason, public readonly retryAfterSeconds = 2) {
    super(`Internal API admission refused: ${reason}`);
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
  /** Which safety knobs were set explicitly vs applied as conservative prod fallback. */
  admissionConfig?: { explicitKnobs: string[]; prodFallbackKnobs: string[] };
  retryAfterSeconds: number;
  /** Number of runs terminalised as stalled by the watchdog. */
  stalledRuns?: number;
  /** ISO timestamp of the oldest still-active run's start, when any. */
  oldestActiveRunStartedAt?: string;
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
}

const RUNTIMES: SessionRuntime[] = ['pi', 'claude', 'opencode', 'antigravity'];
const DEFAULT_MINIMUM_HEADROOM_BYTES = 512 * 1024 * 1024;
const DEFAULT_RESERVED_BYTES_PER_TURN = 256 * 1024 * 1024;
const DEFAULT_RESERVED_PIDS_PER_TURN = 256;
const DEFAULT_HOST_MINIMUM_HEADROOM_BYTES = 512 * 1024 * 1024;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
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
  return {
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
  reservedBytesPerTurn: 768 * 1024 * 1024,
  reservedPidsPerTurn: 256,
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
    pi: 0, claude: 0, opencode: 0, antigravity: 0,
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
  }

  async acquire(runtime: SessionRuntime, cls: AdmissionClass = 'P2'): Promise<{ release: () => void }> {
    const reason = this.refusalReason(runtime, cls);
    if (reason) throw new AdmissionCapacityError(reason, this.retryAfterSeconds);
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
  } {
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
    return { memory, headroomBytes, projectedHeadroomBytes, memoryPressure, memoryCritical, pids, pidPressure, host, hostPressure };
  }

  snapshot(): AdmissionSnapshot {
    const { memory, headroomBytes, projectedHeadroomBytes, memoryPressure, memoryCritical, pids, pidPressure, host, hostPressure } = this.evaluatePressure();
    const executionActive = this.activeByClass.P2 + this.activeByClass.P3;
    const executionFull = executionActive >= this.executionCapacity;
    const reason: AdmissionRefusalReason | undefined = memoryPressure
      ? 'memory_pressure'
      : hostPressure ? 'host_memory_pressure'
        : pidPressure ? 'pid_pressure'
          : executionFull ? 'global_limit' : undefined;
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

  private refusalReason(runtime: SessionRuntime, cls: AdmissionClass): AdmissionRefusalReason | undefined {
    const { memoryPressure, memoryCritical, pidPressure, hostPressure } = this.evaluatePressure();
    if (CONTROL_CLASSES.has(cls)) {
      // P0/P1 control is preserved under ordinary memory pressure (emergency mode:
      // execution is refused, control is kept) and refused only at the critical
      // memory floor or the global turn ceiling. It bypasses the execution
      // capacity and per-runtime limits.
      if (memoryCritical) return 'memory_pressure';
      if (this.activeTurns >= this.maxActiveTurns) return 'global_limit';
    } else {
      // P2/P3 execution: refused under memory pressure, host-memory pressure, PID pressure, execution saturation, or per-runtime ceiling.
      if (memoryPressure) return 'memory_pressure';
      if (hostPressure) return 'host_memory_pressure';
      if (pidPressure) return 'pid_pressure';
      const executionActive = this.activeByClass.P2 + this.activeByClass.P3;
      if (executionActive >= this.executionCapacity) return 'global_limit';
      if (this.activeByRuntime[runtime] >= this.runtimeLimits[runtime]) return 'runtime_limit';
    }
    return undefined;
  }
}
