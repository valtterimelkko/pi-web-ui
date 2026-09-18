import { describe, it, expect } from 'vitest';

/**
 * Voice session service unit suite (Track B, plan Phase 3).
 *
 * The provider socket is mocked. The service is exercised through the frozen
 * `VoiceBridgeService` boundary: start/stop, audio feed, activity, context
 * injection with coalescing and speech suppression, and bounded drop-and-surface
 * for audio faults. One test drives the REAL bridge over a mock provider socket,
 * so the session↔bridge↔transcoder path is proven end-to-end offline.
 *
 * N1/N8 guard: nothing in this suite may create a send path to the worker. The
 * service can only emit `VoiceBridgeEmittedEvent`s; a test asserts that the
 * emitted event vocabulary contains no release, receipt or delivery kind.
 */

import { VoiceSessionService } from '../../../src/voice/voice-session.js';
import { GeminiLiveBridge } from '../../../src/voice/gemini-live-bridge.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import {
  VOICE_CONTEXT_COALESCE_MS,
  type VoiceBridgeEmittedEvent,
  type VoiceBridgeService,
  type VoiceBridgeStartOptions,
} from '../../../src/voice/contract.js';
import { VOICE_AUDIO_INPUT_FORMAT } from '../../../src/voice/contract.js';
import type {
  GeminiLiveBridgeCallbacks,
  LiveRealtimeInput,
  LiveSessionFactory,
  LiveSessionLike,
  VoiceBridgeLike,
  VoiceClock,
} from '../../../src/voice/types.js';

// ── Mock bridge (service-level tests) ───────────────────────────────────────

class MockBridge implements VoiceBridgeLike {
  static instances: MockBridge[] = [];
  readonly options: Record<string, unknown>;
  callbacks: GeminiLiveBridgeCallbacks;
  sentAudio: Buffer[] = [];
  sentContext: string[] = [];
  activity: string[] = [];
  closed = false;
  connectCalls = 0;
  connectError: Error | null = null;
  resumptionHandle: string | null = null;
  sendAudioResult = true;
  sendContextResult = true;

  constructor(options: { callbacks: GeminiLiveBridgeCallbacks } & Record<string, unknown>) {
    this.callbacks = options.callbacks;
    this.options = options;
    MockBridge.instances.push(this);
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
  }

  sendAudio(pcm: Buffer): boolean {
    this.sentAudio.push(pcm);
    return this.sendAudioResult;
  }

  sendContextText(text: string): boolean {
    this.sentContext.push(text);
    return this.sendContextResult;
  }

  activityStart(): void {
    this.activity.push('start');
  }

  activityEnd(): void {
    this.activity.push('end');
  }

  close(): void {
    this.closed = true;
  }
}

function createServiceHarness(overrides: Record<string, unknown> = {}) {
  MockBridge.instances = [];
  let now = 0;
  const timers: Array<{ fn: () => void; delayMs: number; cancelled: boolean }> = [];
  const state = { failNextConnect: false };
  const clock: VoiceClock = () => now;
  const service = new VoiceSessionService({
    bridgeFactory: (options) => {
      const bridge = new MockBridge(options as never);
      if (state.failNextConnect) bridge.connectError = new Error('no provider key');
      state.failNextConnect = false;
      return bridge;
    },
    clock,
    scheduler: (fn, delayMs) => {
      const timer = { fn, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...overrides,
  });
  return {
    service,
    bridges: MockBridge.instances,
    timers,
    failNextConnect: () => {
      state.failNextConnect = true;
    },
    advance: (ms: number) => {
      now += ms;
    },
    runTimers: () => {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
    },
  };
}

function startOptions(laneId = 'lane-1:probe', attachmentGeneration = 3): VoiceBridgeStartOptions {
  return {
    laneId,
    attachmentGeneration,
    workerSessionId: 'session-abc',
    runtime: 'pi',
    captureMode: 'open-mic',
    readingLevel: 'verbatim',
    callbacks: {},
  };
}

function collect(service: VoiceBridgeService) {
  const events: VoiceBridgeEmittedEvent[] = [];
  const unsubscribe = service.subscribe((event) => events.push(event));
  return { events, unsubscribe, kinds: () => events.map((event) => event.kind) };
}

function audioChunk(seq: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    laneId: 'lane-1:probe',
    attachmentGeneration: 3,
    seq,
    mimeType: 'audio/pcm;rate=16000' as const,
    data: Buffer.alloc(640, 4).toString('base64'),
    durationMs: 20,
    capturedAtMs: 100 + seq,
    ...overrides,
  };
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('VoiceSessionService lifecycle', () => {
  it('adopts the lane, emits connecting then live, and exposes the snapshot', async () => {
    const { service, bridges, advance } = createServiceHarness();
    const { events } = collect(service);
    advance(1_000);
    await service.start(startOptions());
    expect(bridges).toHaveLength(1);
    expect(bridges[0].connectCalls).toBe(1);
    expect(events[0]).toMatchObject({ kind: 'state', state: 'connecting', laneId: 'lane-1:probe', attachmentGeneration: 3 });
    bridges[0].callbacks.onState?.('live');
    const snapshot = service.getState('lane-1:probe');
    expect(snapshot).toMatchObject({
      laneId: 'lane-1:probe',
      attachmentGeneration: 3,
      state: 'live',
      readingLevel: 'verbatim',
      captureMode: 'open-mic',
      workerActivity: 'unknown',
      resumable: false,
      startedAtMs: 1_000,
    });
    expect(events.at(-1)).toMatchObject({ kind: 'state', state: 'live' });
  });

  it('passes toolResponseScheduling through to the bridge option surface (F-1)', async () => {
    const { service, bridges } = createServiceHarness({ toolResponseScheduling: 'SILENT' });
    await service.start(startOptions());
    expect(bridges[0].options.toolResponseScheduling).toBe('SILENT');
  });

  it('records audio streamed in/out and live drop/resumption counters (Phase 8)', async () => {
    const metrics = new OperationalMetrics();
    const { service, bridges } = createServiceHarness({ metrics });
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');

    service.feedAudio(audioChunk(1));
    expect(metrics.snapshot().voice?.audio.inputBytes).toBe(640);

    bridges[0].callbacks.onAudioPcm?.(Buffer.alloc(960, 1), 'audio/pcm;rate=24000', 10);
    expect(metrics.snapshot().voice?.audio.outputBytes).toBe(960);

    bridges[0].callbacks.onState?.('reconnecting', 'socket closed unexpectedly');
    expect(metrics.snapshot().voice?.live).toMatchObject({ connectionDrops: 1, resumptionAttempts: 1 });
    bridges[0].callbacks.onReconnected?.();
    expect(metrics.snapshot().voice?.live).toMatchObject({
      connectionDrops: 1,
      resumptionAttempts: 1,
      resumptionSuccesses: 1,
      resumptionFailures: 0,
      resumptionSuccessRate: 1,
    });
  });

  it('counts a fatal error while live as a drop with no resumption attempt', async () => {
    const metrics = new OperationalMetrics();
    const { service, bridges } = createServiceHarness({ metrics });
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    bridges[0].callbacks.onError?.({ code: 'voice_provider_unavailable', message: 'no handle, session lost', fatal: true });
    expect(metrics.snapshot().voice?.live).toMatchObject({
      connectionDrops: 1,
      resumptionAttempts: 0,
      resumptionSuccesses: 0,
      resumptionFailures: 0,
    });
  });

  it('counts a failed resumption when a fatal error lands mid-reconnect', async () => {
    const metrics = new OperationalMetrics();
    const { service, bridges } = createServiceHarness({ metrics });
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    bridges[0].callbacks.onState?.('reconnecting', 'provider goAway');
    bridges[0].callbacks.onError?.({ code: 'voice_provider_unavailable', message: 'attempt failed', fatal: true });
    expect(metrics.snapshot().voice?.live).toMatchObject({
      connectionDrops: 1,
      resumptionAttempts: 1,
      resumptionSuccesses: 0,
      resumptionFailures: 1,
      resumptionSuccessRate: 0,
    });
  });

  it('records resumption handles and reports resumable', async () => {
    const { service, bridges } = createServiceHarness();
    await service.start(startOptions());
    bridges[0].callbacks.onResumptionHandle?.('handle-9', true);
    expect(service.getState('lane-1:probe')?.resumable).toBe(true);
  });

  it('is idempotent for the same lane and generation, and adopts a new generation by closing the old bridge', async () => {
    const { service, bridges } = createServiceHarness();
    await service.start(startOptions());
    await service.start(startOptions());
    expect(bridges).toHaveLength(1);
    bridges[0].callbacks.onState?.('live');

    await service.start(startOptions('lane-1:probe', 4));
    expect(bridges).toHaveLength(2);
    expect(bridges[0].closed).toBe(true);
    expect(service.getState('lane-1:probe')?.attachmentGeneration).toBe(4);
  });

  it('surfaces a provider connect failure as an error state without rejecting', async () => {
    const { service, failNextConnect } = createServiceHarness();
    const { events } = collect(service);
    failNextConnect();
    await expect(service.start(startOptions())).resolves.toBeUndefined();
    expect(service.getState('lane-1:probe')?.state).toBe('error');
    expect(events.some((event) => event.kind === 'state' && (event as { state: string }).state === 'error')).toBe(true);
  });

  it('maps a bridge error callback to an emitted error event and an error state', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onError?.({ code: 'voice_provider_unavailable', message: 'socket died', fatal: true });
    const error = events.find((event) => event.kind === 'error') as { code: string; fatal: boolean };
    expect(error.code).toBe('voice_provider_unavailable');
    expect(error.fatal).toBe(true);
    expect(service.getState('lane-1:probe')?.state).toBe('error');
  });
});

// ── Stop / dispose ──────────────────────────────────────────────────────────

describe('VoiceSessionService stop and dispose', () => {
  it('stops a lane, closes the bridge and says why - and releases nothing', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    await service.stop('lane-1:probe', 'operator_stop');
    expect(bridges[0].closed).toBe(true);
    expect(service.getState('lane-1:probe')?.state).toBe('stopped');
    const stopEvents = events.filter((event) => event.kind === 'state' && (event as { state: string }).state === 'stopped');
    expect(stopEvents).toHaveLength(1);
    expect(stopEvents[0]).toMatchObject({ state: 'stopped', detail: 'operator_stop' });
    expect(events.every((event) => !/release|receipt|deliver/i.test(event.kind))).toBe(true);
  });

  it('a throwing subscriber cannot break the provider callback path or other subscribers', async () => {
    const { service, bridges } = createServiceHarness();
    const received: string[] = [];
    service.subscribe(() => {
      throw new Error('subscriber boom');
    });
    service.subscribe((event) => received.push(event.kind));
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    expect(received).toContain('state');
    expect(bridges[0].callbacks.onAudioPcm).toBeTypeOf('function');
    expect(() => bridges[0].callbacks.onAudioPcm?.(Buffer.alloc(960), 'audio/pcm;rate=24000', 1)).not.toThrow();
  });

  it('tolerates stopping an unknown lane', async () => {
    const { service } = createServiceHarness();
    await expect(service.stop('never:seen', 'operator_stop')).resolves.toBeUndefined();
  });

  it('disposes every lane, clears subscribers and refuses further starts', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions('lane-1:probe', 3));
    await service.start(startOptions('lane-2:probe', 1));
    await service.dispose();
    expect(bridges.every((bridge) => bridge.closed)).toBe(true);
    expect(service.getState('lane-1:probe')?.state).toBe('stopped');
    await expect(service.start(startOptions('lane-3:probe', 1))).rejects.toThrow(/disposed/i);
    const countAfterDispose = events.length;
    expect(service.subscribe(() => {})).toBeTypeOf('function');
    expect(events.length).toBe(countAfterDispose);
  });
});

// ── Audio feed: validation, transcoding, drop-and-surface ───────────────────

describe('VoiceSessionService feedAudio', () => {
  it('delivers a valid chunk to the bridge and advances the sequence', async () => {
    const { service, bridges } = createServiceHarness();
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    service.feedAudio(audioChunk(0));
    service.feedAudio(audioChunk(1));
    expect(bridges[0].sentAudio).toHaveLength(2);
    expect(bridges[0].sentAudio[0].length).toBe(640);
  });

  it('resamples when the provider input rate is 24 kHz', async () => {
    const { service, bridges } = createServiceHarness({ providerInputSampleRateHz: 24_000 });
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    service.feedAudio(audioChunk(0));
    expect(bridges[0].sentAudio[0].length).toBe(960);
  });

  it('never throws, and surfaces corrupt, oversized and wrong-mime chunks (bounded per lane per second)', async () => {
    const { service, bridges, advance } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    expect(() => service.feedAudio(audioChunk(0, { data: 'not base64 !!!' }))).not.toThrow();
    advance(1_001);
    expect(() =>
      service.feedAudio(audioChunk(1, { data: Buffer.alloc(VOICE_AUDIO_INPUT_FORMAT.maxChunkBytes + 2).toString('base64') }))
    ).not.toThrow();
    advance(1_001);
    expect(() => service.feedAudio(audioChunk(2, { mimeType: 'audio/pcm;rate=44100' }))).not.toThrow();
    expect(bridges[0].sentAudio).toHaveLength(0);
    const codes = events.filter((event) => event.kind === 'error').map((event) => (event as { code: string }).code);
    expect(codes).toContain('voice_audio_chunk_corrupt');
    expect(codes).toContain('voice_audio_chunk_too_large');
    expect(codes).toContain('voice_message_malformed');
  });

  it('refuses unknown lanes, stale generations and audio before live', async () => {
    const { service, bridges, advance } = createServiceHarness();
    const { events } = collect(service);
    service.feedAudio(audioChunk(0, { laneId: 'other:lane' }));
    await service.start(startOptions());
    service.feedAudio(audioChunk(0, { attachmentGeneration: 2 }));
    advance(1_001);
    service.feedAudio(audioChunk(0));
    const codes = events.filter((event) => event.kind === 'error').map((event) => (event as { code: string }).code);
    expect(codes).toContain('voice_lane_unknown');
    expect(codes).toContain('voice_generation_stale');
    expect(codes).toContain('voice_not_started');
    expect(bridges[0].sentAudio).toHaveLength(0);
  });

  it('surfaces a sequence gap once and continues delivering', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    service.feedAudio(audioChunk(0));
    service.feedAudio(audioChunk(5));
    service.feedAudio(audioChunk(6));
    expect(bridges[0].sentAudio).toHaveLength(3);
    const gapErrors = events.filter((event) => event.kind === 'error' && /seq/i.test((event as { message: string }).message));
    expect(gapErrors).toHaveLength(1);
  });

  it('bounds repeated audio-fault surfacing to one per lane per second with a suppressed count', async () => {
    const { service, bridges, advance } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    for (let i = 0; i < 5; i += 1) service.feedAudio(audioChunk(i, { data: 'not base64 !!!' }));
    const first = events.filter((event) => event.kind === 'error');
    expect(first).toHaveLength(1);
    advance(1_001);
    service.feedAudio(audioChunk(10, { data: 'not base64 !!!' }));
    const all = events.filter((event) => event.kind === 'error');
    expect(all).toHaveLength(2);
    expect((all[1] as { message: string }).message).toContain('suppressed');
  });

  it('survives a flood of audio chunks without throwing or unbounded buffering', async () => {
    const { service, bridges } = createServiceHarness();
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    for (let i = 0; i < 5_000; i += 1) {
      expect(() => service.feedAudio(audioChunk(i))).not.toThrow();
    }
    expect(bridges[0].sentAudio).toHaveLength(5_000);
  });

  it('surfaces provider backpressure (sendAudio false) without throwing', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    bridges[0].sendAudioResult = false;
    service.feedAudio(audioChunk(0));
    expect(events.some((event) => event.kind === 'error')).toBe(true);
  });
});

// ── Transcripts and event mapping ───────────────────────────────────────────

describe('VoiceSessionService transcript mapping', () => {
  it('emits partial operator deltas and a final operator delta at turn completion', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    bridges[0].callbacks.onInputTranscription?.('ask it ', 10);
    bridges[0].callbacks.onInputTranscription?.('to check the tests', 20);
    bridges[0].callbacks.onTurnComplete?.(30);
    const transcripts = events.filter((event) => event.kind === 'transcript') as Array<{
      speaker: string;
      text: string;
      final: boolean;
      atMs: number;
    }>;
    expect(transcripts.filter((event) => event.speaker === 'operator' && !event.final).map((event) => event.text)).toEqual([
      'ask it ',
      'to check the tests',
    ]);
    const finalOperator = transcripts.find((event) => event.speaker === 'operator' && event.final);
    expect(finalOperator?.text).toBe('ask it to check the tests');
    expect(events.some((event) => event.kind === 'turn_complete')).toBe(true);
  });

  it('emits a final talker delta and an interrupted event on interruption', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    bridges[0].callbacks.onOutputTranscription?.('Both workers are ', 10);
    bridges[0].callbacks.onOutputTranscription?.('running.', 20);
    bridges[0].callbacks.onInterrupted?.(30);
    const finals = (events.filter((event) => event.kind === 'transcript') as Array<{ speaker: string; final: boolean; text: string }>).filter(
      (event) => event.final
    );
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ speaker: 'talker', text: 'Both workers are running.', final: true, atMs: 30 });
    expect(events.some((event) => event.kind === 'interrupted')).toBe(true);
  });

  it('emits audio_out frames with monotonic per-lane sequence and 24 kHz framing', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    bridges[0].callbacks.onAudioPcm?.(Buffer.alloc(960, 1), 'audio/pcm;rate=24000', 5);
    bridges[0].callbacks.onAudioPcm?.(Buffer.alloc(960, 2), 'audio/pcm;rate=24000', 6);
    const audio = events.filter((event) => event.kind === 'audio_out') as Array<{ seq: number; mimeType: string; durationMs: number }>;
    expect(audio.map((event) => event.seq)).toEqual([0, 1]);
    expect(audio[0].mimeType).toBe('audio/pcm;rate=24000');
    expect(audio[0].durationMs).toBe(20);
  });

  it('re-frames an oversized provider delivery into ceiling-sized frames', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    bridges[0].callbacks.onAudioPcm?.(Buffer.alloc(20_000, 1), 'audio/pcm;rate=24000', 5);
    const audio = events.filter((event) => event.kind === 'audio_out') as Array<{ data: string; durationMs: number }>;
    expect(audio.length).toBeGreaterThan(1);
    expect(Math.max(...audio.map((event) => Buffer.from(event.data, 'base64').length))).toBeLessThanOrEqual(4_800);
  });

  it('maps resumption, goAway and state events straight through', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onResumptionHandle?.('h-1', true);
    bridges[0].callbacks.onGoAway?.('5s');
    bridges[0].callbacks.onState?.('reconnecting');
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain('resumption');
    expect(kinds).toContain('go_away');
    expect(kinds).toContain('state');
  });

  it('maps a validated tool call straight through without adding authority', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onToolCall?.({ name: 'mark_addressed_to_talker', args: {}, id: 'call-1', atMs: 1 });
    const toolCall = events.find((event) => event.kind === 'tool_call') as { name: string; args: Record<string, never> };
    expect(toolCall.name).toBe('mark_addressed_to_talker');
    expect(toolCall.args).toEqual({});
  });
});

// ── Context injection: coalescing and speech suppression ────────────────────

describe('VoiceSessionService context injection', () => {
  it('sends the first update immediately and coalesces the next inside the contract window', async () => {
    const { service, bridges, advance, runTimers } = createServiceHarness();
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    service.injectContext('lane-1:probe', { workerActivity: 'busy', activity: 'running tests', statusLine: 'CURRENT STATUS: RUNNING', atMs: 0 });
    expect(bridges[0].sentContext).toHaveLength(1);
    expect(bridges[0].sentContext[0]).toContain('CURRENT STATUS: RUNNING');
    expect(bridges[0].sentContext[0]).toContain('ACTIVITY: running tests');

    advance(500);
    service.injectContext('lane-1:probe', { workerActivity: 'idle', statusLine: 'CURRENT STATUS: IDLE', atMs: 500 });
    expect(bridges[0].sentContext).toHaveLength(1);
    advance(VOICE_CONTEXT_COALESCE_MS);
    runTimers();
    expect(bridges[0].sentContext).toHaveLength(2);
    expect(bridges[0].sentContext[1]).toContain('CURRENT STATUS: IDLE');
  });

  it('suppresses context while the operator speaks and flushes the latest on speech end', async () => {
    const { service, bridges } = createServiceHarness();
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    service.noteActivity({ laneId: 'lane-1:probe', attachmentGeneration: 3, state: 'speech_start', atMs: 0 });
    service.injectContext('lane-1:probe', { workerActivity: 'busy', statusLine: 'CURRENT STATUS: RUNNING', atMs: 1 });
    service.injectContext('lane-1:probe', { workerActivity: 'idle', statusLine: 'CURRENT STATUS: IDLE', atMs: 2 });
    expect(bridges[0].sentContext).toHaveLength(0);
    expect(bridges[0].activity).toEqual(['start']);
    service.noteActivity({ laneId: 'lane-1:probe', attachmentGeneration: 3, state: 'speech_end', atMs: 3 });
    expect(bridges[0].activity).toEqual(['start', 'end']);
    expect(bridges[0].sentContext).toHaveLength(1);
    expect(bridges[0].sentContext[0]).toContain('CURRENT STATUS: IDLE');
  });

  it('never throws for an unknown lane', async () => {
    const { service } = createServiceHarness();
    expect(() => service.injectContext('nope', { workerActivity: 'idle', statusLine: 'x', atMs: 0 })).not.toThrow();
    expect(() =>
      service.noteActivity({ laneId: 'nope', attachmentGeneration: 1, state: 'speech_start', atMs: 0 })
    ).not.toThrow();
  });

  it('reading level is an operation: it emits a state carrying the level and queues a context line', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    service.setReadingLevel('lane-1:probe', 'headlines');
    expect(service.getState('lane-1:probe')?.readingLevel).toBe('headlines');
    const state = events.filter((event) => event.kind === 'state').at(-1) as { state: string; detail?: string };
    expect(state.state).toBe('live');
    expect(state.detail).toContain('headlines');
    const text = bridges[0].sentContext.join('\n');
    expect(text).toContain('READING LEVEL: headlines');
  });
});

// ── N1/N8: the service has no worker send path ──────────────────────────────

describe('VoiceSessionService has no delivery capability', () => {
  it('implements the frozen service surface and exposes no release/delivery verb', () => {
    const { service } = createServiceHarness();
    const contractMethods = ['start', 'stop', 'feedAudio', 'noteActivity', 'injectContext', 'setReadingLevel', 'getState', 'subscribe', 'dispose'];
    const prototype = Object.getPrototypeOf(service) as Record<string, unknown>;
    for (const name of contractMethods) expect(typeof prototype[name], name).toBe('function');
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      expect(name).not.toMatch(/release|deliver|confirm|promote/i);
      expect(name).not.toMatch(/send(To)?Worker|sendInstruction|sendRelease|deliver|dispatchToWorker/i);
    }
    // `sendContext` legitimately sends host context TO THE PROVIDER; the proof
    // that no worker send path exists is that the service has no worker
    // dependency at all, checked in the neutrality suite.
    expect(typeof prototype.sendContext).toBe('function');
  });

  it('emits an event vocabulary with no delivery kind', async () => {
    const { service, bridges } = createServiceHarness();
    const { events } = collect(service);
    await service.start(startOptions());
    bridges[0].callbacks.onState?.('live');
    bridges[0].callbacks.onToolCall?.({ name: 'offer_ask_worker', args: {}, id: 'c1', atMs: 1 });
    bridges[0].callbacks.onInputTranscription?.('hello', 2);
    bridges[0].callbacks.onTurnComplete?.(3);
    bridges[0].callbacks.onAudioPcm?.(Buffer.alloc(960), 'audio/pcm;rate=24000', 4);
    const kinds = new Set(events.map((event) => event.kind));
    for (const kind of kinds) expect(kind).not.toMatch(/release|receipt|deliver|confirm|promote/i);
  });
});

// ── Real bridge + mock provider socket (integration through the seam) ───────

class MockProviderSession implements LiveSessionLike {
  readonly sentRealtime: LiveRealtimeInput[] = [];
  readonly sentClientContent: Array<{ turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: boolean }> = [];
  closed = false;
  sendRealtimeInput(input: LiveRealtimeInput): void {
    this.sentRealtime.push(input);
  }
  sendClientContent(content: { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: boolean }): void {
    this.sentClientContent.push(content);
  }
  sendToolResponse(): void {}
  close(): void {
    this.closed = true;
  }
}

function createIntegrationHarness() {
  const sessions: MockProviderSession[] = [];
  const requests: Array<{ callbacks: { onMessage: (message: unknown) => void; onOpen: () => void } }> = [];
  const factory: LiveSessionFactory = async (request) => {
    requests.push(request as never);
    const session = new MockProviderSession();
    sessions.push(session);
    return session;
  };
  const service = new VoiceSessionService({
    bridgeFactory: (options) => new GeminiLiveBridge({ ...options, sessionFactory: factory }),
    clock: () => 0,
    scheduler: (fn) => {
      fn();
      return () => {};
    },
  });
  return {
    service,
    sessions,
    requests,
    events: () => [] as string[],
    open: () => requests[0].callbacks.onOpen(),
    emit: (message: unknown) => requests[0].callbacks.onMessage(message),
  };
}

describe('VoiceSessionService with the real bridge over a mock provider socket', () => {
  it('feeds transcoded audio to the provider and maps provider transcription back out', async () => {
    const harness = createIntegrationHarness();
    const collected: VoiceBridgeEmittedEvent[] = [];
    harness.service.subscribe((event) => collected.push(event));
    await harness.service.start(startOptions());
    harness.open();
    harness.emit({ setupComplete: {} });
    expect(harness.service.getState('lane-1:probe')?.state).toBe('live');

    harness.service.feedAudio(audioChunk(0));
    expect(harness.sessions[0].sentRealtime[0]).toMatchObject({
      audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.alloc(640, 4).toString('base64') },
    });

    harness.emit({ serverContent: { inputTranscription: { text: 'check the tests' } } });
    harness.emit({ serverContent: { turnComplete: true } });
    const transcripts = collected.filter((event) => event.kind === 'transcript') as Array<{ text: string; final: boolean }>;
    expect(transcripts.some((event) => event.text === 'check the tests' && !event.final)).toBe(true);
    expect(transcripts.some((event) => event.text === 'check the tests' && event.final)).toBe(true);
  });

  it('injects a queued context snapshot only after the provider reports live', async () => {
    const harness = createIntegrationHarness();
    await harness.service.start(startOptions());
    harness.service.injectContext('lane-1:probe', {
      workerActivity: 'busy',
      statusLine: 'CURRENT STATUS: RUNNING',
      atMs: 0,
    });
    expect(harness.sessions[0].sentClientContent).toHaveLength(0);
    harness.open();
    harness.emit({ setupComplete: {} });
    expect(harness.sessions[0].sentClientContent).toHaveLength(1);
    expect(harness.sessions[0].sentClientContent[0].turns[0].parts[0].text).toContain('CURRENT STATUS: RUNNING');
  });
});
