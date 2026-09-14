import { describe, it, expect } from 'vitest';

// RED: the focus projection does not exist yet.
import { renderStateView } from '../../../src/talker/state-view.js';
import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import type {
  ModelTurnResult,
  TalkerModelClient,
  WorkerStateSnapshot,
} from '../../../src/talker/types.js';

/**
 * P18 package C, deliverable 2 — focus/hold, the server side of the
 * "the talker may SUGGEST, never switch" discipline.
 *
 * Focus is the OPERATOR'S control, pressed on the client and nowhere else.
 * The talker can only be told about it, so that it can do the one thing it is
 * allowed to do: say "this needs you — leave focus". This suite pins that the
 * flag is:
 *   - projection-only (it appears in the state view the model reads);
 *   - per-turn input, never stored state (a later turn without the flag is
 *     not focused);
 *   - incapable of changing the gate: a confirmation under focus releases
 *     exactly what it would release without focus.
 */

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '3m',
  activity: 'running the migration',
};

function stubModel(reply: string): TalkerModelClient & { calls: Array<Array<{ role: string; content: string }>> } {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  return {
    calls,
    async completeTurn(messages): Promise<ModelTurnResult> {
      calls.push(messages);
      return { text: reply, ttftMs: 5, totalMs: 12 };
    },
  };
}

function lastProjection(model: ReturnType<typeof stubModel>): string {
  const call = model.calls[model.calls.length - 1];
  return call[call.length - 1].content;
}

describe('P18/2 — the operator’s focus is visible to the talker, and only as a suggestion', () => {
  it('the state view says focus is on, and says the talker cannot switch it', () => {
    const view = renderStateView(SNAPSHOT, { draft: null, lastReleased: null, operatorFocus: true });
    expect(view).toMatch(/focus/i);
    // The model is told the truth about the mechanism: the operator presses.
    expect(view).toMatch(/cannot switch|only the operator|not yours to switch/i);
  });

  it('the state view says nothing about focus when it is off', () => {
    const off = renderStateView(SNAPSHOT, { draft: null, lastReleased: null });
    const explicitlyOff = renderStateView(SNAPSHOT, { draft: null, lastReleased: null, operatorFocus: false });
    expect(off).not.toMatch(/focus/i);
    expect(explicitlyOff).not.toMatch(/focus/i);
  });

  it('the projection is rebuilt fresh per turn: the flag is input, never stored state', async () => {
    const model = stubModel('Noted.');
    const session = new TalkerSession({
      model,
      delivery: createNullDelivery(),
      workerSessionId: 'worker-1',
      snapshotProvider: () => SNAPSHOT,
    });

    await session.handleOperatorTurn('what is the worker doing?', { operatorFocus: true });
    expect(lastProjection(model)).toMatch(/focus/i);

    await session.handleOperatorTurn('and now?');
    expect(lastProjection(model)).not.toMatch(/focus/i);
  });

  it('focus changes nothing about the gate: a confirmation still releases the operator’s verbatim words', async () => {
    const model = stubModel('Shall I send that?');
    const delivery = createNullDelivery();
    const session = new TalkerSession({
      model,
      delivery,
      workerSessionId: 'worker-1',
      snapshotProvider: () => SNAPSHOT,
    });
    await session.handleOperatorTurn('tell the worker to rebase', { operatorFocus: true });
    const released = await session.handleOperatorTurn('yes', { operatorFocus: true });
    expect(released.released?.text).toBe('tell the worker to rebase');
    expect(delivery.deliveredTexts()).toEqual(['tell the worker to rebase']);
  });

  it('no talker-session method sets or clears focus (the model proposes, the operator presses)', () => {
    const session = new TalkerSession({
      model: stubModel('x'),
      delivery: createNullDelivery(),
      workerSessionId: 'worker-1',
      snapshotProvider: () => SNAPSHOT,
    });
    const methods = (Object.getOwnPropertyNames(Object.getPrototypeOf(session)) as string[]).filter(
      name => name !== 'constructor'
    );
    expect(methods.filter(name => /focus/i.test(name))).toEqual([]);
  });
});
