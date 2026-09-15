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

  it('reports a lost wake as a lost wake, and says what to do about it', () => {
    const { title, body } = buildStallNotification(lostWake);

    expect(title).toContain('Wake lost');
    expect(title).toContain('5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f');
    expect(title).not.toContain('quarantined');

    // The honest claims.
    expect(body).toContain('never');
    expect(body).toContain('01a0a410-f683-7422-bc57-055af50db3f2');
    expect(body).toContain('900000');
    // Actionable, instead of "no action required".
    expect(body).toMatch(/re-dispatch|redispatch|replay/i);
    expect(body).not.toContain('no action required');
    // No claim that a slot is being held for this case: it was never executing.
    expect(body).not.toMatch(/slot is held/i);
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
  });
});
