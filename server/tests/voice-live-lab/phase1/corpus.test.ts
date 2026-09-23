/**
 * The Phase 1 corpus contract (native-primary plan §5.1–§5.2).
 *
 * The corpus is the campaign's spine: exactly the 24 catalogue IDs, one
 * schema-versioned file each, holdout surface forms EMPTY (frozen later by a
 * separate validator), and every episode carrying the fields the deterministic
 * director and the offline verifier consume. These tests are data tests on the
 * committed corpus: if the corpus drifts from the plan, they fail.
 */
import { describe, expect, it } from 'vitest';
import {
  CORPUS_SCHEMA_VERSION,
  HOLDOUT_IDS,
  P_TIER_DEV_SET,
  loadCorpus,
  corpusHash,
  episodeById,
} from '../../../../scripts/voice-lane-lab/lib/corpus.js';

const corpus = loadCorpus(); // resolves scripts/voice-lane-lab/corpus relative to the lib

describe('corpus shape', () => {
  it('loads exactly the 24 catalogue IDs, unique, schema-version 1', () => {
    expect(corpus.schemaVersion).toBe(CORPUS_SCHEMA_VERSION);
    expect(corpus.episodes).toHaveLength(24);
    const ids = corpus.episodes.map((episode) => episode.id);
    expect(new Set(ids).size).toBe(24);
    expect(ids.sort()).toEqual(
      Array.from({ length: 24 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`).sort()
    );
  });

  it('carries the frozen tier split: 12 P, 4 H, 8 E', () => {
    const tiers = corpus.episodes.map((episode) => episode.tier);
    expect(tiers.filter((tier) => tier === 'P')).toHaveLength(12);
    expect(tiers.filter((tier) => tier === 'H')).toHaveLength(4);
    expect(tiers.filter((tier) => tier === 'E')).toHaveLength(8);
  });

  it('fixes the P-tier dev set to the plan §5.2 twelve', () => {
    expect(P_TIER_DEV_SET.sort()).toEqual(
      ['C01', 'C03', 'C05', 'C09', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19', 'C20', 'C21'].sort()
    );
  });

  it('marks exactly C10, C11, C22, C24 as holdout with EMPTY surface forms', () => {
    expect(HOLDOUT_IDS.sort()).toEqual(['C10', 'C11', 'C22', 'C24'].sort());
    for (const episode of corpus.episodes) {
      if (episode.holdout) {
        for (const turn of episode.inputTurns) {
          expect(turn.text, `${episode.id} holdout wording must be empty`).toBe('');
          expect(turn.validatorFrozen, `${episode.id} turns must be validator-frozen`).toBe(true);
        }
      } else {
        const opening = episode.inputTurns[0];
        expect(opening.text.length, `${episode.id} opening wording present`).toBeGreaterThan(8);
        expect(opening.validatorFrozen ?? false).toBe(false);
      }
    }
  });
});

describe('every episode carries what the director and verifier consume', () => {
  it('has provenance, opening worker state, and a non-empty route-outcome set', () => {
    for (const episode of corpus.episodes) {
      expect(episode.provenance.source.length, episode.id).toBeGreaterThan(5);
      expect(episode.openingWorkerState.description.length, episode.id).toBeGreaterThan(3);
      expect(episode.permittedRouteOutcomes.length, episode.id).toBeGreaterThan(0);
    }
  });

  it('declares semantic slots with at least one positive slot per episode', () => {
    for (const episode of corpus.episodes) {
      const positive =
        episode.expectedSlots.mustContain.length > 0 ||
        episode.expectedSlots.responseMustContain.length > 0;
      expect(positive, `${episode.id} needs a checkable slot`).toBe(true);
    }
  });

  it('declares required negations/names/numbers where the plan demands them', () => {
    // C05 is THE negation episode; C01/C03 name Podpoint; C06 carries numbers and a filename.
    const byId = (id: string) => episodeById(corpus, id);
    expect(byId('C05').requiredNegations).toContain('not');
    expect(byId('C05').requiredNegations).toContain('until');
    expect(byId('C01').requiredNames.join(' ').toLowerCase()).toContain('pod');
    expect(byId('C06').requiredNumbers.length).toBeGreaterThan(0);
  });

  it('declares positive per-step deadlines and a final worker artefact', () => {
    for (const episode of corpus.episodes) {
      expect(episode.perStepDeadlinesMs.candidateMs, episode.id).toBeGreaterThan(0);
      expect(episode.perStepDeadlinesMs.presentationMs, episode.id).toBeGreaterThan(0);
      expect(episode.perStepDeadlinesMs.deliveryMs, episode.id).toBeGreaterThan(0);
      expect(episode.perStepDeadlinesMs.workerStoreMs, episode.id).toBeGreaterThan(0);
      expect(episode.expectedFinalWorkerArtefact.kind.length, episode.id).toBeGreaterThan(3);
    }
  });

  it('never allows more than one clarification repair branch (plan §5.3 budget)', () => {
    for (const episode of corpus.episodes) {
      const clarifications = episode.repairBranches.filter(
        (branch) => branch.action === 'one-clarification'
      );
      expect(clarifications.length, episode.id).toBeLessThanOrEqual(1);
    }
  });
});

describe('approval semantics are structural, not conventional', () => {
  it('only ever approves after an observed matching candidate plus completed presentation', () => {
    for (const episode of corpus.episodes) {
      for (const approval of episode.approvalTurns) {
        expect(approval.precondition).toBe('candidate-matched+presentation-complete');
      }
    }
  });

  it('gives every relay-outcome episode an approval turn, and conversation-only episodes none', () => {
    for (const episode of corpus.episodes) {
      const routesRelay = episode.permittedRouteOutcomes.some((outcome) =>
        ['relay-proposal', 'steer-busy', 'parks-while-busy'].includes(outcome)
      );
      if (routesRelay && !episode.holdout) {
        expect(episode.approvalTurns.length, `${episode.id} needs an approval turn`).toBeGreaterThan(0);
      }
      if (!routesRelay) {
        expect(episode.approvalTurns.length, `${episode.id} must not approve`).toBe(0);
      }
    }
  });
});

describe('corpus integrity', () => {
  it('index.json agrees with the episode files', () => {
    expect(corpus.index.ids.sort()).toEqual(corpus.episodes.map((episode) => episode.id).sort());
    expect(corpus.index.schemaVersion).toBe(CORPUS_SCHEMA_VERSION);
  });

  it('hashes deterministically over content, not mtimes', () => {
    expect(corpusHash(corpus)).toBe(corpusHash(loadCorpus()));
    expect(corpusHash(corpus)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('labels fixture speech as synthetic based on real wording', () => {
    for (const episode of corpus.episodes) {
      expect(episode.speechLabel).toBe('synthetic speech based on real wording');
    }
  });
});
