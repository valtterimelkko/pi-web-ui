/**
 * PCM16 audio transcoder (Track B, plan Phase 3).
 *
 * Responsibilities, and nothing else:
 *   - decode/encode base64 mono PCM16LE with explicit, format-bound checks;
 *   - resample between the client rate (16 kHz) and a provider input rate
 *     (the live probe proved 16 kHz is accepted; 24 kHz is supported for
 *     endpoints that ask for it), and between the provider output (24 kHz) and
 *     a client playback rate;
 *   - re-frame provider deliveries into ceiling-sized wire chunks;
 *   - hold a bounded buffer so a slow provider socket applies backpressure
 *     instead of growing without limit.
 *
 * The AUTHORITATIVE wire-frame check (decoded-byte ceiling, base64 shape) is the
 * frozen contract's `isVoiceAudioPayloadWithinLimit` / `voiceBase64DecodedByteLength`,
 * applied by `voice-session.ts` / `voice-router.ts`; this module re-checks as a
 * second line of defence so a corrupt chunk is dropped here too and can never
 * reach the provider socket.
 *
 * Samples are processed as plain byte slices and `Buffer.readInt16LE`, never as
 * typed-array views over shared memory: chunks arrive from the socket and may be
 * backed by pooling buffers that a later read could mutate.
 */

import type { Pcm16Format } from './types.js';

export type Pcm16DecodeFailure = 'voice_audio_chunk_corrupt';

export type Pcm16DecodeResult =
  | { ok: true; pcm: Buffer; durationMs: number }
  | { ok: false; reason: Pcm16DecodeFailure; message: string };

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Milliseconds of audio in a PCM16 byte length at a sample rate. */
export function pcm16DurationMs(byteLength: number, sampleRateHz: number): number {
  if (byteLength <= 0 || sampleRateHz <= 0) return 0;
  return Math.round((byteLength / 2 / sampleRateHz) * 1000);
}

function corrupt(message: string): Pcm16DecodeResult {
  return { ok: false, reason: 'voice_audio_chunk_corrupt', message };
}

/**
 * Decode one base64 PCM16LE payload against its format. Refuses — rather than
 * guesses — an empty payload, malformed base64, an odd number of bytes (not
 * sample-aligned) or anything over the format ceiling.
 */
export function decodePcm16Base64(payload: unknown, format: Pcm16Format): Pcm16DecodeResult {
  if (typeof payload !== 'string' || payload.length === 0) {
    return corrupt('audio payload is empty or not a string');
  }
  if (payload.length > format.maxBase64Chars) {
    return corrupt(`audio payload exceeds the ${format.maxBase64Chars}-character ceiling`);
  }
  if (payload.length % 4 !== 0 || !BASE64_PATTERN.test(payload)) {
    return corrupt('audio payload is not well-formed base64');
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const decoded = Buffer.from(payload, 'base64');
  if (decoded.byteLength !== (payload.length / 4) * 3 - padding) {
    return corrupt('audio payload length does not match its base64 form');
  }
  if (decoded.byteLength === 0 || decoded.byteLength % 2 !== 0) {
    return corrupt('audio payload is not an even number of PCM16 bytes');
  }
  if (decoded.byteLength > format.maxChunkBytes) {
    return corrupt(`audio payload exceeds the ${format.maxChunkBytes}-byte ceiling`);
  }
  return { ok: true, pcm: decoded, durationMs: pcm16DurationMs(decoded.byteLength, format.sampleRateHz) };
}

/** Encode mono PCM16LE as base64 for the provider or the wire. */
export function encodePcm16Base64(pcm: Buffer): string {
  return pcm.toString('base64');
}

/**
 * Resample mono PCM16LE with linear interpolation, pre-filtering with a box
 * average when downsampling so aliasing does not fold high frequencies into the
 * speech band. The dangling byte of an odd-length input is dropped — a frame
 * that is not sample-aligned is by definition incomplete.
 */
export function resamplePcm16(pcm: Buffer, fromSampleRateHz: number, toSampleRateHz: number): Buffer {
  const usableBytes = pcm.length - (pcm.length % 2);
  if (usableBytes <= 0) return Buffer.alloc(0);
  if (fromSampleRateHz === toSampleRateHz) return Buffer.from(pcm.subarray(0, usableBytes));
  if (fromSampleRateHz <= 0 || toSampleRateHz <= 0) return Buffer.alloc(0);

  const inputSamples = usableBytes / 2;
  const outputSamples = Math.max(1, Math.round((inputSamples * toSampleRateHz) / fromSampleRateHz));
  const output = Buffer.alloc(outputSamples * 2);

  const downsampling = toSampleRateHz < fromSampleRateHz;
  const boxWindow = downsampling ? Math.max(1, Math.ceil(fromSampleRateHz / toSampleRateHz)) : 1;

  // Read through a small accessor so the box filter and the interpolation agree.
  const sampleAt = (index: number): number => {
    const clamped = Math.max(0, Math.min(inputSamples - 1, index));
    return pcm.readInt16LE(clamped * 2);
  };
  const filteredAt = (index: number): number => {
    if (boxWindow === 1) return sampleAt(index);
    const half = Math.floor(boxWindow / 2);
    let sum = 0;
    for (let offset = -half; offset <= half; offset += 1) sum += sampleAt(index + offset);
    const count = half * 2 + 1;
    return Math.round(sum / count);
  };

  for (let i = 0; i < outputSamples; i += 1) {
    const sourcePosition = (i * fromSampleRateHz) / toSampleRateHz;
    const lowIndex = Math.floor(sourcePosition);
    const highIndex = lowIndex + 1;
    const fraction = sourcePosition - lowIndex;
    const value = filteredAt(lowIndex) * (1 - fraction) + filteredAt(highIndex) * fraction;
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(value))), i * 2);
  }
  return output;
}

/**
 * Re-frame a provider delivery for the wire. A delivery already inside the
 * ceiling is preserved verbatim (provider order and boundaries are meaningful
 * for playback scheduling); a larger one is cut into ceiling-sized, sample
 * aligned frames.
 */
export function chunkPcm16(pcm: Buffer, format: Pcm16Format): Buffer[] {
  const usableBytes = pcm.length - (pcm.length % 2);
  if (usableBytes <= 0) return [];
  const body = pcm.subarray(0, usableBytes);
  if (body.length <= format.maxChunkBytes) return [Buffer.from(body)];

  const maxBytes = format.maxChunkBytes - (format.maxChunkBytes % 2);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += maxBytes) {
    chunks.push(Buffer.from(body.subarray(offset, Math.min(offset + maxBytes, body.length))));
  }
  return chunks;
}

export interface PcmQueueWriteResult {
  acceptedBytes: number;
  droppedBytes: number;
  overflowed: boolean;
}

/**
 * A bounded FIFO of PCM bytes. `write` never grows past capacity: the excess is
 * refused and counted, so the caller can surface an honest backpressure event
 * rather than swallowing audio (contract §5.2). Dropping the newest bytes keeps
 * what is already queued contiguous in time.
 */
export class BoundedPcmQueue {
  private chunks: Buffer[] = [];
  private queuedBytes = 0;
  private dropped = 0;

  constructor(private readonly capacityBytes: number) {
    if (!Number.isFinite(capacityBytes) || capacityBytes <= 0) {
      throw new Error('BoundedPcmQueue capacity must be a positive number of bytes');
    }
  }

  get byteLength(): number {
    return this.queuedBytes;
  }

  get droppedBytes(): number {
    return this.dropped;
  }

  write(pcm: Buffer): PcmQueueWriteResult {
    const space = this.capacityBytes - this.queuedBytes;
    if (space <= 0) {
      this.dropped += pcm.length;
      return { acceptedBytes: 0, droppedBytes: pcm.length, overflowed: true };
    }
    if (pcm.length <= space) {
      this.chunks.push(Buffer.from(pcm));
      this.queuedBytes += pcm.length;
      return { acceptedBytes: pcm.length, droppedBytes: 0, overflowed: false };
    }
    const accepted = Buffer.from(pcm.subarray(0, space));
    this.chunks.push(accepted);
    this.queuedBytes += accepted.length;
    const droppedBytes = pcm.length - accepted.length;
    this.dropped += droppedBytes;
    return { acceptedBytes: accepted.length, droppedBytes, overflowed: true };
  }

  /** Take up to `maxBytes` from the front, or null when empty. */
  read(maxBytes: number): Buffer | null {
    if (this.queuedBytes === 0 || maxBytes <= 0) return null;
    const target = Math.min(maxBytes, this.queuedBytes);
    const out = Buffer.alloc(target);
    let written = 0;
    while (written < target && this.chunks.length > 0) {
      const head = this.chunks[0];
      const take = Math.min(head.length, target - written);
      head.copy(out, written, 0, take);
      written += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.queuedBytes -= written;
    return out.subarray(0, written);
  }

  /** Everything queued, in order. */
  drain(): Buffer {
    const out = Buffer.alloc(this.queuedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      chunk.copy(out, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.queuedBytes = 0;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.queuedBytes = 0;
  }
}
