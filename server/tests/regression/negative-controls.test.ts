/**
 * Falsifiability controls for the Phase 6 regression suite (Track G).
 *
 * A green suite is worthless unless it CAN fail. Each control simulates the
 * guard under test being **deliberately bypassed** (the bypassed outcome is the
 * unsafe one) and asserts that the very assertion the real suite uses then
 * fails through the D runner. This proves, per family, that the check is
 * load-bearing rather than vacuously true.
 *
 * These controls are hermetic and committed; the companion out-of-band control
 * run (recorded in the child's handback) mutates a scratch copy of the real
 * `server/src/**` modules and observes the suite failing, which is why
 * `server/src/**` itself stays untouched here.
 */

import { describe, expect, it } from 'vitest';

import { loadFidelityCorpus, scoreFidelityItem, wordErrorRate, type FidelityItem } from './harness/corpus.js';
import { runRegressionChecks, type RegressionCheck } from './harness/run.js';

/** Run a control that must fail, and whose failure must name the guard's check. */
function expectFalsified(
  controlId: string,
  checks: RegressionCheck[],
  expectedFailedId: string
): void {
  const report = runRegressionChecks(controlId, checks);
  expect(report.verdict, `${controlId}: a bypassed guard must be caught`).toBe('fail');
  expect(
    report.failed.map((entry) => entry.checkId),
    `${controlId}: the failing check must be the guard's own check`
  ).toContain(expectedFailedId);
  // Every check still executed: a failure never silently short-circuits the run.
  expect(report.executed).toBe(checks.length);
}

describe('falsifiability controls: every veto family can be shown to fail', () => {
  it('VETO 1 doubt: a classifier bypassed to always confirm is caught', () => {
    const bypassedClassifier = (): 'confirm' => 'confirm';
    expectFalsified(
      'negctl-doubt',
      [
        {
          id: 'doubt-not-sure-is-not-confirm',
          run: () => {
            expect(bypassedClassifier()).not.toBe('confirm');
          },
        },
      ],
      'doubt-not-sure-is-not-confirm'
    );
  });

  it('VETO 2 conditional agreement: a classifier bypassed to always confirm is caught', () => {
    const bypassedClassifier = (): 'confirm' => 'confirm';
    expectFalsified(
      'negctl-conditional',
      [
        {
          id: 'conditional-agreement-is-statement',
          run: () => {
            expect(bypassedClassifier()).toBe('statement');
          },
        },
      ],
      'conditional-agreement-is-statement'
    );
  });

  it('VETO 3 stale/tampered SHA: a gate bypassed to always take is caught', () => {
    const bypassedTake = (): 'taken' => 'taken';
    expectFalsified(
      'negctl-stale',
      [
        {
          id: 'tampered-sha-refuses',
          run: () => {
            expect(bypassedTake()).toBe('stale');
          },
        },
      ],
      'tampered-sha-refuses'
    );
  });

  it('VETO 4 replay: a confirmation bypassed to always authorise is caught', () => {
    const bypassedConfirm = (): 'authorised' => 'authorised';
    expectFalsified(
      'negctl-replay',
      [
        {
          id: 'replay-is-a-duplicate-refusal',
          run: () => {
            expect(bypassedConfirm()).toBe('duplicate_refusal');
          },
        },
      ],
      'replay-is-a-duplicate-refusal'
    );
  });

  it('VETO 5 disconnect: a router bypassed to delegate the stop is caught', () => {
    const bypassedRouter = { kernelCalls: 1 };
    expectFalsified(
      'negctl-disconnect',
      [
        {
          id: 'disconnect-never-reaches-the-kernel',
          run: () => {
            expect(bypassedRouter.kernelCalls).toBe(0);
          },
        },
      ],
      'disconnect-never-reaches-the-kernel'
    );
  });

  it('VETO 6 lane isolation: a release bypassed onto another lane is caught', () => {
    const bypassedTargetLane = (): string => 'worker-2';
    expectFalsified(
      'negctl-lane-isolation',
      [
        {
          id: 'target-lane-is-the-creation-lane',
          run: () => {
            expect(bypassedTargetLane()).toBe('worker-1');
          },
        },
      ],
      'target-lane-is-the-creation-lane'
    );
  });

  it('FIDELITY: a scorer bypassed to ignore a dropped negation is caught', () => {
    const corpus = loadFidelityCorpus();
    const entry = corpus.items.find((item) => item.negations.length > 0);
    expect(entry).toBeTruthy();
    const recognised = entry?.recognisedText as string;
    // The guard's real input: a recognised text whose negation cue was lost.
    const damaged = recognised.replace(/\bnot\b/i, '');
    expectFalsified(
      'negctl-fidelity-negation',
      [
        {
          id: 'dropped-negation-is-detected',
          run: () => {
            expect(scoreFidelityItem(entry as FidelityItem, damaged, recognised).negations.ratio).toBe(1);
          },
        },
      ],
      'dropped-negation-is-detected'
    );
  });

  it('FIDELITY: a WER check bypassed to expect zero loss is caught', () => {
    expectFalsified(
      'negctl-wer',
      [
        {
          id: 'wer-detects-a-lost-word',
          run: () => {
            expect(wordErrorRate('alpha beta gamma', 'alpha beta')).toBe(0);
          },
        },
      ],
      'wer-detects-a-lost-word'
    );
  });

  it('RUNNER: an empty suite and a single failure are both failures', () => {
    expect(runRegressionChecks('negctl-empty', []).verdict).toBe('fail');
    const single = runRegressionChecks('negctl-single', [
      { id: 'safe', run: () => undefined },
      { id: 'bypassed', run: () => { throw new Error('guard bypass observed'); } },
    ]);
    expect(single.verdict).toBe('fail');
    expect(single.failed.map((entry) => entry.checkId)).toEqual(['bypassed']);
  });
});
