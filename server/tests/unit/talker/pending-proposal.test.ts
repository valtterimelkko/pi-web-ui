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
  it('holds at most one pending proposal; a new candidate replaces the previous one', () => {
    const store = new PendingProposalStore();
    store.recordCandidate('instruction one', 1, 101);
    expect(store.pending?.text).toBe('instruction one');
    store.recordCandidate('instruction two', 2, 102);
    expect(store.pending?.text).toBe('instruction two');
    expect(store.pending?.utteranceId).toBe(102);
  });

  it('takeForRelease atomically consumes the pending proposal (authorisation used once)', () => {
    const store = new PendingProposalStore();
    store.recordCandidate('instruction one', 1, 101);
    const taken = store.takeForRelease(2);
    expect(taken?.text).toBe('instruction one');
    expect(store.pending).toBeNull();
    // A second confirmation has nothing to release.
    expect(store.takeForRelease(3)).toBeNull();
  });

  it('cancel clears the pending proposal so a later yes releases nothing', () => {
    const store = new PendingProposalStore();
    store.recordCandidate('instruction one', 1, 101);
    expect(store.cancel('operator cancelled', 2)).toBe(true);
    expect(store.pending).toBeNull();
    expect(store.takeForRelease(3)).toBeNull();
  });

  it('cancel with nothing pending returns false', () => {
    const store = new PendingProposalStore();
    expect(store.cancel('operator cancelled', 1)).toBe(false);
  });

  it('expires a stale pending proposal after maxPendingAgeTurns', () => {
    const store = new PendingProposalStore({ maxPendingAgeTurns: 3 });
    store.recordCandidate('instruction one', 1, 101);
    store.tickTurn(2);
    store.tickTurn(3);
    expect(store.pending).not.toBeNull();
    store.tickTurn(4); // age reaches the limit
    expect(store.pending).toBeNull();
    expect(store.takeForRelease(5)).toBeNull();
  });

  it('takeForRelease itself refuses an over-aged candidate (lifetime enforced at the send boundary)', () => {
    // A caller that jumps straight to release at a far-future turn — without
    // any intervening tickTurn — must not be able to release a stale proposal.
    const store = new PendingProposalStore({ maxPendingAgeTurns: 3 });
    store.recordCandidate('instruction one', 1, 101);
    expect(store.takeForRelease(50)).toBeNull();
    // The stale candidate is consumed by the refusal: it can never release.
    expect(store.pending).toBeNull();
  });

  it('takeForRelease still releases a fresh candidate in the normal propose-then-confirm window', () => {
    const store = new PendingProposalStore({ maxPendingAgeTurns: 3 });
    store.recordCandidate('instruction one', 1, 101);
    store.tickTurn(2);
    const taken = store.takeForRelease(2) as { text: string } | null;
    expect(taken?.text).toBe('instruction one');
  });

  it('records releases and exposes the last one for the state view', () => {
    const store = new PendingProposalStore();
    store.recordCandidate('instruction one', 1, 101);
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
