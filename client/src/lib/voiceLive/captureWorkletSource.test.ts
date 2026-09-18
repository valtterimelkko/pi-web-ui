import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VOICE_CAPTURE_BLOCK_MS, VOICE_CAPTURE_PROCESSOR_NAME } from './audioConstants';
import {
  CAPTURE_WORKLET_PATH,
  CAPTURE_WORKLET_SOURCE,
  resolveCaptureWorkletUrls,
} from './captureWorkletSource';

/**
 * The worklet processor is evaluated here as the AudioWorkletGlobalScope would
 * evaluate it — the same source string, with `AudioWorkletProcessor`,
 * `registerProcessor`, `sampleRate` and `currentTime` supplied as the scope's
 * globals. So the buffer management under test is the code that actually runs
 * on the audio thread, not a re-implementation of it.
 */

interface PostedBlock {
  type: string;
  frames: number;
  samples: Float32Array;
  transferred: boolean;
}

interface StubPort {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

function loadProcessor(sampleRateHz: number, currentTimeSeconds = 4): {
  ctor: new () => { process(inputs: unknown[], outputs: unknown[]): boolean; port: StubPort };
  posted: PostedBlock[];
  registered: string[];
} {
  const posted: PostedBlock[] = [];
  const registered: string[] = [];

  class StubAudioWorkletProcessor {
    port: StubPort = {
      postMessage: (message: unknown, transfer?: ArrayBuffer[]) => {
        const typed = message as { type?: string; frames?: number; samples?: ArrayBuffer };
        if (typed.type === 'block' && typed.samples) {
          posted.push({
            type: typed.type,
            frames: typed.frames ?? 0,
            samples: new Float32Array(typed.samples.slice(0)),
            transferred: Array.isArray(transfer) && transfer.length === 1,
          });
        }
      },
      onmessage: null,
    };
  }

  const factory = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    'currentTime',
    `${CAPTURE_WORKLET_SOURCE}\nreturn VoiceCaptureProcessor;`,
  );
  const ctor = factory(
    StubAudioWorkletProcessor,
    (name: string) => registered.push(name),
    sampleRateHz,
    currentTimeSeconds,
  ) as new () => { process(inputs: unknown[], outputs: unknown[]): boolean; port: StubPort };
  return { ctor, posted, registered };
}

function channel(samples: number[]): Float32Array {
  return Float32Array.from(samples);
}

describe('capture worklet source', () => {
  it('inlines the same processor name and block cadence the pipeline expects', () => {
    const { registered } = loadProcessor(48_000);
    expect(registered).toEqual([VOICE_CAPTURE_PROCESSOR_NAME]);
    expect(CAPTURE_WORKLET_SOURCE).toContain(`sampleRate * ${VOICE_CAPTURE_BLOCK_MS}`);
  });

  it('has no module import, network call or timer in the audio thread', () => {
    expect(CAPTURE_WORKLET_SOURCE).not.toMatch(/^\s*import\s/m);
    expect(CAPTURE_WORKLET_SOURCE).not.toMatch(/\bfetch\s*\(/);
    expect(CAPTURE_WORKLET_SOURCE).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
  });

  it('posts one block per block window at 48 kHz and transfers the buffer', () => {
    const { ctor, posted } = loadProcessor(48_000);
    const processor = new ctor();
    const blockFrames = (48_000 * VOICE_CAPTURE_BLOCK_MS) / 1000; // 960
    const quantum = channel(new Array(128).fill(0.25));
    const quanta = (blockFrames * 2) / 128; // exact: 15 quanta
    for (let i = 0; i < quanta; i += 1) {
      expect(processor.process([[quantum]], [[]])).toBe(true);
    }
    expect(posted).toHaveLength(2);
    expect(posted[0].frames).toBe(blockFrames);
    expect(posted[0].samples.length).toBe(blockFrames);
    expect(posted.every((block) => block.transferred)).toBe(true);
  });

  it('handles a device rate that is not a multiple of the quantum (44.1 kHz)', () => {
    const { ctor, posted } = loadProcessor(44_100);
    const processor = new ctor();
    const blockFrames = Math.round((44_100 * VOICE_CAPTURE_BLOCK_MS) / 1000); // 882
    const quantum = channel(new Array(128).fill(0.1));
    for (let i = 0; i < Math.ceil((blockFrames * 3) / 128); i += 1) {
      processor.process([[quantum]], [[]]);
    }
    expect(posted.length).toBeGreaterThanOrEqual(3);
    expect(posted[0].frames).toBe(blockFrames);
  });

  it('treats a missing input channel as silence and keeps pacing uniform', () => {
    const { ctor, posted } = loadProcessor(48_000);
    const processor = new ctor();
    for (let i = 0; i < 15; i += 1) processor.process([[]], [[]]);
    expect(posted).toHaveLength(2);
    expect(Array.from(posted[0].samples.slice(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it('holds a partial block until flush, then posts exactly the filled frames', () => {
    const { ctor, posted } = loadProcessor(48_000);
    const processor = new ctor();
    processor.process([[channel(new Array(128).fill(0.5))]], [[]]);
    expect(posted).toHaveLength(0);
    processor.port.onmessage?.({ data: { type: 'flush' } });
    expect(posted).toHaveLength(1);
    expect(posted[0].frames).toBe(128);
    expect(posted[0].samples.length).toBe(128);
    // A second flush with nothing buffered posts nothing.
    processor.port.onmessage?.({ data: { type: 'flush' } });
    expect(posted).toHaveLength(1);
  });

  it('stop flushes the partial block and lets process() return false', () => {
    const { ctor, posted } = loadProcessor(48_000);
    const processor = new ctor();
    processor.process([[channel(new Array(64).fill(0.5))]], [[]]);
    processor.port.onmessage?.({ data: { type: 'stop' } });
    expect(posted).toHaveLength(1);
    expect(posted[0].frames).toBe(64);
    expect(processor.process([[channel(new Array(128))]], [[]])).toBe(false);
  });

  it('never throws out of the audio thread when the port is gone', () => {
    const { ctor } = loadProcessor(48_000);
    const processor = new ctor();
    (processor.port as unknown as { postMessage: () => void }).postMessage = () => {
      throw new Error('port closed');
    };
    expect(() => {
      processor.process([[channel(new Array(960).fill(0.2))]], [[]]);
    }).not.toThrow();
  });

  it('ignores unknown control messages', () => {
    const { ctor, posted } = loadProcessor(48_000);
    const processor = new ctor();
    processor.process([[channel(new Array(10).fill(0.5))]], [[]]);
    processor.port.onmessage?.({ data: { type: 'nonsense' } });
    processor.port.onmessage?.({ data: null });
    expect(posted).toHaveLength(0);
  });
});

/**
 * The worklet is served as a same-origin asset (dev middleware + build emit),
 * NOT only as a blob: URL: production serves `script-src 'self'` with no
 * `blob:`, and a blob-URL worklet is blocked there (the 2026-09-18 field
 * failure). The same-origin path must therefore be the FIRST candidate; the
 * blob stays as a fallback for a stale bundle or a harness that serves neither.
 */
describe('capture worklet delivery (CSP-safe asset first)', () => {
  beforeEach(() => {
    // jsdom implements neither `createObjectURL` nor a real audio thread; the
    // browser shape is what is under test here.
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:stub', configurable: true, writable: true });
  });
  afterEach(() => {
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  });

  it('offers the same-origin asset path before any blob URL', () => {
    const urls = resolveCaptureWorkletUrls();
    expect(urls[0]).toBe(CAPTURE_WORKLET_PATH);
    expect(urls[0].startsWith('/')).toBe(true);
    expect(urls.some((url) => url.startsWith('blob:'))).toBe(true);
  });

  it('names a path a `script-src self` policy can load', () => {
    expect(CAPTURE_WORKLET_PATH.endsWith('.js')).toBe(true);
    expect(CAPTURE_WORKLET_PATH).not.toContain('://');
  });
});
