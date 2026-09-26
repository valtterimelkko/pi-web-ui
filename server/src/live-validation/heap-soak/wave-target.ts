import type { LaneName, WaveTargetConfig } from './types.js';

/**
 * Wave/top-up scheduling (owner amendment 2026-09-26): the load target is a
 * count of completed children per wave, not "wait for every lane". Waves are
 * time-based; when the wave's time budget elapses, whatever lanes B/C did or
 * didn't deliver, the backbone lane (A) tops up completions to the target.
 * This module is the pure arithmetic — completely independent of how children
 * are actually dispatched, so it can be tested without touching the network.
 */

export interface WaveOutcome {
  completedByLane: Partial<Record<LaneName, number>>;
}

/** How many additional backbone-lane children are needed to reach the wave's target. */
export function computeTopUpCount(
  outcome: WaveOutcome,
  config: WaveTargetConfig,
  backboneLane: LaneName,
): number {
  const totalCompleted = Object.values(outcome.completedByLane).reduce((sum, n) => sum + (n ?? 0), 0);
  const shortfall = config.targetPerWave - totalCompleted;
  if (shortfall <= 0) return 0;
  // The backbone lane's own already-completed count doesn't need double
  // counting — the shortfall is already "total needed minus total delivered".
  void backboneLane;
  return shortfall;
}

/**
 * Whether this wave counts as the "all lanes down" anomaly. Per the owner
 * amendment, ONLY the backbone lane failing entirely (zero completions, and
 * unable to top up) triggers this — non-backbone lanes failing is expected
 * and logged, never paged.
 */
export function isBackboneDownAnomaly(
  outcome: WaveOutcome,
  config: WaveTargetConfig,
  backboneLane: LaneName,
): boolean {
  const backboneCompleted = outcome.completedByLane[backboneLane] ?? 0;
  const totalCompleted = Object.values(outcome.completedByLane).reduce((sum, n) => sum + (n ?? 0), 0);
  // The backbone is "down" if it delivered nothing AND the wave still missed
  // its target overall (a wave that hit target without the backbone's help
  // is not an anomaly — but per the amendment the backbone is expected to be
  // the one topping up, so zero backbone completions while under target is
  // exactly the case that matters).
  return backboneCompleted === 0 && totalCompleted < config.targetPerWave;
}
