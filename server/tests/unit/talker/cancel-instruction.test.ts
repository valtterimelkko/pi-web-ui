import { describe, it, expect, vi } from 'vitest';

// Finding F1 (P7): a cancel-shaped utterance swallows an instruction spoken
// in the same breath (s5/t4: "Never mind, forget it. Back to the caching
// thing — tell it to leave caching alone entirely…"). The classifier reads
// the cancel first — the safe default for the gate — but the harness must
// not lose the instruction half: the cancel boundary ends the OLD draft and
// the residue composes fresh, so the operator's words are held verbatim and
// a later "yes" releases exactly what they said.
import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import { RECEIPT_ACK } from '../../../src/talker/ack.js';
import type { TalkerModelClient, ModelTurnResult, WorkerStateSnapshot } from '../../../src/talker/types.js';

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'refactoring the cache layer',
  recentEvents: ['editing cache.ts'],
  children: ['worker 1: running, 22m'],
  lastAssistantText: 'Working on it.',
};

function stubModel(reply: string): TalkerModelClient & { calls: Array<Array<{ role: string; content: string }>> } {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  return {
    calls,
    async completeTurn(messages): Promise<ModelTurnResult> {
      calls.push(messages);
      return { text: reply, ttftMs: 12, totalMs: 40 };
    },
  };
}

function makeSession() {
  const delivery = createNullDelivery();
  const deliverSpy = vi.spyOn(delivery, 'deliver');
  const model = stubModel('Noted — shall I send that?');
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-1',
    snapshotProvider: () => SNAPSHOT,
  });
  return { session, model, delivery, deliverSpy };
}

/** The exact utterance from the Phase 5 findings (s5/t4). */
const S5_T4 =
  "Never mind, forget it. Back to the caching thing — tell it to leave caching alone entirely, we're dropping that work.";
const S5_T4_RESIDUE =
  "Back to the caching thing — tell it to leave caching alone entirely, we're dropping that work.";

describe('F1: a cancel breath with an instruction keeps the instruction', () => {
  it('the s5/t4 utterance cancels the held draft AND captures the instruction half', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn('tell the worker to keep implementing the cache'); // a held draft
    expect(session.proposals.pending?.text).toBe('keep implementing the cache'); // P25: frame stripped

    const result = await session.handleOperatorTurn(S5_T4);
    // The cancel boundary did its job — the OLD draft is gone…
    expect(result.cancelled).toBe(true);
    expect(session.proposals.pending?.text).not.toBe('keep implementing the cache'); // P25: old draft's relay form is gone
    // …and the instruction half is HELD, verbatim residue text:
    expect(session.proposals.pending?.text).toBe(S5_T4_RESIDUE);
  });

  it('the scripted "Yes." then releases the residue — byte-for-byte, without the cancel words', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(S5_T4);
    const yes = await session.handleOperatorTurn('Yes.');
    expect(yes.released?.text).toBe(S5_T4_RESIDUE);
    expect(delivery.deliveredTexts()).toEqual([S5_T4_RESIDUE]);
    // The cancel words never reach the worker:
    expect(delivery.deliveredTexts()[0]).not.toContain('Never mind');
    expect(delivery.deliveredTexts()[0]).not.toContain('forget it');
  });

  it('the cancel breath with NOTHING previously held still captures the instruction half', async () => {
    const { session } = makeSession();
    const result = await session.handleOperatorTurn(S5_T4);
    expect(result.cancelled).toBe(false); // there was nothing to cancel
    expect(session.proposals.pending?.text).toBe(S5_T4_RESIDUE);
  });

  it('the residue opens a new composition batch, so its turn emits the receipt ack', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn('tell the worker to keep implementing the cache'); // batch 1 → receipt
    const breath = await session.handleOperatorTurn(S5_T4);
    expect(breath.receiptAck).toBe(RECEIPT_ACK); // batch 2 opens with the residue
  });

  it('a question-shaped residue is conversational, never drafted', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn("never mind. how's it going?");
    expect(session.proposals.pending).toBeNull();
  });

  it('a pure cancel behaves exactly as before — cleared draft, nothing drafted', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn('tell the worker to keep implementing the cache');
    const result = await session.handleOperatorTurn('never mind');
    expect(result.cancelled).toBe(true);
    expect(session.proposals.pending).toBeNull();
    const yes = await session.handleOperatorTurn('yes');
    expect(yes.released).toBeNull();
  });

  it('the residue draft still requires its own confirmation — the gate is not widened by the split', async () => {
    const { session, delivery, deliverSpy } = makeSession();
    await session.handleOperatorTurn(S5_T4);
    expect(deliverSpy).not.toHaveBeenCalled(); // the breath alone never relays
    await session.handleOperatorTurn('and also rerun the flaky suite'); // joins the draft
    const yes = await session.handleOperatorTurn('yes, go ahead');
    expect(yes.released?.text).toBe(`${S5_T4_RESIDUE}\nand also rerun the flaky suite`);
    expect(delivery.deliveredTexts()).toEqual([`${S5_T4_RESIDUE}\nand also rerun the flaky suite`]);
  });
});
