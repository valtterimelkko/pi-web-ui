import { describe, it, expect, vi } from 'vitest';

// RED: the receipt vocabulary does not exist yet.
import { RECEIPT_ACK, receiptAckFor } from '../../../src/talker/ack.js';
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
    expect(session.proposals.pending?.text).toBe(INSTRUCTION);
    // The confirmation step still follows and still releases the verbatim text.
    const yes = await session.handleOperatorTurn('yes, go ahead');
    expect(delivery.deliveredTexts()).toEqual([INSTRUCTION]);
    expect(yes.released?.text).toBe(INSTRUCTION);
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

  it('at the harness level: three spoken statements, then one answer-ready moment, produce exactly one receipt', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn('tell the worker to rebase onto main');
    await session.handleOperatorTurn('also tell it to rerun the flaky suite');
    await session.handleOperatorTurn('and keep the docs phase for later');
    expect(session.utteranceLog.unacknowledgedCount()).toBe(3);
    expect(session.utteranceLog.takeReceipt()).toBe(3); // one receipt for the batch
    expect(session.utteranceLog.takeReceipt()).toBeNull(); // not a second
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
    await session.handleOperatorTurn(INSTRUCTION); // the model's reply is imposter text
    const due = session.utteranceLog.takeReceipt();
    expect(due).toBe(1);
    // The spoken receipt is the fixed harness string — byte-identical every time,
    // never the model's composition:
    expect(receiptAckFor(due ?? -1)).toBe(RECEIPT_ACK);
    expect(receiptAckFor(due ?? -1)).not.toBe(imposterReply);
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
    // The receipt state is untouched by the failure — the harness still owes one:
    expect(session.utteranceLog.unacknowledgedCount()).toBe(1);
    expect(receiptAckFor(session.utteranceLog.takeReceipt() ?? -1)).toBe(RECEIPT_ACK);
  });

  it('a model reply cannot re-arm or extend a receipt that has already been given', async () => {
    const receiptShapedReply = 'Noted — still holding that. And three more receipts for you.';
    const { session } = makeSession({ model: stubModel(receiptShapedReply) });
    await session.handleOperatorTurn(INSTRUCTION); // exactly one operator utterance; the model's reply is receipt-shaped text
    expect(session.utteranceLog.takeReceipt()).toBe(1); // the one receipt covers the operator utterance only
    // The model's receipt-shaped reply never entered the verbatim log as an
    // operator utterance, so it cannot re-arm or mint another receipt:
    expect(session.utteranceLog.takeReceipt()).toBeNull();
    expect(session.utteranceLog.takeReceipt()).toBeNull();
    expect(session.utteranceLog.unacknowledgedCount()).toBe(0);
  });

  it('producing the receipt never relays and never widens the gate', async () => {
    const delivery = createNullDelivery();
    const deliverSpy = vi.spyOn(delivery, 'deliver');
    const { session } = makeSession({ delivery });
    await session.handleOperatorTurn(INSTRUCTION);
    const due = session.utteranceLog.takeReceipt();
    expect(due).toBe(1);
    expect(deliverSpy).not.toHaveBeenCalled(); // receipt ≠ relay
    expect(session.proposals.pending?.text).toBe(INSTRUCTION); // confirmation still required
    const yes = await session.handleOperatorTurn('yes, go ahead');
    expect(delivery.deliveredTexts()).toEqual([INSTRUCTION]);
    expect(yes.released?.text).toBe(INSTRUCTION);
    expect(deliverSpy).toHaveBeenCalledTimes(1); // exactly one send, exactly from the confirm branch
  });
});
