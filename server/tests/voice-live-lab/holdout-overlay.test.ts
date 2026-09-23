/**
 * Holdout validator overlays (Wave-4 conductor scope).
 *
 * The committed holdout episode files carry family requirements but EMPTY
 * surface forms (validator-frozen). The overlay mechanism lets the separate
 * validator's frozen wording/expected facts merge onto a holdout episode at
 * load time, so holdout cells can plan and run without ever putting wording in
 * the corpus files:
 *
 *   - `withValidatorOverlays(corpus, corpusDir)` merges every holdout
 *     episode's overlay from `corpus/holdout/<ID>.validator.json`;
 *   - fail closed: a missing OR malformed overlay is an error, never a
 *     silent pass-through of empty wording;
 *   - the merged episode is drivable (journeyPlan plans it); the RAW corpus
 *     holdout still refuses;
 *   - the corpus episode files themselves stay empty — always.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CorpusError,
  EpisodeSchema,
  HOLDOUT_IDS,
  loadCorpus,
  loadCorpusFromDir,
  withValidatorOverlays,
  type LoadedCorpus,
} from '../../../scripts/voice-lane-lab/lib/corpus.js';
import { journeyPlan } from '../../../scripts/voice-lane-lab/lib/journey-plan.js';

const repoCorpusDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'scripts/voice-lane-lab/corpus'
);

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A synthetic corpus dir: the real 24 episodes + index, plus optional test-owned overlay and voices. */
function buildSyntheticCorpus(options: { overlay?: object | null; overlayJson?: string; fixtureText?: string }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'voice-lab-overlay-'));
  cleanup.push(dir);
  const episodesDir = path.join(dir, 'episodes');
  mkdirSync(episodesDir, { recursive: true });
  for (const name of loadCorpus().episodes.map((e) => `${e.id}.json`)) {
    writeFileSync(path.join(episodesDir, name), readFileSync(path.join(repoCorpusDir, 'episodes', name)));
  }
  writeFileSync(path.join(dir, 'index.json'), readFileSync(path.join(repoCorpusDir, 'index.json')));
  if (options.overlayJson !== undefined) {
    mkdirSync(path.join(dir, 'holdout'), { recursive: true });
    writeFileSync(path.join(dir, 'holdout', 'C10.validator.json'), options.overlayJson);
  } else if (options.overlay !== undefined && options.overlay !== null) {
    mkdirSync(path.join(dir, 'holdout'), { recursive: true });
    writeFileSync(path.join(dir, 'holdout', 'C10.validator.json'), JSON.stringify(options.overlay, null, 2));
  }
  if (options.fixtureText !== undefined) {
    const voicesDir = path.join(dir, 'voices');
    mkdirSync(voicesDir, { recursive: true });
    const manifest = {
      profileId: 'voice-a',
      speechLabel: 'synthetic speech based on real wording',
      fixtures: [
        {
          id: 'C10-t1',
          text: options.fixtureText,
          pcm16kSha256: 'b'.repeat(64),
          pcm16kPath: `/root/voice-lane-lab/fixtures/voice-a/C10-t1.pcm16k`,
          masterWavPath: `/root/voice-lane-lab/fixtures/voice-a/C10-t1.master.wav`,
          durationMs: 2_000,
          asr: { transcript: 'fixture words', wer: 0.02, missingWords: [], ok: true },
        },
      ],
    };
    writeFileSync(path.join(voicesDir, 'voice-a.manifest.json'), JSON.stringify(manifest, null, 2));
  }
  return dir;
}

const C10_TEXT = 'The session token keeps getting dropped on the third retry — I want to understand why before we change anything.';

const VALID_OVERLAY = {
  schemaVersion: 1,
  id: 'C10',
  validatorFrozenAtIso: '2026-09-23T00:00:00Z',
  note: 'test overlay — frozen by the validator harness fixture',
  inputTurns: [
    {
      id: 't1',
      kind: 'opening',
      text: C10_TEXT,
      requiredWords: ['session', 'token', 'third', 'retry'],
    },
  ],
  expectedSlots: {
    mustContain: [],
    mustNotContain: [],
    responseMustContain: ['token'],
    responseMustNotContain: ['relay to worker', 'sent to the worker'],
  },
  approvalTurns: [],
  repairBranches: [],
};

/** Minimal valid overlays for the remaining holdouts so the fail-closed merge passes them. */
function minimalOverlay(id: string, turns: Array<{ id: string; kind: string }>): object {
  return {
    schemaVersion: 1,
    id,
    validatorFrozenAtIso: '2026-09-23T00:00:00Z',
    note: `test overlay for ${id}`,
    inputTurns: turns.map((turn) => ({ ...turn, text: `frozen ${id} ${turn.kind} wording`, requiredWords: [] })),
    expectedSlots: { mustContain: [], mustNotContain: [], responseMustContain: [], responseMustNotContain: [] },
    approvalTurns: [],
    repairBranches: [],
  };
}

describe('holdout validator overlays', () => {
  it('an overlay-present holdout episode merges and PLANS (drivable)', () => {
    const corpusDir = buildSyntheticCorpus({ overlay: VALID_OVERLAY, fixtureText: C10_TEXT });
    // the other holdouts need their overlays too (fail closed without them)
    mkdirSync(path.join(corpusDir, 'holdout'), { recursive: true });
    writeFileSync(path.join(corpusDir, 'holdout', 'C11.validator.json'), JSON.stringify(minimalOverlay('C11', [{ id: 't1', kind: 'opening' }])));
    writeFileSync(path.join(corpusDir, 'holdout', 'C22.validator.json'), JSON.stringify(minimalOverlay('C22', [{ id: 't1', kind: 'opening' }, { id: 't2', kind: 'adaptive-confirm' }])));
    writeFileSync(path.join(corpusDir, 'holdout', 'C24.validator.json'), JSON.stringify(minimalOverlay('C24', [{ id: 't1', kind: 'opening' }])));
    const raw = loadCorpusFromDir(corpusDir);
    const merged: LoadedCorpus = withValidatorOverlays(raw, corpusDir);

    const c10 = merged.episodes.find((episode) => episode.id === 'C10');
    expect(c10).toBeDefined();
    expect(c10?.holdout).toBe(false); // drivable once the validator's wording exists
    expect(c10?.inputTurns[0]?.text).toBe(C10_TEXT);
    expect(c10?.inputTurns[0]?.requiredWords).toEqual(['session', 'token', 'third', 'retry']);
    expect(c10?.expectedSlots.responseMustContain).toEqual(['token']);
    // other episodes pass through untouched
    expect(merged.episodes.find((episode) => episode.id === 'C01')?.inputTurns[0]?.text).toContain('Podpoint');

    // and the merged episode PLANS: no holdout refusal, turn mapped to the fixture
    const plan = journeyPlan('C10', { corpus: merged, corpusDir, arm: 'standard' });
    expect(plan.episodeId).toBe('C10');
    expect(plan.turns.map((turn) => turn.fixtureId)).toEqual(['C10-t1']);
  });

  it('an overlay-absent holdout episode fails closed (merge refuses; raw corpus still refuses to plan)', () => {
    const corpusDir = buildSyntheticCorpus({});
    const raw = loadCorpusFromDir(corpusDir);
    expect(() => withValidatorOverlays(raw, corpusDir)).toThrow(CorpusError);
    expect(() => withValidatorOverlays(raw, corpusDir)).toThrow(/C10/);

    // the raw holdout refusal is unchanged
    expect(() => journeyPlan('C10', { corpus: raw, corpusDir, arm: 'standard' })).toThrow(
      /holdout wording is frozen by the separate validator/
    );
  });

  it('a malformed overlay fails closed: invalid JSON', () => {
    const corpusDir = buildSyntheticCorpus({ overlayJson: '{not json' });
    const raw = loadCorpusFromDir(corpusDir);
    expect(() => withValidatorOverlays(raw, corpusDir)).toThrow(CorpusError);
  });

  it('a malformed overlay fails closed: schema violation (missing expectedSlots)', () => {
    const corpusDir = buildSyntheticCorpus({
      overlay: { ...VALID_OVERLAY, expectedSlots: undefined },
      fixtureText: C10_TEXT,
    });
    const raw = loadCorpusFromDir(corpusDir);
    expect(() => withValidatorOverlays(raw, corpusDir)).toThrow(CorpusError);
  });

  it('a malformed overlay fails closed: approval references a turn the overlay does not declare', () => {
    const corpusDir = buildSyntheticCorpus({
      overlay: {
        ...VALID_OVERLAY,
        approvalTurns: [{ turnId: 't9', precondition: 'candidate-matched+presentation-complete' }],
      },
      fixtureText: C10_TEXT,
    });
    const raw = loadCorpusFromDir(corpusDir);
    expect(() => withValidatorOverlays(raw, corpusDir)).toThrow(CorpusError);
  });

  it('the overlay OWNS the frozen structure: it may restructure turns (the conductor C11 shape)', () => {
    // base C11 is [t1 opening, t2 adaptive-repair]; the validator freezes a
    // different structure: amend + a NEW confirm turn. The merge must accept
    // it (fail-closed revalidation still applies).
    const corpusDir = buildSyntheticCorpus({});
    mkdirSync(path.join(corpusDir, 'holdout'), { recursive: true });
    writeFileSync(path.join(corpusDir, 'holdout', 'C10.validator.json'), JSON.stringify(VALID_OVERLAY));
    writeFileSync(
      path.join(corpusDir, 'holdout', 'C11.validator.json'),
      JSON.stringify(minimalOverlay('C11', [{ id: 't1', kind: 'opening' }]))
        .replace('"kind": "opening"', '"kind": "opening"')
    );
    // rewrite C11's overlay with the conductor's real shape
    const c11 = {
      schemaVersion: 1,
      id: 'C11',
      validatorFrozenAtIso: '2026-09-23T00:00:00Z',
      note: 'conductor C11 shape',
      inputTurns: [
        { id: 't1', kind: 'opening', text: 'Relay to worker, change the retry backoff to exponential.', requiredWords: ['relay', 'worker'] },
        { id: 't2', kind: 'adaptive-amend', text: 'Actually no — exponential backoff with jitter.', requiredWords: ['jitter'] },
        { id: 't3', kind: 'adaptive-confirm', text: 'Yes, send it.', requiredWords: ['yes'] },
      ],
      expectedSlots: { mustContain: ['backoff', 'jitter'], mustNotContain: [], responseMustContain: [], responseMustNotContain: [] },
      approvalTurns: [{ turnId: 't3', precondition: 'candidate-matched+presentation-complete' }],
      repairBranches: [],
    };
    writeFileSync(path.join(corpusDir, 'holdout', 'C11.validator.json'), JSON.stringify(c11));
    writeFileSync(path.join(corpusDir, 'holdout', 'C22.validator.json'), JSON.stringify(minimalOverlay('C22', [{ id: 't1', kind: 'opening' }, { id: 't2', kind: 'adaptive-confirm' }])));
    writeFileSync(path.join(corpusDir, 'holdout', 'C24.validator.json'), JSON.stringify(minimalOverlay('C24', [{ id: 't1', kind: 'opening' }])));
    const raw = loadCorpusFromDir(corpusDir);
    const merged = withValidatorOverlays(raw, corpusDir);
    const c11merged = merged.episodes.find((episode) => episode.id === 'C11');
    expect(c11merged?.holdout).toBe(false);
    expect(c11merged?.inputTurns.map((turn) => turn.kind)).toEqual(['opening', 'adaptive-amend', 'adaptive-confirm']);
    expect(c11merged?.approvalTurns).toEqual([{ turnId: 't3', precondition: 'candidate-matched+presentation-complete' }]);
  });

  it('a malformed overlay fails closed: id mismatch', () => {
    const corpusDir = buildSyntheticCorpus({ overlay: { ...VALID_OVERLAY, id: 'C11' } });
    const raw = loadCorpusFromDir(corpusDir);
    expect(() => withValidatorOverlays(raw, corpusDir)).toThrow(CorpusError);
  });

  it('a malformed overlay fails closed: unknown top-level field (strict shape)', () => {
    const corpusDir = buildSyntheticCorpus({ overlay: { ...VALID_OVERLAY, extra: true } });
    const raw = loadCorpusFromDir(corpusDir);
    expect(() => withValidatorOverlays(raw, corpusDir)).toThrow(CorpusError);
  });

  it('an overlay naming a NON-holdout episode fails closed', () => {
    const corpusDir = buildSyntheticCorpus({});
    mkdirSync(path.join(corpusDir, 'holdout'), { recursive: true });
    writeFileSync(
      path.join(corpusDir, 'holdout', 'C01.validator.json'),
      JSON.stringify({ ...VALID_OVERLAY, id: 'C01' }, null, 2)
    );
    const raw = loadCorpusFromDir(corpusDir);
    expect(() => withValidatorOverlays(raw, corpusDir)).toThrow(CorpusError);
  });

  it('the committed corpus episode files stay empty (schema rule untouched; merge never writes)', () => {
    const corpus = loadCorpus();
    for (const id of HOLDOUT_IDS) {
      const episode = corpus.episodes.find((candidate) => candidate.id === id);
      expect(episode, id).toBeDefined();
      for (const turn of episode!.inputTurns) {
        expect(turn.text, `${id}/${turn.id}`).toBe('');
        expect(turn.validatorFrozen, `${id}/${turn.id}`).toBe(true);
      }
    }
    // the disk files say the same thing
    for (const id of HOLDOUT_IDS) {
      const raw = JSON.parse(readFileSync(path.join(repoCorpusDir, 'episodes', `${id}.json`), 'utf8')) as {
        inputTurns: Array<{ text: string; validatorFrozen: boolean }>;
      };
      for (const turn of raw.inputTurns) {
        expect(turn.text, `${id} on disk`).toBe('');
        expect(turn.validatorFrozen, `${id} on disk`).toBe(true);
      }
    }
  });

  it('the episode schema still refuses real wording in a holdout:true episode (no silent loosening)', () => {
    const corpusDir = buildSyntheticCorpus({ overlay: VALID_OVERLAY, fixtureText: C10_TEXT });
    const raw = loadCorpusFromDir(corpusDir);
    const c10 = raw.episodes.find((episode) => episode.id === 'C10');
    expect(c10).toBeDefined();
    const corrupted = { ...c10!, holdout: true, inputTurns: [{ ...c10!.inputTurns[0], text: C10_TEXT }] };
    expect(EpisodeSchema.safeParse(corrupted).success).toBe(false);
  });
});
