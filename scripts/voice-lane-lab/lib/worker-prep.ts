/**
 * W4 worker-session preparation (seams C22 + C24).
 *
 * The two holdout families need REAL worker-session state before the relay:
 *
 *   - C22 (busy parking): the worker must be GENUINELY busy when the relay
 *     lands, or the product correctly refuses to park and the journey proves
 *     nothing. The drive is a real Internal API prompt to the journey's own
 *     worker session — a real `sleep` command the runtime executes — never a
 *     fabricated busy flag.
 *   - C24 (attachment switch): a SECOND real worker session must exist before
 *     the journey, created through the Internal API's real session-creation
 *     path and verified present in the real session list, so the switch
 *     resolves a prepared target instead of failing honestly mid-journey.
 *
 * Everything here talks to the SAME disposable server the journey drives,
 * over its Internal API unix socket, with the same bearer token. Nothing
 * writes product state by hand.
 */

/** One call against the disposable server's Internal API. */
export type InternalApiCall = (
  apiPath: string,
  options?: { method?: 'GET' | 'POST'; body?: unknown }
) => Promise<{ status: number; body: string } | null>;

export interface SessionListRow {
  sessionId?: unknown;
  sessionPath?: unknown;
  status?: unknown;
  busy?: unknown;
  model?: unknown;
  [extra: string]: unknown;
}

/**
 * The busy drive's real prompt. The runtime genuinely executes the sleep, so
 * the session status is busy/streaming for the hold window — the product's own
 * busy detection (`isWorkerSessionBusy`) reads that status; nothing here
 * touches it. 120 s covers the relay window yet expires before the promoted
 * confirmation needs the worker reachable again.
 */
export const BUSY_DRIVE_PROMPT =
  'Run this exact shell command and wait for it to finish before you reply: sleep 120. Reply with the single word done afterwards.';
export const BUSY_HOLD_MS = 120_000;

/** How long the drive waits for the session to report busy (bounded, 1 s poll). */
export const BUSY_POLL_TIMEOUT_MS = 20_000;

export interface BusyDriveRecord {
  workerSessionId: string;
  promptSent: boolean;
  busyObserved: boolean;
  promptStatus: number | null;
  busyPollMs: number;
}

export interface PreparedWorkerSession {
  sessionId: string;
  sessionPath: string;
  displayName: string;
  model: string | null;
}

/** A journey whose plan carries an adaptive-promote turn needs the busy drive. */
export function journeyRequiresBusyDrive(plan: { turns: Array<{ kind: string }> }): boolean {
  return plan.turns.some((turn) => turn.kind === 'adaptive-promote');
}

/** A journey whose plan carries an adaptive-switch turn needs a second worker. */
export function journeyRequiresSecondWorker(plan: { turns: Array<{ kind: string }> }): boolean {
  return plan.turns.some((turn) => turn.kind === 'adaptive-switch');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function listSessions(call: InternalApiCall): Promise<SessionListRow[]> {
  const response = await call('/api/v1/sessions');
  if (!response || response.status !== 200) return [];
  try {
    const parsed = JSON.parse(response.body) as { sessions?: SessionListRow[] };
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

const rowId = (row: SessionListRow): string | null =>
  typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : null;

const rowBusy = (row: SessionListRow): boolean => row.busy === true || row.status === 'busy' || row.status === 'running' || row.status === 'streaming';

/**
 * Drive the journey's worker session genuinely busy through a real Internal
 * API prompt. `sessionIdsBefore` is the session list captured BEFORE the UI
 * created the journey's worker session; the diff identifies it without ever
 * guessing. Refuses honestly (throws) when identification, the prompt, or the
 * busy observation fails — the journey must not run on a wrong premise.
 */
export async function driveWorkerBusy(
  call: InternalApiCall,
  sessionIdsBefore: string[],
  options: { prompt?: string; pollTimeoutMs?: number } = {}
): Promise<BusyDriveRecord> {
  const prompt = options.prompt ?? BUSY_DRIVE_PROMPT;
  const pollTimeoutMs = options.pollTimeoutMs ?? BUSY_POLL_TIMEOUT_MS;

  const after = await listSessions(call);
  const fresh = after.map(rowId).filter((id): id is string => id !== null && !sessionIdsBefore.includes(id));
  if (fresh.length !== 1) {
    throw new Error(
      `busy drive: expected exactly one new worker session after the UI created it, saw ${fresh.length} — refusing to prompt an unidentified session`
    );
  }
  const workerSessionId = fresh[0]!;

  const promptResponse = await call(`/api/v1/sessions/${encodeURIComponent(workerSessionId)}/prompt`, {
    method: 'POST',
    body: { message: prompt },
  });
  if (!promptResponse || promptResponse.status >= 300) {
    throw new Error(
      `busy drive: the Internal API prompt to worker ${workerSessionId} failed (HTTP ${promptResponse?.status ?? 'no response'}) — the worker is not busy`
    );
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < pollTimeoutMs) {
    const rows = await listSessions(call);
    const row = rows.find((candidate) => rowId(candidate) === workerSessionId);
    if (row && rowBusy(row)) {
      return { workerSessionId, promptSent: true, busyObserved: true, promptStatus: promptResponse.status, busyPollMs: Date.now() - startedAt };
    }
    await sleep(1_000);
  }
  throw new Error(
    `busy drive: worker ${workerSessionId} never reported busy within ${pollTimeoutMs} ms — the relay would not park, so the journey is refused`
  );
}

export const SECOND_WORKER_DISPLAY_NAMES = ['Voice Lab Worker A', 'Voice Lab Worker B'] as const;

/**
 * Prepare TWO real worker sessions through the Internal API's real creation
 * path and verify both appear in the real session list. Returns the prepared
 * sessions (display names are set through the app's own preferences route by
 * the caller, so the product's session picker shows unambiguous rows).
 */
export async function prepareTwoWorkerSessions(
  call: InternalApiCall,
  options: { runtime?: string; cwd?: string } = {}
): Promise<PreparedWorkerSession[]> {
  const prepared: PreparedWorkerSession[] = [];
  for (const displayName of SECOND_WORKER_DISPLAY_NAMES) {
    const createResponse = await call('/api/v1/sessions', {
      method: 'POST',
      body: { runtime: options.runtime ?? 'pi', cwd: options.cwd ?? '/tmp', source: 'voice-lane-lab-worker-prep' },
    });
    if (!createResponse || createResponse.status >= 300) {
      throw new Error(
        `worker prep: creating "${displayName}" through POST /api/v1/sessions failed (HTTP ${createResponse?.status ?? 'no response'})`
      );
    }
    let createdId: string | null = null;
    try {
      const parsed = JSON.parse(createResponse.body) as { sessionId?: unknown; session?: { sessionId?: unknown; id?: unknown } };
      const candidate = parsed.sessionId ?? parsed.session?.sessionId ?? parsed.session?.id;
      if (typeof candidate === 'string' && candidate) createdId = candidate;
    } catch {
      /* fall through to the list check */
    }
    const rows = await listSessions(call);
    const row = rows.find((candidate) => rowId(candidate) !== null && rowId(candidate) === createdId) ??
      (createdId ? null : rows.find((candidate) => rowId(candidate) !== null && !prepared.some((p) => p.sessionId === rowId(candidate))));
    if (!row) {
      throw new Error(`worker prep: "${displayName}" was created but never appeared in the Internal API session list`);
    }
    prepared.push({
      sessionId: rowId(row)!,
      sessionPath: typeof row.sessionPath === 'string' ? row.sessionPath : '',
      displayName,
      model: typeof row.model === 'string' ? row.model : null,
    });
  }
  return prepared;
}

/** Set a session's display name through the app's own preferences route. */
export async function setSessionDisplayName(
  call: InternalApiCall,
  sessionPath: string,
  name: string
): Promise<boolean> {
  const response = await call('/api/preferences/display-name', {
    method: 'POST',
    body: { sessionPath, name, updatedAt: Date.now() },
  });
  return response !== null && response.status < 300;
}
