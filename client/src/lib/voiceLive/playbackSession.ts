/**
 * voiceLive/playbackSession — 24 kHz model speech, scheduled one chunk ahead.
 *
 * The scheduling rule that matters (contract §5.2, "the no-eaten-first-words
 * property"): the FIRST chunk of an utterance starts essentially immediately,
 * and every later chunk is booked contiguously after the one before it. The
 * scheduler keeps `nextStartTime` — the exact moment the audio already booked
 * will run out — and starts the next chunk there or now, whichever is later.
 * Nothing is ever started from "now" when there is still queued audio, which is
 * what a naive `start()` per arrival gets wrong: it either clips the first
 * words (starting mid-buffer) or overlaps two chunks.
 *
 * DUCKING (N5): the pipeline has no idea capture exists. It reads the shared
 * speech floor (the arbiter's `operatorSpeaking`) and, while the operator holds
 * the floor, ramps the output gain to 15% — a duck, never a stop. The restore is
 * scheduled at the NEXT chunk boundary (the volume automation of the next
 * scheduled chunk), so a ducked chunk stays ducked to its end and no word
 * resumes mid-way. There is no method here that can stop audio because someone
 * started speaking: `stop()` is explicit-only, and the surface is the only
 * caller.
 */

import type { VoiceAudioOutputChunkMessage } from '@pi-web-ui/shared';
import {
  DUCKED_VOLUME,
  NORMAL_VOLUME,
  type SpeechFloorSource,
} from './speechFloor';
import {
  VOICE_PLAYBACK_MAX_PENDING_CHUNKS,
  VOICE_PLAYBACK_MAX_QUEUED_MS,
  VOICE_PLAYBACK_RATE,
} from './audioConstants';
import { decodeOutputChunk } from './messages';

/** A scheduled chunk's handle, so overflow can drop the oldest one. */
export interface ScheduledHandle {
  stop(): void;
}

/**
 * The audio graph the scheduler drives. Kept deliberately tiny so the
 * scheduling arithmetic (the part that is easy to get wrong) is unit-tested
 * against a recording fake, and the Playwright run exercises the real one.
 */
export interface PlaybackBackend {
  /** Monotonic backend clock in seconds (AudioContext.currentTime in prod). */
  currentTime(): number;
  /** Book `samples` (mono, 24 kHz) to start at the absolute time `startAt`. */
  schedule(samples: Float32Array, startAt: number): ScheduledHandle;
  /** Set the output gain at an absolute backend time (used at chunk boundaries). */
  setVolumeAt(volume: number, atTime: number): void;
  /** Duck/resume the audio that is playing right now (live barge-in duck). */
  setVolumeNow(volume: number, rampSeconds?: number): void;
  /** Explicit teardown only. */
  stopAll(): void;
  /** Diagnostics: the gain the backend is heading for. */
  currentVolume(): number;
}

export type PlaybackFaultReason =
  | 'playback_chunk_corrupt'
  | 'playback_seq_gap'
  | 'playback_overflow';

export interface PlaybackFault {
  reason: PlaybackFaultReason;
  detail: string;
  droppedChunks?: number;
}

export interface PlaybackPipelineOptions {
  backend: PlaybackBackend;
  floor: SpeechFloorSource;
  onFault?: (fault: PlaybackFault) => void;
  maxQueuedMs?: number;
  /** Bound on accepted-but-not-yet-booked chunks. */
  maxPendingChunks?: number;
  /** Lead time before the first chunk starts (lets the graph warm up). */
  leadSeconds?: number;
}

export interface PlaybackStats {
  chunksScheduled: number;
  chunksDropped: number;
  queuedMs: number;
  pendingChunks: number;
  /** Seq numbers of the chunks accepted but not yet booked (oldest first). */
  pendingSeqs: number[];
  ducked: boolean;
}

interface BookedChunk {
  handle: ScheduledHandle;
  startAt: number;
  endAt: number;
}

/**
 * One-ahead schedule, bounded queue, ducked gain.
 *
 * Overflow drops the OLDEST unplayed chunk and surfaces it: the bound is real
 * (memory and latency stay finite) and the fault is visible (N9). The current
 * utterance is never hard-stopped by a duck — only an explicit `stop()`.
 */
export class PlaybackPipeline {
  private readonly backend: PlaybackBackend;
  private readonly floor: SpeechFloorSource;
  private readonly onFault: (fault: PlaybackFault) => void;
  private readonly maxQueuedMs: number;
  private readonly leadSeconds: number;
  private readonly unsubscribe: () => void;
  private readonly booked: BookedChunk[] = [];
  /** Chunks accepted but not yet booked into the graph, oldest first. */
  private pending: Array<{ message: VoiceAudioOutputChunkMessage; samples: Float32Array }> = [];
  private readonly maxPendingChunks: number;
  private nextStartTime = 0;
  private lastSeq: number | null = null;
  private chunksScheduled = 0;
  private chunksDropped = 0;
  private lastOverflowFaultAtMs = Number.NEGATIVE_INFINITY;
  private lastFloorSpeaking: boolean;

  constructor(options: PlaybackPipelineOptions) {
    this.backend = options.backend;
    this.floor = options.floor;
    this.onFault = options.onFault ?? (() => {});
    this.maxQueuedMs = options.maxQueuedMs ?? VOICE_PLAYBACK_MAX_QUEUED_MS;
    this.maxPendingChunks = options.maxPendingChunks ?? VOICE_PLAYBACK_MAX_PENDING_CHUNKS;
    this.leadSeconds = options.leadSeconds ?? 0.02;
    this.lastFloorSpeaking = options.floor.getState().operatorSpeaking;
    // Live duck on barge-in. The release is deliberately NOT applied here: the
    // next chunk boundary restores the volume, so the ducked chunk stays ducked.
    this.unsubscribe = options.floor.subscribe(() => {
      const speaking = this.floor.getState().operatorSpeaking;
      if (speaking === this.lastFloorSpeaking) return;
      this.lastFloorSpeaking = speaking;
      if (speaking) this.backend.setVolumeNow(DUCKED_VOLUME, 0.01);
    });
  }

  /**
   * Feed one server audio chunk. The chunk is either booked into the graph now,
   * held in the bounded pending backlog until the scheduled horizon allows it,
   * or refused. Returns whether it was accepted.
   */
  pushChunk(message: VoiceAudioOutputChunkMessage): 'scheduled' | 'dropped' {
    const samples = decodeOutputChunk(message);
    if (!samples || samples.length === 0) {
      this.chunksDropped += 1;
      this.onFault({
        reason: 'playback_chunk_corrupt',
        detail: `refused a ${message.type} chunk (mime/encoding/ceiling)`,
      });
      return 'dropped';
    }

    if (this.lastSeq !== null && message.seq !== this.lastSeq + 1) {
      // A gap is surfaced once and playback continues: never reordered silently.
      this.onFault({
        reason: 'playback_seq_gap',
        detail: `expected seq ${this.lastSeq + 1}, received ${message.seq}`,
      });
    }
    this.lastSeq = message.seq;

    // Keep the decoded frames with the chunk so the pending backlog does not
    // decode twice.
    this.pending.push({ message, samples });
    if (this.pending.length > this.maxPendingChunks) {
      // The backlog beyond the scheduler's horizon is what can still be dropped
      // without cutting audio that is already committed to the graph. The
      // OLDEST pending chunk goes, so latency and memory stay bounded and the
      // most recent model speech is the speech that survives.
      const dropped = this.pending.shift();
      if (dropped) {
        this.chunksDropped += 1;
        // Bounded surfacing (contract §5.3): a burst must not become a storm of
        // fault reports — at most one per second, carrying the running count.
        const nowMs = this.backend.currentTime() * 1000;
        if (nowMs - this.lastOverflowFaultAtMs >= 1_000) {
          this.lastOverflowFaultAtMs = nowMs;
          this.onFault({
            reason: 'playback_overflow',
            detail: 'playback backlog exceeded its bound; the oldest unplayed chunk was dropped',
            droppedChunks: this.chunksDropped,
          });
        }
      }
    }
    this.pump();
    return 'scheduled';
  }

  /** Book pending chunks while the scheduled horizon is under the bound. */
  private pump(): void {
    this.pruneFinished();
    for (;;) {
      const next = this.pending[0];
      if (!next) return;
      const now = this.backend.currentTime();
      const queuedMs = Math.max(0, (this.nextStartTime - now) * 1000);
      const durationSeconds = next.samples.length / VOICE_PLAYBACK_RATE;
      if (queuedMs >= this.maxQueuedMs) return; // the graph must catch up first
      this.pending.shift();

      // One-ahead: contiguous after what is already booked, never overlapping.
      const startAt = Math.max(now + this.leadSeconds, this.nextStartTime);
      const speaking = this.floor.getState().operatorSpeaking;
      // The volume is applied AT the chunk boundary. A release that happened
      // while the previous chunk played therefore takes effect here, not
      // mid-word.
      this.backend.setVolumeAt(speaking ? DUCKED_VOLUME : NORMAL_VOLUME, startAt);
      const handle = this.backend.schedule(next.samples, startAt);
      this.booked.push({ handle, startAt, endAt: startAt + durationSeconds });
      this.nextStartTime = startAt + durationSeconds;
      this.chunksScheduled += 1;
    }
  }

  /** Drop finished entries so the bound counts only unplayed audio. */
  private pruneFinished(): void {
    const now = this.backend.currentTime();
    while (this.booked.length > 0 && this.booked[0].endAt <= now) this.booked.shift();
  }

  /** Explicit stop (operator action). Never triggered by speech. */
  stop(): void {
    this.backend.stopAll();
    this.booked.length = 0;
    this.pending = [];
    this.nextStartTime = 0;
    this.lastSeq = null;
  }

  stats(): PlaybackStats {
    const queuedMs = Math.max(0, (this.nextStartTime - this.backend.currentTime()) * 1000);
    return {
      chunksScheduled: this.chunksScheduled,
      chunksDropped: this.chunksDropped,
      queuedMs,
      pendingChunks: this.pending.length,
      pendingSeqs: this.pending.map((entry) => entry.message.seq),
      ducked: this.floor.getState().operatorSpeaking,
    };
  }

  dispose(): void {
    this.unsubscribe();
  }
}

// ── Web Audio backend (the real graph) ──────────────────────────────────────

export interface WebAudioPlaybackBackend extends PlaybackBackend {
  /** The master gain — the node the harness taps to measure ducking. */
  readonly masterGain: GainNode;
  readonly context: BaseAudioContext;
}

/**
 * The real backend: one master gain between every scheduled source and the
 * destination. `setVolumeAt` uses `setValueAtTime`, so a chunk boundary's volume
 * is exact rather than "whenever JS got around to it".
 */
export function createWebAudioPlaybackBackend(
  context: BaseAudioContext,
  destination: AudioNode = context.destination,
): WebAudioPlaybackBackend {
  const masterGain = context.createGain();
  masterGain.gain.value = NORMAL_VOLUME;
  masterGain.connect(destination);

  let volume = NORMAL_VOLUME;

  return {
    context,
    masterGain,
    currentTime: () => context.currentTime,
    schedule(samples: Float32Array, startAt: number): ScheduledHandle {
      const buffer = context.createBuffer(1, samples.length, VOICE_PLAYBACK_RATE);
      buffer.getChannelData(0).set(samples);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(masterGain);
      source.start(Math.max(startAt, context.currentTime));
      return {
        stop() {
          try {
            source.stop();
          } catch {
            /* already stopped */
          }
          try {
            source.disconnect();
          } catch {
            /* already disconnected */
          }
        },
      };
    },
    setVolumeAt(nextVolume: number, atTime: number): void {
      volume = nextVolume;
      const gain = masterGain.gain;
      const safeTime = Math.max(atTime, context.currentTime);
      gain.cancelScheduledValues(safeTime);
      gain.setValueAtTime(nextVolume, safeTime);
    },
    setVolumeNow(nextVolume: number, rampSeconds = 0.01): void {
      volume = nextVolume;
      const gain = masterGain.gain;
      const now = context.currentTime;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(nextVolume, now + Math.max(0.001, rampSeconds));
    },
    stopAll(): void {
      volume = NORMAL_VOLUME;
      const gain = masterGain.gain;
      const now = context.currentTime;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(NORMAL_VOLUME, now);
    },
    currentVolume: () => volume,
  };
}
