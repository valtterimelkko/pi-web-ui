import { availableParallelism } from 'os';
import {
  readServiceMemoryCapacity,
  readServicePidsCapacity,
  type CgroupMemorySource,
  type ResolvedPidsCapacity,
} from './cgroup-capacity.js';
import type { SessionRuntime } from './types.js';

export type AdmissionRefusalReason = 'global_limit' | 'runtime_limit' | 'memory_pressure';

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
  pids?: { current?: number; max?: number; source?: CgroupMemorySource };
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
  retryAfterSeconds?: number;
}

const RUNTIMES: SessionRuntime[] = ['pi', 'claude', 'opencode', 'antigravity'];
const DEFAULT_MINIMUM_HEADROOM_BYTES = 512 * 1024 * 1024;
const DEFAULT_RESERVED_BYTES_PER_TURN = 256 * 1024 * 1024;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
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
  private readonly retryAfterSeconds: number;

  constructor(options: AdmissionControllerOptions = {}) {
    // CPU-derived by default rather than a fixed child/session count. Operators
    // can lower this explicitly; measured memory pressure remains authoritative.
    this.maxActiveTurns = positiveInteger(options.maxActiveTurns, Math.max(2, availableParallelism()));
    this.interactiveReserve = Math.min(
      Math.max(0, Math.floor(options.interactiveReserve ?? 1)),
      Math.max(0, this.maxActiveTurns - 1),
    );
    this.apiTurnLimit = Math.max(1, this.maxActiveTurns - this.interactiveReserve);
    this.controlReserve = Math.min(
      Math.max(0, Math.floor(options.controlReserve ?? this.interactiveReserve)),
      Math.max(0, this.maxActiveTurns - 1),
    );
    this.executionCapacity = Math.max(0, this.maxActiveTurns - this.controlReserve);
    this.runtimeLimits = Object.fromEntries(RUNTIMES.map((runtime) => [
      runtime,
      positiveInteger(options.runtimeMaxActiveTurns?.[runtime], this.apiTurnLimit),
    ])) as Record<SessionRuntime, number>;
    this.minimumHeadroomBytes = positiveInteger(options.minimumHeadroomBytes, DEFAULT_MINIMUM_HEADROOM_BYTES);
    this.memoryCriticalBytes = positiveInteger(options.memoryCriticalBytes, Math.max(1, Math.floor(this.minimumHeadroomBytes / 4)));
    this.reservedBytesPerTurn = positiveInteger(options.reservedBytesPerTurn, DEFAULT_RESERVED_BYTES_PER_TURN);
    this.memory = options.memory ?? readMemoryCapacity;
    this.readPids = options.readPids ?? readServicePidsCapacity;
    this.retryAfterSeconds = positiveInteger(options.retryAfterSeconds, 2);
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

  /** Projected memory headroom for one more turn, with pressure + critical flags. */
  private memoryState(): { headroomBytes: number; projectedHeadroomBytes: number; pressure: boolean; critical: boolean } {
    const memory = this.memory();
    const headroomBytes = Math.max(0, memory.limitBytes - memory.currentBytes);
    const projectedHeadroomBytes = Math.max(0, headroomBytes - ((this.activeTurns + 1) * this.reservedBytesPerTurn));
    return {
      headroomBytes,
      projectedHeadroomBytes,
      pressure: projectedHeadroomBytes < this.minimumHeadroomBytes,
      critical: projectedHeadroomBytes < this.memoryCriticalBytes,
    };
  }

  snapshot(): AdmissionSnapshot {
    const memory = this.memory();
    const { headroomBytes, projectedHeadroomBytes, pressure: memoryPressure, critical: memoryCritical } = this.memoryState();
    const executionActive = this.activeByClass.P2 + this.activeByClass.P3;
    const executionFull = executionActive >= this.executionCapacity;
    const reason: AdmissionRefusalReason | undefined = memoryPressure
      ? 'memory_pressure'
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
      pids: this.readPids(),
      runtimes: Object.fromEntries(RUNTIMES.map((runtime) => [runtime, {
        activeTurns: this.activeByRuntime[runtime],
        maxActiveTurns: this.runtimeLimits[runtime],
      }])) as AdmissionSnapshot['runtimes'],
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }

  private refusalReason(runtime: SessionRuntime, cls: AdmissionClass): AdmissionRefusalReason | undefined {
    const { pressure, critical } = this.memoryState();
    if (CONTROL_CLASSES.has(cls)) {
      // P0/P1 control is preserved under ordinary memory pressure (emergency mode:
      // execution is refused, control is kept) and refused only at the critical
      // memory floor or the global turn ceiling. It bypasses the execution
      // capacity and per-runtime limits.
      if (critical) return 'memory_pressure';
      if (this.activeTurns >= this.maxActiveTurns) return 'global_limit';
    } else {
      // P2/P3 execution: refused under memory pressure, execution saturation, or per-runtime ceiling.
      if (pressure) return 'memory_pressure';
      const executionActive = this.activeByClass.P2 + this.activeByClass.P3;
      if (executionActive >= this.executionCapacity) return 'global_limit';
      if (this.activeByRuntime[runtime] >= this.runtimeLimits[runtime]) return 'runtime_limit';
    }
    return undefined;
  }
}
