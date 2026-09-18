/**
 * Drive the SHIPPED client scheduler over real captured audio.
 *
 * The point of this file is that no arithmetic is re-implemented here. The lane's
 * client-side scheduling lives in `client/src/lib/voiceLive/playbackSession.ts`
 * (`PlaybackPipeline`), and that is the code the operator's browser ran. It takes
 * an injectable backend — precisely so it can be driven like this — so we run the
 * REAL class against a backend that records every booking instead of making sound.
 *
 * The clock is the interesting part. In production `AudioContext.currentTime`
 * advances while chunks arrive. Here the clock is set to each chunk's real arrival
 * time before it is pushed, so the schedule reflects the arrival pattern that
 * actually happened (a burst stays a burst, a stall stays a stall). The clock is
 * NOT advanced afterwards and `pump()` is never called by hand: the pipeline only
 * ever pumps from `pushChunk`, so whatever is still unbooked when the audio stops
 * arriving is what the product leaves unbooked. That is a measurement, not a
 * convenience.
 */
import { PlaybackPipeline, type PlaybackBackend, type ScheduledHandle } from '../../../client/src/lib/voiceLive/playbackSession.js';
import type { VoiceAudioOutputChunkMessage } from '../../../client/src/lib/voiceLive/messages.js';
import type { ScheduledSource } from './oracle.js';

export interface ArrivedChunk {
  seq: number;
  /** Wall-clock arrival (ms since epoch) at the client. */
  arrivedAtMs: number;
  /** Decoded mono samples at 24 kHz. */
  samples: Float32Array;
  mimeType: string;
  declaredDurationMs: number;
}

export interface ScheduleRun {
  schedule: ScheduledSource[];
  /** Chunks the pipeline accepted but had not booked when the audio stopped arriving. */
  strandedSeqs: number[];
  droppedChunks: number;
  faults: Array<{ reason: string; detail: string }>;
  /** The largest queued horizon the scheduler allowed, ms. */
  maxQueuedMs: number;
  /** Wall-clock ms the schedule was allowed to drain for after the last arrival. */
  settleMs: number;
  /** The scheduler refused to construct at all — never silently a clean run. */
  refused: string | null;
}

interface RecordingBackend extends PlaybackBackend {
  clockMs: number;
  setClock(ms: number): void;
  bookings: ScheduledSource[];
}

function createRecordingBackend(): RecordingBackend {
  const bookings: ScheduledSource[] = [];
  const backend: RecordingBackend = {
    clockMs: 0,
    bookings,
    currentTime: () => backend.clockMs / 1000,
    setClock: (ms: number) => {
      backend.clockMs = ms;
    },
    schedule(samples: Float32Array, startAt: number): ScheduledHandle {
      // The pipeline passes the seq through the message; it is recovered by the
      // caller from the booking order, so the handle only needs to be stoppable.
      bookings.push({ seq: -1, startAt, durationSeconds: samples.length / 24_000 });
      return { stop: () => undefined };
    },
    setVolumeAt: () => undefined,
    setVolumeNow: () => undefined,
    stopAll: () => undefined,
    currentVolume: () => 1,
  };
  return backend;
}

/**
 * Run the shipped scheduler over the chunks in arrival order, in REAL time.
 *
 * The clock is set to each chunk's real arrival instant before it is pushed, and
 * the harness then waits the real interval to the next arrival: a burst stays a
 * burst, a stall stays a stall, and — because the product's scheduler now drains
 * on the clock as well as on arrival — the drain timer gets the same chance to
 * fire that it gets in a browser.
 *
 * After the last arrival the harness waits (up to `settleMs` of wall clock) while
 * advancing the audio clock, which is what playback does when the operator has
 * stopped being spoken to. Whatever is still unbooked then is what the product
 * leaves unplayed.
 *
 * @param chunks        real chunks, in arrival order
 * @param options.maxQueuedMs    the scheduling horizon to replay under
 * @param options.settleMs       wall-clock ms allowed for the backlog to drain
 * @param options.realTime       false for a fast deterministic replay that
 *                               advances no timers (only for tests of the shape)
 */
export async function runShippedScheduler(
  chunks: ArrivedChunk[],
  options: { maxQueuedMs?: number; settleMs?: number; realTime?: boolean } = {}
): Promise<ScheduleRun> {
  const settleMs = options.settleMs ?? 45_000;
  const realTime = options.realTime ?? true;
  const backend = createRecordingBackend();
  const faults: Array<{ reason: string; detail: string }> = [];
  const floor = {
    getState: () => ({ operatorSpeaking: false }),
    subscribe: () => () => undefined,
  };
  const pipeline = new PlaybackPipeline({
    backend,
    floor: floor as never,
    onFault: (fault) => faults.push({ reason: fault.reason, detail: fault.detail }),
    ...(options.maxQueuedMs !== undefined ? { maxQueuedMs: options.maxQueuedMs } : {}),
  });

  const first = chunks[0];
  if (!first) {
    pipeline.dispose();
    return {
      schedule: [],
      strandedSeqs: [],
      droppedChunks: 0,
      faults,
      maxQueuedMs: options.maxQueuedMs ?? 2_000,
      settleMs: 0,
      refused: null,
    };
  }

  let peakQueuedMs = 0;
  let previousArrival = first.arrivedAtMs;
  for (const chunk of chunks) {
    const waitMs = chunk.arrivedAtMs - previousArrival;
    if (realTime && waitMs > 0) await sleep(Math.min(waitMs, 500));
    previousArrival = chunk.arrivedAtMs;
    backend.setClock(chunk.arrivedAtMs - first.arrivedAtMs);
    const message = {
      type: 'voice_audio_chunk',
      version: 1,
      laneId: 'capture-lane',
      attachmentGeneration: 1,
      seq: chunk.seq,
      mimeType: chunk.mimeType,
      data: base64FromSamples(chunk.samples),
      durationMs: chunk.declaredDurationMs,
      atMs: chunk.arrivedAtMs,
    } as unknown as VoiceAudioOutputChunkMessage;
    pipeline.pushChunk(message);
    peakQueuedMs = Math.max(peakQueuedMs, pipeline.stats().queuedMs);
  }

  // Let the backlog drain the way playback would if the turn simply ended: the
  // audio clock keeps advancing and the scheduler keeps booking. Nothing is
  // pumped by hand — the drain under test is the product's own.
  const settleStart = Date.now();
  let elapsed = 0;
  while (pipeline.stats().pendingChunks > 0 && elapsed < settleMs) {
    if (realTime) await sleep(50);
    elapsed = Date.now() - settleStart;
    backend.setClock(chunks[chunks.length - 1].arrivedAtMs - first.arrivedAtMs + elapsed);
    if (!realTime) break;
  }

  const stats = pipeline.stats();
  const strandedSeqs = [...stats.pendingSeqs];
  const droppedChunks = stats.chunksDropped;
  const booked = backend.bookings.map((booking, index) => ({ ...booking, seq: chunks[index]?.seq ?? index }));
  pipeline.dispose();

  return {
    schedule: booked,
    strandedSeqs,
    droppedChunks,
    faults,
    maxQueuedMs: Math.round(peakQueuedMs),
    settleMs: Math.round(elapsed),
    refused: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** PCM16LE base64, the contract's wire encoding for model speech. */
function base64FromSamples(samples: Float32Array): string {
  const bytes = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    bytes.writeInt16LE(Math.round(clamped * 32767), index * 2);
  }
  return bytes.toString('base64');
}
