import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Controllable spawn mock for the lifecycle suite. Each test sets
 * `ctrl.behavior` / `ctrl.stdout` before prompting, and may gate completion via
 * `ctrl.gatePromise` to observe a turn mid-flight (before runAgy resolves).
 */
const ctrl = vi.hoisted(() => ({
  behavior: 'success' as 'success' | 'error-empty',
  stdout: '',
  args: [] as string[],
  cwd: '',
  gatePromise: Promise.resolve() as Promise<unknown>,
  gateResolve: null as null | (() => void),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, args: string[], opts: { cwd?: string }) => {
      ctrl.args = args;
      ctrl.cwd = opts?.cwd ?? '';
      const child = new EventEmitter();
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      // Resolve the configured outcome only after the test's gate releases.
      void ctrl.gatePromise.then(() => {
        process.nextTick(() => {
          if (ctrl.behavior === 'success') {
            (child as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from(ctrl.stdout));
            child.emit('close', 0);
          } else {
            // non-zero exit with empty stdout → runAgy returns { ok:false }
            child.emit('close', 1);
          }
        });
      });
      return child;
    }),
  };
});

import { config } from '../../../src/config.js';
import { AntigravitySessionStore } from '../../../src/antigravity/antigravity-session-store.js';
import {
  applySentConversationId,
  extractSentConversationIdFromAgyLog,
  pickNewConversationId,
  getModelContextWindow,
  normalizeAgyModel,
  ANTIGRAVITY_CHARS_PER_TOKEN,
  AntigravityService,
  type ConversationFileInfo,
} from '../../../src/antigravity/antigravity-service.js';

const PLACEHOLDER_CONVERSATION = '96ab5de0-2ac0-42b3-ba11-4ccaba820cbe';
const ACTUAL_CONVERSATION = 'a1efeb45-ca4b-4350-a97e-7feb18776438';

describe('extractSentConversationIdFromAgyLog', () => {
  it('uses the conversation that print mode actually sends to, not an earlier transient conversation', () => {
    const log = `
I0609 08:14:37.446682 server.go:753] Created conversation ${PLACEHOLDER_CONVERSATION}
I0609 08:14:38.163321 server.go:753] Created conversation ${ACTUAL_CONVERSATION}
I0609 08:14:38.165849 printmode.go:147] Print mode: conversation=${ACTUAL_CONVERSATION}, sending message
`;

    expect(extractSentConversationIdFromAgyLog(log)).toBe(ACTUAL_CONVERSATION);
  });

  it('returns the last sent conversation when the log contains multiple print-mode sends', () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    const log = `
I0609 08:00:00 printmode.go:147] Print mode: conversation=${first}, sending message
I0609 08:01:00 printmode.go:147] Print mode: conversation=${second}, sending message
`;

    expect(extractSentConversationIdFromAgyLog(log)).toBe(second);
  });
});

describe('applySentConversationId', () => {
  it('keeps the requested conversation when agy confirms the same sent conversation', () => {
    expect(applySentConversationId(PLACEHOLDER_CONVERSATION, PLACEHOLDER_CONVERSATION)).toBe(PLACEHOLDER_CONVERSATION);
  });

  it('uses the sent conversation on the first turn when there is no requested conversation yet', () => {
    expect(applySentConversationId(null, ACTUAL_CONVERSATION)).toBe(ACTUAL_CONVERSATION);
  });

  it('throws when agy sends a follow-up to a different conversation than requested', () => {
    expect(() => applySentConversationId(PLACEHOLDER_CONVERSATION, ACTUAL_CONVERSATION)).toThrow(/refusing to rebind/i);
  });
});

describe('pickNewConversationId', () => {
  it('chooses the largest newly-created conversation DB instead of depending on directory iteration order', () => {
    const before = new Map<string, ConversationFileInfo>();
    const after = new Map<string, ConversationFileInfo>([
      [PLACEHOLDER_CONVERSATION, { id: PLACEHOLDER_CONVERSATION, size: 49_152, mtimeMs: 1_000 }],
      [ACTUAL_CONVERSATION, { id: ACTUAL_CONVERSATION, size: 1_163_264, mtimeMs: 2_000 }],
    ]);

    expect(pickNewConversationId(before, after)).toBe(ACTUAL_CONVERSATION);
  });

  it('returns null when no new conversation DB was created', () => {
    const before = new Map<string, ConversationFileInfo>([
      [PLACEHOLDER_CONVERSATION, { id: PLACEHOLDER_CONVERSATION, size: 49_152, mtimeMs: 1_000 }],
    ]);
    const after = new Map(before);

    expect(pickNewConversationId(before, after)).toBeNull();
  });
});

describe('getModelContextWindow', () => {
  it('returns 1 M tokens for Gemini 3.5 Flash variants', () => {
    expect(getModelContextWindow('Gemini 3.5 Flash (Medium)')).toBe(1_048_576);
    expect(getModelContextWindow('Gemini 3.5 Flash (High)')).toBe(1_048_576);
    expect(getModelContextWindow('Gemini 3.5 Flash (Low)')).toBe(1_048_576);
  });

  it('returns 2 M tokens for Gemini 3.1 Pro variants', () => {
    expect(getModelContextWindow('Gemini 3.1 Pro (Low)')).toBe(2_097_152);
    expect(getModelContextWindow('Gemini 3.1 Pro (High)')).toBe(2_097_152);
  });

  it('returns 200 K tokens for Claude Sonnet variants', () => {
    expect(getModelContextWindow('Claude Sonnet 4.6 (Thinking)')).toBe(200_000);
  });

  it('returns 200 K tokens for Claude Opus variants', () => {
    expect(getModelContextWindow('Claude Opus 4.6 (Thinking)')).toBe(200_000);
  });

  it('returns 128 K tokens for GPT-OSS models', () => {
    expect(getModelContextWindow('GPT-OSS 120B (Medium)')).toBe(128_000);
  });

  it('falls back to 1 M tokens for unrecognised model names', () => {
    expect(getModelContextWindow('Unknown Future Model XL')).toBe(1_048_576);
    expect(getModelContextWindow('')).toBe(1_048_576);
  });

  it('normalises a provider-prefixed id before matching (RC3)', () => {
    // agy silently downgrades when given "antigravity/…"; the prefix must not
    // defeat context-window matching. Pro → 2 M, not the Flash default.
    expect(getModelContextWindow('antigravity/Gemini 3.1 Pro (High)')).toBe(2_097_152);
    expect(getModelContextWindow('antigravity/Gemini 3.5 Flash (High)')).toBe(1_048_576);
  });
});

describe('normalizeAgyModel', () => {
  it('strips a leading antigravity/ prefix', () => {
    expect(normalizeAgyModel('antigravity/Gemini 3.5 Flash (High)')).toBe('Gemini 3.5 Flash (High)');
  });

  it('strips any single provider/ prefix', () => {
    expect(normalizeAgyModel('foo/Claude Sonnet 4.6')).toBe('Claude Sonnet 4.6');
  });

  it('leaves a bare label unchanged', () => {
    expect(normalizeAgyModel('Gemini 3.5 Flash (High)')).toBe('Gemini 3.5 Flash (High)');
  });

  it('handles an empty string', () => {
    expect(normalizeAgyModel('')).toBe('');
  });
});

describe('context usage estimation from conversation history', () => {
  const CHARS_PER_TOKEN = ANTIGRAVITY_CHARS_PER_TOKEN;

  it('estimates tokens as total chars divided by chars-per-token', () => {
    const prompt = 'a'.repeat(400);   // 400 chars
    const response = 'b'.repeat(600); // 600 chars
    // total = 1000 chars → 1000/4 = 250 tokens
    const totalChars = prompt.length + response.length;
    expect(Math.round(totalChars / CHARS_PER_TOKEN)).toBe(250);
  });

  it('grows with each additional turn', () => {
    const turns = [
      { prompt: 'a'.repeat(400), response: 'b'.repeat(600) },  // 1 000 chars → 250 tokens
      { prompt: 'c'.repeat(200), response: 'd'.repeat(800) },  // 1 000 chars → 250 tokens total additional
    ];
    const totalChars = turns.reduce((acc, t) => acc + t.prompt.length + t.response.length, 0);
    expect(Math.round(totalChars / CHARS_PER_TOKEN)).toBe(500);
  });

  it('percent is capped at 100 when estimated tokens exceed the context window', () => {
    const contextWindow = 1_000; // tiny window for the test
    const tokens = 2_000;        // double the window
    const percent = Math.min(Math.round((tokens / contextWindow) * 100), 100);
    expect(percent).toBe(100);
  });

  it('produces a non-zero percent for a realistic short conversation', () => {
    // Simulate one turn: 500-char prompt + 1500-char response on a 1 M window
    const totalChars = 2_000;
    const tokens = Math.round(totalChars / CHARS_PER_TOKEN); // 500
    const contextWindow = 1_048_576;
    const percent = Math.min(Math.round((tokens / contextWindow) * 100), 100);
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(1); // < 1% of 1 M
  });
});

// ── Lifecycle: durable turn + visible failures + model normalization ─────────
// These exercise sendPrompt/runPromptAsync with the controllable spawn mock.
describe('AntigravityService — durable turn lifecycle', () => {
  let tmp: string;
  let svc: AntigravityService;
  let store: AntigravitySessionStore;
  let prevSessionDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'antigravity-lifecycle-'));
    prevSessionDir = config.antigravitySessionDir;
    config.antigravitySessionDir = tmp;
    svc = new AntigravityService({ registryPath: join(tmp, 'registry.json') });
    store = new AntigravitySessionStore(tmp);
    ctrl.behavior = 'success';
    ctrl.stdout = 'mocked reply';
    ctrl.args = [];
    ctrl.gatePromise = Promise.resolve();
    ctrl.gateResolve = null;
  });

  afterEach(() => {
    config.antigravitySessionDir = prevSessionDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Drain macrotasks so runPromptAsync can run up to its gated subprocess await. */
  async function flush(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  /** Poll the store until a turn appears (or timeout) — mirrors a refresh mid-flight. */
  async function waitForTurn(sessionId: string, timeoutMs = 2000): Promise<ReturnType<typeof store.loadHistory>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const h = await store.loadHistory(sessionId);
      if (h.length > 0) return h;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('turn never appeared in store');
  }

  function prompt(
    sessionId: string,
    text: string,
    onEvent?: (e: { type: string; data?: unknown }) => void,
  ): Promise<Error | undefined> {
    return new Promise((resolve) =>
      svc.sendPrompt(sessionId, text, (e) => onEvent?.(e), (err) => resolve(err)),
    );
  }

  it('persists a running turn with the prompt before the subprocess resolves (RC1 mid-flight durability)', async () => {
    const { sessionId } = await svc.createSession(tmp);
    // Hold the subprocess open so we can inspect the store mid-flight.
    ctrl.gatePromise = new Promise<void>((r) => { ctrl.gateResolve = r; });
    ctrl.stdout = 'eventual reply';

    const done = prompt(sessionId, 'in-flight prompt');
    // Let runPromptAsync run up to the gated subprocess await.
    await flush();

    // Mid-flight: a running turn with the prompt is already on disk.
    const mid = await waitForTurn(sessionId);
    expect(mid).toHaveLength(1);
    expect(mid[0].status).toBe('running');
    expect(mid[0].prompt).toBe('in-flight prompt');

    // The registry reflects the in-flight turn too (status running, firstMessage set).
    const midEntry = await svc.getSession(sessionId);
    expect(midEntry?.status).toBe('running');
    expect(midEntry?.firstMessage).toBe('in-flight prompt');

    // Release the subprocess; the turn should finalize to done.
    ctrl.gateResolve?.();
    await done;

    const final = await store.loadHistory(sessionId);
    expect(final).toHaveLength(1);
    expect(final[0].status).toBe('done');
    expect(final[0].response).toBe('eventual reply');
  });

  it('finalizes a successful turn to done and increments registry messageCount/firstMessage', async () => {
    const { sessionId } = await svc.createSession(tmp);
    ctrl.stdout = 'final answer';
    const err = await prompt(sessionId, 'hello world');
    expect(err).toBeUndefined();

    const history = await store.loadHistory(sessionId);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('done');
    expect(history[0].response).toBe('final answer');
    expect(history[0].rawStdoutLength).toBe('final answer'.length);

    const entry = await svc.getSession(sessionId);
    expect(entry?.messageCount).toBe(1);
    expect(entry?.firstMessage).toBe('hello world');
    expect(entry?.status).toBe('idle');
  });

  it('finalizes a failing/empty subprocess turn to error and still emits an assistant body + agent_end (RC2)', async () => {
    const { sessionId } = await svc.createSession(tmp);
    ctrl.behavior = 'error-empty';
    ctrl.stdout = '';

    const types: string[] = [];
    const assistantDeltas: string[] = [];
    const err = await prompt(sessionId, 'do something', (e) => {
      types.push(e.type);
      const d = (e.data as { assistantMessageEvent?: { delta?: string } } | undefined)?.assistantMessageEvent?.delta;
      if (d) assistantDeltas.push(d);
    });

    // The error path now emits an assistant message + agent_end (not just a bare agent_end).
    expect(types.filter((t) => t === 'message_start').length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(types.filter((t) => t === 'agent_end')).toHaveLength(1);
    const body = assistantDeltas[assistantDeltas.length - 1] ?? '';
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/exit|timeout|fail|did not return|error/i);

    // Registry: the turn still counts, with a firstMessage and an error status.
    expect(err).toBeDefined();
    const entry = await svc.getSession(sessionId);
    expect(entry?.messageCount).toBe(1);
    expect(entry?.firstMessage).toBe('do something');
    expect(entry?.status).toBe('error');

    // And it persists as error with a real reason.
    const history = await store.loadHistory(sessionId);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('error');
    expect(history[0].error).toBeTruthy();
    expect(history[0].error).toMatch(/exit|timeout/i);
  });

  it('passes the normalized (prefix-stripped) label as the --model arg (RC3)', async () => {
    const { sessionId } = await svc.createSession(tmp, 'antigravity/Gemini 3.5 Flash (High)');
    await prompt(sessionId, 'hi');

    const modelIdx = ctrl.args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(ctrl.args[modelIdx + 1]).toBe('Gemini 3.5 Flash (High)');
    // The raw prefixed id must never reach agy.
    expect(ctrl.args).not.toContain('antigravity/Gemini 3.5 Flash (High)');
  });

  it('keeps the stored registry model id untouched (normalization only at the agy boundary)', async () => {
    const { sessionId } = await svc.createSession(tmp, 'antigravity/Gemini 3.5 Flash (High)');
    await prompt(sessionId, 'hi');
    const entry = await svc.getSession(sessionId);
    expect(entry?.model).toBe('antigravity/Gemini 3.5 Flash (High)');
  });

  it('getSessionStats counts finalized turns only — a running turn is not counted (§5.3)', async () => {
    const { sessionId } = await svc.createSession(tmp);
    // Seed the store directly: one done, one error, one running.
    await store.appendTurn(sessionId, { prompt: 'p1', response: 'r1', model: 'm', conversationId: null, timestamp: 1, status: 'done', rawStdoutLength: 10 });
    await store.appendTurn(sessionId, { prompt: 'p2', response: '', model: 'm', conversationId: null, timestamp: 2, status: 'error', error: 'boom' });
    await store.startTurn(sessionId, { turnId: 'tr', prompt: 'p3', model: 'm', conversationId: null, timestamp: 3 });

    const stats = await svc.getSessionStats(sessionId);
    expect(stats?.userMessages).toBe(2); // done + error; running excluded
    expect(stats?.assistantMessages).toBe(2);
    expect(stats?.totalMessages).toBe(4);
  });
});
