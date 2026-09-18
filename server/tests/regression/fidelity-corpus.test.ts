/**
 * Fidelity corpus + regression harness (Voice Mode execution plan, Phase 6;
 * architecture recommendation 2026-09 §7.1.3).
 *
 * Wave 0 (child D) loaded the migrated frozen corpus, asserted its shape and
 * provenance, and executed one worked scoring example. Wave 2 (child G) adds
 * the Gate 6 scoring suite: recognition WER, required-word recall, 100 %
 * retention of critical negations/conditionals, file paths and semi-verbatim
 * byte equality, all scored hermetically from the frozen fixture (no live
 * provider calls). The kernel-dependent vetoes live in `safety-veto.test.ts`.
 *
 * Nothing in this file skips: the corpus is a committed fixture, so a missing
 * or damaged fixture is a failure, and every Gate 6 score runs through Track
 * D's runner (zero checks fails; one failure fails the suite).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FIXTURE_PATH,
  FIDELITY_CORPUS_SCHEMA,
  aggregateFidelity,
  aggregateRecognition,
  byteEqual,
  composeCandidateText,
  contentTokens,
  criticalTokenRetention,
  filePathsIn,
  loadFidelityCorpus,
  recognitionWords,
  recognisedTextProblems,
  scoreFidelityItem,
  scoreRecognition,
  validateFidelityCorpus,
  wordErrorRate,
  type FidelityItem,
} from './harness/corpus.js';
import { assertRegressionPass, runRegressionChecks, type RegressionCheck } from './harness/run.js';
import { PendingProposalStore } from '../../src/talker/proposal-store.js';

// Loaded at module scope, so an invalid fixture fails the file rather than
// quietly shrinking the suite.
const corpus = loadFidelityCorpus();

describe('migrated fidelity corpus fixture', () => {
  it('is a valid voice-lab.fidelity-corpus/1 document with exactly 20 items', () => {
    const outcome = validateFidelityCorpus(corpus);
    expect(outcome.problems).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(corpus.schema).toBe(FIDELITY_CORPUS_SCHEMA);
    expect(corpus.version).toContain('frozen');
    expect(corpus.items).toHaveLength(20);
  });

  it('records provenance back to the bench source and commit', () => {
    const provenance = corpus.provenance;
    expect(provenance, 'fixture must carry a provenance header').toBeTruthy();
    expect(provenance?.sourceRepo).toBe('agent-benchmarks');
    expect(provenance?.sourcePath).toBe('benchmarks/04-voice-live-lab/scenarios/tier2/fidelity-corpus.json');
    expect(provenance?.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance?.migratedAt).toBeTruthy();
  });

  it('has ids fc-01 … fc-20, all unique', () => {
    expect(corpus.items.map((entry) => entry.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `fc-${String(index + 1).padStart(2, '0')}`)
    );
  });

  it('declares every required word and target inside its own utterance', () => {
    for (const entry of corpus.items) {
      const utteranceTokens = new Set(contentTokens(entry.utterance));
      for (const word of entry.requiredWords) {
        for (const token of contentTokens(word)) {
          expect(utteranceTokens.has(token), `${entry.id}: required "${word}" → ${token}`).toBe(true);
        }
      }
      for (const target of entry.targets) {
        for (const token of contentTokens(target)) {
          expect(utteranceTokens.has(token), `${entry.id}: target "${target}" → ${token}`).toBe(true);
        }
      }
      expect(entry.negations.length + entry.conditionals.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('scores the frozen corpus to recall 1.0 with the hermetic composer', () => {
    const scores = corpus.items.map((entry) => scoreFidelityItem(entry, composeCandidateText(entry)));
    const aggregate = aggregateFidelity(scores);
    expect(aggregate.items).toBe(20);
    expect(aggregate.recall).toBe(1);
    expect(aggregate.negationSurvival).toBe(1);
    expect(aggregate.conditionalSurvival).toBe(1);
    expect(aggregate.targetSurvival).toBe(1);
    expect(aggregate.distractorLeakage).toBe(0);
    expect(aggregate.criticalSurvival).toBe(1);
    // The verbatim operator utterance is the tier-1 mechanical control.
    const verbatim = aggregateFidelity(corpus.items.map((entry) => scoreFidelityItem(entry, entry.utterance, entry.utterance)));
    expect(verbatim.recall).toBe(1);
    expect(verbatim.lengthRatio).toBe(1);
  });
});

describe('scoring helpers (§7.1.3)', () => {
  const item = corpus.items[0];

  it('worked example (fc-01): a clean send keeps recall and the negation; dropping "not" loses the constraint', () => {
    const composed = composeCandidateText(item);
    const clean = scoreFidelityItem(item, composed);
    expect(item.id).toBe('fc-01');
    expect(clean.recall).toBe(1);
    expect(clean.missingRequired).toEqual([]);
    expect(clean.negations.ratio).toBe(1);
    expect(clean.negations.dropped).toEqual([]);
    expect(clean.critical.intact).toBe(true);

    const damaged = composed.replace(/\bnot\b/i, '');
    const dropped = scoreFidelityItem(item, damaged);
    expect(dropped.recall).toBe(1); // the nouns survive …
    expect(dropped.negations.ratio).toBe(0); // … but the constraint does not
    expect(dropped.negations.dropped).toEqual(['do not touch the auth routes']);
    expect(dropped.critical.intact).toBe(false);
    expect(dropped.critical.negationCues.dropped).toContain('not');
  });

  it('recognised → delivered byte equality is exact for semi-verbatim instructions', () => {
    const recognised = 'Add a changelog entry for the parser fix.';
    expect(byteEqual(recognised, recognised)).toBe(true);
    expect(byteEqual(recognised, `${recognised} `)).toBe(false);
    expect(byteEqual(recognised, recognised.replace('changelog', 'Changelog'))).toBe(false);
  });

  it('retains file paths and target names when a corpus item carries them', () => {
    const synthetic: FidelityItem = {
      id: 'fc-99',
      utterance:
        'Rename the helper in server/src/talker/policy-core.ts and do not touch src/talker/talker.ts, only if the tests pass.',
      requiredWords: ['helper'],
      negations: ['do not touch src/talker/talker.ts'],
      conditionals: ['only if the tests pass'],
      targets: ['server/src/talker/policy-core.ts'],
      distractors: ['I have lost my thread here'],
    };
    const paths = filePathsIn(synthetic.utterance);
    expect(paths).toContain('server/src/talker/policy-core.ts');
    expect(paths).toContain('src/talker/talker.ts');

    const intact = criticalTokenRetention(synthetic, synthetic.utterance);
    expect(intact.filePaths.ratio).toBe(1);
    expect(intact.targets.ratio).toBe(1);
    expect(intact.negationCues.ratio).toBe(1);
    expect(intact.conditionalCues.ratio).toBe(1);
    expect(intact.intact).toBe(true);

    const pathDropped = criticalTokenRetention(
      synthetic,
      'Rename the helper in server/src/talker/policy-core.ts and do not touch the other file, only if the tests pass.'
    );
    expect(pathDropped.filePaths.ratio).toBe(0.5);
    expect(pathDropped.filePaths.dropped).toEqual(['src/talker/talker.ts']);

    const conditionalDropped = criticalTokenRetention(
      synthetic,
      synthetic.utterance.replace(/\bonly if\b/i, 'after')
    );
    expect(conditionalDropped.conditionalCues.ratio).toBe(0);
    expect(conditionalDropped.conditionalCues.dropped).toEqual(['if']);
  });

  it('records honestly that the frozen corpus declares no file paths', () => {
    const corpusPaths = corpus.items.flatMap((entry) => filePathsIn(entry.utterance));
    expect(corpusPaths).toEqual([]);
    expect(corpus.observedGaps?.some((gap) => gap.includes('file'))).toBe(true);
  });
});

describe('regression runner skeleton', () => {
  it('executes checks and passes only when all of them hold', () => {
    const report = runRegressionChecks('shape-suite', [
      { id: 'fixture-has-20-items', run: () => expect(corpus.items).toHaveLength(20) },
      { id: 'fixture-validates', run: () => expect(validateFidelityCorpus(corpus).ok).toBe(true) },
    ]);
    expect(report.executed).toBe(2);
    expect(report.passed).toBe(2);
    expect(report.failed).toEqual([]);
    expect(report.verdict).toBe('pass');
    expect(report.failureReason).toBeNull();
    assertRegressionPass(report);
  });

  it('fails the whole suite when a single veto check throws', () => {
    const report = runRegressionChecks('veto-suite', [
      { id: 'ok', run: () => undefined },
      { id: 'void', run: () => { throw new Error('unauthorised release'); } },
    ]);
    expect(report.verdict).toBe('fail');
    expect(report.executed).toBe(2);
    expect(report.failed.map((entry) => entry.checkId)).toEqual(['void']);
    expect(report.failureReason).toContain('void');
    expect(() => assertRegressionPass(report)).toThrow(/regression suite veto-suite failed/);
  });

  it('fails a suite that executed zero checks (no vacuously green suites)', () => {
    const report = runRegressionChecks('empty-suite', []);
    expect(report.verdict).toBe('fail');
    expect(report.executed).toBe(0);
    expect(report.failureReason).toContain('0 checks');
  });
});

describe('fixture path', () => {
  it('resolves to server/tests/fixtures/fidelity-corpus.json', () => {
    expect(DEFAULT_FIXTURE_PATH.endsWith('/server/tests/fixtures/fidelity-corpus.json')).toBe(true);
  });
});

// ── Gate 6 scoring suite (runs through the D runner) ──────────────────────────

function check(id: string, run: () => void): RegressionCheck {
  return { id, run };
}

describe('Gate 6: the frozen corpus scored through the regression runner', () => {
  it('scores recognition, recall, critical retention, file paths and byte equality hermetically', () => {
    const composed = corpus.items.map((entry) => scoreFidelityItem(entry, composeCandidateText(entry)));
    const composedAggregate = aggregateFidelity(composed);
    const recognition = aggregateRecognition(
      corpus.items.map((entry) => scoreRecognition(entry, entry.recognisedText as string))
    );
    const verbatim = corpus.items.map((entry) =>
      scoreFidelityItem(entry, entry.recognisedText as string, entry.recognisedText as string)
    );

    const syntheticPathItem: FidelityItem = {
      id: 'fc-99',
      utterance:
        'Rename the helper in server/src/talker/policy-core.ts and do not touch src/talker/talker.ts, only if the tests pass.',
      recognisedText:
        'Rename the helper in server/src/talker/policy-core.ts and do not touch src/talker/talker.ts, only if the tests pass.',
      requiredWords: ['helper'],
      negations: ['do not touch src/talker/talker.ts'],
      conditionals: ['only if the tests pass'],
      targets: ['server/src/talker/policy-core.ts'],
      distractors: ['I have lost my thread here'],
    };

    const checks: RegressionCheck[] = [
      check('fixture-carries-20-recognised-texts-with-provenance', () => {
        expect(recognisedTextProblems(corpus)).toEqual([]);
        expect(corpus.items).toHaveLength(20);
        expect(corpus.recognisedProvenance?.source).toBe('frozen-reference');
      }),
      check('recognition-wer-is-zero-on-the-frozen-transcription-lane', () => {
        expect(recognition.items).toBe(20);
        expect(recognition.wer).toBe(0);
        expect(recognition.maxWer).toBe(0);
        for (const score of recognition.perItem) {
          expect(score.referenceWords, score.itemId).toBeGreaterThan(0);
        }
      }),
      check('recognition-loses-no-required-word-and-no-critical-token', () => {
        expect(recognition.recall).toBe(1);
        expect(recognition.intactRatio).toBe(1);
        expect(recognition.negationCueRetention).toBe(1);
        expect(recognition.conditionalCueRetention).toBe(1);
      }),
      check('composed-delivery-keeps-100pc-of-negations-and-conditionals', () => {
        expect(composedAggregate.items).toBe(20);
        expect(composedAggregate.recall).toBe(1);
        expect(composedAggregate.negationSurvival).toBe(1);
        expect(composedAggregate.conditionalSurvival).toBe(1);
        expect(composedAggregate.criticalSurvival).toBe(1);
      }),
      check('every-critical-negation-and-conditional-phrase-survives-exactly', () => {
        for (const entry of corpus.items) {
          const score = scoreFidelityItem(entry, composeCandidateText(entry));
          expect(score.negations.dropped, entry.id).toEqual([]);
          expect(score.conditionals.dropped, entry.id).toEqual([]);
          expect(score.requiredTotal - score.requiredRecalled, entry.id).toBe(0);
        }
      }),
      check('semi-verbatim-byte-equality-from-recognised-to-delivered', () => {
        for (const entry of corpus.items) {
          const recognised = entry.recognisedText as string;
          // The tier-1 mechanical relay delivers the recognised bytes verbatim.
          expect(byteEqual(recognised, recognised), entry.id).toBe(true);
        }
        expect(byteEqual('Hold phase three.', 'Hold phase three')).toBe(false);
        expect(byteEqual('Hold phase three.', 'Hold  phase three.')).toBe(false);
      }),
      check('recognised-to-delivered-bytes-through-the-real-relay-store', () => {
        // A clean instruction (nothing for the semi-verbatim normaliser to
        // remove) must reach the delivery store byte-for-byte identical.
        const recognised = 'Hold phase three until my review.';
        const store = new PendingProposalStore();
        store.appendToDraft(1, recognised, 1);
        const taken = store.takeForRelease(1);
        expect(taken?.text).toBe(recognised);
      }),
      check('verbatim-control-recalls-every-required-word-at-length-ratio-1', () => {
        const verbatimAggregate = aggregateFidelity(verbatim);
        expect(verbatimAggregate.recall).toBe(1);
        expect(verbatimAggregate.lengthRatio).toBe(1);
      }),
      check('file-path-retention-is-measurable-even-though-the-corpus-has-none', () => {
        expect(corpus.items.flatMap((entry) => filePathsIn(entry.utterance))).toEqual([]);
        expect(corpus.observedGaps?.some((gap) => gap.includes('file'))).toBe(true);
        expect(criticalTokenRetention(syntheticPathItem, syntheticPathItem.utterance).filePaths.ratio).toBe(1);
        const pathDropped = criticalTokenRetention(
          syntheticPathItem,
          syntheticPathItem.utterance.replace('src/talker/talker.ts', 'the other file')
        );
        expect(pathDropped.filePaths.ratio).toBeLessThan(1);
      }),
      check('the-wer-metric-detects-a-dropped-negation', () => {
        const entry = corpus.items.find((item) => item.negations.length > 0);
        expect(entry, 'corpus must declare at least one negation').toBeTruthy();
        const damaged = (entry?.recognisedText as string).replace(/\bnot\b/i, '');
        expect(wordErrorRate(entry?.utterance as string, damaged)).toBeGreaterThan(0);
        const scored = scoreFidelityItem(entry as FidelityItem, damaged, entry?.recognisedText);
        expect(scored.negations.ratio).toBeLessThan(1);
      }),
      check('wordErrorRate-is-a-working-metric', () => {
        expect(wordErrorRate('alpha beta gamma', 'alpha beta gamma')).toBe(0);
        expect(wordErrorRate('alpha beta gamma', 'alpha beta')).toBeCloseTo(1 / 3, 10);
        expect(wordErrorRate('alpha beta gamma', '')).toBe(1);
        expect(recognitionWords("Don't stop, okay?")).toEqual(['dont', 'stop', 'okay']);
      }),
    ];

    expect(checks.length).toBeGreaterThanOrEqual(10);
    const report = runRegressionChecks('gate6-fidelity-corpus', checks);
    expect(report.executed).toBe(checks.length);
    assertRegressionPass(report);
  });
});