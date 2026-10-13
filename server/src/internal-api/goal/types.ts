/**
 * Cross-runtime goal function (contract 1.27.0) — shared goal types.
 *
 * The canonical projection vocabulary every runtime read path maps into.
 * Documented in docs/INTERNAL-API.md (§ Goal) and
 * docs/plans/CROSS-RUNTIME-GOAL-FUNCTION-PLAN.md §5. Undefined beats guessing:
 * omit what a runtime cannot know rather than inventing a value.
 */
import type { GoalInterruptionCause } from './transient-cause.js';

/**
 * Wave K (contract 1.60.0, additive): interruption facts for a goal stop that
 * the server detected. `cause` is the K1 closed vocabulary (see
 * docs/INTERNAL-API.md § Goal); `autoContinued` marks the single automatic
 * continue. A non-continued stop projects as `status: "paused"`,
 * `pausedReason: "interrupted"` — no new top-level status (R4).
 */
export interface GoalInterruptionInfo {
  cause: GoalInterruptionCause;
  source: 'receipt' | 'drain' | 'boot_orphan' | 'rehydrate_pause' | 'provider_abort';
  detectedAt: number;
  continueCount?: number;
  autoContinued?: boolean;
  continueNote?: string;
  inFlightToolCall?: { name: string; argsSummary: string } | null;
}

/** Canonical goal status across runtimes. */
export type CanonicalGoalStatus =
  | 'running'
  | 'paused'
  | 'wrapping_up'
  | 'achieved'
  | 'cleared'
  | 'failed'
  | 'idle'
  | 'suggested'
  | 'unknown';

export type GoalVerificationStatus = 'passed' | 'failed' | 'self_reported' | 'not_run';

export interface GoalVerificationInfo {
  status?: GoalVerificationStatus;
  command?: string | null;
  message?: string | null;
}

export interface SessionGoalProjection {
  /** False when this runtime/backend genuinely cannot do goals (never a guess). */
  supported: boolean;
  status: CanonicalGoalStatus;
  objective?: string;
  /** Harness turns/runs consumed for this goal (best effort). */
  runs?: number;
  maxRuns?: number | null;
  verification?: GoalVerificationInfo;
  /** Verifier verdict / governor note / pending question text. */
  lastReason?: string | null;
  spend?: { inputTokens?: number; usd?: number };
  budget?: { tokens?: number | null; usd?: number | null };
  startedAt?: number | null;
  completedAt?: number | null;
  pausedReason?: string | null;
  /** Server-side auto-continue loop state (Claude; Command Code mod arming). */
  autoContinue?: boolean;
  /** Wave K (contract 1.60.0): interruption/auto-continue facts (Pi only). */
  interruption?: GoalInterruptionInfo;
  /**
   * Correction 03 C6: top-level flag on the VERIFIED auto-continue `goal_state`
   * event data — watch `dataMatch` is a shallow top-level match, so the nested
   * `interruption.autoContinued` can never fire a watch. Present only on the
   * verified auto-continue event (never on plain projections).
   */
  autoContinued?: boolean;
  /**
   * Contract 1.62.0 (W2-a): stable id minted once per goal start. Stamped
   * top-level on every goal_state / goal_end event and on GET/POST /goal, so a
   * watch `dataMatch {"goalId":"<id>"}` is not woken by another goal's clear.
   */
  goalId?: string;
  /**
   * Contract 1.62.0 (W2-b): present (true) only on the stall `goal_state`
   * event — a `running` goal whose session has been idle `GOAL_STALL_MINUTES`.
   * The status stays `running`; never on plain projections.
   */
  stalled?: boolean;
  /** Contract 1.62.0 (W2-b): how long the session has been idle (ms), with `stalled`. */
  stalledForMs?: number;
  /** Verbatim native state, for consumers that want more than the projection. */
  runtimeState?: unknown;
}

/** Terminal-ish statuses that emit a synthetic `goal_end` broker event. */
export const GOAL_TERMINAL_STATUSES: readonly CanonicalGoalStatus[] = ['achieved', 'failed', 'cleared'];

export function isTerminalGoalStatus(status: CanonicalGoalStatus): boolean {
  return GOAL_TERMINAL_STATUSES.includes(status);
}
