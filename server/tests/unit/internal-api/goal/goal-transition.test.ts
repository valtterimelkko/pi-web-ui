/**
 * Phase 2 (contract 1.45.0, INTERNAL-API-SILENT-NOOP-AND-SESSION-OWNERSHIP-PLAN.md)
 * — goal transition truth, pure evaluator.
 *
 * The evaluator compares the goal projection read BEFORE the composed /goal
 * command with the projection read AFTER prompt() resolved (the extension
 * writes state synchronously before the command returns — 2924596f) and
 * classifies the outcome:
 *   applied        — the requested transition verifiably happened;
 *   honest no-op   — the desired end state already held (200 applied:false);
 *   failure        — the command ran but the state did not move (409
 *                    GOAL_ACTION_NOT_APPLIED).
 * Rules mirror the extension's own semantics (pi-enhancement/goal-engine):
 * isActive = running|wrapping-up; clear on non-active is a documented no-op
 * ("No active goal to clear."); resume requires paused; start is verified by
 * objective identity plus a live status.
 */
import { describe, it, expect } from 'vitest';
import { evaluatePiGoalActionTransition } from '../../../../src/internal-api/goal/goal-actions.js';
import type { SessionGoalProjection } from '../../../../src/internal-api/goal/types.js';

function projection(overrides: Partial<SessionGoalProjection> = {}): SessionGoalProjection {
  return {
    supported: true,
    status: 'idle',
    objective: undefined,
    verification: { status: 'not_run', command: null, message: null },
    lastReason: null,
    budget: { tokens: null, usd: null },
    startedAt: null,
    completedAt: null,
    pausedReason: null,
    ...overrides,
  };
}

describe('evaluatePiGoalActionTransition (Phase 2, contract 1.45.0)', () => {
  describe('start', () => {
    it('is applied when the objective matches and the goal is live', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'start',
        requestedObjective: 'write the thing',
        before: projection({ status: 'idle' }),
        after: projection({ status: 'running', objective: 'write the thing' }),
      });
      expect(result).toMatchObject({ applied: true, failure: false });
    });

    it('is applied when it replaces an achieved goal (S4)', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'start',
        requestedObjective: 'next objective',
        before: projection({ status: 'achieved', objective: 'old objective', completedAt: 1 }),
        after: projection({ status: 'running', objective: 'next objective' }),
      });
      expect(result).toMatchObject({ applied: true, failure: false });
    });

    it('RED: is a failure when the state did not change (fenced silent no-op)', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'start',
        requestedObjective: 'write the thing',
        before: projection({ status: 'idle' }),
        after: projection({ status: 'idle' }),
      });
      expect(result).toMatchObject({ applied: false, failure: true });
    });

    it('is a failure when a different objective is live than requested', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'start',
        requestedObjective: 'write the thing',
        before: projection({ status: 'idle' }),
        after: projection({ status: 'running', objective: "someone else's objective" }),
      });
      expect(result).toMatchObject({ applied: false, failure: true });
    });

    it('is a failure when the objective matches but the status is not live (suggested state)', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'start',
        requestedObjective: 'write the thing',
        before: projection({ status: 'idle' }),
        after: projection({ status: 'suggested', objective: 'write the thing' }),
      });
      expect(result).toMatchObject({ applied: false, failure: true });
    });
  });

  describe('pause', () => {
    it('is applied when an active goal became paused', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'pause',
        before: projection({ status: 'running', objective: 'x' }),
        after: projection({ status: 'paused', objective: 'x' }),
      });
      expect(result).toMatchObject({ applied: true, failure: false });
    });

    it('is an honest no-op when the goal was already paused', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'pause',
        before: projection({ status: 'paused', objective: 'x' }),
        after: projection({ status: 'paused', objective: 'x' }),
      });
      expect(result).toMatchObject({ applied: false, failure: false, reason: 'already_paused' });
    });

    it('is a failure when an active goal stayed active', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'pause',
        before: projection({ status: 'running', objective: 'x' }),
        after: projection({ status: 'running', objective: 'x' }),
      });
      expect(result).toMatchObject({ applied: false, failure: true });
    });
  });

  describe('resume', () => {
    it('is applied when a paused goal became live', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'resume',
        before: projection({ status: 'paused', objective: 'x' }),
        after: projection({ status: 'running', objective: 'x' }),
      });
      expect(result).toMatchObject({ applied: true, failure: false });
    });

    it('is an honest no-op when no goal was paused', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'resume',
        before: projection({ status: 'running', objective: 'x' }),
        after: projection({ status: 'running', objective: 'x' }),
      });
      expect(result).toMatchObject({ applied: false, failure: false, reason: 'not_paused' });
    });

    it('is a failure when a paused goal stayed paused (fenced silent no-op)', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'resume',
        before: projection({ status: 'paused', objective: 'x' }),
        after: projection({ status: 'paused', objective: 'x' }),
      });
      expect(result).toMatchObject({ applied: false, failure: true });
    });
  });

  describe('clear', () => {
    it('is applied when an active goal became inactive', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'clear',
        before: projection({ status: 'running', objective: 'x' }),
        after: projection({ status: 'idle' }),
      });
      expect(result).toMatchObject({ applied: true, failure: false });
    });

    it('RED: is an honest already_inactive no-op when nothing was active (S4)', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'clear',
        before: projection({ status: 'idle' }),
        after: projection({ status: 'idle' }),
      });
      expect(result).toMatchObject({ applied: false, failure: false, reason: 'already_inactive' });
    });

    it('is an honest already_inactive no-op for an achieved goal (extension: no active goal to clear)', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'clear',
        before: projection({ status: 'achieved', objective: 'x', completedAt: 5 }),
        after: projection({ status: 'achieved', objective: 'x', completedAt: 5 }),
      });
      expect(result).toMatchObject({ applied: false, failure: false, reason: 'already_inactive' });
    });

    it('is a failure when an active goal stayed active (cleared refused / confirm unanswered)', () => {
      const result = evaluatePiGoalActionTransition({
        action: 'clear',
        before: projection({ status: 'running', objective: 'x' }),
        after: projection({ status: 'running', objective: 'x' }),
      });
      expect(result).toMatchObject({ applied: false, failure: true });
    });
  });
});
