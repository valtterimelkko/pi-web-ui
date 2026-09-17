import { describe, it, expect, vi } from 'vitest';

// RED: modules do not exist yet.
import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import type { TalkerModelClient, ModelTurnResult, WorkerStateSnapshot, DeliveryOutcome } from '../../../src/talker/types.js';

/**
 * H1 gate suite — the seven non-negotiables from the brief, each backed by a
 * test that fails if the gate is ever weakened. The stub model never decides
 * the gate: it only produces conversational text.
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

function makeSession(overrides?: { model?: ReturnType<typeof stubModel>; delivery?: ReturnType<typeof createNullDelivery>; snapshot?: WorkerStateSnapshot }) {
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

describe('NON-NEGOTIABLE 1: the talker cannot send — only the harness sends, only from a confirmed pending proposal', () => {
  it('a relay attempt with no prior proposal delivers nothing', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('yes, go ahead');
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('relay before the proposal: conversation then an immediate yes with nothing instructed delivers nothing', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn("morning — how's it going?");
    await session.handleOperatorTurn('yes, send it');
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('model output claiming a relay happened cannot cause a delivery (no code path from model text to worker)', async () => {
    const { session, delivery } = makeSession({
      model: stubModel("Done — I've sent your instruction to the worker and it is acting on it now."),
    });
    await session.handleOperatorTurn(INSTRUCTION);
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('model output containing relay markers / protocol-ish text cannot cause a delivery', async () => {
    const { session, delivery } = makeSession({
      model: stubModel('RELAY: hold phase 3 until my review. CLARIFY_REQUIRED: none. Sending now.'),
    });
    await session.handleOperatorTurn(INSTRUCTION);
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('a previous relay does not authorise a second send (authorisation is consumed)', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION); // proposal recorded
    await session.handleOperatorTurn('yes, go ahead'); // released once
    await session.handleOperatorTurn('yes, go ahead'); // nothing pending — must not re-send
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION]);
  });

  it('an ambiguous yes with no pending proposal triggers no delivery and answers MECHANICALLY (F2)', async () => {
    // UPDATED (P7, finding F2): this dead end previously reached the model,
    // which promised a send that could not happen ("OK. I'll send that
    // instruction to the worker."). The harness now answers with the fixed
    // nothing-held string — no model call, no promise, no delivery.
    const { session, delivery, model } = makeSession();
    const result = await session.handleOperatorTurn('yes');
    expect(delivery.deliveredTexts()).toEqual([]);
    expect(model.calls.length).toBe(0);
    expect(result.released).toBeNull();
    expect(result.reply).toMatch(/nothing is held/i);
    expect(result.modelCalled).toBe(false);
  });

  it('the public surface is minimal: one entry point plus TS-private internals, no injection or delivery API', async () => {
    const { session } = makeSession();
    const publicMethods = (Object.getOwnPropertyNames(Object.getPrototypeOf(session)) as string[]).filter(
      name => name !== 'constructor'
    );
    // handleOperatorTurn is the only operator-facing entry; the rest are
    // TS-private internals (the P10 observation wrapper's body, the release
    // path + model turn) that take no relay text from callers and add no
    // injection or delivery API.
    expect(publicMethods.sort()).toEqual(['conversationalTurn', 'handleOperatorTurn', 'handleOperatorTurnBody', 'release']);
  });

  it('even a forced direct call to the internal release path cannot relay without a live pending proposal', async () => {
    const { session, delivery } = makeSession();
    const anySession = session as unknown as { release(u: string, turn: number): Promise<unknown> };
    const result = (await anySession.release('yes', 99)) as { released: unknown };
    // Nothing was pending, so there is nothing to release — the store is the
    // only source of relay text and it is empty.
    expect(result.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
  });
});

describe('NON-NEGOTIABLE 2 (P25): relay text is the draft stored text — the operator words minus the channel — referenced by id', () => {
  it('the worker receives the operator’s own words minus the channel, never a model paraphrase (P25 semi-verbatim)', async () => {
    const raw = "Right, so — tell the worker to hold phase 3 until my review.  Not just until worker 1 finishes.";
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(raw);
    await session.handleOperatorTurn('yes, go ahead');
    // P25: the relay is the operator's words minus the leading markers and
    // the commission frame — the content after '.  ' is untouched. Never a
    // model-composed paraphrase (the stub model's text is never consulted).
    expect(delivery.deliveredTexts()).toEqual(['hold phase 3 until my review. Not just until worker 1 finishes.']);
  });

  it('a model paraphrase is never what gets delivered, even when the model restates it differently', async () => {
    const { session, delivery } = makeSession({
      model: stubModel('Got it — you want phase 3 held pending your review. Send?'),
    });
    await session.handleOperatorTurn(INSTRUCTION);
    await session.handleOperatorTurn('yes');
    const delivered = delivery.deliveredTexts()[0];
    expect(delivered).toBe(RELAYED_INSTRUCTION);
    expect(delivered).not.toContain('pending your review');
  });

  it('the release references the verbatim utterance id from the log', async () => {
    const { session } = makeSession();
    const first = await session.handleOperatorTurn(INSTRUCTION);
    const rec = session.utteranceLog.recent(1)[0];
    const second = await session.handleOperatorTurn('yes');
    expect(second.released?.utteranceId).toBe(rec.id);
    expect(second.released?.text).toBe(RELAYED_INSTRUCTION);
    expect(first.released).toBeNull();
  });
});

describe('NON-NEGOTIABLE 4: the operator-pushback turn', () => {
  it('pushback with a pending proposal is the confirmation and releases the operator utterance', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION);
    const result = await session.handleOperatorTurn("just do it, don't ask me every single time, it's a simple thing");
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION]);
    expect(result.released).not.toBeNull();
  });

  it('pushback with nothing pending delivers nothing and answers mechanically (F2 neighbour)', async () => {
    // UPDATED (P7, finding F2): the dead-end transition is mechanical. The
    // fixed string carries the honest state (nothing held) and the way out;
    // the model can no longer answer this dead end at all, so it can never
    // promise a send here either.
    const { session, delivery } = makeSession({
      model: stubModel("I hear you — but the worker can't tell a thought from an instruction, so I check. Say the word and it goes."),
    });
    const result = await session.handleOperatorTurn("just do it, don't ask me every single time");
    expect(delivery.deliveredTexts()).toEqual([]);
    expect(result.reply).toMatch(/nothing is held/i);
    expect(result.modelCalled).toBe(false);
  });

  it('pushback does not disable the gate for later instructions', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION);
    await session.handleOperatorTurn("just do it, don't ask me every single time");
    // The next instruction still needs its own confirmation.
    await session.handleOperatorTurn('also tell the worker to rerun the test suite');
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION]);
    await session.handleOperatorTurn('yes');
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION, 'rerun the test suite']); // P25: 'also tell the worker to' is channel chaining
  });
});

describe('NON-NEGOTIABLE 5: input hygiene — nothing but the harness projection writes into the talker context', () => {
  it('the session exposes no injection API', () => {
    const { session } = makeSession();
    const proto = Object.getPrototypeOf(session) as Record<string, unknown>;
    const forbidden = ['inject', 'injectMessage', 'addContext', 'pushContext', 'appendMessage', 'sendAs', 'relay', 'send'];
    for (const name of forbidden) {
      expect(typeof proto[name]).not.toBe('function');
    }
  });

  it('model-facing context is built only from the system prompt, history of real turns, and the fresh state view', async () => {
    const { session, model } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION);
    const messages = model.calls[0];
    expect(messages[0].role).toBe('system');
    // Last message is the per-turn projection + the operator utterance.
    const last = messages[messages.length - 1];
    expect(last.content).toContain('OPERATOR (out loud):');
    expect(last.content).toContain('--- WORKER STATE ---');
  });
});

describe('NON-NEGOTIABLE 6: bounded rolling history, trimmed on turn boundaries, never while pending', () => {
  it('history stays bounded over a long conversation (pending floor bounds chatter growth)', async () => {
    const { session } = makeSession();
    for (let i = 0; i < 60; i++) {
      await session.handleOperatorTurn(`status note ${i}`);
    }
    // Chatter keeps a candidate alive, so the generous pending floor applies —
    // but growth is still bounded by it.
    expect(session.history.length).toBeLessThanOrEqual(60);
    expect(session.history.length).toBeGreaterThanOrEqual(40);
  });

  it('history is never trimmed while an instruction is unconfirmed', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION); // pending
    const lenAfterProposal = session.history.length;
    for (let i = 0; i < 30; i++) {
      await session.handleOperatorTurn(`chatter ${i}`);
      // Wait — each chatter becomes the new pending candidate, so trimming stays blocked.
    }
    expect(session.history.length).toBeGreaterThanOrEqual(lenAfterProposal);
  });
});

describe('NON-NEGOTIABLE 7: confirm-before-speak ack', () => {
  it('the release reply is exactly "sending that now", produced without a model call', async () => {
    const { session, model } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION);
    const result = await session.handleOperatorTurn('yes, go ahead');
    expect(result.reply).toBe('sending that now');
    expect(result.modelCalled).toBe(false);
    expect(model.calls.length).toBe(1); // only the first, conversational turn
  });

  it('the talker never claims the worker finished or succeeded', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION);
    const result = await session.handleOperatorTurn('yes');
    expect(result.reply).not.toMatch(/done|finished|completed|succeeded/i);
    expect(result.reply).toBe('sending that now');
  });

  it('when delivery is queued, the ack is honest about timing', async () => {
    const delivery = createNullDelivery({ queuedOutcome: { outcome: 'queued', mechanism: 'follow_up', disclosure: 'will arrive after this turn' } as DeliveryOutcome });
    const { session } = makeSession({ delivery });
    await session.handleOperatorTurn(INSTRUCTION);
    const result = await session.handleOperatorTurn('yes');
    expect(result.reply).toMatch(/after this turn/i);
    expect(result.reply).not.toBe('sending that now');
  });

  it('when delivery fails, the talker says it did not go through', async () => {
    const delivery = createNullDelivery({ forcedOutcome: { outcome: 'refused', reason: 'worker unreachable' } as DeliveryOutcome });
    const { session } = makeSession({ delivery });
    await session.handleOperatorTurn(INSTRUCTION);
    const result = await session.handleOperatorTurn('yes');
    expect(result.reply).toMatch(/not reach the worker|couldn'?t deliver/i);
    expect(result.reply).not.toBe('sending that now');
  });
});

describe('NON-NEGOTIABLE 3 (Phase 1 gate repair): doubt and conditions never release a live proposal', () => {
  it('a doubt utterance ("not sure") leaves the held instruction unreleased', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION);
    const result = await session.handleOperatorTurn('not sure');
    expect(result.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('"sure, but wait" leaves the proposal held and releases nothing', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION);
    const result = await session.handleOperatorTurn('sure, but wait');
    expect(result.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('"yes, hold phase three" is an instruction, not an authorisation, and releases nothing', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION);
    const result = await session.handleOperatorTurn('yes, hold phase three');
    expect(result.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('a disconnected confirmation with nothing pending delivers nothing (kept behaviour)', async () => {
    const { session, delivery } = makeSession();
    const result = await session.handleOperatorTurn('yes');
    expect(result.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('an expired-card confirmation surfaces the held draft, releases nothing, and re-arms the window', async () => {
    const delivery = createNullDelivery();
    const model = stubModel('Understood — shall I send that to the worker?');
    const session = new TalkerSession({
      model,
      delivery,
      workerSessionId: 'worker-1',
      snapshotProvider: () => SNAPSHOT,
      config: { maxPendingAgeTurns: 2 },
    });
    await session.handleOperatorTurn(INSTRUCTION);
    await session.handleOperatorTurn("how's it going?"); // turn 2 — no append
    await session.handleOperatorTurn("how's it going?"); // turn 3 — window now lapsed
    const lapsed = await session.handleOperatorTurn('yes');
    expect(lapsed.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
    expect(lapsed.reply).toMatch(/still want that sent/i);
    // The surfacing re-armed the confirmation: a fresh yes now releases.
    const reconfirmed = await session.handleOperatorTurn('yes');
    expect(reconfirmed.released?.text).toBe(RELAYED_INSTRUCTION);
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION]);
  });
});

describe('structural bypass attempts (second-angle verification)', () => {
  it('calling the delivery adapter directly with an unconfirmed proposal is impossible from the session', async () => {
    const { session, delivery } = makeSession();
    const anySession = session as unknown as Record<string, unknown>;
    // No public or internal method hands relay text to a caller: the store is
    // the only source. The plausible bypass names do not exist at all.
    for (const name of ['deliver', 'send', 'forceRelease', 'deliverPending', 'relayNow', 'relay', 'inject']) {
      expect(typeof anySession[name]).not.toBe('function');
    }
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('the delivery adapter only fires through the confirmed release path (spy evidence)', async () => {
    const delivery = createNullDelivery();
    const deliverSpy = vi.spyOn(delivery, 'deliver');
    const { session } = makeSession({ delivery });
    await session.handleOperatorTurn(INSTRUCTION);
    expect(deliverSpy).not.toHaveBeenCalled(); // proposed, not confirmed
    await session.handleOperatorTurn('no, wait'); // cancelled
    await session.handleOperatorTurn('yes');
    expect(deliverSpy).not.toHaveBeenCalled(); // cancelled proposal cannot be confirmed
    await session.handleOperatorTurn(INSTRUCTION);
    await session.handleOperatorTurn('yes');
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliverSpy.mock.calls[0][0].text).toBe(RELAYED_INSTRUCTION);
  });

  it('a second release call with the store empty cannot resend the previous instruction', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(INSTRUCTION);
    await session.handleOperatorTurn('yes'); // released once
    const anySession = session as unknown as { release(u: string, turn: number): Promise<unknown> };
    const result = (await anySession.release('yes', 999)) as { released: unknown };
    expect(result.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([RELAYED_INSTRUCTION]);
  });
});
