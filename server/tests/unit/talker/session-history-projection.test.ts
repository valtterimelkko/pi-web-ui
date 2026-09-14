/**
 * P20 — the talker sees the worker session's earlier turns (mid-session attach).
 *
 * The gap (confirmed on a live turn): attaching Voice Mode to an ALREADY-RUNNING
 * worker and asking "What has happened earlier in this session?" reached
 * phase proposed — the talker offered to ask the worker because it genuinely
 * had nothing to answer from. `history.ts` is the talker's OWN conversation
 * window with the operator; `state-view.ts` supplied current status plus the
 * last assistant message only. Neither holds the worker session's earlier turns.
 *
 * The bounded outcome pinned here:
 *   1. the state view gains a bounded WORKER SESSION HISTORY block (recent
 *      conversation messages only), so a mid-session question about earlier
 *      turns is answerable from real history rather than deferred;
 *   2. boundedness is structural: entry cap, per-entry clip and a total char
 *      budget for the block — a huge session cannot blow up the projection;
 *   3. truncation is STATED in the view with exact counts, never hidden, and
 *      absence is stated by the block being absent — the talker must never
 *      imply knowledge beyond the window;
 *   4. the ask-the-worker offer is untouched and still fires when a question
 *      genuinely exceeds the window — the honest fallback, never a bluff;
 *   5. the gate is untouched: this package adds projection INPUT only.
 */
import { describe, it, expect } from 'vitest';

// RED: the fields and the block do not exist yet.
import { renderStateView, SESSION_HISTORY_LIMITS } from '../../../src/talker/state-view.js';
import { TalkerSessionRegistry } from '../../../src/talker/session-registry.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import type { DefaultDeliveries } from '../../../src/talker/delivery.js';
import type {
  ChatMessage,
  HarnessView,
  ModelTurnResult,
  TalkerModelClient,
  WorkerStateSnapshot,
} from '../../../src/talker/types.js';

const emptyHarness: HarnessView = { draft: null, lastReleased: null };

describe('P20 renderer: the WORKER SESSION HISTORY block', () => {
  const history = [
    { role: 'user' as const, text: 'fix the login bug first' },
    { role: 'assistant' as const, text: 'Fixed. Login now clears the stale token and I bumped the version to 2.3.1.' },
    { role: 'user' as const, text: 'now write the release notes' },
    { role: 'assistant' as const, text: 'Release notes drafted in CHANGELOG.md, ready for review.' },
  ];

  it('renders the session’s earlier turns oldest-first with operator/worker labels', () => {
    const view = renderStateView({ recentHistory: history, historyTotal: 4 }, emptyHarness);
    expect(view).toContain('--- WORKER SESSION HISTORY ---');
    const block = view.slice(view.indexOf('--- WORKER SESSION HISTORY ---'), view.indexOf('--- END STATE ---'));
    expect(block.indexOf('fix the login bug first')).toBeLessThan(block.indexOf('Release notes drafted'));
    expect(block).toContain('operator: fix the login bug first');
    expect(block).toContain('worker: Fixed. Login now clears the stale token');
  });

  it('states truncation with exact counts when the window hides earlier messages', () => {
    const total = 30;
    const view = renderStateView({ recentHistory: history, historyTotal: total }, emptyHarness);
    expect(view).toContain(`Showing the most recent ${history.length} of ${total} messages`);
    expect(view).toContain(`${total - history.length} earlier are not included`);
  });

  it('states completeness when nothing is hidden (so the talker need not hedge)', () => {
    const view = renderStateView({ recentHistory: history, historyTotal: history.length }, emptyHarness);
    expect(view).toContain(`All ${history.length} messages of the session so far are shown.`);
    expect(view).not.toContain('not included');
  });

  it('absent history means NO block — the view never implies knowledge it was not given', () => {
    const view = renderStateView({ activity: 'worker status: idle' }, emptyHarness);
    expect(view).not.toContain('WORKER SESSION HISTORY');
    // And an explicitly empty history is equally silent.
    expect(renderStateView({ recentHistory: [], historyTotal: 0 }, emptyHarness)).not.toContain('WORKER SESSION HISTORY');
  });

  it('is bounded: a pathological history cannot blow up the view', () => {
    const long = 'z'.repeat(5000);
    const bloated: WorkerStateSnapshot = {
      recentHistory: Array.from({ length: 400 }, (_, i) =>
        i % 2 === 0 ? { role: 'user' as const, text: `turn ${i} ${long}` } : { role: 'assistant' as const, text: long }
      ),
      historyTotal: 400,
    };
    const view = renderStateView(bloated, emptyHarness);
    expect(view.length).toBeLessThan(8000); // block budget + the rest of the view's own bounds
    expect(view.match(/^(operator|worker): /gm)?.length ?? 0).toBeLessThanOrEqual(SESSION_HISTORY_LIMITS.entries);
  });

  it('the total char budget trims the oldest entries within the window, and the disclosure still accounts for them', () => {
    // entryChars * entries far exceeds totalChars: budget, not count, is the binder.
    const filler = 'w'.repeat(SESSION_HISTORY_LIMITS.entryChars);
    const entries = Array.from({ length: SESSION_HISTORY_LIMITS.entries }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `msg ${i} ${filler}`,
    }));
    const view = renderStateView({ recentHistory: entries, historyTotal: entries.length }, emptyHarness);
    const shown = view.match(/^(operator|worker): /gm)?.length ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(SESSION_HISTORY_LIMITS.entries);
    // Budget-dropped entries are disclosed as "earlier", not silently gone.
    expect(view).toContain(`Showing the most recent ${shown} of ${entries.length} messages`);
    expect(view).toContain(`${entries.length - shown} earlier are not included`);
    // What IS shown is the NEWEST part of the window.
    expect(view).toContain(`msg ${entries.length - 1} `);
    expect(view).not.toContain(`msg 0 ${filler}`);
  });

  it('per-entry text is clipped to entryChars', () => {
    const view = renderStateView(
      { recentHistory: [{ role: 'assistant', text: 'q'.repeat(5000) }], historyTotal: 1 },
      emptyHarness
    );
    const line = view.split('\n').find(l => l.startsWith('worker: ')) as string;
    expect(line.length).toBeLessThanOrEqual('worker: '.length + SESSION_HISTORY_LIMITS.entryChars + 2);
  });

  it('stays deterministic, and the pre-existing section shape is untouched', () => {
    const snapshot: WorkerStateSnapshot = {
      activity: 'worker status: idle',
      recentHistory: history,
      historyTotal: history.length,
    };
    const view = renderStateView(snapshot, emptyHarness);
    expect(view).toBe(renderStateView(snapshot, emptyHarness));
    expect(view).toContain('--- WORKER STATE ---');
    expect(view).toContain('--- END STATE ---');
    expect(view.length).toBeLessThan(6000);
  });
});

// ── Providers: the registry feeds real session history into the view ──────

const OPERATOR_MARKER = '\n\nOPERATOR (out loud):';

/** A model client that records the rendered state view of every turn and can
 *  be scripted on what it sees (the stub stands in for the real talker model). */
function scriptedModel(answer: (view: string) => string): TalkerModelClient & { views(): string[] } {
  const seen: string[] = [];
  return {
    views: () => seen,
    async completeTurn(messages: ChatMessage[]): Promise<ModelTurnResult> {
      const last = messages[messages.length - 1];
      const idx = last.content.indexOf(OPERATOR_MARKER);
      const view = idx === -1 ? last.content : last.content.slice(0, idx);
      seen.push(view);
      return { text: answer(view), ttftMs: 5, totalMs: 10 };
    },
  };
}

function nullDeliveries(): DefaultDeliveries {
  return { pi: createNullDelivery(), claude: createNullDelivery(), antigravity: createNullDelivery() };
}

function piManager(messages: unknown[]): unknown {
  return {
    getSessionStatus: () => ({ status: 'idle', currentStep: 0 }),
    getAgentSession: () => ({ messages }),
  };
}

function registryWithMessages(messages: unknown[], answer: (view: string) => string): {
  registry: TalkerSessionRegistry;
  model: ReturnType<typeof scriptedModel>;
} {
  const model = scriptedModel(answer);
  const manager = messages.length
    ? piManager(messages)
    : { getSessionStatus: () => undefined, getAgentSession: () => undefined };
  const registry = new TalkerSessionRegistry({
    multiSessionManager: manager as never,
    deliveries: nullDeliveries(),
    modelClient: model,
  });
  return { registry, model };
}

const CONVERSATION = [
  { role: 'user', content: 'audit the auth module for stale tokens' },
  { role: 'assistant', content: [{ type: 'text', text: 'Found two stale-token paths. Writing the fix now.' }] },
  { role: 'toolResult', content: ' gigantic tool output that must never reach the talker ' },
  { role: 'user', content: 'good — then update CHANGELOG.md' },
  { role: 'assistant', content: 'CHANGELOG.md updated with both fixes under 2.3.1.' },
];

describe('P20 providers: the worker session’s real history reaches the view', () => {
  it('a mid-session pi worker: conversation messages reach the view, tool noise never does', async () => {
    const { registry, model } = registryWithMessages(CONVERSATION, () => 'Noted.');
    await registry.handleOperatorTurn({ workerSessionId: 'pi-w', utterance: 'status?', runtime: 'pi' });

    const view = model.views()[0];
    expect(view).toContain('--- WORKER SESSION HISTORY ---');
    expect(view).toContain('operator: audit the auth module for stale tokens');
    expect(view).toContain('worker: CHANGELOG.md updated with both fixes under 2.3.1.');
    expect(view).not.toContain('gigantic tool output');
    // historyTotal counts only conversation messages: exactly what the disclosure needs.
    expect(view).toContain('All 4 messages of the session so far are shown.');
  });

  it('a long pi session: the provider tail keeps the projection cheap and the disclosure states the true total', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i} of three hundred`,
    }));
    const { registry, model } = registryWithMessages(many, () => 'Noted.');
    await registry.handleOperatorTurn({ workerSessionId: 'pi-w', utterance: 'status?', runtime: 'pi' });

    const view = model.views()[0];
    expect(view).toContain('--- WORKER SESSION HISTORY ---');
    // The view shows the newest tail…
    expect(view).toContain('turn 299 of three hundred');
    expect(view).not.toContain('turn 0 of three hundred');
    // …and states exactly what it did not include.
    expect(view).toMatch(/Showing the most recent \d+ of 300 messages/);
    expect(view).toMatch(/\d+ earlier are not included/);
  });

  it('an unloaded pi session gets no history block (the honest minimal view stands)', async () => {
    const { registry, model } = registryWithMessages([], () => 'Noted.');
    await registry.handleOperatorTurn({ workerSessionId: 'pi-w', utterance: 'status?', runtime: 'pi' });
    expect(model.views()[0]).not.toContain('WORKER SESSION HISTORY');
  });

  it('a claude worker: loadSessionHistory entries reach the view', async () => {
    const model = scriptedModel(() => 'Noted.');
    const registry = new TalkerSessionRegistry({
      multiSessionManager: { getSessionStatus: () => undefined, getAgentSession: () => undefined } as never,
      deliveries: nullDeliveries(),
      modelClient: model,
      claudeWorkerState: {
        hasSession: () => true,
        isRunning: () => false,
        getSession: async () => ({ status: 'idle' }),
        loadSessionHistory: async () => [
          { type: 'meta', content: 'session opened' },
          { type: 'user', content: 'migrate the database when ready' },
          { type: 'assistant', content: 'Migration planned; waiting for your go.' },
          { type: 'tool', content: 'tool noise stays out' },
        ],
      },
    });
    await registry.handleOperatorTurn({ workerSessionId: 'cl-w', utterance: 'status?', runtime: 'claude' });

    const view = model.views()[0];
    expect(view).toContain('--- WORKER SESSION HISTORY ---');
    expect(view).toContain('operator: migrate the database when ready');
    expect(view).toContain('worker: Migration planned; waiting for your go.');
    expect(view).not.toContain('tool noise stays out');
    expect(view).toContain('All 2 messages of the session so far are shown.');
  });

  it('claude history that fails to load degrades to the status view — no block, no invented history', async () => {
    const model = scriptedModel(() => 'Noted.');
    const registry = new TalkerSessionRegistry({
      multiSessionManager: { getSessionStatus: () => undefined, getAgentSession: () => undefined } as never,
      deliveries: nullDeliveries(),
      modelClient: model,
      claudeWorkerState: {
        hasSession: () => true,
        isRunning: () => false,
        getSession: async () => ({ status: 'idle' }),
        loadSessionHistory: async () => {
          throw new Error('disk gone');
        },
      },
    });
    await registry.handleOperatorTurn({ workerSessionId: 'cl-w', utterance: 'status?', runtime: 'claude' });
    const view = model.views()[0];
    expect(view).toContain('Worker: worker status: idle');
    expect(view).not.toContain('WORKER SESSION HISTORY');
  });
});

// ── The turn: answered from history when it can, deferring honestly when not ──

const MID_SESSION_HISTORY = [
  { role: 'user', content: 'please fix the login bug and bump the version' },
  { role: 'assistant', content: 'Login bug fixed, version bumped to 2.3.1, tests green.' },
];

describe('P20 the turn: answered from history, or deferred honestly', () => {
  it('a mid-session question about earlier turns is answerable: the model SEES the real history and no relay is proposed', async () => {
    const { registry, model } = registryWithMessages(
      MID_SESSION_HISTORY,
      view =>
        view.includes('--- WORKER SESSION HISTORY ---')
          ? 'Earlier in this session you asked the worker to fix the login bug, and it did — version 2.3.1, tests green.'
          : 'I don’t have the earlier turns — want me to pass the question to the worker? [[ask-worker]]'
    );
    const result = await registry.handleOperatorTurn({
      workerSessionId: 'pi-w',
      utterance: 'What has happened earlier in this session?',
      runtime: 'pi',
    });

    // The harness handed the session's REAL history to the model on this very turn…
    expect(model.views()[0]).toContain('--- WORKER SESSION HISTORY ---');
    expect(model.views()[0]).toContain('please fix the login bug and bump the version');
    // …so the answer comes from it, not from a relay offer.
    expect(result.reply).toContain('fix the login bug');
    expect(result.turn?.askWorkerOffer).toBeUndefined();
    expect(result.turn?.released ?? null).toBeNull(); // and nothing was sent — the gate is untouched
  });

  it('an over-window question still defers honestly: the offer fires and holds the operator’s VERBATIM words', async () => {
    // Thirty earlier turns exist; the view can hold only its recent window and
    // says exactly that — a question about the March work falls outside it.
    const longAgo = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}: the March retry-bug investigation continued`,
    }));
    const { registry, model } = registryWithMessages(longAgo, view =>
      /earlier are not included/.test(view)
        ? 'That part is older than the history I hold — want me to pass the question to the worker? [[ask-worker]]'
        : 'Here is what the history shows.'
    );
    const QUESTION = 'What did we decide about the March retry-bug fix?';
    const result = await registry.handleOperatorTurn({
      workerSessionId: 'pi-w',
      utterance: QUESTION,
      runtime: 'pi',
    });

    // The view still told the truth about its limit…
    expect(model.views()[0]).toMatch(/\d+ earlier are not included/);
    // …the model deferred, and the harness honoured the offer mechanically.
    expect(result.turn?.askWorkerOffer).toBe(true);
    expect(result.reply).not.toContain('[[ask-worker]]'); // the tag is never spoken
    expect(result.turn?.released ?? null).toBeNull();
    // The relay candidate is the OPERATOR'S OWN question, word for word.
    const draft = registry.get('pi-w', 'pi')?.proposals.snapshotDraft();
    expect(draft?.utterances.map(u => u.text)).toEqual([QUESTION]);
  });

  it('without any history the same question still reaches the offer path (fresh-session attach)', async () => {
    const { registry, model } = registryWithMessages(
      [],
      () => 'I don’t have the earlier turns — want me to pass the question to the worker? [[ask-worker]]'
    );
    const result = await registry.handleOperatorTurn({
      workerSessionId: 'pi-w',
      utterance: 'What has happened earlier in this session?',
      runtime: 'pi',
    });
    expect(model.views()[0]).not.toContain('WORKER SESSION HISTORY');
    expect(result.turn?.askWorkerOffer).toBe(true);
  });
});
