import { InternalApiClient } from '../../server/src/live-validation/internal-api-client.js';
import { computeOpenSessionIds } from '../../server/src/live-validation/heap-soak/orphans.js';
import type { LaneEvent } from '../../server/src/live-validation/heap-soak/types.js';

/**
 * Sweep any child created by this run that is still open per the events log
 * (created but never confirmedly deleted — see computeOpenSessionIds). Runs
 * once per cycle so the harness itself never becomes the leak.
 */
export async function sweepOrphans(
  client: InternalApiClient,
  events: readonly LaneEvent[],
  logEvent: (event: LaneEvent) => void,
  elapsedMs: () => number,
): Promise<{ swept: string[]; alreadyGone: string[] }> {
  const open = computeOpenSessionIds(events);
  const swept: string[] = [];
  const alreadyGone: string[] = [];
  for (const sessionId of open) {
    try {
      await client.deleteSession(sessionId);
      swept.push(sessionId);
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
  return { swept, alreadyGone };
}
