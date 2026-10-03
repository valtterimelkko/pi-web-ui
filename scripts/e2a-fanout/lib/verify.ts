/**
 * 08-correction items 1–3 (Luna review findings 3, 4, 5): fail-closed cleanup
 * verification, cleanup-before-release on any post-create exception, and a
 * route check that validates every child BEFORE any prompt dispatch.
 */
import { getJson, type SocketConn } from './httpclient.ts';

export interface CleanupVerification {
  ok: boolean;
  failures: string[];
}

/**
 * Item 1: cleanup verification fails closed.
 * - the status command must exit 0;
 * - its output must parse as JSON with a `children` array, which must be empty;
 * - every created session id must answer HTTP 404 afterwards.
 */
export async function verifyCleanup(input: {
  statusExitCode: number;
  statusStdout: string;
  createdIds: string[];
  fetchSessionStatus: (id: string) => Promise<number | null>;
}): Promise<CleanupVerification> {
  const failures: string[] = [];
  if (input.statusExitCode !== 0) {
    failures.push(`status command failed (exit ${String(input.statusExitCode)})`);
  }
  let children: unknown = undefined;
  try {
    const parsed = JSON.parse(input.statusStdout) as Record<string, unknown>;
    children = parsed['children'];
  } catch {
    failures.push('status output is not parsable JSON');
  }
  if (!Array.isArray(children)) {
    if (!failures.some((f) => f.includes('parsable'))) failures.push('status output has no children array');
  } else if (children.length > 0) {
    failures.push(`owner still lists ${String(children.length)} child(ren): ${JSON.stringify(children).slice(0, 400)}`);
  }
  for (const id of input.createdIds) {
    let status: number | null = null;
    try {
      status = await input.fetchSessionStatus(id);
    } catch (err) {
      failures.push(`session ${id}: status check errored (${String(err).slice(0, 120)})`);
      continue;
    }
    if (status !== 404) {
      failures.push(`session ${id} still exists (GET status ${String(status)}, expected 404)`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/** Live helper: GET /api/v1/sessions/:id through the Internal API socket; null when the read itself fails. */
export async function fetchSessionStatusLive(conn: SocketConn, id: string): Promise<number | null> {
  try {
    const res = await getJson(conn, `/api/v1/sessions/${encodeURIComponent(id)}`);
    return res.status;
  } catch {
    return null;
  }
}

export interface ChildStatus {
  child: string;
  code: number;
  stdout: string;
}

export interface RouteCheck {
  ok: boolean;
  violations: string[];
  /** Empty unless EVERY child passed (fail closed, all-or-nothing). */
  dispatchableChildren: string[];
}

/**
 * Item 3: collect-and-validate every child's status BEFORE dispatching any
 * prompt. A failed command, unparsable output, or `fallbackApplied: true` on
 * any single child aborts the arm (zero dispatchable children).
 */
export function checkRoutes(statuses: ChildStatus[]): RouteCheck {
  const violations: string[] = [];
  for (const st of statuses) {
    if (st.code !== 0) {
      violations.push(`${st.child}: status command failed (exit ${String(st.code)})`);
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(st.stdout) as Record<string, unknown>;
    } catch {
      violations.push(`${st.child}: malformed status output (not JSON)`);
      continue;
    }
    if (parsed['fallbackApplied'] === true) {
      violations.push(`${st.child}: fallbackApplied=true — unapproved route`);
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    dispatchableChildren: violations.length === 0 ? statuses.map((s) => s.child) : [],
  };
}

export interface CleanupSafetyResult<T> {
  result?: T;
  error?: unknown;
  cleanupIds: string[];
  cleanupRan: boolean;
  verification: CleanupVerification | null;
  order: string[];
}

/**
 * Item 2: every exception after the first create runs cleanupAll (and the
 * verification) BEFORE the lock release. `createChildren` returns whatever
 * sessions were actually created; if IT throws, nothing was created and only
 * the release runs. `work` throwing still cleans up. `releaseLock` always
 * runs last, after cleanup + verification.
 */
export async function withFailClosedCleanup<T>(deps: {
  createChildren: () => Promise<Array<{ sessionId?: string }>>;
  work: () => Promise<T>;
  cleanupAll: (ids: string[]) => Promise<void>;
  verifyCleanupAfter: (ids: string[]) => Promise<CleanupVerification>;
  releaseLock: () => void;
}): Promise<CleanupSafetyResult<T>> {
  const order: string[] = [];
  const out: CleanupSafetyResult<T> = { cleanupIds: [], cleanupRan: false, verification: null, order };
  try {
    const outcomes = await deps.createChildren();
    out.cleanupIds = outcomes.flatMap((o) => (o.sessionId !== undefined ? [o.sessionId] : []));
    try {
      out.result = await deps.work();
    } catch (err) {
      out.error = err;
    }
  } catch (err) {
    // Nothing (or only partial ids returned) was created; record and release.
    out.error = err;
    order.push('release');
    deps.releaseLock();
    return out;
  }
  if (out.cleanupIds.length > 0) {
    order.push(`cleanup:${out.cleanupIds.join(',')}`);
    await deps.cleanupAll(out.cleanupIds);
    out.cleanupRan = true;
    order.push('verify');
    out.verification = await deps.verifyCleanupAfter(out.cleanupIds);
  }
  order.push('release');
  deps.releaseLock();
  return out;
}
