/**
 * FFmpeg/ffprobe wrappers.
 *
 * All invocation is argv-based (never a shell string), bounded by a timeout,
 * and confined to the run directory. The lab decodes MP3 fixtures and captured
 * PCM through the same tool so both sides of a comparison pass through an
 * identical, well-known decoder path — differences the measurement reports are
 * then differences in the render, not differences in two decoders.
 */

import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runTool(
  command: string,
  args: string[],
  options: { timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024,
        env: options.env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`${command} is not installed or not on PATH`));
          return;
        }
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? ((error as { code: number }).code)
          : error
            ? 1
            : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

export interface AudioProbe {
  codec: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  frames: number | null;
  bitRate: number | null;
  formatName: string;
}

/** Probe a media file's stream properties. */
export async function probeAudio(filePath: string): Promise<AudioProbe> {
  const result = await runTool(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels,duration,nb_frames,bit_rate',
      '-show_entries',
      'format=format_name,duration',
      '-of',
      'json',
      filePath,
    ],
    { timeoutMs: 30_000 }
  );
  if (result.code !== 0) throw new Error(`ffprobe failed for ${filePath}: ${result.stderr.trim()}`);
  const parsed = JSON.parse(result.stdout) as {
    streams?: Array<Record<string, string>>;
    format?: Record<string, string>;
  };
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`ffprobe found no audio stream in ${filePath}`);
  const formatDuration = Number.parseFloat(parsed.format?.duration ?? '');
  const streamDuration = Number.parseFloat(stream.duration ?? '');
  return {
    codec: stream.codec_name ?? 'unknown',
    sampleRate: Number.parseInt(stream.sample_rate ?? '0', 10),
    channels: Number.parseInt(stream.channels ?? '0', 10),
    durationSec: Number.isFinite(streamDuration) ? streamDuration : formatDuration,
    frames: stream.nb_frames ? Number.parseInt(stream.nb_frames, 10) : null,
    bitRate: stream.bit_rate ? Number.parseInt(stream.bit_rate, 10) : null,
    formatName: parsed.format?.format_name ?? 'unknown',
  };
}

/** Decode any FFmpeg-readable audio to mono float32 PCM at the target rate.
 *
 * The PCM is written to a file and read back rather than captured from a pipe.
 * `execFile` returns stdout as a UTF-8 string by default, and decoding binary
 * PCM that way silently corrupts it (observed: a 660 Hz tone decoded to
 * samples around 1e38). Reading from a file removes the whole class of bug, and
 * the on-disk decode is retained as evidence next to the recording. */
export async function decodeToMonoF32(
  filePath: string,
  sampleRate: number,
  options: { timeoutMs?: number; scratchPath?: string } = {}
): Promise<Float32Array> {
  const scratch =
    options.scratchPath ?? `${filePath}.f32-${sampleRate}`;
  const result = await runTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-i',
      filePath,
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      'f32le',
      scratch,
    ],
    { timeoutMs: options.timeoutMs ?? 120_000 }
  );
  if (result.code !== 0) {
    throw new Error(`ffmpeg decode failed for ${filePath}: ${result.stderr.trim()}`);
  }
  const buffer = readFileSync(scratch);
  const frames = Math.floor(buffer.byteLength / 4);
  if (frames === 0) throw new Error(`ffmpeg decoded zero samples from ${filePath}`);
  const aligned = new ArrayBuffer(frames * 4);
  Buffer.from(aligned).set(buffer.subarray(0, frames * 4));
  const samples = new Float32Array(aligned);
  assertPlausiblePcm(samples, filePath);
  return samples;
}

/**
 * Reject decoded PCM that cannot be real audio.
 *
 * FFmpeg's f32le output is nominally normalised to [-1, 1] (MP3 intersample
 * overshoot can push it slightly past 1). Values far outside that are proof
 * that the bytes were misinterpreted, not that the recording was loud, and
 * letting them through would poison every downstream measurement: a garbage
 * decode once reported a peak of 1.7e38 and "passed" an energy check.
 */
export function assertPlausiblePcm(samples: Float32Array, source: string, ceiling = 2): void {
  let max = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (!Number.isFinite(value)) {
      throw new Error(`Decoded audio from ${source} contains a non-finite sample at index ${i}`);
    }
    if (value > max) max = value;
  }
  if (max > ceiling) {
    throw new Error(
      `Decoded audio from ${source} is out of range (peak ${max}); the bytes were not audio`
    );
  }
}

/** Remux a raw PCM16 mono stream into a canonical WAV file. */
export async function rawPcm16ToWav(
  rawPath: string,
  wavPath: string,
  sampleRate: number
): Promise<void> {
  const result = await runTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-f',
      's16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-i',
      rawPath,
      '-c:a',
      'pcm_s16le',
      wavPath,
    ],
    { timeoutMs: 120_000 }
  );
  if (result.code !== 0) throw new Error(`ffmpeg remux failed: ${result.stderr.trim()}`);
}

/** Encode PCM16 mono WAV to MP3 at the given bitrate (fixture generation). */
export async function wavToMp3(wavPath: string, mp3Path: string, bitRate = '96k'): Promise<void> {
  const result = await runTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-i',
      wavPath,
      '-c:a',
      'libmp3lame',
      '-b:a',
      bitRate,
      '-ar',
      '24000',
      '-ac',
      '1',
      mp3Path,
    ],
    { timeoutMs: 120_000 }
  );
  if (result.code !== 0) throw new Error(`ffmpeg mp3 encode failed: ${result.stderr.trim()}`);
}

/** Extract a bounded clip [startMs, endMs) from any input into a WAV file. */
export async function extractClip(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number
): Promise<void> {
  const durationMs = Math.max(1, endMs - startMs);
  const result = await runTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-ss',
      (startMs / 1000).toFixed(3),
      '-t',
      (durationMs / 1000).toFixed(3),
      '-i',
      inputPath,
      '-c:a',
      'pcm_s16le',
      outputPath,
    ],
    { timeoutMs: 60_000 }
  );
  if (result.code !== 0) throw new Error(`ffmpeg clip extraction failed: ${result.stderr.trim()}`);
}

/** Validate that an operator-supplied recording is a readable audio container
 *  and return its properties, WITHOUT modifying the original. */
export async function validateImport(path: string, maxBytes: number): Promise<AudioProbe> {
  const size = statSync(path).size;
  if (size <= 0) throw new Error(`Imported recording is empty: ${path}`);
  if (size > maxBytes) throw new Error(`Imported recording exceeds ${maxBytes} bytes: ${path}`);
  const probe = await probeAudio(path);
  if (!probe.sampleRate || !probe.channels) {
    throw new Error(`Imported recording declares no usable audio stream: ${path}`);
  }
  if (!Number.isFinite(probe.durationSec) || probe.durationSec <= 0) {
    throw new Error(`Imported recording has no measurable duration: ${path}`);
  }
  return probe;
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

export function readBytes(path: string): Buffer {
  return readFileSync(path);
}
