/**
 * WAV container tests. The oracle's honesty depends on the recorder's files
 * being read exactly: a truncated capture must throw, never silently become a
 * shorter (and therefore apparently fine) recording.
 */
import { describe, it, expect } from 'vitest';
import {
  decodePcm16le,
  decodeWav,
  encodeWavPcm16,
  toMono,
  type PcmAudio,
} from '../../../scripts/audio-lab/lib/wav.js';

function tone(frames: number, sampleRate = 8000): PcmAudio {
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) data[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
  return { channels: [data], sampleRate, frames };
}

describe('wav encode/decode', () => {
  it('round-trips a mono tone within 16-bit quantisation error', () => {
    const original = tone(1600);
    const decoded = decodeWav(encodeWavPcm16(original));
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.channels.length).toBe(1);
    expect(decoded.frames).toBe(1600);
    let maxError = 0;
    for (let i = 0; i < original.frames; i += 1) {
      maxError = Math.max(maxError, Math.abs(decoded.channels[0][i] - original.channels[0][i]));
    }
    expect(maxError).toBeLessThan(1 / 32767 + 1e-6);
  });

  it('round-trips stereo with channels kept separate', () => {
    const frames = 400;
    const left = new Float32Array(frames).fill(0.25);
    const right = new Float32Array(frames).fill(-0.75);
    const decoded = decodeWav(encodeWavPcm16({ channels: [left, right], sampleRate: 16000, frames }));
    expect(decoded.channels.length).toBe(2);
    expect(decoded.channels[0][10]).toBeCloseTo(0.25, 3);
    expect(decoded.channels[1][10]).toBeCloseTo(-0.75, 3);
  });

  it('rejects a non-RIFF buffer', () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/RIFF/);
  });

  it('rejects a header-only buffer with no complete frames', () => {
    const wav = encodeWavPcm16(tone(10));
    // Either error is honest: the declared data chunk is short, and even if it
    // were trusted there would be no complete frame. Both refuse the input.
    expect(() => decodeWav(wav.subarray(0, 44))).toThrow(/no complete frames|truncated/);
  });

  it('rejects a data chunk truncated relative to its declared size', () => {
    const wav = encodeWavPcm16(tone(800));
    // Keep the full header (which declares the true data size) but drop the tail.
    const truncated = Buffer.concat([wav.subarray(0, 44), wav.subarray(44, 144)]);
    expect(() => decodeWav(truncated)).toThrow(/truncated/);
  });

  it('reads a streamed WAV whose data size is 0xFFFFFFFF by trusting the file length', () => {
    const wav = Buffer.from(encodeWavPcm16(tone(500)));
    wav.writeUInt32LE(0xffffffff, 40);
    wav.writeUInt32LE(0xffffffff, 4);
    const decoded = decodeWav(wav);
    expect(decoded.frames).toBe(500);
  });

  it('decodes 24-bit PCM', () => {
    const frames = 8;
    const buffer = Buffer.alloc(44 + frames * 3);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + frames * 3, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(8000, 24);
    buffer.writeUInt32LE(8000 * 3, 28);
    buffer.writeUInt16LE(3, 32);
    buffer.writeUInt16LE(24, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(frames * 3, 40);
    // +0.5 in 24-bit little-endian: 0x400000
    buffer[44] = 0x00;
    buffer[45] = 0x00;
    buffer[46] = 0x40;
    const decoded = decodeWav(buffer);
    expect(decoded.frames).toBe(frames);
    expect(decoded.channels[0][0]).toBeCloseTo(0.5, 6);
    expect(decoded.channels[0][1]).toBe(0);
  });

  it('decodes WAVE_FORMAT_EXTENSIBLE using its sub-format tag', () => {
    const frames = 4;
    const dataBytes = frames * 2;
    const fmtBody = Buffer.from(
      // tag | channels | sampleRate | byteRate | blockAlign | bits | cbSize
      'feff' + '0100' + '803e0000' + '007d0000' + '0200' + '1000' + '1600' +
        // validBits | channelMask | SubFormat GUID (KSDATAFORMAT_SUBTYPE_PCM)
        '1000' + '04000000' + '0100000000001000800000aa00389b71',
      'hex'
    );
    expect(fmtBody.length).toBe(40);
    const buffer = Buffer.alloc(12 + 8 + fmtBody.length + 8 + dataBytes);
    let cursor = 0;
    buffer.write('RIFF', cursor, 'ascii'); cursor += 4;
    buffer.writeUInt32LE(buffer.length - 8, cursor); cursor += 4;
    buffer.write('WAVE', cursor, 'ascii'); cursor += 4;
    buffer.write('fmt ', cursor, 'ascii'); cursor += 4;
    buffer.writeUInt32LE(fmtBody.length, cursor); cursor += 4;
    fmtBody.copy(buffer, cursor); cursor += fmtBody.length;
    buffer.write('data', cursor, 'ascii'); cursor += 4;
    buffer.writeUInt32LE(dataBytes, cursor); cursor += 4;
    for (let i = 0; i < frames; i += 1) {
      buffer.writeInt16LE(1000 * (i + 1), cursor);
      cursor += 2;
    }
    const decoded = decodeWav(buffer);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.frames).toBe(frames);
    expect(decoded.channels[0][0]).toBeCloseTo(1000 / 32768, 6);
  });

  it('decodes raw interleaved PCM16 exactly', () => {
    const frames = 4;
    const buffer = Buffer.alloc(frames * 2 * 2);
    for (let i = 0; i < frames; i += 1) {
      buffer.writeInt16LE(16384, i * 4);      // left = +0.5
      buffer.writeInt16LE(-32768, i * 4 + 2); // right = -1
    }
    const decoded = decodePcm16le(buffer, 2, 48000);
    expect(decoded.frames).toBe(frames);
    expect(decoded.channels[0][0]).toBeCloseTo(0.5, 6);
    expect(decoded.channels[1][0]).toBe(-1);
  });

  it('rejects a raw PCM buffer too short for one frame', () => {
    expect(() => decodePcm16le(Buffer.alloc(2), 2, 48000)).toThrow(/no complete frames/);
  });

  it('mixes channels down to mono by mean', () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 1, -1]);
    const mono = toMono({ channels: [left, right], sampleRate: 8000, frames: 3 });
    expect(Array.from(mono)).toEqual([0.5, 0.5, -1]);
  });
});
