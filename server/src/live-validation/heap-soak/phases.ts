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
