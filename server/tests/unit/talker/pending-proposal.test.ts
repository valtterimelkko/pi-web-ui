import { describe, it, expect } from 'vitest';

// RED: module does not exist yet.
import { PendingProposalStore, UtteranceLog } from '../../../src/talker/pending-proposal.js';

describe('UtteranceLog', () => {
  it('stores verbatim operator utterances with ids and resolves them by id', () => {
    const log = new UtteranceLog();
    const a = log.record('tell the worker to hold phase 3 until my review', 1);
    const b = log.record('yes, go ahead', 2);
    expect(a.id).not.toBe(b.id);
    expect(log.resolve(a.id)?.text).toBe('tell the worker to hold phase 3 until my review');
    expect(log.resolve(b.id)?.text).toBe('yes, go ahead');
    expect(log.resolve(9999)).toBeNull();
  });

  it('preserves the raw text byte-for-byte (no trimming or normalisation)', () => {
    const log = new UtteranceLog();
    const raw = '  Right, so — tell the worker to hold phase 3.  ';
    const rec = log.record(raw, 1);
    expect(log.resolve(rec.id)?.text).toBe(raw);
  });

  it('is bounded: keeps only the most recent window', () => {
    const log = new UtteranceLog({ limit: 3 });
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(log.record(`utterance ${i}`, i).id);
    expect(log.resolve(ids[0])).toBeNull();
    expect(log.resolve(ids[9])?.text).toBe('utterance 9');
  });
});

describe('PendingProposalStore', () => {
  it('a second utterance accumulates into the draft — nothing is replaced silently (plan §4.2)', () => {
    // CHANGED from replacement semantics (plan §4.2): the old test pinned
    // recordCandidate() REPLACING the candidate so the most recent instruction
    // was the one a yes referred to. That silently destroyed the first
    // instruction. Supersession now holds both: the draft is the operator's
    // accumulating composing thread, and the state view surfaces the count so
    // the talker asks which. A release takes the whole draft, or one part by
    // id — never a silent replacement.
    const store = new PendingProposalStore();
    store.appendToDraft(101, 'instruction one', 1);
    expect(store.pending?.text).toBe('instruction one');
    store.appendToDraft(102, 'instruction two', 2);
    expect(store.snapshotDraft()?.utterances.map(u => u.text)).toEqual(['instruction one', 'instruction two']);
    // The compatibility view anchors the latest part id and carries the
    // whole verbatim draft text.
    expect(store.pending?.utteranceId).toBe(102);
    expect(store.pending?.text).toBe('instruction one\ninstruction two');
  });

  it('takeForRelease atomically consumes the draft (authorisation used once)', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(101, 'instruction one', 1);
    const taken = store.takeForRelease(2);
    expect(taken?.text).toBe('instruction one');
    expect(store.pending).toBeNull();
    // A second confirmation has nothing to release.
    expect(store.takeForRelease(3)).toBeNull();
  });

  it('cancel clears the whole draft so a later yes releases nothing', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(101, 'instruction one', 1);
    expect(store.cancel('operator cancelled', 2)).toBe(true);
    expect(store.pending).toBeNull();
    expect(store.takeForRelease(3)).toBeNull();
  });

  it('cancel with nothing pending returns false', () => {
    const store = new PendingProposalStore();
    expect(store.cancel('operator cancelled', 1)).toBe(false);
  });

  it('a lapsed window never releases — and the refusal marks the draft instead of dropping it', () => {
    // CHANGED (plan §4.2): the old test pinned tickTurn() EXPIRING (dropping)
    // the candidate at maxPendingAgeTurns. The safety half — stale text is
    // never released — is preserved unchanged below. What is removed is the
    // silent drop: the window now lapses onto the confirmation, the draft is
    // marked needs-re-confirmation, and the harness surfaces it.
    const store = new PendingProposalStore({ maxPendingAgeTurns: 3 });
    store.appendToDraft(101, 'instruction one', 1);
    store.tickTurn(2);
    store.tickTurn(3);
    expect(store.snapshotDraft()?.needsReConfirmation).toBe(false);
    store.tickTurn(4); // the window lapses
    expect(store.takeForRelease(5)).toBeNull(); // stale text is never released (unchanged safety)
    expect(store.snapshotDraft()).not.toBeNull(); // and nothing is silently dropped
    expect(store.snapshotDraft()?.needsReConfirmation).toBe(true);
  });

  it('takeForRelease itself refuses an over-aged draft at the send boundary — without destroying it', () => {
    // A caller that jumps straight to release at a far-future turn — without
    // any intervening tickTurn — must not be able to release a stale draft.
    // CHANGED (plan §4.2): the refusal no longer CONSUMES the draft (the old
    // code's consumption was the silent drop); it marks needs-re-confirmation
    // so the harness can surface it and the operator can re-confirm.
    const store = new PendingProposalStore({ maxPendingAgeTurns: 3 });
    store.appendToDraft(101, 'instruction one', 1);
    expect(store.takeForRelease(50)).toBeNull();
    expect(store.snapshotDraft()?.needsReConfirmation).toBe(true);
    expect(store.snapshotDraft()?.utterances.map(u => u.text)).toEqual(['instruction one']);
  });

  it('takeForRelease still releases a fresh draft in the normal propose-then-confirm window', () => {
    const store = new PendingProposalStore({ maxPendingAgeTurns: 3 });
    store.appendToDraft(101, 'instruction one', 1);
    store.tickTurn(2);
    const taken = store.takeForRelease(2) as { text: string } | null;
    expect(taken?.text).toBe('instruction one');
  });

  it('records releases and exposes the last one for the state view', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(101, 'instruction one', 1);
    const taken = store.takeForRelease(2) as { utteranceId: number; text: string };
    store.recordReleased({ utteranceId: taken.utteranceId, text: taken.text, outcome: 'delivered (steer)', turn: 2 });
    expect(store.lastReleased?.text).toBe('instruction one');
    expect(store.lastReleased?.outcome).toBe('delivered (steer)');
  });

  it('release history is bounded', () => {
    const store = new PendingProposalStore({ releasedHistoryLimit: 2 });
    for (let i = 0; i < 5; i++) {
      store.recordReleased({ utteranceId: i, text: `u${i}`, outcome: 'delivered (prompt)', turn: i });
    }
    expect(store.lastReleased?.text).toBe('u4');
    // Internal history must not grow unbounded.
    const history = store.releasedHistory();
    expect(history.length).toBe(2);
  });
});
