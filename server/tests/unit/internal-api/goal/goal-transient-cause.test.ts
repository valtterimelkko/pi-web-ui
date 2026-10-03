/**
 * Wave K (contract 1.59.0) — K1 transient-cause classifier table tests.
 *
 * The classifier takes the facts of a goal child's stop and returns a
 * transient cause (closed list: restart interruption, rehydrate pause,
 * provider abort) or `not_transient`. One row per transient cause plus the
 * negative rows (real tool error, user/parent abort, budget pause, question
 * pause, unknown receipt reason, live session). Documented in
 * docs/INTERNAL-API.md § Goal.
 */
import { describe, it, expect } from 'vitest';
import { classifyGoalStop, type StopFacts } from '../../../../src/internal-api/goal/transient-cause.js';

function row(name: string, facts: StopFacts, expected: { transient: boolean; cause?: string; reasonIncludes?: string }): void {
  it(name, () => {
    const result = classifyGoalStop(facts);
    expect(result.transient).toBe(expected.transient);
    if (expected.transient) {
      expect(result.cause).toBe(expected.cause);
    } else if (expected.reasonIncludes) {
      expect(result.reason).toContain(expected.reasonIncludes);
    }
  });
}

describe('classifyGoalStop — transient rows', () => {
  row('receipt SERVER_RESTART', { source: 'receipt', interruptionReason: 'SERVER_RESTART' }, { transient: true, cause: 'restart_interruption' });
  row('receipt interruptedByRestart', { source: 'receipt', interruptionReason: 'interruptedByRestart' }, { transient: true, cause: 'restart_interruption' });
  row('drain drain_timeout', { source: 'drain', interruptionReason: 'drain_timeout' }, { transient: true, cause: 'restart_interruption' });
  row('boot orphan: goal running on disk, session not busy', { source: 'boot_orphan', diskStatus: 'running', sessionBusy: false }, { transient: true, cause: 'restart_interruption' });
  row('boot orphan: goal wrapping_up on disk, session not busy', { source: 'boot_orphan', diskStatus: 'wrapping_up', sessionBusy: false }, { transient: true, cause: 'restart_interruption' });
  row('rehydrate pause inside a restart/orphan scope', { source: 'rehydrate_pause', pauseReason: 'restored_on_session_start', inRestartScope: true }, { transient: true, cause: 'rehydrate_pause' });
  row('provider overload 429', { source: 'provider_abort', status: 'paused', lastErrorMessage: 'Provider overloaded (HTTP 429); retries exhausted' }, { transient: true, cause: 'provider_abort' });
  row('provider 5xx', { source: 'provider_abort', status: 'failed', lastErrorMessage: 'HTTP 503 from provider upstream' }, { transient: true, cause: 'provider_abort' });
  row('provider connection reset', { source: 'provider_abort', status: 'paused', lastErrorMessage: 'ECONNRESET while streaming from provider' }, { transient: true, cause: 'provider_abort' });
  row('exhausted provider retries', { source: 'provider_abort', status: 'paused', lastErrorMessage: 'Provider request failed after retries exhausted' }, { transient: true, cause: 'provider_abort' });
});

describe('classifyGoalStop — negative rows', () => {
  row('boot orphan but session is live (busy)', { source: 'boot_orphan', diskStatus: 'running', sessionBusy: true }, { transient: false, reasonIncludes: 'live' });
  row('receipt with an unknown interruption reason', { source: 'receipt', interruptionReason: 'something_else' }, { transient: false, reasonIncludes: 'reason' });
  row('restored_on_session_start outside a restart scope (plain idle-eviction rehydrate)', { source: 'rehydrate_pause', pauseReason: 'restored_on_session_start', inRestartScope: false }, { transient: false, reasonIncludes: 'scope' });
  row('budget pause', { source: 'rehydrate_pause', pauseReason: 'spend budget reached', inRestartScope: true }, { transient: false, reasonIncludes: 'pause' });
  row('turn-limit pause', { source: 'rehydrate_pause', pauseReason: 'turn limit reached', inRestartScope: true }, { transient: false, reasonIncludes: 'pause' });
  row('user abort (goal engine message)', { source: 'provider_abort', status: 'paused', lastErrorMessage: 'Goal run aborted by user; auto-continuation paused.' }, { transient: false, reasonIncludes: 'abort' });
  row('bare abort (ambiguous: user, parent or browser stop)', { source: 'provider_abort', status: 'paused', lastErrorMessage: 'aborted' }, { transient: false, reasonIncludes: 'abort' });
  row('verification failure (real error)', { source: 'provider_abort', status: 'paused', lastErrorMessage: 'Verification failed: npm test exited 1' }, { transient: false, reasonIncludes: 'error' });
  row('real tool error (not provider evidence)', { source: 'provider_abort', status: 'failed', lastErrorMessage: 'Tool write failed: EACCES /worktree/file' }, { transient: false, reasonIncludes: 'error' });
  row('no error message at all', { source: 'provider_abort', status: 'failed', lastErrorMessage: null }, { transient: false, reasonIncludes: 'error' });
});
