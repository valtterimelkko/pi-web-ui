/**
 * The operator's 2026-09-18 report, again: *"I was asking it if it can summarise
 * what the worker had been doing … but basically the talker told me it does not
 * have access to the session."*
 *
 * This run is different from the earlier one in the way that matters. The worker
 * session was real, registered, and readable — `status: idle`, 540 messages, a
 * session file on disk — but it was **not loaded in the server's memory**, so the
 * talker's projection (which read only `manager.getAgentSession(id).messages`)
 * saw an empty conversation and told the truth about the empty thing it held,
 * while the UI showed the session perfectly well because the UI reads the file.
 *
 * These tests pin the fix at the level the operator experiences: the state view
 * the talker is given must contain the worker's actual conversation for a session
 * that is on disk but not in memory — and must stay honest when it is not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/claude/index.js', () => ({
  getClaudeService: () => {
    throw new Error('claude service must not be resolved for a pi worker');
  },
}));

/** Counts real stream reads, so the once-a-second poll's caching can be proven. */
const readCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../src/talker/session-file-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/talker/session-file-history.js')>();
  return {
    ...actual,
    readSessionFileHistory: (...args: Parameters<typeof actual.readSessionFileHistory>) => {
      readCalls.count += 1;
      return actual.readSessionFileHistory(...args);
    },
  };
});

import { TalkerSessionRegistry } from '../../../src/talker/session-registry.js';
import { createNullDelivery, type DefaultDeliveries } from '../../../src/talker/delivery.js';
import type { ChatMessage, ModelTurnResult, TalkerModelClient } from '../../../src/talker/types.js';

const OPERATOR_MARKER = '\n\nOPERATOR (out loud):';

interface Harness {
  registry: TalkerSessionRegistry;
  views: string[];
  resolver: ReturnType<typeof vi.fn>;
  ask(workerSessionId: string): Promise<string>;
}

function nullDeliveries(): DefaultDeliveries {
  return { pi: createNullDelivery(), claude: createNullDelivery(), antigravity: createNullDelivery() };
}

function makeHarness(opts: {
  resolver?: (sessionId: string) => Promise<{ path: string; cwd?: string } | undefined>;
  manager?: Record<string, unknown>;
} = {}): Harness {
  const views: string[] = [];
  const model: TalkerModelClient = {
    async completeTurn(messages: ChatMessage[]): Promise<ModelTurnResult> {
      const last = messages[messages.length - 1];
      const idx = last.content.indexOf(OPERATOR_MARKER);
      views.push(idx === -1 ? last.content : last.content.slice(0, idx));
      return { text: 'Here is what I can see.', ttftMs: 5, totalMs: 10 };
    },
  };
  const resolver = vi.fn(opts.resolver ?? (async () => undefined));
  const registry = new TalkerSessionRegistry({
    multiSessionManager: (opts.manager ?? { getSessionStatus: () => undefined, getAgentSession: () => undefined }) as never,
    deliveries: nullDeliveries(),
    modelClient: model,
    resolveWorkerSession: resolver,
  });
  return {
    registry,
    views,
    resolver,
    async ask(workerSessionId: string) {
      const result = await registry.handleOperatorTurn({
        workerSessionId,
        utterance: 'summarise what the worker has been doing',
        runtime: 'pi',
      });
      return result.reply;
    },
  };
}

const dirs: string[] = [];

function sessionFile(lines: Array<[('user' | 'assistant' | 'toolResult'), string]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'voice-lane-disk-'));
  dirs.push(dir);
  const path = join(dir, 'session.jsonl');
  writeFileSync(
    path,
    lines
      .map(([role, text]) =>
        JSON.stringify({ type: 'message', id: `m-${text.length}`, message: { role, content: [{ type: 'text', text }], timestamp: 1 } })
      )
      .join('\n') + '\n'
  );
  return path;
}

/** A manager that knows the session (as production does) but holds no messages. */
const registeredButUnloaded = {
  getSessionStatus: (id: string) => ({
    sessionPath: id,
    sessionId: id,
    status: 'idle',
    lastActivity: new Date(),
    messageCount: 540,
    subscriberCount: 0,
    pinned: false,
  }),
  getAgentSession: () => undefined,
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('an unloaded worker session is read from its file, not reported empty', () => {
  it('the talker is given the on-disk conversation of a session that is not in memory', async () => {
    const path = sessionFile([
      ['user', 'Please make the voice lane capture work in the deployed UI.'],
      ['assistant', 'Found it: the worklet was loading from a blob URL the production CSP refuses.'],
      ['toolResult', 'bash noise'],
    ]);
    const h = makeHarness({ resolver: async () => ({ path }), manager: registeredButUnloaded });

    await h.ask('01a0a575-7d40-7494-847d-2f42042c7759');

    const view = h.views.at(-1)!;
    expect(view).toContain('WORKER SESSION HISTORY');
    expect(view).toContain('the worklet was loading from a blob URL');
    expect(view).not.toContain('bash noise');
  });

  it('still reports the honest minimal view when there is no session file to read', async () => {
    const h = makeHarness({ resolver: async () => undefined, manager: registeredButUnloaded });

    await h.ask('not-on-disk-at-all');

    const view = h.views.at(-1)!;
    expect(view).toContain('worker status: idle');
    // Nothing invented to fill the gap: no history block at all.
    expect(view).not.toContain('WORKER SESSION HISTORY');
  });

  it('distinguishes an existing session with no messages from one it cannot resolve (2026-09-22)', async () => {
    // The operator opened a brand-new session and pressed Start listening; the
    // talker said it could not access the work session. An empty session that
    // EXISTS must not be described as "not loaded".
    const empty = sessionFile([]);
    const withEmpty = makeHarness({ resolver: async () => ({ path: empty }) });
    await withEmpty.ask('01a0c85e-161c-7732-83ed-b45a7eb0bf11');
    const emptyView = withEmpty.views.at(-1)!;
    expect(emptyView).toContain('worker session is new; it has no messages yet');
    expect(emptyView).not.toContain('worker session is not loaded on this server');

    const unresolvable = makeHarness({ resolver: async () => undefined });
    await unresolvable.ask('never-existed');
    expect(unresolvable.views.at(-1)!).toContain('worker session is not loaded on this server');
  });

  it('does not read the file when the manager already holds the session in memory', async () => {
    const h = makeHarness({
      resolver: async () => ({ path: '/does/not/matter.jsonl' }),
      manager: {
        getSessionStatus: () => ({ status: 'idle', messageCount: 2 }),
        getAgentSession: () => ({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'in-memory question' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'in-memory answer' }] },
          ],
        }),
      },
    });

    await h.ask('loaded-session');

    const view = h.views.at(-1)!;
    expect(view).toContain('in-memory answer');
    expect(h.resolver).not.toHaveBeenCalled();
  });

  it('a resolver that fails leaves the honest view intact, never an invented conversation', async () => {
    const h = makeHarness({
      resolver: async () => {
        throw new Error('registry is down');
      },
      manager: registeredButUnloaded,
    });

    await h.ask('registry-down');

    const view = h.views.at(-1)!;
    expect(view).not.toContain('WORKER SESSION HISTORY');
  });

  it('reads the file ONCE for an unchanged file, however often the status poll runs', async () => {
    // The worker-status poll runs every second per live lane. A 5 MB session
    // re-streamed once a second would be a CPU leak, so the read is cached by the
    // file's own version and an unchanged file costs a stat and nothing more.
    const path = sessionFile([
      ['user', 'the operator question'],
      ['assistant', 'the worker answer'],
    ]);
    const h = makeHarness({ resolver: async () => ({ path }), manager: registeredButUnloaded });

    readCalls.count = 0;
    await h.registry.workerStateSnapshot('polled-session');
    await h.registry.workerStateSnapshot('polled-session');
    await h.registry.workerStateSnapshot('polled-session');

    expect(readCalls.count).toBe(1);
  });

  it('re-reads when the file HAS changed, so a resumed session is never served stale', async () => {
    const path = sessionFile([
      ['user', 'first question'],
      ['assistant', 'first answer'],
    ]);
    const h = makeHarness({ resolver: async () => ({ path }), manager: registeredButUnloaded });

    const first = await h.registry.workerStateSnapshot('resumed-session');
    expect(first.recentHistory?.at(-1)?.text).toBe('first answer');

    writeFileSync(
      path,
      [
        ['user', 'first question'],
        ['assistant', 'first answer'],
        ['assistant', 'the answer that arrived after the session was resumed'],
      ]
        .map(([, text]) => JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 } }))
        .join('\n') + '\n'
    );

    const second = await h.registry.workerStateSnapshot('resumed-session');
    expect(second.recentHistory?.at(-1)?.text).toBe('the answer that arrived after the session was resumed');
  });
});
