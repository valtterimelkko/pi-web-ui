/**
 * Minimal, dependency-free RIFF/WAVE reader + PCM16 writer.
 *
 * The lab compares bytes captured by an independent OS recorder (`parec`
 * writing raw PCM) against MP3 fixtures decoded by FFmpeg. Both sides end up
 * as float PCM here, so the oracle never reasons about file formats — only
 * about samples and rates. Deliberately strict: a malformed or truncated
 * container must throw, never silently yield short/partial audio, because
 * "zero captured frames" must invalidate acceptance rather than read as
 * silence (plan §3.3).
 */

export interface PcmAudio {
  /** One Float32Array per channel; every channel has exactly `frames`. */
  channels: Float32Array[];
  sampleRate: number;
  frames: number;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function readSample(view: DataView, offset: number, format: number, bits: number): number {
  if (format === FORMAT_FLOAT) {
    if (bits === 32) return view.getFloat32(offset, true);
    if (bits === 64) return view.getFloat64(offset, true);
    throw new Error(`Unsupported float WAV bit depth: ${bits}`);
  }
  if (format !== FORMAT_PCM) throw new Error(`Unsupported WAV format tag: ${format}`);
  switch (bits) {
    case 8:
      return (view.getUint8(offset) - 128) / 128;
    case 16:
      return view.getInt16(offset, true) / 32768;
    case 24: {
      const b0 = view.getUint8(offset);
      const b1 = view.getUint8(offset + 1);
      const b2 = view.getInt8(offset + 2);
      return ((b2 << 16) | (b1 << 8) | b0) / 8388608;
    }
    case 32:
      return view.getInt32(offset, true) / 2147483648;
    default:
      throw new Error(`Unsupported PCM WAV bit depth: ${bits}`);
  }
}

/** Parse a RIFF/WAVE buffer. Throws on anything it cannot read exactly. */
export function decodeWav(buffer: Uint8Array): PcmAudio {
  if (buffer.byteLength < 44) throw new Error('WAV too small to contain a header');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (fourcc(view, 0) !== 'RIFF') throw new Error('Not a RIFF container');
  if (fourcc(view, 8) !== 'WAVE') throw new Error('RIFF container is not WAVE');

  let formatTag = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;
  let blockAlign = 0;

  let cursor = 12;
  while (cursor + 8 <= buffer.byteLength) {
    const id = fourcc(view, cursor);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;
    const available = Math.min(size, buffer.byteLength - body);
    if (id === 'fmt ') {
      if (available < 16) throw new Error('WAV fmt chunk truncated');
      formatTag = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (formatTag === FORMAT_EXTENSIBLE) {
        if (available < 40) throw new Error('WAVE_FORMAT_EXTENSIBLE fmt chunk truncated');
        // SubFormat GUID: first two bytes are the real format tag.
        formatTag = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOffset = body;
      // Streamed writers leave 0xFFFFFFFF (or 0) when the true size is unknown
      // until the file is closed; trust the on-disk remainder in that case.
      dataBytes = size === 0xffffffff || size === 0 ? buffer.byteLength - body : available;
      if (size !== 0xffffffff && size !== 0 && available < size) {
        throw new Error(`WAV data chunk truncated: declared ${size} bytes, ${available} present`);
      }
    }
    cursor = body + size + (size % 2);
    if (size === 0xffffffff) break;
  }

  if (dataOffset < 0) throw new Error('WAV has no data chunk');
  if (channelCount < 1) throw new Error('WAV declares no channels');
  if (sampleRate < 1) throw new Error('WAV declares no sample rate');
  if (formatTag !== FORMAT_PCM && formatTag !== FORMAT_FLOAT) {
    throw new Error(`Unsupported WAV format tag: ${formatTag}`);
  }
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
  }
  const frameBytes = blockAlign > 0 ? blockAlign : bytesPerSample * channelCount;
  const frames = Math.floor(dataBytes / frameBytes);
  if (frames < 1) throw new Error('WAV data chunk contains no complete frames');

  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c += 1) channels.push(new Float32Array(frames));
  for (let f = 0; f < frames; f += 1) {
    const base = dataOffset + f * frameBytes;
    for (let c = 0; c < channelCount; c += 1) {
      channels[c][f] = readSample(view, base + c * bytesPerSample, formatTag, bitsPerSample);
    }
  }
  return { channels, sampleRate, frames };
}

/** Decode raw interleaved little-endian PCM16 into `PcmAudio`. */
export function decodePcm16le(buffer: Uint8Array, channelCount: number, sampleRate: number): PcmAudio {
  if (channelCount < 1) throw new Error('channelCount must be >= 1');
  const total = Math.floor(buffer.byteLength / 2);
  const frames = Math.floor(total / channelCount);
  if (frames < 1) throw new Error('Raw PCM buffer contains no complete frames');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c += 1) channels.push(new Float32Array(frames));
  for (let f = 0; f < frames; f += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      channels[c][f] = view.getInt16((f * channelCount + c) * 2, true) / 32768;
    }
  }
  return { channels, sampleRate, frames };
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Encode mono/stereo float PCM as a canonical 16-bit PCM WAVE file. */
export function encodeWavPcm16(audio: PcmAudio): Buffer {
  const { channels, sampleRate, frames } = audio;
  if (channels.length < 1) throw new Error('encodeWavPcm16 needs at least one channel');
  for (const channel of channels) {
    if (channel.length !== frames) throw new Error('Channel length mismatch');
  }
  const channelCount = channels.length;
  const dataBytes = frames * channelCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let f = 0; f < frames; f += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      const clamped = Math.max(-1, Math.min(1, channels[c][f]));
      view.setInt16(offset, Math.round(clamped * 32767), true);
      offset += 2;
    }
  }
  return buffer;
}

/** Mix every channel down to a single mono track (mean of channels). */
export function toMono(audio: PcmAudio): Float32Array {
  if (audio.channels.length === 1) return audio.channels[0].slice();
  const mono = new Float32Array(audio.frames);
  for (let c = 0; c < audio.channels.length; c += 1) {
    const channel = audio.channels[c];
    for (let i = 0; i < audio.frames; i += 1) mono[i] += channel[i];
  }
  const scale = 1 / audio.channels.length;
  for (let i = 0; i < audio.frames; i += 1) mono[i] *= scale;
  return mono;
}
