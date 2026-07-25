import { describe, it, expect } from 'vitest';
import {
  parseGoalWidget,
  deriveGoalPhase,
  summarizeGoal,
  isGoalContinuationPrompt,
  formatSpend,
  GOAL_WIDGET_KEY,
} from '../../../src/lib/goalModel';

/**
 * Widget payloads here are verbatim captures from a live Pi session running the
 * goal-engine extension (gpt-5.6-luna, 2026-07-25). The extension owns this
 * format; the client only reads it, so these fixtures are the contract.
 */
const RUNNING_WIDGET = [
  '🎯 Goal Status',
  'Status: ▶ Running',
  'Objective: Create three files in this workspace: a.txt, b.txt and c.txt, each containing the single word done.',
  'Started: 7/25/2026, 4:41:01 PM',
  'Agent runs: 1',
  'Max runs: 4',
  'Last run: suspect — completion rejected: A newly completed critical-review cycle must be followed by a separate improvement/re-check run before completion.',
  'Continuation interval: 30s (rung 1/4)',
  'Consecutive suspect runs: 1',
  'Token spend: 38,287 / 5,000,000 billed input tokens',
  'USD spend: $0.06 / disabled',
  'Progress: 1/1',
  'Verification command: test -f a.txt && test -f b.txt',
  'Verification status: failed',
  'Verification result: A newly completed critical-review cycle must be followed by a separate improvement/re-check run before completion.',
  'Critical-review cycles: 1/1',
  '',
  'Run /goal status again to hide.',
];

const PLAN_WIDGET = [
  '🎯 Goal Status',
  'Status: ⏸ Paused',
  'Objective: Ship the thing',
  'Started: 7/25/2026, 4:41:01 PM',
  'Agent runs: 3',
  'Continuation interval: 2m (rung 3/4)',
  'Token spend: 1,000 / disabled billed input tokens',
  'Verification status: not-run',
  'Compactions: 2',
  'Consecutive errors: 1',
  'Last error: boom',
  '',
  'Plan:',
  '  ✓ First step',
  '  ☐ Second step',
  '',
  'Run /goal status again to hide.',
];

describe('goalModel', () => {
  describe('parseGoalWidget', () => {
    it('parses the core fields of a running goal', () => {
      const model = parseGoalWidget(RUNNING_WIDGET);
      expect(model).not.toBeNull();
      expect(model!.status).toBe('running');
      expect(model!.objective).toContain('Create three files in this workspace');
      expect(model!.runs).toBe(1);
      expect(model!.maxRuns).toBe(4);
      expect(model!.startedAt).toBe('7/25/2026, 4:41:01 PM');
      expect(model!.lastRun).toContain('suspect');
    });

    it('parses spend, progress and verification', () => {
      const model = parseGoalWidget(RUNNING_WIDGET)!;
      expect(model.tokensSpent).toBe(38287);
      expect(model.tokenBudget).toBe(5000000);
      expect(model.usdSpent).toBe(0.06);
      expect(model.usdBudget).toBeNull();
      expect(model.progress).toEqual({ label: 'Progress', current: 1, total: 1 });
      expect(model.verification.command).toBe('test -f a.txt && test -f b.txt');
      expect(model.verification.status).toBe('failed');
      expect(model.verification.result).toContain('critical-review cycle');
      expect(model.reviewCycles).toEqual({ completed: 1, required: 1 });
    });

    it('parses the continuation interval into milliseconds', () => {
      expect(parseGoalWidget(RUNNING_WIDGET)!.continuationIntervalMs).toBe(30_000);
      expect(parseGoalWidget(PLAN_WIDGET)!.continuationIntervalMs).toBe(120_000);
    });

    it('parses plan items, compactions and errors', () => {
      const model = parseGoalWidget(PLAN_WIDGET)!;
      expect(model.status).toBe('paused');
      expect(model.plan).toEqual([
        { text: 'First step', done: true },
        { text: 'Second step', done: false },
      ]);
      expect(model.compactions).toBe(2);
      expect(model.errors).toEqual({ consecutive: 1, lastMessage: 'boom' });
      expect(model.tokenBudget).toBeNull();
    });

    it('does not leak the CLI-only hide hint into the parsed model', () => {
      const model = parseGoalWidget(RUNNING_WIDGET)!;
      expect(JSON.stringify(model)).not.toContain('/goal status again to hide');
    });

    it('recognises awaiting-input and wrapping-up states', () => {
      const awaiting = parseGoalWidget([
        '🎯 Goal Status',
        'Status: ⏸ Awaiting user input',
        'Objective: X',
        'Agent runs: 2',
        'Question: Which database should I use?',
      ])!;
      expect(awaiting.status).toBe('awaiting-input');
      expect(awaiting.question).toBe('Which database should I use?');

      const wrapping = parseGoalWidget([
        '🎯 Goal Status',
        'Status: ⏸ Wrapping up…',
        'Objective: X',
        'Agent runs: 2',
      ])!;
      expect(wrapping.status).toBe('wrapping-up');
    });

    it('parses a completed goal report', () => {
      const model = parseGoalWidget([
        '🎯 Goal Report',
        'Status: Idle',
        'Objective: X',
        'Agent runs: 2',
        'Verification status: passed',
        '',
        'Completed: 7/25/2026, 4:42:27 PM',
      ])!;
      expect(model.status).toBe('idle');
      expect(model.completedAt).toBe('7/25/2026, 4:42:27 PM');
      expect(model.verification.status).toBe('passed');
    });

    it('returns null for widgets that are not goal-engine payloads', () => {
      expect(parseGoalWidget(['some other extension', 'line two'])).toBeNull();
      expect(parseGoalWidget([])).toBeNull();
    });
  });

  describe('deriveGoalPhase', () => {
    const model = parseGoalWidget(RUNNING_WIDGET)!;

    it('reports working while the agent streams', () => {
      const phase = deriveGoalPhase({ model, isStreaming: true, updatedAt: 1000, now: 5000 });
      expect(phase.kind).toBe('working');
      expect(phase.pulsing).toBe(true);
      // Run 1 has completed, so the run in flight is number 2.
      expect(phase.displayRun).toBe(2);
    });

    it('counts down to the next continuation while idle between runs', () => {
      const phase = deriveGoalPhase({ model, isStreaming: false, updatedAt: 1000, now: 11_000 });
      expect(phase.kind).toBe('continuing');
      expect(phase.secondsUntilContinue).toBe(20);
      expect(phase.label).toBe('continuing in 20s');
      expect(phase.pulsing).toBe(false);
    });

    it('keeps a continuing state once the interval has elapsed', () => {
      const phase = deriveGoalPhase({ model, isStreaming: false, updatedAt: 1000, now: 99_000 });
      expect(phase.kind).toBe('continuing');
      expect(phase.secondsUntilContinue).toBe(0);
      expect(phase.label).toBe('continuing…');
    });

    it('reports paused, wrapping-up and awaiting-input distinctly', () => {
      const paused = parseGoalWidget(PLAN_WIDGET)!;
      expect(deriveGoalPhase({ model: paused, isStreaming: false, updatedAt: 0, now: 0 }).kind).toBe('paused');

      const wrapping = { ...model, status: 'wrapping-up' as const };
      expect(deriveGoalPhase({ model: wrapping, isStreaming: true, updatedAt: 0, now: 0 }).kind).toBe('wrapping-up');

      const awaiting = { ...model, status: 'awaiting-input' as const, question: 'Which one?' };
      const phase = deriveGoalPhase({ model: awaiting, isStreaming: false, updatedAt: 0, now: 0 });
      expect(phase.kind).toBe('awaiting-input');
      expect(phase.label).toContain('needs you');
    });

    it('reports done for a completed goal', () => {
      const done = { ...model, status: 'idle' as const, completedAt: '7/25/2026, 4:42:27 PM' };
      const phase = deriveGoalPhase({ model: done, isStreaming: false, updatedAt: 0, now: 0 });
      expect(phase.kind).toBe('done');
      expect(phase.pulsing).toBe(false);
    });

    it('never shows a countdown when no interval is known', () => {
      const noInterval = { ...model, continuationIntervalMs: null };
      const phase = deriveGoalPhase({ model: noInterval, isStreaming: false, updatedAt: 0, now: 1000 });
      expect(phase.kind).toBe('continuing');
      expect(phase.secondsUntilContinue).toBeNull();
    });
  });

  describe('summarizeGoal', () => {
    it('builds a one-line header for the collapsed panel', () => {
      const model = parseGoalWidget(RUNNING_WIDGET)!;
      const phase = deriveGoalPhase({ model, isStreaming: true, updatedAt: 0, now: 0 });
      const summary = summarizeGoal(model, phase);
      expect(summary).toContain('Run 2/4');
      expect(summary).toContain('$0.06');
      // Callers that render the run themselves can drop it from the summary.
      expect(summarizeGoal(model, phase, { includeRun: false })).not.toContain('Run 2/4');
    });

    it('summarises a completed goal by outcome', () => {
      const model = { ...parseGoalWidget(RUNNING_WIDGET)!, status: 'idle' as const, runs: 2, completedAt: 'x' };
      const phase = deriveGoalPhase({ model, isStreaming: false, updatedAt: 0, now: 0 });
      expect(summarizeGoal(model, phase)).toContain('2 runs');
    });
  });

  describe('isGoalContinuationPrompt', () => {
    it('detects the extension-authored continuation prompts', () => {
      expect(isGoalContinuationPrompt('Continue working toward the goal. Report progress, completed critical-review cycles, and whether the objective has been fully achieved.')).toBe(true);
      expect(isGoalContinuationPrompt('Resume working toward the goal. Continue from where you left off.')).toBe(true);
      expect(isGoalContinuationPrompt('Resume the persisted goal. Re-read key files, reconstruct progress, and continue from the latest verified state.')).toBe(true);
    });

    it('leaves the operator-authored seed prompt and normal messages alone', () => {
      expect(isGoalContinuationPrompt('Goal: build the thing\n\nBegin working toward this objective.')).toBe(false);
      expect(isGoalContinuationPrompt('continue')).toBe(false);
      expect(isGoalContinuationPrompt('')).toBe(false);
    });
  });

  describe('formatSpend', () => {
    it('formats token and usd spend compactly', () => {
      expect(formatSpend(38287, 5000000)).toBe('38.3k / 5M tokens');
      expect(formatSpend(900, null)).toBe('900 tokens');
    });
  });

  it('exposes the goal widget key the extension uses', () => {
    expect(GOAL_WIDGET_KEY).toBe('goal-engine-status');
  });
});
