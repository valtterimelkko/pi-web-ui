/**
 * B3b — per-run output-token and streamed-byte budgets (the rest of B3).
 *
 * The same 2026-09-12 stall class B3a bounded for tool-call arguments also
 * covers plain runaway GENERATION: a turn that streams text/thinking/tool
 * arguments without bound monopolises the event loop and heap. This guard
 * sits beside `ToolArgsBudgetGuard` at the same single PiService subscribe
 * funnel and enforces, per run (agent_start → agent_end):
 *
 *   - an OUTPUT-TOKEN cap over public usage reported at `message_end`
 *     (pi-ai reports usage only in the final streaming chunk, i.e. at message
 *     end — mid-stream the STREAMED-BYTE cap is the live bound);
 *   - a STREAMED-BYTE cap over every streamed assistant delta (text +
 *     thinking + tool-call arguments, UTF-8 bytes).
 *
 * On breach it emits one synthetic `run_budget_exceeded` event (data.budget
 * distinguishes "output_tokens" from "streamed_bytes") through the same
 * handler, then aborts the turn via the public `AgentSession.abort()` with
 * the same bounded single-in-flight retry pattern B3a's corrections pinned.
 */
import { describe, expect, it } from 'vitest';

import {
  PiRunBudgetExceededError,
  RUN_BUDGET_EXCEEDED_EVENT,
  RunBudgetGuard,
} from '../../../src/pi/run-budget.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

const agentStart = (): Record<string, unknown> => ({ type: 'agent_start' });

const streamDelta = (kind: 'text_delta' | 'thinking_delta' | 'toolcall_delta', delta: string): Record<string, unknown> => ({
  type: 'message_update',
  message: { role: 'assistant', id: 'm1' },
  assistantMessageEvent: { type: kind, contentIndex: 0, delta, partial: {} },
});

const messageEnd = (role: string, usageOutput: number | undefined): Record<string, unknown> => ({
  type: 'message_end',
  message: {
    role,
    content: [],
    ...(usageOutput === undefined ? {} : { usage: { input: 10, output: usageOutput, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + (usageOutput ?? 0) } }),
  },
});

interface Harness {
  aborted: number;
  abort: () => Promise<void>;
  emitted: Record<string, unknown>[];
  emit: (event: Record<string, unknown>) => void;
}

function makeSession(): Harness {
  const harness: Harness = {
    aborted: 0,
    abort: async () => {
      harness.aborted += 1;
    },
    emitted: [],
    emit: (event) => {
      harness.emitted.push(event);
    },
  };
  return harness;
}

/** Feed `bytes` UTF-8 bytes as ASCII deltas of `chunk` bytes each. */
function feedBytes(guard: RunBudgetGuard, session: Harness, kind: 'text_delta' | 'thinking_delta' | 'toolcall_delta', bytes: number, chunk = 64): void {
  let remaining = bytes;
  while (remaining > 0) {
    const size = Math.min(chunk, remaining);
    guard.observe(session, streamDelta(kind, 'x'.repeat(size)), session.emit);
    remaining -= size;
  }
}

// ─── streamed-byte budget ────────────────────────────────────────────────────

describe('RunBudgetGuard — streamed bytes', () => {
  it('does not breach a stream under the byte cap (no emit, no abort)', () => {
    const guard = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 4096 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    feedBytes(guard, session, 'text_delta', 4000);
    feedBytes(guard, session, 'thinking_delta', 64);
    feedBytes(guard, session, 'toolcall_delta', 32);
    expect(session.aborted).toBe(0);
    expect(session.emitted).toEqual([]);
  });

  it('counts text, thinking and tool-call deltas together toward one per-run byte cap', () => {
    const guard = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 1024 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    // Three kinds, 400 bytes each: none alone breaches; the aggregate does.
    feedBytes(guard, session, 'text_delta', 400);
    feedBytes(guard, session, 'thinking_delta', 400);
    expect(session.aborted).toBe(0);
    feedBytes(guard, session, 'toolcall_delta', 400);
    expect(session.aborted).toBe(1);
    expect(session.emitted).toHaveLength(1);
    const event = session.emitted[0];
    expect(event.type).toBe(RUN_BUDGET_EXCEEDED_EVENT);
    expect((event.data as Record<string, unknown>).budget).toBe('streamed_bytes');
    expect((event.data as Record<string, unknown>).cap).toBe(1024);
    expect((event.data as Record<string, unknown>).observed).toBeGreaterThan(1024);
    expect(typeof event.timestamp).toBe('number');
  });

  it('counts UTF-8 bytes, not UTF-16 code units (multibyte deltas)', () => {
    const guard = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 10 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    // 'ä' is 1 UTF-16 unit but 2 UTF-8 bytes; 6 of them are 12 bytes > 10.
    guard.observe(session, streamDelta('text_delta', 'ä'.repeat(6)), session.emit);
    expect(session.aborted).toBe(1);
    expect((session.emitted[0].data as Record<string, unknown>).observed).toBe(12);
  });

  it('accumulates across multiple messages within one run', () => {
    const guard = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 1024 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    feedBytes(guard, session, 'text_delta', 600);
    guard.observe(session, messageEnd('assistant', 100), session.emit);
    feedBytes(guard, session, 'text_delta', 600, 600); // second message pushes past the cap
    expect(session.aborted).toBe(1);
    expect(session.emitted).toHaveLength(1);
  });

  it('accumulation spans a queued follow-up consumed within one run (correction 01 pin)', () => {
    // pi-agent-core's loop consumes queued follow-ups/steers INSIDE one run
    // (one agent_start; agent-loop.js getFollowUpMessages → continue), and
    // the guard must accumulate across them: the run boundary is agent_start,
    // never the user message. Characterisation pin (behaviour pre-existing);
    // the measured defaults depend on it.
    const guard = new RunBudgetGuard({ outputTokens: 1000, streamedBytes: 0 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    guard.observe(session, messageEnd('assistant', 600), session.emit);
    // A follow-up arrives (persisted as a user message) and is consumed by
    // the SAME running loop — no agent_start is emitted between the messages.
    guard.observe(session, { type: 'message_start', message: { role: 'user', content: 'go on' } }, session.emit);
    guard.observe(session, messageEnd('assistant', 600), session.emit);
    expect(session.aborted).toBe(1);
    expect(session.emitted).toHaveLength(1);
    expect((session.emitted[0].data as Record<string, unknown>).budget).toBe('output_tokens');
    expect((session.emitted[0].data as Record<string, unknown>).observed).toBe(1200);
    // Control: a real new run (agent_start) resets the counters instead.
    const guardB = new RunBudgetGuard({ outputTokens: 1000, streamedBytes: 0 });
    const sessionB = makeSession();
    guardB.observe(sessionB, agentStart(), sessionB.emit);
    guardB.observe(sessionB, messageEnd('assistant', 600), sessionB.emit);
    guardB.observe(sessionB, agentStart(), sessionB.emit);
    guardB.observe(sessionB, messageEnd('assistant', 600), sessionB.emit);
    expect(sessionB.aborted).toBe(0);
  });
});

// ─── output-token budget ─────────────────────────────────────────────────────

describe('RunBudgetGuard — output tokens', () => {
  it('does not breach under the token cap', () => {
    const guard = new RunBudgetGuard({ outputTokens: 1000, streamedBytes: 0 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    guard.observe(session, messageEnd('assistant', 600), session.emit);
    guard.observe(session, messageEnd('assistant', 399), session.emit);
    expect(session.aborted).toBe(0);
    expect(session.emitted).toEqual([]);
  });

  it('breaches when summed assistant output tokens exceed the cap, and aborts', () => {
    const guard = new RunBudgetGuard({ outputTokens: 1000, streamedBytes: 0 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    guard.observe(session, messageEnd('assistant', 600), session.emit);
    guard.observe(session, messageEnd('assistant', 600), session.emit);
    expect(session.aborted).toBe(1);
    expect(session.emitted).toHaveLength(1);
    const event = session.emitted[0];
    expect(event.type).toBe(RUN_BUDGET_EXCEEDED_EVENT);
    expect((event.data as Record<string, unknown>).budget).toBe('output_tokens');
    expect((event.data as Record<string, unknown>).cap).toBe(1000);
    expect((event.data as Record<string, unknown>).observed).toBe(1200);
  });

  it('ignores user and toolResult message usage (only assistant output counts)', () => {
    const guard = new RunBudgetGuard({ outputTokens: 1000, streamedBytes: 0 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    guard.observe(session, messageEnd('user', 50_000), session.emit);
    guard.observe(session, messageEnd('toolResult', 50_000), session.emit);
    expect(session.aborted).toBe(0);
    guard.observe(session, messageEnd('assistant', 100), session.emit);
    expect(session.aborted).toBe(0);
  });

  it('tolerates missing or malformed usage (providers without token reporting never NaN-trip)', () => {
    const guard = new RunBudgetGuard({ outputTokens: 1000, streamedBytes: 0 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    guard.observe(session, messageEnd('assistant', undefined), session.emit);
    guard.observe(session, { type: 'message_end', message: { role: 'assistant', content: [], usage: { output: 'many' } } }, session.emit);
    guard.observe(session, { type: 'message_end', message: { role: 'assistant', content: [], usage: null } }, session.emit);
    guard.observe(session, { type: 'message_end', message: { role: 'assistant', content: [], usage: { output: Number.NaN } } }, session.emit);
    guard.observe(session, { type: 'message_end', message: { role: 'assistant', content: [], usage: { output: Number.POSITIVE_INFINITY } } }, session.emit);
    guard.observe(session, { type: 'message_end', message: null }, session.emit);
    guard.observe(session, { type: 'message_end' }, session.emit);
    expect(session.aborted).toBe(0);
    expect(session.emitted).toEqual([]);
  });
});

// ─── shared guard behaviour ──────────────────────────────────────────────────

describe('RunBudgetGuard — run lifecycle and abort', () => {
  it('resets all accumulation on agent_start (a new run starts with a fresh budget)', () => {
    const guard = new RunBudgetGuard({ outputTokens: 1000, streamedBytes: 1024 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    feedBytes(guard, session, 'text_delta', 900);
    guard.observe(session, messageEnd('assistant', 900), session.emit);
    // New run: counters reset, the same volume is legal again.
    guard.observe(session, agentStart(), session.emit);
    feedBytes(guard, session, 'text_delta', 900);
    guard.observe(session, messageEnd('assistant', 900), session.emit);
    expect(session.aborted).toBe(0);
    expect(session.emitted).toEqual([]);
  });

  it('breaches at most once per run (no duplicate aborts or events) and re-arms on the next run', () => {
    const guard = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 1024 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    feedBytes(guard, session, 'text_delta', 5000);
    feedBytes(guard, session, 'text_delta', 5000);
    expect(session.aborted).toBe(1);
    expect(session.emitted).toHaveLength(1);
    guard.observe(session, agentStart(), session.emit);
    feedBytes(guard, session, 'text_delta', 5000);
    expect(session.aborted).toBe(2);
  });

  it('a zero cap disables that dimension; 0/0 makes the guard inert', () => {
    const disabled = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 0 });
    const sessionA = makeSession();
    disabled.observe(sessionA, agentStart(), sessionA.emit);
    feedBytes(disabled, sessionA, 'text_delta', 10_000);
    disabled.observe(sessionA, messageEnd('assistant', 10_000_000), sessionA.emit);
    expect(sessionA.aborted).toBe(0);
    expect(sessionA.emitted).toEqual([]);

    const bytesOnly = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 1024 });
    const sessionB = makeSession();
    bytesOnly.observe(sessionB, agentStart(), sessionB.emit);
    feedBytes(bytesOnly, sessionB, 'text_delta', 2000);
    expect(sessionB.aborted).toBe(1);
    expect((sessionB.emitted[0].data as Record<string, unknown>).budget).toBe('streamed_bytes');

    const tokensOnly = new RunBudgetGuard({ outputTokens: 1000, streamedBytes: 0 });
    const sessionC = makeSession();
    tokensOnly.observe(sessionC, agentStart(), sessionC.emit);
    feedBytes(tokensOnly, sessionC, 'text_delta', 10_000);
    tokensOnly.observe(sessionC, messageEnd('assistant', 1001), sessionC.emit);
    expect(sessionC.aborted).toBe(1);
    expect((sessionC.emitted[0].data as Record<string, unknown>).budget).toBe('output_tokens');
  });

  it('emits the synthetic event before calling abort', () => {
    const guard = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 64 });
    const order: string[] = [];
    const session = {
      aborted: 0,
      abort: async () => {
        order.push('abort');
      },
      emitted: [] as Record<string, unknown>[],
      emit: (event: Record<string, unknown>) => {
        order.push(String(event.type));
      },
    };
    guard.observe(session, agentStart(), session.emit);
    feedBytes(guard, session, 'text_delta', 128);
    expect(order).toEqual([RUN_BUDGET_EXCEEDED_EVENT, 'abort']);
  });

  it('never throws on malformed or unknown events', () => {
    const guard = new RunBudgetGuard({ outputTokens: 64, streamedBytes: 256 });
    const session = makeSession();
    const junk: unknown[] = [
      null,
      undefined,
      42,
      'string',
      {},
      { type: 'message_update' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 123 } },
      { type: 'message_update', assistantMessageEvent: null },
      { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'whole message, not a delta' } },
    ];
    for (const event of junk) {
      expect(() => guard.observe(session, event, session.emit)).not.toThrow();
    }
    expect(session.aborted).toBe(0);
  });

  it('does not let an abort rejection escape the observe call', async () => {
    const guard = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 64 });
    const emitted: Record<string, unknown>[] = [];
    const session = {
      aborted: 0,
      abort: () => Promise.reject(new Error('abort failed')),
      emitted,
      emit: (event: Record<string, unknown>) => {
        emitted.push(event);
      },
    };
    guard.observe(session, agentStart(), session.emit);
    expect(() => feedBytes(guard, session, 'text_delta', 128)).not.toThrow();
    expect(emitted).toHaveLength(1);
    // Let any rejected promise surface on the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('retries the abort on later deltas when abort() rejects, bounded, then latches', async () => {
    const guard = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 64 });
    const emitted: Record<string, unknown>[] = [];
    let abortCalls = 0;
    const session = {
      get aborted() {
        return abortCalls;
      },
      abort: () => {
        abortCalls += 1;
        // First two attempts reject (the loop refused to stop); the third succeeds.
        return abortCalls <= 2 ? Promise.reject(new Error('abort failed')) : Promise.resolve();
      },
      emitted,
      emit: (event: Record<string, unknown>) => {
        emitted.push(event);
      },
    };
    guard.observe(session, agentStart(), session.emit);
    feedBytes(guard, session, 'text_delta', 128);
    await new Promise((resolve) => setImmediate(resolve));
    expect(abortCalls).toBe(1);

    // Output keeps arriving because the first abort did not stop the loop:
    // the guard must re-attempt rather than ignoring it forever.
    feedBytes(guard, session, 'text_delta', 64);
    await new Promise((resolve) => setImmediate(resolve));
    expect(abortCalls).toBe(2);

    feedBytes(guard, session, 'text_delta', 64);
    await new Promise((resolve) => setImmediate(resolve));
    expect(abortCalls).toBe(3); // third attempt succeeds

    // After a successful abort the guard stops retrying (one breach per run).
    feedBytes(guard, session, 'text_delta', 64);
    await new Promise((resolve) => setImmediate(resolve));
    expect(abortCalls).toBe(3);
    // The synthetic reason event is emitted only once per run.
    expect(emitted).toHaveLength(1);
  });

  it('never spawns duplicate abort attempts while one abort is merely slow', async () => {
    const guard = new RunBudgetGuard({ outputTokens: 0, streamedBytes: 64 });
    let abortCalls = 0;
    let releaseAbort: () => void = () => undefined;
    const abortInFlight = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const emitted: Record<string, unknown>[] = [];
    const session = {
      aborted: 0,
      abort: () => {
        abortCalls += 1;
        return abortCalls === 1 ? abortInFlight : Promise.resolve();
      },
      emitted,
      emit: (event: Record<string, unknown>) => {
        emitted.push(event);
      },
    };
    guard.observe(session, agentStart(), session.emit);
    feedBytes(guard, session, 'text_delta', 128);
    // A synchronous burst of further breaches while abort #1 is still pending:
    feedBytes(guard, session, 'text_delta', 256);
    feedBytes(guard, session, 'text_delta', 256);
    expect(abortCalls).toBe(1); // no duplicate attempts
    releaseAbort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitted).toHaveLength(1);
  });

  it('exposes the breach as a PiRunBudgetExceededError-friendly payload (budget/cap/observed)', () => {
    const guard = new RunBudgetGuard({ outputTokens: 500, streamedBytes: 0 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    guard.observe(session, messageEnd('assistant', 600), session.emit);
    const data = session.emitted[0].data as Record<string, unknown>;
    expect(() => new PiRunBudgetExceededError(data.budget as 'output_tokens', data.cap as number, data.observed as number)).not.toThrow();
    const error = new PiRunBudgetExceededError('streamed_bytes', 1024, 2048);
    expect(error.name).toBe('PiRunBudgetExceededError');
    expect(error.budget).toBe('streamed_bytes');
    expect(error.cap).toBe(1024);
    expect(error.observed).toBe(2048);
    expect(error.message).toMatch(/streamed/);
  });
});
