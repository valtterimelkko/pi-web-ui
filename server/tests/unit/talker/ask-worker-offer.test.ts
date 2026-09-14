import { describe, it, expect, vi } from 'vitest';

// RED: module does not exist yet.
import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import { MODEL_FAILURE_REPLY } from '../../../src/talker/ack.js';
import {
  ASK_WORKER_MARKER,
  isAskWorkerOffer,
  stripAskWorkerMarker,
} from '../../../src/talker/ask-worker.js';
import type {
  ModelTurnResult,
  TalkerModelClient,
  WorkerStateSnapshot,
} from '../../../src/talker/types.js';

/**
 * P18 package C, deliverable 1 — "I can't answer that — shall I ask the
 * worker?".
 *
 * The talker's knowledge is a bounded window, so questions about older work
 * fall outside it. Before this the talker could only say "I can't tell", which
 * left the operator to rephrase the question themselves. The upgrade turns
 * that honest failure into a next step — an OFFER to pass the question on —
 * and doing so reuses the existing confirmation gate entirely:
 *
 *   model offers  →  the operator's own question joins the draft, held verbatim
 *                    (nothing delivered, nothing sent)
 *   operator says yes → the release branch delivers THAT question, word for
 *                    word (never the model's paraphrase)
 *
 * What is pinned here, and must not soften:
 *   - the relayed text is the operator's verbatim question, by utterance id;
 *   - the model cannot release anything: the offer only ever creates a
 *     CANDIDATE, and a candidate still needs the operator's mechanical
 *     confirmation (same as every other proposal);
 *   - the offer fires only for a question the talker could not answer — an
 *     offer attached to a statement or to a meta-send question widens nothing;
 *   - the marker never reaches the operator's ear;
 *   - a model failure can never offer.
 */

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'running the refactor',
  children: ['worker 1: running'],
  lastAssistantText: 'Two suites are green so far.',
};

function stubModel(
  reply: string | ((messages: Array<{ role: string; content: string }>) => string)
): TalkerModelClient & { calls: Array<Array<{ role: string; content: string }>> } {
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

function makeSession(model: ReturnType<typeof stubModel>) {
  const delivery = createNullDelivery();
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-1',
    snapshotProvider: () => SNAPSHOT,
  });
  return { session, model, delivery };
}

const QUESTIONS = {
  beyondWindow: 'what did the worker find about the retry bug in the March refactor?',
  status: "how's it going?",
};

const INSTRUCTION = 'tell the worker to hold phase 3 until my review';
// P25 (semi-verbatim relay, docs/VOICE-ORCHESTRATOR-FEASIBILITY.md §3.2
// rule 3): the draft and the release carry the operator's words MINUS the
// channel — a commission frame like 'tell the worker to ...' is how the
// operator addresses the relay, not part of the instruction. EXPECTATION
// constants below hold the relay form; spoken-input call sites keep the raw
// utterance (the harness normalises at draft time, before approval).
const RELAYED_INSTRUCTION = 'hold phase 3 until my review';
const META = 'did you send it yet?';

const OFFER = `I can't tell from what I hold — shall I ask the worker? ${ASK_WORKER_MARKER}`;

describe('the ask-worker marker is a mechanical, end-anchored tag', () => {
  it('is recognised at the very end of the reply, with trailing whitespace tolerated', () => {
    expect(isAskWorkerOffer(`Shall I ask the worker? ${ASK_WORKER_MARKER}`)).toBe(true);
    expect(isAskWorkerOffer(`Shall I ask the worker? ${ASK_WORKER_MARKER}\n`)).toBe(true);
    expect(isAskWorkerOffer(`Shall I ask the worker?  ${ASK_WORKER_MARKER}  `)).toBe(true);
  });

  it('is NOT an offer when it does not end the reply or is absent', () => {
    expect(isAskWorkerOffer('Shall I ask the worker?')).toBe(false);
    expect(isAskWorkerOffer(`${ASK_WORKER_MARKER} shall I ask the worker?`)).toBe(false);
    expect(isAskWorkerOffer(`Shall I ask the worker? ${ASK_WORKER_MARKER} I think that is best.`)).toBe(false);
  });

  it('is stripped from what the operator hears, wherever it appears', () => {
    expect(stripAskWorkerMarker(`Shall I ask the worker? ${ASK_WORKER_MARKER}`)).toBe(
      'Shall I ask the worker?'
    );
    expect(stripAskWorkerMarker(`${ASK_WORKER_MARKER} Shall I ask?`)).toBe('Shall I ask?');
    expect(stripAskWorkerMarker(`Shall ${ASK_WORKER_MARKER} I ask?`)).toBe('Shall  I ask?');
    expect(stripAskWorkerMarker('No marker here.')).toBe('No marker here.');
  });
});

describe('P18/1 — the offer holds the operator’s question verbatim, and releases nothing yet', () => {
  it('a question the talker cannot answer becomes a HELD candidate, not a send', async () => {
    const { session, delivery } = makeSession(stubModel(OFFER));
    const result = await session.handleOperatorTurn(QUESTIONS.beyondWindow);

    expect(result.released).toBeNull();
    expect(result.askWorkerOffer).toBe(true);
    expect(delivery.deliveredTexts()).toEqual([]);
    // The candidate is the OPERATOR'S question — held by reference, verbatim.
    expect(session.proposals.pending?.text).toBe(QUESTIONS.beyondWindow);
  });

  it('the confirmation then delivers the operator’s verbatim question — never the model’s paraphrase', async () => {
    const model = stubModel(
      `I think you are asking whether the March refactor found the retry bug. Shall I ask the worker? ${ASK_WORKER_MARKER}`
    );
    const { session, delivery } = makeSession(model);
    await session.handleOperatorTurn(QUESTIONS.beyondWindow);
    expect(delivery.deliveredTexts()).toEqual([]);

    const release = await session.handleOperatorTurn('yes, send that');
    expect(release.released?.text).toBe(QUESTIONS.beyondWindow);
    expect(delivery.deliveredTexts()).toEqual([QUESTIONS.beyondWindow]);
    // Not a paraphrase, not a reworded version of the model's sentence.
    expect(delivery.deliveredTexts()[0]).not.toContain('March refactor found');
  });

  it('the marker itself never reaches the operator’s ear', async () => {
    const { session } = makeSession(stubModel(OFFER));
    const result = await session.handleOperatorTurn(QUESTIONS.beyondWindow);
    expect(result.reply).not.toContain(ASK_WORKER_MARKER);
    expect(result.reply).toMatch(/shall i ask the worker\?/i);
    // History records what was actually heard, marker-free.
    const entries = session.history.entries();
    const last = entries[entries.length - 1];
    expect(last.content).not.toContain(ASK_WORKER_MARKER);
  });

  it('the offer is a RECEIPT moment like any other draft opening (rule 2)', async () => {
    const { session } = makeSession(stubModel(OFFER));
    const result = await session.handleOperatorTurn(QUESTIONS.beyondWindow);
    expect(result.receiptAck).toBe('Noted — still holding that.');
  });
});

describe('P18/1 — the offer never widens the gate', () => {
  it('an offer attached to a STATEMENT creates nothing (statements already have their own path)', async () => {
    const { session, delivery } = makeSession(stubModel(OFFER));
    const result = await session.handleOperatorTurn(INSTRUCTION);
    expect(result.askWorkerOffer).toBeUndefined();
    // The statement still accumulates as an ordinary draft part — unchanged.
    expect(session.proposals.pending?.text).toBe(RELAYED_INSTRUCTION);
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('an offer attached to a META-SEND question creates nothing and leaves the draft untouched', async () => {
    const { session, delivery } = makeSession(stubModel(OFFER));
    await session.handleOperatorTurn(INSTRUCTION);
    const result = await session.handleOperatorTurn(META);
    expect(result.askWorkerOffer).toBeUndefined();
    // The draft still holds exactly the instruction — the meta question did
    // not become a relay candidate.
    expect(session.proposals.pending?.text).toBe(RELAYED_INSTRUCTION);
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('the model cannot release: without an offer, a question is never a candidate and a yes delivers nothing', async () => {
    const { session, delivery } = makeSession(stubModel('All quiet — still on step three.'));
    const asked = await session.handleOperatorTurn(QUESTIONS.status);
    expect(asked.askWorkerOffer).toBeUndefined();
    expect(session.proposals.pending).toBeNull();

    const yes = await session.handleOperatorTurn('yes, go ahead');
    expect(yes.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('a model failure never offers — the honest fallback is not a proposal', async () => {
    const session = new TalkerSession({
      model: {
        async completeTurn() {
          throw new Error('provider 502');
        },
      },
      delivery: createNullDelivery(),
      workerSessionId: 'worker-1',
      snapshotProvider: () => SNAPSHOT,
    });
    const result = await session.handleOperatorTurn(QUESTIONS.beyondWindow);
    expect(result.reply).toBe(MODEL_FAILURE_REPLY);
    expect(result.askWorkerOffer).toBeUndefined();
    expect(session.proposals.pending).toBeNull();
  });

  it('the offer only ever creates a candidate: the delivery adapter is not touched by an offer turn', async () => {
    const delivery = createNullDelivery();
    const deliverSpy = vi.spyOn(delivery, 'deliver');
    const session = new TalkerSession({
      model: stubModel(OFFER),
      delivery,
      workerSessionId: 'worker-1',
      snapshotProvider: () => SNAPSHOT,
    });
    await session.handleOperatorTurn(QUESTIONS.beyondWindow);
    expect(deliverSpy).not.toHaveBeenCalled();
    await session.handleOperatorTurn('yes');
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliverSpy.mock.calls[0][0].text).toBe(QUESTIONS.beyondWindow);
  });

  it('an offer while a draft is already held ADDS the question rather than replacing the draft', async () => {
    const { session, delivery } = makeSession(stubModel(OFFER));
    await session.handleOperatorTurn(INSTRUCTION);
    await session.handleOperatorTurn(QUESTIONS.beyondWindow);
    // Both parts are held — nothing was silently replaced (§4.2).
    expect(session.proposals.snapshotDraft()?.utterances.map(u => u.text)).toEqual([
      RELAYED_INSTRUCTION, // P25
      QUESTIONS.beyondWindow, // a question with no strippable channel relays unchanged
    ]);
    expect(delivery.deliveredTexts()).toEqual([]);
  });
});
