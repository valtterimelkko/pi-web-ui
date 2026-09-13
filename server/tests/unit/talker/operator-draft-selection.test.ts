import { describe, it, expect } from 'vitest';

// RED: the mechanical selection API does not exist yet.
import { resolveDraftSelection } from '../../../src/talker/utterance-classifier.js';
import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import type { TalkerModelClient, ModelTurnResult, WorkerStateSnapshot } from '../../../src/talker/types.js';

/**
 * Subset release by id (plan §4.2, invariant 2): a release releases verbatim
 * text selected by id — never composed. "Just the second one" selects a
 * subset of the draft's utterance ids; the model has no route to compose,
 * edit, summarise or re-word what is sent. The selection vocabulary here is
 * deliberately tiny and mechanical (fixed ordinal words), like the rest of
 * the harness state machine — anything outside it never selects.
 */

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'supervising two workers',
  recentEvents: ['watching worker 1'],
  children: ['worker 1: running'],
  pendingItems: ['phase 3 held'],
  lastAssistantText: 'Both are running.',
};

const PART_1 = 'tell the worker to hold phase 3 until my review';
const PART_2 = 'and also make it use staging credentials, not production';

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

function makeSession() {
  const delivery = createNullDelivery();
  const model = stubModel('Still going — nothing needs you yet.');
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-1',
    snapshotProvider: () => SNAPSHOT,
  });
  return { session, delivery };
}

describe('resolveDraftSelection: the fixed, mechanical ordinal vocabulary', () => {
  it('parses bare ordinal selections', () => {
    expect(resolveDraftSelection('just the second one')).toEqual({ kind: 'ordinal', position: 'second' });
    expect(resolveDraftSelection('the first one')).toEqual({ kind: 'ordinal', position: 'first' });
    expect(resolveDraftSelection('only the last part')).toEqual({ kind: 'ordinal', position: 'last' });
    expect(resolveDraftSelection('send the third one.')).toEqual({ kind: 'ordinal', position: 'third' });
  });

  it('parses confirm-prefixed ordinal selections', () => {
    expect(resolveDraftSelection('yes, the second one')).toEqual({ kind: 'ordinal', position: 'second' });
    expect(resolveDraftSelection('ok just the first one')).toEqual({ kind: 'ordinal', position: 'first' });
  });

  it('never parses anything outside the fixed shapes — instructions and chatter select nothing', () => {
    expect(resolveDraftSelection('hold the second one back')).toBeNull(); // an instruction, not a selection
    expect(resolveDraftSelection('what about the second one?')).toBeNull(); // questions never select
    expect(resolveDraftSelection('tell the worker to rerun the second suite')).toBeNull();
    expect(resolveDraftSelection('yes')).toBeNull(); // a plain yes selects the whole draft implicitly
    expect(resolveDraftSelection('did you send the second one?')).toBeNull();
    expect(resolveDraftSelection('')).toBeNull();
  });
});

describe('harness-level: "just the second one" releases exactly that utterance by id', () => {
  it('releases the selected part verbatim and keeps the rest of the draft', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(PART_1);
    await session.handleOperatorTurn(PART_2);
    const pick = await session.handleOperatorTurn('just the second one');
    expect(pick.released?.text).toBe(PART_2);
    expect(delivery.deliveredTexts()).toEqual([PART_2]);
    // The first part is still held — choosing one must not destroy the other.
    expect(session.proposals.snapshotDraft()?.utterances.map(u => u.text)).toEqual([PART_1]);
    // A fresh confirmation releases the remainder.
    const rest = await session.handleOperatorTurn('yes');
    expect(rest.released?.text).toBe(PART_1);
    expect(delivery.deliveredTexts()).toEqual([PART_2, PART_1]);
  });

  it('an unknown ordinal never acts and never damages the draft (ambiguous never acts)', async () => {
    const { session, delivery } = makeSession();
    await session.handleOperatorTurn(PART_1);
    const fifth = await session.handleOperatorTurn('the fifth one');
    expect(fifth.released).toBeNull();
    expect(delivery.deliveredTexts()).toEqual([]);
    expect(session.proposals.snapshotDraft()?.utterances.map(u => u.text)).toEqual([PART_1]);
  });
});
