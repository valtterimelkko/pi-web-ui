/**
 * B3a — pi-web-ui-side streaming tool-argument budget.
 *
 * The 2026-09-12 stall class: a runaway generation streaming tool-call
 * arguments makes upstream pi-ai re-parse the accumulated buffer per delta
 * (quadratic, synchronous). The patch that used to bound this is removed with
 * this lane; pi-web-ui now enforces a per-tool-call and per-run cap from its
 * own side of the single `session.subscribe` funnel in PiService, aborting the
 * turn via the public `AgentSession.abort()` and emitting a synthetic
 * `tool_args_budget_exceeded` event that carries the breach into the run
 * receipt (`RUN_BUDGET_EXCEEDED`).
 *
 * These tests pin the guard behaviour (breach detection per cap, reset per
 * run, disable path, emit-before-abort ordering, malformed-event tolerance)
 * and the PiService wiring (every session event passes through the guard;
 * synthetic events dispatch through the registered handler).
 */
import { describe, expect, it } from 'vitest';

import {
  PiToolArgsBudgetExceededError,
  TOOL_ARGS_BUDGET_EXCEEDED_EVENT,
  ToolArgsBudgetGuard,
} from '../../../src/pi/tool-args-budget.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

const agentStart = (): Record<string, unknown> => ({ type: 'agent_start' });

const toolcallDelta = (contentIndex: number, delta: string): Record<string, unknown> => ({
  type: 'message_update',
  message: { role: 'assistant', id: 'm1' },
  assistantMessageEvent: { type: 'toolcall_delta', contentIndex, delta, partial: {} },
});

const toolcallEnd = (contentIndex: number): Record<string, unknown> => ({
  type: 'message_update',
  message: { role: 'assistant', id: 'm1' },
  assistantMessageEvent: { type: 'toolcall_end', contentIndex, toolCall: { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }, partial: {} },
});

const textDelta = (delta: string): Record<string, unknown> => ({
  type: 'message_update',
  message: { role: 'assistant', id: 'm1' },
  assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: {} },
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

/** Feed an accumulated character count as fine toolcall deltas. */
function feedDeltas(guard: ToolArgsBudgetGuard, session: Harness, contentIndex: number, chars: number, chunk = 4): void {
  let remaining = chars;
  while (remaining > 0) {
    const size = Math.min(chunk, remaining);
    guard.observe(session, toolcallDelta(contentIndex, 'x'.repeat(size)), session.emit);
    remaining -= size;
  }
}

// ─── guard behaviour ─────────────────────────────────────────────────────────

describe('ToolArgsBudgetGuard', () => {
  it('does not breach a stream under both caps (no emit, no abort)', () => {
    const guard = new ToolArgsBudgetGuard({ callChars: 1024, turnChars: 4096 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    feedDeltas(guard, session, 0, 1000);
    expect(session.aborted).toBe(0);
    expect(session.emitted).toEqual([]);
  });

  it('breaches the per-call cap, emits the synthetic event, and aborts', () => {
    const guard = new ToolArgsBudgetGuard({ callChars: 1024, turnChars: 8192 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    feedDeltas(guard, session, 0, 1025);

    expect(session.aborted).toBe(1);
    expect(session.emitted).toHaveLength(1);
    const event = session.emitted[0];
    expect(event.type).toBe(TOOL_ARGS_BUDGET_EXCEEDED_EVENT);
    expect((event.data as Record<string, unknown>).scope).toBe('call');
    expect((event.data as Record<string, unknown>).capChars).toBe(1024);
    expect((event.data as Record<string, unknown>).observedChars).toBeGreaterThan(1024);
    expect(typeof event.timestamp).toBe('number');
  });

  it('breaches the per-run (turn) aggregate cap across several calls', () => {
    const guard = new ToolArgsBudgetGuard({ callChars: 1024, turnChars: 2048 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    // Two calls of 900 chars each: each under the call cap, aggregate over the turn cap.
    feedDeltas(guard, session, 0, 900);
    guard.observe(session, toolcallEnd(0), session.emit);
    feedDeltas(guard, session, 1, 900);
    expect(session.aborted).toBe(0);
    feedDeltas(guard, session, 2, 900);

    expect(session.aborted).toBe(1);
    expect(session.emitted).toHaveLength(1);
    expect((session.emitted[0].data as Record<string, unknown>).scope).toBe('turn');
  });

  it('resets per-call accumulation at toolcall_end so sequential big-but-legal calls pass', () => {
    const guard = new ToolArgsBudgetGuard({ callChars: 1024, turnChars: 8192 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    for (const index of [0, 1, 2]) {
      feedDeltas(guard, session, index, 1000);
      guard.observe(session, toolcallEnd(index), session.emit);
    }
    expect(session.aborted).toBe(0);
    expect(session.emitted).toEqual([]);
  });

  it('resets all accumulation on agent_start (a new run starts with a fresh budget)', () => {
    const guard = new ToolArgsBudgetGuard({ callChars: 1024, turnChars: 8192 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    feedDeltas(guard, session, 0, 1000);
    // New run: counters reset, the same volume is legal again.
    guard.observe(session, agentStart(), session.emit);
    feedDeltas(guard, session, 0, 1000);
    expect(session.aborted).toBe(0);
    expect(session.emitted).toEqual([]);
  });

  it('breaches at most once per run (no duplicate aborts or events)', () => {
    const guard = new ToolArgsBudgetGuard({ callChars: 1024, turnChars: 8192 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    feedDeltas(guard, session, 0, 5000);
    feedDeltas(guard, session, 1, 5000);
    expect(session.aborted).toBe(1);
    expect(session.emitted).toHaveLength(1);
    // A new run re-arms the guard.
    guard.observe(session, agentStart(), session.emit);
    feedDeltas(guard, session, 0, 5000);
    expect(session.aborted).toBe(2);
  });

  it('text/thinking deltas never count toward the tool-argument budget', () => {
    const guard = new ToolArgsBudgetGuard({ callChars: 1024, turnChars: 8192 });
    const session = makeSession();
    guard.observe(session, agentStart(), session.emit);
    for (let i = 0; i < 100; i++) guard.observe(session, textDelta('y'.repeat(200)), session.emit);
    expect(session.aborted).toBe(0);
    expect(session.emitted).toEqual([]);
  });

  it('a zero cap disables that dimension; 0/0 makes the guard inert', () => {
    const disabled = new ToolArgsBudgetGuard({ callChars: 0, turnChars: 0 });
    const sessionA = makeSession();
    disabled.observe(sessionA, agentStart(), sessionA.emit);
    feedDeltas(disabled, sessionA, 0, 10_000);
    expect(sessionA.aborted).toBe(0);
    expect(sessionA.emitted).toEqual([]);

    const turnOnly = new ToolArgsBudgetGuard({ callChars: 0, turnChars: 1024 });
    const sessionB = makeSession();
    turnOnly.observe(sessionB, agentStart(), sessionB.emit);
    feedDeltas(turnOnly, sessionB, 0, 2000);
    expect(sessionB.aborted).toBe(1);
    expect((sessionB.emitted[0].data as Record<string, unknown>).scope).toBe('turn');
  });

  it('emits the synthetic event before calling abort', () => {
    const guard = new ToolArgsBudgetGuard({ callChars: 64, turnChars: 8192 });
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
    feedDeltas(guard, session, 0, 128);
    expect(order).toEqual([TOOL_ARGS_BUDGET_EXCEEDED_EVENT, 'abort']);
  });

  it('never throws on malformed or unknown events', () => {
    const guard = new ToolArgsBudgetGuard({ callChars: 64, turnChars: 256 });
    const session = makeSession();
    const junk: unknown[] = [
      null,
      undefined,
      42,
      'string',
      {},
      { type: 'message_update' },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta' } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 123 } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 'x', delta: 'yyy' } },
    ];
    for (const event of junk) {
      expect(() => guard.observe(session, event, session.emit)).not.toThrow();
    }
    expect(session.aborted).toBe(0);
  });

  it('does not let an abort rejection escape the observe call', async () => {
    const guard = new ToolArgsBudgetGuard({ callChars: 64, turnChars: 8192 });
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
    expect(() => feedDeltas(guard, session, 0, 128)).not.toThrow();
    expect(emitted).toHaveLength(1);
    // Let any rejected promise surface on the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('PiToolArgsBudgetExceededError', () => {
  it('carries scope, cap and observed chars in a parent-readable message', () => {
    const error = new PiToolArgsBudgetExceededError('call', 65536, 65600);
    expect(error.name).toBe('PiToolArgsBudgetExceededError');
    expect(error.scope).toBe('call');
    expect(error.capChars).toBe(65536);
    expect(error.observedChars).toBe(65600);
    expect(error.message).toMatch(/65,?536/);
    expect(error.message).toMatch(/tool argument/i);
  });
});
