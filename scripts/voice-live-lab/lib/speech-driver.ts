/**
 * Paced PCM speech driver (L0, plan §21).
 *
 * The driver is how a frozen utterance becomes candidate input. It streams
 * 16 kHz signed-16 little-endian mono PCM in fixed 20 ms frames (640 bytes),
 * one frame per monotonic tick — never a single dump of the whole recording,
 * because listening and interrupting are exactly what the lab measures.
 *
 * Two endpointing lanes are supported, and they stay labelled because they
 * answer different questions:
 *
 *   E — explicit boundary. `activityStart` is sent before the first frame and
 *       `activityEnd` after the last. This isolates reasoning from endpoint
 *       detection but hands the model an ideal boundary.
 *   N — natural endpointing. No hidden script boundary is leaked; the stream
 *       carries `leadInMs` of silence, the speech, then `trailSilenceMs` of
 *       silence and the configured VAD decides where the turn ends.
 *
 * Every frame is logged with its byte count and media offset, so the manifest
 * can declare the same numbers and the offline verifier can detect a dropped
 * frame as a content defect rather than trusting the driver's own summary.
 */

import { EVENT, type EventLog } from './scheduler.js';

export type EndpointLane = 'E' | 'N';

export interface PcmInputFormat {
  encoding: 'pcm16';
  sampleRate: number;
  channels: number;
}

export interface ProviderInputSink {
  pushAudio(frame: Buffer, format: PcmInputFormat, inputSequence: number): void;
  activityStart?(atMs: number): void;
  activityEnd?(atMs: number): void;
}

export interface SpeechDriverOptions {
  log: EventLog;
  sink: ProviderInputSink;
  lane: EndpointLane;
  /** Frame size in bytes. 640 bytes = 320 samples = 20 ms at 16 kHz. */
  frameBytes?: number;
  frameIntervalMs?: number;
  /** Silence before speech, N lane only. 300 ms by default. */
  leadInMs?: number;
  /** Silence after speech, N lane only. 900 ms by default. */
  trailSilenceMs?: number;
  /** Overridable for deterministic tests; real runs use wall-clock timers. */
  sleep?: (ms: number) => Promise<void>;
}

export interface StreamReport {
  utteranceId: string;
  lane: EndpointLane;
  frames: number;
  audioFrames: number;
  silenceFrames: number;
  /** Bytes actually pushed (frames × frameBytes). */
  bytes: number;
  /** Bytes of the source recording. */
  sourceBytes: number;
  /** Zero-padding added to the final partial frame. */
  paddedBytes: number;
  durationMs: number;
  frameBytes: number;
  startedWithActivityMarker: boolean;
  endedWithActivityMarker: boolean;
}

export const DEFAULT_FRAME_BYTES = 640;
export const DEFAULT_FRAME_INTERVAL_MS = 20;
export const DEFAULT_LEAD_IN_MS = 300;
export const DEFAULT_TRAIL_SILENCE_MS = 900;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SpeechDriver {
  private readonly log: EventLog;
  private readonly sink: ProviderInputSink;
  private readonly lane: EndpointLane;
  private readonly frameBytes: number;
  private readonly frameIntervalMs: number;
  private readonly leadInMs: number;
  private readonly trailSilenceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private sequence = 0;

  constructor(options: SpeechDriverOptions) {
    if (options.frameBytes !== undefined && (options.frameBytes <= 0 || options.frameBytes % 2 !== 0)) {
      throw new Error(`frameBytes must be a positive even number, got ${options.frameBytes}`);
    }
    if (options.frameIntervalMs !== undefined && options.frameIntervalMs <= 0) {
      throw new Error(`frameIntervalMs must be positive, got ${options.frameIntervalMs}`);
    }
    this.log = options.log;
    this.sink = options.sink;
    this.lane = options.lane;
    this.frameBytes = options.frameBytes ?? DEFAULT_FRAME_BYTES;
    this.frameIntervalMs = options.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS;
    this.leadInMs = options.leadInMs ?? DEFAULT_LEAD_IN_MS;
    this.trailSilenceMs = options.trailSilenceMs ?? DEFAULT_TRAIL_SILENCE_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get samplesPerFrame(): number {
    return this.frameBytes / 2;
  }

  /**
   * Stream one utterance. Frames are paced on the log's monotonic clock; the
   * frame's `mediaOffsetMs` is its intended position in the stream, kept
   * distinct from its actual `tMs` so scheduling drift stays visible.
   */
  async stream(utteranceId: string, pcm: Buffer): Promise<StreamReport> {
    if (this.lane === 'E') this.sink.activityStart?.(0);
    const format: PcmInputFormat = { encoding: 'pcm16', sampleRate: 16000, channels: 1 };

    const report: StreamReport = {
      utteranceId,
      lane: this.lane,
      frames: 0,
      audioFrames: 0,
      silenceFrames: 0,
      bytes: 0,
      sourceBytes: pcm.byteLength,
      paddedBytes: 0,
      durationMs: 0,
      frameBytes: this.frameBytes,
      startedWithActivityMarker: this.lane === 'E',
      endedWithActivityMarker: this.lane === 'E',
    };

    const silenceFrame = Buffer.alloc(this.frameBytes);

    if (this.lane === 'N') {
      const leadFrames = Math.round(this.leadInMs / this.frameIntervalMs);
      for (let index = 0; index < leadFrames; index += 1) {
        await this.emit(utteranceId, silenceFrame, index, format, true);
        report.frames += 1;
        report.silenceFrames += 1;
        report.bytes += this.frameBytes;
      }
    }

    const audioFrames = Math.ceil(pcm.byteLength / this.frameBytes);
    for (let index = 0; index < audioFrames; index += 1) {
      const start = index * this.frameBytes;
      const slice = pcm.subarray(start, Math.min(start + this.frameBytes, pcm.byteLength));
      let frame = slice;
      if (slice.byteLength < this.frameBytes) {
        frame = Buffer.concat([slice, Buffer.alloc(this.frameBytes - slice.byteLength)]);
        report.paddedBytes += this.frameBytes - slice.byteLength;
      }
      await this.emit(utteranceId, frame, report.frames, format, false);
      report.frames += 1;
      report.audioFrames += 1;
      report.bytes += this.frameBytes;
    }

    if (this.lane === 'N') {
      const trailFrames = Math.round(this.trailSilenceMs / this.frameIntervalMs);
      for (let index = 0; index < trailFrames; index += 1) {
        await this.emit(utteranceId, silenceFrame, report.frames, format, true);
        report.frames += 1;
        report.silenceFrames += 1;
        report.bytes += this.frameBytes;
      }
    }

    report.durationMs = report.frames * this.frameIntervalMs;
    if (this.lane === 'E') this.sink.activityEnd?.(report.durationMs);
    this.log.append({
      source: 'input',
      kind: EVENT.INPUT_ACTIVITY,
      id: `${utteranceId}:stream-complete`,
      payload: {
        lane: this.lane,
        frames: report.frames,
        bytes: report.bytes,
        sourceBytes: report.sourceBytes,
        paddedBytes: report.paddedBytes,
        durationMs: report.durationMs,
      },
    });
    return report;
  }

  private async emit(
    utteranceId: string,
    frame: Buffer,
    index: number,
    format: PcmInputFormat,
    silence: boolean
  ): Promise<void> {
    await this.sleep(this.frameIntervalMs);
    this.sink.pushAudio(frame, format, this.sequence);
    this.log.append({
      source: 'input',
      kind: EVENT.INPUT_FRAME,
      id: `${utteranceId}:frame:${index}`,
      mediaOffsetMs: index * this.frameIntervalMs,
      payload: {
        index,
        bytes: frame.byteLength,
        sequence: this.sequence,
        silence,
        lane: this.lane,
        utteranceId,
      },
    });
    this.sequence += 1;
  }
}
