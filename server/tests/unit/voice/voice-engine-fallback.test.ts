/**
 * Phase 8 dual-engine fallback proof (Gate 8, plan anti-early-claim guard).
 *
 * The plan demands: "kill the Live bridge connection mid-session and verify
 * that the UI seamlessly degrades to push-to-talk cascade with an audible
 * announcement." This suite proves the SERVER half, hermetically (no network):
 * it drives the REAL `VoiceSessionService` and the REAL `GeminiLiveBridge` over
 * a mock provider socket, and kills that connection mid-session exactly as an
 * unrecoverable drop does. It asserts
 *
 *   (a) the fallback engages (lane engine flips to cascade, metrics + evidence);
 *   (b) active drafts and parked items survive the kill and remain actionable;
 *   (c) the announcement frames reach the wire (the client's rendered surface);
 *   (d) the Gemma cascade (the talker session registry) is the path now serving
 *       the lane — including the one-time spoken announcement.
 *
 * The audible half of the plan's guard is the frozen client's (it renders and
 * speaks `voice_state`/`voice_error`); the server's proof is the announcement
 * frame plus the cascade reply the client reads out.
 *
 * It also proves the reversible flag: with `VOICE_MODE_ENGINE=cascade`, a
 * `voice_session_start` never constructs a bridge factory or opens a provider
 * lane; the client is told honestly to use the cascade.
 */

import { describe, expect, it } from 'vitest';

import type {
  VoiceActivityNote,
  VoiceAudioInputChunk,
  VoiceBridgeContextUpdate,
  VoiceBridgeEmittedEvent,
  VoiceBridgeLaneState,
  VoiceBridgeService,
  VoiceBridgeStartOptions,
  VoiceReadingLevel,
  VoiceStopReason,
} from '../../../src/voice/contract.js';
import type { DeliveryOutcome, WorkerDelivery } from '../../../src/talker/types.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { VoiceLiveMount, type VoiceCascadeSink } from '../../../src/websocket/voice-live-mount.js';
import { VoiceSessionService } from '../../../src/voice/voice-session.js';
import { GeminiLiveBridge } from '../../../src/voice/gemini-live-bridge.js';
import type {
  LiveConnectRequest,
  LiveRealtimeInput,
  LiveSessionLike,
} from '../../../src/voice/types.js';
import {
  TALKER_LIVE_ENGINE_FALLBACK_ANNOUNCEMENT,
  TalkerSessionRegistry,
} from '../../../src/talker/session-registry.js';
import { createNullDelivery, type DefaultDeliveries } from '../../../src/talker/delivery.js';
import type { ModelTurnResult, TalkerModelClient } from '../../../src/talker/types.js';

const LANE = 'lane-1';
const GENERATION = 1;
const WORKER = 'worker-1';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeService implements VoiceBridgeService {
  private readonly listeners = new Set<(event: VoiceBridgeEmittedEvent) => void>();
  readonly states = new Map<string, VoiceBridgeLaneState>();
  readonly starts: VoiceBridgeStartOptions[] = [];

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
    this.emit({ kind: 'state', laneId: options.laneId, attachmentGeneration: options.attachmentGeneration, state: 'live' });
  }

  async stop(_laneId: string, _reason: VoiceStopReason): Promise<void> {}

  feedAudio(_chunk: VoiceAudioInputChunk & { laneId: string; attachmentGeneration: number }): void {}

  noteActivity(_note: VoiceActivityNote): void {}

  injectContext(_laneId: string, _update: VoiceBridgeContextUpdate): void {}

  setReadingLevel(_laneId: string, _level: VoiceReadingLevel): void {}

  getState(laneId: string): VoiceBridgeLaneState | null {
    return this.states.get(laneId) ?? null;
  }

  subscribe(listener: (event: VoiceBridgeEmittedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
  }

  emit(event: VoiceBridgeEmittedEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

interface Sent {
  type: string;
  [key: string]: unknown;
}

function makeDelivery(outcome: DeliveryOutcome = { outcome: 'delivered', mechanism: 'prompt' }): WorkerDelivery & {
  calls: Array<{ workerSessionId: string; text: string }>;
} {
  const calls: Array<{ workerSessionId: string; text: string }> = [];
  return {
    calls,
    describe: () => 'test delivery',
    async deliver({ workerSessionId, text }) {
      calls.push({ workerSessionId, text });
      return outcome;
    },
  };
}

function stubModel(reply = 'Understood.'): TalkerModelClient {
  return {
    async completeTurn(): Promise<ModelTurnResult> {
      return { text: reply, ttftMs: 5, totalMs: 10 };
    },
  };
}

function nullDeliveries(): DefaultDeliveries {
  return { pi: createNullDelivery(), claude: createNullDelivery(), antigravity: createNullDelivery() };
}

function makeRegistry(): TalkerSessionRegistry {
  const manager = {
    getSessionStatus: () => undefined,
    getAgentSession: () => undefined,
    resolveSessionRef: (ref: string) => ref,
  };
  return new TalkerSessionRegistry({
    multiSessionManager: manager as never,
    deliveries: nullDeliveries(),
    modelClient: stubModel(),
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ── A real bridge over a mock provider socket ────────────────────────────────
//
// The fallback proof must genuinely KILL a live connection, so it drives the
// real VoiceSessionService and the real GeminiLiveBridge; only the provider
// socket is a mock. `closeProviderSocket()` is the kill.

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

function createRealServiceHarness(metrics: OperationalMetrics): {
  service: VoiceSessionService;
  requests: LiveConnectRequest[];
  sessions: MockLiveSession[];
  open(): void;
  speakOperator(text: string): void;
  closeProviderSocket(): void;
} {
  const requests: LiveConnectRequest[] = [];
  const sessions: MockLiveSession[] = [];
  const service = new VoiceSessionService({
    metrics,
    clock: () => 1,
    scheduler: () => () => undefined,
    bridgeFactory: (options) =>
      new GeminiLiveBridge({
        ...options,
        sessionFactory: async (request) => {
          requests.push(request);
          const session = new MockLiveSession();
          sessions.push(session);
          return session;
        },
      }),
  });
  return {
    service,
    requests,
    sessions,
    open: () => requests[0].callbacks.onMessage({ setupComplete: {} }),
    speakOperator: (text: string) =>
      requests[0].callbacks.onMessage({
        serverContent: { inputTranscription: { text }, turnComplete: true },
      }),
    // The kill: the provider socket closes with no resumption handle, exactly
    // as a real unrecoverable drop does.
    closeProviderSocket: () => requests[0].callbacks.onClose(),
  };
}

async function startLane(mount: VoiceLiveMount, sent: Sent[]): Promise<void> {
  const code = await mount.route(
    'client-1',
    { send: (message) => sent.push(message as unknown as Sent) },
    {
      type: 'voice_session_start',
      version: 1,
      laneId: LANE,
      attachmentGeneration: GENERATION,
      workerSessionId: WORKER,
    } as never
  );
  expect(code).toBeNull();
}

/** The model-driven relay: the native talker calls `relay_to_worker`. */
async function relay(mount: VoiceLiveMount, text: string): Promise<void> {
  await mount.handleToolRequest({ laneId: LANE, name: 'relay_to_worker', args: { text }, atMs: 1 });
}

// ── (a)-(d) the fallback proof ──────────────────────────────────────────────

describe('Phase 8 fallback: kill the live connection mid-session', () => {
  it('degrades to the cascade with drafts + parked items intact and the announcement on the wire', async () => {
    const metrics = new OperationalMetrics();
    const harness = createRealServiceHarness(metrics);
    const delivery = makeDelivery();
    const registry = makeRegistry();
    const evidence: Array<Record<string, unknown>> = [];
    let busy = false;
    const mount = new VoiceLiveMount({
      service: harness.service,
      delivery,
      isWorkerBusy: async () => busy,
      metrics,
      evidence: (event) => evidence.push(event),
      cascade: { noteEngineFallback: (input) => registry.noteEngineFallback(input) },
    });
    const sent: Sent[] = [];
    const send = (message: unknown): void => {
      sent.push(message as Sent);
    };

    await startLane(mount, sent);
    expect(harness.requests).toHaveLength(1);
    expect(mount.getLaneEngine(LANE)).toBe('gemini-live');
    harness.open();
    expect(harness.service.getState(LANE)?.state).toBe('live');

    // One active draft...
    await relay(mount, 'check the tests.');
    const draft = (sent.find((frame) => frame.type === 'proposal_created') as Sent).proposal as {
      proposalId: string;
      version: number;
      sha256: string;
      tidied: string;
    };
    expect(draft).toBeDefined();

    // ...and one parked item (flagged while the worker was busy).
    busy = true;
    await relay(mount, 'update the changelog.');
    busy = false;
    const parkingFrames = sent.filter((frame) => frame.type === 'parking_updated');
    const parkedId = (parkingFrames.at(-1)?.items as Array<{ itemId: string }>)[0].itemId;
    expect(parkedId).toBeDefined();

    // Kill the live connection: the provider socket closes with no resumption
    // handle, so the real bridge gives up fatally.
    harness.closeProviderSocket();
    await flush();
    expect(harness.service.getState(LANE)?.state).toBe('error');
    // The kill was observed as a live-connection drop (no resumption handle, so
    // no attempt was made).
    expect(metrics.snapshot().voice?.live).toMatchObject({ connectionDrops: 1, resumptionAttempts: 0 });

    // (a) The fallback engaged: engine flipped, metric and evidence recorded,
    //     and the cascade sink was notified for this lane/worker.
    expect(mount.getLaneEngine(LANE)).toBe('cascade');
    expect(mount.getLaneFallbackReason(LANE)).toContain('voice_provider_unavailable');
    expect(metrics.snapshot().voice?.live.engineFallbacks).toBe(1);
    expect(evidence).toContainEqual(expect.objectContaining({ event: 'engine_fallback', laneId: LANE }));
    expect(registry.getEngineFallback(WORKER)).toMatchObject({ laneId: LANE, announced: false });

    // (c) The announcement reached the wire: the state frame names the cascade
    //     and the fatal error frame is on the wire unchanged.
    const stateFrame = sent.find(
      (frame) => frame.type === 'voice_state' && String(frame.detail).includes('cascade')
    );
    expect(stateFrame).toBeDefined();
    expect(sent.some((frame) => frame.type === 'voice_error' && frame.fatal === true)).toBe(true);

    // (b) The active draft survives: confirming it still releases its exact bytes.
    //     H3: the read-back presentation state survives the engine fallback too
    //     (the kernel owns it; the fallback only changes the serving engine).
    const presented = await mount.route(
      'client-1',
      { send },
      {
        type: 'proposal_presentation',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: draft.proposalId,
        presentedVariant: 'tidied',
        completed: true,
      } as never
    );
    expect(presented).toBeNull();
    const confirmCode = await mount.route(
      'client-1',
      { send },
      {
        type: 'proposal_confirm',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: draft.proposalId,
        variant: 'tidied',
        idempotencyKey: 'idem-after-fallback',
        proposalRef: { version: draft.version, sha256: draft.sha256 },
      } as never
    );
    expect(confirmCode).toBeNull();
    expect(delivery.calls).toEqual([{ workerSessionId: WORKER, text: draft.tidied }]);

    // (b) And the parked item is still listed, unpromoted.
    const listCode = await mount.route(
      'client-1',
      { send },
      { type: 'parking_list', version: 1, laneId: LANE, attachmentGeneration: GENERATION } as never
    );
    expect(listCode).toBeNull();
    const listed = sent.filter((frame) => frame.type === 'parking_updated').at(-1) as Sent;
    expect((listed.items as Array<{ itemId: string }>).map((item) => item.itemId)).toEqual([parkedId]);

    // (d) The cascade is the path now serving the lane: the registry takes the
    //     operator's next turn and speaks the one-time announcement first.
    const turn = await registry.handleOperatorTurn({ workerSessionId: WORKER, utterance: 'What happened to the live engine?' });
    expect(turn.refused).toBeUndefined();
    expect(turn.reply.startsWith(TALKER_LIVE_ENGINE_FALLBACK_ANNOUNCEMENT)).toBe(true);
    expect(turn.reply).toContain('Understood.');
  });

  it('treats quota exhaustion as a fallback trigger with the quota reason recorded', async () => {
    const metrics = new OperationalMetrics();
    const harness = createRealServiceHarness(metrics);
    const registry = makeRegistry();
    const mount = new VoiceLiveMount({
      service: harness.service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      metrics,
      cascade: { noteEngineFallback: (input) => registry.noteEngineFallback(input) },
    });
    const sent: Sent[] = [];
    await startLane(mount, sent);
    harness.open();

    // The provider reports quota exhaustion on the socket, then the connection
    // dies — the fatal give-up must carry the quota classification.
    harness.requests[0].callbacks.onError(new Error('429 RESOURCE_EXHAUSTED: quota exceeded'));
    harness.closeProviderSocket();
    await flush();

    expect(mount.getLaneEngine(LANE)).toBe('cascade');
    expect(metrics.snapshot().voice?.live).toMatchObject({ engineFallbacks: 1 });
    expect(registry.getEngineFallback(WORKER)?.reason).toContain('voice_quota_exhausted');
    expect(sent.some((frame) => frame.type === 'voice_error' && frame.code === 'voice_quota_exhausted')).toBe(true);
  });

  it('counts the proposal lifecycle through the mount (created/released/refused/reconciled)', async () => {
    const metrics = new OperationalMetrics();
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      metrics,
    });
    const sent: Sent[] = [];
    const send = (message: unknown): void => {
      sent.push(message as Sent);
    };
    await startLane(mount, sent);

    await relay(mount, 'check the tests.');
    const draft = (sent.find((frame) => frame.type === 'proposal_created') as Sent).proposal as {
      proposalId: string;
      version: number;
      sha256: string;
      tidied: string;
    };
    expect(metrics.snapshot().voice?.proposals).toMatchObject({ created: 1, released: 0, refused: 0, reconciled: 0 });

    // A confirmation naming no live proposal is refused, and consumes nothing.
    const refusedCode = await mount.route(
      'client-1',
      { send },
      {
        type: 'proposal_confirm',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: 'no-such-proposal',
        variant: 'tidied',
        idempotencyKey: 'idem-refused',
      } as never
    );
    expect(refusedCode).toBe('voice_confirm_requires_proposal');
    expect(metrics.snapshot().voice?.proposals).toMatchObject({ created: 1, released: 0, refused: 1 });

    // The genuine confirmation releases exactly once (H3: after a completed
    // read-back and with the identity echo).
    const presented = await mount.route(
      'client-1',
      { send },
      {
        type: 'proposal_presentation',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: draft.proposalId,
        presentedVariant: 'tidied',
        completed: true,
      } as never
    );
    expect(presented).toBeNull();
    const releasedCode = await mount.route(
      'client-1',
      { send },
      {
        type: 'proposal_confirm',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: draft.proposalId,
        variant: 'tidied',
        idempotencyKey: 'idem-released',
        proposalRef: { version: draft.version, sha256: draft.sha256 },
      } as never
    );
    expect(releasedCode).toBeNull();
    expect(metrics.snapshot().voice?.proposals).toMatchObject({ created: 1, released: 1, refused: 1, reconciled: 0 });

    // A cancelled proposal reconciles its slot without a release.
    await relay(mount, 'update the changelog.');
    const second = (sent.filter((frame) => frame.type === 'proposal_created') as Sent).at(-1)?.proposal as {
      proposalId: string;
    };
    const cancelledCode = await mount.route(
      'client-1',
      { send },
      {
        type: 'proposal_cancel',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: second.proposalId,
        reason: 'operator_cancel',
      } as never
    );
    expect(cancelledCode).toBeNull();
    expect(metrics.snapshot().voice?.proposals).toMatchObject({ created: 2, released: 1, refused: 1, reconciled: 1 });
  });

  it('never engages the live path when the engine flag is cascade, and says so on the wire', async () => {
    const metrics = new OperationalMetrics();
    let bridgeFactoryCalls = 0;
    const service = new VoiceSessionService({
      bridgeFactory: () => {
        bridgeFactoryCalls += 1;
        throw new Error('the live bridge factory must not be called when VOICE_MODE_ENGINE=cascade');
      },
    });
    const mount = new VoiceLiveMount({
      engine: 'cascade',
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      metrics,
    });
    const sent: Sent[] = [];
    await startLane(mount, sent);

    // Nothing live activated: no bridge factory call, no provider lane, and the
    // lane is recorded as cascade.
    expect(bridgeFactoryCalls).toBe(0);
    expect(service.getState(LANE)).toBeNull();
    expect(mount.getLaneEngine(LANE)).toBe('cascade');

    const stateFrame = sent.find((frame) => frame.type === 'voice_state') as Sent;
    expect(stateFrame?.state).toBe('error');
    expect(String(stateFrame?.detail)).toContain('VOICE_MODE_ENGINE=cascade');
    const errorFrame = sent.find((frame) => frame.type === 'voice_error') as Sent;
    expect(errorFrame?.fatal).toBe(true);
    expect(String(errorFrame?.message)).toContain('cascade');

    // A follow-up audio frame is bounded-refused (one surfaced error), never
    // silently swallowed and never routed to a provider.
    const code = await mount.route(
      'client-1',
      { send: (message) => sent.push(message as unknown as Sent) },
      {
        type: 'voice_audio_chunk',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        seq: 1,
        mimeType: 'audio/pcm;rate=16000',
        data: Buffer.alloc(640, 1).toString('base64'),
        durationMs: 20,
        capturedAtMs: 2,
      } as never
    );
    expect(code).toBeNull();
    expect(bridgeFactoryCalls).toBe(0);
    expect(
      sent.some((frame) => frame.type === 'voice_error' && frame.fatal === false && frame.code === 'voice_not_started')
    ).toBe(true);
  });

  it('a failing cascade sink cannot break the fallback announcement or the lane', async () => {
    const metrics = new OperationalMetrics();
    const service = new FakeService();
    const evidence: Array<Record<string, unknown>> = [];
    const badSink: VoiceCascadeSink = {
      noteEngineFallback: () => {
        throw new Error('sink unavailable');
      },
    };
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      metrics,
      evidence: (event) => evidence.push(event),
      cascade: badSink,
    });
    const sent: Sent[] = [];
    await startLane(mount, sent);
    service.emit({
      kind: 'error',
      laneId: LANE,
      attachmentGeneration: GENERATION,
      code: 'voice_provider_unavailable',
      message: 'dropped',
      fatal: true,
    });
    service.emit({
      kind: 'state',
      laneId: LANE,
      attachmentGeneration: GENERATION,
      state: 'error',
      detail: 'dropped',
    });
    await flush();
    expect(mount.getLaneEngine(LANE)).toBe('cascade');
    expect(evidence).toContainEqual(expect.objectContaining({ event: 'engine_fallback_notify_failed' }));
    expect(sent.some((frame) => frame.type === 'voice_error' && String(frame.message).includes('cascade'))).toBe(true);
    expect(sent.some((frame) => frame.type === 'voice_state' && String(frame.detail).includes('cascade'))).toBe(true);
  });
});
