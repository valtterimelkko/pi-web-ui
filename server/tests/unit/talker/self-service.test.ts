import { describe, it, expect } from 'vitest';

// RED first (P22): today an imperative addressed to the TALKER — "summarise
// what has been done in this session" — is not a question, so it classifies
// as `statement` and handleOperatorTurn appends it to the draft
// unconditionally. The operator's own words sit in the harness as a pending
// WORKER instruction; the model offers to relay them back at the operator;
// and a stray "yes" releases them. The assertions below describe the repair
// and FAIL against the current code — the failure output shows the draft
// holding the operator's words.
import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import { MODEL_FAILURE_REPLY, NOTHING_PENDING_ACK, RECEIPT_ACK } from '../../../src/talker/ack.js';
import type {
  ModelTurnResult,
  TalkerModelClient,
  WorkerStateSnapshot,
} from '../../../src/talker/types.js';

/**
 * P22 — requests addressed to the talker must not become worker instructions.
 *
 * The system had two concepts: an instruction for the worker (hold, confirm,
 * relay) and a question the talker cannot answer (offer to ask the worker).
 * It had none for a request the talker can fulfil itself from what it
 * already holds — summarise the session, read the queue back, restate what
 * is pending. Those arrived as imperatives with no "?", classified as
 * `statement`, and were drafted verbatim as worker instructions.
 *
 * The repair follows the [[ask-worker]] mould, narrowed: the model may end a
 * reply with the tag [[to-talker]] when it judged the utterance was
 * addressed to it and it answered from what it holds; the harness then does
 * not draft the utterance. What is pinned here, and must not soften:
 *   - suppression only — the tag can keep words OUT of the draft, never put
 *     anything in and never release anything, so a wrong guess is always the
 *     safe direction (a mis-marked instruction leaves nothing pending, and a
 *     later "yes" meets the mechanical nothing-pending dead end, not a send);
 *   - the tag is honoured only at the very end of a reply, and only on
 *     statement-classified turns — worker-directed questions keep their own
 *     path, so model behaviour cannot widen the gate;
 *   - an unmarked worker instruction — including an imperative — drafts and
 *     releases exactly as before: the distinction must not blunt the gate;
 *   - the tag is never spoken, a marked utterance earns no receipt, and a
 *     model failure (no marker possible) still drafts.
 */

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'running the refactor',
  children: ['worker 1: running'],
  lastAssistantText: 'The parser piece is done; tests are next.',
  recentHistory: [
    { role: 'user', text: 'run the refactor plan, phase 1 only' },
    { role: 'assistant', text: 'Phase 1 is done — parser rewritten, suites green.' },
  ],
  historyTotal: 2,
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

/** Deliberately literal: the tag is protocol, pinned byte-for-byte. */
const MARKER = '[[to-talker]]';

const REQUEST = 'summarise what has been done in this session';
const INSTRUCTION = 'tell the worker to rebase the branch';
// P25 (semi-verbatim relay, docs/VOICE-ORCHESTRATOR-FEASIBILITY.md §3.2
// rule 3): the draft and the release carry the operator's words MINUS the
// channel — a commission frame like 'tell the worker to ...' is how the
// operator addresses the relay, not part of the instruction. EXPECTATION
// constants below hold the relay form; spoken-input call sites keep the raw
// utterance (the harness normalises at draft time, before approval).
const RELAYED_INSTRUCTION = 'rebase the branch';

const SUMMARY_REPLY = `Sure — you asked it to run phase 1 of the refactor, and the parser part is done with suites green. ${MARKER}`;

describe('P22 — a request addressed to the talker is answered, never held', () => {
  it('the defect case: an imperative self-service request leaves NOTHING in the draft', async () => {
    const { session, delivery } = makeSession(stubModel(SUMMARY_REPLY));
    const result = await session.handleOperatorTurn(REQUEST);

    // The words were never meant for the worker — nothing is held for one.
    expect(session.proposals.pending).toBeNull();
    // Nothing opened a composition batch, so no receipt is owed either.
    expect(result.receiptAck ?? null).toBeNull();
    // The harness reports that the mark was honoured.
    expect(result.addressedToTalker).toBe(true);
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('the tag never reaches the operator’s ear, and the answer itself is still spoken', async () => {
    const { session } = makeSession(stubModel(SUMMARY_REPLY));
    const result = await session.handleOperatorTurn(REQUEST);
    expect(result.reply).not.toContain(MARKER);
    expect(result.reply).toMatch(/parser/i);
    // History records what was actually heard, tag-free.
    const entries = session.history.entries();
    expect(entries[entries.length - 1].content).not.toContain(MARKER);
  });

  it('a tag buried mid-reply is model noise: the utterance is drafted and the tag is still stripped', async () => {
    const { session } = makeSession(
      stubModel(`I could pass that on. ${MARKER} Anyway — the parser part is done.`)
    );
    const result = await session.handleOperatorTurn(REQUEST);
    expect(result.addressedToTalker).toBeUndefined();
    // Not honoured: the safe direction is that the words stay held.
    expect(session.proposals.pending?.text).toBe(REQUEST);
    expect(result.reply).not.toContain(MARKER);
  });

  it('after an answered request, "yes" meets the mechanical dead end — no relay, no model call', async () => {
    const { session, model, delivery } = makeSession(stubModel(SUMMARY_REPLY));
    await session.handleOperatorTurn(REQUEST);
    model.calls.length = 0;

    const yes = await session.handleOperatorTurn('yes');
    expect(yes.released).toBeNull();
    expect(yes.reply).toBe(NOTHING_PENDING_ACK);
    expect(yes.modelCalled).toBe(false);
    expect(delivery.deliveredTexts()).toEqual([]);
  });
});

describe('P22 — a genuine worker instruction still drafts and still releases', () => {
  it('an unmarked imperative instruction drafts verbatim and releases on confirmation', async () => {
    const { session, delivery } = makeSession(stubModel('Got it — shall I send that to the worker?'));
    const t1 = await session.handleOperatorTurn(INSTRUCTION);

    expect(t1.addressedToTalker).toBeUndefined();
    expect(session.proposals.pending?.text).toBe(RELAYED_INSTRUCTION);
    expect(t1.receiptAck).toBe(RECEIPT_ACK);

    const yes = await session.handleOperatorTurn('yes, go ahead');
    expect(yes.released?.text).toBe(RELAYED_INSTRUCTION);
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION]);
  });
});

describe('P22 — a wrong mark is safe and self-correcting, and never widens the gate', () => {
  it('a genuine instruction mis-marked as self-service leaves nothing pending — a later yes cannot send', async () => {
    const { session, delivery } = makeSession(stubModel(`Noted, I will take care of that. ${MARKER}`));
    const t1 = await session.handleOperatorTurn(INSTRUCTION);

    // The harness honoured the (wrong) mark: nothing is held.
    expect(t1.addressedToTalker).toBe(true);
    expect(session.proposals.pending).toBeNull();

    // So the operator's yes cannot send anything — the F2 dead end, not a relay.
    const yes = await session.handleOperatorTurn('yes');
    expect(yes.released).toBeNull();
    expect(yes.reply).toBe(NOTHING_PENDING_ACK);
    expect(yes.modelCalled).toBe(false);
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('a tag on a worker-directed QUESTION is not honoured — questions keep their own classification', async () => {
    const { session, delivery } = makeSession(stubModel(`Shall I have it rebase? ${MARKER}`));
    const q = await session.handleOperatorTurn('could you ask the worker to rebase the branch?');

    expect(q.addressedToTalker).toBeUndefined();
    expect(q.receiptAck).toBe(RECEIPT_ACK);
    expect(q.reply).not.toContain(MARKER);
    expect(session.proposals.pending?.text).toBe('rebase the branch?'); // P25

    const yes = await session.handleOperatorTurn('yes');
    expect(delivery.deliveredTexts()).toEqual(['rebase the branch?']); // P25
  });

  it('a marked continuing utterance never destroys the draft held so far', async () => {
    const model = stubModel((messages) => {
      const last = messages[messages.length - 1].content;
      return last.includes('summarise')
        ? `Here is the recap: one instruction held, nothing sent yet. ${MARKER}`
        : 'Got it — shall I send that to the worker?';
    });
    const { session, delivery } = makeSession(model);
    await session.handleOperatorTurn(INSTRUCTION);

    const second = await session.handleOperatorTurn('and also summarise what has been done so far');
    expect(second.addressedToTalker).toBe(true);
    // Only the genuine instruction is held — the recap request joined nothing.
    expect(session.proposals.snapshotDraft()?.utterances.map(u => u.text)).toEqual([RELAYED_INSTRUCTION]);

    const yes = await session.handleOperatorTurn('yes, go ahead');
    expect(yes.released?.text).toBe(RELAYED_INSTRUCTION);
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION]);
  });
});

describe('P22 — residue and failure edges', () => {
  it('a marked cancel residue is answered, not held', async () => {
    const model = stubModel((messages) => {
      const last = messages[messages.length - 1].content;
      return last.includes('summarise')
        ? `Recap: the rebase instruction was cancelled, nothing is queued. ${MARKER}`
        : 'Got it — shall I send that to the worker?';
    });
    const { session } = makeSession(model);
    await session.handleOperatorTurn(INSTRUCTION); // draft 1 → its own receipt

    const breath = await session.handleOperatorTurn('never mind. actually, summarise what has been done instead');
    expect(breath.cancelled).toBe(true);
    expect(breath.addressedToTalker).toBe(true);
    expect(session.proposals.pending).toBeNull();
    // The residue joined no batch, so no receipt for it either.
    expect(breath.receiptAck ?? null).toBeNull();
  });

  it('a model failure on a statement still drafts — no marker exists to honour', async () => {
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
    const result = await session.handleOperatorTurn(INSTRUCTION);
    expect(result.reply).toBe(MODEL_FAILURE_REPLY);
    expect(result.addressedToTalker).toBeUndefined();
    // Deferral must not lose the operator's words when the model is down.
    expect(session.proposals.pending?.text).toBe(RELAYED_INSTRUCTION);
    expect(result.receiptAck).toBe(RECEIPT_ACK);
  });
});
