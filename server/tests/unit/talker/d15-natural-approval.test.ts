/**
 * D15-3 (plan §15.3, owner decision 2026-09-23) — natural approval and
 * self-correction at the approval boundary.
 *
 * Two classification changes, both confined to utterances aimed at the
 * currently presented candidate; the gate (policy-core's release predicate)
 * and its reachability are untouched:
 *
 *   1. A confirmation that explicitly refers to the pending candidate
 *      ("yes, send the amended version") counts. The campaign had to REWORD
 *      the C18 fixture to "Yes, send it." to get through the closed
 *      vocabulary — teaching the test to fit the product. The product now
 *      accepts the operator's real phrasing, and the corpus wording is
 *      restored.
 *   2. An utterance that withdraws AND carries a replacement instruction
 *      ("actually no — make it thirty seconds") amends rather than silently
 *      cancelling. On the native lane this is the C11-standard defect: the
 *      utterance was classified `cancel`, which cancelled the amendment's
 *      OWN proposal, and the amended candidate never arrived again
 *      (SOAK/campaign C11, failed twice). Bare withdrawals ("actually no.",
 *      "no, cancel that", "don't send it") still cancel, and a residue that
 *      is only the cancel's own object ("the amended version") is not a
 *      replacement.
 *
 * RED first (2026-09-23, follow-up execution): the candidate-referring and
 * amendment shapes below failed before the classifier change.
 */
import { describe, expect, it } from 'vitest';

import { classifyOperatorUtterance, extractPostCancelInstruction } from '../../../src/talker/utterance-classifier.js';

describe('D15-3: a confirmation that refers to the pending candidate releases', () => {
  it('the C18 natural wording (restored in the corpus) is a confirmation', () => {
    expect(classifyOperatorUtterance('Yes, send the amended version.')).toBe('confirm');
  });

  it('the other owner-listed candidate references confirm', () => {
    expect(classifyOperatorUtterance('yes, send the new one')).toBe('confirm');
    expect(classifyOperatorUtterance('send the updated version')).toBe('confirm');
    expect(classifyOperatorUtterance('okay, relay the corrected draft')).toBe('confirm');
    expect(classifyOperatorUtterance('yep, send the revised wording')).toBe('confirm');
  });

  it('negation and uncertainty still disqualify (never confirm)', () => {
    expect(classifyOperatorUtterance("I'm not sure about the amended version")).toBe('statement');
    expect(classifyOperatorUtterance('I would never send the amended version')).toBe('statement');
    expect(classifyOperatorUtterance('is that the amended version?')).toBe('question');
    expect(classifyOperatorUtterance('did you send the amended version?')).toBe('question');
  });

  it('a bare withdrawal with only the cancel object is still a cancel, not an amendment', () => {
    expect(classifyOperatorUtterance("don't send the amended version")).toBe('cancel');
    expect(classifyOperatorUtterance('cancel that updated draft')).toBe('cancel');
  });

  it('an unrelated instruction that merely contains a candidate word stays a statement', () => {
    // "amended version" absent — the reference must name the candidate shape.
    expect(classifyOperatorUtterance('tell the worker to deploy the new build to staging')).toBe('statement');
  });
});

describe('D15-3: a withdrawal that carries a replacement amends instead of cancelling', () => {
  it("the owner's real phrasing classifies as a statement (amend), not a cancel", () => {
    expect(classifyOperatorUtterance('Actually no — make it thirty seconds.')).toBe('statement');
    expect(
      classifyOperatorUtterance('Actually no — exponential backoff with jitter, and cap it at thirty seconds.')
    ).toBe('statement');
  });

  it('other cancel-plus-replacement shapes amend too', () => {
    expect(classifyOperatorUtterance('No, wait — use the red button instead.')).toBe('statement');
    expect(classifyOperatorUtterance("never mind, forget it. Tell the worker to rebase instead.")).toBe('statement');
  });

  it('bare withdrawals still cancel exactly as before', () => {
    expect(classifyOperatorUtterance('Actually no.')).toBe('cancel');
    expect(classifyOperatorUtterance('actually, no — scratch that')).toBe('cancel');
    expect(classifyOperatorUtterance('no')).toBe('cancel');
    expect(classifyOperatorUtterance('no, wait')).toBe('cancel');
    expect(classifyOperatorUtterance('no, cancel that')).toBe('cancel');
    expect(classifyOperatorUtterance("don't send it")).toBe('cancel');
    expect(classifyOperatorUtterance('never mind')).toBe('cancel');
    expect(classifyOperatorUtterance('forget it')).toBe('cancel');
  });

  it('the replacement text is exactly the residue after the cancel boundary', () => {
    expect(extractPostCancelInstruction('Actually no — make it thirty seconds.')).toBe('make it thirty seconds.');
    expect(
      extractPostCancelInstruction('Actually no — exponential backoff with jitter, and cap it at thirty seconds.')
    ).toBe('exponential backoff with jitter, and cap it at thirty seconds.');
  });
});
