/**
 * SOAK-10MIN reconnect seam (plan §15.4 F-1) — the two mount/kernel defects the
 * L5 soak attempt-04 exposed after M2's transcript-finalisation fix:
 *
 *   1. A speech window that SPANS a same-lane restart delivers `activityEnd`
 *      into a provider session that never saw `activityStart` (markers are
 *      silently dropped while the session is still connecting). From then on
 *      the revived session never completes a turn again — it keeps
 *      transcribing, but the model never answers and never calls
 *      `relay_to_worker`, so a post-reconnect relay produces no candidate
 *      (SOAK-10MIN-standard/attempt-04). The host owns the marker pair, so it
 *      must never deliver an unmatched `activityEnd`.
 *   2. A same-generation restart (`registerLane`'s refresh path) kept the
 *      lane's context ledger (`acknowledgedEntries`/`briefSignature`
 *      /`workerActivity`) — so the FRESH provider session was treated as if it
 *      had already seen the conversation and received only deltas (or nothing
 *      at all while nothing changed), instead of the full brief it had never
 *      seen.
 *
 * Hermetic: the mock provider socket and the fake bridge service. No provider
 * call, no socket, no worker. The real end-to-end proof is a fresh
 * SOAK-10MIN run recorded as new campaign attempts.
 */
import { describe, expect, it } from 'vitest';

import { GeminiLiveBridge } from '../../../src/voice/gemini-live-bridge.js';
import type {
  VoiceBridgeEmittedEvent,
  VoiceBridgeLaneState,
  VoiceBridgeService,
  VoiceBridgeStartOptions,
  VoiceWorkerBrief,
} from '../../../src/websocket/voice-live-mount.js';
import {
  VoiceLiveMount,
} from '../../../src/websocket/voice-live-mount.js';
import type { LiveConnectRequest, LiveRealtimeInput, LiveSessionFactory, LiveSessionLike } from '../../../src/voice/types.js';

// ── Bridge-level harness (the same idiom as gemini-live-bridge.test.ts) ─────

class MockLiveSession implements LiveSessionLike {
  readonly sentRealtime: LiveRealtimeInput[] = [];
  readonly sentClientContent: Array<{
    turns: Array<{ role: string; parts: Array<{ text: string }> }>;
    turnComplete: boolean;
  }> = [];
  readonly sentToolResponses: Array<{ functionResponses: Array<Record<string, unknown>> }> = [];
  closed = false;

  sendRealtimeInput(input: LiveRealtimeInput): void {
    this.sentRealtime.push(input);
  }

  sendClientContent(content: {
    turns: Array<{ role: string; parts: Array<{ text: string }> }>;
    turnComplete: boolean;
  }): void {
    this.sentClientContent.push(content);
  }

  sendToolResponse(response: { functionResponses: Array<Record<string, unknown>> }): void {
    this.sentToolResponses.push(response);
  }

  close(): void {
    this.closed = true;
  }
}

function createMockFactory() {
  const sessions: MockLiveSession[] = [];
  const requests: LiveConnectRequest[] = [];
  const factory: LiveSessionFactory = async (request) => {
    requests.push(request);
    const session = new MockLiveSession();
    sessions.push(session);
    return session;
  };
  return {
    factory,
    sessions,
    last: () => sessions[sessions.length - 1],
    request: (index = -1) => requests[index < 0 ? requests.length - 1 : index],
  };
}

function createBridgeCallbacks() {
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const callbacks = {
    onState: (state: string, detail?: string) => events.push({ kind: 'state', payload: { state, detail } }),
    onSetupComplete: () => events.push({ kind: 'setup', payload: {} }),
  };
  return { events, callbacks };
}

async function connectedBridge() {
  const mock = createMockFactory();
  const { callbacks, events } = createBridgeCallbacks();
  const bridge = new GeminiLiveBridge({
    laneId: 'lane-1',
    attachmentGeneration: 1,
    systemInstruction: 'You are a test talker.',
    manualActivityDetection: true,
    callbacks,
    sessionFactory: mock.factory,
  } as never);
  await bridge.connect();
  mock.request().callbacks.onOpen();
  mock.request().callbacks.onMessage({ setupComplete: {} } as never);
  expect(bridge.state).toBe('live');
  return { bridge, mock: { last: mock.last }, events };
}

// ── Bridge: activity-marker hygiene across a restart ────────────────────────

describe('activity markers: an unmatched activityEnd must never reach the provider (soak F-1 seam)', () => {
  it('suppresses an activityEnd that arrives before any delivered activityStart, and counts it', async () => {
    const { bridge, mock } = await connectedBridge();

    bridge.activityEnd();
    expect(mock.last().sentRealtime).toEqual([]);
    expect(bridge.usage.unmatchedActivityEndsSuppressed).toBe(1);

    // A matched pair still flows — the healthy path is untouched.
    bridge.activityStart();
    bridge.activityEnd();
    expect(mock.last().sentRealtime).toEqual([{ activityStart: {} }, { activityEnd: {} }]);
    expect(bridge.usage.unmatchedActivityEndsSuppressed).toBe(1);
    bridge.close();
  });

  it('suppresses the activityEnd whose activityStart was dropped while the session was still connecting', async () => {
    const mock = createMockFactory();
    const { callbacks } = createBridgeCallbacks();
    const bridge = new GeminiLiveBridge({
      laneId: 'lane-1',
      attachmentGeneration: 1,
      systemInstruction: 'You are a test talker.',
      manualActivityDetection: true,
      callbacks,
      sessionFactory: mock.factory,
    } as never);

    // The operator starts speaking while the reminted session is connecting:
    // the marker is dropped (the bridge is not live yet).
    const connectPromise = bridge.connect();
    bridge.activityStart();
    expect(mock.last().sentRealtime).toEqual([]);
    await connectPromise;

    mock.request().callbacks.onOpen();
    mock.request().callbacks.onMessage({ setupComplete: {} } as never);
    expect(bridge.state).toBe('live');

    // The matching end must NOT reach the provider: the provider saw no start,
    // and an unmatched end is what wedges the turn cycle (attempt-04).
    bridge.activityEnd();
    expect(mock.last().sentRealtime).toEqual([]);
    expect(bridge.usage.unmatchedActivityEndsSuppressed).toBe(1);

    // The next spoken window flows as a clean pair.
    bridge.activityStart();
    bridge.activityEnd();
    expect(mock.last().sentRealtime).toEqual([{ activityStart: {} }, { activityEnd: {} }]);
    bridge.close();
  });
});

// ── Mount: the context ledger resets on a same-generation restart ───────────

// Mount harness (the same idiom as voice-corr-server.test.ts).

interface Sent {
  type: string;
  [key: string]: unknown;
}

function ctx(sent: Sent[]) {
  return { clientId: 'c1', send: (message: unknown) => sent.push(message as Sent) };
}

class FakeService implements VoiceBridgeService {
  private readonly listeners = new Set<(event: VoiceBridgeEmittedEvent) => void>();
  readonly states = new Map<string, VoiceBridgeLaneState>();
  readonly starts: VoiceBridgeStartOptions[] = [];
  readonly contexts: Array<{ laneId: string; update: Record<string, unknown> }> = [];
  stopped: Array<{ laneId: string; reason: string }> = [];

  async start(options: VoiceBridgeStartOptions): Promise<void> {
    this.starts.push(options);
    this.states.set(options.laneId, {
      laneId: options.laneId,
      attachmentGeneration: options.attachmentGeneration,
      state: 'live',
      workerActivity: 'idle',
      readingLevel: options.readingLevel,
      captureMode: options.captureMode,
      resumable: false,
      startedAtMs: 1,
      lastEventAtMs: 1,
    });
  }

  async stop(laneId: string, reason: string): Promise<void> {
    this.stopped.push({ laneId, reason });
  }

  getState(laneId: string): VoiceBridgeLaneState | null {
    return this.states.get(laneId) ?? null;
  }

  feedAudio(): void {}

  noteActivity(): void {}

  setReadingLevel(): void {}

  injectContext(laneId: string, update: Record<string, unknown>): void {
    this.contexts.push({ laneId, update });
  }

  async dispose(): Promise<void> {}

  subscribe(listener: (event: VoiceBridgeEmittedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: VoiceBridgeEmittedEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function startLane(mount: VoiceLiveMount, sent: Sent[], laneId: string): Promise<string | null> {
  return mount.route('c1', ctx(sent) as never, {
    type: 'voice_session_start',
    version: 1,
    laneId,
    attachmentGeneration: 1,
    workerSessionId: 'W1',
  } as never);
}

const brief: VoiceWorkerBrief = {
  entries: [{ role: 'user', text: 'deploy the hot fix to staging' }],
  total: 1,
};

async function mountWithBrief() {
  const service = new FakeService();
  const mount = new VoiceLiveMount({
    service,
    delivery: {
      describe: () => 'test delivery',
      deliver: async () => ({ outcome: 'delivered', mechanism: 'prompt' }),
    } as never,
    isWorkerBusy: async () => false,
    workerBrief: async () => brief,
  } as never);
  const sent: Sent[] = [];
  await startLane(mount, sent, 'lane-1');
  return { service, mount, sent };
}

describe('a same-generation restart hands the fresh provider session a clean context ledger', () => {
  it('re-injects the FULL brief after a stop+start on the same lane and generation', async () => {
    const { service, mount, sent } = await mountWithBrief();

    await mount.refreshWorkerStatuses();
    expect(service.contexts).toHaveLength(1);
    // First contact: the whole session (full mode) — the note carries the entry.
    expect(String(service.contexts[0].update.note)).toContain('deploy the hot fix to staging');

    // The capture-mode restart: a real stop, then a fresh start, same lane id,
    // same attachment generation — the exact sequence the soak's reconnect
    // drives through the product's own capture-mode radios.
    await mount.route('c1', ctx(sent) as never, {
      type: 'voice_session_stop',
      version: 1,
      laneId: 'lane-1',
      attachmentGeneration: 1,
      reason: 'operator_stop',
    } as never);
    await startLane(mount, sent, 'lane-1');

    // The fresh provider session has seen nothing: the next refresh must
    // re-inject the FULL brief, not delta — and not nothing.
    await mount.refreshWorkerStatuses();
    expect(service.contexts.length).toBe(2);
    expect(String(service.contexts[1].update.note)).toContain('deploy the hot fix to staging');
  });
});

describe('the remint marker resets the mount context ledger', () => {
  it('re-injects the FULL brief after a provider_unresponsive_remint state event', async () => {
    const { service, mount, sent } = await mountWithBrief();

    await mount.refreshWorkerStatuses();
    expect(service.contexts).toHaveLength(1);

    // The service's internal remint announces itself with a marked state event.
    service.emit({
      kind: 'state',
      laneId: 'lane-1',
      attachmentGeneration: 1,
      state: 'connecting',
      detail: 'provider_unresponsive_remint (fresh provider session)',
    } as never);

    await mount.refreshWorkerStatuses();
    expect(service.contexts.length).toBe(2);
    expect(String(service.contexts[1].update.note)).toContain('deploy the hot fix to staging');
  });
});

describe('the remint retires stale relay-source candidates', () => {
  it('binds a post-remint relay whose identical words were also spoken before the wedge', async () => {
    const { service, mount, sent } = await mountWithBrief();
    const relayText = 'Relay to worker I want to find out about Podpoint.';

    // Before the wedge: the operator's first relay is accepted as a candidate.
    service.emit({
      kind: 'transcript',
      laneId: 'lane-1',
      attachmentGeneration: 1,
      speaker: 'operator',
      source: 'native',
      text: relayText,
      final: true,
      atMs: 1,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The wedge is recovered: the service remints and announces it.
    service.emit({
      kind: 'state',
      laneId: 'lane-1',
      attachmentGeneration: 1,
      state: 'connecting',
      detail: 'provider_unresponsive_remint (fresh provider session)',
    } as never);

    // After the remint the operator repeats the very same relay words (the
    // soak does this by design) and the fresh model relays them.
    service.emit({
      kind: 'transcript',
      laneId: 'lane-1',
      attachmentGeneration: 1,
      speaker: 'operator',
      source: 'native',
      text: relayText,
      final: true,
      atMs: 2,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await mount.handleToolRequest({ laneId: 'lane-1', name: 'relay_to_worker', args: { text: 'I want to find out about Podpoint.' }, atMs: 2 });

    // RED before the fix: the stale pre-wedge candidate makes the binder
    // refuse `ambiguous_source` and no proposal is created.
    expect(sent.some((message) => (message as { type: string }).type === 'proposal_created')).toBe(true);
  });
});

describe('a final that lands mid-speech is deferred to the speech window, not dropped', () => {
  const relayBrief: VoiceWorkerBrief = {
    entries: [{ role: 'user', text: 'deploy the hot fix to staging' }],
    total: 1,
  };

  function mountWithSink() {
    const service = new FakeService();
    const evidenceEvents: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: {
        describe: () => 'test delivery',
        deliver: async () => ({ outcome: 'delivered', mechanism: 'prompt' }),
      } as never,
      isWorkerBusy: async () => false,
      workerBrief: async () => relayBrief,
      evidence: (event) => evidenceEvents.push(event),
    } as never);
    const sent: Sent[] = [];
    return { service, mount, sent, evidenceEvents };
  }

  it('defers a mid-speech final and processes it when the speech window closes (soak F-1, attempt-09)', async () => {
    const { service, mount, sent, evidenceEvents } = mountWithSink();
    await startLane(mount, sent, 'lane-1');

    // The operator starts speaking; the provider finalises the transcript
    // BEFORE the client's speech_end arrives (the VAD tail races the turn
    // boundary — exactly the post-reconnect confirm shape that ate the
    // soak's first release in attempt-09).
    await mount.route('c1', ctx(sent) as never, {
      type: 'voice_activity_state', version: 1, laneId: 'lane-1', attachmentGeneration: 1, state: 'speech_start', atMs: 1,
    } as never);
    service.emit({
      kind: 'transcript', laneId: 'lane-1', attachmentGeneration: 1, speaker: 'operator', source: 'native',
      text: 'Yes, send that.', final: true, atMs: 2,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Deferred: recorded as deferred, not accepted, not echo-dropped.
    const names = () => evidenceEvents.map((e) => String(e.event));
    expect(names()).toContain('operator_utterance_deferred');
    expect(names()).not.toContain('operator_utterance');

    // The window closes — the deferred final is decided with full information.
    await mount.route('c1', ctx(sent) as never, {
      type: 'voice_activity_state', version: 1, laneId: 'lane-1', attachmentGeneration: 1, state: 'speech_end', atMs: 3,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(names()).toContain('operator_utterance'); // it reached the kernel path
    expect(names()).toContain('spoken_confirm_no_proposal'); // honestly answered: nothing was pending
  });

  it('still suppresses a deferred final whose speech overlapped talker audio (echo guarantee intact)', async () => {
    const { service, mount, sent, evidenceEvents } = mountWithSink();
    await startLane(mount, sent, 'lane-1');

    await mount.route('c1', ctx(sent) as never, {
      type: 'voice_activity_state', version: 1, laneId: 'lane-1', attachmentGeneration: 1, state: 'speech_start', atMs: 1,
    } as never);
    // Talker audio is in the room while the operator speaks (the window will
    // show the overlap once it closes).
    (mount as unknown as { lanes: Map<string, { talkerAudioUntilMs: number }> }).lanes
      .get('lane-1')!.talkerAudioUntilMs = Date.now() + 60_000;
    service.emit({
      kind: 'transcript', laneId: 'lane-1', attachmentGeneration: 1, speaker: 'operator', source: 'native',
      text: 'Yes, send that.', final: true, atMs: 2,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const names = () => evidenceEvents.map((e) => String(e.event));
    expect(names()).toContain('operator_utterance_deferred');

    await mount.route('c1', ctx(sent) as never, {
      type: 'voice_activity_state', version: 1, laneId: 'lane-1', attachmentGeneration: 1, state: 'speech_end', atMs: 3,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The window closed OVERLAPPING talker audio: the echo suppression holds.
    expect(names()).toContain('operator_utterance_echo_suspect');
    expect(names()).not.toContain('operator_utterance');
  });
});
