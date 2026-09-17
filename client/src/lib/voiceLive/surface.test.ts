import { describe, expect, it } from 'vitest';
import {
  VOICE_WIRE_VERSION,
  type VoiceAudioOutputChunkMessage,
  type VoiceClientMessage,
  type VoiceReceiptEventMessage,
} from '@pi-web-ui/shared';
import { createSpeechArbiter } from '../speechArbiter';
import { VoiceLiveSurface, type VoiceLiveSurfaceFactories } from './surface';
import { createVoiceLane, pcm16Base64 } from './messages';
import type { CaptureActivityReport, CaptureChunk, CaptureSession, StartCaptureSessionOptions } from './captureSession';
import type { PlaybackBackend, ScheduledHandle } from './playbackSession';

const LANE = createVoiceLane({ workerSessionId: 'worker-1', nonce: 's1' });

function env(type: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    version: VOICE_WIRE_VERSION,
    laneId: LANE.laneId,
    attachmentGeneration: LANE.attachmentGeneration,
    ...extra,
  } as unknown;
}

function receipt(outcome: string): VoiceReceiptEventMessage {
  return env('receipt_event', {
    receipt: { releaseId: 'rel-1', proposalId: 'p', idempotencyKey: 'k', outcome, atMs: 1 },
  }) as unknown as VoiceReceiptEventMessage;
}

/** A fake gain-only playback backend (scheduling is unit-tested elsewhere). */
class FakePlaybackBackend implements PlaybackBackend {
  time = 0;
  scheduled = 0;
  stops = 0;
  volumeAt: number[] = [];
  liveVolume: number[] = [];
  currentTime(): number {
    return this.time;
  }
  schedule(_samples: Float32Array, _startAt: number): ScheduledHandle {
    this.scheduled += 1;
    return { stop: () => undefined };
  }
  setVolumeAt(volume: number): void {
    this.volumeAt.push(volume);
  }
  setVolumeNow(volume: number): void {
    this.liveVolume.push(volume);
  }
  stopAll(): void {
    this.stops += 1;
  }
  currentVolume(): number {
    return this.volumeAt[this.volumeAt.length - 1] ?? 1;
  }
}

interface Harness {
  surface: VoiceLiveSurface;
  frames: VoiceClientMessage[];
  captureOptions: StartCaptureSessionOptions[];
  activity: Array<(report: CaptureActivityReport) => void>;
  backend: FakePlaybackBackend;
  arbiter: ReturnType<typeof createSpeechArbiter>;
  /** Live counters (a primitive returned by value would go stale). */
  counters: { captureStops: number; mediaRequests: number };
}

function makeSurface(options: { failMic?: boolean; captureFault?: boolean } = {}): Harness {
  const frames: VoiceClientMessage[] = [];
  const captureOptions: StartCaptureSessionOptions[] = [];
  const activity: Array<(report: CaptureActivityReport) => void> = [];
  const backend = new FakePlaybackBackend();
  const arbiter = createSpeechArbiter();
  const counters = { captureStops: 0, mediaRequests: 0 };

  const fakeContext = {
    state: 'running',
    currentTime: 0,
    audioWorklet: { addModule: async () => undefined },
    destination: {} as AudioNode,
    createGain: () => ({ gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, value0: 1 }, connect() {}, disconnect() {} }),
    createOscillator: () => ({ type: 'sine', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }),
    createBuffer: () => ({ getChannelData: () => new Float32Array(1) }),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {}, stop() {}, disconnect() {} }),
    resume: async () => undefined,
    close: async () => undefined,
  } as unknown as AudioContext;

  const factories: VoiceLiveSurfaceFactories = {
    createAudioContext: () => fakeContext,
    createPlaybackBackend: () => backend,
    getUserMedia: async () => {
      counters.mediaRequests += 1;
      if (options.failMic) throw new Error('NotAllowedError: microphone denied');
      return { getAudioTracks: () => [{ stop() {} }] } as unknown as MediaStream;
    },
    startCaptureSession: async (opts) => {
      captureOptions.push(opts);
      activity.push(opts.onActivity ?? (() => {}));
      const session: CaptureSession = {
        inputRate: 48_000,
        stop: async () => {
          counters.captureStops += 1;
        },
        flush: () => undefined,
        stats: () => ({
          framesProduced: 0,
          chunksSent: 0,
          chunksDropped: 0,
          speaking: false,
          pendingChunks: 0,
        }),
      };
      return session;
    },
  };

  const surface = new VoiceLiveSurface({
    lane: LANE,
    send: (frame) => void frames.push(frame),
    arbiter,
    factories,
  });
  return { surface, frames, captureOptions, activity, backend, arbiter, counters };
}

describe('VoiceLiveSurface — capture lifecycle is honest', () => {
  it('starts capture, streams chunks out as voice_audio_chunk frames, and reports live', async () => {
    const harness = makeSurface();
    expect(await harness.surface.startCapture()).toBe('live');
    expect(harness.surface.getState().capture).toBe('live');
    expect(harness.counters.mediaRequests).toBe(1);

    const sink = harness.captureOptions[0].sink;
    const chunk: CaptureChunk = {
      seq: 0,
      mimeType: 'audio/pcm;rate=16000',
      data: pcm16Base64(new Int16Array(320)),
      durationMs: 20,
      capturedAtMs: 1,
    };
    sink(chunk);
    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0].type).toBe('voice_audio_chunk');
  });

  it('reports an error and keeps going when the microphone is refused (fallback stays reachable)', async () => {
    const harness = makeSurface({ failMic: true });
    expect(await harness.surface.startCapture()).toBe('error');
    const state = harness.surface.getState();
    expect(state.capture).toBe('error');
    expect(state.captureDetail).toContain('microphone denied');
    expect(state.controller.wireState).not.toBe('live');
  });

  it('suspends capture only on an explicit stop, and says so', async () => {
    const harness = makeSurface();
    await harness.surface.startCapture();
    await harness.surface.stopCapture('lane stopped');
    expect(harness.counters.captureStops).toBe(1);
    const state = harness.surface.getState();
    expect(state.capture).toBe('suspended');
    expect(state.captureDetail).toBe('lane stopped');
  });

  it('push-to-talk starts capture with silence sending and flushes on release', async () => {
    const harness = makeSurface();
    expect(await harness.surface.beginPushToTalk()).toBe('live');
    expect(harness.captureOptions[0].sendSilence).toBe(true);
    await harness.surface.endPushToTalk();
    expect(harness.counters.captureStops).toBe(1);
    expect(harness.surface.getState().capture).toBe('suspended');
  });
});

describe('VoiceLiveSurface — the VAD reaches the floor and the wire, never capture', () => {
  it('ducks the arbiter on speech_start and reports the boundary on the wire', async () => {
    const harness = makeSurface();
    await harness.surface.startCapture();
    const onActivity = harness.activity[0];

    onActivity({ state: 'speech_start', atMs: 100 });
    // The arbiter holds the floor. (`ducked` is only true while something is
    // actually playing; the PCM playback path's ducking is pinned separately.)
    expect(harness.arbiter.isOperatorSpeaking()).toBe(true);
    expect(harness.arbiter.getState().operatorSpeaking).toBe(true);
    expect(harness.frames.map((frame) => frame.type)).toEqual(['voice_activity_state']);
    // Capture is untouched by the duck.
    expect(harness.surface.getState().capture).toBe('live');
    expect(harness.counters.captureStops).toBe(0);

    onActivity({ state: 'speech_end', atMs: 900 });
    expect(harness.arbiter.isOperatorSpeaking()).toBe(false);
    expect(harness.surface.getState().capture).toBe('live');
  });
});

describe('VoiceLiveSurface — inbound audio and the chime', () => {
  it('routes an accepted 24 kHz chunk into playback and applies the controller state', async () => {
    const harness = makeSurface();
    const message: VoiceAudioOutputChunkMessage = env('voice_audio_chunk', {
      seq: 0,
      mimeType: 'audio/pcm;rate=24000',
      data: pcm16Base64(new Int16Array(480).fill(4000)),
      durationMs: 20,
      atMs: 1,
      state: undefined,
    }) as unknown as VoiceAudioOutputChunkMessage;
    expect(harness.surface.onWireMessage(message)).toBe('applied');
    expect(harness.backend.scheduled).toBe(1);
    expect(harness.surface.getState().playback?.chunksScheduled).toBe(1);
  });

  it('plays the trusted chime on a delivered receipt only', () => {
    const harness = makeSurface();
    expect(harness.surface.onWireMessage(receipt('delivered'))).toBe('applied');
    expect(harness.surface.getState().lastChime).toBe('delivered');
  });

  it('plays the distinct non-delivery tone for queued/refused/unknown', () => {
    for (const outcome of ['queued', 'refused', 'unknown'] as const) {
      const harness = makeSurface();
      harness.surface.onWireMessage(receipt(outcome));
      expect(harness.surface.getState().lastChime).toBe(outcome);
    }
  });

  it('plays nothing at all for proposal_resolved released', () => {
    const harness = makeSurface();
    harness.surface.onWireMessage(
      env('proposal_resolved', { proposalId: 'p', outcome: 'released', releaseId: 'rel-1' }),
    );
    expect(harness.surface.getState().lastChime).toBeNull();
  });

  it('refuses a foreign frame without touching playback', () => {
    const harness = makeSurface();
    const foreign = { ...(env('voice_state', { state: 'live' }) as object), laneId: 'other:lane' };
    expect(harness.surface.onWireMessage(foreign)).toBe('refused');
    expect(harness.backend.scheduled).toBe(0);
  });
});

describe('VoiceLiveSurface — teardown', () => {
  it('stops capture, releases the floor and closes the graph', async () => {
    const harness = makeSurface();
    await harness.surface.startCapture();
    await harness.surface.dispose();
    expect(harness.counters.captureStops).toBe(1);
    expect(harness.arbiter.isOperatorSpeaking()).toBe(false);
    expect(harness.surface.getState().capture).toBe('suspended');
  });

  it('an explicit playback stop never stops capture', async () => {
    const harness = makeSurface();
    await harness.surface.startCapture();
    harness.surface.stopPlayback();
    expect(harness.backend.stops).toBe(1);
    expect(harness.counters.captureStops).toBe(0);
    expect(harness.surface.getState().capture).toBe('live');
  });
});
