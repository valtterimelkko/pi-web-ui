import type { LaneEvent } from './types.js';

/**
 * Orphan detection reuses the same lane-events log the driver already writes
 * (child_created / child_deleted), rather than a second bookkeeping ledger:
 * a session id with a `child_created` event but no later `child_deleted`
 * event for that same session id is still open and should be swept.
 */
export function computeOpenSessionIds(events: readonly LaneEvent[]): string[] {
  const createdOrder: string[] = [];
  const created = new Set<string>();
  const deleted = new Set<string>();
  for (const e of events) {
    if (!e.sessionId) continue;
    if (e.kind === 'child_created') {
      if (!created.has(e.sessionId)) createdOrder.push(e.sessionId);
      created.add(e.sessionId);
    } else if (e.kind === 'child_deleted') {
      deleted.add(e.sessionId);
    }
  }
  return createdOrder.filter((id) => !deleted.has(id));
}

/**
 * Orphan-sweep race (B0.1 defect 4). The confirmation soak's 167 lane-A
 * `SESSION_NOT_FOUND` failures all followed the same sequence:
 * `child_created` -> `child_tool_call_seen` -> `orphan_swept` -> the driver's
 * own follow-up prompt or delete failed. The sweep was deleting children a
 * wave's stragglers still owned, and the harness then counted its own deletion
 * as a child failure.
 *
 * The fix has two halves:
 *   1. the sweep only touches sessions no in-flight driver cycle still tracks
 *      (this partition); and
 *   2. if a swept session nevertheless fails later, it is accounted as
 *      `orphan_swept`, not `child_failed` (see {@link classifyChildFailure}).
 */
export function partitionSweepCandidates(
  openSessionIds: readonly string[],
  inFlight: ReadonlySet<string>,
): { sweepable: string[]; skippedInFlight: string[] } {
  const sweepable: string[] = [];
  const skippedInFlight: string[] = [];
  for (const sessionId of openSessionIds) {
    if (inFlight.has(sessionId)) skippedInFlight.push(sessionId);
    else sweepable.push(sessionId);
  }
  return { sweepable, skippedInFlight };
}

/**
 * Which event kind a child failure should be recorded under: the harness's own
 * sweep deleting a session is `orphan_swept`, never a child failure.
 */
export function classifyChildFailure(input: { sessionId?: string; sweptByHarness: boolean }): 'child_failed' | 'orphan_swept' {
  return input.sessionId !== undefined && input.sweptByHarness ? 'orphan_swept' : 'child_failed';
}

/**
 * How a session DELETE failed. `already-gone` is only a confirmed not-found
 * (HTTP 404 / `SESSION_NOT_FOUND`); every other failure is `transient` and the
 * session must stay OPEN — a timeout or 5xx must never be recorded as a
 * `child_deleted`, or the drain/sweep would treat a still-live child as gone
 * (B0.1 correction 03 item 2).
 */
export type DeleteErrorOutcome = 'already-gone' | 'transient';

export function classifyDeleteError(error: unknown): DeleteErrorOutcome {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (code === 'SESSION_NOT_FOUND') return 'already-gone';
    if (statusCode === 404) return 'already-gone';
  }
  return 'transient';
}

/**
 * Regression invariant for the accounting fix: session ids that have BOTH an
 * `orphan_swept` and a later `child_failed` event. A correct harness reports
 * none — the sweep's own deletions are counted as `orphan_swept`.
 */
export function sweptChildFailures(events: readonly LaneEvent[]): string[] {
  const swept = new Set<string>();
  const misCounted: string[] = [];
  for (const e of events) {
    if (!e.sessionId) continue;
    if (e.kind === 'orphan_swept') swept.add(e.sessionId);
    else if (e.kind === 'child_failed' && swept.has(e.sessionId) && !misCounted.includes(e.sessionId)) misCounted.push(e.sessionId);
  }
  return misCounted;
}
