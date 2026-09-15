import { describe, it, expect } from 'vitest';

import { TalkerSession } from '../../../src/talker/talker.js';
import { PendingProposalStore, describeProposal } from '../../../src/talker/pending-proposal.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import { NOTHING_PENDING_ACK } from '../../../src/talker/ack.js';
import type { TalkerModelClient, ModelTurnResult, WorkerStateSnapshot } from '../../../src/talker/types.js';

/**
 * D-card — proposal identity.
 *
 * The card's promise is "this is the exact text that will be sent". Between
 * render and confirm the draft can change underneath the card (the operator
 * speaks again, another lane or tab mutates the same worker's draft), and
 * today the server releases whatever the draft holds at that moment: the
 * released bytes can differ from the approved bytes. The repair is an
 * identity on the proposed payload — a version counter plus a content hash
 * over the exact release bytes — which the card echoes on confirm; a confirm
 * whose echo no longer matches the current proposal is REFUSED mechanically
 * (the same class as the lapsed/ambiguous/empty refusals): nothing released,
 * the draft untouched, the current text quoted honestly.
 *
 * The 'original' release variant gets a matching gate: it is refused unless
 * the CURRENT proposal's descriptor actually advertised an `original` (a
 * visible removal happened), so a stale or buggy client can no longer
 * release raw text the card never offered.
 *
 * The bare spoken "yes" keeps today's semantics (no echo, existing gates) —
 * the identity ride-along is additive and the card gestures are the callers
 * that become precise.
 */

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '3m',
  activity: 'waiting',
  lastAssistantText: 'Ready.',
};

/** Scripted model that RECORDS every call — confirm refusals must be model-free. */
function recordingModel(reply = 'Understood — shall I send that to the worker?'): TalkerModelClient & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async completeTurn(): Promise<ModelTurnResult> {
      calls += 1;
      return { text: reply, ttftMs: 1, totalMs: 2 };
    },
  };
}

function makeSession() {
  const model = recordingModel();
  const delivery = createNullDelivery();
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-identity-1',
    snapshotProvider: () => SNAPSHOT,
  });
  return { session, delivery, model };
}

/** What the card would display after this turn: the harness's card payload. */
function cardFor(session: TalkerSession) {
  return session.proposals.describeCurrentProposal();
}

describe('proposal identity — the store half', () => {
  it('describeCurrentProposal carries a stable, comparable identity; null when nothing is held', () => {
    const store = new PendingProposalStore();
    expect(store.describeCurrentProposal()).toBeNull();

    store.appendToDraft(1, 'first instruction', 1);
    const a = store.describeCurrentProposal();
    expect(a).not.toBeNull();
    expect(typeof a!.version).toBe('number');
    expect(typeof a!.hash).toBe('string');
    expect(a!.hash.length).toBeGreaterThan(0);

    // Stable: recomputing without any mutation gives the same identity.
    expect(store.describeCurrentProposal()).toEqual(a);

    store.cancel('operator cancelled', 2);
    expect(store.describeCurrentProposal()).toBeNull();
  });

  it('append-after-render: the identity moves when the draft moves (version AND hash)', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'first instruction', 1);
    const before = store.describeCurrentProposal()!;
    store.appendToDraft(2, 'and also run the lint', 2);
    const after = store.describeCurrentProposal()!;
    expect(after.version).not.toBe(before.version);
    expect(after.hash).not.toBe(before.hash);
    expect(after.text).toBe('first instruction\nand also run the lint');
  });

  it('the hash is content: identical bytes give an identical hash, different bytes do not', () => {
    const s1 = new PendingProposalStore();
    const s2 = new PendingProposalStore();
    s1.appendToDraft(1, 'same words', 1);
    s2.appendToDraft(9, 'same words', 4);
    expect(s1.describeCurrentProposal()!.hash).toBe(s2.describeCurrentProposal()!.hash);
    // And a tidied draft hashes its ORIGINAL bytes into the identity too.
    s2.appendToDraft(10, 'Um, tell the worker to rerun the suite', 5);
    const tidied = s2.describeCurrentProposal()!;
    expect(tidied.cleaned).toBe(true);
    expect(tidied.hash).not.toBe(s1.describeCurrentProposal()!.hash);
    // describeProposal agrees with the store's hash (single source of truth).
    expect(describeProposal(s2.snapshotDraft()!.utterances).hash).toBe(tidied.hash);
  });

  it('a partial (selection) release bumps the identity of what remains', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'first', 1);
    store.appendToDraft(2, 'second', 2);
    const before = store.describeCurrentProposal()!;
    const taken = store.takeForRelease(3, { kind: 'ordinal', position: 'first' });
    expect(taken).not.toBeNull();
    const after = store.describeCurrentProposal()!;
    expect(after).not.toBeNull();
    expect(after!.text).toBe('second');
    expect(after!.version).not.toBe(before.version);
    expect(after!.hash).not.toBe(before.hash);
  });
});

describe('proposal identity — the confirm gate (staleness refusals)', () => {
  it('append-after-render: a confirm on the OLD card refuses, releases nothing, keeps the draft', async () => {
    const { session, delivery, model } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3 for review');
    const staleCard = cardFor(session)!;

    // Another lane/tab mutates the same worker's draft between render and confirm.
    await session.handleOperatorTurn('and also update the changelog');
    const currentCard = cardFor(session)!;
    expect(currentCard.version).not.toBe(staleCard.version);

    const beforeCalls = model.calls;
    const confirm = await session.handleOperatorTurn('yes', {
      proposalRef: { version: staleCard.version, hash: staleCard.hash },
    });

    // Mechanical refusal: model-free, nothing released, nothing delivered.
    expect(confirm.released).toBeNull();
    expect(confirm.utteranceClass).toBe('confirm');
    expect(model.calls).toBe(beforeCalls);
    expect(delivery.deliveredTexts()).toEqual([]);
    // Honest: the refusal names the situation and quotes the CURRENT text.
    expect(confirm.reply).toContain('out of date');
    expect(confirm.reply).toContain('hold phase 3 for review');
    expect(confirm.reply).toContain('update the changelog');

    // The draft is NOT consumed: the current card's confirm now releases both parts.
    const fresh = cardFor(session)!;
    const retry = await session.handleOperatorTurn('yes', {
      proposalRef: { version: fresh.version, hash: fresh.hash },
    });
    expect(retry.released?.text).toBe('hold phase 3 for review\nand also update the changelog');
    expect(delivery.deliveredTexts()).toEqual(['hold phase 3 for review\nand also update the changelog']);
  });

  it('proposal replaced (cancel, then the same words re-typed): the OLD identity still refuses — version, not just bytes', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3 for review');
    const staleCard = cardFor(session)!;

    await session.handleOperatorTurn('no, cancel that');
    // The operator re-types the very same words: identical bytes, NEW proposal.
    await session.handleOperatorTurn('tell the worker to hold phase 3 for review');
    const currentCard = cardFor(session)!;
    expect(currentCard.hash).toBe(staleCard.hash); // same bytes…
    expect(currentCard.version).not.toBe(staleCard.version); // …but not the same proposal

    const confirm = await session.handleOperatorTurn('yes', {
      proposalRef: { version: staleCard.version, hash: staleCard.hash },
    });
    expect(confirm.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
    expect(confirm.reply).toContain('out of date');
  });

  it('proposal cancelled: a confirm on the dead card is the nothing-pending dead end', async () => {
    const { session, delivery, model } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3 for review');
    const staleCard = cardFor(session)!;
    await session.handleOperatorTurn('no, cancel that');
    const beforeCalls = model.calls;

    const confirm = await session.handleOperatorTurn('yes', {
      proposalRef: { version: staleCard.version, hash: staleCard.hash },
    });
    expect(confirm.released).toBeNull();
    expect(confirm.reply).toBe(NOTHING_PENDING_ACK);
    expect(model.calls).toBe(beforeCalls);
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('second confirm after a successful release: the consumed proposal cannot release again, even with its identity', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3 for review');
    const card = cardFor(session)!;
    const first = await session.handleOperatorTurn('yes', {
      proposalRef: { version: card.version, hash: card.hash },
    });
    expect(first.released?.text).toBe('hold phase 3 for review');
    expect(delivery.deliveredTexts()).toEqual(['hold phase 3 for review']);

    const second = await session.handleOperatorTurn('yes', {
      proposalRef: { version: card.version, hash: card.hash },
    });
    expect(second.released).toBeNull();
    expect(second.reply).toBe(NOTHING_PENDING_ACK);
    expect(delivery.deliveredTexts()).toEqual(['hold phase 3 for review']);
  });

  it('cross-lane mutation with a DIFFERENT shape: version and hash must BOTH match (either mismatch refuses)', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('first instruction');
    const card = cardFor(session)!;

    // Same version, wrong hash → refuse.
    const wrongHash = await session.handleOperatorTurn('yes', {
      proposalRef: { version: card.version, hash: 'deadbeef' },
    });
    expect(wrongHash.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);

    // Wrong version, right hash → refuse.
    const wrongVersion = await session.handleOperatorTurn('yes', {
      proposalRef: { version: card.version + 1000, hash: card.hash },
    });
    expect(wrongVersion.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);

    // The draft survived both probes.
    expect(cardFor(session)?.text).toBe('first instruction');
  });

  it('a MATCHING echo releases exactly the displayed bytes (the whole point)', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3 for review');
    const card = cardFor(session)!;
    const confirm = await session.handleOperatorTurn('yes', {
      proposalRef: { version: card.version, hash: card.hash },
    });
    expect(confirm.released?.text).toBe(card.text);
    expect(delivery.deliveredTexts()).toEqual([card.text]);
  });
});

describe("proposal identity — the 'original' variant gate", () => {
  it("refuses 'original' when the current proposal advertised none (clean draft), and keeps the draft", async () => {
    const { session, delivery, model } = makeSession();
    await session.handleOperatorTurn('run the deploy checks');
    const card = cardFor(session)!;
    expect(card.cleaned).toBe(false);
    const beforeCalls = model.calls;

    const confirm = await session.handleOperatorTurn('yes', {
      releaseVariant: 'original',
      proposalRef: { version: card.version, hash: card.hash },
    });
    expect(confirm.released).toBeNull();
    expect(model.calls).toBe(beforeCalls);
    expect(delivery.deliveredTexts()).toEqual([]);
    // Mechanical honesty: names the situation and quotes the draft.
    expect(confirm.reply).toContain('deploy checks');

    // Draft intact: the ordinary confirm still releases the card's text.
    const retry = await session.handleOperatorTurn('yes', {
      proposalRef: { version: card.version, hash: card.hash },
    });
    expect(retry.released?.text).toBe(card.text);
    expect(delivery.deliveredTexts()).toEqual([card.text]);
  });

  it("serves 'original' when the current proposal advertised one — the exact raw bytes", async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('Um, tell the worker to rerun the suite');
    const card = cardFor(session)!;
    expect(card.cleaned).toBe(true);
    expect(card.original).toBe('Um, tell the worker to rerun the suite');

    const confirm = await session.handleOperatorTurn('yes', {
      releaseVariant: 'original',
      proposalRef: { version: card.version, hash: card.hash },
    });
    expect(confirm.released?.text).toBe(card.original);
    expect(delivery.deliveredTexts()).toEqual(['Um, tell the worker to rerun the suite']);
  });

  it("refuses 'original' against a STALE identity too — the gate reads the current proposal, not the echoed one", async () => {
    const { session, delivery } = makeSession();
    // First draft: tidied, original advertised.
    await session.handleOperatorTurn('Um, tell the worker to rerun the suite');
    const staleCard = cardFor(session)!;
    // The draft moves on to a clean instruction: no original advertised any more.
    await session.handleOperatorTurn('no, cancel that');
    await session.handleOperatorTurn('run the deploy checks');
    const currentCard = cardFor(session)!;
    expect(currentCard.cleaned).toBe(false);

    // An echo of the STALE (cleaned) card must not unlock the raw bytes of
    // the CURRENT draft — the gate checks what is held NOW.
    const confirm = await session.handleOperatorTurn('yes', {
      releaseVariant: 'original',
      proposalRef: { version: staleCard.version, hash: staleCard.hash },
    });
    expect(confirm.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
    expect(confirm.reply).toContain('out of date');
  });

  it("the gate holds without any echo at all — a bare 'yes' with variant 'original' on a clean draft refuses", async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('run the deploy checks');
    const confirm = await session.handleOperatorTurn('yes', { releaseVariant: 'original' });
    expect(confirm.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
    // And the draft survives for the honest confirm.
    const retry = await session.handleOperatorTurn('yes');
    expect(retry.released?.text).toBe('run the deploy checks');
    expect(delivery.deliveredTexts()).toEqual(['run the deploy checks']);
  });
});

describe('proposal identity — the voice path is untouched', () => {
  it('a bare confirm (no echo) releases the current draft exactly as before', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3 for review');
    const yes = await session.handleOperatorTurn('yes');
    expect(yes.released?.text).toBe('hold phase 3 for review');
    expect(delivery.deliveredTexts()).toEqual(['hold phase 3 for review']);
  });

  it('the lapsed-window refusal still runs FIRST and is unchanged', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3 for review');
    // Age the confirmation window past its limit (default 6 turns).
    for (let i = 0; i < 6; i++) await session.handleOperatorTurn('did you send it?');
    const stale = await session.handleOperatorTurn('yes');
    expect(stale.released).toBeNull();
    expect(stale.reply).toContain('still want that sent');
    // And after the re-arm, the fresh card identity releases.
    const card = cardFor(session)!;
    const retry = await session.handleOperatorTurn('yes', {
      proposalRef: { version: card.version, hash: card.hash },
    });
    expect(retry.released?.text).toBe('hold phase 3 for review');
  });
});
