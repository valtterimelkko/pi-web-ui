import { describe, it, expect } from 'vitest';

// RED: module does not exist yet.
import {
  PendingProposalStore,
  UtteranceLog,
  describeProposal,
  joinOriginalDraftText,
} from '../../../src/talker/pending-proposal.js';

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

/**
 * R1–R5 (card-contract brief, D1) — the pure proposal descriptor the card
 * payload is built from. `changed` is byte-level and cannot be the card's
 * truth claim: a trimmed trailing newline marks a part changed with zero
 * recorded removals, which made the card cry wolf and strike through the
 * operator's whole utterance. The descriptor answers the visible question
 * instead, and carries the raw bytes the operator can choose (D2, R3).
 */
describe('describeProposal — the card payload, built pure (R1–R5)', () => {
  const draftOf = (...utterances: string[]) => {
    const store = new PendingProposalStore();
    utterances.forEach((u, i) => store.appendToDraft(i + 1, u, i + 1));
    const snap = store.snapshotDraft();
    if (!snap) throw new Error('draft expected');
    return snap.utterances;
  };

  it('R1: a whitespace-only normalisation is NOT a tidy — cleaned false, no removed, no original', () => {
    // The operator-reported case, exactly: a dictation trailing newline.
    const parts = draftOf('Proceed.\n');
    expect(parts[0].text).toBe('Proceed.');
    expect(parts[0].originalText).toBe('Proceed.\n'); // the store still holds the raw bytes
    expect(describeProposal(parts)).toEqual({ text: 'Proceed.', cleaned: false, hash: expect.any(String) });
  });

  it('R4: an already-clean utterance invents nothing', () => {
    expect(describeProposal(draftOf('run the deploy checks'))).toEqual({
      text: 'run the deploy checks',
      cleaned: false,
      // D-card identity: the descriptor carries the content hash of its own
      // release bytes (version rides on the store, not the pure descriptor).
      hash: expect.any(String),
    });
  });

  it('R2/R3: visible removals → cleaned true, removed = the FRAGMENTS only, original = the raw bytes', () => {
    const described = describeProposal(draftOf('Um, tell the worker to rerun the suite'));
    expect(described).toEqual({
      text: 'rerun the suite',
      cleaned: true,
      removed: 'Um, tell the worker to',
      original: 'Um, tell the worker to rerun the suite',
      hash: expect.any(String),
    });
    // R2 hard rule: `removed` never carries the operator's whole utterance.
    expect(described.removed).not.toBe('Um, tell the worker to rerun the suite');
    // D-card identity: the hash covers the ORIGINAL bytes too — a tidied
    // draft and its clean twin must not share an identity.
    expect(described.hash).not.toBe(describeProposal(draftOf('rerun the suite')).hash);
  });

  it('R3: a multi-part original is each part\'s raw bytes (originalText ?? text), same join as the relay', () => {
    const parts = draftOf('Um, rebase main', 'run the suite');
    const described = describeProposal(parts);
    expect(described.text).toBe('rebase main\nrun the suite');
    expect(described.cleaned).toBe(true);
    expect(described.removed).toBe('Um,');
    expect(described.original).toBe('Um, rebase main\nrun the suite');
    expect(described.original).toBe(joinOriginalDraftText(parts));
  });

  it('R2: fragments of several removals are joined once, seam-repaired — not the whole utterance', () => {
    const described = describeProposal(draftOf('Okay, um, could you ask the worker to rebase the auth branch?'));
    expect(described.text).toBe('rebase the auth branch?');
    expect(described.cleaned).toBe(true);
    expect(described.removed).not.toContain('rebase the auth branch');
    expect(described.removed).toContain('um');
    expect(described.removed).toContain('ask the worker to');
    expect(described.original).toBe('Okay, um, could you ask the worker to rebase the auth branch?');
  });
});

/**
 * R7 (card-contract brief, D2) — the release path takes the variant as a
 * parameter and nothing else changes: the same selection, the same gates, the
 * same single door.
 */
describe('takeForRelease variant (R7)', () => {
  it("default 'tidied' releases the relay text — unchanged behaviour", () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'Um, tell the worker to rerun the suite', 1);
    expect(store.takeForRelease(2)?.text).toBe('rerun the suite');
  });

  it("R7: 'original' releases the raw bytes per part — exactly what the descriptor's original promised", () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'Um, tell the worker to rerun the suite', 1);
    const parts = store.snapshotDraft()?.utterances;
    const described = describeProposal(parts as never);
    expect(store.takeForRelease(2, undefined, 'original')?.text).toBe(described.original);
    expect(store.takeForRelease(3)).toBeNull(); // consumed once — no second door
  });

  it("R7: the variant selects exactly the parts the same selection resolves", () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'Um, rebase main', 1);
    store.appendToDraft(2, 'run the suite', 2);
    const taken = store.takeForRelease(3, { kind: 'ordinal', position: 'second' }, 'original');
    // The clean second part has no originalText: the raw bytes ARE its text.
    expect(taken?.text).toBe('run the suite');
    expect(taken?.utteranceIds).toEqual([2]);
  });

  it("R7: every existing gate is unchanged with the original variant — lapsed draft still refuses", () => {
    const store = new PendingProposalStore({ maxPendingAgeTurns: 3 });
    store.appendToDraft(1, 'Um, rebase main', 1);
    expect(store.takeForRelease(50, undefined, 'original')).toBeNull();
    expect(store.snapshotDraft()?.needsReConfirmation).toBe(true);
    expect(store.snapshotDraft()?.utterances.length).toBe(1); // nothing silently dropped
  });

  it("R7: nothing pending releases nothing, whatever the variant", () => {
    const store = new PendingProposalStore();
    expect(store.takeForRelease(1, undefined, 'original')).toBeNull();
  });
});
