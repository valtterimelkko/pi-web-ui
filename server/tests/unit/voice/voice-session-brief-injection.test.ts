import { describe, expect, it } from 'vitest';
import { VoiceSessionService, VOICE_PENDING_CONTEXT_MAX_CHARS } from '../../../src/voice/voice-session.js';
import type { GeminiLiveBridgeCallbacks, VoiceBridgeEmittedEvent } from '../../../src/voice/types.js';

/**
 * Two seams the full-session brief depends on, both invisible until they broke:
 *   - pending host context must APPEND (a replaced delta would silently drop
 *     messages the host believed it had delivered);
 *   - a tool call may be answered WITH A PAYLOAD, because the retrieval result is
 *     the tool's response — an `{ok:true}` ack would make the model answer blind.
 *
 * The payload travels as the RETURN VALUE of the callback the bridge invokes. The
 * bridge is what turns it into the provider's function response, and that wire
 * step — including the plain `{ok:true}` fallback the gate tools keep — is
 * covered in `gemini-live-bridge.test.ts`. This suite covers the service's half:
 * the kernel's handler is asked, its answer is returned, the observation event is
 * emitted either way, and a failure never fabricates a payload.
 */
class MockBridge {
  static instances: MockBridge[] = [];
  readonly callbacks: GeminiLiveBridgeCallbacks;
  readonly sentContext: string[] = [];

  constructor(options: { callbacks: GeminiLiveBridgeCallbacks }) {
    this.callbacks = options.callbacks;
    MockBridge.instances.push(this);
  }
  async connect(): Promise<void> {}
  sendAudio(): boolean { return true; }
  sendContextText(text: string): boolean { this.sentContext.push(text); return true; }
  activityStart(): void {}
  activityEnd(): void {}
  close(): void {}
}

function harness(overrides: Record<string, unknown> = {}) {
  MockBridge.instances = [];
  let now = 0;
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  const service = new VoiceSessionService({
    bridgeFactory: (options) => new MockBridge(options as never),
    clock: () => now,
    scheduler: (fn) => {
      const timer = { fn, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    ...overrides,
  });
  return {
    service,
    bridge: () => MockBridge.instances.at(-1)!,
    advance: (ms: number) => { now += ms; },
    runTimers: () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); },
  };
}

/** The lane is only 'live' after the provider says so; injections before that are dropped. */
async function liveLane(overrides: Record<string, unknown> = {}) {
  const ctx = harness(overrides);
  await ctx.service.start({
    laneId: 'lane-1',
    attachmentGeneration: 1,
    workerSessionId: 'worker-1',
    runtime: 'pi',
    captureMode: 'open-mic',
    readingLevel: 'verbatim',
    callbacks: {},
  } as never);
  ctx.bridge().callbacks.onState?.('live');
  return ctx;
}

const update = (laneId: string, note: string) => ({
  laneId,
  workerActivity: 'idle' as const,
  statusLine: 'CURRENT STATUS: IDLE',
  note,
  atMs: 0,
});

describe('host context injection', () => {
  it('appends a second block instead of replacing the first', async () => {
    const ctx = await liveLane({ contextCoalesceMs: 1 });
    // The first block must NOT be delivered yet, so the second is a real merge.
    ctx.service.injectContext('lane-1', update('lane-1', 'FIRST BLOCK') as never);
    ctx.service.injectContext('lane-1', update('lane-1', 'SECOND BLOCK') as never);
    ctx.advance(10);
    ctx.runTimers();

    const sent = ctx.bridge().sentContext.join('\n---\n');
    expect(sent).toContain('FIRST BLOCK');
    expect(sent).toContain('SECOND BLOCK');
  });

  it('keeps the pending text bounded, saying what it dropped', async () => {
    const ctx = await liveLane({ contextCoalesceMs: 1_000 });
    // The lane's opening block goes out at once — the model gets its snapshot as
    // soon as it is live. The bound is about what ACCUMULATES afterwards, which is
    // where a delta could otherwise grow a live context without limit.
    ctx.service.injectContext('lane-1', update('lane-1', 'the opening block') as never);
    ctx.advance(100);
    ctx.service.injectContext('lane-1', update('lane-1', 'z'.repeat(VOICE_PENDING_CONTEXT_MAX_CHARS)) as never);
    ctx.service.injectContext('lane-1', update('lane-1', 'the newest words') as never);
    ctx.advance(1_000);
    ctx.runTimers();

    const [opening] = ctx.bridge().sentContext;
    const sent = ctx.bridge().sentContext.at(-1)!;
    expect(opening).toContain('the opening block');
    expect(sent).toContain('earlier host context omitted');
    expect(sent).toContain('the newest words');
    expect(sent.length).toBeLessThanOrEqual(VOICE_PENDING_CONTEXT_MAX_CHARS + 500);
  });
});

describe('tool calls the kernel answers', () => {
  it('returns the handler payload so the bridge can send it as the tool response', async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ctx = await liveLane({
      toolRequestHandler: (input: { name: string; args: Record<string, unknown> }) => {
        seen.push({ name: input.name, args: input.args });
        return input.name === 'read_worker_history' ? { history: 'the earlier conversation' } : undefined;
      },
    });
    const events: VoiceBridgeEmittedEvent[] = [];
    ctx.service.subscribe((event) => events.push(event));

    const response = await ctx.bridge().callbacks.onToolCall?.({
      name: 'read_worker_history',
      args: { query: 'retry' },
      id: 'c1',
      atMs: 1,
    } as never);

    expect(response).toEqual({ history: 'the earlier conversation' });
    // The argument reaches the handler intact — the args are the tool's input.
    expect(seen).toEqual([{ name: 'read_worker_history', args: { query: 'retry' } }]);
    // Observation is unconditional: the call is on the record whatever the answer.
    expect(events.filter((event) => event.kind === 'tool_call')).toHaveLength(1);
  });

  it('keeps the plain acknowledgement when the handler answers nothing', async () => {
    const ctx = await liveLane({ toolRequestHandler: () => undefined });

    const response = await ctx.bridge().callbacks.onToolCall?.({
      name: 'read_worker_history',
      args: { query: 'x' },
      id: 'c2',
      atMs: 1,
    } as never);

    // No payload: the bridge's own `{ok:true}` fallback is what the model sees.
    expect(response).toBeUndefined();
  });

  it('never fabricates a payload when the handler throws', async () => {
    const ctx = await liveLane({
      toolRequestHandler: () => {
        throw new Error('the session store is unavailable');
      },
    });

    const response = await ctx.bridge().callbacks.onToolCall?.({
      name: 'read_worker_history',
      args: { query: 'x' },
      id: 'c3',
      atMs: 1,
    } as never);

    expect(response).toBeUndefined();
  });

  it('keeps the acknowledgement when the handler is absent entirely', async () => {
    const ctx = await liveLane();

    const response = await ctx.bridge().callbacks.onToolCall?.({
      name: 'read_worker_history',
      args: { query: 'x' },
      id: 'c4',
      atMs: 1,
    } as never);

    expect(response).toBeUndefined();
  });
});
