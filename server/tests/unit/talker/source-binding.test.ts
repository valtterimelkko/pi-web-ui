/**
 * Phase 3 (native-primary programme, child H) — RED-5 core: the pure
 * source-binding predicate a `relay_to_worker` tool call is tied through.
 *
 * Defect (Phase 0): the mount read `lane.utteranceSeq` at tool-call time, so an
 * async relay arriving after a second utterance was bound to the LATEST
 * utterance — provenance by position, not by origin (plan: "Bind a tool call to
 * its originating utterance/turn, not whichever final utterance happens to be
 * last when an async tool finishes. Ambiguous provenance holds/refuses; it
 * never guesses a source.").
 *
 * Binding rule pinned here:
 *   - candidates are the lane's recent FINAL operator statement utterances
 *     (approval-channel speech — confirm/cancel — is never relay source);
 *   - a candidate matches when the relay's tokens are contained in it
 *     (normalised), ≥ the containment floor — the semi-verbatim relay is the
 *     operator's own words minus the addressing frame;
 *   - exactly one match  → bound to it;
 *   - two or more matches → AMBIGUOUS: the host refuses, it never picks;
 *   - no textual match, exactly one candidate → bound to it (attribution is
 *     unambiguous when there is only one possible source);
 *   - no textual match, several candidates → AMBIGUOUS: refuse.
 */

import { describe, expect, it } from 'vitest';

import {
  RELAY_SOURCE_CONTAINMENT_FLOOR,
  bindRelaySource,
  type SourceUtterance,
} from '../../../src/talker/source-binding.js';

function utt(id: number, text: string): SourceUtterance {
  return { id, text };
}

describe('bindRelaySource — the originating utterance, never the latest', () => {
  it('binds a tidied relay to the utterance it came from (Phase 0 RED-5 seed)', () => {
    const binding = bindRelaySource('Investigate the alternative', [
      utt(1, 'Investigate the alternative'),
      utt(2, 'Actually, forget that for a moment'),
    ]);
    expect(binding).toMatchObject({ kind: 'bound', utterance: { id: 1 } });
  });

  it('binds a semi-verbatim relay through containment, not equality', () => {
    const binding = bindRelaySource('Find out about Podpoint', [
      utt(1, 'I want to find out about Podpoint'),
      utt(2, 'What is the largest file in the repo'),
    ]);
    expect(binding).toMatchObject({ kind: 'bound', utterance: { id: 1 } });
  });

  it('binds through the addressing frame the operator actually spoke', () => {
    const binding = bindRelaySource('run the integration suite', [
      utt(7, 'relay to worker run the integration suite'),
      utt(8, 'and after that we can look at the report'),
    ]);
    expect(binding).toMatchObject({ kind: 'bound', utterance: { id: 7 } });
  });

  it('never binds to the latest utterance when the relay matches an earlier one', () => {
    const binding = bindRelaySource('hold phase three until my review', [
      utt(1, 'hold phase three until my review'),
      utt(2, 'actually wait'),
      utt(3, 'what do you think about the report'),
      utt(4, 'hold that thought'),
    ]);
    expect(binding).toMatchObject({ kind: 'bound', utterance: { id: 1 } });
  });
});

describe('bindRelaySource — ambiguity refuses, it never guesses', () => {
  it('two matching candidates refuse as ambiguous', () => {
    const binding = bindRelaySource('check the build', [
      utt(1, 'please check the build now'),
      utt(2, 'I need you to check the build again'),
    ]);
    expect(binding).toMatchObject({ kind: 'ambiguous', candidateIds: [1, 2] });
  });

  it('no match with several candidates refuses — the relay has no provable source', () => {
    const binding = bindRelaySource('deploy the staging branch', [
      utt(1, 'Investigate the alternative'),
      utt(2, 'What is the largest file in the repo'),
    ]);
    expect(binding).toMatchObject({ kind: 'ambiguous', candidateIds: [1, 2] });
  });

  it('below the containment floor a single candidate is still the only possible source', () => {
    const binding = bindRelaySource('please look into the podpoint charging question', [
      utt(1, 'I want to find out about Podpoint'),
    ]);
    expect(binding).toMatchObject({ kind: 'bound', utterance: { id: 1 } });
  });

  it('no candidates at all refuses', () => {
    expect(bindRelaySource('check the build', [])).toMatchObject({ kind: 'unbound' });
  });
});

describe('bindRelaySource — the containment floor', () => {
  it('is the same order the spoken read-back uses (0.6)', () => {
    expect(RELAY_SOURCE_CONTAINMENT_FLOOR).toBe(0.6);
  });

  it('a relay sharing most of its tokens with one candidate binds to it', () => {
    // 4 of 5 relay tokens appear in the candidate: above the floor.
    const binding = bindRelaySource('find out about the podpoint charging', [
      utt(1, 'I want to find out about Podpoint'),
      utt(2, 'never mind'),
    ]);
    expect(binding).toMatchObject({ kind: 'bound', utterance: { id: 1 } });
  });

  it('a barely-overlapping relay against two candidates refuses rather than guesses', () => {
    // 1 of 4 relay tokens in candidate 1, 0 in candidate 2: no match anywhere,
    // several candidates ⇒ ambiguous.
    const binding = bindRelaySource('restart the whole pipeline now', [
      utt(1, 'Investigate the alternative'),
      utt(2, 'What is the largest file in the repo'),
    ]);
    expect(binding).toMatchObject({ kind: 'ambiguous' });
  });
});
