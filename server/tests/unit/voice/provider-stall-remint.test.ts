/**
 * SOAK-10MIN F-1 seam, part 2 — the unresponsive-provider remint.
 *
 * Two soak attempts (SOAK-10MIN-standard/attempt-04 and attempt-05) prove the
 * remaining wedge: after the mid-session reconnect the revived session's
 * presentation read-back is barge-in interrupted (`serverContent.interrupted`),
 * and from that moment the provider never produces model output again — input
 * transcription continues, activity markers are matched, context is injected,
 * yet no reply, no read-back, no `relay_to_worker` call ever arrives. The host
 * cannot un-wedge the provider session; the proven recovery is a FRESH session
 * (every reminted session responded immediately in the records).
 *
 * So the service watches for a stalled model: the MOUNT — which owns
 * classification — arms the watch for each accepted statement/question
 * (confirm/cancel are mechanical and never arm it) via the concrete service's
 * `noteOperatorUtteranceForStallWatch`; the watch fires on NO model engagement (no talker transcript, no model
 * audio, no tool call, no turn boundary) for `VOICE_MODEL_REPLY_STALL_MS`.
 * On a stall it remints the provider session ONCE per wedge, marks the state
 * event (`provider_unresponsive_remint`) so the mount resets its context
 * ledger for the fresh session, and replays the unanswered utterances as user
 * turns that elicit replies. A wedge that survives the remint is surfaced once
 * and NOT reminted in a loop.
 *
 * Hermetic: MockBridge + injected clock/scheduler; no provider call.
 */
import { describe, expect, it } from 'vitest';

import { VoiceSessionService } from '../../../src/voice/voice-session.js';
import { VOICE_MODEL_REPLY_STALL_MS } from '../../../src/voice/voice-session.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import type { VoiceBridgeEmittedEvent, VoiceBridgeStartOptions } from '../../../src/voice/contract.js';
import type { GeminiLiveBridgeCallbacks, VoiceBridgeLike, VoiceClock } from '../../../src/voice/types.js';

class MockBridge implements VoiceBridgeLike {
  static instances: MockBridge[] = [];
  readonly options: Record<string, unknown>;
  callbacks: GeminiLiveBridgeCallbacks;
  sentContext: string[] = [];
  replays: string[] = [];
  closed = false;
  connectCalls = 0;
  resumptionHandle: string | null = null;

  constructor(options: { callbacks: GeminiLiveBridgeCallbacks } & Record<string, unknown>) {
    this.callbacks = options.callbacks;
    this.options = options;
    MockBridge.instances.push(this);
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  sendAudio(): boolean {
    return true;
  }

  sendContextText(text: string): boolean {
    this.sentContext.push(text);
    return true;
  }

  replayUserTurn(text: string): boolean {
    this.replays.push(text);
    return true;
  }

  activityStart(): void {}

  activityEnd(): void {}

  close(): void {
    this.closed = true;
  }
}

function createHarness(overrides: Record<string, unknown> = {}) {
  MockBridge.instances = [];
  let now = 0;
  const timers: Array<{ fn: () => void; delayMs: number; cancelled: boolean }> = [];
  const clock: VoiceClock = () => now;
  const logWarnings: string[] = [];
  const service = new VoiceSessionService({
    bridgeFactory: (options) => new MockBridge(options as never),
    clock,
    scheduler: (fn, delayMs) => {
      const timer = { fn, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => logWarnings.push(message),
      error: () => {},
    },
    metrics: new OperationalMetrics(),
    ...overrides,
  });
  const events: VoiceBridgeEmittedEvent[] = [];
  service.subscribe((event) => events.push(event));
  return {
    service,
    bridges: MockBridge.instances,
    timers,
    logWarnings,
    events,
    advance: (ms: number) => {
      now += ms;
    },
    runTimers: async () => {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
      // the stall check is async (close + reopen): let its continuations run
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function startOptions(laneId = 'lane-1:probe'): VoiceBridgeStartOptions {
  return {
    laneId,
    attachmentGeneration: 3,
    workerSessionId: 'session-abc',
    runtime: 'pi',
    captureMode: 'open-mic',
    readingLevel: 'verbatim',
    callbacks: {},
  };
}

async function startLive(h: ReturnType<typeof createHarness>) {
  h.advance(1_000);
  await h.service.start(startOptions());
  h.bridges[0].callbacks.onState?.('live');
}

/** The operator speaks one utterance (start → provider transcribes → end). */
async function operatorSays(h: ReturnType<typeof createHarness>, text: string) {
  const live = h.bridges[h.bridges.length - 1];
  await h.service.noteActivity({ laneId: 'lane-1:probe', attachmentGeneration: 3, state: 'speech_start', atMs: 0 });
  live.callbacks.onInputTranscription?.(text, 0);
  await h.service.noteActivity({ laneId: 'lane-1:probe', attachmentGeneration: 3, state: 'speech_end', atMs: 0 });
}

describe('provider-stall remint (soak F-1 seam)', () => {
  it(`remints once after ${VOICE_MODEL_REPLY_STALL_MS} ms with an unanswered statement and replays it to the fresh session`, async () => {
    const h = createHarness();
    await startLive(h);

    await operatorSays(h, 'Relay to worker I want to find out about Podpoint.');
    // The mount (which classifies) arms the watch for this statement.
    h.service.noteOperatorUtteranceForStallWatch('lane-1:probe', 'Relay to worker I want to find out about Podpoint.', 1_000);
    // No model output at all — the wedge. Advance past the stall and fire the check.
    h.advance(VOICE_MODEL_REPLY_STALL_MS + 1);
    await h.runTimers();

    expect(h.bridges.length).toBe(2); // a fresh provider session was minted
    expect(h.bridges[0].closed).toBe(true); // the wedged session was closed
    // The fresh session has not gone live yet, so the context replay is pending…
    expect(h.bridges[1].sentContext).toEqual([]);
    h.bridges[1].callbacks.onState?.('live');
    // …and flushes to the session that can act on it — as CONTEXT
    // (turnComplete false: no reply elicited, no audio over the operator).
    expect(h.bridges[1].sentContext).toEqual([
      'RECONNECT CONTEXT: while the voice connection was down, the operator said: Relay to worker I want to find out about Podpoint.',
    ]);
    // The mount learns to reset its context ledger from the marked state event.
    expect(
      h.events.some(
        (e) => e.kind === 'state' && String((e as { detail?: string }).detail ?? '').includes('provider_unresponsive_remint')
      )
    ).toBe(true);
  });

  it('does not remint a healthy session that keeps engaging the model', async () => {
    const h = createHarness();
    await startLive(h);

    await operatorSays(h, 'I think our real problem is that the deploy takes nearly 10 minutes.');
    h.service.noteOperatorUtteranceForStallWatch('lane-1:probe', 'I think our real problem is that the deploy takes nearly 10 minutes.', 1_000);
    // The model answers (talker output).
    h.bridges[0].callbacks.onOutputTranscription?.('Right — the deploy is the slow part.', 0);
    h.advance(VOICE_MODEL_REPLY_STALL_MS + 5_000);
    await h.runTimers();

    expect(h.bridges.length).toBe(1);
    expect(h.bridges[0].closed).toBe(false);
  });

  it('remints at most once per wedge — a persistent wedge is logged, not looped', async () => {
    const h = createHarness();
    await startLive(h);

    await operatorSays(h, 'Relay to worker I want to find out about Podpoint.');
    h.service.noteOperatorUtteranceForStallWatch('lane-1:probe', 'Relay to worker I want to find out about Podpoint.', 1_000);
    h.advance(VOICE_MODEL_REPLY_STALL_MS + 1);
    await h.runTimers();
    expect(h.bridges.length).toBe(2);

    // The fresh session goes live but wedges too; another statement stalls.
    h.bridges[1].callbacks.onState?.('live');
    await operatorSays(h, 'Relay to worker, please: I want to find out about Podpoint.');
    h.service.noteOperatorUtteranceForStallWatch('lane-1:probe', 'Relay to worker, please: I want to find out about Podpoint.', 1_000);
    h.advance(VOICE_MODEL_REPLY_STALL_MS + 1);
    await h.runTimers();

    expect(h.bridges.length).toBe(2); // no second remint
    expect(h.logWarnings.some((line) => line.includes('provider_unresponsive'))).toBe(true);
  });
});
