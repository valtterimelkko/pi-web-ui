import { describe, it, expect } from 'vitest';
import { buildStallNotification, isLostWake } from '../../../src/internal-api/run-receipts/stall-notification.js';

/**
 * What the operator is told when the watchdog terminalises a run (2026-09-15).
 *
 * Run `5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f` was a watch wake that never
 * executed: accepted 08:36:09, zero assistant messages, zero tool calls, never
 * delivered to the session, terminalised 15 minutes later by the idle watchdog.
 * The operator received
 *
 *   "Run quarantined (TURN_STALLED) … The admission slot is held until the
 *    runtime confirms cessation (or a 30s drain quarantine); no action required"
 *
 * which is wrong in three ways for that event: nothing was "quarantined"
 * (`quarantinedRuns` stayed 0 — the runtime was never executing the run, so the
 * drain released the slot on its first poll), the parenthetical implies the 30s
 * drain releases the slot when it in fact replaces it with held capacity debt,
 * and "no action required" is the opposite of helpful for a wake that was
 * silently lost.
 */
describe('stall notification wording', () => {
  const lostWake = {
    runId: '5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f',
    sessionId: '01a0a410-f683-7422-bc57-055af50db3f2',
    status: 'failed',
    liveness: {
      idleTimeoutMs: 900_000,
      watchdog: { reason: 'no_activity', idleTimeoutMs: 900_000 },
      cessation: { state: 'unknown', basis: 'watchdog' },
    },
    outputEvidence: { assistantMessages: 0, toolCalls: 0, disposition: 'unknown' },
  };

  it('recognises a run that never executed', () => {
    expect(isLostWake(lostWake)).toBe(true);
    expect(isLostWake({ liveness: { watchdog: { reason: 'idle' } } })).toBe(false);
    expect(isLostWake({ liveness: { watchdog: { reason: 'absolute' } } })).toBe(false);
    expect(isLostWake({})).toBe(false);
  });

  it('reports a lost wake as a lost wake, and never advises a retry it cannot prove safe', () => {
    const { title, body } = buildStallNotification(lostWake);

    // Lane A (W1): this fixture has NO delivery evidence — the honest claim is
    // "no activity was observed", not "the message never ran". The audit's
    // eight Devin wakes were exactly this shape and then executed.
    expect(title).toContain('Wake unconfirmed');
    expect(title).toContain('5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f');
    expect(title).not.toContain('quarantined');

    // The honest claims.
    expect(body).toContain('no activity of any kind');
    expect(body).toContain('01a0a410-f683-7422-bc57-055af50db3f2');
    expect(body).toContain('900000');
    expect(body).toMatch(/unconfirmed/i);
    // Actionable guidance without asserting non-execution: check, then decide.
    expect(body).toMatch(/check the session transcript/i);
    expect(body).not.toContain('no action required');
    // No claim that a slot is being held for this case: it was never executing.
    expect(body).not.toMatch(/slot is held/i);
    // The obsolete unsafe advice must not survive for an unproven state.
    expect(body).not.toMatch(/nothing to clean up/i);
    expect(body).not.toMatch(/re-dispatch it/i);
  });

  it('Lane A: a message proven removed before dispatch IS safe to re-dispatch, with a fresh key', () => {
    const removed = {
      ...lostWake,
      status: 'cancelled',
      errorCode: 'NEVER_STARTED',
      liveness: {
        ...lostWake.liveness,
        delivery: { state: 'cancelled_before_dispatch', basis: 'targeted_removal', observedAt: '2026-11-25T00:00:00.000Z' },
      },
    };
    const { title, body } = buildStallNotification(removed);

    expect(title).toMatch(/never executed/i);
    expect(body).toMatch(/removed from the session's follow-up queue/i);
    // Proven non-execution: retry advice is correct here, and only here.
    expect(body).toMatch(/re-dispatch it/i);
    expect(body).toMatch(/new idempotency key/i);
    // ...but it must not claim something the receipt does not say.
    expect(body).not.toMatch(/nothing to clean up no orphan process/i);
  });

  it('Lane A: a queued message at the absolute ceiling is never safe to retry', () => {
    const { title, body } = buildStallNotification({
      runId: 'run-ceiling',
      sessionId: 'session-ceiling',
      status: 'failed',
      errorCode: 'NEVER_STARTED',
      liveness: {
        watchdog: { reason: 'absolute', idleTimeoutMs: 900_000, absoluteTimeoutMs: 21_600_000 },
        cessation: { state: 'unknown', basis: 'watchdog' },
        delivery: { state: 'queued', basis: 'follow_up_queue', observedAt: '2026-11-25T00:00:00.000Z' },
      },
    });
    expect(title).toMatch(/delivery unconfirmed/i);
    expect(body).toMatch(/has not been shown/i);
    expect(body).not.toMatch(/re-dispatch it/i);
  });

  it('Lane A: a late terminal observation is reported as contradictory evidence', () => {
    const { title, body } = buildStallNotification({
      runId: 'run-late',
      sessionId: 'session-late',
      status: 'failed',
      errorCode: 'NEVER_STARTED',
      liveness: {
        watchdog: { reason: 'no_activity', startWindowMs: 120_000 },
        cessation: { state: 'unknown', basis: 'watchdog' },
        delivery: { state: 'late_terminal_observed', basis: 'late_terminal', observedAt: '2026-11-25T00:05:00.000Z' },
        terminalObservations: [{ late: true, observedAt: '2026-11-25T00:04:00.000Z' }],
      },
    });
    expect(title).toMatch(/contradict/i);
    expect(body).toMatch(/contradict/i);
    expect(body).not.toMatch(/if the work still matters/i);
  });

  it('keeps the quarantine wording for a turn that really was running', () => {
    const { title, body } = buildStallNotification({
      runId: 'run-idle',
      sessionId: 'session-1',
      liveness: { watchdog: { reason: 'idle', idleTimeoutMs: 900_000 }, cessation: { state: 'unknown', basis: 'watchdog' } },
    });

    expect(title).toContain('quarantined');
    expect(title).toContain('run-idle');
    expect(body).toMatch(/slot is held/i);
    // The 30s drain does NOT release the slot; it converts it to held debt.
    // Saying "(or a 30s drain quarantine)" implied the opposite.
    expect(body).not.toMatch(/or a 30s drain quarantine/i);
    expect(body).toMatch(/capacity debt|held as/i);
  });

  it('still names the run for an absolute-ceiling stop', () => {
    const { title, body } = buildStallNotification({
      runId: 'run-absolute',
      sessionId: 'session-2',
      liveness: { watchdog: { reason: 'absolute', idleTimeoutMs: 900_000 }, cessation: { state: 'unknown', basis: 'watchdog' } },
    });
    expect(title).toContain('run-absolute');
    expect(body).toContain('run-absolute');
  });

  it('does not crash on a receipt missing the optional detail', () => {
    const { title, body } = buildStallNotification({ runId: 'bare-run' });
    expect(title).toContain('bare-run');
    expect(body).toContain('bare-run');
  });});
