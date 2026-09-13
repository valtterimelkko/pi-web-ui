import { describe, it, expect } from 'vitest';

// RED: module does not exist yet.
import { classifyOperatorUtterance } from '../../../src/talker/utterance-classifier.js';

describe('classifyOperatorUtterance', () => {
  // The pushback turn from scripts/talker-prompts/v2-structured.txt and plan
  // §10.11. With a pending proposal this IS an authorisation and must release.
  it('classifies the operator-pushback utterance as a confirmation', () => {
    expect(classifyOperatorUtterance("just do it, don't ask me every single time, it's a simple thing")).toBe('confirm');
  });

  it('classifies the pushback short form as a confirmation', () => {
    expect(classifyOperatorUtterance("just do it, stop asking me every time")).toBe('confirm');
    expect(classifyOperatorUtterance('yes, go ahead')).toBe('confirm');
    expect(classifyOperatorUtterance('yeah send it')).toBe('confirm');
    expect(classifyOperatorUtterance('please send that')).toBe('confirm');
    expect(classifyOperatorUtterance('sure, do it')).toBe('confirm');
    expect(classifyOperatorUtterance('confirmed')).toBe('confirm');
  });

  it('classifies bare affirmations as confirmations', () => {
    expect(classifyOperatorUtterance('yes')).toBe('confirm');
    expect(classifyOperatorUtterance('yes.')).toBe('confirm');
    expect(classifyOperatorUtterance('yep')).toBe('confirm');
    expect(classifyOperatorUtterance('okay')).toBe('confirm');
    expect(classifyOperatorUtterance('go ahead')).toBe('confirm');
  });

  it('classifies explicit cancels as cancels', () => {
    expect(classifyOperatorUtterance('no')).toBe('cancel');
    expect(classifyOperatorUtterance('no, wait')).toBe('cancel');
    expect(classifyOperatorUtterance('never mind')).toBe('cancel');
    expect(classifyOperatorUtterance("don't send that")).toBe('cancel');
    expect(classifyOperatorUtterance('forget it')).toBe('cancel');
    expect(classifyOperatorUtterance('actually, no — scratch that')).toBe('cancel');
  });

  it('a correction that starts with no but carries new content is a statement, not a cancel', () => {
    expect(classifyOperatorUtterance("no, that's wrong — tell it to rebase first")).toBe('statement');
  });

  it('questions about the send are never confirmations (gate guard)', () => {
    // "did you send it?" must NOT release a pending proposal.
    expect(classifyOperatorUtterance('did you send it?')).toBe('question');
    expect(classifyOperatorUtterance('did you send it')).toBe('question');
    expect(classifyOperatorUtterance('has it been sent?')).toBe('question');
  });

  it('classifies ordinary questions as questions', () => {
    expect(classifyOperatorUtterance("how's it going?")).toBe('question');
    expect(classifyOperatorUtterance('what is worker 1 doing')).toBe('question');
    expect(classifyOperatorUtterance('do you see any errors')).toBe('question');
  });

  it('classifies instructions and chatter as statements', () => {
    expect(classifyOperatorUtterance('tell the worker to hold phase 3 until my review')).toBe('statement');
    expect(classifyOperatorUtterance('ok so tell the worker to rebase the branch')).toBe('statement');
    expect(classifyOperatorUtterance("I'm just thinking out loud, maybe split the module later")).toBe('statement');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(classifyOperatorUtterance('  YES  ')).toBe('confirm');
    expect(classifyOperatorUtterance('Never Mind.')).toBe('cancel');
  });

  it('classifies the empty utterance as a statement (caller guards empty input)', () => {
    expect(classifyOperatorUtterance('   ')).toBe('statement');
  });
});

// ============================================================================
// Finding F1 (P7): a cancel-shaped utterance can carry instruction material
// AFTER the cancel boundary. The classifier reads the cancel first (safe
// default — the gate must not move), so without a mechanical split the
// instruction half never reaches the draft and the operator's words vanish
// from the harness. extractPostCancelInstruction locates the boundary;
// the caller decides what the residue means.
// ============================================================================

import { extractPostCancelInstruction } from '../../../src/talker/utterance-classifier.js';

describe('extractPostCancelInstruction — the cancel/instruction boundary (F1)', () => {
  it('the exact s5/t4 utterance: everything after the cancel run is the residue', () => {
    const utterance =
      "Never mind, forget it. Back to the caching thing — tell it to leave caching alone entirely, we're dropping that work.";
    expect(extractPostCancelInstruction(utterance)).toBe(
      "Back to the caching thing — tell it to leave caching alone entirely, we're dropping that work."
    );
  });

  it('a pure cancel yields null — unchanged behaviour', () => {
    expect(extractPostCancelInstruction('never mind')).toBeNull();
    expect(extractPostCancelInstruction('cancel that')).toBeNull();
    expect(extractPostCancelInstruction('no, wait')).toBeNull();
    expect(extractPostCancelInstruction('forget it')).toBeNull();
    expect(extractPostCancelInstruction('No.')).toBeNull();
  });

  it('a cancel run is skipped whole — several cancel phrases in a row do not strand a fragment', () => {
    expect(extractPostCancelInstruction('No, wait — cancel that. Actually tell the worker to rebase.')).toBe(
      'Actually tell the worker to rebase.'
    );
  });

  it('an instruction that self-cancels in the same breath cancels wholly — nothing drafts', () => {
    // The last cancel phrase swallows what came before it: the operator took
    // it back themselves. Same outcome as the pre-fix classifier.
    expect(extractPostCancelInstruction('tell it to rebase. actually no, cancel that')).toBeNull();
  });

  it('the residue is returned raw for the caller to classify — a question-shaped residue is not an instruction', () => {
    expect(extractPostCancelInstruction("never mind. how's it going?")).toBe("how's it going?");
  });

  it('non-cancel utterances pass through whole (only the cancel branch consults this)', () => {
    expect(extractPostCancelInstruction('tell the worker to rebase onto main')).toBe(
      'tell the worker to rebase onto main'
    );
  });
});
