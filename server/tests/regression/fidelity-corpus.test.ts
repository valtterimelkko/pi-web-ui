/**
 * Fidelity corpus + regression harness skeleton (Voice Mode execution plan,
 * Phase 6; architecture recommendation 2026-09 §7.1.3).
 *
 * Wave 0 scope: load the migrated frozen corpus, assert its shape and its
 * provenance, and execute one worked scoring example through the harness. The
 * kernel-dependent veto suites (proposal SHA binding, idempotency, disconnect
 * safety, lane isolation) are deliberately **not** here — they need the merged
 * host kernel and belong to a later child. Nothing in this file skips: the
 * corpus is a committed fixture, so a missing or damaged fixture is a failure.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FIXTURE_PATH,
  FIDELITY_CORPUS_SCHEMA,
  aggregateFidelity,
  byteEqual,
  composeCandidateText,
  contentTokens,
  criticalTokenRetention,
  filePathsIn,
  loadFidelityCorpus,
  scoreFidelityItem,
  validateFidelityCorpus,
  type FidelityItem,
} from './harness/corpus.js';
import { assertRegressionPass, runRegressionChecks } from './harness/run.js';

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