/**
 * Tier 2 fidelity corpus (L7; intent §20.5b–d) — schema, content and scoring.
 *
 * The corpus is the phase's primary measurement: 20 frozen spoken instructions,
 * each declaring the words that must survive (`requiredWords`), the negative
 * constraints (`negations`), the conditional constraints (`conditionals`), the
 * thing the instruction is about (`targets`) and the preamble the composer
 * should drop (`distractors`). These tests pin four things:
 *
 *   1. The frozen corpus is exactly what §20.5b asks for, and the validator
 *      REFUSES a damaged corpus (a corpus that silently mis-scores is worse
 *      than no corpus).
 *   2. The scoring rules are mechanical and honest: recall, qualifier survival,
 *      target survival, distractor leakage, length ratio.
 *   3. The corpus smoke test: the tier 1 mechanical relay (verbatim bytes)
 *      scores recall 1.0 — the corpus is measureable — while the hermetic
 *      composer drops every distractor, which is the property tier 2 exists to
 *      test.
 *   4. The runnable scenario and the corpus data cannot drift.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FIDELITY_CORPUS_SCHEMA,
  aggregateFidelity,
  composeCandidateText,
  contentTokens,
  cueWordsIn,
  loadFidelityCorpusFile,
  scoreFidelityItem,
  validateFidelityCorpus,
  type FidelityCorpus,
  type FidelityItem,
} from '../../../scripts/voice-live-lab/lib/harness/tier2-lean.js';

const BENCH_ROOT = '/root/agent-benchmarks/benchmarks/04-voice-live-lab';
const CORPUS_PATH = path.join(BENCH_ROOT, 'scenarios', 'tier2', 'fidelity-corpus.json');
const CORPUS_SCENARIO_PATH = path.join(BENCH_ROOT, 'scenarios', 'tier2', 't2-fidelity-corpus.json');
const corpusExists = existsSync(CORPUS_PATH);

function corpus(): FidelityCorpus {
  return loadFidelityCorpusFile(CORPUS_PATH);
}

/** A minimal valid item, spread-overridable per test. Every class is present
 *  and every phrase really is in the utterance, so the fixture satisfies the
 *  corpus-level substance gates too. */
function item(overrides: Partial<FidelityItem> = {}): FidelityItem {
  return {
    id: 'fc-01',
    utterance:
      'Tell the worker to add a changelog entry for the parser fix and not touch the auth routes, and I have lost my train of thought, only after the tests pass.',
    requiredWords: ['changelog', 'parser fix', 'auth routes'],
    negations: ['not touch the auth routes'],
    conditionals: ['only after the tests pass'],
    targets: ['the auth routes'],
    distractors: ['I have lost my train of thought'],
    ...overrides,
  };
}

function corpusWith(items: FidelityItem[], overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: FIDELITY_CORPUS_SCHEMA,
    id: 'test-corpus',
    version: '0.0.0-test',
    items,
    ...overrides,
  };
}

// ── 1. The frozen corpus (§20.5b) ───────────────────────────────────────────

describe.skipIf(!corpusExists)('the frozen fidelity corpus', () => {
  it('is a valid voice-lab.fidelity-corpus/1 document', () => {
    const loaded = corpus();
    expect(loaded.schema).toBe(FIDELITY_CORPUS_SCHEMA);
    expect(loaded.version).toContain('frozen');
    const outcome = validateFidelityCorpus(loaded);
    expect(outcome.problems).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it('has exactly 20 items, fc-01 … fc-20, all unique', () => {
    const loaded = corpus();
    expect(loaded.items).toHaveLength(20);
    expect(loaded.items.map((entry) => entry.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `fc-${String(index + 1).padStart(2, '0')}`)
    );
  });

  it('every item declares all five classes, and every class is populated corpus-wide', () => {
    const items = corpus().items;
    for (const entry of items) {
      for (const field of ['requiredWords', 'negations', 'conditionals', 'targets', 'distractors'] as const) {
        expect(Array.isArray(entry[field]), `${entry.id}.${field}`).toBe(true);
        for (const value of entry[field]) expect(typeof value).toBe('string');
      }
      // requiredWords, targets and distractors are never empty; an instruction
      // that constrains nothing would declare neither a negation nor a
      // conditional, so at least one of those is present too.
      expect(entry.requiredWords.length, entry.id).toBeGreaterThan(0);
      expect(entry.targets.length, entry.id).toBeGreaterThan(0);
      expect(entry.distractors.length, entry.id).toBeGreaterThan(0);
      expect(entry.negations.length + entry.conditionals.length, entry.id).toBeGreaterThan(0);
    }
    const total = (field: 'requiredWords' | 'negations' | 'conditionals' | 'targets' | 'distractors') =>
      items.reduce((sum, entry) => sum + entry[field].length, 0);
    expect(total('requiredWords')).toBeGreaterThanOrEqual(50);
    expect(total('negations')).toBeGreaterThanOrEqual(8);
    expect(total('conditionals')).toBeGreaterThanOrEqual(8);
    expect(total('targets')).toBeGreaterThanOrEqual(20);
    expect(total('distractors')).toBeGreaterThanOrEqual(20);
  });

  it('utters every instruction as speech, not as a written brief', () => {
    for (const entry of corpus().items) {
      expect(entry.utterance.split(/\s+/).length, entry.id).toBeGreaterThanOrEqual(8);
      expect(entry.utterance, entry.id).not.toMatch(/```|^- |\*\*/m);
    }
  });

  it('declares every required word and target inside the utterance it scores', () => {
    for (const entry of corpus().items) {
      const utteranceTokens = new Set(contentTokens(entry.utterance));
      for (const word of entry.requiredWords) {
        const tokens = contentTokens(word);
        expect(tokens.length, `${entry.id}:${word}`).toBeGreaterThan(0);
        for (const token of tokens) {
          expect(utteranceTokens.has(token), `${entry.id}: required "${word}" → ${token}`).toBe(true);
        }
      }
      for (const target of entry.targets) {
        for (const token of contentTokens(target)) {
          expect(utteranceTokens.has(token), `${entry.id}: target "${target}" → ${token}`).toBe(true);
        }
      }
    }
  });

  it('every negation and conditional carries a real qualifier to lose', () => {
    for (const entry of corpus().items) {
      for (const phrase of entry.negations) {
        expect(phrase.toLowerCase(), `${entry.id}: ${phrase}`).toMatch(
          /\b(not|never|no|without|avoid|alone|untouched|don'?t|doesn'?t|mustn'?t|shouldn'?t|isn'?t)\b/
        );
      }
      for (const phrase of entry.conditionals) {
        expect(phrase.toLowerCase(), `${entry.id}: ${phrase}`).toMatch(
          /\b(if|only|after|once|before|when|unless|provided|until|wait)\b/
        );
      }
    }
  });
});

// ── 2. The validator refuses a damaged corpus ───────────────────────────────

describe('fidelity corpus validation', () => {
  it('refuses the wrong schema, the wrong item count and a duplicate id', () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      item({ id: `fc-${String(index + 1).padStart(2, '0')}` })
    );
    expect(validateFidelityCorpus(corpusWith(items)).ok).toBe(true);

    const wrongSchema = validateFidelityCorpus(corpusWith(items, { schema: 'voice-lab.nope/1' }));
    expect(wrongSchema.problems.join(' ')).toContain('schema must be');

    const nineteen = validateFidelityCorpus(corpusWith(items.slice(0, 19)));
    expect(nineteen.problems.join(' ')).toContain('20 instruction utterances');

    const duplicate = validateFidelityCorpus(corpusWith([...items.slice(0, 19), item({ id: 'fc-01' })]));
    expect(duplicate.problems.join(' ')).toContain('duplicate id fc-01');
  });

  it('refuses a missing or empty field, an unknown key and an unscored required word', () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      item({ id: `fc-${String(index + 1).padStart(2, '0')}` })
    );

    const empty = [...items];
    empty[0] = { ...empty[0], requiredWords: [] };
    expect(validateFidelityCorpus(corpusWith(empty)).problems.join(' ')).toContain(
      'requiredWords must declare at least one entry'
    );

    const unknownKey = [...items];
    unknownKey[0] = { ...unknownKey[0], somethingElse: true } as unknown as FidelityItem;
    expect(validateFidelityCorpus(corpusWith(unknownKey)).problems.join(' ')).toContain('unknown key "somethingElse"');

    const notInUtterance = [...items];
    notInUtterance[0] = { ...notInUtterance[0], requiredWords: ['quantum-encabulator'] };
    expect(validateFidelityCorpus(corpusWith(notInUtterance)).problems.join(' ')).toContain(
      'does not appear in the utterance'
    );

    const unqualifier = [...items];
    unqualifier[0] = { ...unqualifier[0], negations: ['touch the auth routes'] };
    expect(validateFidelityCorpus(corpusWith(unqualifier)).problems.join(' ')).toContain(
      'no negative qualifier to lose'
    );

    const weakDistractor = [...items];
    weakDistractor[0] = { ...weakDistractor[0], distractors: ['um'] };
    expect(validateFidelityCorpus(corpusWith(weakDistractor)).problems.join(' ')).toContain(
      'at least 3 distinctive words'
    );
  });

  it('refuses a corpus that declares almost nothing between its items', () => {
    const thin = Array.from({ length: 20 }, (_, index) =>
      item({
        id: `fc-${String(index + 1).padStart(2, '0')}`,
        requiredWords: ['changelog'],
        negations: ['do not touch the auth routes'],
        conditionals: [],
      })
    );
    const problems = validateFidelityCorpus(corpusWith(thin)).problems.join(' ');
    expect(problems).toContain('conditionals');
  });

  it('loadFidelityCorpusFile names the problems instead of throwing a parse error', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fidelity-corpus-'));
    try {
      const file = path.join(dir, 'bad.json');
      writeFileSync(file, JSON.stringify(corpusWith([item()])), 'utf8');
      expect(() => loadFidelityCorpusFile(file)).toThrow(/invalid fidelity corpus/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 3. The scoring rules (§20.5b) ───────────────────────────────────────────

describe('fidelity scoring', () => {
  it('scores required-word recall and names what was dropped', () => {
    const base = item({ requiredWords: ['changelog', 'parser fix'] });
    const full = scoreFidelityItem(base, 'Add a changelog entry for the parser fix. Do not touch the auth routes.');
    expect(full.recall).toBe(1);
    expect(full.missingRequired).toEqual([]);

    const dropped = scoreFidelityItem(base, 'Add a changelog entry. Do not touch the auth routes.');
    expect(dropped.recall).toBe(0.5);
    expect(dropped.missingRequired).toEqual(['parser fix']);
  });

  it('scores a multi-word required term as a phrase, not as a bag of words', () => {
    const base = item({ requiredWords: ['phase three'] });
    expect(scoreFidelityItem(base, 'Hold phase 3 for review.').recall).toBe(0);
    expect(scoreFidelityItem(base, 'Hold phase three until review.').recall).toBe(1);
  });

  it('detects a dropped negation, including one whose nouns survive but whose "not" did not', () => {
    const base = item({ negations: ['do not touch the auth routes'] });
    const survived = scoreFidelityItem(base, 'Add the changelog. Do not touch the auth routes.');
    expect(survived.negations.ratio).toBe(1);
    expect(survived.negations.dropped).toEqual([]);

    const qualifierDropped = scoreFidelityItem(base, 'Add the changelog. Do touch the auth routes.');
    expect(qualifierDropped.negations.ratio).toBe(0);
    expect(qualifierDropped.negations.dropped).toEqual(['do not touch the auth routes']);

    const constraintDropped = scoreFidelityItem(base, 'Add the changelog. Do not touch anything else.');
    expect(constraintDropped.negations.ratio).toBe(0);
  });

  it('detects a dropped conditional qualifier ("only"/"if")', () => {
    const base = item({ conditionals: ['only if the tests pass'] });
    expect(scoreFidelityItem(base, 'Push, only if the tests pass.').conditionals.ratio).toBe(1);
    const weakened = scoreFidelityItem(base, 'Push, if the tests pass.');
    expect(weakened.conditionals.ratio).toBe(0);
    expect(weakened.conditionals.dropped).toEqual(['only if the tests pass']);
  });

  it('scores target survival and distractor leakage', () => {
    const base = item({
      targets: ['the auth routes', 'the migration'],
      distractors: ['I have completely lost my train of thought'],
    });
    const clean = scoreFidelityItem(base, 'Add a changelog entry for the parser fix. Do not touch the auth routes.');
    expect(clean.targets.ratio).toBe(0.5);
    expect(clean.targets.dropped).toEqual(['the migration']);
    expect(clean.distractorLeakage).toBe(0);
    expect(clean.leakedDistractors).toEqual([]);

    const leaked = scoreFidelityItem(
      base,
      'I have completely lost my train of thought. Add a changelog entry. Do not touch the auth routes and the migration.'
    );
    expect(leaked.targets.ratio).toBe(1);
    expect(leaked.distractorLeakage).toBe(1);
    expect(leaked.leakedDistractors).toEqual(['I have completely lost my train of thought']);
  });

  it('reports the length ratio and the unexplained additions a judge would have to review', () => {
    const base = item();
    const score = scoreFidelityItem(
      base,
      'Please also update the deployment configuration and rotate the credentials before you leave, and check the proxy timeout too, while adding a changelog entry for the parser fix and not touching the auth routes.'
    );
    expect(score.sentWords).toBeGreaterThan(score.operatorWords);
    expect(score.lengthRatio).toBeGreaterThan(1);
    expect(score.unexplainedAdditions).toEqual(
      expect.arrayContaining(['deployment', 'configuration', 'credentials', 'rotate', 'proxy', 'timeout'])
    );
  });

  it('aggregates per-item scores into the run-level fidelity metrics', () => {
    const items = corpusExists
      ? corpus().items
      : [
          item({ id: 'fc-01' }),
          item({ id: 'fc-02', utterance: 'Hold phase three until my review, and only un-gate it after the tests pass.', requiredWords: ['phase three'], negations: [], conditionals: ['only un-gate it after the tests pass'], targets: ['phase three'], distractors: ['Hold on, I lost my thread there'] }),
        ];
    const perfect = items.map((entry) => scoreFidelityItem(entry, composeCandidateText(entry), entry.utterance));
    const aggregate = aggregateFidelity(perfect);
    expect(aggregate.items).toBe(items.length);
    expect(aggregate.recall).toBe(1);
    expect(aggregate.negationSurvival).toBe(1);
    expect(aggregate.conditionalSurvival).toBe(1);
    expect(aggregate.targetSurvival).toBe(1);
    expect(aggregate.distractorLeakage).toBe(0);
    expect(aggregate.requiredWordsTotal).toBeGreaterThan(0);
  });

  it('cueWordsIn exposes the phrase\u2019s own qualifiers (the strict survival rule)', () => {
    expect(new Set(cueWordsIn('only after the tests pass', /\b(if|only|after|once|before|when|unless|provided|until|wait)\b/gi))).toEqual(
      new Set(['only', 'after'])
    );
    expect(cueWordsIn('do not touch the auth routes', /\b(not|never|no|without|avoid|alone|untouched|don'?t)\b/gi)).toEqual(['not']);
  });
});

// ── 4. The smoke test (§20.5b): tier 1's mechanical relay vs the composer ───

describe.skipIf(!corpusExists)('corpus smoke test', () => {
  it('tier 1 control: a verbatim mechanical relay scores recall 1.0 across all 20 items', () => {
    const scores = corpus().items.map((entry) => scoreFidelityItem(entry, entry.utterance, entry.utterance));
    const aggregate = aggregateFidelity(scores);
    expect(aggregate.items).toBe(20);
    expect(aggregate.recall).toBe(1);
    expect(aggregate.requiredWordsRecalled).toBe(aggregate.requiredWordsTotal);
    expect(aggregate.negationSurvival).toBe(1);
    expect(aggregate.conditionalSurvival).toBe(1);
    expect(aggregate.targetSurvival).toBe(1);
    // A verbatim relay keeps the operator's preamble too: that is the tier-1
    // ceiling on content and the floor on composedness, and it is exactly what
    // tier 2's composer is supposed to change.
    expect(aggregate.distractorLeakage).toBe(1);
    expect(aggregate.lengthRatio).toBe(1);
  });

  it('the hermetic composer keeps every constraint and drops every distractor', () => {
    const scores = corpus().items.map((entry) => {
      const composed = composeCandidateText(entry);
      const score = scoreFidelityItem(entry, composed, entry.utterance);
      expect(score.missingRequired, entry.id).toEqual([]);
      expect(score.negations.dropped, entry.id).toEqual([]);
      expect(score.conditionals.dropped, entry.id).toEqual([]);
      expect(score.targets.dropped, entry.id).toEqual([]);
      expect(score.leakedDistractors, entry.id).toEqual([]);
      return score;
    });
    const aggregate = aggregateFidelity(scores);
    expect(aggregate.recall).toBe(1);
    expect(aggregate.distractorLeakage).toBe(0);
    // The composer is shorter than the operator: hesitation costs words.
    expect(aggregate.lengthRatio).toBeLessThan(1);
  });

  it('the corpus discriminates: dropping one negation flips its class survival for that item only', () => {
    const withNegations = corpus().items.filter((entry) => entry.negations.length > 0);
    expect(withNegations.length).toBeGreaterThanOrEqual(8);
    const target = withNegations[0];
    const composed = composeCandidateText(target);
    const damaged = composed.replace(/\b(not|never|no)\b/i, '');
    const score = scoreFidelityItem(target, damaged, target.utterance);
    expect(score.negations.ratio).toBe(0);
    expect(score.recall).toBe(1);
  });
});

// ── 5. The runnable scenario cannot drift from the corpus ───────────────────

describe.skipIf(!corpusExists)('corpus scenario parity', () => {
  it('t2-fidelity-corpus.json is one beat per item, in corpus order, byte-identical utterances', () => {
    const loaded = corpus();
    const scenario = JSON.parse(readFileSync(CORPUS_SCENARIO_PATH, 'utf8'));
    expect(scenario.tier).toBe(2);
    expect(scenario.world).toBe(loaded.world);
    expect(scenario.beats).toHaveLength(loaded.items.length);
    loaded.items.forEach((entry, index) => {
      const beat = scenario.beats[index];
      expect(beat.id, entry.id).toBe(entry.id);
      expect(beat.mode, entry.id).toBe('frozen');
      expect(beat.utterance, entry.id).toBe(entry.utterance);
      expect(beat.labels.corpusId, entry.id).toBe(entry.id);
      expect(beat.trigger.at ?? beat.trigger.after, entry.id).toBeTruthy();
    });
  });

  it('links every item to a send-plan entry in all three conditions', () => {
    const loaded = corpus();
    const scenario = JSON.parse(readFileSync(CORPUS_SCENARIO_PATH, 'utf8'));
    expect(scenario.tier2.fidelityCorpus).toBe('scenarios/tier2/fidelity-corpus.json');
    expect(scenario.tier2.sendPlan).toHaveLength(loaded.items.length);
    const ids = new Set(scenario.beats.map((beat: { id: string }) => beat.id));
    for (const entry of scenario.tier2.sendPlan) {
      expect(ids.has(entry.modelSendAt), entry.id).toBe(true);
      expect(entry.fidelityCorpusId).toMatch(/^fc-\d{2}$/);
      // free and fixed-text deliver the model's composition; confirm-guided
      // holds it behind the operator's confirmation, so no delivery window is
      // asserted there (fidelity is still measured on what the model composed).
      expect(entry.deliveredAt.free).toBe(entry.modelSendAt);
      expect(entry.deliveredAt['fixed-text']).toBe(entry.modelSendAt);
      expect(entry.deliveredAt['confirm-guided']).toBeNull();
    }
    expect(new Set(scenario.tier2.sendPlan.map((entry: { fidelityCorpusId: string }) => entry.fidelityCorpusId)).size).toBe(
      loaded.items.length
    );
  });
});
