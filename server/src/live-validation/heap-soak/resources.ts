/**
 * Soak-unit resource limits (B0 defect 4).
 *
 * The disposable soak server must run with a cgroup `MemoryMax` large enough
 * that admission's `memory_pressure` does NOT throttle the load profile before
 * the V8 heap cap binds. In A1 the unit had `MemoryMax=6G` while production
 * runs 18 GiB, so admission (projected headroom < minimum headroom, with a
 * 512 MiB reservation per active turn) refused 574 prompts from minute 21 —
 * the run stopped exercising the heap long before the 4 GiB heap cap mattered.
 *
 * Grounding (all measured, not estimated):
 * - A1's final samples show RSS 6,070,779,904 bytes (≈5,789 MiB) at heap
 *   4,240,669,648 bytes (≈4,044 MiB) — i.e. the heap cap binds at ≈5.8 GiB RSS.
 * - Admission pressure triggers when
 *     (MemoryMax − RSS) − (activeTurns + 1) × reservedBytesPerTurn < minimumHeadroom.
 *   The disposable server runs non-production, so the admission defaults apply:
 *   minimumHeadroom = 512 MiB, reservedBytesPerTurn = 512 MiB (see
 *   server/src/internal-api/admission-controller.ts), maxActiveTurns = 16.
 * - The soak driver's real concurrency is bounded by the lanes: lane A
 *   maxConcurrent 6 + lane B 1, with a wave target of 4 completed children.
 *   `SOAK_ASSUMED_ACTIVE_TURNS = 7` is therefore a conservative ceiling.
 *
 * With MemoryMax = 12 GiB the admission throttle threshold is
 *   12288 − 512 − 8×512 = 6,656 MiB,
 * comfortably above the 5,789 MiB heap-cap RSS, so the heap cap binds first.
 * `MemoryHigh = 10 GiB` is a soft-reclaim boundary above any legitimate RSS
 * (so the `memory.high` pressure term never fires in normal operation) yet
 * below `MemoryMax`, so a runaway native leak is throttled before the cap.
 * The 12 GiB cap itself is the host-safety cap: on a 31 GiB host it leaves
 * ≈19 GiB for the OS and production, unlike production's own 18 GiB.
 *
 * Pure and unit-tested; `launcher.ts` applies the resolved strings.
 */

/** A1 final sample RSS at the V8 heap cap: 6,070,779,904 bytes. */
export const A1_RSS_AT_HEAP_CAP_MIB = Math.round(6_070_779_904 / (1024 * 1024));

/** Host-safety ceiling for the soak unit's cgroup cap (14 GiB). */
export const SOAK_MEMORY_SAFETY_CAP_MIB = 14 * 1024;

/** Conservative ceiling on concurrently-active admission turns during a soak wave. */
export const SOAK_ASSUMED_ACTIVE_TURNS = 7;

/** admission-controller.ts DEFAULT_MINIMUM_HEADROOM_BYTES (non-production). */
export const ADMISSION_MINIMUM_HEADROOM_MIB = 512;

/** admission-controller.ts DEFAULT_RESERVED_BYTES_PER_TURN. */
export const ADMISSION_RESERVED_MIB_PER_TURN = 512;

export interface SoakMemoryLimits {
  memoryMaxMiB: number;
  memoryHighMiB: number;
  rssAtHeapCapMiB: number;
  minimumHeadroomMiB: number;
  reservedPerTurnMiB: number;
  assumedActiveTurns: number;
}

export const MEMORY_MAX_ENV_KEY = 'HEAP_SOAK_MEMORY_MAX_MIB';
export const MEMORY_HIGH_ENV_KEY = 'HEAP_SOAK_MEMORY_HIGH_MIB';

const DEFAULT_MEMORY_MAX_MIB = 12 * 1024;
const DEFAULT_MEMORY_HIGH_MIB = 10 * 1024;
/** Below 1 GiB the server cannot boot its seeded registry; the floor only exists so a typo cannot wedge the run. */
const MIN_MEMORY_MAX_MIB = 1024;
const MIN_MEMORY_HIGH_MIB = 512;

function readEnvMiB(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = (env[key] ?? '').trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${key} must be a whole number of MiB (got ${JSON.stringify(raw)})`);
  }
  if (value < min) {
    throw new Error(`${key} must be at least ${min} MiB (got ${value})`);
  }
  if (value > SOAK_MEMORY_SAFETY_CAP_MIB) {
    throw new Error(`${key} must not exceed the host-safety cap SOAK_MEMORY_SAFETY_CAP_MIB=${SOAK_MEMORY_SAFETY_CAP_MIB} (got ${value})`);
  }
  return value;
}

/**
 * The chosen soak-unit cgroup limits plus the inputs to the throttle arithmetic.
 *
 * E2a-1: `HEAP_SOAK_MEMORY_MAX_MIB` / `HEAP_SOAK_MEMORY_HIGH_MIB` override the
 * B0 defaults (12G/10G) — the bounded soak's brief binds MemoryMax ≤ 8G and
 * MemoryHigh ≤ 6G because the host guard soft-alerts below 8 GiB MemAvailable.
 * Both overrides are validated fail-closed (integer, floor, ≤ the host-safety
 * cap, high strictly below max); unset ⇒ the historic B0 limits.
 */
export function resolveSoakMemoryLimits(env: NodeJS.ProcessEnv = process.env): SoakMemoryLimits {
  const memoryMaxMiB = readEnvMiB(env, MEMORY_MAX_ENV_KEY, DEFAULT_MEMORY_MAX_MIB, MIN_MEMORY_MAX_MIB);
  const memoryHighMiB = readEnvMiB(env, MEMORY_HIGH_ENV_KEY, DEFAULT_MEMORY_HIGH_MIB, MIN_MEMORY_HIGH_MIB);
  if (memoryHighMiB >= memoryMaxMiB) {
    throw new Error(`${MEMORY_HIGH_ENV_KEY} (${memoryHighMiB}) must be below ${MEMORY_MAX_ENV_KEY} (${memoryMaxMiB})`);
  }
  return {
    memoryMaxMiB,
    memoryHighMiB,
    rssAtHeapCapMiB: A1_RSS_AT_HEAP_CAP_MIB,
    minimumHeadroomMiB: ADMISSION_MINIMUM_HEADROOM_MIB,
    reservedPerTurnMiB: ADMISSION_RESERVED_MIB_PER_TURN,
    assumedActiveTurns: SOAK_ASSUMED_ACTIVE_TURNS,
  };
}

/**
 * RSS (MiB) above which admission would refuse a new execution turn with
 * `memory_pressure`, given the cgroup cap and the per-turn reservation.
 */
export function admissionThrottleThresholdMiB(limits: SoakMemoryLimits): number {
  return limits.memoryMaxMiB - limits.minimumHeadroomMiB - (limits.assumedActiveTurns + 1) * limits.reservedPerTurnMiB;
}

/** True when the V8 heap cap binds (RSS reaches the heap-cap level) before admission throttles. */
export function heapCapBindsFirst(limits: SoakMemoryLimits = resolveSoakMemoryLimits()): boolean {
  return admissionThrottleThresholdMiB(limits) > limits.rssAtHeapCapMiB;
}
