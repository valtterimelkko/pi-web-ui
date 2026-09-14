import { describe, it, expect, vi } from 'vitest';

// RED: the receipt vocabulary does not exist yet.
import { RECEIPT_ACK, RELEASE_ACK, NOTHING_PENDING_ACK, NOTHING_TO_CANCEL_ACK, receiptAckFor } from '../../../src/talker/ack.js';
import { UtteranceLog } from '../../../src/talker/pending-proposal.js';
import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import type { TalkerModelClient, ModelTurnResult, WorkerStateSnapshot } from '../../../src/talker/types.js';

/**
 * Receipt ack (Drive Mode Two-Lane plan §4.1 rule 2) — three properties, each
 * with its own red-then-green round:
 *
 *   1. A receipt, never an agreement. It must not be readable as assent or as
 *      an action taken; at ack time nothing has been relayed and the explicit
 *      confirmation step still follows. The exact strings are pinned.
 *   2. At most once per relay — never once per utterance. Three operator
 *      utterances in a row produce exactly one receipt when the answer is
 *      ready, not three.
 *   3. Produced by the harness, never by the model: a fixed vocabulary,
 *      selected mechanically from harness state. A model reply can neither
 *      substitute for nor suppress it.
 *
 * The release gate is untouched by design: takeForRelease() stays atomic and
 * release-time-staleness-enforcing; release() stays reachable only from the
 * confirm branch. These tests additionally assert the receipt path does not
 * widen it.
 */

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'supervising two workers',
  recentEvents: ['watching worker 1'],
  children: ['worker 1: running, 22m'],
  pendingItems: ['phase 3 held for the operator'],
  lastAssistantText: 'Both are running.',
};

function stubModel(reply: string | ((messages: Array<{ role: string; content: string }>) => string)): TalkerModelClient & { calls: Array<Array<{ role: string; content: string }>> } {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  return {
    calls,
    async completeTurn(messages): Promise<ModelTurnResult> {
      calls.push(messages);
      const text = typeof reply === 'function' ? reply(messages) : reply;
      return { text, ttftMs: 12, totalMs: 40 };
    },
  };
}

function makeSession(overrides?: { model?: TalkerModelClient; delivery?: ReturnType<typeof createNullDelivery>; snapshot?: WorkerStateSnapshot }) {
  const delivery = overrides?.delivery ?? createNullDelivery();
  const model = overrides?.model ?? stubModel('Understood — shall I send that to the worker?');
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-1',
    snapshotProvider: () => overrides?.snapshot ?? SNAPSHOT,
  });
  return { session, model, delivery };
}

const INSTRUCTION = 'tell the worker to hold phase 3 until my review';
// P25 (semi-verbatim relay, docs/VOICE-ORCHESTRATOR-FEASIBILITY.md §3.2
// rule 3): the draft and the release carry the operator's words MINUS the
// channel — a commission frame like 'tell the worker to ...' is how the
// operator addresses the relay, not part of the instruction. EXPECTATION
// constants below hold the relay form; spoken-input call sites keep the raw
// utterance (the harness normalises at draft time, before approval).
const RELAYED_INSTRUCTION = 'hold phase 3 until my review';

describe('PROPERTY 1: the receipt ack is a receipt, never an agreement', () => {
  it('the receipt ack string is pinned exactly', () => {
    expect(RECEIPT_ACK).toBe('Noted — still holding that.');
  });

  it('the receipt ack cannot be read as assent, a send, or an action taken', () => {
    // Never a send, never a relay claim:
    expect(RECEIPT_ACK).not.toMatch(/\bsending\b|\bsend\b|\bsent\b|\brelayed?\b/i);
    // Never an agreement or an action taken:
    expect(RECEIPT_ACK).not.toMatch(/\bwill do\b|\bright away\b|\bon it\b|\bdoing it\b|\bdoing that\b|\bconsider it done\b|\bwill act\b/i);
    expect(RECEIPT_ACK).not.toMatch(/\byes\b|\bsure\b|\bokay\b|\bok\b|\bagreed\b/i);
    // It must say, in words, that the utterance is being HELD — not acted on:
    expect(RECEIPT_ACK).toMatch(/holding/i);
  });

  it('at the moment a receipt is due, nothing has been relayed and the confirmation step still follows', async () => {
    const delivery = createNullDelivery();
    const deliverSpy = vi.spyOn(delivery, 'deliver');
    const { session } = makeSession({ delivery });
    await session.handleOperatorTurn(INSTRUCTION);
    // The utterance is receipt-worthy, but the receipt step must not have
    // touched the worker, and the pending proposal must still be awaiting
    // its explicit confirmation.
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(delivery.deliveredTexts()).toEqual([]);
    expect(session.proposals.pending?.text).toBe(RELAYED_INSTRUCTION);
    // The confirmation step still follows and still releases the verbatim text.
    const yes = await session.handleOperatorTurn('yes, go ahead');
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION]);
    expect(yes.released?.text).toBe(RELAYED_INSTRUCTION);
  });
});

describe('PROPERTY 2: the receipt fires at most once per relay — never once per utterance', () => {
  it('one unacknowledged utterance yields exactly one receipt', () => {
    const log = new UtteranceLog();
    log.record('hold phase 3 until my review', 1);
    expect(log.unacknowledgedCount()).toBe(1);
    expect(log.takeReceipt()).toBe(1); // one receipt, covering one utterance
    expect(log.takeReceipt()).toBeNull(); // a second answer-ready moment: nothing is due
    expect(log.takeReceipt()).toBeNull();
    expect(log.unacknowledgedCount()).toBe(0);
  });

  it('three utterances in a row yield exactly one receipt — not three', () => {
    const log = new UtteranceLog();
    const a = log.record('tell the worker to rebase onto main', 1);
    const b = log.record('also rerun the flaky suite', 2);
    const c = log.record('and keep the docs phase for later', 3);
    expect(log.unacknowledgedCount()).toBe(3);
    expect(log.takeReceipt()).toBe(3); // ONE receipt covering all three
    expect(log.takeReceipt()).toBeNull(); // never a second receipt for the same batch
    // The acknowledgement marker lands on the verbatim records themselves —
    // no parallel store of utterances exists.
    expect(log.resolve(a.id)?.acknowledged).toBe(true);
    expect(log.resolve(b.id)?.acknowledged).toBe(true);
    expect(log.resolve(c.id)?.acknowledged).toBe(true);
    // The verbatim text stays byte-for-byte in the log regardless.
    expect(log.resolve(a.id)?.text).toBe('tell the worker to rebase onto main');
  });

  it('a new utterance after a receipt re-arms exactly one more receipt', () => {
    const log = new UtteranceLog();
    log.record('first instruction', 1);
    expect(log.takeReceipt()).toBe(1);
    log.record('second instruction', 2);
    expect(log.takeReceipt()).toBe(1);
    expect(log.takeReceipt()).toBeNull();
  });

  it('at the harness level: three spoken statements produce exactly one EMITTED receipt — on the turn that opened the batch', async () => {
    // Updated for the live emission path (P7/A11): the receipt is no longer a
    // condition a caller consumes by hand — the harness emits it on the turn
    // result, once per batch. The property is unchanged: one receipt per
    // relay, never one per utterance.
    const { session } = makeSession();
    const t1 = await session.handleOperatorTurn('tell the worker to rebase onto main');
    const t2 = await session.handleOperatorTurn('also tell it to rerun the flaky suite');
    const t3 = await session.handleOperatorTurn('and keep the docs phase for later');
    expect(t1.receiptAck).toBe(RECEIPT_ACK);
    expect(t2.receiptAck ?? null).toBeNull();
    expect(t3.receiptAck ?? null).toBeNull();
    // The verbatim records exist per utterance; the single receipt covers the
    // batch. No parallel store of utterances exists.
    expect(session.utteranceLog.size).toBe(3);
  });
});

describe('PROPERTY 3: produced by the harness, never by the model', () => {
  it('the selector is a pure function of harness state — it has no model-shaped input', () => {
    expect(receiptAckFor(0)).toBeNull();
    expect(receiptAckFor(1)).toBe(RECEIPT_ACK);
    expect(receiptAckFor(3)).toBe(RECEIPT_ACK);
    expect(receiptAckFor(50)).toBe(RECEIPT_ACK);
    expect(receiptAckFor(-1)).toBeNull();
  });

  it('a model reply that imitates or upgrades an acknowledgement cannot substitute for the receipt', async () => {
    const imposterReply = "Done — sending that to the worker for you right away.";
    const { session } = makeSession({ model: stubModel(imposterReply) });
    const result = await session.handleOperatorTurn(INSTRUCTION); // the model's reply is imposter text
    // The spoken receipt is the fixed harness string on the result —
    // byte-identical every time, never the model's composition:
    expect(result.receiptAck).toBe(RECEIPT_ACK);
    expect(result.receiptAck).not.toBe(imposterReply);
    // The imposter text remains what it is — conversational model output:
    expect(result.reply).toBe(imposterReply);
  });

  it('a model failure cannot suppress the receipt', async () => {
    const failingModel: TalkerModelClient = {
      async completeTurn() {
        throw new Error('provider down');
      },
    };
    const { session } = makeSession({ model: failingModel });
    const result = await session.handleOperatorTurn(INSTRUCTION); // conversational turn fails
    expect(result.error).toBeDefined(); // the model really did fail
    // The receipt is still emitted on the result — the failure suppresses nothing:
    expect(result.receiptAck).toBe(RECEIPT_ACK);
  });

  it('a model reply cannot re-arm or extend a receipt that has already been given', async () => {
    const receiptShapedReply = 'Noted — still holding that. And three more receipts for you.';
    const { session } = makeSession({ model: stubModel(receiptShapedReply) });
    const result = await session.handleOperatorTurn(INSTRUCTION); // exactly one operator utterance; the model's reply is receipt-shaped text
    expect(result.receiptAck).toBe(RECEIPT_ACK); // exactly the fixed string — not the model's extended version
    // The model's receipt-shaped reply never entered the verbatim log as an
    // operator utterance, so it cannot re-arm or mint another receipt:
    expect(session.utteranceLog.size).toBe(1);
  });

  it('producing the receipt never relays and never widens the gate', async () => {
    const delivery = createNullDelivery();
    const deliverSpy = vi.spyOn(delivery, 'deliver');
    const { session } = makeSession({ delivery });
    const result = await session.handleOperatorTurn(INSTRUCTION);
    expect(result.receiptAck).toBe(RECEIPT_ACK); // emitted at the answer-ready moment
    expect(deliverSpy).not.toHaveBeenCalled(); // receipt ≠ relay
    expect(session.proposals.pending?.text).toBe(RELAYED_INSTRUCTION); // confirmation still required
    const yes = await session.handleOperatorTurn('yes, go ahead');
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION]);
    expect(yes.released?.text).toBe(RELAYED_INSTRUCTION);
    expect(deliverSpy).toHaveBeenCalledTimes(1); // exactly one send, exactly from the confirm branch
  });
});

// ============================================================================
// LIVE EMISSION (A11 closure, P7): the receipt ack is emitted by the harness
// on the turn result — not merely consumable by hand. Before this package,
// takeReceipt() had zero callers outside tests: the receipt existed but never
// happened. The emission point is the answer-ready moment (plan §4.1 rule 2:
// "it fires once when the worker's answer is ready and at least one operator
// utterance has not been acknowledged"): the turn whose reply answers the
// utterance that OPENED the composition batch. One receipt per batch — never
// one per utterance — and only batch-opening turns consume one.
// ============================================================================

describe('LIVE EMISSION: the harness emits the receipt on the turn result', () => {
  it('the dead-end ack strings are pinned exactly — fixed vocabulary, no model wording', () => {
    expect(NOTHING_PENDING_ACK).toBe(
      "Nothing is held right now, so there is nothing to send. Say the instruction and I'll hold it for your go-ahead."
    );
    expect(NOTHING_TO_CANCEL_ACK).toBe('Nothing is held right now — there was nothing to cancel.');
    // Neither can be read as a promise or a send:
    for (const s of [NOTHING_PENDING_ACK, NOTHING_TO_CANCEL_ACK]) {
      expect(s).not.toMatch(/\bi'?ll send\b|\bi will send\b|\bsending that\b|\bshall i send\b|\bdone\b|\bcancelled that\b/i);
    }
  });

  it('a batch-opening instruction turn carries the receipt ack on its result', async () => {
    const delivery = createNullDelivery();
    const deliverSpy = vi.spyOn(delivery, 'deliver');
    const { session, model } = makeSession({ delivery });
    const result = await session.handleOperatorTurn(INSTRUCTION);
    expect(result.receiptAck).toBe(RECEIPT_ACK);
    // The receipt never races the gate: no relay, no model substitution —
    // the conversational reply still comes from the model, the receipt from
    // the fixed vocabulary.
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(result.modelCalled).toBe(true);
    expect(result.reply).not.toBe(RECEIPT_ACK);
    expect(session.proposals.pending?.text).toBe(RELAYED_INSTRUCTION);
    expect(model.calls.length).toBe(1);
  });

  it('a worker-directed question that opens a batch carries the receipt too', async () => {
    const { session } = makeSession();
    const result = await session.handleOperatorTurn('could you ask the worker to rebase onto main?');
    expect(result.receiptAck).toBe(RECEIPT_ACK);
    expect(session.proposals.pending?.text).toBe('rebase onto main?'); // P25: politeness + frame stripped
  });

  it('three statements in a row produce exactly ONE emitted receipt — on the first turn, not per utterance', async () => {
    const { session } = makeSession();
    const t1 = await session.handleOperatorTurn('tell the worker to rebase onto main');
    const t2 = await session.handleOperatorTurn('also tell it to rerun the flaky suite');
    const t3 = await session.handleOperatorTurn('and keep the docs phase for later');
    expect(t1.receiptAck).toBe(RECEIPT_ACK);
    expect(t2.receiptAck ?? null).toBeNull();
    expect(t3.receiptAck ?? null).toBeNull();
    // The verbatim records exist per utterance; the single emitted receipt
    // covered the batch opener. No parallel store of utterances exists.
    expect(session.utteranceLog.size).toBe(3);
  });

  it('after a release, a NEW composition batch earns exactly one more receipt (once per relay)', async () => {
    const { session, delivery } = makeSession();
    const t1 = await session.handleOperatorTurn(INSTRUCTION);
    expect(t1.receiptAck).toBe(RECEIPT_ACK);
    await session.handleOperatorTurn('yes, go ahead'); // release — its own ack, no receipt
    const t3 = await session.handleOperatorTurn('also tell the worker to rerun the flaky suite');
    expect(t3.receiptAck).toBe(RECEIPT_ACK);
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION]);
  });

  it('no receipt on turns that hold nothing new: status question, meta question, cancel, release, confirm dead-end', async () => {
    const { session } = makeSession();
    expect((await session.handleOperatorTurn("how's it going?")).receiptAck ?? null).toBeNull();
    await session.handleOperatorTurn(INSTRUCTION); // receipt fires here (batch opens)
    expect((await session.handleOperatorTurn('did you send it yet?')).receiptAck ?? null).toBeNull();
    // Cancel the draft, then a fresh instruction opens a new batch on its own turn.
    expect((await session.handleOperatorTurn('never mind')).receiptAck ?? null).toBeNull();
    expect(session.proposals.pending).toBeNull();
    const fresh = await session.handleOperatorTurn(INSTRUCTION);
    expect(fresh.receiptAck).toBe(RECEIPT_ACK);
    const release = await session.handleOperatorTurn('yes, go ahead');
    expect(release.receiptAck ?? null).toBeNull();
    expect(release.reply).toBe(RELEASE_ACK); // release keeps its own fixed ack
    // Confirm-shaped dead end (nothing pending): mechanical reply, no receipt.
    expect((await session.handleOperatorTurn('yes')).receiptAck ?? null).toBeNull();
  });

  it('a lapsed-draft reconfirmation turn does not emit a receipt', async () => {
    const model = stubModel('noted.');
    const session = new TalkerSession({
      model,
      delivery: createNullDelivery(),
      workerSessionId: 'w',
      snapshotProvider: () => SNAPSHOT,
      config: { maxPendingAgeTurns: 2 },
    });
    await session.handleOperatorTurn(INSTRUCTION); // receipt emitted (batch opens)
    await session.handleOperatorTurn('did you send it?');
    await session.handleOperatorTurn('did you send it?'); // window lapses
    const lapsedYes = await session.handleOperatorTurn('yes');
    expect(lapsedYes.released).toBeNull();
    expect(lapsedYes.receiptAck ?? null).toBeNull();
    expect(lapsedYes.reply).toContain('still want that sent');
  });

  it('a model failure on the batch-opening turn cannot suppress the emitted receipt', async () => {
    const failingModel: TalkerModelClient = {
      async completeTurn() {
        throw new Error('provider down');
      },
    };
    const { session } = makeSession({ model: failingModel });
    const result = await session.handleOperatorTurn(INSTRUCTION);
    expect(result.error).toBeDefined();
    expect(result.receiptAck).toBe(RECEIPT_ACK);
  });
});
