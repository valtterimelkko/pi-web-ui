/**
 * Cross-runtime goal function (contract 1.27.0) — Pi slash-command composition tests.
 * The composed strings must parse with the goal-engine extension's own parser rules.
 */
import { describe, it, expect } from 'vitest';
import { composePiGoalCommand } from '../../../../src/internal-api/goal/goal-actions.js';

describe('composePiGoalCommand', () => {
  it('start composes a quoted objective plus optional flags', () => {
    const r = composePiGoalCommand({
      action: 'start',
      objective: 'Process 160 species datasets',
      maxTurns: 12,
      minReviews: 1,
      budgetTokens: 500000,
      budgetUsd: 4.5,
      verifyCommand: 'test -f done.marker',
    });
    expect(r).toEqual({
      ok: true,
      action: 'start',
      command: '/goal "Process 160 species datasets" --max-turns 12 --min-reviews 1 --budget-tokens 500000 --budget-usd 4.5 --verify "test -f done.marker"',
    });
  });

  it('pause maps to pause-now; resume and clear map directly', () => {
    expect(composePiGoalCommand({ action: 'pause' })).toEqual({ ok: true, action: 'pause', command: '/goal pause-now' });
    expect(composePiGoalCommand({ action: 'resume' })).toEqual({ ok: true, action: 'resume', command: '/goal resume' });
    expect(composePiGoalCommand({ action: 'clear' })).toEqual({ ok: true, action: 'clear', command: '/goal clear' });
  });

  it('rejects unknown actions and missing objectives with INVALID_REQUEST', () => {
    expect(composePiGoalCommand({ action: 'nope' })!.ok).toBe(false);
    expect((composePiGoalCommand({ action: 'start' }) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
    expect((composePiGoalCommand({ action: 'start', objective: '   ' }) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  it('rejects newlines in objective and verifyCommand', () => {
    const bad = composePiGoalCommand({ action: 'start', objective: 'line one\nrm -rf /' });
    expect(bad.ok).toBe(false);
    const badVerify = composePiGoalCommand({ action: 'start', objective: 'x', verifyCommand: 'a\nb' });
    expect(badVerify.ok).toBe(false);
  });

  it('rejects a verifyCommand that cannot be quoted for the parser', () => {
    const r = composePiGoalCommand({ action: 'start', objective: 'x', verifyCommand: `grep "a" 'b' file` });
    expect(r.ok).toBe(false);
  });

  it('validates flag types honestly', () => {
    expect((composePiGoalCommand({ action: 'start', objective: 'x', maxTurns: -3 }) as { error?: { code: string } }).error?.code).toBe('INVALID_REQUEST');
    expect((composePiGoalCommand({ action: 'start', objective: 'x', budgetUsd: 'lots' }) as { error?: { code: string } }).error?.code).toBe('INVALID_REQUEST');
    expect((composePiGoalCommand({ action: 'start', objective: 'x', minReviews: 1.5 }) as { error?: { code: string } }).error?.code).toBe('INVALID_REQUEST');
  });
});
