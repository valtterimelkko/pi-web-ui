import { InternalApiClient } from '../../server/src/live-validation/internal-api-client.js';
import {
  classifyDeleteError,
  computeOpenSessionIds,
  findUntrackedChildrenSessions,
  partitionSweepCandidates,
  type ServerSessionRef,
} from '../../server/src/live-validation/heap-soak/orphans.js';
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

export interface UntrackedSweepOptions {
  /** Absolute `<runDir>/children` for THIS run. */
  childWorkspaceRoot: string;
  /** Every session id the harness already knows (trackedSessionIds(events) ∪ inFlight). */
  tracked: ReadonlySet<string>;
  /** A server session younger than this is held back. */
  graceMs?: number;
  maxDeleteAttempts?: number;
  retryDelayMs?: number;
}

export interface UntrackedSweepResult {
  swept: string[];
  alreadyGone: string[];
  failedTransient: string[];
  skippedYoung: string[];
}

const DEFAULT_MAX_DELETE_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DeleteOutcome {
  outcome: 'deleted' | 'already-gone' | 'transient';
  attempts: number;
  error?: unknown;
}

/**
 * Correction 03 item 2: only a confirmed not-found terminalises. A transient
 * failure is retried up to `maxAttempts`; if it keeps failing the caller must
 * leave the session OPEN (never write a `child_deleted` for it).
 */
async function deleteSessionWithRetry(
  client: InternalApiClient,
  sessionId: string,
  maxAttempts: number,
  retryDelayMs: number,
): Promise<DeleteOutcome> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await client.deleteSession(sessionId);
      return { outcome: 'deleted', attempts: attempt };
    } catch (error) {
      if (classifyDeleteError(error) === 'already-gone') return { outcome: 'already-gone', attempts: attempt, error };
      if (attempt < maxAttempts) await sleep(retryDelayMs);
      else return { outcome: 'transient', attempts: attempt, error };
    }
  }
  /* istanbul ignore next -- loop always returns */
  return { outcome: 'transient', attempts: maxAttempts };
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
): Promise<SweepResult> {
  const open = computeOpenSessionIds(events);
  const { sweepable, skippedInFlight } = partitionSweepCandidates(open, options.inFlight);
  const maxAttempts = options.maxDeleteAttempts ?? DEFAULT_MAX_DELETE_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const swept: string[] = [];
  const alreadyGone: string[] = [];
  const failedTransient: string[] = [];

  for (const sessionId of sweepable) {
    const result = await deleteSessionWithRetry(client, sessionId, maxAttempts, retryDelayMs);
    if (result.outcome === 'deleted') {
      swept.push(sessionId);
      options.swept.add(sessionId);
      logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'orphan_swept', sessionId, detail: `deleted (attempt ${result.attempts})` });
      logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'child_deleted', sessionId });
    } else if (result.outcome === 'already-gone') {
      alreadyGone.push(sessionId);
      logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'child_deleted', sessionId, detail: `already gone: ${result.error instanceof Error ? result.error.message : String(result.error)}` });
    } else {
      failedTransient.push(sessionId);
      logEvent({
        ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'anomaly', sessionId,
        detail: `orphan sweep could not delete after ${result.attempts} attempts (treated as still live, left open): ${result.error instanceof Error ? result.error.message : String(result.error)}`,
      });
    }
  }

  if (skippedInFlight.length > 0) {
    logEvent({
      ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'anomaly',
      detail: `orphan sweep skipped ${skippedInFlight.length} session(s) still tracked by an in-flight driver cycle`,
    });
  }
  return { swept, alreadyGone, skippedInFlight, failedTransient };
}

/**
 * B0.1 correction 04: server-side orphan reconciliation. The event-log sweep
 * above cannot see a session whose `createSession` was in flight when the
 * supervisor was killed (no `child_created` was logged). This lists the
 * server's sessions, selects ones under THIS run's children cwd that the
 * harness has no record of and that are past a grace window, and deletes them
 * as `orphan_swept` (`detail: untracked`). The correction-03 rule still applies:
 * only a confirmed not-found terminalises; a transient failure is left OPEN.
 */
export async function sweepUntrackedServerSessions(
  client: InternalApiClient,
  entries: readonly ServerSessionRef[],
  logEvent: (event: LaneEvent) => void,
  elapsedMs: () => number,
  options: UntrackedSweepOptions,
): Promise<UntrackedSweepResult> {
  const maxAttempts = options.maxDeleteAttempts ?? DEFAULT_MAX_DELETE_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const { sweepable, skippedYoung } = findUntrackedChildrenSessions(entries, {
    childWorkspaceRoot: options.childWorkspaceRoot,
    tracked: options.tracked,
    nowMs: Date.now(),
    graceMs: options.graceMs ?? 30_000,
  });
  const swept: string[] = [];
  const alreadyGone: string[] = [];
  const failedTransient: string[] = [];

  for (const sessionId of sweepable) {
    const result = await deleteSessionWithRetry(client, sessionId, maxAttempts, retryDelayMs);
    if (result.outcome === 'deleted') {
      swept.push(sessionId);
      logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'orphan_swept', sessionId, detail: `untracked (deleted on attempt ${result.attempts})` });
      logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'child_deleted', sessionId, detail: 'untracked orphan' });
    } else if (result.outcome === 'already-gone') {
      alreadyGone.push(sessionId);
      logEvent({ ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'child_deleted', sessionId, detail: `untracked orphan already gone: ${result.error instanceof Error ? result.error.message : String(result.error)}` });
    } else {
      failedTransient.push(sessionId);
      logEvent({
        ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'anomaly', sessionId,
        detail: `untracked orphan could not be deleted after ${result.attempts} attempts (treated as still live, left open): ${result.error instanceof Error ? result.error.message : String(result.error)}`,
      });
    }
  }

  if (skippedYoung.length > 0) {
    logEvent({
      ts: new Date().toISOString(), elapsedMs: elapsedMs(), lane: 'A', kind: 'anomaly',
      detail: `untracked-orphan sweep held back ${skippedYoung.length} session(s) inside the grace window`,
    });
  }
  return { swept, alreadyGone, failedTransient, skippedYoung };
}
