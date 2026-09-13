/**
 * P11 (F3 closure): per-runtime worker state view.
 *
 * Finding F3 (docs/plans/VOICE-MODE-VALIDATION-RESULTS.md §7): the talker's
 * state snapshot read only the Pi MultiSessionManager, so a Claude worker got
 * the honest-but-blind "worker session is not loaded on this server" for every
 * status question. This suite pins the fix:
 *
 *   1. Claude workers get a real snapshot via a read-only Claude state source
 *      (activity + last assistant text) — blindness is closed.
 *   2. Honesty is preserved, never traded: an unknown Claude session still
 *      yields the blind fallback; a failing state source yields a plain
 *      cannot-observe line; no snapshot ever implies unobserved activity.
 *   3. Runtimes without a provider (antigravity) keep an explicit honest
 *      cannot-tell fallback — never an invented status, never the Pi manager
 *      read by accident.
 *   4. The Pi path is byte-for-byte unchanged (same status line as before,
 *      from the same manager).
 *
 * The snapshot is observed the way production observes it: through the talker's
 * conversational turn, which embeds the rendered state view in the model call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/claude/index.js', () => ({
  getClaudeService: () => {
    throw new Error('default claude source must not be resolved when an explicit one is injected');
  },
}));

import { TalkerSessionRegistry } from '../../../src/talker/session-registry.js';
import type { DefaultDeliveries } from '../../../src/talker/delivery.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import type { ChatMessage, ModelTurnResult, TalkerModelClient } from '../../../src/talker/types.js';
import type { TalkerClaudeWorkerState } from '../../../src/talker/session-registry.js';

const OPERATOR_MARKER = '\n\nOPERATOR (out loud):';

/** A model client that records the rendered state view of every turn. */
function capturingModel(reply = 'Here is what I can see.'): TalkerModelClient & { stateViews(): string[] } {
  const views: string[] = [];
  return {
    stateViews: () => views,
    async completeTurn(messages: ChatMessage[]): Promise<ModelTurnResult> {
      const last = messages[messages.length - 1];
      const idx = last.content.indexOf(OPERATOR_MARKER);
      views.push(idx === -1 ? last.content : last.content.slice(0, idx));
      return { text: reply, ttftMs: 5, totalMs: 10 };
    },
  };
}

function nullDeliveries(): DefaultDeliveries {
  return { pi: createNullDelivery(), claude: createNullDelivery(), antigravity: createNullDelivery() };
}

function claudeSource(overrides: Partial<TalkerClaudeWorkerState> = {}): TalkerClaudeWorkerState {
  return {
    hasSession: vi.fn(() => true),
    isRunning: vi.fn(() => true),
    getSession: vi.fn(async () => ({ status: 'running' })),
    loadSessionHistory: vi.fn(async () => [
      { type: 'user', content: 'run the migration when ready' },
      { type: 'assistant', content: 'CLAUDE-LAST-WORD: the migration is halfway through.' },
    ]),
    ...overrides,
  };
}

interface Harness {
  registry: TalkerSessionRegistry;
  model: ReturnType<typeof capturingModel>;
  source: TalkerClaudeWorkerState;
  ask(workerSessionId: string, runtime: 'pi' | 'claude' | 'antigravity', utterance?: string): Promise<string>;
}

function makeHarness(opts: {
  claudeWorkerState?: TalkerClaudeWorkerState;
  manager?: unknown;
}): Harness {
  const model = capturingModel();
  const manager = opts.manager ?? {
    getSessionStatus: () => undefined,
    getAgentSession: () => undefined,
  };
  const registry = new TalkerSessionRegistry({
    multiSessionManager: manager as never,
    deliveries: nullDeliveries(),
    modelClient: model,
    ...(opts.claudeWorkerState !== undefined ? { claudeWorkerState: opts.claudeWorkerState } : {}),
  });
  return {
    registry,
    model,
    source: opts.claudeWorkerState as TalkerClaudeWorkerState,
    async ask(workerSessionId, runtime, utterance = 'how is the worker doing right now?') {
      const result = await registry.handleOperatorTurn({ workerSessionId, utterance, runtime });
      return result.reply;
    },
  };
}

/** The state view the talker saw on the most recent turn for this session. */
function lastView(h: Harness): string {
  const views = h.model.stateViews();
  expect(views.length).toBeGreaterThan(0);
  return views[views.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('P11: a claude worker yields its real state, not the blind fallback', () => {
  it('a claude worker with observable state gets a real claude snapshot (activity + last assistant text)', async () => {
    const h = makeHarness({ claudeWorkerState: claudeSource() });
    await h.ask('claude-worker-1', 'claude');

    const view = lastView(h);
    expect(view).toContain('Worker: worker status: running');
    expect(view).toContain('Worker last said: CLAUDE-LAST-WORD: the migration is halfway through.');
    // The blindness is gone — the old F3 fallback must not appear.
    expect(view).not.toContain('worker session is not loaded on this server');
  });

  it('a busy-then-idle claude worker reflects the live observation over the stale registry status', async () => {
    const h = makeHarness({
      claudeWorkerState: claudeSource({
        isRunning: () => false,
        getSession: vi.fn(async () => ({ status: 'running' })), // stale on-disk claim
      }),
    });
    await h.ask('claude-worker-1', 'claude');

    const view = lastView(h);
    // A live not-running observation must never be reported as running.
    expect(view).toContain('Worker: worker status: idle');
    expect(view).not.toContain('worker status: running');
  });

  it('a claude worker in the error registry state reports error, honestly', async () => {
    const h = makeHarness({
      claudeWorkerState: claudeSource({
        isRunning: () => false,
        getSession: vi.fn(async () => ({ status: 'error' })),
      }),
    });
    await h.ask('claude-worker-1', 'claude');
    expect(lastView(h)).toContain('Worker: worker status: error');
  });

  it('history that fails to load degrades to the status-only view (still real status, no invented text)', async () => {
    const h = makeHarness({
      claudeWorkerState: claudeSource({
        loadSessionHistory: vi.fn(async () => {
          throw new Error('disk gone');
        }),
      }),
    });
    await h.ask('claude-worker-1', 'claude');

    const view = lastView(h);
    expect(view).toContain('Worker: worker status: running');
    expect(view).not.toContain('Worker last said:');
  });

  it('an assistant entry with blank content is never surfaced as the last words', async () => {
    const h = makeHarness({
      claudeWorkerState: claudeSource({
        loadSessionHistory: vi.fn(async () => [
          { type: 'assistant', content: 'real earlier answer' },
          { type: 'assistant', content: '   ' },
        ]),
      }),
    });
    await h.ask('claude-worker-1', 'claude');
    expect(lastView(h)).toContain('Worker last said: real earlier answer');
  });
});

describe('P11: honesty is preserved, not traded away', () => {
  it('an unknown claude session still yields the honest blind fallback', async () => {
    const h = makeHarness({
      claudeWorkerState: claudeSource({ hasSession: vi.fn(() => false) }),
    });
    await h.ask('never-seen-session', 'claude');
    expect(lastView(h)).toContain('worker session is not loaded on this server');
  });

  it('a failing claude state source yields a plain cannot-observe line, never a status', async () => {
    const h = makeHarness({
      claudeWorkerState: claudeSource({
        hasSession: vi.fn(() => {
          throw new Error('source exploded');
        }),
      }),
    });
    await h.ask('claude-worker-1', 'claude');
    const view = lastView(h);
    expect(view).toContain('Worker: worker state for claude workers is not available on this server yet');
    expect(view).not.toContain('worker status:');
  });

  it('an unimplemented runtime (antigravity) keeps the explicit honest cannot-tell fallback', async () => {
    const h = makeHarness({ claudeWorkerState: claudeSource() });
    await h.ask('agy-worker-1', 'antigravity');

    const view = lastView(h);
    expect(view).toContain('Worker: worker state for antigravity workers is not available on this server yet');
    // No invented status, and never an accidental read of the Pi manager.
    expect(view).not.toContain('worker status:');
    expect(view).not.toContain('worker session is not loaded on this server');
  });

  it('the default wiring resolves the server Claude service lazily (production path, no dep supplied)', async () => {
    // claude/index.js is mocked at the top of this file to throw on resolve,
    // so the only way this turn answers is via the honest cannot-observe line —
    // proving the default path exists, is lazy, and degrades honestly.
    const h = makeHarness({});
    await h.ask('claude-worker-1', 'claude');
    expect(lastView(h)).toContain('Worker: worker state for claude workers is not available on this server yet');
  });
});

describe('P11: the pi path is unchanged', () => {
  it('a pi worker still reads the Pi manager exactly as before (status + step suffix)', async () => {
    const h = makeHarness({
      claudeWorkerState: claudeSource(),
      manager: {
        getSessionStatus: (id: string) => ({
          sessionPath: id,
          sessionId: id,
          status: 'busy',
          lastActivity: new Date(),
          messageCount: 3,
          currentStep: 2,
          subscriberCount: 0,
          pinned: false,
        }),
        getAgentSession: () => undefined,
      },
    });
    await h.ask('pi-worker-1', 'pi');

    const view = lastView(h);
    expect(view).toContain('Worker: worker status: busy, step 2');
    // The claude source must not have been consulted for a pi worker.
    expect(h.source.hasSession).not.toHaveBeenCalled();
    expect(h.source.isRunning).not.toHaveBeenCalled();
  });

  it('an unloaded pi worker still gets the honest minimal view', async () => {
    const h = makeHarness({ claudeWorkerState: claudeSource() });
    await h.ask('pi-worker-unloaded', 'pi');
    expect(lastView(h)).toContain('worker session is not loaded on this server');
  });
});
