import { describe, it, expect, vi } from 'vitest';

// RED: the operator draft (plan §4.2) does not exist yet.
import { TalkerSession } from '../../../src/talker/talker.js';
import { PendingProposalStore, UtteranceLog } from '../../../src/talker/pending-proposal.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import type { TalkerModelClient, ModelTurnResult, WorkerStateSnapshot } from '../../../src/talker/types.js';

/**
 * The operator's draft — plan §4.2 (interleaved composition), acceptance
 * criteria A12/A13/A14.
 *
 * The three properties most worth pinning, because they are the ones a
 * careless implementation loses:
 *
 *   1. the draft survives interleaving — compose, advance several turns of
 *      conversation, resume, confirm; the released text is the whole draft,
 *      verbatim (A12);
 *   2. a lapsed draft is surfaced, not dropped — drive past the confirmation
 *      window, then ask; the draft is still there and requires
 *      re-confirmation (A13);
 *   3. supersession holds both — a second unreleased instruction does not
 *      destroy the first (A14 / §4.2 "holds both and asks which").
 *
 * Plus the two standing rules from §4.2: explicit abandon ("forget that")
 * works, and an ambiguous confirmation never acts.
 *
 * The gate itself is out of scope here and pinned in talker-gate.test.ts;
 * nothing in this file may weaken it: releases stay verbatim, by id, atomic,
 * exactly once, and reachable only from a confirm-classified utterance.
 */

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'supervising two workers',
  recentEvents: ['watching worker 1'],
  children: ['worker 1: running'],
  pendingItems: ['phase 3 held'],
  lastAssistantText: 'Both are running.',
};

const INSTRUCTION_1 = 'tell the worker to hold phase 3 until my review';
const ADDENDUM = 'and also make it use staging credentials, not production';

function stubModel(reply: string): TalkerModelClient & { calls: Array<Array<{ role: string; content: string }>> } {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  return {
    calls,
    async completeTurn(messages): Promise<ModelTurnResult> {
      calls.push(messages);
      return { text: reply, ttftMs: 10, totalMs: 30 };
    },
  };
}

function makeSession(reply = 'Still going — nothing needs you yet.') {
  const delivery = createNullDelivery();
  const model = stubModel(reply);
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-1',
    snapshotProvider: () => SNAPSHOT,
  });
  return { session, model, delivery };
}

/** Non-candidate conversation turns (status/meta) — the "worker news" lane. */
async function interleave(session: TalkerSession, turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) await session.handleOperatorTurn("how's it going?");
}

describe('PROPERTY 1 (A12): the draft survives interleaving', () => {
  it('compose → many conversation turns → resume → confirm releases the whole draft, verbatim', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION_1); // turn 1: the operator starts composing
    // Seven turns of interleaved conversation. Under the old semantics the
    // candidate silently expired at age 6 and was then REPLACED by the
    // addendum — the first half of the instruction vanished.
    await interleave(session, 7);
    await session.handleOperatorTurn(ADDENDUM); // the operator resumes the half-finished thought
    const result = await session.handleOperatorTurn('yes, send that');
    expect(result.released).not.toBeNull();
    expect(result.released?.text).toBe(`${INSTRUCTION_1}\n${ADDENDUM}`);
    expect(delivery.deliveredTexts()).toEqual([`${INSTRUCTION_1}\n${ADDENDUM}`]);
  });

  it('interleaving without confirmation loses nothing: the draft is intact before the confirm', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION_1);
    await interleave(session, 7);
    const snap = session.proposals.snapshotDraft();
    expect(snap?.utterances.map(u => u.text)).toEqual([INSTRUCTION_1]);
  });
});

describe('PROPERTY 2 (A13): a lapsed draft is surfaced, never dropped', () => {
  it('a yes after the window releases nothing, quotes the draft, keeps it, and a re-confirmed yes releases it', async () => {
    const { session, delivery, model } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION_1); // turn 1
    await interleave(session, 6); // turns 2–7: the confirmation window lapses
    model.calls.length = 0;

    const lapsedYes = await session.handleOperatorTurn('yes'); // turn 8: stale confirmation
    expect(lapsedYes.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
    // Nothing is silently dropped: the draft is still held…
    expect(session.proposals.pending).not.toBeNull();
    expect(session.proposals.snapshotDraft()?.utterances.map(u => u.text)).toEqual([INSTRUCTION_1]);
    // …the talker surfaces it, quoting it verbatim, mechanically (no model call —
    // the model must never own this state transition).
    expect(lapsedYes.reply).toContain(INSTRUCTION_1);
    expect(lapsedYes.modelCalled).toBe(false);
    expect(model.calls).toHaveLength(0);

    // The surfacing re-arms the confirmation: a fresh yes now releases.
    const reconfirmed = await session.handleOperatorTurn('yes');
    expect(reconfirmed.released?.text).toBe(INSTRUCTION_1);
    expect(delivery.deliveredTexts()).toEqual([INSTRUCTION_1]);
    // Exactly once: the draft is consumed by the release.
    expect(session.proposals.pending).toBeNull();
  });

  it('the boundary holds even when no tick ever observed the lapse (release-time enforcement)', async () => {
    const store = new PendingProposalStore({ maxPendingAgeTurns: 3 });
    store.appendToDraft(101, INSTRUCTION_1, 1);
    expect(store.takeForRelease(50)).toBeNull(); // far-future turn: refused
    // Refusal is NOT destruction (the old code consumed the candidate here).
    expect(store.snapshotDraft()?.utterances.map(u => u.text)).toEqual([INSTRUCTION_1]);
    expect(store.snapshotDraft()?.needsReConfirmation).toBe(true);
    // After the harness surfaces it (re-arm), it can release.
    store.markResurfaced(51);
    expect(store.takeForRelease(52)?.text).toBe(INSTRUCTION_1);
  });

  it('tickTurn marks the lapsed draft but never drops it', () => {
    const store = new PendingProposalStore({ maxPendingAgeTurns: 3 });
    store.appendToDraft(101, INSTRUCTION_1, 1);
    store.tickTurn(2);
    store.tickTurn(3);
    expect(store.snapshotDraft()?.needsReConfirmation).toBe(false);
    store.tickTurn(4); // age reaches the window
    expect(store.snapshotDraft()).not.toBeNull();
    expect(store.snapshotDraft()?.needsReConfirmation).toBe(true);
    expect(store.takeForRelease(5)).toBeNull(); // still refuses until re-confirmed
    expect(store.snapshotDraft()).not.toBeNull(); // and still holds the draft
  });
});

describe('PROPERTY 3 (A14): supersession holds both — nothing is replaced silently', () => {
  it('a second unreleased instruction accumulates; a confirm releases both, in order, verbatim', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION_1);
    await session.handleOperatorTurn(ADDENDUM);
    const snap = session.proposals.snapshotDraft();
    expect(snap?.utterances.map(u => u.text)).toEqual([INSTRUCTION_1, ADDENDUM]);
    await session.handleOperatorTurn('yes, send that');
    expect(delivery.deliveredTexts()).toEqual([`${INSTRUCTION_1}\n${ADDENDUM}`]);
  });
});

describe('explicit abandon (§4.2): "forget that" clears the draft and a later yes releases nothing', () => {
  it('forget that abandons the whole draft', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION_1);
    await session.handleOperatorTurn(ADDENDUM);
    const forget = await session.handleOperatorTurn('forget that');
    expect(forget.cancelled).toBe(true);
    expect(session.proposals.pending).toBeNull();
    const yes = await session.handleOperatorTurn('yes');
    expect(yes.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
  });
});

describe('an ambiguous confirmation never acts (§4.2 / invariant 6)', () => {
  it('an ordinal selection that resolves to nothing releases nothing and keeps the draft', async () => {
    const { session, delivery, model } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION_1); // one-part draft
    model.calls.length = 0;
    const fifth = await session.handleOperatorTurn('the fifth one'); // resolves to nothing
    expect(fifth.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
    // The draft is untouched and still requires confirmation.
    expect(session.proposals.snapshotDraft()?.utterances.map(u => u.text)).toEqual([INSTRUCTION_1]);
    // Mechanical clarification, not a model guess.
    expect(fifth.modelCalled).toBe(false);
    // And a plain yes afterwards still releases the whole (single-part) draft.
    const yes = await session.handleOperatorTurn('yes');
    expect(yes.released?.text).toBe(INSTRUCTION_1);
    expect(delivery.deliveredTexts()).toEqual([INSTRUCTION_1]);
  });
});

describe('draft store mechanics (harness state, held by object reference)', () => {
  it('the draft holds its own verbatim copies — it is not reconstructed from the utterance log window', () => {
    const store = new PendingProposalStore();
    const log = new UtteranceLog();
    const rec = log.record(INSTRUCTION_1, 1);
    store.appendToDraft(rec.id, rec.text, 1);
    // Shrink the log below the record (eviction cannot corrupt the draft):
    for (let i = 0; i < 60; i++) log.record(`chatter ${i}`, i + 2);
    expect(log.resolve(rec.id)).toBeNull();
    // The draft still holds the verbatim text by reference.
    expect(store.snapshotDraft()?.utterances[0]?.text).toBe(INSTRUCTION_1);
  });

  it('appending re-arms a lapsed draft: the operator touching it is fresh engagement', () => {
    const store = new PendingProposalStore({ maxPendingAgeTurns: 3 });
    store.appendToDraft(101, INSTRUCTION_1, 1);
    store.tickTurn(2);
    store.tickTurn(3);
    store.tickTurn(4); // lapsed
    expect(store.snapshotDraft()?.needsReConfirmation).toBe(true);
    store.appendToDraft(102, ADDENDUM, 5); // the operator resumes
    expect(store.snapshotDraft()?.needsReConfirmation).toBe(false);
    expect(store.takeForRelease(6)?.text).toBe(`${INSTRUCTION_1}\n${ADDENDUM}`);
  });

  it('a subset release takes exactly the selected utterance and leaves the rest held', () => {
    const store = new PendingProposalStore({ maxPendingAgeTurns: 6 });
    store.appendToDraft(101, INSTRUCTION_1, 1);
    store.appendToDraft(102, ADDENDUM, 2);
    const taken = store.takeForRelease(3, { kind: 'ordinal', position: 'second' });
    expect(taken?.text).toBe(ADDENDUM);
    expect(taken?.utteranceIds).toEqual([102]);
    // The first part is still held, still requires its own confirmation.
    expect(store.snapshotDraft()?.utterances.map(u => u.text)).toEqual([INSTRUCTION_1]);
    // The taken part cannot be taken again: 'second' no longer resolves.
    expect(store.takeForRelease(3, { kind: 'ordinal', position: 'second' })).toBeNull();
    // The remainder releases on its own explicit selection.
    const rest = store.takeForRelease(3, { kind: 'ordinal', position: 'first' });
    expect(rest?.text).toBe(INSTRUCTION_1);
    expect(store.snapshotDraft()).toBeNull();
    expect(store.takeForRelease(5)).toBeNull(); // exactly once, per part and overall
  });

  it('cancel clears the whole accumulated draft', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(101, INSTRUCTION_1, 1);
    store.appendToDraft(102, ADDENDUM, 2);
    expect(store.cancel('operator cancelled', 3)).toBe(true);
    expect(store.snapshotDraft()).toBeNull();
    expect(store.takeForRelease(4)).toBeNull();
  });

  it('the release path stays atomic: exactly-once for a multi-part draft', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(101, INSTRUCTION_1, 1);
    store.appendToDraft(102, ADDENDUM, 2);
    const taken = store.takeForRelease(3);
    expect(taken?.utteranceIds).toEqual([101, 102]);
    expect(taken?.text).toBe(`${INSTRUCTION_1}\n${ADDENDUM}`);
    expect(store.snapshotDraft()).toBeNull();
    expect(store.takeForRelease(4)).toBeNull();
  });

  it('released records still expose the last release for the state view', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(101, INSTRUCTION_1, 1);
    const taken = store.takeForRelease(2);
    store.recordReleased({ utteranceId: taken!.utteranceId, text: taken!.text, outcome: 'delivered (steer)', turn: 2 });
    expect(store.lastReleased?.text).toBe(INSTRUCTION_1);
    expect(store.lastReleased?.utteranceId).toBe(101);
  });
});

describe('the verbatim release text of a multi-part draft is deterministic', () => {
  it('parts are joined in composition order with newlines, each byte-verbatim', () => {
    const store = new PendingProposalStore();
    const raw1 = '  Right, so — tell the worker to hold phase 3.  '; // untrimmed on purpose
    store.appendToDraft(1, raw1, 1);
    store.appendToDraft(2, ADDENDUM, 2);
    expect(store.takeForRelease(3)?.text).toBe(`${raw1}\n${ADDENDUM}`);
  });
});
