import { describe, it, expect } from 'vitest';

/**
 * Audio transcoder unit suite (Track B, plan Phase 3).
 *
 * The transcoder is the only place PCM framing is interpreted inside the voice
 * service: client microphone bytes arrive as 16 kHz mono PCM16LE base64 and the
 * provider's model speech returns as 24 kHz mono PCM16LE, which is re-framed for
 * the wire. Everything here is offline and deterministic — no provider socket.
 *
 * The contract's own ceilings are exercised by `voice-contract-conformance`
 * through the shared guards; this suite proves the transcoder's own bounds,
 * resampling and safe-drop behaviour.
 */

import {
  BoundedPcmQueue,
  chunkPcm16,
  decodePcm16Base64,
  encodePcm16Base64,
  pcm16DurationMs,
  resamplePcm16,
} from '../../../src/voice/audio-transcoder.js';
import { VOICE_CLIENT_PLAYBACK_FORMAT, VOICE_PROVIDER_INPUT_FORMAT } from '../../../src/voice/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function sinePcm16(sampleRateHz: number, frequencyHz: number, durationMs: number, amplitude = 12_000): Buffer {
  const samples = Math.round((sampleRateHz * durationMs) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRateHz));
    buffer.writeInt16LE(Math.max(-32_768, Math.min(32_767, value)), i * 2);
  }
  return buffer;
}

function zeroCrossings(pcm: Buffer): number {
  let crossings = 0;
  let previous = pcm.readInt16LE(0);
  for (let offset = 2; offset + 1 < pcm.length; offset += 2) {
    const current = pcm.readInt16LE(offset);
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1;
    previous = current;
  }
  return crossings;
}

function estimatedFrequencyHz(pcm: Buffer, sampleRateHz: number): number {
  const durationS = pcm.length / 2 / sampleRateHz;
  return zeroCrossings(pcm) / 2 / durationS;
}

function peakAbs(pcm: Buffer): number {
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  }
  return peak;
}

// ── Duration arithmetic ─────────────────────────────────────────────────────

describe('pcm16DurationMs', () => {
  it('converts bytes to milliseconds at 16 kHz and 24 kHz', () => {
    expect(pcm16DurationMs(640, 16_000)).toBe(20);
    expect(pcm16DurationMs(3_200, 16_000)).toBe(100);
    expect(pcm16DurationMs(960, 24_000)).toBe(20);
    expect(pcm16DurationMs(4_800, 24_000)).toBe(100);
  });

  it('is zero for zero bytes', () => {
    expect(pcm16DurationMs(0, 16_000)).toBe(0);
  });
});

// ── Base64 decode ───────────────────────────────────────────────────────────

describe('decodePcm16Base64', () => {
  it('decodes a valid 20 ms client chunk with a duration', () => {
    const pcm = sinePcm16(16_000, 440, 20);
    const result = decodePcm16Base64(pcm.toString('base64'), VOICE_PROVIDER_INPUT_FORMAT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pcm.equals(pcm)).toBe(true);
    expect(result.durationMs).toBe(20);
  });

  it('refuses an empty payload', () => {
    const result = decodePcm16Base64('', VOICE_PROVIDER_INPUT_FORMAT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('voice_audio_chunk_corrupt');
  });

  it('refuses a non-string payload', () => {
    const result = decodePcm16Base64(42 as unknown, VOICE_PROVIDER_INPUT_FORMAT);
    expect(result.ok).toBe(false);
  });

  it('refuses malformed base64 and valid base64 of odd byte length', () => {
    for (const payload of ['not base64 !!!', 'AAAAA', 'AB==extra', 'A']) {
      const result = decodePcm16Base64(payload, VOICE_PROVIDER_INPUT_FORMAT);
      expect(result.ok).toBe(false);
    }
    // 3 base64 chars decode to 2 bytes only with padding; an unpadded 3-byte
    // payload is a genuinely odd PCM16 length and must be refused.
    const odd = Buffer.from([1, 2, 3]).toString('base64');
    const result = decodePcm16Base64(odd, VOICE_PROVIDER_INPUT_FORMAT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('voice_audio_chunk_corrupt');
  });

  it('drops a payload over the format ceiling instead of buffering it', () => {
    const oversized = Buffer.alloc(VOICE_PROVIDER_INPUT_FORMAT.maxChunkBytes + 2);
    const result = decodePcm16Base64(oversized.toString('base64'), VOICE_PROVIDER_INPUT_FORMAT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('voice_audio_chunk_corrupt');
  });

  it('accepts exactly the ceiling', () => {
    const exact = Buffer.alloc(VOICE_PROVIDER_INPUT_FORMAT.maxChunkBytes, 7);
    const result = decodePcm16Base64(exact.toString('base64'), VOICE_PROVIDER_INPUT_FORMAT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pcm.length).toBe(VOICE_PROVIDER_INPUT_FORMAT.maxChunkBytes);
  });
});

describe('encodePcm16Base64', () => {
  it('round-trips exactly', () => {
    const pcm = sinePcm16(24_000, 300, 40);
    const decoded = decodePcm16Base64(encodePcm16Base64(pcm), VOICE_CLIENT_PLAYBACK_FORMAT);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.pcm.equals(pcm)).toBe(true);
  });
});

// ── Resampling ──────────────────────────────────────────────────────────────

describe('resamplePcm16', () => {
  it('upsamples 16 kHz to 24 kHz with the expected length and pitch', () => {
    const input = sinePcm16(16_000, 440, 500);
    const output = resamplePcm16(input, 16_000, 24_000);
    expect(output.length).toBe(Math.round((input.length / 2) * 1.5) * 2);
    expect(estimatedFrequencyHz(output, 24_000)).toBeGreaterThan(430);
    expect(estimatedFrequencyHz(output, 24_000)).toBeLessThan(450);
    expect(peakAbs(output)).toBeGreaterThan(peakAbs(input) * 0.85);
    expect(peakAbs(output)).toBeLessThan(peakAbs(input) * 1.15);
  });

  it('downsamples 24 kHz to 16 kHz preserving pitch and without clipping', () => {
    const input = sinePcm16(24_000, 440, 500);
    const output = resamplePcm16(input, 24_000, 16_000);
    expect(output.length).toBe(Math.round((input.length / 2) * (2 / 3)) * 2);
    expect(estimatedFrequencyHz(output, 16_000)).toBeGreaterThan(425);
    expect(estimatedFrequencyHz(output, 16_000)).toBeLessThan(455);
    expect(peakAbs(output)).toBeGreaterThan(peakAbs(input) * 0.8);
    expect(peakAbs(output)).toBeLessThanOrEqual(32_767);
  });

  it('returns an identical copy when the rate does not change', () => {
    const input = sinePcm16(16_000, 440, 40);
    const output = resamplePcm16(input, 16_000, 16_000);
    expect(output.equals(input)).toBe(true);
    expect(output).not.toBe(input);
  });

  it('keeps digital silence silent in both directions', () => {
    const silence = Buffer.alloc(1_000);
    expect(peakAbs(resamplePcm16(silence, 16_000, 24_000))).toBe(0);
    expect(peakAbs(resamplePcm16(silence, 24_000, 16_000))).toBe(0);
  });

  it('handles odd byte lengths by dropping the dangling byte and never throws', () => {
    const odd = Buffer.from([1, 2, 3]);
    const output = resamplePcm16(odd, 16_000, 24_000);
    expect(output.length % 2).toBe(0);
    expect(output.length).toBeGreaterThan(0);
    expect(resamplePcm16(Buffer.alloc(1), 16_000, 24_000).length % 2).toBe(0);
  });
});

// ── Re-framing for the wire ─────────────────────────────────────────────────

describe('chunkPcm16', () => {
  it('keeps a provider chunk that is already inside the ceiling as one frame', () => {
    const pcm = sinePcm16(24_000, 440, 20);
    const chunks = chunkPcm16(pcm, VOICE_CLIENT_PLAYBACK_FORMAT);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].equals(pcm)).toBe(true);
  });

  it('splits an oversized provider delivery into ceiling-sized aligned frames', () => {
    const pcm = Buffer.alloc(VOICE_CLIENT_PLAYBACK_FORMAT.maxChunkBytes + 200, 3);
    const chunks = chunkPcm16(pcm, VOICE_CLIENT_PLAYBACK_FORMAT);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(VOICE_CLIENT_PLAYBACK_FORMAT.maxChunkBytes);
      expect(chunk.length % 2).toBe(0);
    }
    expect(Buffer.concat(chunks).equals(pcm)).toBe(true);
  });

  it('returns no frames for empty input', () => {
    expect(chunkPcm16(Buffer.alloc(0), VOICE_CLIENT_PLAYBACK_FORMAT)).toEqual([]);
  });
});

// ── Bounded buffer + backpressure ───────────────────────────────────────────

describe('BoundedPcmQueue', () => {
  it('accepts up to capacity, then refuses (backpressure) and counts the drop', () => {
    const queue = new BoundedPcmQueue(1_000);
    const first = queue.write(Buffer.alloc(600, 1));
    expect(first.acceptedBytes).toBe(600);
    expect(first.droppedBytes).toBe(0);
    expect(first.overflowed).toBe(false);

    const second = queue.write(Buffer.alloc(600, 2));
    expect(second.acceptedBytes).toBe(400);
    expect(second.droppedBytes).toBe(200);
    expect(second.overflowed).toBe(true);
    expect(queue.byteLength).toBe(1_000);
    expect(queue.droppedBytes).toBe(200);
  });

  it('reads in bounded slices and drains in order', () => {
    const queue = new BoundedPcmQueue(100);
    queue.write(Buffer.from([1, 2, 3, 4, 5, 6]));
    const first = queue.read(4);
    expect(first).not.toBeNull();
    expect([...(first ?? Buffer.alloc(0))]).toEqual([1, 2, 3, 4]);
    expect(queue.byteLength).toBe(2);
    const rest = queue.drain();
    expect([...rest]).toEqual([5, 6]);
    expect(queue.byteLength).toBe(0);
    expect(queue.read(4)).toBeNull();
  });

  it('never grows past capacity even under a write flood', () => {
    const queue = new BoundedPcmQueue(256);
    for (let i = 0; i < 50; i += 1) queue.write(Buffer.alloc(64, i));
    expect(queue.byteLength).toBeLessThanOrEqual(256);
    queue.clear();
    expect(queue.byteLength).toBe(0);
    expect(queue.read(1)).toBeNull();
  });
});
