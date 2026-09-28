/**
 * Wave/idle cycle schedule and checkpoint timing, kept pure so both the full
 * 24h run and the compressed micro-soak schedule share one tested engine.
 */

export interface ScheduleConfig {
  waveMs: number;
  idleMs: number;
  totalMs: number;
  /** Fractions of totalMs at which a checkpoint ping fires (e.g. full run: [1/24, 6/24, 12/24, 18/24]). */
  checkpointFractions: number[];
  /** How many snapshots to take, evenly spaced start/mid/.../end over totalMs. */
  snapshotCount: number;
  /** Nominal sampler cadence — used both by the sampler loop and by the report's coverage check. */
  sampleIntervalMs: number;
}

/** Production schedule: 24h, checkpoints at +1h/+6h/+12h/+18h, 3 snapshots (start/mid/end). */
export const FULL_SCHEDULE: ScheduleConfig = {
  waveMs: 10 * 60_000,
  idleMs: 5 * 60_000,
  totalMs: 24 * 3_600_000,
  checkpointFractions: [1 / 24, 6 / 24, 12 / 24, 18 / 24],
  snapshotCount: 3,
  sampleIntervalMs: 120_000,
};

/** Micro-soak (Gate 1): ~20 minutes, same shape compressed ~72x. */
export const MICRO_SCHEDULE: ScheduleConfig = {
  waveMs: 60_000,
  idleMs: 30_000,
  totalMs: 20 * 60_000,
  checkpointFractions: [1 / 24, 6 / 24, 12 / 24, 18 / 24],
  snapshotCount: 2,
  sampleIntervalMs: 10_000,
};

/**
 * Bounded full-run window (B0.1 defect 5). `start` accepts `--hours <n>` so
 * D1 can run a bounded soak with the same instrument as E2's final 24 h run.
 * The default stays 24 h.
 */
export const DEFAULT_FULL_RUN_HOURS = 24;
/** A sane minimum: below an hour no checkpoint/snapshot cadence is meaningful, and the GLM warm-up dominates. */
export const MIN_FULL_RUN_HOURS = 1;
/** A week is the ceiling — a longer window would be an unattended-run risk, not a soak. */
export const MAX_FULL_RUN_HOURS = 168;

export type FullRunHoursParse = { ok: true; hours: number } | { ok: false; error: string };

/** Validate a `--hours` value: a positive whole number of hours inside [MIN, MAX]. */
export function parseFullRunHours(raw: string | number | undefined): FullRunHoursParse {
  if (raw === undefined || String(raw).trim() === '') {
    return { ok: false, error: '--hours requires a value (a whole number of hours)' };
  }
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, error: `--hours must be a whole number of hours (got ${JSON.stringify(String(raw))})` };
  }
  if (value < MIN_FULL_RUN_HOURS) return { ok: false, error: `--hours must be at least ${MIN_FULL_RUN_HOURS} hour(s)` };
  if (value > MAX_FULL_RUN_HOURS) return { ok: false, error: `--hours must be at most ${MAX_FULL_RUN_HOURS} hours` };
  return { ok: true, hours: value };
}

/** The full schedule rescaled to `hours`. Checkpoints and snapshot offsets are fractions of totalMs, so both scale. */
export function fullScheduleForHours(hours: number): ScheduleConfig {
  const parsed = parseFullRunHours(hours);
  if (!parsed.ok) throw new RangeError(parsed.error);
  return { ...FULL_SCHEDULE, totalMs: parsed.hours * 3_600_000 };
}

export type PhaseName = 'wave' | 'idle';

export function phaseAt(elapsedMs: number, config: ScheduleConfig): PhaseName {
  const cycleMs = config.waveMs + config.idleMs;
  const intoCycle = ((elapsedMs % cycleMs) + cycleMs) % cycleMs;
  return intoCycle < config.waveMs ? 'wave' : 'idle';
}

/** Absolute ms offsets (from run start) at which checkpoint pings should fire. */
export function checkpointOffsetsMs(config: ScheduleConfig): number[] {
  return config.checkpointFractions.map((f) => Math.round(f * config.totalMs));
}

/** Absolute ms offsets (from run start) at which snapshots should be taken: evenly spaced incl. start and end. */
export function snapshotOffsetsMs(config: ScheduleConfig): number[] {
  const n = config.snapshotCount;
  if (n <= 1) return [0];
  const offsets: number[] = [];
  for (let i = 0; i < n; i++) offsets.push(Math.round((i / (n - 1)) * config.totalMs));
  return offsets;
}

/**
 * B0.1 defect 2: the declared snapshot offsets that the sampler loop can
 * actually reach — everything strictly before the window closes. The offset
 * equal to `totalMs` never fired (the loop exits on `isRunComplete` first), so
 * it is taken explicitly after the window instead of being left to the loop.
 */
export function interimSnapshotOffsetsMs(config: ScheduleConfig): number[] {
  return snapshotOffsetsMs(config).filter((offset) => offset < config.totalMs);
}

/** The declared end-snapshot offset (== the window length), taken after the window closes and before teardown. */
export function endSnapshotOffsetMs(config: ScheduleConfig): number {
  return config.totalMs;
}

/** A dry-run description of the schedule a `start --hours <n>` would run — printed by `cli.ts plan`. */
export interface FullRunPlan {
  mode: 'full';
  hours: number;
  totalMs: number;
  waveMs: number;
  idleMs: number;
  sampleIntervalMs: number;
  checkpointOffsetsMs: number[];
  interimSnapshotOffsetsMs: number[];
  endSnapshotOffsetMs: number;
}

export function fullRunPlan(hours: number): FullRunPlan {
  const schedule = fullScheduleForHours(hours);
  return {
    mode: 'full',
    hours,
    totalMs: schedule.totalMs,
    waveMs: schedule.waveMs,
    idleMs: schedule.idleMs,
    sampleIntervalMs: schedule.sampleIntervalMs,
    checkpointOffsetsMs: checkpointOffsetsMs(schedule),
    interimSnapshotOffsetsMs: interimSnapshotOffsetsMs(schedule),
    endSnapshotOffsetMs: endSnapshotOffsetMs(schedule),
  };
}

/**
 * Given elapsed ms and a list of already-fired offsets (ms), return the next
 * offset (checkpoint or snapshot) that should fire now, or undefined. Pure so
 * "fire once, in order, tolerant of a supervisor restart between checks" is
 * testable without a real clock.
 */
export function nextDueOffset(elapsedMs: number, offsets: readonly number[], firedOffsets: ReadonlySet<number>): number | undefined {
  const due = offsets.filter((o) => o <= elapsedMs && !firedOffsets.has(o)).sort((a, b) => a - b);
  return due[0];
}

export function isRunComplete(elapsedMs: number, config: ScheduleConfig): boolean {
  return elapsedMs >= config.totalMs;
}
