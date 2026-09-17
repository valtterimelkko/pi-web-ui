/**
 * In-process reference PCM player (L0, plan §8.2, §21).
 *
 * The lab needs an output sink that records what was *received* and what was
 * actually *rendered*, so a player that silently drops the head, tail or a
 * middle segment is detectable. It is deliberately in-process PCM: the host's
 * private PulseAudio lane is broken (audio-lab `doctor` reports `capture:chain`
 * failing), so OS-rendered proof stays `indeterminate` here and the reference
 * player is the honest measurement of the player under test.
 *
 * Two policies are kept explicitly separate, because they answer different
 * questions and must never be conflated:
 *
 *   duck              Current-contract compatibility. While the operator holds
 *                     the floor, in-flight speech is scaled to `duckGain`
 *                     (0.15). Barge-in does NOT cancel: `interrupt()` is
 *                     recorded as ignored, matching the shipped product.
 *   native-interrupt  Native-policy exploration. `interrupt()` flushes the
 *                     unrendered queue, reporting generation cancelled and
 *                     audio discarded with no claim of current-policy parity.
 *
 * `stop()` is the separate explicit discard action in both profiles.
 *
 * Accounting is exact: receivedFrames === renderedFrames + discardedFrames +
 * queuedFrames, so "provider sent it" can never be confused with "the operator
 * heard it".
 */

import { EVENT, type EventLog } from './scheduler.js';

export type PlaybackProfile = 'duck' | 'native-interrupt';

export interface ReferencePlayerOptions {
  log?: EventLog;
  profile?: PlaybackProfile;
  /** Output PCM sample rate. Gemini Live audio output is 24 kHz. */
  sampleRate?: number;
  /** Gain applied while the operator holds the floor. */
  duckGain?: number;
}

export interface PlaybackStats {
  receivedBytes: number;
  receivedFrames: number;
  renderedBytes: number;
  renderedFrames: number;
  discardedBytes: number;
  discardedFrames: number;
  queuedBytes: number;
  queuedFrames: number;
  consumedFrames: number;
  consumedMs: number;
  gainChanges: number;
  currentGain: number;
  interruptions: number;
}

export const DEFAULT_DUCK_GAIN = 0.15;
export const DEFAULT_OUTPUT_SAMPLE_RATE = 24000;

/** Scale int16 samples by a gain, clamping to the representable range. */
export function applyGain(pcm: Buffer, gain: number): Buffer {
  if (gain === 1) return Buffer.from(pcm);
  const out = Buffer.alloc(pcm.byteLength);
  for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
    out.writeInt16LE(scaled, offset);
  }
  return out;
}

export class ReferencePlayer {
  readonly profile: PlaybackProfile;
  readonly sampleRate: number;
  readonly duckGain: number;

  private readonly log?: EventLog;
  private readonly receivedChunks: Buffer[] = [];
  private readonly renderedChunks: Buffer[] = [];
  private readonly discardedChunks: Buffer[] = [];
  private pending = Buffer.alloc(0);
  private pendingOffset = 0;
  private operatorFloor = false;
  private gain = 1;
  private gainChanges = 0;
  private interruptions = 0;
  private consumedFrames = 0;
  private renderedFrames = 0;
  private receivedFrames = 0;
  private discardedFrames = 0;

  constructor(options: ReferencePlayerOptions = {}) {
    this.profile = options.profile ?? 'duck';
    this.sampleRate = options.sampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE;
    this.duckGain = options.duckGain ?? DEFAULT_DUCK_GAIN;
    this.log = options.log;
  }

  get operatorHoldsFloor(): boolean {
    return this.operatorFloor;
  }

  /**
   * Operator floor. In the duck profile this is the only thing that changes
   * output level; in the native-interrupt profile it still applies, because a
   * policy exploration that ignores ducking would not be comparable.
   */
  setOperatorFloor(active: boolean): void {
    this.operatorFloor = active;
    const target = active ? this.duckGain : 1;
    if (target !== this.gain) {
      this.gainChanges += 1;
      this.gain = target;
      this.log?.append({
        source: 'player',
        kind: EVENT.PLAYBACK_GAIN,
        payload: { gain: this.gain, operatorFloor: active, profile: this.profile },
      });
    }
  }

  /** Receive PCM from the model. Nothing is played yet. */
  receive(pcm: Buffer): void {
    if (pcm.byteLength === 0) return;
    if (pcm.byteLength % 2 !== 0) throw new Error('PCM16 buffer must have an even byte length');
    this.receivedChunks.push(Buffer.from(pcm));
    this.receivedFrames += pcm.byteLength / 2;
    if (this.pending.byteLength === this.pendingOffset) {
      this.pending = Buffer.from(pcm);
      this.pendingOffset = 0;
    } else {
      this.pending = Buffer.concat([this.pending.subarray(this.pendingOffset), pcm]);
      this.pendingOffset = 0;
    }
    this.log?.append({
      source: 'player',
      kind: EVENT.PLAYBACK_RECEIVED,
      payload: { bytes: pcm.byteLength, frames: pcm.byteLength / 2 },
    });
  }

  /**
   * Render queued audio, applying the current gain. `maxFrames` bounds one
   * call so an interruption can be placed mid-answer.
   */
  render(maxFrames?: number): Buffer {
    const availableBytes = this.pending.byteLength - this.pendingOffset;
    const limit = maxFrames === undefined ? availableBytes : Math.min(availableBytes, maxFrames * 2);
    if (limit <= 0) return Buffer.alloc(0);
    const slice = this.pending.subarray(this.pendingOffset, this.pendingOffset + limit);
    const rendered = applyGain(slice, this.gain);
    this.pendingOffset += limit;
    this.renderedChunks.push(rendered);
    this.renderedFrames += limit / 2;
    this.consumedFrames += limit / 2;
    this.log?.append({
      source: 'player',
      kind: EVENT.PLAYBACK_RENDERED,
      payload: { bytes: rendered.byteLength, frames: limit / 2, gain: this.gain },
    });
    if (this.pendingOffset >= this.pending.byteLength) {
      this.pending = Buffer.alloc(0);
      this.pendingOffset = 0;
    }
    return rendered;
  }

  /**
   * Barge-in. Native-interrupt flushes the unrendered queue; the duck profile
   * records that the interruption was deliberately ignored (the shipped
   * contract keeps talking, only quieter).
   */
  interrupt(reason = 'operator-barge-in'): void {
    if (this.profile === 'native-interrupt') {
      this.discardPending(reason, 'interrupt');
      this.interruptions += 1;
      this.log?.append({
        source: 'player',
        kind: EVENT.PLAYBACK_INTERRUPT,
        payload: { reason, profile: this.profile },
      });
      return;
    }
    this.interruptions += 1;
    this.log?.append({
      source: 'player',
      kind: EVENT.PLAYBACK_INTERRUPT_IGNORED,
      payload: { reason, profile: this.profile },
    });
  }

  /** Explicit discard action (the product's "Stop talker"). Both profiles. */
  stop(reason = 'operator-stop'): void {
    this.discardPending(reason, 'stop');
  }

  private discardPending(reason: string, cause: 'interrupt' | 'stop'): void {
    const bytes = this.pending.byteLength - this.pendingOffset;
    if (bytes <= 0) return;
    const slice = Buffer.from(this.pending.subarray(this.pendingOffset));
    this.discardedChunks.push(slice);
    this.discardedFrames += bytes / 2;
    this.pending = Buffer.alloc(0);
    this.pendingOffset = 0;
    this.log?.append({
      source: 'player',
      kind: EVENT.PLAYBACK_DISCARDED,
      payload: { bytes, frames: bytes / 2, reason, cause },
    });
  }

  stats(): PlaybackStats {
    const queuedBytes = this.pending.byteLength - this.pendingOffset;
    return {
      receivedBytes: this.receivedFrames * 2,
      receivedFrames: this.receivedFrames,
      renderedBytes: this.renderedFrames * 2,
      renderedFrames: this.renderedFrames,
      discardedBytes: this.discardedFrames * 2,
      discardedFrames: this.discardedFrames,
      queuedBytes,
      queuedFrames: queuedBytes / 2,
      consumedFrames: this.consumedFrames,
      consumedMs: (this.consumedFrames / this.sampleRate) * 1000,
      gainChanges: this.gainChanges,
      currentGain: this.gain,
      interruptions: this.interruptions,
    };
  }

  /** True when every received sample is accounted for exactly once. */
  accountingBalanced(): boolean {
    const stats = this.stats();
    return stats.receivedFrames === stats.renderedFrames + stats.discardedFrames + stats.queuedFrames;
  }

  receivedPcm(): Buffer {
    return Buffer.concat(this.receivedChunks);
  }

  renderedPcm(): Buffer {
    return Buffer.concat(this.renderedChunks);
  }

  discardedPcm(): Buffer {
    return Buffer.concat(this.discardedChunks);
  }
}
