/**
 * Cross-runtime goal function (contract 1.38.0) — Antigravity (server-side).
 *
 * `agy` has no native /goal (no slash layer, no hook surface), so the
 * antigravity goal is fully server-owned, following the Command Code "wide"
 * pattern minus the mod:
 *
 *   - a per-session control store (`<antigravitySessionDir>/goal-control/`)
 *     holds objective, verifier, budget and lifecycle — restart-safe truth;
 *   - a turn-driven sweeper advances the goal whenever a turn completes:
 *     verify (command → exit code, or `GOAL_STATUS: ACHIEVED` self-report),
 *     then either mark achieved, dispatch a continuation follow-up, or fail
 *     on budget exhaustion — publishing `goal_state`/`goal_end` on change;
 *   - pause = disarm auto-continue (server-side semantics; an in-flight turn
 *     still settles); resume = re-arm + one continuation prompt.
 *
 * Follow-up queueing (contract 1.37.0) is what makes the loop safe: a
 * continuation dispatched while a turn is still settling queues inside the
 * agy process instead of being refused.
 */

import { exec } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgyCompletedTurn } from '../../antigravity/antigravity-service.js';
import type { GoalVerificationInfo, SessionGoalProjection } from './types.js';

/** Exact self-report marker the goal prompts ask the model to emit. */
export const AGY_GOAL_SENTINEL = 'GOAL_STATUS: ACHIEVED';

/** Consecutive provider-error turns after which the sweeper pauses the goal
 *  (contract 1.58.3, mirroring the Pi goal engine's three-strike rule: errors
 *  1..n-1 retry the continuation, the nth pauses). */
export const AGY_GOAL_MAX_CONSECUTIVE_ERRORS = 3;

const SENTINEL_RE = /GOAL_STATUS:\s*ACHIEVED/i;

// ─── /goal command parsing (web-UI + prompt-path interception) ───────────────

export type AgyGoalCommand =
  | { kind: 'start'; objective: string; verifyCommand?: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'status' };

const CONTROL_VERBS: Record<string, AgyGoalCommand> = {
  pause: { kind: 'pause' },
  'pause-now': { kind: 'pause' },
  resume: { kind: 'resume' },
  continue: { kind: 'resume' },
  clear: { kind: 'clear' },
  stop: { kind: 'clear' },
  status: { kind: 'status' },
  show: { kind: 'status' },
};

/**
 * Parse a raw prompt into an antigravity goal command, or null when the text
 * is not a `/goal …` command and must reach the model as a normal prompt.
 * Accepts the spaced and hyphenated TUI forms; `/goal <objective>` starts a
 * goal (quotes around the whole objective are stripped), optionally with
 * `--verify "cmd"` / `--verify=cmd`.
 */
export function parseAgyGoalCommand(raw: string): AgyGoalCommand | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\/goal(?![a-z])/i.test(trimmed)) return null;

  // "/goal-pause" loses its single joiner hyphen; flag dashes (--verify) survive.
  const rest = trimmed.slice('/goal'.length).replace(/^-(?=[^\s])/, '').trim();
  if (rest === '') return { kind: 'status' };

  const verbMatch = rest.match(/^([a-z-]+)(?:\s|$)/i);
  if (verbMatch) {
    const verb = CONTROL_VERBS[verbMatch[1].toLowerCase()];
    if (verb) return verb;
  }

  // start: optional --verify flag, remainder is the objective.
  let verifyCommand: string | undefined;
  let objective = rest;
  const quotedVerify = objective.match(/^--verify\s+("([^"]+)"|'([^']+)')\s*/i);
  const eqVerify = objective.match(/^--verify=(\S+)\s*/i);
  if (quotedVerify) {
    verifyCommand = quotedVerify[2] ?? quotedVerify[3];
    objective = objective.slice(quotedVerify[0].length);
  } else if (eqVerify) {
    verifyCommand = eqVerify[1];
    objective = objective.slice(eqVerify[0].length);
  }
  objective = objective.trim();
  const wrapped = objective.match(/^"([^"]*)"$/) ?? objective.match(/^'([^']*)'$/);
  if (wrapped) objective = wrapped[1];
  objective = objective.trim();
  if (objective === '') return { kind: 'status' };
  return verifyCommand !== undefined ? { kind: 'start', objective, verifyCommand } : { kind: 'start', objective };
}

// ─── control store ───────────────────────────────────────────────────────────

export interface AntigravityGoalRecord {
  objective: string;
  /** Shell command; exit 0 = achieved. Absent = sentinel self-report. */
  verifyCommand?: string;
  maxRuns: number;
  status: 'running' | 'paused' | 'achieved' | 'failed' | 'cleared';
  /** Verification cycles consumed (completed turns processed for this goal).
   *  Provider-error strikes do not consume a run (contract 1.58.3). */
  runs: number;
  pausedReason?: 'user' | 'budget' | 'error';
  /** Consecutive provider-error strikes in the current armed cycle. Reset by a
   *  successful turn; the pause ends the cycle and resets it (the count that
   *  caused a pause is stated in `lastReason`). */
  consecutiveErrors?: number;
  /** A resume re-armed the goal but its continuation could not be dispatched
   *  (the session was still settling). The sweeper owes that continuation until
   *  a dispatch is accepted or a newer completed turn supersedes it. */
  pendingContinuation?: boolean;
  /** Last verifier message / governor note. */
  lastReason?: string;
  verification?: GoalVerificationInfo;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
  clearedAt?: number;
  /** false = user paused. undefined/true = armed. */
  autoContinue?: boolean;
  /** Turn timestamp already processed by the sweeper (turn-driven advance). */
  lastVerifiedTurnAt?: number;
}

/** Restart-safe per-session goal ledger, shaped after ClaudeGoalControlStore. */
export class AntigravityGoalControlStore {
  constructor(private readonly dir: string) {}

  private fileFor(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.json`);
  }

  async get(sessionId: string): Promise<AntigravityGoalRecord | null> {
    try {
      const raw = await fsp.readFile(this.fileFor(sessionId), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  async patch(sessionId: string, patch: Partial<AntigravityGoalRecord>): Promise<AntigravityGoalRecord> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const current = (await this.get(sessionId)) ?? {};
    const next = { ...current, ...patch, updatedAt: Date.now() } as AntigravityGoalRecord;
    await fsp.writeFile(this.fileFor(sessionId), JSON.stringify(next), 'utf8');
    return next;
  }

  async listSessionIds(): Promise<string[]> {
    try {
      const entries = await fsp.readdir(this.dir);
      return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }
}

// ─── projection ──────────────────────────────────────────────────────────────

/** Project the control record into the canonical goal vocabulary (1.27.0). */
export function projectAgyGoal(record: AntigravityGoalRecord | null): SessionGoalProjection {
  if (!record) return { supported: true, status: 'idle' };
  const projection: SessionGoalProjection = {
    supported: true,
    status: record.status,
    objective: record.objective,
    runs: record.runs,
    maxRuns: record.maxRuns,
    verification: record.verification,
    lastReason: record.lastReason ?? null,
    startedAt: record.createdAt,
    completedAt: record.completedAt ?? null,
    pausedReason: record.pausedReason ?? null,
    autoContinue: record.autoContinue !== false,
    runtimeState: undefined,
  };
  return projection;
}

// ─── prompts ─────────────────────────────────────────────────────────────────

const SENTINEL_INSTRUCTION = `When the goal is fully achieved, end your reply with exactly this line and nothing after it:\n${AGY_GOAL_SENTINEL}`;

/** Initial goal prompt dispatched through the normal prompt pipeline on start. */
export function buildAgyGoalStartPrompt(objective: string, hasVerifyCommand: boolean): string {
  const lines = [
    `Work toward your active goal: ${objective}`,
    'Keep making progress on it across replies until it is fully achieved; do not drift to unrelated work.',
  ];
  if (!hasVerifyCommand) lines.push(SENTINEL_INSTRUCTION);
  return lines.join('\n');
}

/** Continuation prompt sent by the sweeper after each unmet completed turn. */
export function buildAgyGoalContinuationPrompt(objective: string, hasVerifyCommand: boolean): string {
  const lines = [
    `Continue working toward your active goal: ${objective}`,
    'Re-check the goal against current reality, make further progress, and report the current state.',
  ];
  if (!hasVerifyCommand) lines.push(SENTINEL_INSTRUCTION);
  return lines.join('\n');
}

// ─── verification ────────────────────────────────────────────────────────────

export interface AgyGoalVerifyInput {
  verifyCommand?: string;
  /** Latest completed turn response (sentinel scan target). */
  response: string;
  cwd: string;
  timeoutMs: number;
}

export interface AgyGoalVerifyResult {
  met: boolean;
  verification: GoalVerificationInfo;
}

function sentinelResult(response: string): AgyGoalVerifyResult {
  if (SENTINEL_RE.test(response)) {
    return { met: true, verification: { status: 'self_reported', command: null, message: 'model self-reported goal achievement' } };
  }
  return { met: false, verification: { status: 'not_run', command: null, message: null } };
}

/**
 * Verify one completed turn. `verifyCommand` wins when present (exit 0 =
 * achieved). Otherwise the sentinel self-report decides. Never throws.
 */
export function verifyAgyGoalTurn(input: AgyGoalVerifyInput): Promise<AgyGoalVerifyResult> {
  if (!input.verifyCommand) {
    return Promise.resolve(sentinelResult(input.response ?? ''));
  }
  const command: string = input.verifyCommand;
  return new Promise((resolve) => {
    exec(
      command,
      { cwd: input.cwd, timeout: input.timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error && error.killed === true) {
          resolve({
            met: false,
            verification: { status: 'failed', command, message: `verify command timed out after ${input.timeoutMs}ms` },
          });
          return;
        }
        const code = typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : (error ? 1 : 0);
        if (code === 0) {
          resolve({ met: true, verification: { status: 'passed', command, message: null } });
        } else {
          const tail = String(stderr ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 400);
          resolve({
            met: false,
            verification: { status: 'failed', command, message: tail.length > 0 ? `exit ${code}: ${tail}` : `exit ${code}` },
          });
        }
      },
    );
  });
}

// ─── config ──────────────────────────────────────────────────────────────────

export interface AgyGoalAutoContinueConfig {
  enabled: boolean;
  sweepIntervalMs: number;
  maxRuns: number;
  verifyTimeoutMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadAgyGoalAutoContinueConfig(env: Record<string, string | undefined> = process.env): AgyGoalAutoContinueConfig {
  return {
    enabled: env.AGY_GOAL_AUTO_CONTINUE !== 'false',
    sweepIntervalMs: positiveInt(env.AGY_GOAL_SWEEP_MS, 15_000),
    maxRuns: positiveInt(env.AGY_GOAL_MAX_RUNS, 100),
    verifyTimeoutMs: positiveInt(env.AGY_GOAL_VERIFY_TIMEOUT_MS, 60_000),
  };
}

// ─── sweeper ─────────────────────────────────────────────────────────────────

export interface AgyGoalSweeperDeps {
  config: AgyGoalAutoContinueConfig;
  now?: () => number;
  /** Session ids with a goal record (store dir scan by default). */
  listGoalSessions: () => Promise<string[]>;
  /** Runtime liveness — never verify/continue a streaming session. */
  isRunning: (sessionId: string) => boolean;
  getStore: () => AntigravityGoalControlStore;
  /** Latest finalized turn of the session (null when none), carrying its
   *  provider-error truth (contract 1.58.3). */
  readLastCompletedTurn: (sessionId: string) => Promise<AgyCompletedTurn | null>;
  /** Session cwd for verifyCommand execution. */
  sessionCwd: (sessionId: string) => Promise<string | undefined>;
  /** Send the continuation prompt through the normal detached pipeline. */
  dispatch: (sessionId: string, message: string) => Promise<void>;
  /** Injectable for tests; defaults to {@link verifyAgyGoalTurn}. */
  verify?: (record: AntigravityGoalRecord, turn: { completedAt: number; response: string }) => Promise<AgyGoalVerifyResult>;
  /** Broker publisher (goal_state / goal_end). */
  publish?: (sessionId: string, event: { type: string; timestamp: number; data: unknown }) => void;
}

export interface AgyGoalSweeper {
  sweepOnce(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createAgyGoalSweeper(deps: AgyGoalSweeperDeps): AgyGoalSweeper {
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  const lastPublished = new Map<string, string>();
  const lastTerminal = new Map<string, string>();

  function projectionOf(record: AntigravityGoalRecord): SessionGoalProjection {
    return projectAgyGoal(record);
  }

  function signatureOf(p: SessionGoalProjection): string {
    return JSON.stringify([p.status, p.objective, p.completedAt, p.pausedReason, p.lastReason, p.runs, p.autoContinue]);
  }

  function publishIfChanged(sessionId: string, record: AntigravityGoalRecord): void {
    if (!deps.publish) return;
    const projection = projectionOf(record);
    const signature = signatureOf(projection);
    if (lastPublished.get(sessionId) === signature) return;
    lastPublished.set(sessionId, signature);
    const terminal = record.status === 'achieved' || record.status === 'failed' || record.status === 'cleared';
    deps.publish(sessionId, { type: 'goal_state', timestamp: now(), data: projection });
    if (terminal && lastTerminal.get(sessionId) !== record.status) {
      lastTerminal.set(sessionId, record.status);
      deps.publish(sessionId, { type: 'goal_end', timestamp: now(), data: projection });
    } else if (!terminal) {
      lastTerminal.delete(sessionId);
    }
  }

  const sweeper: AgyGoalSweeper = {
    async sweepOnce(): Promise<void> {
      if (!deps.config.enabled) return;
      let sessionIds: string[] = [];
      try {
        sessionIds = await deps.listGoalSessions();
      } catch {
        return;
      }
      // Re-read just before a dispatch: the turn read and verification are
      // asynchronous, so a pause, clear or restart can land after the record
      // above was read. A continuation is sent only if the goal is still armed
      // and still at the cursor this sweep advanced from (review r2, 1.58.3).
      // The latest completed turn is re-read too: a turn that finished after
      // this sweep's snapshot must be processed first, not answered with a
      // continuation built on stale turn state (review r3).
      const stillArmed = async (
        sessionId: string,
        cursor: number | undefined,
        expectedTurnAt: number | undefined,
        requirePending = false,
      ): Promise<AntigravityGoalRecord | null> => {
        // Turn first, goal record last: the record is the final read before the
        // dispatch, so a pause or clear that lands during the turn read still
        // wins (review r4).
        if (deps.isRunning(sessionId)) return null;
        const latest = await deps.readLastCompletedTurn(sessionId);
        if ((latest?.completedAt ?? undefined) !== expectedTurnAt) return null;
        const fresh = await deps.getStore().get(sessionId);
        if (!fresh || fresh.status !== 'running' || fresh.autoContinue === false) return null;
        if (fresh.lastVerifiedTurnAt !== cursor) return null;
        if (requirePending && !fresh.pendingContinuation) return null;
        return deps.isRunning(sessionId) ? null : fresh;
      };
      const continuationFor = (rec: AntigravityGoalRecord) => buildAgyGoalContinuationPrompt(rec.objective, rec.verifyCommand !== undefined);
      for (const sessionId of sessionIds) {
        try {
          const record = await deps.getStore().get(sessionId);
          if (!record) continue;
          // Terminal or disarmed goals never advance. A re-sweep of a terminal
          // goal must not re-publish (change detection absorbs it anyway).
          if (record.status !== 'running' || record.autoContinue === false) continue;
          if (deps.isRunning(sessionId)) continue;

          const turn = await deps.readLastCompletedTurn(sessionId);
          const turnIsNew = turn !== null
            && (record.lastVerifiedTurnAt === undefined || turn.completedAt > record.lastVerifiedTurnAt);
          if (!turnIsNew) {
            // A resume whose continuation was refused (the session was still
            // settling) left no new turn to advance from: dispatch the owed
            // continuation now. A refused dispatch throws and is retried on the
            // next sweep; the flag clears only once a dispatch is accepted.
            const owed = record.pendingContinuation ? await stillArmed(sessionId, record.lastVerifiedTurnAt, turn?.completedAt, true) : null;
            if (owed) {
              await deps.dispatch(sessionId, continuationFor(owed));
              await deps.getStore().patch(sessionId, { pendingContinuation: false });
            }
            continue;
          }
          // Turn-driven advance: each completed turn is processed exactly once.
          // A newer turn supersedes any owed resume continuation.
          if (record.pendingContinuation) await deps.getStore().patch(sessionId, { pendingContinuation: false });

          // Provider-error strike (contract 1.58.3). A finalized error turn has no
          // assistant answer to verify, so it must never advance the goal as an
          // ordinary unmet turn (the H2s Gemini session burned 27 of 40 runs that
          // way). Consecutive strikes pause the goal; a successful turn resets the
          // count. Strikes 1..n-1 retry the continuation, mirroring the Pi goal
          // engine's three-strike rule for real errors (retry, then pause).
          if (turn.status === 'error') {
            const strikes = (record.consecutiveErrors ?? 0) + 1;
            const errorText = turn.error?.trim() || turn.response.trim() || 'unknown provider error';
            if (strikes >= AGY_GOAL_MAX_CONSECUTIVE_ERRORS) {
              const patched = await deps.getStore().patch(sessionId, {
                status: 'paused',
                pausedReason: 'error',
                // The counter belongs to the running cycle: the pause ends it and a
                // resume starts a fresh three-strike window. The count that caused
                // the pause is stated in lastReason.
                consecutiveErrors: 0,
                lastReason: `goal paused after ${strikes} consecutive provider errors; last error: ${errorText}`,
                lastVerifiedTurnAt: turn.completedAt,
              });
              publishIfChanged(sessionId, patched);
              continue;
            }
            // Retry first, record second: if the continuation is refused because
            // the session is still settling (the route's admission lease can
            // outlive the turn's finalisation), the strike must not be consumed —
            // the next sweep re-processes the same turn and retries the dispatch.
            const armedForRetry = await stillArmed(sessionId, record.lastVerifiedTurnAt, turn.completedAt);
            if (!armedForRetry) continue;
            await deps.dispatch(sessionId, continuationFor(armedForRetry));
            const patched = await deps.getStore().patch(sessionId, {
              consecutiveErrors: strikes,
              lastReason: `provider error (strike ${strikes}/${AGY_GOAL_MAX_CONSECUTIVE_ERRORS}): ${errorText}`,
              lastVerifiedTurnAt: turn.completedAt,
            });
            publishIfChanged(sessionId, patched);
            continue;
          }

          const cwd = (await deps.sessionCwd(sessionId)) ?? process.cwd();
          const result = deps.verify
            ? await deps.verify(record, turn)
            : await verifyAgyGoalTurn({ verifyCommand: record.verifyCommand, response: turn.response, cwd, timeoutMs: deps.config.verifyTimeoutMs });

          const runs = record.runs + 1;
          // This turn succeeded: any run of consecutive provider errors is over.
          // Clear a stale strike note rather than carrying it into the projection.
          const recovered = (record.consecutiveErrors ?? 0) > 0;
          if (result.met) {
            const patched = await deps.getStore().patch(sessionId, {
              status: 'achieved',
              completedAt: now(),
              runs,
              verification: result.verification,
              lastReason: result.verification.message ?? (recovered ? undefined : record.lastReason),
              consecutiveErrors: 0,
              lastVerifiedTurnAt: turn.completedAt,
            });
            publishIfChanged(sessionId, patched);
            continue;
          }

          if (runs >= record.maxRuns) {
            const patched = await deps.getStore().patch(sessionId, {
              status: 'failed',
              pausedReason: 'budget',
              runs,
              verification: result.verification,
              lastReason: `goal run budget exhausted (${record.maxRuns} runs) without achieving the goal; start or resume to re-arm`,
              consecutiveErrors: 0,
              lastVerifiedTurnAt: turn.completedAt,
            });
            publishIfChanged(sessionId, patched);
            continue;
          }

          const patched = await deps.getStore().patch(sessionId, {
            runs,
            verification: result.verification,
            lastReason: result.verification.message ?? (recovered ? undefined : record.lastReason),
            consecutiveErrors: 0,
            lastVerifiedTurnAt: turn.completedAt,
          });
          publishIfChanged(sessionId, patched);
          const armedForNext = await stillArmed(sessionId, turn.completedAt, turn.completedAt);
          if (armedForNext) {
            try {
              await deps.dispatch(sessionId, continuationFor(armedForNext));
            } catch {
              // Refused (the session is still settling): the cursor already moved
              // past this turn, so mark the continuation owed; the sweeper retries
              // it until accepted or a newer turn supersedes it (review r3).
              await deps.getStore().patch(sessionId, { pendingContinuation: true });
            }
          }
        } catch {
          /* per-session isolation: one bad session cannot stop the sweep */
        }
      }
    },
    start(): void {
      if (timer || !deps.config.enabled) return;
      timer = setInterval(() => { void sweeper.sweepOnce(); }, deps.config.sweepIntervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return sweeper;
}
