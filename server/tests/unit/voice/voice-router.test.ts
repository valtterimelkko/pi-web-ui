import { describe, it, expect, vi } from 'vitest';

/**
 * Voice router unit suite (Track B, plan Phase 3; contract §6.4).
 *
 * The handler is thin by construction: it runs the contract's own envelope
 * check, resolves the lane and generation, routes to the bridge or the kernel,
 * and adds no capability. These tests prove the refusals, the routing, and that
 * a kernel-owned frame without a bound kernel surfaces rather than silently
 * succeeding.
 */

import { VoiceSessionRouter, mapBridgeEventToServerMessage } from '../../../src/voice/voice-router.js';
import type {
  VoiceBridgeEmittedEvent,
  VoiceBridgeLaneState,
  VoiceBridgeService,
  VoiceClientMessage,
  VoiceServerMessage,
} from '../../../src/voice/contract.js';
import { VOICE_WIRE_VERSION } from '../../../src/voice/contract.js';

// ── Stub service ────────────────────────────────────────────────────────────

function laneState(overrides: Partial<VoiceBridgeLaneState> = {}): VoiceBridgeLaneState {
  return {
    laneId: 'lane-1:probe',
    attachmentGeneration: 3,
    state: 'live',
    workerActivity: 'unknown',
    readingLevel: 'verbatim',
    captureMode: 'open-mic',
    resumable: false,
    startedAtMs: 0,
    lastEventAtMs: null,
    ...overrides,
  };
}

function createStubService(states: VoiceBridgeLaneState[] = [laneState()]) {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    feedAudio: vi.fn(),
    noteActivity: vi.fn(),
    injectContext: vi.fn(),
    setReadingLevel: vi.fn(),
    getState: vi.fn((laneId: string) => states.find((state) => state.laneId === laneId) ?? null),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(async () => {}),
  } satisfies VoiceBridgeService;
}

function createRouter(service: VoiceBridgeService = createStubService()) {
  const sent: VoiceServerMessage[] = [];
  const router = new VoiceSessionRouter({ service });
  const context = { send: (message: VoiceServerMessage) => sent.push(message) };
  return { router, service, context, sent };
}

const envelope = { version: VOICE_WIRE_VERSION as 1, laneId: 'lane-1:probe', attachmentGeneration: 3 };

// ── Envelope refusals (the contract check, not a second validator) ──────────

describe('VoiceSessionRouter envelope refusals', () => {
  const cases: Array<{ name: string; message: unknown; code: string }> = [
    { name: 'not an object', message: 'nope', code: 'voice_message_malformed' },
    { name: 'missing type', message: { ...envelope }, code: 'voice_message_malformed' },
    { name: 'unknown type', message: { ...envelope, type: 'voice_note' }, code: 'voice_message_unknown' },
    { name: 'server-only type', message: { ...envelope, type: 'voice_state', state: 'live' }, code: 'voice_message_unknown' },
    { name: 'wrong version', message: { ...envelope, type: 'parking_list', version: 2 }, code: 'voice_version_unsupported' },
    { name: 'missing lane', message: { ...envelope, type: 'parking_list', laneId: undefined }, code: 'voice_message_malformed' },
    { name: 'long lane', message: { ...envelope, type: 'parking_list', laneId: 'x'.repeat(201) }, code: 'voice_message_malformed' },
    { name: 'bad generation', message: { ...envelope, type: 'parking_list', attachmentGeneration: -1 }, code: 'voice_message_malformed' },
    { name: 'instruction text key', message: { ...envelope, type: 'parking_list', text: 'send it' }, code: 'voice_client_text_forbidden' },
    { name: 'unnamed field', message: { ...envelope, type: 'parking_list', note: 'do X' }, code: 'voice_message_unknown_field' },
    { name: 'missing required field', message: { ...envelope, type: 'parking_promote' }, code: 'voice_message_missing_field' },
    {
      name: 'confirm without a proposal identity',
      message: { ...envelope, type: 'proposal_confirm', variant: 'tidied', idempotencyKey: 'i-1' },
      code: 'voice_confirm_requires_proposal',
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name} with ${testCase.code} and acts on nothing`, async () => {
      const { router, service, context } = createRouter();
      const code = await router.handle(context, testCase.message as VoiceClientMessage);
      expect(code).toBe(testCase.code);
      expect(service.start).not.toHaveBeenCalled();
      expect(service.feedAudio).not.toHaveBeenCalled();
      expect(service.stop).not.toHaveBeenCalled();
    });
  }
});

// ── Bridge-owned routing ────────────────────────────────────────────────────

describe('VoiceSessionRouter bridge routing', () => {
  it('starts a lane with contract defaults and adopts the client envelope', async () => {
    const { router, service, context } = createRouter();
    const message: VoiceClientMessage = {
      type: 'voice_session_start',
      ...envelope,
      requestId: 'req-1',
      workerSessionId: 'session-abc',
    };
    expect(await router.handle(context, message)).toBeNull();
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: 'lane-1:probe',
        attachmentGeneration: 3,
        workerSessionId: 'session-abc',
        runtime: 'pi',
        captureMode: 'open-mic',
        readingLevel: 'verbatim',
        resume: false,
      })
    );
  });

  it('passes explicit start fields through', async () => {
    const { router, service, context } = createRouter();
    await router.handle(context, {
      type: 'voice_session_start',
      ...envelope,
      workerSessionId: 'session-abc',
      runtime: 'claude',
      captureMode: 'push-to-talk',
      readingLevel: 'summary',
      resume: true,
    } as VoiceClientMessage);
    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'claude', captureMode: 'push-to-talk', readingLevel: 'summary', resume: true })
    );
  });

  it('routes stop, audio, activity and reading level', async () => {
    const { router, service, context } = createRouter();
    await router.handle(context, { type: 'voice_session_stop', ...envelope, reason: 'operator_stop' } as VoiceClientMessage);
    expect(service.stop).toHaveBeenCalledWith('lane-1:probe', 'operator_stop');

    await router.handle(context, {
      type: 'voice_audio_chunk',
      ...envelope,
      seq: 0,
      mimeType: 'audio/pcm;rate=16000',
      data: Buffer.alloc(640).toString('base64'),
      durationMs: 20,
      capturedAtMs: 1,
    } as VoiceClientMessage);
    expect(service.feedAudio).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: 'lane-1:probe', attachmentGeneration: 3, seq: 0 })
    );

    await router.handle(context, {
      type: 'voice_activity_state',
      ...envelope,
      state: 'speech_start',
      atMs: 5,
    } as VoiceClientMessage);
    expect(service.noteActivity).toHaveBeenCalledWith({
      laneId: 'lane-1:probe',
      attachmentGeneration: 3,
      state: 'speech_start',
      atMs: 5,
    });

    await router.handle(context, { type: 'voice_reading_level', ...envelope, level: 'headlines' } as VoiceClientMessage);
    expect(service.setReadingLevel).toHaveBeenCalledWith('lane-1:probe', 'headlines');
  });

  it('refuses an unknown lane, a stale generation and audio before live', async () => {
    const service = createStubService([laneState({ laneId: 'lane-1:probe', attachmentGeneration: 3, state: 'connecting' })]);
    const { router, context } = createRouter(service);
    const audio = {
      type: 'voice_audio_chunk',
      laneId: 'lane-1:probe',
      version: VOICE_WIRE_VERSION,
      attachmentGeneration: 3,
      seq: 0,
      mimeType: 'audio/pcm;rate=16000',
      data: Buffer.alloc(640).toString('base64'),
      durationMs: 20,
      capturedAtMs: 1,
    } as VoiceClientMessage;
    expect(await router.handle(context, audio)).toBe('voice_not_started');
    expect(await router.handle(context, { ...audio, laneId: 'ghost:lane' } as VoiceClientMessage)).toBe('voice_lane_unknown');
    expect(await router.handle(context, { ...audio, attachmentGeneration: 2 } as VoiceClientMessage)).toBe('voice_generation_stale');
    expect(service.feedAudio).not.toHaveBeenCalled();
  });

  it('refuses activity and reading level for a stale generation', async () => {
    const service = createStubService([laneState({ state: 'live', attachmentGeneration: 3 })]);
    const { router, context } = createRouter(service);
    expect(
      await router.handle(context, {
        type: 'voice_activity_state',
        ...envelope,
        attachmentGeneration: 2,
        state: 'speech_start',
        atMs: 0,
      } as VoiceClientMessage)
    ).toBe('voice_generation_stale');
    expect(
      await router.handle(context, { type: 'voice_reading_level', ...envelope, attachmentGeneration: 2, level: 'summary' } as VoiceClientMessage)
    ).toBe('voice_generation_stale');
    expect(service.noteActivity).not.toHaveBeenCalled();
    expect(service.setReadingLevel).not.toHaveBeenCalled();
  });

  it('lets a session start create a lane the service has not seen', async () => {
    const service = createStubService([]);
    const { router, context } = createRouter(service);
    expect(
      await router.handle(context, {
        type: 'voice_session_start',
        ...envelope,
        workerSessionId: 'session-abc',
      } as VoiceClientMessage)
    ).toBeNull();
    expect(service.start).toHaveBeenCalledTimes(1);
  });
});

// ── Kernel-owned routing ────────────────────────────────────────────────────

describe('VoiceSessionRouter kernel delegation', () => {
  const kernelOwned: VoiceClientMessage[] = [
    {
      type: 'proposal_confirm',
      ...envelope,
      proposalId: 'prop-1',
      variant: 'tidied',
      idempotencyKey: 'idem-1',
    },
    { type: 'proposal_cancel', ...envelope, proposalId: 'prop-1', reason: 'operator_cancel' },
    { type: 'proposal_presentation', ...envelope, proposalId: 'prop-1', presentedVariant: 'tidied', completed: true },
    { type: 'parking_promote', ...envelope, itemId: 'item-1' },
    { type: 'parking_list', ...envelope },
  ];

  it('surfaces voice_internal_error for every kernel-owned frame when no kernel is bound', async () => {
    const { router, service, context } = createRouter();
    for (const message of kernelOwned) {
      expect(await router.handle(context, message)).toBe('voice_internal_error');
    }
    expect(service.start).not.toHaveBeenCalled();
    expect(service.feedAudio).not.toHaveBeenCalled();
  });

  it('delegates kernel-owned frames to the bound kernel and relays its refusal', async () => {
    const service = createStubService();
    const kernel = { handle: vi.fn(async () => 'voice_proposal_stale' as const) };
    const router = new VoiceSessionRouter({ service, kernel });
    const context = { send: () => {} };
    expect(await router.handle(context, kernelOwned[0])).toBe('voice_proposal_stale');
    expect(kernel.handle).toHaveBeenCalledWith(context, kernelOwned[0]);
  });

  it('accepts a kernel-owned frame when the kernel returns null', async () => {
    const kernel = { handle: vi.fn(async () => null) };
    const router = new VoiceSessionRouter({ service: createStubService(), kernel });
    expect(await router.handle({ send: () => {} }, kernelOwned[4])).toBeNull();
  });
});

// ── Bridge-event mapping helper ─────────────────────────────────────────────

describe('mapBridgeEventToServerMessage', () => {
  const base = { laneId: 'lane-1:probe', attachmentGeneration: 3 };

  it('maps audio_out to a 24 kHz wire chunk', () => {
    const event: VoiceBridgeEmittedEvent = {
      kind: 'audio_out',
      ...base,
      seq: 7,
      mimeType: 'audio/pcm;rate=24000',
      data: 'AAAA',
      durationMs: 20,
      atMs: 100,
    };
    expect(mapBridgeEventToServerMessage(event)).toEqual({
      type: 'voice_audio_chunk',
      version: VOICE_WIRE_VERSION,
      ...base,
      seq: 7,
      mimeType: 'audio/pcm;rate=24000',
      data: 'AAAA',
      durationMs: 20,
      atMs: 100,
    });
  });

  it('maps transcript deltas, including kernel identity when present', () => {
    const event: VoiceBridgeEmittedEvent = {
      kind: 'transcript',
      ...base,
      speaker: 'operator',
      source: 'native',
      text: 'hello',
      final: true,
      utteranceId: 9,
      turnId: 'pi:session-abc:14',
      atMs: 5,
    };
    expect(mapBridgeEventToServerMessage(event)).toMatchObject({
      type: 'transcript_delta',
      speaker: 'operator',
      source: 'native',
      text: 'hello',
      final: true,
      utteranceId: 9,
      turnId: 'pi:session-abc:14',
    });
  });

  it('maps state, resumption, goAway and error without ever carrying a resumption handle', () => {
    const state = mapBridgeEventToServerMessage({ kind: 'state', ...base, state: 'live', detail: 'ok' });
    expect(state).toMatchObject({ type: 'voice_state', state: 'live', detail: 'ok' });

    const resumption = mapBridgeEventToServerMessage({ kind: 'resumption', ...base, handle: 'SECRET-HANDLE', resumable: true });
    expect(resumption).toMatchObject({ type: 'voice_state', state: 'live', resumption: { resumable: true } });
    expect(JSON.stringify(resumption)).not.toContain('SECRET-HANDLE');

    const goAway = mapBridgeEventToServerMessage({ kind: 'go_away', ...base, timeLeft: '5s' });
    expect(goAway).toMatchObject({ type: 'voice_state', state: 'reconnecting' });

    const error = mapBridgeEventToServerMessage({ kind: 'error', ...base, code: 'voice_provider_unavailable', message: 'down', fatal: true });
    expect(error).toMatchObject({ type: 'voice_error', code: 'voice_provider_unavailable', message: 'down', fatal: true });
  });

  it('maps interruption to a state and never maps tool_call or turn_complete to the wire', () => {
    expect(mapBridgeEventToServerMessage({ kind: 'interrupted', ...base, atMs: 1 })).toMatchObject({ type: 'voice_state' });
    expect(mapBridgeEventToServerMessage({ kind: 'turn_complete', ...base, atMs: 1 })).toBeNull();
    expect(
      mapBridgeEventToServerMessage({ kind: 'tool_call', ...base, callId: 'c1', name: 'read_worker_history', args: { query: 'x' }, atMs: 1 })
    ).toBeNull();
  });
});
