/**
 * Cross-runtime goal function (contract 1.27.0) — Pi read path.
 *
 * The goal-engine Pi extension persists per-session state at
 * `~/.pi/agent/goal-engine/<slug>.<sha256(sessionKey)[:16]>.goal.json`.
 * The path algorithm below MUST stay byte-identical with the extension's
 * `getSessionGoalStatePath()` (pi-enhancement/goal-engine/state.ts):
 *   - slug: basename without extension, chars outside [a-zA-Z0-9_\-.]
 *     replaced with '_', capped at 80 chars, 'session' when empty;
 *   - identity: first 16 hex chars of sha256 of the FULL session key
 *     (the session file path).
 * This is a deliberate duplicated constant, not a shared dependency: the
 * extension lives in a separate repo and must stay decoupled.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { homedirOverride } from './homedir.js';
import type { CanonicalGoalStatus, GoalVerificationStatus, SessionGoalProjection } from './types.js';

/** Raw shape of the extension's persisted GoalState (subset we consume). */
export interface PiGoalStateLike {
  objective?: string;
  status?: string;
  turnCount?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  verifyCommand?: string | null;
  minReviewCycles?: number;
  reviewCyclesCompleted?: number;
  lastVerificationStatus?: string | null;
  lastVerificationMessage?: string | null;
  maxTurns?: number | null;
  pendingQuestion?: string | null;
  /** Agent-suggested goal awaiting explicit owner approval (contract 1.28.0). */
  pendingSuggestion?: { objective?: string; rationale?: string | null; suggestedAt?: number } | null;
  lastRunReason?: string | null;
  lastErrorMessage?: string | null;
  spentInputTokens?: number;
  spentUsd?: number;
  budgetTokens?: number | null;
  budgetUsd?: number | null;
  [key: string]: unknown;
}

function goalDir(): string {
  return path.join(homedirOverride(), '.pi', 'agent', 'goal-engine');
}

function slugFromKey(sessionKey: string): string {
  const base = path.basename(sessionKey, path.extname(sessionKey));
  return base.replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 80) || 'session';
}

/** Collision-safe per-session state path; mirrors the extension exactly. */
export function piGoalStatePath(sessionKey: string): string {
  const identity = createHash('sha256').update(sessionKey).digest('hex').slice(0, 16);
  return path.join(goalDir(), `${slugFromKey(sessionKey)}.${identity}.goal.json`);
}

/** Sentinel passed to {@link projectPiGoalState} when a state file exists but cannot be parsed. */
export const INVALID_PI_GOAL_STATE = Symbol('invalid-pi-goal-state');

/**
 * Read + parse the Pi goal state file. Returns null when the file does not
 * exist — never throws for missing state.
 */
export async function readPiGoalStateFile(sessionKey: string): Promise<PiGoalStateLike | null> {
  let raw: string;
  try {
    raw = await fs.readFile(piGoalStatePath(sessionKey), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return INVALID_PI_GOAL_STATE as unknown as PiGoalStateLike;
    return parsed as PiGoalStateLike;
  } catch {
    return INVALID_PI_GOAL_STATE as unknown as PiGoalStateLike;
  }
}

function mapVerificationStatus(value: unknown): GoalVerificationStatus {
  switch (value) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'self-reported':
      return 'self_reported';
    default:
      return 'not_run';
  }
}

function canonicalPiStatus(gs: PiGoalStateLike): { status: CanonicalGoalStatus; pausedReason?: string; suggestedObjective?: string } {
  const hasErrorPause = Boolean(gs.lastErrorMessage);
  switch (gs.status) {
    case 'running':
      return { status: 'running' };
    case 'wrapping-up':
      return { status: 'wrapping_up' };
    case 'paused':
      if (gs.pendingQuestion) return { status: 'paused', pausedReason: 'question' };
      if (hasErrorPause) return { status: 'failed', pausedReason: 'error' };
      return { status: 'paused' };
    case 'idle': {
      if (gs.completedAt != null) return { status: 'achieved' };
      // An agent-suggested goal awaiting owner approval (contract 1.28.0):
      // report it as its own non-terminal state with the suggested objective.
      const suggestedObjective = gs.pendingSuggestion?.objective;
      if (typeof suggestedObjective === 'string' && suggestedObjective.length > 0) {
        return { status: 'suggested', suggestedObjective };
      }
      if (!gs.objective) return { status: 'idle' };
      return { status: 'unknown' };
    }
    default:
      return { status: 'unknown' };
  }
}

/**
 * Project a raw Pi goal state into the runtime-neutral canonical vocabulary.
 * Accepts null (no file / junk) and still answers honestly.
 */
export function projectPiGoalState(raw: PiGoalStateLike | null | typeof INVALID_PI_GOAL_STATE): SessionGoalProjection {
  if (raw === INVALID_PI_GOAL_STATE) {
    // Present but unparseable must not masquerade as a healthy idle goal.
    return { supported: true, status: 'unknown', runtimeState: undefined };
  }
  if (!raw || typeof raw !== 'object') {
    // A missing state file means this Pi session has no goal history.
    // The runtime IS supported; there is simply nothing to report yet.
    return { supported: true, status: 'idle', runtimeState: undefined };
  }
  const gs = raw;
  const { status, pausedReason, suggestedObjective } = canonicalPiStatus(gs);
  const projection: SessionGoalProjection = {
    supported: true,
    status,
    objective: suggestedObjective ?? (typeof gs.objective === 'string' ? gs.objective : undefined),
    runs: typeof gs.turnCount === 'number' ? gs.turnCount : undefined,
    maxRuns: gs.maxTurns ?? null,
    verification: {
      status: mapVerificationStatus(gs.lastVerificationStatus),
      command: gs.verifyCommand ?? null,
      message: gs.lastVerificationMessage ?? null,
    },
    lastReason: gs.pendingQuestion ?? gs.lastRunReason ?? null,
    spend: {
      inputTokens: typeof gs.spentInputTokens === 'number' ? gs.spentInputTokens : undefined,
      usd: typeof gs.spentUsd === 'number' ? gs.spentUsd : undefined,
    },
    budget: { tokens: gs.budgetTokens ?? null, usd: gs.budgetUsd ?? null },
    startedAt: gs.startedAt ?? null,
    completedAt: gs.completedAt ?? null,
    pausedReason: pausedReason ?? null,
    runtimeState: gs,
  };
  return projection;
}

/** Convenience: read + project in one call. */
export async function readProjectPiGoalState(sessionKey: string): Promise<SessionGoalProjection> {
  return projectPiGoalState(await readPiGoalStateFile(sessionKey));
}
