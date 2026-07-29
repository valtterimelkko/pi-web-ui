import { readFileSync } from 'fs';
import { availableParallelism, totalmem } from 'os';
import type { SessionRuntime } from './types.js';

export type AdmissionRefusalReason = 'global_limit' | 'runtime_limit' | 'memory_pressure';

export class AdmissionCapacityError extends Error {
  constructor(public readonly reason: AdmissionRefusalReason, public readonly retryAfterSeconds = 2) {
    super(`Internal API admission refused: ${reason}`);
    this.name = 'AdmissionCapacityError';
  }
}

export interface MemoryCapacity {
  currentBytes: number;
  limitBytes: number;
}

export interface AdmissionSnapshot {
  available: boolean;
  reason?: AdmissionRefusalReason;
  activeTurns: number;
  maxActiveTurns: number;
  interactiveReserve: number;
  apiTurnLimit: number;
  memory: MemoryCapacity & { headroomBytes: number; minimumHeadroomBytes: number; reservedBytesPerTurn: number; projectedHeadroomBytes: number };
  runtimes: Record<SessionRuntime, { activeTurns: number; maxActiveTurns: number }>;
  retryAfterSeconds: number;
}

export interface AdmissionControllerOptions {
  /** Total process execution budget; one slot remains reserved for Web UI work. */
  maxActiveTurns?: number;
  interactiveReserve?: number;
  runtimeMaxActiveTurns?: Partial<Record<SessionRuntime, number>>;
  minimumHeadroomBytes?: number;
  /** Conservative memory reservation applied before each admitted turn. */
  reservedBytesPerTurn?: number;
  memory?: () => MemoryCapacity;
  retryAfterSeconds?: number;
}

const RUNTIMES: SessionRuntime[] = ['pi', 'claude', 'opencode', 'antigravity'];
const DEFAULT_MINIMUM_HEADROOM_BYTES = 512 * 1024 * 1024;
const DEFAULT_RESERVED_BYTES_PER_TURN = 256 * 1024 * 1024;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

function readNumber(path: string): number | undefined {
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (value === 'max') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Uses cgroup-v2 aggregate memory when available, otherwise process RSS/host RAM. */
export function readMemoryCapacity(): MemoryCapacity {
  const current = readNumber('/sys/fs/cgroup/memory.current');
  const limit = readNumber('/sys/fs/cgroup/memory.max');
  if (current !== undefined && limit !== undefined) return { currentBytes: current, limitBytes: limit };
  return { currentBytes: process.memoryUsage().rss, limitBytes: totalmem() };
}

export class AdmissionController {
  private activeTurns = 0;
  private readonly activeByRuntime: Record<SessionRuntime, number> = {
    pi: 0, claude: 0, opencode: 0, antigravity: 0,
  };
  private readonly maxActiveTurns: number;
  private readonly interactiveReserve: number;
  private readonly apiTurnLimit: number;
  private readonly runtimeLimits: Record<SessionRuntime, number>;
  private readonly minimumHeadroomBytes: number;
  private readonly memory: () => MemoryCapacity;
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
    this.runtimeLimits = Object.fromEntries(RUNTIMES.map((runtime) => [
      runtime,
      positiveInteger(options.runtimeMaxActiveTurns?.[runtime], this.apiTurnLimit),
    ])) as Record<SessionRuntime, number>;
    this.minimumHeadroomBytes = positiveInteger(options.minimumHeadroomBytes, DEFAULT_MINIMUM_HEADROOM_BYTES);
    this.reservedBytesPerTurn = positiveInteger(options.reservedBytesPerTurn, DEFAULT_RESERVED_BYTES_PER_TURN);
    this.memory = options.memory ?? readMemoryCapacity;
    this.retryAfterSeconds = positiveInteger(options.retryAfterSeconds, 2);
  }

  async acquire(runtime: SessionRuntime): Promise<{ release: () => void }> {
    const reason = this.refusalReason(runtime);
    if (reason) throw new AdmissionCapacityError(reason, this.retryAfterSeconds);
    // JavaScript's run-to-completion makes this check+increment atomic within
    // one server process (there is no await between them).
    this.activeTurns += 1;
    this.activeByRuntime[runtime] += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeTurns = Math.max(0, this.activeTurns - 1);
        this.activeByRuntime[runtime] = Math.max(0, this.activeByRuntime[runtime] - 1);
      },
    };
  }

  snapshot(): AdmissionSnapshot {
    const memory = this.memory();
    const headroomBytes = Math.max(0, memory.limitBytes - memory.currentBytes);
    const projectedHeadroomBytes = Math.max(0, headroomBytes - ((this.activeTurns + 1) * this.reservedBytesPerTurn));
    const memoryPressure = projectedHeadroomBytes < this.minimumHeadroomBytes;
    const globalFull = this.activeTurns >= this.apiTurnLimit;
    const reason: AdmissionRefusalReason | undefined = memoryPressure
      ? 'memory_pressure'
      : globalFull ? 'global_limit' : undefined;
    return {
      available: reason === undefined,
      reason,
      activeTurns: this.activeTurns,
      maxActiveTurns: this.maxActiveTurns,
      interactiveReserve: this.interactiveReserve,
      apiTurnLimit: this.apiTurnLimit,
      memory: { ...memory, headroomBytes, minimumHeadroomBytes: this.minimumHeadroomBytes, reservedBytesPerTurn: this.reservedBytesPerTurn, projectedHeadroomBytes },
      runtimes: Object.fromEntries(RUNTIMES.map((runtime) => [runtime, {
        activeTurns: this.activeByRuntime[runtime],
        maxActiveTurns: this.runtimeLimits[runtime],
      }])) as AdmissionSnapshot['runtimes'],
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }

  private refusalReason(runtime: SessionRuntime): AdmissionRefusalReason | undefined {
    const snapshot = this.snapshot();
    if (snapshot.reason) return snapshot.reason;
    if (this.activeByRuntime[runtime] >= this.runtimeLimits[runtime]) return 'runtime_limit';
    return undefined;
  }
}
