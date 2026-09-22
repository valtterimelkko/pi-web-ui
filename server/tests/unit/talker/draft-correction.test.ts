/**
 * Phase 3 (native-primary programme, child H) — RED-3: a correction replaces
 * the failed attempt instead of accumulating with it.
 *
 * Defect (Phase 0): `appendToDraft` accumulated unconditionally, so a corrected
 * repeat produced a draft holding BOTH the misheard first attempt and the
 * correction — the whole concatenation was releasable (plan §2, KPI
 * "Correction behaviour: 100% replaced-not-concatenated"; corpus C17).
 *
 * The synthesis this pins (plan Phase 3: "Support replacing/correcting a
 * candidate without accumulating the rejected attempt. A multi-turn composed
 * message requires explicit composition context"):
 *   - a NEW utterance that re-states the held draft — the draft's normalised
 *     text is a prefix of the new text, or vice versa — REPLACES the draft:
 *     the operator re-spoke the whole instruction, and the latest words win;
 *     nothing is lost, because the old text is contained in the new;
 *   - any other new utterance still APPENDS (plan §4.2 supersession: unrelated
 *     composition holds both — pinned unchanged in pending-proposal.test.ts).
 */

import { describe, expect, it } from 'vitest';

import { PendingProposalStore, isDraftRestatement } from '../../../src/talker/proposal-store.js';

describe('Phase 3 RED-3: a corrected repeat replaces, not accumulates', () => {
  // Phase 0 probe acceptance seed (verbatim).
  it('the corrected version alone is releasable', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'Investigate the alternative', 1);
    store.appendToDraft(2, 'Investigate the alternative, but do not change anything', 2);
    const snap = store.snapshotDraft();
    const joined = snap?.utterances.map((u) => u.text).join(' ') ?? '';
    expect(joined).toBe('Investigate the alternative, but do not change anything');
  });

  it('takeForRelease delivers only the correction', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'check the build', 1);
    store.appendToDraft(2, 'check the build but do not deploy', 2);
    const taken = store.takeForRelease(3);
    expect(taken?.text).toBe('check the build but do not deploy');
  });

  it('a shortened re-statement also replaces (the latest, shorter wording wins)', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'check the build status and report back', 1);
    store.appendToDraft(2, 'check the build', 2);
    expect(store.pending?.text).toBe('check the build');
  });

  it('a pure repeat replaces with the same bytes and a NEW identity (C19)', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'check the build', 1);
    const before = store.describeCurrentProposal();
    store.appendToDraft(2, 'check the build', 2);
    const after = store.describeCurrentProposal();
    expect(store.pending?.text).toBe('check the build');
    expect(after?.version).toBeGreaterThan(before?.version ?? 0);
  });

  it('an unrelated second instruction still appends (§4.2 supersession control)', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'instruction one', 1);
    store.appendToDraft(2, 'instruction two', 2);
    expect(store.snapshotDraft()?.utterances.map((u) => u.text)).toEqual([
      'instruction one',
      'instruction two',
    ]);
  });

  it('an addendum that does not re-state the draft still appends (pinned cascade pair)', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'hold phase 3 until my review', 1);
    store.appendToDraft(2, 'and also make it use staging credentials, not production', 2);
    expect(store.snapshotDraft()?.utterances).toHaveLength(2);
  });

  it('replacement is prefix-based, not substring-based anywhere', () => {
    // "run the whole suite" appears inside the new text but not as its head,
    // and the draft is not the new text's head either — this appends.
    expect(
      isDraftRestatement('run the whole suite', 'first lint, then run the whole suite twice')
    ).toBe(false);
  });
});

describe('isDraftRestatement (the mechanical correction predicate)', () => {
  it('true when the new text extends the draft from its head', () => {
    expect(isDraftRestatement('check the build', 'check the build, but do not deploy')).toBe(true);
  });

  it('true when the new text shortens the draft from its head', () => {
    expect(isDraftRestatement('check the build status and report', 'check the build')).toBe(true);
  });

  it('true across punctuation and case differences', () => {
    expect(isDraftRestatement('Check the build.', 'check the build please')).toBe(true);
  });

  it('false for unrelated texts', () => {
    expect(isDraftRestatement('check the build', 'deploy the staging branch')).toBe(false);
  });

  it('false when a shared prefix is shorter than the whole draft', () => {
    expect(isDraftRestatement('check the build status', 'check the deploy log')).toBe(false);
  });
});
