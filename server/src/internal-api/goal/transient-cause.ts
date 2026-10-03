/**
 * Wave K (contract 1.60.0) — K1 transient-cause classifier (pure).
 *
 * Takes the facts of a goal child's stop and returns a transient cause or
 * `not_transient`. The transient list is closed (R5 scope): restart
 * interruption (receipt-backed, drain-announced, or an unannounced death
 * detected at boot as a goal `running` on disk with no live turn), the
 * rehydrate-at-start goal pause, and a provider abort with POSITIVE provider
 * evidence (overload, 429, 5xx, provider connection reset, exhausted provider
 * retries). Everything else is a real stop: a user/parent abort, a bare
 * ambiguous abort, a budget or turn limit, a verification failure, a real
 * tool error, a question pause. Documented in docs/INTERNAL-API.md § Goal.
 */

/** Closed transient-cause list (K1). */
export type TransientCause = 'restart_interruption' | 'rehydrate_pause' | 'provider_abort';

/**
 * Full cause vocabulary for the interruption object (contract 1.60.0): the
 * transient causes plus the visible non-continue causes.
 */
export type GoalInterruptionCause = TransientCause | 'second_transient' | 'limit' | 'question' | 'unsupported_runtime' | 'continue_failed';

/** Where the stop facts came from (surfaced in the projection's interruption object). */
export type InterruptionSource = 'receipt' | 'drain' | 'boot_orphan' | 'rehydrate_pause' | 'provider_abort';

export interface RestartStopFacts {
  source: 'receipt' | 'drain';
  interruptionReason: string;
}

export interface BootOrphanFacts {
  source: 'boot_orphan';
  diskStatus: 'running' | 'wrapping_up';
  sessionBusy: boolean;
}

export interface RehydratePauseFacts {
  source: 'rehydrate_pause';
  pauseReason: string;
  /** True only when the restore pause is seen inside a restart/orphan scope (R1, R7). */
  inRestartScope: boolean;
}

export interface ProviderAbortFacts {
  source: 'provider_abort';
  status: 'failed' | 'paused';
  lastErrorMessage: string | null;
}

export type StopFacts = RestartStopFacts | BootOrphanFacts | RehydratePauseFacts | ProviderAbortFacts;

export type GoalStopClassification =
  | { transient: true; cause: TransientCause }
  | { transient: false; reason: string };

/** Receipt/drain reasons that mean the server cut the run off (not the child or parent). */
const RESTART_REASONS = new Set(['SERVER_RESTART', 'server_restart', 'interruptedByRestart', 'drain_timeout']);

/**
 * Positive provider evidence only (R6). A bare "aborted" is ambiguous — a
 * user abort, a parent abort and the browser stop button look identical — so
 * it is deliberately NOT transient. Ordered most-specific first; `abort`
 * patterns are checked before provider patterns so an "aborted by user"
 * message can never ride a substring match into a transient verdict.
 */
const NOT_TRANSIENT_PATTERNS: RegExp[] = [
  /abort/i,
];

const PROVIDER_EVIDENCE_PATTERNS: RegExp[] = [
  /overload/i,
  /\b429\b/,
  /rate[ ._-]?limit/i,
  /\b5\d\d\b/,
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN)\b/,
  /socket hang up/i,
  /retr(?:y|ies|ied)[^.]*exhaust|exhaust[^.]*retr/i,
];

function hasProviderEvidence(message: string): boolean {
  if (NOT_TRANSIENT_PATTERNS.some((p) => p.test(message))) return false;
  return PROVIDER_EVIDENCE_PATTERNS.some((p) => p.test(message));
}

/** Classify a goal child's stop from its facts. Pure; total (never throws). */
export function classifyGoalStop(facts: StopFacts): GoalStopClassification {
  switch (facts.source) {
    case 'receipt':
    case 'drain': {
      if (RESTART_REASONS.has(facts.interruptionReason)) {
        return { transient: true, cause: 'restart_interruption' };
      }
      return { transient: false, reason: `receipt interruption reason '${facts.interruptionReason}' is not a restart/drain cut-off` };
    }
    case 'boot_orphan': {
      if (facts.sessionBusy) {
        return { transient: false, reason: 'session is live (busy); nothing to continue' };
      }
      if (facts.diskStatus === 'running' || facts.diskStatus === 'wrapping_up') {
        return { transient: true, cause: 'restart_interruption' };
      }
      return { transient: false, reason: `disk status '${facts.diskStatus}' is not an active goal` };
    }
    case 'rehydrate_pause': {
      if (facts.pauseReason !== 'restored_on_session_start') {
        return { transient: false, reason: `pause reason '${facts.pauseReason}' is a deliberate pause, not a restore` };
      }
      if (!facts.inRestartScope) {
        return { transient: false, reason: 'restore pause outside a restart/orphan scope (plain rehydration)' };
      }
      return { transient: true, cause: 'rehydrate_pause' };
    }
    case 'provider_abort': {
      if (!facts.lastErrorMessage) {
        return { transient: false, reason: 'no error message; not positive provider evidence' };
      }
      if (hasProviderEvidence(facts.lastErrorMessage)) {
        return { transient: true, cause: 'provider_abort' };
      }
      return { transient: false, reason: `error message lacks positive provider evidence (abort/limit/real error): '${facts.lastErrorMessage.slice(0, 120)}'` };
    }
  }
}
