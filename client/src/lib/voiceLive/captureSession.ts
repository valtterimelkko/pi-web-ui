/**
 * voiceLive/captureSession — 16 kHz microphone capture with bounded buffers.
 *
 * Two layers, deliberately separated:
 *
 *   - `CapturePipeline` is pure: it takes device-rate mono blocks, resamples
 *     them to 16 kHz, frames them, runs the local VAD, retains a pre-roll, and
 *     hands finished chunks to a sink through a *bounded* queue. It has no DOM
 *     and no AudioWorklet, so every buffer/overflow rule is unit-tested.
 *   - `startCaptureSession` is the thin browser wiring: `getUserMedia` stream →
 *     `MediaStreamAudioSourceNode` → the capture worklet → the pipeline.
 *
 * THE INVARIANT (N5): capture is unconditional. Nothing in this module can be
 * paused, gated or suppressed by speech scheduling. There is no import of the
 * speech arbiter here, no `setOperatorSpeaking`, and no method that drops
 * capture to make room for playback. A local VAD avoids *sending* silence, but
 * a pre-roll buffer is retained so the first word is never clipped (contract
 * §5.2 / P21) — and when it does send, it sends the operator's audio, never a
 * decision about it.
 */

import { VOICE_AUDIO_INPUT_MIME, type VoiceActivityState } from '@pi-web-ui/shared';
import {
  VAD_HANGOVER_FRAMES,
  VOICE_CAPTURE_MAX_PENDING_CHUNKS,
  VOICE_CAPTURE_PREROLL_FRAMES,
  VOICE_CAPTURE_PROCESSOR_NAME,
  VOICE_FRAME_MS,
} from './audioConstants';
import {
  BoundedFrameQueue,
  FrameAccumulator,
  VoiceActivityDetector,
  createResamplerState,
  floatToPcm16,
  frameRms,
  resampleMono,
  type ResamplerState,
} from './captureDsp';
import { createCaptureWorkletUrl } from './captureWorkletSource';
import { pcm16Base64 } from './messages';

/** One encoded, ready-to-send microphone chunk. */
export interface CaptureChunk {
  seq: number;
  mimeType: typeof VOICE_AUDIO_INPUT_MIME;
  data: string;
  durationMs: number;
  capturedAtMs: number;
}

/** The sink may return a promise; a slow sink creates real backpressure. */
export type CaptureSink = (chunk: CaptureChunk) => void | Promise<void>;

export interface CaptureActivityReport {
  state: VoiceActivityState;
  atMs: number;
}

export type CaptureFaultReason = 'capture_backpressure' | 'worklet_unavailable' | 'capture_failed';

export interface CaptureFaultReport {
  reason: CaptureFaultReason;
  detail: string;
  droppedChunks?: number;
}

export interface CapturePipelineOptions {
  sink: CaptureSink;
  /** Device rate of the incoming blocks. */
  inputRate: number;
  onActivity?: (activity: CaptureActivityReport) => void;
  onFault?: (fault: CaptureFaultReport) => void;
  frameMs?: number;
  /** Clock for chunk stamps and activity reports (injectable in tests). */
  now?: () => number;
  vad?: VoiceActivityDetector;
  /**
   * Push-to-talk precision mode: frames are sent even when the local VAD hears
   * silence, because the operator's button is the boundary. Still no influence
   * over whether capture runs.
   */
  sendSilence?: boolean;
  maxPendingChunks?: number;
}

export interface CaptureStats {
  framesProduced: number;
  chunksSent: number;
  chunksDropped: number;
  speaking: boolean;
  pendingChunks: number;
}

/**
 * Device-rate blocks in, 16 kHz chunks out.
 *
 * Overflow policy: the finished-chunk queue is bounded at one second of audio.
 * Beyond it the OLDEST un-drained chunk is dropped and the drop count surfaced
 * (N9) — memory is bounded and the fault is visible; capture itself is never
 * suppressed, and the socket's own ordered outbound queue (intent §11) is what
 * normally absorbs a slow link.
 */
export class CapturePipeline {
  private readonly sink: CaptureSink;
  private readonly onActivity: (activity: CaptureActivityReport) => void;
  private readonly onFault: (fault: CaptureFaultReport) => void;
  private readonly now: () => number;
  private readonly vad: VoiceActivityDetector;
  private readonly sendSilence: boolean;
  private readonly resampler: ResamplerState;
  private readonly accumulator: FrameAccumulator;
  private readonly queue: BoundedFrameQueue<CaptureChunk>;
  private readonly frameSamples: number;
  private preRoll: Float32Array[] = [];
  private seq = 0;
  private framesProduced = 0;
  private chunksSent = 0;
  private draining: Promise<void> | null = null;
  private lastBackpressureFaultAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: CapturePipelineOptions) {
    this.sink = options.sink;
    this.onActivity = options.onActivity ?? (() => {});
    this.onFault = options.onFault ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.vad = options.vad ?? new VoiceActivityDetector();
    this.sendSilence = options.sendSilence ?? false;
    this.resampler = createResamplerState(options.inputRate, 16_000);
    this.frameSamples = (16_000 * (options.frameMs ?? VOICE_FRAME_MS)) / 1000;
    this.accumulator = new FrameAccumulator(this.frameSamples);
    this.queue = new BoundedFrameQueue<CaptureChunk>(
      options.maxPendingChunks ?? VOICE_CAPTURE_MAX_PENDING_CHUNKS,
    );
  }

  /** One device-rate block from the worklet (already mono float). */
  pushBlock(block: Float32Array, atMs: number = this.now()): void {
    const resampled = resampleMono(block, this.resampler);
    const frames = this.accumulator.push(resampled);
    for (const frame of frames) this.consumeFrame(frame, atMs);
  }

  private consumeFrame(frame: Float32Array, atMs: number): void {
    this.framesProduced += 1;
    const transition = this.vad.push(frameRms(frame));

    if (transition === 'speech_start') {
      // Flush the retained pre-roll FIRST so the first word is intact, then
      // this frame. (P21 is exactly this defect.)
      for (const held of this.preRoll) this.emit(held, atMs);
      this.preRoll = [];
      this.emit(frame, atMs);
      this.onActivity({ state: 'speech_start', atMs });
      return;
    }

    if (transition === 'speech_end') {
      this.emit(frame, atMs);
      this.onActivity({ state: 'speech_end', atMs });
      return;
    }

    if (this.vad.speaking || this.sendSilence) {
      this.emit(frame, atMs);
      return;
    }

    // Idle: do not send silence, but keep the pre-roll bounded and recent.
    this.preRoll.push(frame);
    if (this.preRoll.length > VOICE_CAPTURE_PREROLL_FRAMES) this.preRoll.shift();
  }

  private emit(frame: Float32Array, atMs: number): void {
    const pcm = floatToPcm16(frame);
    const chunk: CaptureChunk = {
      seq: this.seq,
      mimeType: VOICE_AUDIO_INPUT_MIME,
      data: pcm16Base64(pcm),
      durationMs: (frame.length / 16_000) * 1000,
      capturedAtMs: atMs,
    };
    this.seq += 1;
    const overflow = this.queue.push(chunk);
    if (overflow > 0) {
      const now = this.now();
      // Bounded surfacing: a fault storm must not become a UI storm.
      if (now - this.lastBackpressureFaultAtMs >= 1_000) {
        this.lastBackpressureFaultAtMs = now;
        this.onFault({
          reason: 'capture_backpressure',
          detail: 'capture backlog exceeded one second; oldest chunks were dropped',
          droppedChunks: this.queue.droppedCount,
        });
      }
    }
    this.kick();
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const next = this.queue.shift();
        if (!next) return;
        // A promise-returning sink is real backpressure: stop draining until it
        // resolves rather than piling more work on it.
        await this.sink(next);
        this.chunksSent += 1;
      }
    } finally {
      this.draining = null;
      if (this.queue.size > 0) this.kick();
    }
  }

  /** Resolves once the queue is empty (tests and `stop()`). */
  async whenDrained(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Flush the partial frame, zero-padded — the last syllable is not lost. */
  flush(atMs: number = this.now()): void {
    const tail = this.accumulator.flushPadded();
    if (tail) {
      // A flushed tail is always emitted (a push-to-talk boundary or shutdown),
      // never held back by the VAD.
      this.emit(tail, atMs);
    }
  }

  stats(): CaptureStats {
    return {
      framesProduced: this.framesProduced,
      chunksSent: this.chunksSent,
      chunksDropped: this.queue.droppedCount,
      speaking: this.vad.speaking,
      pendingChunks: this.queue.size,
    };
  }
}

// ── Browser wiring ──────────────────────────────────────────────────────────

export interface StartCaptureSessionOptions {
  context: AudioContext;
  stream: MediaStream;
  sink: CaptureSink;
  onActivity?: (activity: CaptureActivityReport) => void;
  onFault?: (fault: CaptureFaultReport) => void;
  frameMs?: number;
  /** Sends silence too (push-to-talk precision mode). */
  sendSilence?: boolean;
  now?: () => number;
}

export interface CaptureSession {
  /** The worklet's actual device rate (what the pipeline resamples from). */
  readonly inputRate: number;
  stop(): Promise<void>;
  /** Push-to-talk boundary: flush the partial block/frame now. */
  flush(): void;
  stats(): CaptureStats;
}

/**
 * Wire a live microphone stream through the worklet into a `CapturePipeline`.
 * Throws when AudioWorklet is unavailable so the surface can fall back to
 * push-to-talk honestly rather than pretending to listen.
 */
export async function startCaptureSession(
  options: StartCaptureSessionOptions,
): Promise<CaptureSession> {
  const { context, stream } = options;
  if (!context.audioWorklet) {
    throw new Error('AudioWorklet is unavailable in this browser context');
  }

  const workletUrl = createCaptureWorkletUrl();
  try {
    await context.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, VOICE_CAPTURE_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  // A zero-gain sink keeps the node in the rendering graph without making any
  // sound: the microphone must never be audible through the page.
  const silentSink = context.createGain();
  silentSink.gain.value = 0;

  const pipeline = new CapturePipeline({
    sink: options.sink,
    inputRate: context.sampleRate,
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    ...(options.onFault ? { onFault: options.onFault } : {}),
    ...(options.frameMs !== undefined ? { frameMs: options.frameMs } : {}),
    ...(options.sendSilence !== undefined ? { sendSilence: options.sendSilence } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; samples?: ArrayBuffer; atMs?: number } | null;
    if (!data || data.type !== 'block' || !data.samples) return;
    try {
      pipeline.pushBlock(new Float32Array(data.samples), data.atMs ?? Date.now());
    } catch (error) {
      options.onFault?.({
        reason: 'capture_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  source.connect(node);
  node.connect(silentSink);
  silentSink.connect(context.destination);

  let stopped = false;
  return {
    inputRate: context.sampleRate,
    async stop() {
      if (stopped) return;
      stopped = true;
      // Ask the processor for its partial block, let that message arrive, then
      // flush the partial frame so the tail is delivered rather than cut.
      try {
        node.port.postMessage({ type: 'stop' });
      } catch {
        /* the port may already be closed; the flush below still runs */
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      pipeline.flush();
      await pipeline.whenDrained();
      node.port.onmessage = null;
      try {
        source.disconnect();
        node.disconnect();
        silentSink.disconnect();
      } catch {
        /* already torn down */
      }
      for (const track of stream.getAudioTracks()) track.stop();
    },
    flush() {
      try {
        node.port.postMessage({ type: 'flush' });
      } catch {
        /* ignore */
      }
      pipeline.flush();
    },
    stats() {
      return pipeline.stats();
    },
  };
}

/** VAD hangover in frames, surfaced so the surface can describe its timing. */
export const CAPTURE_VAD_HANGOVER_FRAMES = VAD_HANGOVER_FRAMES;
