import { describe, it, expect } from 'vitest';
import { classifyOperatorUtterance, extractPostCancelInstruction } from '../../../src/talker/utterance-classifier.js';

/**
 * P25 — the Cancel gesture must actually cancel.
 *
 * The confirmation card's Cancel button sends the fixed CANCEL_UTTERANCE
 * 'no, cancel that' (client/src/components/DriveMode/useVoiceTurn.ts). The
 * classifier correctly reads it as a cancel and clears the draft — but the
 * F1 residue rule then re-drafted the fragment 'that' as a FRESH pending
 * proposal, so the card reappeared and could never be dismissed. Observed
 * live by the operator: "if I press cancel ... the new thing to be sent comes
 * out".
 */
describe('P25 — a bare cancel leaves nothing behind to draft', () => {
  it('the exact button utterance leaves no residue', () => {
    expect(classifyOperatorUtterance('no, cancel that')).toBe('cancel');
    expect(extractPostCancelInstruction('no, cancel that')).toBeNull();
  });

  it('other bare cancel shapes leave no residue either', () => {
    for (const bare of ['cancel it', "don't send that", 'never mind that', 'no, cancel it', 'forget that']) {
      expect(classifyOperatorUtterance(bare), bare).toBe('cancel');
      expect(extractPostCancelInstruction(bare), bare).toBeNull();
    }
  });

  it('a real instruction after the cancel boundary is STILL captured (F1 intact)', () => {
    const text = 'Never mind, forget it. Tell the worker to rebase instead.';
    expect(extractPostCancelInstruction(text)).toBe('Tell the worker to rebase instead.');
  });

  it('a cancel phrase followed by a distinct instruction keeps that instruction', () => {
    expect(extractPostCancelInstruction('no, cancel that. Tell the worker to stop.')).toBe('Tell the worker to stop.');
  });

  it('a pure cancel repeated still collapses to nothing', () => {
    expect(extractPostCancelInstruction('no, wait — cancel that')).toBeNull();
  });
});
