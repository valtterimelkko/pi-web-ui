/**
 * Long-Horizon Validation Runner
 *
 * A headless, resumable validator. It drives a real "subject" agent session
 * through the Internal API, registers a durable watch on it, then waits —
 * possibly for a very long time — for declared conditions to fire, without a
 * human in the loop and without holding any connection open.
 *
 * The crucial design choice: the runner never blocks on the subject. It
 * dispatches work, then *polls the durable watch ledger* on an interval. Each
 * poll is a single cheap request that answers "what has fired so far?", so the
 * runner can sleep (or even exit and be re-launched by cron) between polls and
 * lose nothing — the server-side watch keeps recording regardless.
 *
 * Two execution shapes are supported:
 *  - {@link runToCompletion} — a long-lived daemon that polls on a timer.
 *  - {@link startRun} + {@link tick} — stateless steps a scheduler (e.g. cron)
 *    can drive one at a time, with all progress persisted to a run-state file.
 */

import { mkdir, readFile, open, rename, rm } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  CreateSessionResponse,
  DeleteWatchResponse,
  PromptDispatchResponse,
  RegisterWatchRequest,
  SendPromptRequest,
  SessionControlResponse,
  WaitResponse,
  WatchConditionSpec,
  WatchFiring,
  WatchResponse,
} from '../internal-api/types.js';
import type { ValidationRuntime } from './types.js';

/** The Internal API surface the runner depends on (InternalApiClient satisfies it). */
export interface LongHorizonClient {
  createSession(input: { runtime: ValidationRuntime; cwd?: string; model?: string }): Promise<CreateSessionResponse>;
  prompt(sessionId: string, input: SendPromptRequest): Promise<PromptDispatchResponse>;
  pinSession(sessionId: string): Promise<SessionControlResponse>;
  registerWatch(sessionId: string, body: RegisterWatchRequest): Promise<WatchResponse>;
  getWatch(sessionId: string, sinceIndex?: number): Promise<WatchResponse>;
  deleteWatch(sessionId: string): Promise<DeleteWatchResponse>;
  waitForStatus(sessionId: string, status?: 'idle' | 'running', timeoutMs?: number): Promise<WaitResponse>;
  deleteSession(sessionId: string): Promise<void>;
}

export type StopWhen = 'all' | 'any';
export type RunStatus = 'running' | 'passed' | 'failed' | 'timeout';

export interface LongHorizonConfig {
  client: LongHorizonClient;
  /** Create a fresh subject of this runtime. Mutually exclusive with existingSessionId. */
  subjectRuntime?: ValidationRuntime;
  /** Attach to an existing subject session instead of creating one. */
  existingSessionId?: string;
  cwd?: string;
  model?: string;
  /** Optional initial prompt to drive the subject. Dispatched without blocking. */
  seedPrompt?: string;
  /** Conditions to watch for. Must be non-empty. */
  conditions: WatchConditionSpec[];
  /** Succeed when all (default) or any target condition has fired. */
  stopWhen?: StopWhen;
  /** Subset of condition ids that define success. Defaults to every condition. */
  targetConditionIds?: string[];
  /** Pin the subject so idle eviction can't kill it. Default true. */
  pin?: boolean;
  label?: string;
  /** Poll cadence in ms. Default 30000. The "hour" of a long test is just this × N. */
  pollIntervalMs?: number;
  /** Absolute time budget in ms. Default 3600000 (1h). */
  maxWaitMs?: number;
  /** On success, send this probe prompt to the subject and capture its answer. */
  probePrompt?: string;
  /** Keep a runner-created subject alive after finishing (default: delete it). */
  keepSubject?: boolean;
  /** Keep the server-side watch ledger after finishing (default: delete it). */
  keepWatch?: boolean;
  /** Where to persist run-state JSON. */
  statePath?: string;
  logger?: (message: string) => void;
}

export interface LongHorizonRunState {
  runId: string;
  createdAt: string;
  updatedAt: string;
  subjectSessionId: string;
  subjectRuntime: string;
  createdSubject: boolean;
  conditions: WatchConditionSpec[];
  conditionIds: string[];
  targetConditionIds: string[];
  stopWhen: StopWhen;
  pollIntervalMs: number;
  deadlineAt: number;
  attempts: number;
  lastFiringCount: number;
  status: RunStatus;
  firedConditionIds: string[];
  firings: WatchFiring[];
  probeAnswer?: string;
  seedRunId?: string;
  verdict?: string;
  statePath?: string;
  keepSubject: boolean;
  keepWatch?: boolean;
  cleanupWarnings: string[];
}

export interface TickResult {
  done: boolean;
  state: LongHorizonRunState;
  watch: WatchResponse;
}

const DEFAULT_POLL_MS = 30000;
const DEFAULT_MAX_WAIT_MS = 3600000;

function noopLogger(): void { /* silent by default */ }

/**
 * Create the subject (or attach to an existing one), register the watch, fire
 * the optional seed prompt, and persist initial run-state. Does not wait for
 * any condition — that's {@link tick}'s job.
 */
export async function startRun(config: LongHorizonConfig): Promise<{ state: LongHorizonRunState; watch: WatchResponse }> {
  const log = config.logger ?? noopLogger;
  const { client } = config;

  if (!config.conditions || config.conditions.length === 0) {
    throw new Error('At least one watch condition is required');
  }
  if (!config.subjectRuntime && !config.existingSessionId) {
    throw new Error('Provide either subjectRuntime (to create a subject) or existingSessionId (to attach)');
  }

  let subjectSessionId: string;
  let createdSubject = false;
  if (config.existingSessionId) {
    subjectSessionId = config.existingSessionId;
    log(`Attaching to existing subject session ${subjectSessionId}`);
  } else {
    const created = await client.createSession({
      runtime: config.subjectRuntime as ValidationRuntime,
      cwd: config.cwd,
      model: config.model,
    });
    subjectSessionId = created.sessionId;
    createdSubject = true;
    log(`Created ${config.subjectRuntime} subject session ${subjectSessionId}`);
  }

  // Registering the watch also pins the subject (pin defaults to true), so it
  // survives idle eviction while the validator sleeps.
  let watch: WatchResponse;
  try {
    watch = await client.registerWatch(subjectSessionId, {
      conditions: config.conditions,
      pin: config.pin,
      label: config.label,
    });
  } catch (registrationError) {
    if (createdSubject) {
      try {
        await client.deleteSession(subjectSessionId);
      } catch (cleanupError) {
        throw new AggregateError(
          [registrationError, cleanupError],
          `Watch registration failed (${safeErrorMessage(registrationError)}); subject cleanup also failed (${safeErrorMessage(cleanupError)})`,
        );
      }
    }
    throw registrationError;
  }
  log(`Registered watch ${watch.watchId} with ${watch.conditions.length} condition(s); pinned=${watch.pinned}`);

  const conditionIds = watch.conditions.map((c) => c.id);
  const targetConditionIds = config.targetConditionIds && config.targetConditionIds.length > 0
    ? config.targetConditionIds
    : conditionIds;

  // Dispatch the seed prompt WITHOUT blocking: the subject works asynchronously
  // server-side while we poll the watch. A disconnected answers-mode request
  // does not abort the turn, so fire-and-forget is safe here.
  let seedRunId: string | undefined;
  if (config.seedPrompt) {
    log(`Dispatching seed prompt (${config.seedPrompt.length} chars)`);
    try {
      const dispatch = await client.prompt(subjectSessionId, {
        message: config.seedPrompt,
        verbosity: 'answers',
        detach: true,
      });
      seedRunId = dispatch.runId;
      log(`Seed prompt accepted with runId=${seedRunId}`);
    } catch (error) {
      log(`Seed prompt error (non-fatal): ${safeErrorMessage(error)}`);
    }
  }

  const now = Date.now();
  const state: LongHorizonRunState = {
    runId: randomUUID(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    subjectSessionId,
    subjectRuntime: watch.runtime,
    createdSubject,
    conditions: config.conditions,
    conditionIds,
    targetConditionIds,
    stopWhen: config.stopWhen ?? 'all',
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_MS,
    deadlineAt: now + (config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS),
    attempts: 0,
    lastFiringCount: watch.firingCount,
    status: 'running',
    firedConditionIds: watch.conditions.filter((c) => c.fired).map((c) => c.id),
    firings: [...watch.firings],
    seedRunId,
    statePath: config.statePath,
    keepSubject: config.keepSubject ?? false,
    keepWatch: config.keepWatch ?? false,
    cleanupWarnings: [],
  };

  if (config.statePath) await persistState(config.statePath, state);
  return { state, watch };
}

/** Whether the success criteria are met given the set of fired condition ids. */
function successMet(state: LongHorizonRunState, fired: Set<string>): boolean {
  if (state.stopWhen === 'any') {
    return state.targetConditionIds.some((id) => fired.has(id));
  }
  return state.targetConditionIds.every((id) => fired.has(id));
}

/**
 * One poll-and-decide step. Reads the durable watch, folds new firings into the
 * run-state, evaluates success/timeout, and persists. Safe to call from a
 * daemon loop or a one-shot cron invocation.
 */
export async function tick(state: LongHorizonRunState, client: LongHorizonClient, logger?: (m: string) => void): Promise<TickResult> {
  const log = logger ?? noopLogger;
  state.attempts += 1;

  const watch = await client.getWatch(state.subjectSessionId);
  const fired = new Set(watch.conditions.filter((c) => c.fired).map((c) => c.id));
  state.firedConditionIds = Array.from(fired);
  state.firings = [...watch.firings];
  state.lastFiringCount = watch.firingCount;
  state.updatedAt = new Date().toISOString();

  let done = false;
  if (successMet(state, fired)) {
    state.status = 'passed';
    state.verdict = `Success: ${state.stopWhen === 'any' ? 'a target condition' : 'all target conditions'} fired (${state.firedConditionIds.join(', ')})`;
    done = true;
  } else if (Date.now() >= state.deadlineAt) {
    state.status = 'timeout';
    const pending = state.targetConditionIds.filter((id) => !fired.has(id));
    state.verdict = `Timeout after ${state.attempts} poll(s); pending condition(s): ${pending.join(', ') || 'none'}`;
    done = true;
  } else {
    state.status = 'running';
  }

  log(`Poll #${state.attempts}: status=${watch.status} firings=${watch.firingCount} fired=[${state.firedConditionIds.join(',')}] verdict=${state.status}`);

  if (state.statePath) await persistState(state.statePath, state);
  return { done, state, watch };
}

/**
 * Daemon mode: start, then poll on a timer until success, timeout, or process
 * exit. On success, optionally probes the subject and captures its answer; then
 * cleans up (deletes the watch and any runner-created subject unless kept).
 */
export async function runToCompletion(config: LongHorizonConfig): Promise<LongHorizonRunState> {
  const log = config.logger ?? noopLogger;
  const { state } = await startRun(config);

  try {
    while (state.status === 'running') {
      await sleep(state.pollIntervalMs);
      const result = await tick(state, config.client, log);
      if (result.done) break;
    }
  } catch (error) {
    state.status = 'failed';
    state.verdict = `Validation polling failed: ${safeErrorMessage(error)}`;
    log(state.verdict);
  } finally {
    try {
      await finalize(state, config);
    } catch (error) {
      const warning = `validation finalization failed: ${safeErrorMessage(error)}`;
      state.cleanupWarnings.push(warning);
      state.updatedAt = new Date().toISOString();
      log(warning);
    }
  }
  return state;
}

/**
 * Post-success/timeout steps: optional probe prompt, then cleanup. Idempotent
 * enough to be called once at the end of a run regardless of outcome.
 */
export async function finalize(state: LongHorizonRunState, config: LongHorizonConfig): Promise<LongHorizonRunState> {
  const log = config.logger ?? noopLogger;

  if (state.status === 'passed' && config.probePrompt) {
    try {
      // Make sure the subject is idle before probing so we don't collide with
      // an in-flight turn.
      await config.client.waitForStatus(state.subjectSessionId, 'idle', 120000).catch(() => undefined);
      const answer = await config.client.prompt(state.subjectSessionId, { message: config.probePrompt, verbosity: 'answers' });
      if ('content' in answer) {
        state.probeAnswer = answer.content;
        log(`Probe answer captured (${answer.content.length} chars)`);
      } else {
        log(`Probe returned non-terminal dispatch evidence (runId=${answer.runId})`);
      }
    } catch (err) {
      log(`Probe failed (non-fatal): ${safeErrorMessage(err)}`);
    }
  }

  // Cleanup. Remove the watch ledger unless the caller explicitly asked to keep
  // it for post-run evidence queries; remove the subject only if we created it
  // and the caller didn't ask to keep it.
  state.cleanupWarnings ??= [];
  if (!state.keepWatch && !config.keepWatch) {
    try {
      const deleted = await config.client.deleteWatch(state.subjectSessionId);
      if (!deleted.success) throw new Error('server did not confirm deletion');
      log(`Deleted watch for subject ${state.subjectSessionId}`);
    } catch (error) {
      const warning = `watch cleanup failed: ${safeErrorMessage(error)}`;
      state.cleanupWarnings.push(warning);
      log(warning);
    }
  } else {
    state.keepWatch = true;
  }
  if (state.createdSubject && !state.keepSubject) {
    try {
      await config.client.deleteSession(state.subjectSessionId);
      log(`Deleted runner-created subject ${state.subjectSessionId}`);
    } catch (error) {
      const warning = `session cleanup failed: ${safeErrorMessage(error)}`;
      state.cleanupWarnings.push(warning);
      log(warning);
    }
  }

  state.updatedAt = new Date().toISOString();
  if (state.statePath) await persistState(state.statePath, state);
  return state;
}

// ─── Run-state persistence ──────────────────────────────────────────────────

/**
 * Per-state-path write chain: serialises writes so concurrent persistState()
 * calls for the same file cannot interleave/corrupt it and an older state
 * cannot overwrite a newer one (each write awaits the previous, in call order).
 */
const stateWriteChains = new Map<string, Promise<void>>();

/**
 * Atomic state persistence: write an owner-only temp file in the same directory
 * (so rename is atomic on POSIX), then rename it over the target. A failure
 * between write and rename leaves the previous valid file untouched and cleans
 * up the temp file. The temp file is created with mode 0o600 and rename carries
 * that mode onto the final path.
 */
async function writeAtomicState(statePath: string, state: LongHorizonRunState): Promise<void> {
  const dir = path.dirname(statePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(statePath)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, statePath);
    // Best-effort directory fsync makes the rename durable across power loss on
    // filesystems that support syncing directory handles.
    try {
      const dirHandle = await open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Atomic file replacement still holds where directory fsync is unavailable.
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {
      // Best-effort cleanup of the orphaned temp file.
    });
    throw err;
  }
}

export async function persistState(statePath: string, state: LongHorizonRunState): Promise<void> {
  // Serialise per path: chain this write after any in-flight write for the same
  // path. The stored chain never rejects so a failed write doesn't block later
  // retries; the caller still observes its own rejection via `next`.
  const prev = stateWriteChains.get(statePath) ?? Promise.resolve();
  const next = prev.then(
    () => writeAtomicState(statePath, state),
    () => writeAtomicState(statePath, state),
  );
  const stored = next.then(
    () => undefined,
    () => undefined,
  );
  stateWriteChains.set(statePath, stored);
  // Remove the settled chain entry (only if it still points at `stored`) so the
  // map cannot grow unbounded — consistent with watch-store/run-receipt-store.
  const cleanup = (): void => {
    if (stateWriteChains.get(statePath) === stored) {
      stateWriteChains.delete(statePath);
    }
  };
  stored.then(cleanup, cleanup);
  await next;
}

export async function loadState(statePath: string): Promise<LongHorizonRunState> {
  const raw = await readFile(statePath, 'utf8');
  return JSON.parse(raw) as LongHorizonRunState;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;&]+/gi, '[REDACTED]')
    .replace(/([?&](?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .slice(0, 300);
}
