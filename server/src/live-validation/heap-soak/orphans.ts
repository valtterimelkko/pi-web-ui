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
 * Server-side orphan reconciliation (B0.1 correction 04).
 *
 * The event-log reconciliation above only knows sessions that produced an
 * event. If the supervisor is killed while a `createSession` is in flight, the
 * session is created on the server but `child_created` is never logged, so the
 * sweep misses it and it survives — the parent traced exactly this in run 4
 * (Gate 1's SIGKILL of the supervisor at 22:43:34, session
 * `01a0ea30-…`, cwd `children/A-5527047e`, never prompted). The restarted
 * supervisor's trackers are empty, so the server's own session list is the only
 * remaining source of truth.
 */

/** The subset of a server `SessionInfo` this reconciliation needs. */
export interface ServerSessionRef {
  sessionId: string;
  cwd?: string;
  createdAt?: string;
}

/** Every session id that appears anywhere in the events log — the harness's full known set. */
export function trackedSessionIds(events: readonly LaneEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.sessionId) ids.add(event.sessionId);
  }
  return ids;
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

/** True when `cwd` is the child-workspace root itself or a directory under it (never a prefix-sharing sibling). */
export function isUnderChildWorkspace(cwd: string | undefined, childWorkspaceRoot: string): boolean {
  if (!cwd) return false;
  const root = stripTrailingSlash(childWorkspaceRoot);
  const target = stripTrailingSlash(cwd);
  return target === root || target.startsWith(`${root}/`);
}

export interface UntrackedOrphanInput {
  /** Absolute `<runDir>/children` for THIS run. */
  childWorkspaceRoot: string;
  /** Session ids the harness already knows (events, in-flight, swept). */
  tracked: ReadonlySet<string>;
  nowMs: number;
  /** A session younger than this is held back (its create may still be resolving). */
  graceMs: number;
}

export interface UntrackedOrphanSelection {
  sweepable: string[];
  skippedYoung: string[];
}

/**
 * Server sessions under this run's children cwd that the harness has no record
 * of (and that are past the grace window). Pure: the caller lists the server
 * and performs the deletes.
 */
export function findUntrackedChildrenSessions(
  entries: readonly ServerSessionRef[],
  input: UntrackedOrphanInput,
): UntrackedOrphanSelection {
  const sweepable: string[] = [];
  const skippedYoung: string[] = [];
  for (const entry of entries) {
    if (!entry.sessionId || input.tracked.has(entry.sessionId)) continue;
    if (!isUnderChildWorkspace(entry.cwd, input.childWorkspaceRoot)) continue;
    const createdMs = entry.createdAt ? Date.parse(entry.createdAt) : Number.NaN;
    if (Number.isFinite(createdMs) && input.nowMs - createdMs < input.graceMs) {
      skippedYoung.push(entry.sessionId);
      continue;
    }
    sweepable.push(entry.sessionId);
  }
  return { sweepable, skippedYoung };
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
