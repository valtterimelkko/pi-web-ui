import { describe, it, expect, vi } from 'vitest';

// Finding F2 (P7): with no draft held, a confirm-shaped utterance reached the
// model, which replied "OK. I'll send that instruction to the worker." (s5/t5)
// — a promise of a send that could not happen (the gate held; nothing was
// sent). In a voice surface a false promise is a real harm. The dead-end
// branches answer MECHANICALLY from harness state: no model call, no promise,
// the honest truth — nothing is held.
import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import type { TalkerModelClient, ModelTurnResult, WorkerStateSnapshot } from '../../../src/talker/types.js';

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '3m',
  activity: 'idle between steps',
  children: ['worker 1: running'],
  lastAssistantText: 'Step done.',
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

function makeSession(modelReply = 'Send what, exactly?') {
  const delivery = createNullDelivery();
  const deliverSpy = vi.spyOn(delivery, 'deliver');
  const model = stubModel(modelReply);
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-1',
    snapshotProvider: () => SNAPSHOT,
  });
  return { session, model, delivery, deliverSpy };
}

/** A send promise is the failure: the reply must never claim or offer a send. */
const PROMISE_RE = /\bi'?ll send\b|\bi will send\b|\bsending that\b|\bsending it\b|\bwill send\b|\bshall i send\b|\bsend that (now|over)\b/i;

describe('F2: a confirm with nothing pending cannot promise a send', () => {
  it('a bare "yes" with no draft held gets the mechanical nothing-held answer — no model call', async () => {
    const { session, model, deliverSpy } = makeSession("OK. I'll send that instruction to the worker.");
    const result = await session.handleOperatorTurn('yes');
    expect(result.reply).toMatch(/nothing is held/i);
    expect(result.reply).not.toMatch(PROMISE_RE);
    expect(result.modelCalled).toBe(false);
    expect(model.calls.length).toBe(0);
    expect(result.released).toBeNull();
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it('the s5/t5 shape — "Yes." right after a release consumed the draft — answers mechanically too', async () => {
    const { session, model } = makeSession("OK. I'll send that instruction to the worker.");
    await session.handleOperatorTurn('tell the worker to leave caching alone entirely');
    await session.handleOperatorTurn('yes, go ahead'); // released
    const again = await session.handleOperatorTurn('Yes.');
    expect(again.released).toBeNull();
    expect(again.reply).toMatch(/nothing is held/i);
    expect(again.reply).not.toMatch(PROMISE_RE);
    expect(model.calls.length).toBe(1); // only the first, conversational turn
  });

  it('operator pushback with nothing pending gets the same honest mechanical answer', async () => {
    const { session, model, deliverSpy } = makeSession();
    const result = await session.handleOperatorTurn("just do it, don't ask me every single time");
    expect(result.reply).toMatch(/nothing is held/i);
    expect(result.reply).not.toMatch(PROMISE_RE);
    expect(result.modelCalled).toBe(false);
    expect(model.calls.length).toBe(0);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it('a pure cancel with nothing pending cannot claim a cancellation that never happened', async () => {
    const { session, model, deliverSpy } = makeSession("Done — I've cancelled that for you.");
    const result = await session.handleOperatorTurn('never mind');
    expect(result.reply).toMatch(/nothing (is held|to cancel)/i);
    expect(result.modelCalled).toBe(false);
    expect(model.calls.length).toBe(0);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(session.proposals.pending).toBeNull();
  });

  it('a cancel that DID clear a held draft stays conversational — the model may truthfully acknowledge it', async () => {
    const { session, model } = makeSession('Dropped — nothing is held now.');
    await session.handleOperatorTurn('tell the worker to rebase onto main');
    const result = await session.handleOperatorTurn('never mind');
    expect(result.cancelled).toBe(true);
    expect(result.modelCalled).toBe(true);
    // Two conversational turns: the instruction's propose turn and the cancel.
    expect(model.calls.length).toBe(2);
    expect(session.proposals.pending).toBeNull();
  });

  it('a confirm WITH a live draft still releases — the dead-end rule never touches the gate', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('tell the worker to rebase onto main');
    const yes = await session.handleOperatorTurn('yes');
    expect(yes.released?.text).toBe('rebase onto main'); // P25
    expect(delivery.deliveredTexts()).toEqual(['rebase onto main']); // P25
  });
});
