import { InternalApiClient } from '../../server/src/live-validation/internal-api-client.js';
import { computeOpenSessionIds, partitionSweepCandidates } from '../../server/src/live-validation/heap-soak/orphans.js';
import type { LaneEvent } from '../../server/src/live-validation/heap-soak/types.js';

export interface SweepOptions {
  /**
   * B0.1 defect 4: session ids whose `runChild` call is still running. The
   * sweep skips them — they are not orphans, they are live children a wave's
   * straggler still owns and will delete itself in its own finally-block.
   */
  inFlight: ReadonlySet<string>;
  /** B0.1 defect 4: ids this sweep deleted, so a later failure is counted as `orphan_swept`. */
  swept: Set<string>;
}

/**
 * Sweep any child created by this run that is still open per the events log
 * (created but never confirmedly deleted — see computeOpenSessionIds) and that
 * no in-flight driver cycle still tracks. Runs once per cycle so the harness
 * itself never becomes the leak.
 */
export async function sweepOrphans(
  client: InternalApiClient,
  events: readonly LaneEvent[],
  logEvent: (event: LaneEvent) => void,
  elapsedMs: () => number,
  options: SweepOptions,
): Promise<{ swept: string[]; alreadyGone: string[]; skippedInFlight: string[] }> {
  const open = computeOpenSessionIds(events);
  const { sweepable, skippedInFlight } = partitionSweepCandidates(open, options.inFlight);
  const swept: string[] = [];
  const alreadyGone: string[] = [];
  for (const sessionId of sweepable) {
    try {
      await client.deleteSession(sessionId);
      swept.push(sessionId);
      options.swept.add(sessionId);
      logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'orphan_swept', sessionId, detail: 'deleted' });
      // Emit a synthetic child_deleted too, so a later sweep in the same run
      // does not try to delete it again (computeOpenSessionIds is idempotent
      // once a matching child_deleted event exists).
      logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'child_deleted', sessionId });
    } catch (error) {
      // Already gone (e.g. deleted by its own runChild finally-block after
      // this sweep's snapshot was taken) — not an error, just stale data.
      alreadyGone.push(sessionId);
      logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'child_deleted', sessionId, detail: `already gone: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (skippedInFlight.length > 0) {
    logEvent({
      ts: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      lane: 'A',
      kind: 'anomaly',
      detail: `orphan sweep skipped ${skippedInFlight.length} session(s) still tracked by an in-flight driver cycle`,
    });
  }
  return { swept, alreadyGone, skippedInFlight };
}
