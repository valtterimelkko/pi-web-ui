import { describe, it, expect } from 'vitest';

// RED: normaliseRelayText does not exist yet (P25).
import { normaliseRelayText } from '../../../src/talker/relay-normalise.js';
import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import type { TalkerModelClient, ModelTurnResult, WorkerStateSnapshot } from '../../../src/talker/types.js';

/**
 * P25 — the semi-verbatim relay, end to end through the harness.
 *
 * Primary invariant (P25, replacing "byte-equal to the operator's raw words"):
 * THE CARD SHOWS THE EXACT TEXT THAT WILL BE SENT. The transform happens
 * BEFORE approval — the draft holds the relay text, so the confirmation card,
 * the mechanical re-confirmation quote and the release are all the same bytes
 * by construction. The gate is untouched: a release still requires a
 * confirmation-classified utterance against a live draft, and the store is
 * still the only source of relay text.
 */

const SPOKEN = "Okay, ask the worker if it has enough materials to start developing the first week's materials, if it has enough resources for that.";
const RELAYED = normaliseRelayText(SPOKEN).text;

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'supervising two workers',
  lastAssistantText: 'Both are running.',
};

function stubModel(reply: string): TalkerModelClient {
  return {
    async completeTurn(): Promise<ModelTurnResult> {
      return { text: reply, ttftMs: 12, totalMs: 40 };
    },
  };
}

function makeSession(reply = 'Understood — shall I send that to the worker?') {
  const delivery = createNullDelivery();
  const session = new TalkerSession({
    model: stubModel(reply),
    delivery,
    workerSessionId: 'worker-1',
    snapshotProvider: () => SNAPSHOT,
  });
  return { session, delivery };
}

describe('P25: the operator-reported failure case, end to end', () => {
  it('the spoken commission frame never reaches the worker — the relay is the content', async () => {
    const { session, delivery } = makeSession();
    const first = await session.handleOperatorTurn(SPOKEN);
    expect(first.utteranceClass).toBe('statement'); // classification unchanged by normalisation
    expect(session.proposals.pending?.text).toBe(RELAYED);
    expect(session.proposals.pending?.text).not.toContain('ask the worker');

    const yes = await session.handleOperatorTurn('yes');
    expect(delivery.deliveredTexts()).toEqual([RELAYED]);
    expect(yes.released?.text).toBe(RELAYED);
  });

  it('PRIMARY INVARIANT: the released bytes equal the bytes the card showed', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(SPOKEN);

    // What the card renders at approval time: the draft snapshot the surface
    // reads (P26) and the store's pending text.
    const cardUtterances = session.proposals.snapshotDraft()?.utterances.map(u => u.text) ?? [];
    const cardText = cardUtterances.join('\n');

    const yes = await session.handleOperatorTurn('yes');

    expect(cardUtterances).toHaveLength(1);
    expect(cardText).toBe(RELAYED);
    expect(yes.released?.text).toBe(cardText); // same value…
    expect(Buffer.byteLength(yes.released?.text ?? '', 'utf8'))
      .toBe(Buffer.byteLength(cardText, 'utf8')); // …and the same bytes
    expect(delivery.deliveredTexts()).toEqual([cardText]);
  });

  it('the mechanical re-confirmation quote shows the relay text too — the operator always approves what will be sent', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn(SPOKEN);
    // Age the confirmation window past its limit (default 6 turns).
    for (let i = 0; i < 6; i++) await session.handleOperatorTurn('did you send it?');
    const stale = await session.handleOperatorTurn('yes');
    // The refusal quotes the draft verbatim — which is now the relay text.
    expect(stale.reply).toContain(RELAYED);
    expect(stale.reply).not.toContain('ask the worker');
    // Draft intact; the re-armed window lets the next yes release exactly
    // what was quoted.
    const fresh = await session.handleOperatorTurn('yes');
    expect(fresh.released?.text).toBe(RELAYED);
  });

  it('a plain, clean instruction is passed through unchanged — no transform by default', async () => {
    const { session, delivery } = makeSession();
    const clean = 'hold phase 3 until my review';
    await session.handleOperatorTurn(clean);
    const part = session.proposals.snapshotDraft()?.utterances[0];
    expect(part?.text).toBe(clean);
    expect(part?.originalText).toBeUndefined(); // nothing was removed — no reversible record needed
    const yes = await session.handleOperatorTurn('yes');
    expect(delivery.deliveredTexts()).toEqual([clean]);
    expect(yes.released?.text).toBe(clean);
  });

  it('multi-part drafts: every part is normalised, and a selection releases that part’s relay text', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('um, hold phase 3 until my review');
    await session.handleOperatorTurn('Okay, ask the worker to run the smoke tests after');
    const parts = session.proposals.snapshotDraft()?.utterances.map(u => u.text) ?? [];
    expect(parts).toEqual(['hold phase 3 until my review', 'run the smoke tests after']);

    const second = await session.handleOperatorTurn('just the second one');
    expect(second.released?.text).toBe('run the smoke tests after');
    expect(delivery.deliveredTexts()).toEqual(['run the smoke tests after']);
  });

  it('the ask-the-worker offer path holds the operator’s question in relay form too', async () => {
    // Not worker-directed, not a meta-send question → offerable. The model
    // appends [[ask-worker]]; the harness holds the operator's OWN question.
    const { session, delivery } = makeSession('I cannot tell from here [[ask-worker]]');
    await session.handleOperatorTurn('um, what was the last error about?');
    expect(session.proposals.pending?.text).toBe('what was the last error about?');
    const yes = await session.handleOperatorTurn('yes');
    expect(delivery.deliveredTexts()).toEqual(['what was the last error about?']);
    expect(yes.released?.text).toBe('what was the last error about?');
  });

  it('the cancel-residue path is normalised the same way', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('never mind — um, tell the worker to rebase the branch');
    expect(session.proposals.pending?.text).toBe('rebase the branch');
    const yes = await session.handleOperatorTurn('yes');
    expect(delivery.deliveredTexts()).toEqual(['rebase the branch']);
    expect(yes.released?.text).toBe('rebase the branch');
  });
});

describe('P25: the gate is untouched by the transform', () => {
  it('normalisation creates no new send path: the model cannot release, only the operator’s confirmation can', async () => {
    const { session, delivery } = makeSession('Sending that to the worker now.');
    await session.handleOperatorTurn(SPOKEN);
    // A meta question: conversational, and it never joins the draft (§4.2).
    await session.handleOperatorTurn('did you send it?');
    expect(delivery.deliveredTexts()).toEqual([]);
    // Only the operator's literal confirmation releases — once.
    await session.handleOperatorTurn('yes');
    expect(delivery.deliveredTexts()).toEqual([RELAYED]);
    await session.handleOperatorTurn('yes'); // nothing pending any more
    expect(delivery.deliveredTexts()).toHaveLength(1);
  });

  it('the store stays the only source of relay text: a confirmation with nothing pending still delivers nothing', async () => {
    const { session, delivery } = makeSession();
    const yes = await session.handleOperatorTurn('yes');
    expect(yes.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('raw words are still kept byte-for-byte in the verbatim log and as the reversible record', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn(SPOKEN);
    const logged = session.utteranceLog.recent(1)[0];
    expect(logged.text).toBe(SPOKEN); // the log is untouched — still verbatim
    const part = session.proposals.snapshotDraft()?.utterances[0];
    expect(part?.originalText).toBe(SPOKEN); // the draft part keeps the original
    expect(part?.text).toBe(RELAYED); // and carries the relay text it will release
  });
});
