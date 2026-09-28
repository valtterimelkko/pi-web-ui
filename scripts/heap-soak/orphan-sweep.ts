import { InternalApiClient } from '../../server/src/live-validation/internal-api-client.js';
import { classifyDeleteError, computeOpenSessionIds, partitionSweepCandidates } from '../../server/src/live-validation/heap-soak/orphans.js';
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
  /** Correction 03 item 2: how many times a transient DELETE failure is retried before the session is left open. */
  maxDeleteAttempts?: number;
  /** Correction 03 item 2: delay between transient DELETE retries. */
  retryDelayMs?: number;
}

export interface SweepResult {
  swept: string[];
  alreadyGone: string[];
  skippedInFlight: string[];
  /** Correction 03 item 2: sessions whose DELETE kept failing transiently — left OPEN and counted as live by the drain. */
  failedTransient: string[];
}

const DEFAULT_MAX_DELETE_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sweep any child created by this run that is still open per the events log
 * (created but never confirmedly deleted — see computeOpenSessionIds) and that
 * no in-flight driver cycle still tracks. Runs once per cycle so the harness
 * itself never becomes the leak.
 *
 * Correction 03 item 2: **only a confirmed not-found terminalises a child.**
 * A timeout or 5xx is retried within a bound and, if it keeps failing, the
 * session is left OPEN (no `child_deleted`, no `orphan_swept`) and reported as
 * `failedTransient`, so a still-live session can never be silently closed in
 * the events log (which is what the end drain reads).
 */
export async function sweepOrphans(
  client: InternalApiClient,
  events: readonly LaneEvent[],
  logEvent: (event: LaneEvent) => void,
  elapsedMs: () => number,
  options: SweepOptions,
): Promise<SweepResult> {
  const open = computeOpenSessionIds(events);
  const { sweepable, skippedInFlight } = partitionSweepCandidates(open, options.inFlight);
  const maxAttempts = options.maxDeleteAttempts ?? DEFAULT_MAX_DELETE_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const swept: string[] = [];
  const alreadyGone: string[] = [];
  const failedTransient: string[] = [];

  for (const sessionId of sweepable) {
    let terminal = false;
    let lastTransientError: unknown;
    for (let attempt = 1; attempt <= maxAttempts && !terminal; attempt++) {
      try {
        await client.deleteSession(sessionId);
        swept.push(sessionId);
        options.swept.add(sessionId);
        logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'orphan_swept', sessionId, detail: `deleted (attempt ${attempt})` });
        // Emit a synthetic child_deleted too, so a later sweep in the same run
        // does not try to delete it again (computeOpenSessionIds is idempotent
        // once a matching child_deleted event exists).
        logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'child_deleted', sessionId });
        terminal = true;
      } catch (error) {
        if (classifyDeleteError(error) === 'already-gone') {
          alreadyGone.push(sessionId);
          logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'child_deleted', sessionId, detail: `already gone: ${error instanceof Error ? error.message : String(error)}` });
          terminal = true;
        } else {
          lastTransientError = error;
          if (attempt < maxAttempts) await sleep(retryDelayMs);
        }
      }
    }
    if (!terminal) {
      // Transient failure: the session may still exist. Leave it OPEN (no
      // child_deleted) so the drain counts it as live rather than assuming it
      // is gone.
      failedTransient.push(sessionId);
      logEvent({
        ts: new Date().toISOString(),
        elapsedMs: elapsedMs(),
        lane: 'A',
        kind: 'anomaly',
        sessionId,
        detail: `orphan sweep could not delete after ${maxAttempts} attempts (treated as still live, left open): ${lastTransientError instanceof Error ? lastTransientError.message : String(lastTransientError)}`,
      });
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
  return { swept, alreadyGone, skippedInFlight, failedTransient };
}
