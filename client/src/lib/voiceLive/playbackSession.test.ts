import { describe, expect, it } from 'vitest';
import {
  VOICE_AUDIO_OUTPUT_MIME,
  VOICE_WIRE_VERSION,
  type VoiceAudioOutputChunkMessage,
} from '@pi-web-ui/shared';
import { VOICE_PLAYBACK_MAX_QUEUED_MS, VOICE_PLAYBACK_RATE } from './audioConstants';
import { pcm16Base64 } from './messages';
import {
  PlaybackPipeline,
  type PlaybackBackend,
  type PlaybackFault,
  type ScheduledHandle,
} from './playbackSession';
import { DUCKED_VOLUME, NORMAL_VOLUME, type SpeechFloorSource, type SpeechTierState } from './speechFloor';
import { createSpeechArbiter } from '../speechArbiter';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeFloor implements SpeechFloorSource {
  private state: SpeechTierState = { operatorSpeaking: false, ducked: false, playing: false, paused: false };
  private listeners = new Set<() => void>();

  set(speaking: boolean): void {
    this.state = { ...this.state, operatorSpeaking: speaking, ducked: speaking };
    for (const fn of this.listeners) fn();
  }

  getState(): SpeechTierState {
    return { ...this.state };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

interface ScheduleCall {
  startAt: number;
  frames: number;
  stopped: boolean;
}

class FakeBackend implements PlaybackBackend {
  time = 0;
  schedules: ScheduleCall[] = [];
  volumeAt: Array<{ volume: number; at: number }> = [];
  liveVolume: Array<{ volume: number; ramp: number }> = [];
  stops = 0;
  volume = NORMAL_VOLUME;

  currentTime(): number {
    return this.time;
  }

  schedule(samples: Float32Array, startAt: number): ScheduledHandle {
    const call: ScheduleCall = { startAt, frames: samples.length, stopped: false };
    this.schedules.push(call);
    return {
      stop: () => {
        call.stopped = true;
      },
    };
  }

  setVolumeAt(volume: number, atTime: number): void {
    this.volume = volume;
    this.volumeAt.push({ volume, at: atTime });
  }

  setVolumeNow(volume: number, rampSeconds = 0.01): void {
    this.volume = volume;
    this.liveVolume.push({ volume, ramp: rampSeconds });
  }

  stopAll(): void {
    this.stops += 1;
  }

  currentVolume(): number {
    return this.volume;
  }
}

function outputChunk(seq: number, frames = 480, level = 0.4): VoiceAudioOutputChunkMessage {
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) samples[i] = level > 0 ? 8000 : 0;
  return {
    type: 'voice_audio_chunk',
    version: VOICE_WIRE_VERSION,
    laneId: 'worker:p',
    attachmentGeneration: 0,
    seq,
    mimeType: VOICE_AUDIO_OUTPUT_MIME,
    data: pcm16Base64(samples),
    durationMs: (frames / VOICE_PLAYBACK_RATE) * 1000,
    atMs: 0,
  };
}

function makePipeline() {
  const backend = new FakeBackend();
  const floor = new FakeFloor();
  const faults: PlaybackFault[] = [];
  const pipeline = new PlaybackPipeline({
    backend,
    floor,
    onFault: (fault) => faults.push(fault),
    leadSeconds: 0.02,
  });
  let clock = 0;
  return {
    backend,
    floor,
    faults,
    pipeline,
    advance(seconds: number) {
      clock += seconds;
      backend.time = clock;
    },
  };
}

// ── One-ahead scheduling ────────────────────────────────────────────────────

describe('PlaybackPipeline — one-ahead scheduling (no eaten first words)', () => {
  it('starts the first chunk immediately and books the rest contiguously', () => {
    const { backend, pipeline } = makePipeline();
    backend.time = 10;
    expect(pipeline.pushChunk(outputChunk(0))).toBe('scheduled');
    expect(pipeline.pushChunk(outputChunk(1))).toBe('scheduled');
    expect(pipeline.pushChunk(outputChunk(2))).toBe('scheduled');

    expect(backend.schedules).toHaveLength(3);
    const [first, second, third] = backend.schedules;
    // First chunk: now + lead (never in the past).
    expect(first.startAt).toBeCloseTo(10.02, 6);
    // Each later chunk begins exactly where the previous one ends: contiguous,
    // no overlap (which would clip) and no gap (which would swallow the start).
    const duration = 480 / VOICE_PLAYBACK_RATE;
    expect(second.startAt).toBeCloseTo(first.startAt + duration, 9);
    expect(third.startAt).toBeCloseTo(second.startAt + duration, 9);
  });

  it('does not restart from "now" while audio is still queued (the classic clipping bug)', () => {
    const { backend, pipeline, advance } = makePipeline();
    backend.time = 0;
    pipeline.pushChunk(outputChunk(0));
    // The graph runs slower than chunks arrive, so the queue is ahead of now.
    advance(0.005);
    pipeline.pushChunk(outputChunk(1));
    advance(0.005);
    pipeline.pushChunk(outputChunk(2));
    const starts = backend.schedules.map((call) => call.startAt);
    expect(starts[1]).toBeGreaterThan(backend.time);
    expect(starts[2]).toBeGreaterThan(starts[1]);
    expect(new Set(starts).size).toBe(3);
  });

  it('starts the next chunk at the lead time when the queue has run dry', () => {
    const { backend, pipeline, advance } = makePipeline();
    pipeline.pushChunk(outputChunk(0));
    advance(5); // everything that was booked has finished
    pipeline.pushChunk(outputChunk(1));
    expect(backend.schedules[1].startAt).toBeCloseTo(5.02, 6);
  });
});

// ── Ducking ─────────────────────────────────────────────────────────────────

describe('PlaybackPipeline — duck, never stop (N5)', () => {
  it('ducks the in-flight audio when the operator takes the floor, without stopping it', () => {
    const { backend, floor, pipeline } = makePipeline();
    pipeline.pushChunk(outputChunk(0));
    const scheduledBefore = backend.schedules.length;

    floor.set(true);
    expect(backend.liveVolume).toEqual([{ volume: DUCKED_VOLUME, ramp: 0.01 }]);
    expect(DUCKED_VOLUME).toBeCloseTo(0.15, 6);
    // Nothing was stopped or re-scheduled: the duck replaced the stop.
    expect(backend.stops).toBe(0);
    expect(backend.schedules).toHaveLength(scheduledBefore);
    expect(backend.schedules.every((call) => !call.stopped)).toBe(true);
  });

  it('restores volume at the next chunk boundary, not mid-word', () => {
    const { backend, floor, pipeline } = makePipeline();
    backend.time = 1;
    pipeline.pushChunk(outputChunk(0));
    floor.set(true);
    backend.volumeAt.length = 0; // ignore the first chunk's boundary automation
    floor.set(false);
    // Releasing the floor does NOT ramp the live gain back up...
    expect(backend.liveVolume).toEqual([{ volume: DUCKED_VOLUME, ramp: 0.01 }]);

    // ...the NEXT chunk's boundary carries the normal volume.
    pipeline.pushChunk(outputChunk(1));
    expect(backend.volumeAt).toEqual([
      { volume: NORMAL_VOLUME, at: backend.schedules[1].startAt },
    ]);
  });

  it('schedules a chunk arriving while the operator speaks at the ducked volume', () => {
    const { backend, floor, pipeline } = makePipeline();
    floor.set(true);
    pipeline.pushChunk(outputChunk(0));
    expect(backend.volumeAt[0].volume).toBe(DUCKED_VOLUME);
    expect(backend.stops).toBe(0);
  });

  it('has no API that stops playback because the operator spoke', () => {
    const { backend, floor, pipeline } = makePipeline();
    pipeline.pushChunk(outputChunk(0));
    floor.set(true);
    floor.set(false);
    floor.set(true);
    expect(backend.stops).toBe(0);
    // Explicit stop is a separate, operator-owned action.
    pipeline.stop();
    expect(backend.stops).toBe(1);
  });

  it('reads the real arbiter as the floor (one definition of ducking)', () => {
    const arbiter = createSpeechArbiter();
    const backend = new FakeBackend();
    const pipeline = new PlaybackPipeline({
      backend,
      floor: {
        getState: () => arbiter.getState(),
        subscribe: (fn) => arbiter.subscribe(fn),
      },
    });
    pipeline.pushChunk(outputChunk(0));
    arbiter.setOperatorSpeaking(true);
    expect(backend.liveVolume).toContainEqual({ volume: DUCKED_VOLUME, ramp: 0.01 });
  });
});

// ── Faults, bounds, corruption ──────────────────────────────────────────────

describe('PlaybackPipeline — bounded queue and surfaced faults', () => {
  it('bounds the queued audio and drops the OLDEST unplayed chunk (newest survives)', () => {
    const { backend, pipeline, faults } = makePipeline();
    // 50 ms per chunk (1200 frames). A burst arrives while the clock is frozen,
    // which is the only way a backlog can build at all.
    const perChunk = 1_200;
    const chunkMs = (perChunk / VOICE_PLAYBACK_RATE) * 1000; // 50 ms
    const count = 100;
    for (let seq = 0; seq < count; seq += 1) pipeline.pushChunk(outputChunk(seq, perChunk));

    const overflow = faults.filter((fault) => fault.reason === 'playback_overflow');
    expect(overflow).toHaveLength(1);
    expect(overflow[0].droppedChunks).toBeGreaterThan(0);
    expect(pipeline.stats().chunksDropped).toBeGreaterThan(0);

    // The SCHEDULED horizon is hard-capped, so latency cannot run away.
    const stats = pipeline.stats();
    expect(stats.queuedMs).toBeLessThanOrEqual(VOICE_PLAYBACK_MAX_QUEUED_MS + chunkMs);
    expect(stats.chunksScheduled).toBeLessThanOrEqual(
      Math.ceil(VOICE_PLAYBACK_MAX_QUEUED_MS / chunkMs) + 1,
    );
    // The backlog is bounded too, and the NEWEST chunk is still pending (it was
    // not the one dropped); the oldest pending chunks are gone.
    expect(stats.pendingChunks).toBeLessThanOrEqual(50);
    expect(stats.pendingSeqs).toContain(count - 1);
    // The first pending chunk was dropped: the retained backlog starts after it.
    expect(stats.pendingSeqs).not.toContain(stats.chunksScheduled);
    expect(stats.pendingSeqs[0]).toBe(stats.chunksScheduled + stats.chunksDropped);
    expect(backend.stops).toBe(0);
  });

  it('never drops a chunk when the stream arrives in real time', () => {
    const { backend, pipeline, advance, faults } = makePipeline();
    for (let seq = 0; seq < 30; seq += 1) {
      // Each chunk arrives just before the previous one finishes playing.
      advance(0.048);
      pipeline.pushChunk(outputChunk(seq, 1200));
    }
    expect(faults.filter((fault) => fault.reason === 'playback_overflow')).toHaveLength(0);
    expect(pipeline.stats().chunksDropped).toBe(0);
    // Still contiguous, one ahead of the clock.
    for (let i = 1; i < backend.schedules.length; i += 1) {
      expect(backend.schedules[i].startAt).toBeCloseTo(backend.schedules[i - 1].startAt + 0.05, 9);
    }
  });

  it('drops a corrupt chunk and surfaces it rather than throwing', () => {
    const { pipeline, faults } = makePipeline();
    const corrupt = { ...outputChunk(0), data: '!!!!' };
    expect(pipeline.pushChunk(corrupt)).toBe('dropped');
    expect(faults).toEqual([
      { reason: 'playback_chunk_corrupt', detail: expect.stringContaining('voice_audio_chunk') },
    ]);
  });

  it('refuses a chunk above the contract ceiling', () => {
    const { pipeline, faults } = makePipeline();
    const tooMany = new Int16Array(VOICE_PLAYBACK_RATE); // 1 s ≫ 100 ms ceiling
    const oversize = { ...outputChunk(0), data: pcm16Base64(tooMany) };
    expect(pipeline.pushChunk(oversize)).toBe('dropped');
    expect(faults[0].reason).toBe('playback_chunk_corrupt');
  });

  it('surfaces a seq gap once and keeps playing in arrival order', () => {
    const { pipeline, faults } = makePipeline();
    pipeline.pushChunk(outputChunk(0));
    pipeline.pushChunk(outputChunk(1));
    pipeline.pushChunk(outputChunk(4));
    expect(faults.filter((fault) => fault.reason === 'playback_seq_gap')).toHaveLength(1);
    expect(pipeline.stats().chunksScheduled).toBe(3);
  });

  it('stop() clears the queue and resets sequencing', () => {
    const { backend, pipeline } = makePipeline();
    pipeline.pushChunk(outputChunk(0));
    pipeline.stop();
    expect(backend.stops).toBe(1);
    expect(pipeline.stats().queuedMs).toBe(0);
  });
});
