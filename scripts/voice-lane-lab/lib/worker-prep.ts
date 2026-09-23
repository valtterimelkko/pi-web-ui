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
 * touches it. The wording forces the shell TOOL: a model that merely replies
 * ends its turn in about a second and the busy state collapses (the C22
 * attempt-02 failure), so the drive re-prompts whenever that happens.
 */
export const BUSY_DRIVE_PROMPT =
  'Automation needs a timed pause. Use your shell tool to run exactly this command and wait for the real command to finish — do not simulate or shortcut it: sleep 75 && echo pause-complete. Reply with only pause-complete once the command has actually finished.';
export const BUSY_HOLD_MS = 75_000;

/** How long the drive waits for the FIRST busy report (bounded, 1 s poll). */
export const BUSY_POLL_TIMEOUT_MS = 20_000;
/** How long the busy state must HOLD (the relay lands inside this window). */
export const BUSY_HOLD_WATCH_MS = 15_000;
/** Maximum detached prompts the drive may send while holding busy. */
export const BUSY_MAX_PROMPTS = 4;

export interface BusyDriveRecord {
  workerSessionId: string;
  promptsSent: number;
  busyObserved: boolean;
  busyHeldMs: number;
  lastPromptStatus: number | null;
}

export interface PreparedWorkerSession {
  sessionId: string;
  sessionPath: string;
  displayName: string;
  model: string | null;
}

/** A journey whose EPISODE carries an adaptive-promote turn needs the busy drive.
 *  Takes the episode's inputTurns — the plan's speakable turns have the
 *  promote/switch gestures filtered out (they are director-driven gestures,
 *  never spoken), so the plan alone cannot see the requirement. */
export function journeyRequiresBusyDrive(turns: Array<{ kind: string }>): boolean {
  return turns.some((turn) => turn.kind === 'adaptive-promote');
}

/** A journey whose EPISODE carries an adaptive-switch turn needs a second worker. */
export function journeyRequiresSecondWorker(turns: Array<{ kind: string }>): boolean {
  return turns.some((turn) => turn.kind === 'adaptive-switch');
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
  options: { prompt?: string; pollTimeoutMs?: number; holdWatchMs?: number; maxPrompts?: number } = {}
): Promise<BusyDriveRecord> {
  const prompt = options.prompt ?? BUSY_DRIVE_PROMPT;
  const pollTimeoutMs = options.pollTimeoutMs ?? BUSY_POLL_TIMEOUT_MS;
  const holdWatchMs = options.holdWatchMs ?? BUSY_HOLD_WATCH_MS;
  const maxPrompts = options.maxPrompts ?? BUSY_MAX_PROMPTS;

  const after = await listSessions(call);
  const fresh = after.map(rowId).filter((id): id is string => id !== null && !sessionIdsBefore.includes(id));
  if (fresh.length !== 1) {
    throw new Error(
      `busy drive: expected exactly one new worker session after the UI created it, saw ${fresh.length} — refusing to prompt an unidentified session`
    );
  }
  const workerSessionId = fresh[0]!;

  let promptsSent = 0;
  let lastPromptStatus: number | null = null;
  const sendPrompt = async (): Promise<boolean> => {
    if (promptsSent >= maxPrompts) return false;
    promptsSent += 1;
    const promptResponse = await call(`/api/v1/sessions/${encodeURIComponent(workerSessionId)}/prompt`, {
      method: 'POST',
      // Detached: the request returns as soon as the runtime dispatches the
      // turn — the sleep keeps the session busy while the journey proceeds.
      body: { message: prompt, detach: true },
    });
    lastPromptStatus = promptResponse?.status ?? null;
    return promptResponse !== null && promptResponse.status < 300;
  };

  if (!(await sendPrompt())) {
    throw new Error(
      `busy drive: the Internal API prompt to worker ${workerSessionId} failed (HTTP ${lastPromptStatus ?? 'no response'}) — the worker is not busy`
    );
  }

  // Phase 1: wait for the FIRST busy report.
  let busySince: number | null = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < pollTimeoutMs) {
    const rows = await listSessions(call);
    const row = rows.find((candidate) => rowId(candidate) === workerSessionId);
    if (row && rowBusy(row)) {
      busySince = Date.now();
      break;
    }
    await sleep(1_000);
  }
  if (busySince === null) {
    throw new Error(
      `busy drive: worker ${workerSessionId} never reported busy within ${pollTimeoutMs} ms — the relay would not park, so the journey is refused`
    );
  }

  // Phase 2: the busy state must HOLD across the relay window. A model that
  // answered without running the command ends its turn in ~1 s (the C22
  // attempt-02 failure); re-prompt — real work each time, bounded — instead
  // of pretending the state held.
  while (Date.now() - busySince < holdWatchMs) {
    await sleep(1_000);
    const rows = await listSessions(call);
    const row = rows.find((candidate) => rowId(candidate) === workerSessionId);
    if (row && rowBusy(row)) continue;
    // Honest diagnostics: capture the worker's own last words so the record
    // shows WHY the busy state collapsed (e.g. the model answered without
    // running the command).
    const collapseReply = await call(`/api/v1/sessions/${encodeURIComponent(workerSessionId)}/transcript?view=screen`);
    const replyExcerpt = collapseReply?.status === 200 ? collapseReply.body.slice(-300) : `HTTP ${collapseReply?.status ?? 'none'}`;
    if (!(await sendPrompt())) {
      throw new Error(
        `busy drive: worker ${workerSessionId} left busy and the prompt budget (${maxPrompts}) is exhausted — the relay would not park; worker said: ${replyExcerpt}`
      );
    }
    busySince = null;
    const reBusyAt = Date.now();
    while (Date.now() - reBusyAt < pollTimeoutMs) {
      const retryRows = await listSessions(call);
      const retryRow = retryRows.find((candidate) => rowId(candidate) === workerSessionId);
      if (retryRow && rowBusy(retryRow)) {
        busySince = Date.now();
        break;
      }
      await sleep(1_000);
    }
    if (busySince === null) {
      throw new Error(
        `busy drive: worker ${workerSessionId} never returned to busy after a re-prompt — the relay would not park, so the journey is refused`
      );
    }
  }

  return { workerSessionId, promptsSent, busyObserved: true, busyHeldMs: Date.now() - busySince, lastPromptStatus };
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
