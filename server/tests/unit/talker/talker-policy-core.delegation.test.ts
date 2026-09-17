/**
 * L3 delegation pins: the extracted gate is not merely equivalent to the
 * session — the session RUNS ON it.
 *
 * The differential suite proves policy-core reproduces the pre-extraction
 * decisions. This suite proves the direction of the dependency: every
 * TalkerSession turn consults decideOperatorTurn, every spoken turn consults
 * decideAfterModelReply, and policy-core itself stays free of I/O-bearing
 * imports (no model client, delivery adapter, observability, logger or file
 * system), so it can be embedded by a live harness.
 *
 * The core is wrapped, not replaced: the mock factory delegates to the real
 * implementation, so behaviour under test is the production behaviour and the
 * recorded calls are the gate inputs the session actually passed.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const recorded = vi.hoisted(() => ({
  decide: [] as Array<{ args: unknown[] }>,
  post: [] as Array<{ args: unknown[] }>,
}));

vi.mock('../../../src/talker/policy-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/talker/policy-core.js')>();
  return {
    ...actual,
    decideOperatorTurn: (...args: unknown[]) => {
      recorded.decide.push({ args });
      return (actual.decideOperatorTurn as (...a: unknown[]) => unknown)(...args);
    },
    decideAfterModelReply: (...args: unknown[]) => {
      recorded.post.push({ args });
      return (actual.decideAfterModelReply as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { TalkerSession } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import { NOTHING_TO_CANCEL_ACK } from '../../../src/talker/ack.js';
import type { ModelTurnResult, TalkerModelClient, WorkerStateSnapshot } from '../../../src/talker/types.js';

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'running the refactor',
  lastAssistantText: 'Two suites are green so far.',
};

function makeSession(reply = 'Noted.') {
  let calls = 0;
  const model: TalkerModelClient & { calls: number } = {
    get calls() {
      return calls;
    },
    async completeTurn(): Promise<ModelTurnResult> {
      calls += 1;
      return { text: reply, ttftMs: 12, totalMs: 40 };
    },
  };
  const delivery = createNullDelivery();
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-delegation',
    snapshotProvider: () => SNAPSHOT,
  });
  return { session, model, delivery };
}

describe('TalkerSession delegates its mechanical gate to policy-core', () => {
  it('every operator turn consults decideOperatorTurn with the state view and the turn input', async () => {
    const { session } = makeSession();
    recorded.decide.length = 0;

    await session.handleOperatorTurn('tell the worker to hold phase 3 until my review');
    await session.handleOperatorTurn('yes, go ahead');
    await session.handleOperatorTurn('never mind');
    await session.handleOperatorTurn("how's it going?");

    expect(recorded.decide).toHaveLength(4);
    const inputs = recorded.decide.map(c => c.args[1] as { utterance: string });
    expect(inputs.map(i => i.utterance)).toEqual([
      'tell the worker to hold phase 3 until my review',
      'yes, go ahead',
      'never mind',
      "how's it going?",
    ]);
    // The first argument is the pure state view the core consumes (not a
    // store, not a callback): a plain object with turn + draft.
    for (const call of recorded.decide) {
      const state = call.args[0] as { turn: number; draft: unknown };
      expect(typeof state.turn).toBe('number');
      expect('draft' in state).toBe(true);
    }
    // The decision the core returned is the one that was executed.
    expect((recorded.decide[1].args[1] as { utterance: string }).utterance).toBe('yes, go ahead');
  });

  it('the decision kind drives the executed branch (release releases, nothing-to-cancel answers mechanically)', async () => {
    const { session, delivery, model } = makeSession();
    recorded.decide.length = 0;

    await session.handleOperatorTurn('tell the worker to hold phase 3 until my review');
    await session.handleOperatorTurn('yes');

    expect(delivery.deliveredTexts()).toEqual(['hold phase 3 until my review']);
    const confirmCall = recorded.decide[1].args[1] as { utterance: string };
    expect(confirmCall.utterance).toBe('yes');
    expect(model.calls).toBe(1); // only the drafting turn — the release is model-free

    recorded.decide.length = 0;
    const cancel = await session.handleOperatorTurn('never mind');
    expect(cancel.reply).toBe(NOTHING_TO_CANCEL_ACK);
    expect(cancel.modelCalled).toBe(false);
    expect(recorded.decide).toHaveLength(1);
  });

  it('every model turn consults decideAfterModelReply (and no model-free turn does)', async () => {
    const { session } = makeSession();
    recorded.post.length = 0;

    await session.handleOperatorTurn("um, what was the last error about?"); // spoken question → post
    expect(recorded.post).toHaveLength(1);
    const [, reply] = recorded.post[0].args as [unknown, string];
    expect(reply).toBe('Noted.');
    // The decision passed to the post-model plan is a spoken decision.
    const decision = recorded.post[0].args[0] as { kind: string; plan: { path: string } };
    expect(['conversational', 'cancel']).toContain(decision.kind);
    expect(decision.plan.path).toBe('offer');

    await session.handleOperatorTurn('yes'); // nothing pending → mechanical, no post call
    await session.handleOperatorTurn('yes'); // nothing pending again
    expect(recorded.post).toHaveLength(1);
  });
});

describe('policy-core stays free of I/O-bearing imports', () => {
  const source = readFileSync(fileURLToPath(new URL('../../../src/talker/policy-core.ts', import.meta.url)), 'utf8');

  it('imports nothing from model clients, delivery, observability, the session or the filesystem', () => {
    const imports = [...source.matchAll(/^(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/model-client|delivery|observability|talker\.js|logger|logging|node:(fs|net|http|https|child_process|worker_threads|dns|tls)/);
    }
  });

  it('declares no async function and awaits nothing (decisions are synchronous)', () => {
    expect(source).not.toMatch(/\basync\s/);
    expect(source).not.toMatch(/\bawait\s/);
    expect(source).not.toMatch(/\bPromise\b/);
  });
});
