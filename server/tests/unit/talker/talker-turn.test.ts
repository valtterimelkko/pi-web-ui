import { describe, it, expect, vi } from 'vitest';

// RED: module does not exist yet.
import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import { RELEASE_ACK } from '../../../src/talker/ack.js';
import type { TalkerModelClient, ModelTurnResult, WorkerStateSnapshot } from '../../../src/talker/types.js';

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'supervising',
  recentEvents: ['watching worker 1'],
  children: ['worker 1: running'],
  pendingItems: ['phase 3 held'],
  lastAssistantText: 'Both are running.',
};

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

function makeSession(reply = 'Here is where things stand.', snapshot: WorkerStateSnapshot = SNAPSHOT) {
  const delivery = createNullDelivery();
  const model = stubModel(reply);
  const snapshotProvider = vi.fn(() => snapshot);
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-1',
    snapshotProvider,
  });
  return { session, model, delivery, snapshotProvider };
}

describe('TalkerSession turn loop', () => {
  it('answers conversationally: model receives [system, history window, fresh projection + utterance]', async () => {
    const { session, model } = makeSession();
    const result = await session.handleOperatorTurn("morning — how's it going?");
    expect(result.reply).toBe('Here is where things stand.');
    expect(result.modelCalled).toBe(true);
    expect(result.utteranceClass).toBe('question');

    const messages = model.calls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content.length).toBeGreaterThan(100);
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('--- WORKER STATE ---');
    expect(last.content).toContain("OPERATOR (out loud): morning — how's it going?");
    // Exactly one user message per turn in a fresh session.
    expect(messages.filter(m => m.role === 'user')).toHaveLength(1);
  });

  it('rebuilds the state view fresh on every model turn', async () => {
    const { session, snapshotProvider } = makeSession();
    await session.handleOperatorTurn('status?');
    await session.handleOperatorTurn('and now?');
    expect(snapshotProvider).toHaveBeenCalledTimes(2);
  });

  it('records the exchange in history as plain utterances (projection is never persisted)', async () => {
    const { session } = makeSession();
    await session.handleOperatorTurn('status?');
    const entries = session.history.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ role: 'user', content: 'status?', kind: 'operator' });
    expect(entries[1]).toMatchObject({ role: 'assistant', content: 'Here is where things stand.', kind: 'talker' });
    expect(entries.every(e => !e.content.includes('WORKER STATE'))).toBe(true);
  });

  it('carries the conversation window into the next turn', async () => {
    const { session, model } = makeSession();
    await session.handleOperatorTurn('status?');
    await session.handleOperatorTurn('and the workers?');
    const second = model.calls[1];
    expect(second.some(m => m.role === 'user' && m.content === 'status?')).toBe(true);
    expect(second.some(m => m.role === 'assistant' && m.content === 'Here is where things stand.')).toBe(true);
  });

  it('an instruction becomes the pending candidate and appears in the next projection', async () => {
    const { session, model } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3 until my review');
    await session.handleOperatorTurn('actually, what is worker 2 doing?');
    const last = model.calls[1][model.calls[1].length - 1];
    expect(last.content).toContain('--- PENDING INSTRUCTION ---');
    expect(last.content).toContain('tell the worker to hold phase 3 until my review');
  });

  it('a bare yes resolves to the pending proposal without a model call (voice-safe confirmation)', async () => {
    const { session, model, delivery } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3 until my review');
    model.calls.length = 0;
    const result = await session.handleOperatorTurn('yes');
    expect(result.released).not.toBeNull();
    expect(result.reply).toBe(RELEASE_ACK);
    expect(result.modelCalled).toBe(false);
    expect(model.calls).toHaveLength(0);
    expect(delivery.deliveredTexts()).toEqual(['tell the worker to hold phase 3 until my review']);
  });

  it('an explicit cancel clears the proposal and the projection reflects it', async () => {
    const { session, model } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3');
    const result = await session.handleOperatorTurn('never mind');
    expect(result.cancelled).toBe(true);
    await session.handleOperatorTurn('so what now?');
    const last = model.calls[model.calls.length - 1][model.calls[model.calls.length - 1].length - 1];
    expect(last.content).not.toContain('--- PENDING INSTRUCTION ---');
    expect(session.proposals.pending).toBeNull();
  });

  it('a stale confirmation releases nothing — and the draft is surfaced, not dropped (plan §4.2)', async () => {
    // RENAMED + strengthened (plan §4.2): was "a stale proposal expires so a
    // much later yes releases nothing". The safety assertion — a much later
    // yes releases nothing — is unchanged; what changed is that the draft is
    // no longer silently dropped: it is held for re-confirmation.
    const delivery = createNullDelivery();
    const model = stubModel('noted.');
    const session = new TalkerSession({
      model,
      delivery,
      workerSessionId: 'w',
      snapshotProvider: () => SNAPSHOT,
      config: { maxPendingAgeTurns: 2 },
    });
    await session.handleOperatorTurn('tell the worker to hold phase 3'); // turn 1: draft
    await session.handleOperatorTurn('did you send it?'); // turn 2: meta question — draft kept
    await session.handleOperatorTurn('did you send it?'); // turn 3: window lapses
    const result = await session.handleOperatorTurn('yes');
    expect(result.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
    // Surfaced, never dropped:
    expect(session.proposals.pending).not.toBeNull();
    expect(result.reply).toContain('tell the worker to hold phase 3');
    // A re-confirmed yes then releases it verbatim.
    const reconfirmed = await session.handleOperatorTurn('yes');
    expect(reconfirmed.released?.text).toBe('tell the worker to hold phase 3');
  });

  it('a meta question about the send never replaces or releases the pending proposal', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3');
    const mid = await session.handleOperatorTurn('did you send it yet?');
    expect(mid.released).toBeNull();
    expect(session.proposals.pending?.text).toBe('tell the worker to hold phase 3');
    const done = await session.handleOperatorTurn('yes');
    expect(done.released?.text).toBe('tell the worker to hold phase 3');
    expect(delivery.deliveredTexts()).toEqual(['tell the worker to hold phase 3']);
  });

  it('a question-shaped polite instruction is relayable (verbatim)', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn('could you ask the worker to rebase the branch before continuing?');
    await session.handleOperatorTurn('yes, go ahead');
    expect(delivery.deliveredTexts()).toEqual(['could you ask the worker to rebase the branch before continuing?']);
  });

  it('after a release, the next projection tells the model what was released (coherence)', async () => {
    const { session, model } = makeSession();
    await session.handleOperatorTurn('tell the worker to hold phase 3');
    await session.handleOperatorTurn('yes');
    await session.handleOperatorTurn('did it go through?');
    const lastCall = model.calls[model.calls.length - 1];
    const last = lastCall[lastCall.length - 1];
    expect(last.content).toContain('--- LAST RELEASED ---');
    expect(last.content).toContain('tell the worker to hold phase 3');
  });

  it('model failure produces an honest fallback and never throws at the caller', async () => {
    const delivery = createNullDelivery();
    const session = new TalkerSession({
      model: {
        async completeTurn() {
          throw new Error('provider 502');
        },
      },
      delivery,
      workerSessionId: 'w',
      snapshotProvider: () => SNAPSHOT,
    });
    const result = await session.handleOperatorTurn('status?');
    expect(result.reply).toMatch(/couldn'?t reach|say that again/i);
    expect(result.error).toContain('provider 502');
    expect(delivery.deliveredTexts()).toEqual([]);
  });

  it('refuses empty utterances', async () => {
    const { session } = makeSession();
    await expect(session.handleOperatorTurn('   ')).rejects.toThrow(/empty/i);
  });
});
