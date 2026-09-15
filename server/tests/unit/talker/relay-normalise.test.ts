import { describe, it, expect } from 'vitest';

// RED: the module does not exist yet (P25 — restore the intent's rule:
// semi-verbatim relay).
import {
  normaliseRelayText,
  relayHasVisibleRemoval,
  visibleRemovalFragments,
} from '../../../src/talker/relay-normalise.js';

/**
 * P25 — the relay transform unit suite.
 *
 * The intent (docs/VOICE-ORCHESTRATOR-FEASIBILITY.md §3.2 rule 3) is
 * semi-verbatim: the operator's own words, optionally made more concise when
 * the speech rambles, never summarised, never expanded. The implementation is
 * therefore a closed, conservative list of REMOVAL-ONLY transforms of what
 * carries no instruction: the channel (commission/addressing frames) and the
 * disfluency (hesitation, stutters, leading markers, trailing courtesies).
 * No rewriting, no substituting, no reordering, no case changes — when in
 * doubt the words stay in.
 */

const relay = (raw: string): string => normaliseRelayText(raw).text;

describe('P25: the operator-reported failure case', () => {
  const SPOKEN = "Okay, ask the worker if it has enough materials to start developing the first week's materials, if it has enough resources for that.";
  const EXPECTED = "if it has enough materials to start developing the first week's materials, if it has enough resources for that.";

  it('relays the content, not the commission frame (the worker must never read "ask the worker")', () => {
    expect(relay(SPOKEN)).toBe(EXPECTED);
  });

  it('records every removal so the transform is reversible in the record', () => {
    const result = normaliseRelayText(SPOKEN);
    expect(result.changed).toBe(true);
    expect(result.removals).toEqual(['Okay, ', 'ask the worker ']);
    // For a leading-strip case the removed pieces precede the kept text, so
    // the original is reconstructable from the record alone. (In general the
    // draft also keeps `originalText` — the complete reversible record.)
    expect(result.removals[0] + result.removals[1] + result.text).toBe(SPOKEN);
  });

  it('leaves a conditional tail that IS content ("if it has enough resources for that")', () => {
    // The second "if ..." clause is a real condition, not a courtesy pad —
    // removing it would drop intent. Only the closed courtesy list is
    // padded away ("if that's okay", "if you don't mind", "please").
    expect(relay(SPOKEN)).toContain('if it has enough resources for that.');
  });
});

describe('P25: commission / addressing frames (the channel, not the instruction)', () => {
  it.each([
    ['ask the worker to rebase the branch', 'rebase the branch'],
    ['tell the worker to hold phase 3', 'hold phase 3'],
    ['tell the worker that we are delaying the review', 'we are delaying the review'],
    ['let the worker know the build is green', 'the build is green'],
    ['let the worker know that the build is green', 'the build is green'],
    ['pass this on to the worker: rebase the branch', 'rebase the branch'],
    ['ask it to rebase the branch', 'rebase the branch'],
    ['tell it to hold phase 3', 'hold phase 3'],
    ['could you ask the worker to rebase the branch', 'rebase the branch'],
    ['can you tell the worker to stop', 'stop'],
  ])('%s → %s', (spoken, expected) => {
    expect(relay(spoken)).toBe(expected);
  });

  it('keeps the interrogative connector — question force is meaning, and rewriting "if" into a statement is forbidden', () => {
    expect(relay('ask the worker what the status is')).toBe('what the status is');
    expect(relay('ask the worker whether the migration finished')).toBe('whether the migration finished');
    expect(relay('ask the worker for a status update')).toBe('for a status update');
  });

  it('leaves an unknown continuation untouched: "ask the worker nicely to stop" is not safely parseable', () => {
    // "nicely" might be the operator's real adverb. When the frame is not
    // followed by a known connector, the conservative choice is to leave the
    // whole utterance alone — a missed cleanup is correct; a mangled one is
    // the failure this project exists to prevent.
    expect(relay('ask the worker nicely to stop')).toBe('ask the worker nicely to stop');
  });

  it('never empties the relay: an utterance that is only a frame stays untouched', () => {
    expect(relay('pass this on to the worker')).toBe('pass this on to the worker');
    expect(normaliseRelayText('pass this on to the worker').changed).toBe(false);
  });

  it('strips a chained-instruction connective only when a commission frame follows', () => {
    // 'also tell the worker to …' would otherwise leak the frame to the
    // worker. A bare 'also …' is content-adjacent and stays.
    expect(relay('also tell the worker to rerun the test suite')).toBe('rerun the test suite');
    expect(relay('also run the flaky suite')).toBe('also run the flaky suite');
  });

  it('does not strip mid-sentence frames (leading-anchor only) — a nested frame may be real content', () => {
    // "if you see a failure, ask the worker to rebase" — stripping the frame
    // mid-sentence would mangle the sentence. Only sentence-initial frames
    // are the channel; the rest is left to the operator's own words.
    expect(relay('if you see a failure, ask the worker to rebase')).toBe('if you see a failure, ask the worker to rebase');
  });
});

describe('P25: hesitation and stutters (the disfluency, never the words)', () => {
  it('removes hesitation fillers (um, uh, er, erm) anywhere as standalone tokens', () => {
    expect(relay('um, hold phase 3 until my review')).toBe('hold phase 3 until my review');
    expect(relay('hold uh phase 3 until my review')).toBe('hold phase 3 until my review');
    expect(relay('hold phase 3, erm, until my review')).toBe('hold phase 3, until my review');
    expect(relay('er, start week one')).toBe('start week one');
  });

  it('does not break words that merely contain filler letters', () => {
    expect(relay('her review is pending')).toBe('her review is pending');
    expect(relay('the thermal limit')).toBe('the thermal limit');
  });

  it('collapses immediate word repetition (stutters) keeping one instance', () => {
    // Non-frame sentences: a frame-bearing sentence would ALSO be stripped by
    // the channel transform ('tell the the worker to rebase' relays as
    // 'rebase'), which would make this test assert two transforms at once.
    expect(relay('the the report is due Friday')).toBe('the report is due Friday');
    expect(relay('start start week one')).toBe('start week one');
  });

  it('leaves meaningful repetition alone: "very very" is an intensifier, not a stutter', () => {
    // Closed exemption list: very, so, no, oh, yeah, well, ok, okay, hmm, ah.
    // "no no" is emphasis/answer; "very very" strengthens. When in doubt,
    // leave the words in.
    expect(relay('this is very very important')).toBe('this is very very important');
    expect(relay('no no, run it on Tuesday')).toBe('no no, run it on Tuesday');
  });
});

describe('P25: leading discourse markers', () => {
  it.each([
    ['Okay so run the integration suite', 'run the integration suite'],
    ['Right, hold phase 3 until my review', 'hold phase 3 until my review'],
    ['So, run the integration suite', 'run the integration suite'],
    ['Well, start week one', 'start week one'],
    ['Okay, okay, um, start week one', 'start week one'],
  ])('%s → %s', (spoken, expected) => {
    expect(relay(spoken)).toBe(expected);
  });

  it('leaves a mid-sentence "so" alone — only leading markers are disfluency', () => {
    expect(relay('run it so the cache warms')).toBe('run it so the cache warms');
  });
});

describe('P25: trailing courtesy padding', () => {
  it.each([
    ["start week one, if that's okay", 'start week one'],
    ["start week one if you don't mind", 'start week one'],
    ['start week one, please', 'start week one'],
  ])('%s → %s', (spoken, expected) => {
    expect(relay(spoken)).toBe(expected);
  });

  it('leaves conditionals that carry instruction ("if possible", "if that works")', () => {
    // These are real conditions on the instruction — removing them would
    // change what the worker is asked to do. Only the closed courtesy list
    // ("if that's okay", "if you don't mind", "please") is removable.
    expect(relay('start today if possible')).toBe('start today if possible');
    expect(relay('ship it Tuesday if that works')).toBe('ship it Tuesday if that works');
  });
});

describe('P25: the transform is removal-only', () => {
  it('never rewrites, substitutes, reorders, or re-cases words', () => {
    const result = normaliseRelayText("Okay, ask the worker if it's ready");
    expect(result.text).toBe("if it's ready");
  });

  it('repairs only the seams removals leave behind (stray leading punctuation, double spaces, space before punctuation)', () => {
    expect(relay('um, , hold phase 3')).toBe('hold phase 3');
    expect(relay('hold  phase 3 until  my review')).toBe('hold phase 3 until my review');
    expect(relay('hold phase 3 , then rebase')).toBe('hold phase 3, then rebase');
  });

  it('is idempotent: normalising twice changes nothing further', () => {
    const once = normaliseRelayText('Okay, um, tell the the worker to rebase');
    const twice = normaliseRelayText(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.changed).toBe(false);
  });

  it('preserves a completely clean instruction byte-for-byte with changed=false and no removals', () => {
    const clean = 'hold phase 3 until my review';
    const result = normaliseRelayText(clean);
    expect(result.text).toBe(clean);
    expect(result.changed).toBe(false);
    expect(result.removals).toEqual([]);
  });
});

/**
 * R1/R2 (card-contract brief) — `changed` is a BYTE-level fact, so a trimmed
 * trailing newline marks a part 'changed' with zero recorded removals. The
 * card must not cry wolf: only a removal that took VISIBLE content is a tidy.
 * These two helpers are the pure predicate over `removals` that draws the
 * line, exported here so the card payload and the release agree by
 * construction.
 */
describe('R1/R2: visible tidy vs byte-level change', () => {
  it('a whitespace-only normalisation records no visible removal', () => {
    const result = normaliseRelayText('Proceed.\n');
    expect(result.text).toBe('Proceed.');
    expect(result.changed).toBe(true); // bytes changed...
    expect(result.removals).toEqual([]);
    expect(relayHasVisibleRemoval(result.removals)).toBe(false); // ...but nothing visible was removed
  });

  it('a whitespace-only removal piece is not visible', () => {
    expect(relayHasVisibleRemoval([])).toBe(false);
    expect(relayHasVisibleRemoval(['  ', '\n', ' \t '])).toBe(false);
  });

  it('a removal containing a non-whitespace character IS visible', () => {
    expect(relayHasVisibleRemoval(['Um'])).toBe(true);
    expect(relayHasVisibleRemoval(['  ', ', ', ''])).toBe(true);
    const result = normaliseRelayText('Um, tell the worker to rerun the suite');
    expect(relayHasVisibleRemoval(result.removals)).toBe(true);
  });

  it('visibleRemovalFragments keeps only visible pieces, trims them, and invents nothing', () => {
    expect(visibleRemovalFragments(['Um', ', ', '  ', 'tell the worker to '])).toEqual([
      'Um',
      ',',
      'tell the worker to',
    ]);
    expect(visibleRemovalFragments(['  ', '\n'])).toEqual([]);
    expect(visibleRemovalFragments([])).toEqual([]);
  });
});

describe('the card must not claim "exactly" over a visible change (W3 review, 2026-09-15)', () => {
  /**
   * Found by the W3 read-only reviewer and confirmed by the conductor on
   * 0798661's code: `repairRelaySeams()` deleted the operator's duplicated
   * punctuation (`run!! tests` -> `run! tests`) under a comment claiming
   * whitespace/punctuation-only changes "are not recorded as removals".
   *
   * Collapsing whitespace is invisible and correctly unclaimed. DELETING a
   * punctuation character the operator spoke is visible, so with no removal
   * recorded the descriptor returned `cleaned: false` and the card claimed
   * "your words, exactly" over text that differed from what was said — the
   * mirror image of the defect this commit fixed (a claim that was false in
   * the other direction).
   */
  const cases = ['run!! tests', 'run !!! tests', 'deploy, then wait;; go'];

  it('records dropped punctuation, so a visible change is never claimed as exact', () => {
    for (const raw of cases) {
      const result = normaliseRelayText(raw);
      if (result.text === raw) continue; // nothing changed: nothing to claim
      expect(
        relayHasVisibleRemoval(result.removals),
        `"${raw}" became "${result.text}" but recorded no visible removal, so the card would claim "exactly"`,
      ).toBe(true);
    }
  });

  it('still makes no claim for an invisible change (the original defect stays fixed)', () => {
    const result = normaliseRelayText('Proceed.\n');
    expect(result.text).toBe('Proceed.');
    expect(relayHasVisibleRemoval(result.removals), 'trailing whitespace must not claim a tidy').toBe(false);
  });

  it('names the removed punctuation in the fragments the card shows', () => {
    const result = normaliseRelayText('run!! tests');
    expect(result.text).toBe('run! tests');
    expect(visibleRemovalFragments(result.removals).join('')).toContain('!');
  });
});
