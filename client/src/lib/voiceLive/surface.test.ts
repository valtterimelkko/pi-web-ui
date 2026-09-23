import { describe, expect, it } from 'vitest';
import {
  VOICE_WIRE_VERSION,
  type VoiceAudioOutputChunkMessage,
  type VoiceClientMessage,
  type VoiceReceiptEventMessage,
} from '@pi-web-ui/shared';
import { createSpeechArbiter } from '../speechArbiter';
import type { PlaybackHealthReport } from '../clientDiagnosticsReporter';
import { loadCaptureWorklet } from './captureSession';
import { VoiceLiveSurface, type VoiceLiveSurfaceFactories } from './surface';
import { createVoiceLane, pcm16Base64 } from './messages';
import type { ReadBackSpeech, ReadBackSpeaker } from './readBack';
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
  speaker: FakeReadBackSpeaker;
  /** Playback-health reports the surface uploaded (the P13 gap fill). */
  playbackHealth: PlaybackHealthReport[];
  /** Live counters (a primitive returned by value would go stale). */
  counters: { captureStops: number; mediaRequests: number };
}

/**
 * A read-back speaker whose playback only ends when the test says so — which is
 * exactly what makes the H3 property testable: nothing may be reported between
 * `speak()` and the host's own end event.
 */
class FakeReadBackSpeaker implements ReadBackSpeaker {
  readonly supported: boolean;
  readonly spoken: string[] = [];
  cancellations = 0;
  private pending: ReadBackSpeech | null = null;

  constructor(supported = true) {
    this.supported = supported;
  }

  speak(speech: ReadBackSpeech): boolean {
    if (!this.supported) return false;
    this.spoken.push(speech.text);
    this.pending = speech;
    return true;
  }

  cancel(): void {
    this.cancellations += 1;
    this.pending = null;
  }

  boundary(charIndex: number): void {
    this.pending?.onBoundary?.(charIndex);
  }

  /** Playback reached the end of the utterance. */
  finish(): void {
    const speech = this.pending;
    this.pending = null;
    speech?.onEnd();
  }

  /** Playback was stopped or failed. */
  interrupt(reason = 'interrupted'): void {
    const speech = this.pending;
    this.pending = null;
    speech?.onError(reason);
  }

  get reading(): boolean {
    return this.pending !== null;
  }
}

function makeSurface(options: { failMic?: boolean; failWorklet?: boolean; captureFault?: boolean; readBack?: ReadBackSpeaker; laneProbeTimeoutMs?: number } = {}): Harness {
  const frames: VoiceClientMessage[] = [];
  const captureOptions: StartCaptureSessionOptions[] = [];
  const activity: Array<(report: CaptureActivityReport) => void> = [];
  const backend = new FakePlaybackBackend();
  const arbiter = createSpeechArbiter();
  const counters = { captureStops: 0, mediaRequests: 0 };
  const speaker = new FakeReadBackSpeaker();
  const playbackHealth: PlaybackHealthReport[] = [];

  const fakeContext = {
    state: 'running',
    currentTime: 0,
    audioWorklet: {
      addModule: async (url: string) => {
        if (options.failWorklet) throw new Error(`Failed to load module script: ${url}`);
      },
    },
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
    createReadBackSpeaker: () => options.readBack ?? speaker,
    reportPlaybackHealth: (report) => {
      playbackHealth.push(report);
    },
    ...(options.laneProbeTimeoutMs !== undefined ? { laneProbeTimeoutMs: options.laneProbeTimeoutMs } : {}),
    getUserMedia: async () => {
      counters.mediaRequests += 1;
      if (options.failMic) throw new Error('NotAllowedError: microphone denied');
      return { getAudioTracks: () => [{ stop() {} }] } as unknown as MediaStream;
    },
    startCaptureSession: async (opts) => {
      captureOptions.push(opts);
      // Faithful to production: the worklet is really loaded (same-origin asset
      // first) before a session exists, so a worklet failure is the same failure.
      await loadCaptureWorklet(opts.context, {
        ...(opts.onFault ? { onFault: opts.onFault } : {}),
        ...(opts.workletUrls ? { workletUrls: opts.workletUrls } : {}),
      });
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
  return { surface, frames, captureOptions, activity, backend, arbiter, speaker, playbackHealth, counters };
}

/** A live proposal that has NOT been read back yet (the H3 starting point). */
function proposalFrame(overrides: Record<string, unknown> = {}): unknown {
  return env('proposal_created', {
    proposal: {
      proposalId: 'prop-1',
      version: 3,
      sha256: 'a'.repeat(64),
      promotionRoute: 'directed',
      original: 'ask it whether the retry handler drops the token',
      tidied: 'ask whether the retry handler drops the token',
      presentedVariant: 'tidied',
      presentation: { completed: false },
      ...overrides,
    },
  });
}

function presentationFrames(frames: VoiceClientMessage[]): Array<Record<string, unknown>> {
  return frames.filter((frame) => frame.type === 'proposal_presentation') as unknown as Array<
    Record<string, unknown>
  >;
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

  it('names the worklet as the cause when the worklet will not load', async () => {
    const harness = makeSurface({ failWorklet: true });
    const result = await harness.surface.startCapture();
    expect(result).toBe('error');
    expect(harness.surface.getState().captureFaultReason).toBe('worklet_unavailable');
    expect(harness.surface.getState().captureFaults.at(-1)?.reason).toBe('worklet_unavailable');

    // …and the SERVER is told, on the activity frame, so the reason is not
    // confined to this browser (the gap the field failure exposed).
    type ActivityFrame = Extract<VoiceClientMessage, { type: 'voice_activity_state' }>;
    const faultFrame = harness.frames.filter(
      (frame): frame is ActivityFrame => frame.type === 'voice_activity_state' && 'captureFault' in frame,
    );
    expect(faultFrame).toHaveLength(1);
    expect(faultFrame[0].captureFault?.reason).toBe('worklet_unavailable');
    // The boundary carried is the TRUE local state, not a fabricated one.
    expect(faultFrame[0].state).toBe('speech_end');
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

/**
 * P13 gap fill — the playback half of "why didn't I hear it?".
 *
 * The surface already kept playback faults and playback stats in memory, and
 * that is exactly where they died: nothing about the shape of the audio left
 * the page, so a lane that accepted audio and never played it was invisible
 * from the server. These tests pin the upload: a fault leaves immediately, and
 * the lane-end summary carries the stranded figure measured BEFORE the queue is
 * cleared (after `stop()` there is nothing left to measure).
 */
describe('VoiceLiveSurface — playback health leaves the page (P13 gap fill)', () => {
  function audioChunk(seq: number, ms = 100) {
    const samples = new Int16Array((24_000 * ms) / 1000).fill(4000);
    return env('voice_audio_chunk', {
      seq,
      mimeType: 'audio/pcm;rate=24000',
      data: pcm16Base64(samples),
      durationMs: ms,
      atMs: 1,
      state: undefined,
    }) as unknown as VoiceAudioOutputChunkMessage;
  }

  it('reports a playback fault immediately, with the stats at the moment it happened', () => {
    const harness = makeSurface();
    harness.surface.onWireMessage(audioChunk(0));
    harness.surface.onWireMessage(audioChunk(2)); // seq 1 never arrived
    expect(harness.playbackHealth).toHaveLength(1);
    const report = harness.playbackHealth[0];
    expect(report.reason).toBe('playback_seq_gap');
    expect(report.detail).toContain('expected seq 1');
    expect(report.stats.chunksScheduled).toBeGreaterThan(0);
    // The record joins the lane's server-side story by worker session.
    expect(report.workerSessionId).toBe('worker-1');
  });

  it('reports a corrupt chunk as a fault too (the client is not the only listener)', () => {
    const harness = makeSurface();
    harness.surface.onWireMessage(
      env('voice_audio_chunk', { seq: 0, mimeType: 'audio/ogg', data: 'not-base64-at-all', durationMs: 20, atMs: 1 }) as unknown as VoiceAudioOutputChunkMessage,
    );
    expect(harness.playbackHealth.map((r) => r.reason)).toContain('playback_chunk_corrupt');
  });

  it('reports the lane-end summary with the stranded audio measured BEFORE the queue is cleared', () => {
    const harness = makeSurface();
    // 26 x 100 ms = 2.6 s of speech; the horizon holds ~2 s, so ~0.6 s stays pending.
    for (let seq = 0; seq < 26; seq++) harness.surface.onWireMessage(audioChunk(seq));
    harness.surface.stopPlayback();
    const laneEnd = harness.playbackHealth.find((r) => r.reason === 'lane_end');
    expect(laneEnd).toBeDefined();
    expect(laneEnd?.stats.pendingChunks).toBeGreaterThan(0);
    expect(laneEnd?.stats.pendingMs).toBeGreaterThan(0);
    // And it is genuinely pre-reset: after stop() the pipeline reports 0 pending.
    expect(harness.surface.getState().playback?.pendingChunks).toBe(0);
  });

  it('does not double-report the same lane-end snapshot on dispose after an explicit stop', async () => {
    const harness = makeSurface();
    for (let seq = 0; seq < 26; seq++) harness.surface.onWireMessage(audioChunk(seq));
    harness.surface.stopPlayback();
    await harness.surface.dispose();
    expect(harness.playbackHealth.filter((r) => r.reason === 'lane_end')).toHaveLength(1);
  });

  it('reports a lane-end summary on dispose when the lane never got an explicit stop', async () => {
    const harness = makeSurface();
    for (let seq = 0; seq < 26; seq++) harness.surface.onWireMessage(audioChunk(seq));
    await harness.surface.dispose();
    const laneEnds = harness.playbackHealth.filter((r) => r.reason === 'lane_end');
    expect(laneEnds).toHaveLength(1);
    expect(laneEnds[0].stats.pendingMs).toBeGreaterThan(0);
  });

  it('says nothing about a lane that never received audio', async () => {
    const harness = makeSurface();
    await harness.surface.dispose();
    expect(harness.playbackHealth).toHaveLength(0);
  });
});

describe('VoiceLiveSurface — presentation is reported only after the read-back (H3)', () => {
  it('speaks the retained bytes, reports nothing on start, and reports completion only at the end', async () => {
    const harness = makeSurface();
    harness.surface.onWireMessage(proposalFrame());
    expect(harness.surface.getState().controller.proposal?.proposal.proposalId).toBe('prop-1');
    // Nothing is presented yet: the proposal announced completed: false.
    expect(harness.surface.controller.presentationStatus()).toBe('pending');

    const done = harness.surface.readBackProposal('tidied');
    // Playback started with the exact release bytes...
    expect(harness.speaker.spoken).toEqual(['ask whether the retry handler drops the token']);
    expect(harness.surface.getState().readBack.state).toBe('reading');
    // ...and the wire has heard NOTHING: a start is not a presentation.
    expect(presentationFrames(harness.frames)).toHaveLength(0);
    expect(harness.surface.controller.presentationStatus()).toBe('pending');

    harness.speaker.finish();
    expect(await done).toBe('completed');
    const reported = presentationFrames(harness.frames);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      type: 'proposal_presentation',
      proposalId: 'prop-1',
      presentedVariant: 'tidied',
      completed: true,
    });
    expect(harness.surface.controller.presentationStatus()).toBe('presented');
    expect(harness.surface.getState().readBack.state).toBe('completed');
  });

  it('an interrupted read-back reports the narrowing outcome with where it stopped', async () => {
    const harness = makeSurface();
    harness.surface.onWireMessage(proposalFrame());
    const done = harness.surface.readBackProposal();
    harness.speaker.boundary(12);
    // Mid-playback: still nothing on the wire.
    expect(presentationFrames(harness.frames)).toHaveLength(0);
    harness.speaker.interrupt('interrupted');

    expect(await done).toBe('interrupted');
    const reported = presentationFrames(harness.frames);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ completed: false, stoppedAtChar: 12 });
    expect(harness.surface.controller.presentationStatus()).toBe('pending');
    expect(harness.surface.getState().readBack.state).toBe('interrupted');
  });

  it('reads back whichever retained variant the operator is looking at, verbatim', async () => {
    const harness = makeSurface();
    harness.surface.onWireMessage(proposalFrame());
    const done = harness.surface.readBackProposal('original');
    expect(harness.speaker.spoken).toEqual(['ask it whether the retry handler drops the token']);
    harness.speaker.finish();
    await done;
    expect(presentationFrames(harness.frames)[0]).toMatchObject({
      presentedVariant: 'original',
      completed: true,
    });
  });

  it('has nothing to read back when there is no live proposal', async () => {
    const harness = makeSurface();
    expect(await harness.surface.readBackProposal()).toBe('no-proposal');
    expect(harness.speaker.spoken).toHaveLength(0);
    expect(presentationFrames(harness.frames)).toHaveLength(0);
  });

  it('says the host cannot read back rather than fabricating a completion', async () => {
    const harness = makeSurface({ readBack: new FakeReadBackSpeaker(false) });
    harness.surface.onWireMessage(proposalFrame());
    expect(await harness.surface.readBackProposal()).toBe('unsupported');
    expect(harness.surface.getState().readBack.state).toBe('unsupported');
    expect(harness.surface.getState().readBack.supported).toBe(false);
    expect(presentationFrames(harness.frames)).toHaveLength(0);
    expect(harness.surface.controller.presentationStatus()).toBe('pending');
  });

  it('drops a read-back in flight when a newer proposal replaces the one being read', async () => {
    const harness = makeSurface();
    harness.surface.onWireMessage(proposalFrame());
    const done = harness.surface.readBackProposal();
    harness.surface.onWireMessage(
      proposalFrame({ proposalId: 'prop-2', version: 4, sha256: 'b'.repeat(64) }),
    );
    expect(await done).toBe('interrupted');
    expect(harness.speaker.cancellations).toBeGreaterThan(0);
    expect(harness.surface.getState().readBack.state).toBe('idle');
    // A replaced proposal is never reported as presented.
    expect(presentationFrames(harness.frames)).toHaveLength(0);
  });

  it('cancels the read-back on teardown', async () => {
    const harness = makeSurface();
    harness.surface.onWireMessage(proposalFrame());
    const done = harness.surface.readBackProposal();
    await harness.surface.dispose();
    expect(await done).toBe('interrupted');
    expect(harness.speaker.cancellations).toBeGreaterThan(0);
  });
});

describe('VoiceLiveSurface — the host reads a fresh proposal back by itself (H2)', () => {
  it('auto-reads the tidied bytes the moment a proposal is created on the addressed surface', async () => {
    const harness = makeSurface();
    harness.surface.setAutoReadBackActive(true);
    harness.surface.onWireMessage(proposalFrame());
    // The HOST speaks the exact retained bytes — presentation no longer waits
    // for the model to volunteer a verbatim read-back (pass-1 C01/C03/C17/C19).
    expect(harness.speaker.spoken).toEqual(['ask whether the retry handler drops the token']);
    expect(harness.surface.getState().readBack.state).toBe('reading');
    // A start is not a presentation: the wire has heard nothing yet.
    expect(presentationFrames(harness.frames)).toHaveLength(0);
    expect(harness.surface.controller.presentationStatus()).toBe('pending');

    harness.speaker.finish();
    expect(harness.surface.getState().readBack.state).toBe('completed');
    const reported = presentationFrames(harness.frames);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      type: 'proposal_presentation',
      proposalId: 'prop-1',
      presentedVariant: 'tidied',
      completed: true,
    });
    expect(harness.surface.controller.presentationStatus()).toBe('presented');
  });

  it('never auto-reads on a surface the operator is not addressing (multi-lane safety)', () => {
    const harness = makeSurface();
    // Default: NOT the addressed surface — arming is the component's explicit act.
    harness.surface.onWireMessage(proposalFrame());
    expect(harness.speaker.spoken).toHaveLength(0);
    expect(harness.surface.getState().readBack.state).toBe('idle');
    expect(presentationFrames(harness.frames)).toHaveLength(0);
    expect(harness.surface.controller.presentationStatus()).toBe('pending');
  });

  it('is single-flight per proposal identity: a repeat announcement does not restart the read', () => {
    const harness = makeSurface();
    harness.surface.setAutoReadBackActive(true);
    harness.surface.onWireMessage(proposalFrame());
    expect(harness.speaker.spoken).toHaveLength(1);
    // The same proposal announced again must not cancel and restart the utterance.
    harness.surface.onWireMessage(proposalFrame());
    expect(harness.speaker.spoken).toHaveLength(1);
    expect(harness.speaker.cancellations).toBe(0);
    expect(harness.surface.getState().readBack.state).toBe('reading');
  });

  it('a newer proposal cancels the in-flight auto read-back and reads the new bytes instead', () => {
    const harness = makeSurface();
    harness.surface.setAutoReadBackActive(true);
    harness.surface.onWireMessage(proposalFrame());
    harness.surface.onWireMessage(
      proposalFrame({ proposalId: 'prop-2', version: 4, sha256: 'b'.repeat(64) }),
    );
    // The replaced read reported nothing; the CURRENT proposal's bytes are the
    // ones being spoken now.
    expect(harness.speaker.spoken).toEqual([
      'ask whether the retry handler drops the token',
      'ask whether the retry handler drops the token',
    ]);
    expect(harness.speaker.cancellations).toBeGreaterThan(0);
    expect(harness.surface.getState().readBack.proposalId).toBe('prop-2');
    expect(presentationFrames(harness.frames)).toHaveLength(0);
  });

  it('an unsupported host stays honestly incomplete: presentation is never faked', () => {
    const harness = makeSurface({ readBack: new FakeReadBackSpeaker(false) });
    harness.surface.setAutoReadBackActive(true);
    harness.surface.onWireMessage(proposalFrame());
    expect(harness.surface.getState().readBack.state).toBe('unsupported');
    expect(harness.surface.getState().readBack.supported).toBe(false);
    expect(presentationFrames(harness.frames)).toHaveLength(0);
    expect(harness.surface.controller.presentationStatus()).toBe('pending');
  });

  it('disarming (unmount, lane switch) stops the surface from auto-reading', () => {
    const harness = makeSurface();
    harness.surface.setAutoReadBackActive(true);
    harness.surface.setAutoReadBackActive(false);
    harness.surface.onWireMessage(proposalFrame());
    expect(harness.speaker.spoken).toHaveLength(0);
    expect(harness.surface.getState().readBack.state).toBe('idle');
  });
});

describe('VoiceLiveSurface — lane reachability is honest (M7)', () => {
  it('opens the lane on the wire, then reports live when the engine says so', () => {
    const harness = makeSurface();
    expect(harness.surface.getState().lane.state).toBe('unknown');
    expect(harness.surface.startLane()).toBe('started');
    expect(harness.frames[0].type).toBe('voice_session_start');
    expect(harness.surface.getState().lane.state).toBe('connecting');

    harness.surface.onWireMessage(env('voice_state', { state: 'live' }));
    expect(harness.surface.getState().lane.state).toBe('live');
  });

  it('does not re-open a lane that is already live (a capture pause is not a lane stop)', () => {
    const harness = makeSurface();
    harness.surface.startLane();
    harness.surface.onWireMessage(env('voice_state', { state: 'live' }));
    harness.surface.startLane();
    harness.surface.startLane();
    const starts = harness.frames.filter((frame) => frame.type === 'voice_session_start');
    expect(starts).toHaveLength(1);
    expect(harness.surface.getState().lane.state).toBe('live');
  });

  it('renders the server\u2019s own words when the live engine is disabled (cascade)', async () => {
    const harness = makeSurface();
    expect(harness.surface.startLane()).toBe('started');
    // Exactly the pair the cascade server sends: an error state, then a fatal
    // voice_error carrying the reason.
    harness.surface.onWireMessage(
      env('voice_state', { state: 'error', detail: 'live voice is disabled on this server (VOICE_MODE_ENGINE=cascade); the push-to-talk cascade is now serving this lane' }),
    );
    harness.surface.onWireMessage(
      env('voice_error', {
        code: 'voice_provider_unavailable',
        message: 'live voice is disabled on this server (VOICE_MODE_ENGINE=cascade); the push-to-talk cascade is now serving this lane',
        fatal: true,
      }),
    );
    const state = harness.surface.getState();
    expect(state.lane.state).toBe('unavailable');
    expect(state.lane.detail).toContain('VOICE_MODE_ENGINE=cascade');
    expect(state.controller.lastError?.fatal).toBe(true);
  });

  it('a lane start that is never answered becomes honestly unavailable, and stops capture', async () => {
    const harness = makeSurface({ laneProbeTimeoutMs: 15 });
    await harness.surface.startCapture();
    expect(harness.surface.getState().capture).toBe('live');
    harness.surface.startLane();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const state = harness.surface.getState();
    expect(state.lane.state).toBe('unavailable');
    expect(state.lane.detail).toContain('no answer from the voice engine');
    // A lane that cannot be served must not keep the microphone open.
    expect(state.capture).toBe('suspended');
  });

  it('a fatal lane error stops capture and a retry can open the lane again', async () => {
    const harness = makeSurface();
    harness.surface.startLane();
    await harness.surface.startCapture();
    harness.surface.onWireMessage(
      env('voice_error', { code: 'voice_internal_error', message: 'engine exploded', fatal: true }),
    );
    expect(harness.surface.getState().lane.state).toBe('unavailable');
    // Stopping capture is asynchronous (the session is released first).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.surface.getState().capture).toBe('suspended');

    harness.surface.retryLane();
    expect(harness.surface.getState().lane.state).toBe('connecting');
    const starts = harness.frames.filter((frame) => frame.type === 'voice_session_start');
    expect(starts.length).toBe(2);

    // A retry that succeeds must not keep reporting the stale failure.
    harness.surface.onWireMessage(env('voice_state', { state: 'live' }));
    expect(harness.surface.getState().lane.state).toBe('live');
    expect(harness.surface.getState().controller.lastError).toBeNull();
  });

  it('reports an unsupported host as unsupported without touching the wire', () => {
    const harness = makeSurface();
    // A host whose capture seam is absent cannot run the lane at all.
    const bare = new VoiceLiveSurface({
      lane: LANE,
      send: () => undefined,
      arbiter: createSpeechArbiter(),
      factories: {},
    });
    // jsdom has no getUserMedia: the honest answer is "unsupported", not a dead start.
    const previous = (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'mediaDevices');
    try {
      expect(bare.getState().lane.state).toBe('unsupported');
      expect(bare.getState().lane.detail).toContain('no microphone capture API');
      expect(bare.startLane()).toBe('unsupported');
    } finally {
      if (previous !== undefined) {
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: previous });
      }
    }
    expect(harness.surface.getState().lane.state).toBe('unknown');
  });
});

describe('VoiceLiveSurface — transport-level refusals reach the surface (M8)', () => {
  it('accepts and records a rate refusal that carried no lane envelope', () => {
    const harness = makeSurface();
    const refusal = {
      type: 'voice_error',
      version: VOICE_WIRE_VERSION,
      laneId: '',
      attachmentGeneration: 0,
      code: 'voice_internal_error',
      message: 'Voice frame rate exceeded; the frame was dropped.',
      fatal: false,
    };
    expect(harness.surface.onWireMessage(refusal)).toBe('transport-refusal');
    const state = harness.surface.getState();
    expect(state.controller.transportRefusals).toHaveLength(1);
    expect(state.controller.transportRefusals[0]).toMatchObject({
      code: 'voice_internal_error',
      fatal: false,
    });
    // It is NOT a lane refusal and NOT lane state: nothing was applied.
    expect(state.controller.refusals).toHaveLength(0);
    expect(state.controller.lastError).toBeNull();
  });

  it('still refuses a genuinely malformed frame', () => {
    const harness = makeSurface();
    expect(harness.surface.onWireMessage({ type: 'voice_error', version: VOICE_WIRE_VERSION })).toBe(
      'refused',
    );
    expect(harness.surface.getState().controller.transportRefusals).toHaveLength(0);
  });
});

// ── C24: the picker hands the lane to another worker ────────────────────────
//
// Drive Mode's session picker swaps a lane's worker in place and DISCARDS the
// lane's surface. The contract (§3.2 step 1) says the switch stops the lane's
// native session with reason `worker_switch` — the server resolves any live
// proposal (proposal_resolved `replaced`) and closes the provider session
// before the worker changes. The surface owns the wire session, so it owns
// that stop.

describe('VoiceLiveSurface — stopForWorkerSwitch (C24)', () => {
  it('sends voice_session_stop {worker_switch} for an open lane and reports stopped', async () => {
    const harness = makeSurface();
    harness.surface.startLane();
    await harness.surface.startCapture();
    // The server's ack makes the lane genuinely live (the state the picker
    // switches away from).
    harness.surface.onWireMessage(env('voice_state', { state: 'live' }));
    expect(harness.surface.getState().controller.wireState).toBe('live');

    const sent = harness.surface.stopForWorkerSwitch();

    expect(sent).toBe(true);
    const stop = harness.frames.find((frame) => frame.type === 'voice_session_stop') as
      | { type: string; reason: string; laneId: string; attachmentGeneration: number }
      | undefined;
    expect(stop).toBeDefined();
    expect(stop?.reason).toBe('worker_switch');
    expect(stop?.laneId).toBe(LANE.laneId);
    expect(stop?.attachmentGeneration).toBe(LANE.attachmentGeneration);
    expect(harness.surface.getState().controller.wireState).toBe('stopped');
  });

  it('is a no-op (false, no frame) when the lane was never opened', () => {
    const harness = makeSurface();
    expect(harness.surface.stopForWorkerSwitch()).toBe(false);
    expect(harness.frames).toHaveLength(0);
  });

  it('stops a suspended lane too — the provider session still exists server-side', () => {
    const harness = makeSurface();
    harness.surface.startLane();
    harness.surface.onWireMessage(env('voice_state', { state: 'suspended' }));
    expect(harness.surface.getState().controller.wireState).toBe('suspended');
    expect(harness.surface.stopForWorkerSwitch()).toBe(true);
    const stop = harness.frames.find((frame) => frame.type === 'voice_session_stop') as
      | { reason: string }
      | undefined;
    expect(stop?.reason).toBe('worker_switch');
  });
});
