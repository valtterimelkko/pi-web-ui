/**
 * voiceLive/captureDsp — the pure DSP the capture path is built from.
 *
 * Everything here is a plain function or a small state machine with no DOM and
 * no audio-thread dependency, so the parts of capture that are easy to get
 * subtly wrong (resampling across block boundaries, silence detection, frame
 * boundaries) are pinned by fast unit tests rather than only by ear.
 */

import {
  VOICE_CAPTURE_RATE,
  VOICE_FRAME_MS,
  VAD_ATTACK_FRAMES,
  VAD_END_RMS,
  VAD_HANGOVER_FRAMES,
  VAD_START_RMS,
  clampSample,
} from './audioConstants';

// ── Resampling ──────────────────────────────────────────────────────────────

/**
 * Resampler state carried between blocks. Output positions are tracked in
 * ABSOLUTE input-sample coordinates (`nextIndex` / `consumed`), which is what
 * makes the output continuous across block boundaries: a per-block resampler
 * that reset its phase would click every 20 ms and slowly drift.
 */
export interface ResamplerState {
  prev: number;
  /** Absolute index (in the concatenated input stream) of the next output. */
  nextIndex: number;
  /** Absolute index of the first sample of the next block. */
  consumed: number;
  started: boolean;
  inputRate: number;
  outputRate: number;
}

export function createResamplerState(inputRate: number, outputRate: number): ResamplerState {
  return { prev: 0, nextIndex: 0, consumed: 0, started: false, inputRate, outputRate };
}

/**
 * Linearly resample one mono block, continuing the phase from `state`.
 *
 * Exactness matters here: for an integer ratio (the 48 kHz → 16 kHz case on
 * most desktops) a block of 960 samples must yield exactly 320 output samples,
 * every block, or the capture frame cadence would jitter forever. The last
 * input sample of a block is emitted directly (fraction 0), so no sample is
 * ever duplicated or dropped at a join.
 */
export function resampleMono(
  input: Float32Array,
  state: ResamplerState,
): Float32Array {
  if (input.length === 0) return new Float32Array(0);
  const ratio = state.inputRate / state.outputRate;

  // stream[0] is the previous block's last sample (the interpolation anchor);
  // stream[j] is absolute input sample `consumed + j - 1`.
  const stream = new Float32Array(input.length + 1);
  stream[0] = state.started ? state.prev : input[0];
  stream.set(input, 1);

  const blockStart = state.consumed;
  const lastAvailable = blockStart + input.length - 1;
  let x = state.nextIndex;
  const out: number[] = [];
  while (x <= lastAvailable) {
    const local = x - blockStart + 1;
    const index = Math.floor(local);
    const frac = local - index;
    // At a block's last sample frac is 0 and there is no sample to its right:
    // take it directly rather than reading past the end (undefined * 0 = NaN).
    const next = index + 1 < stream.length ? stream[index + 1] : stream[index];
    out.push(stream[index] * (1 - frac) + next * frac);
    x += ratio;
  }

  state.prev = input[input.length - 1];
  state.nextIndex = x;
  state.consumed = blockStart + input.length;
  state.started = true;
  return Float32Array.from(out);
}

/** Convert float samples to the wire's signed 16-bit little-endian PCM. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = clampSample(samples[i]);
    // 32767 (not 32768) so +1.0 maps inside the signed range.
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

/** Root-mean-square of a frame — the voice-activity detector's only input. */
export function frameRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// ── Voice-activity detection ────────────────────────────────────────────────

export type VoiceActivityTransition = 'speech_start' | 'speech_end' | null;

export interface VoiceActivityOptions {
  startRms?: number;
  endRms?: number;
  attackFrames?: number;
  hangoverFrames?: number;
}

/**
 * Local energy VAD with hysteresis and hangover. It is a SCHEDULING signal and
 * nothing else (intent §20): it decides when the talker may speak (barge-in
 * ducking) and when captions should be considered live. It cannot send, cannot
 * confirm, and cannot release — no method on it reaches a transport.
 */
export class VoiceActivityDetector {
  private readonly startRms: number;
  private readonly endRms: number;
  private readonly attackFrames: number;
  private readonly hangoverFrames: number;
  private above = 0;
  private below = 0;
  private speakingNow = false;

  constructor(options: VoiceActivityOptions = {}) {
    this.startRms = options.startRms ?? VAD_START_RMS;
    this.endRms = options.endRms ?? VAD_END_RMS;
    this.attackFrames = options.attackFrames ?? VAD_ATTACK_FRAMES;
    this.hangoverFrames = options.hangoverFrames ?? VAD_HANGOVER_FRAMES;
  }

  get speaking(): boolean {
    return this.speakingNow;
  }

  /** Feed one frame's RMS; returns the transition this frame completed. */
  push(rms: number): VoiceActivityTransition {
    if (!this.speakingNow) {
      this.above = rms >= this.startRms ? this.above + 1 : 0;
      if (this.above >= this.attackFrames) {
        this.speakingNow = true;
        this.above = 0;
        this.below = rms < this.endRms ? 1 : 0;
        return 'speech_start';
      }
      return null;
    }
    this.below = rms < this.endRms ? this.below + 1 : 0;
    if (this.below >= this.hangoverFrames) {
      this.speakingNow = false;
      this.below = 0;
      this.above = 0;
      return 'speech_end';
    }
    return null;
  }

  reset(): void {
    this.above = 0;
    this.below = 0;
    this.speakingNow = false;
  }
}

// ── Fixed-size framing ──────────────────────────────────────────────────────

export const CAPTURE_FRAME_SAMPLES = (VOICE_CAPTURE_RATE * VOICE_FRAME_MS) / 1000;

/**
 * Splits a stream of resampled samples into fixed 16 kHz frames, retaining the
 * partial tail for the next call (and exposing it so `stop()` can flush it
 * zero-padded rather than losing the last syllable).
 */
export class FrameAccumulator {
  private readonly frameSamples: number;
  private pending: Float32Array;

  constructor(frameSamples = CAPTURE_FRAME_SAMPLES) {
    this.frameSamples = frameSamples;
    this.pending = new Float32Array(0);
  }

  push(samples: Float32Array): Float32Array[] {
    if (samples.length === 0) return [];
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending, 0);
    joined.set(samples, this.pending.length);

    const frames: Float32Array[] = [];
    let offset = 0;
    while (offset + this.frameSamples <= joined.length) {
      frames.push(joined.subarray(offset, offset + this.frameSamples));
      offset += this.frameSamples;
    }
    this.pending = joined.subarray(offset);
    return frames;
  }

  get pendingSamples(): number {
    return this.pending.length;
  }

  /** Take the partial tail, zero-padded to one frame (or null when empty). */
  flushPadded(): Float32Array | null {
    if (this.pending.length === 0) return null;
    const frame = new Float32Array(this.frameSamples);
    frame.set(this.pending, 0);
    this.pending = new Float32Array(0);
    return frame;
  }
}

/**
 * A bounded FIFO of already-produced frames, oldest-first. Overflow drops the
 * OLDEST entry and reports how many have been dropped, so a slow consumer
 * degrades honestly instead of growing without bound.
 */
export class BoundedFrameQueue<T> {
  private readonly items: T[] = [];
  private dropped = 0;

  constructor(private readonly capacity: number) {}

  push(item: T): number {
    this.items.push(item);
    if (this.items.length <= this.capacity) return 0;
    const overflow = this.items.length - this.capacity;
    for (let i = 0; i < overflow; i += 1) this.items.shift();
    this.dropped += overflow;
    return overflow;
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }
}
