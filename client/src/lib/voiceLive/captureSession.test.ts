import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VOICE_AUDIO_INPUT_FORMAT,
  VOICE_AUDIO_INPUT_MIME,
  checkVoiceEnvelope,
} from '@pi-web-ui/shared';
import {
  VOICE_CAPTURE_MAX_PENDING_CHUNKS,
  VOICE_CAPTURE_PREROLL_FRAMES,
  VOICE_FRAME_MS,
  VAD_HANGOVER_FRAMES,
} from './audioConstants';
import {
  CapturePipeline,
  loadCaptureWorklet,
  type CaptureChunk,
  type CaptureFaultReport,
} from './captureSession';
import { CAPTURE_WORKLET_PATH } from './captureWorkletSource';
import { buildAudioChunk, createVoiceLane } from './messages';

// Vite raw import (the jsdom test environment has no Node builtins).
import sourceOfCaptureSession from './captureSession.ts?raw';

const RATE = 16_000;
const FRAME_SAMPLES = (RATE * VOICE_FRAME_MS) / 1000; // 320

const SILENCE = 0.0001;
const SPEECH = 0.5;

function frame(level: number): Float32Array {
  return new Float32Array(FRAME_SAMPLES).fill(level);
}

interface Harness {
  pipeline: CapturePipeline;
  chunks: CaptureChunk[];
  activity: string[];
  faults: CaptureFaultReport[];
}

function makePipeline(overrides: Record<string, unknown> = {}): Harness {
  const chunks: CaptureChunk[] = [];
  const activity: string[] = [];
  const faults: CaptureFaultReport[] = [];
  let clock = 1_000;
  const pipeline = new CapturePipeline({
    sink: (chunk: CaptureChunk) => {
      chunks.push(chunk);
    },
    inputRate: RATE,
    onActivity: (report) => activity.push(report.state),
    onFault: (fault) => faults.push(fault),
    now: () => (clock += 1),
    ...overrides,
  });
  return { pipeline, chunks, activity, faults };
}

/** Push `count` frames, one block each, then let the async drain finish. */
async function pushFrames(
  pipeline: CapturePipeline,
  count: number,
  level: number,
  atMs = 1,
): Promise<void> {
  for (let i = 0; i < count; i += 1) pipeline.pushBlock(frame(level), atMs + i * VOICE_FRAME_MS);
  await pipeline.whenDrained();
}

describe('CapturePipeline — silence handling and the first word', () => {
  it('does not send silence, but retains a pre-roll so the first word is intact', async () => {
    const { pipeline, chunks, activity } = makePipeline();
    await pushFrames(pipeline, VAD_HANGOVER_FRAMES, SILENCE); // idle room noise
    expect(chunks).toHaveLength(0);

    await pushFrames(pipeline, 3, SPEECH);
    expect(activity).toEqual(['speech_start']);
    // The retained pre-roll goes out BEFORE the frames that triggered the
    // detection, so nothing before the detected start is clipped (P21).
    expect(chunks.length).toBe(VOICE_CAPTURE_PREROLL_FRAMES + 2);
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_c, i) => i));
    expect(chunks[0].durationMs).toBe(VOICE_FRAME_MS);
  });

  it('emits the frame that completes the hangover, then stops sending until speech resumes', async () => {
    const { pipeline, chunks, activity } = makePipeline();
    await pushFrames(pipeline, 3, SPEECH); // speech_start on the 2nd frame
    const afterStart = chunks.length;

    await pushFrames(pipeline, VAD_HANGOVER_FRAMES, SILENCE); // hangover completes
    expect(activity).toEqual(['speech_start', 'speech_end']);
    expect(chunks.length).toBeGreaterThan(afterStart);

    const settled = chunks.length;
    await pushFrames(pipeline, 20, SILENCE);
    expect(chunks.length).toBe(settled); // back to not sending silence
  });

  it('sends silence when the operator chose push-to-talk precision mode', async () => {
    const { pipeline, chunks } = makePipeline({ sendSilence: true });
    await pushFrames(pipeline, 5, SILENCE);
    expect(chunks).toHaveLength(5);
  });

  it('flush() emits the partial frame zero-padded so a boundary loses nothing', async () => {
    const { pipeline, chunks } = makePipeline();
    pipeline.pushBlock(frame(0.4).subarray(0, 100), 42);
    pipeline.flush(43);
    await pipeline.whenDrained();
    expect(chunks).toHaveLength(1);
    expect(chunks[0].durationMs).toBe(VOICE_FRAME_MS);
    expect(atob(chunks[0].data).length).toBe(640); // zero-padded to a full frame
  });

  it('reports frames produced vs chunks handed to the sink', async () => {
    const { pipeline } = makePipeline();
    await pushFrames(pipeline, 4, SPEECH);
    const stats = pipeline.stats();
    expect(stats.framesProduced).toBe(4);
    expect(stats.chunksSent).toBe(4);
    expect(stats.speaking).toBe(true);
    expect(stats.pendingChunks).toBe(0);
  });
});

describe('CapturePipeline — wire framing', () => {
  it('produces contract-shaped 16 kHz 20 ms chunks the contract accepts', async () => {
    const { pipeline, chunks } = makePipeline();
    await pushFrames(pipeline, 3, SPEECH);
    const lane = createVoiceLane({ workerSessionId: 'w', nonce: 'n' });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.mimeType).toBe(VOICE_AUDIO_INPUT_MIME);
      expect(chunk.durationMs).toBe(VOICE_FRAME_MS);
      expect(chunk.durationMs).toBeLessThanOrEqual(VOICE_AUDIO_INPUT_FORMAT.maxChunkMs);
      expect(checkVoiceEnvelope(buildAudioChunk(lane, chunk), 'client-to-server')).toEqual({
        ok: true,
      });
      // 20 ms of 16 kHz mono PCM16 = 640 bytes (the contract's suggested size).
      expect(atob(chunk.data).length).toBe(640);
    }
  });

  it('numbers chunks monotonically from zero and never reorders them', async () => {
    const { pipeline, chunks } = makePipeline();
    await pushFrames(pipeline, 5, SPEECH);
    await pushFrames(pipeline, VAD_HANGOVER_FRAMES, SILENCE);
    await pushFrames(pipeline, 5, SPEECH);
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_c, index) => index));
  });
});

describe('CapturePipeline — bounded buffers and honest backpressure', () => {
  it('bounds the queue, drops the OLDEST chunks and surfaces the drop (never silently)', async () => {
    const faults: CaptureFaultReport[] = [];
    const delivered: CaptureChunk[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstSinkGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const total = VOICE_CAPTURE_MAX_PENDING_CHUNKS + 20;
    const pipeline = new CapturePipeline({
      sink: async (chunk) => {
        call += 1;
        if (call === 1) await firstSinkGate; // block the drain
        delivered.push(chunk);
      },
      inputRate: RATE,
      sendSilence: true,
      onFault: (fault) => faults.push(fault),
      now: () => 10_000,
    });

    for (let i = 0; i < total; i += 1) pipeline.pushBlock(frame(SPEECH), 1);
    await Promise.resolve();

    const whileBlocked = pipeline.stats();
    expect(whileBlocked.pendingChunks).toBeLessThanOrEqual(VOICE_CAPTURE_MAX_PENDING_CHUNKS);
    expect(whileBlocked.chunksDropped).toBeGreaterThan(0);
    expect(faults).toHaveLength(1);
    expect(faults[0].reason).toBe('capture_backpressure');
    expect(faults[0].droppedChunks).toBeGreaterThan(0);

    releaseFirst?.();
    await pipeline.whenDrained();
    // The newest audio is what survives — the operator's latest words.
    expect(delivered[delivered.length - 1].seq).toBe(total - 1);
  });

  it('throttles repeated backpressure faults to one per second (bounded surfacing)', async () => {
    let clock = 0;
    const faults: CaptureFaultReport[] = [];
    const pipeline = new CapturePipeline({
      sink: async () => {
        await new Promise<void>(() => {});
      },
      inputRate: RATE,
      sendSilence: true,
      onFault: (fault) => faults.push(fault),
      now: () => clock,
    });
    for (let i = 0; i < VOICE_CAPTURE_MAX_PENDING_CHUNKS + 30; i += 1) {
      pipeline.pushBlock(frame(SPEECH), 1);
    }
    await Promise.resolve();
    expect(faults).toHaveLength(1);
    clock = 50; // under one second later
    for (let i = 0; i < 10; i += 1) pipeline.pushBlock(frame(SPEECH), 1);
    expect(faults).toHaveLength(1);
    clock = 5_000;
    for (let i = 0; i < 40; i += 1) pipeline.pushBlock(frame(SPEECH), 1);
    expect(faults).toHaveLength(2);
  });
});

describe('captureSession source invariants (N5 — capture is never scheduled)', () => {
  // Comments describe the invariant; only CODE may be scanned.
  const code = sourceOfCaptureSession
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('has no speech-arbiter import and no way to pause or duck capture', () => {
    expect(code).not.toMatch(/speechArbiter/);
    expect(code).not.toMatch(/setOperatorSpeaking/);
    expect(code).not.toMatch(/duck/i);
    expect(code).not.toMatch(/pause/i);
  });

  it('exposes no capture-suppressing API, only start/stop/flush/stats', () => {
    const exported = code.match(/export (?:async )?function (\w+)/g) ?? [];
    expect(exported).toContain('export async function startCaptureSession');
    for (const name of exported) expect(name).not.toMatch(/suppress|suspend|mute/i);
  });
});

/**
 * A worklet that cannot be loaded is a NAMED fault, not a generic capture
 * error: the operator's report named this failure and the reason must reach the
 * surface (and, later, the server) as its own fact.
 */
describe('capture worklet loading (ordered candidates)', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:stub', configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true, writable: true });
  });
  afterEach(() => {
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  function contextWith(addModule: (url: string) => Promise<void>): AudioContext {
    return { audioWorklet: { addModule } } as unknown as AudioContext;
  }

  it('falls back to the blob URL when the same-origin asset is not served', async () => {
    const tried: string[] = [];
    const faults: CaptureFaultReport[] = [];
    await loadCaptureWorklet(contextWith(async (url) => {
      tried.push(url);
      if (url === CAPTURE_WORKLET_PATH) throw new Error('Failed to load module script');
    }), { onFault: (fault) => faults.push(fault) });

    expect(tried[0]).toBe(CAPTURE_WORKLET_PATH);
    expect(tried[1]?.startsWith('blob:')).toBe(true);
    expect(faults).toEqual([]);
  });

  it('reports worklet_unavailable, naming both attempts, when no candidate loads', async () => {
    const faults: CaptureFaultReport[] = [];
    await expect(
      loadCaptureWorklet(contextWith(async () => { throw new Error('blocked by CSP'); }), {
        onFault: (fault) => faults.push(fault),
      }),
    ).rejects.toThrow(/capture worklet could not be loaded/);

    expect(faults).toHaveLength(1);
    expect(faults[0].reason).toBe('worklet_unavailable');
    expect(faults[0].detail).toContain(CAPTURE_WORKLET_PATH);
    expect(faults[0].detail).toContain('blocked by CSP');
  });
});
