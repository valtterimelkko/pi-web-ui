import { describe, expect, it } from 'vitest';
import {
  BoundedFrameQueue,
  FrameAccumulator,
  VoiceActivityDetector,
  createResamplerState,
  floatToPcm16,
  frameRms,
  resampleMono,
} from './captureDsp';

/** A 48 kHz mono block of a sine wave, continuing from `offset` samples. */
function sineBlock(frames: number, frequencyHz: number, rate: number, offset: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * frequencyHz * (offset + i)) / rate);
  }
  return out;
}

describe('resampleMono', () => {
  it('resamples 48 kHz to 16 kHz at the right count and phase', () => {
    const state = createResamplerState(48_000, 16_000);
    const blockSize = 480; // 10 ms
    let produced = 0;
    const collected: number[] = [];
    for (let block = 0; block < 20; block += 1) {
      const out = resampleMono(sineBlock(blockSize, 440, 48_000, block * blockSize), state);
      collected.push(...out);
      produced += out.length;
    }
    // 20 blocks of 10 ms = 200 ms -> 16 kHz should give ~3200 samples.
    expect(produced).toBeGreaterThan(3_180);
    expect(produced).toBeLessThan(3_220);
    // 440 Hz over 200 ms = 88 cycles -> ~176 zero crossings.
    let crossings = 0;
    for (let i = 1; i < collected.length; i += 1) {
      if (collected[i - 1] <= 0 && collected[i] > 0) crossings += 1;
    }
    expect(crossings).toBeGreaterThan(84);
    expect(crossings).toBeLessThan(92);
  });

  it('is continuous across block boundaries (no reset click, no drift)', () => {
    const state = createResamplerState(44_100, 16_000);
    const blocks: Float32Array[] = [];
    const level = 0.7;
    for (let block = 0; block < 50; block += 1) {
      const input = new Float32Array(441).fill(level);
      blocks.push(resampleMono(input, state));
    }
    // A DC block must stay at its level from the very first output sample: a
    // resampler that fabricated a leading zero would produce a click here.
    expect(blocks[0][0]).toBeCloseTo(level, 5);
    for (let b = 1; b < blocks.length; b += 1) {
      const previous = blocks[b - 1][blocks[b - 1].length - 1];
      const next = blocks[b][0];
      expect(Math.abs(next - previous)).toBeLessThan(0.001);
    }
  });

  it('passes a 16 kHz stream through unchanged', () => {
    const state = createResamplerState(16_000, 16_000);
    const out = resampleMono(Float32Array.from([0, 0.5, -0.5, 1]), state);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0.5, 3);
    expect(out[2]).toBeCloseTo(-0.5, 3);
    expect(out[3]).toBeCloseTo(1, 6);
  });

  it('emits exactly one output per three inputs for the 48 kHz → 16 kHz case, every block', () => {
    // Exactness, not an average: a jittering cadence would show up as frame
    // slips in the pipeline rather than as an obvious rate error.
    const state = createResamplerState(48_000, 16_000);
    for (let block = 0; block < 10; block += 1) {
      const out = resampleMono(sineBlock(960, 440, 48_000, block * 960), state);
      expect(out.length).toBe(320);
    }
    // And the identity across block joins: the last sample of block N and the
    // first of block N+1 are consecutive inputs, not a repeat of one sample.
    const a = resampleMono(Float32Array.from([1, 2, 3]), createResamplerState(16_000, 16_000));
    const state16 = createResamplerState(16_000, 16_000);
    const first = resampleMono(Float32Array.from([1, 2, 3]), state16);
    const second = resampleMono(Float32Array.from([4, 5, 6]), state16);
    expect(Array.from(first)).toEqual([1, 2, 3]);
    expect(Array.from(second)).toEqual([4, 5, 6]);
    expect(a.length).toBe(3);
  });

  it('returns nothing for an empty block', () => {
    expect(resampleMono(new Float32Array(0), createResamplerState(48_000, 16_000)).length).toBe(0);
  });
});

describe('floatToPcm16', () => {
  it('clamps and scales to the signed 16-bit range', () => {
    const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32767, 32767, -32767, 16384]);
  });
});

describe('frameRms', () => {
  it('measures energy and reports silence as zero', () => {
    expect(frameRms(new Float32Array(320))).toBe(0);
    expect(frameRms(Float32Array.from([1, -1, 1, -1]))).toBeCloseTo(1, 6);
    expect(frameRms(new Float32Array(0))).toBe(0);
  });
});

describe('VoiceActivityDetector', () => {
  const options = { startRms: 0.05, endRms: 0.02, attackFrames: 2, hangoverFrames: 3 };

  it('requires the attack window before speech_start (no single-sample trigger)', () => {
    const vad = new VoiceActivityDetector(options);
    expect(vad.push(0.9)).toBeNull();
    expect(vad.push(0.9)).toBe('speech_start');
    expect(vad.speaking).toBe(true);
  });

  it('resets the attack counter on a silent frame in between', () => {
    const vad = new VoiceActivityDetector(options);
    expect(vad.push(0.9)).toBeNull();
    expect(vad.push(0)).toBeNull();
    expect(vad.push(0.9)).toBeNull();
    expect(vad.push(0.9)).toBe('speech_start');
  });

  it('holds through the hangover window and ends only after it', () => {
    const vad = new VoiceActivityDetector(options);
    vad.push(0.9);
    vad.push(0.9);
    expect(vad.push(0)).toBeNull();
    expect(vad.push(0)).toBeNull();
    expect(vad.speaking).toBe(true);
    expect(vad.push(0)).toBe('speech_end');
    expect(vad.speaking).toBe(false);
  });

  it('uses hysteresis: speech between the two thresholds does not start or end', () => {
    const vad = new VoiceActivityDetector(options);
    // 0.03 is below start (0.05) but above end (0.02): idle stays idle.
    for (let i = 0; i < 10; i += 1) expect(vad.push(0.03)).toBeNull();
    vad.push(0.9);
    vad.push(0.9);
    expect(vad.speaking).toBe(true);
    // And while speaking, 0.03 does not accumulate hangover.
    for (let i = 0; i < 10; i += 1) expect(vad.push(0.03)).toBeNull();
    expect(vad.speaking).toBe(true);
    vad.push(0.001);
    vad.push(0.001);
    expect(vad.push(0.001)).toBe('speech_end');
  });

  it('reset() returns it to idle', () => {
    const vad = new VoiceActivityDetector(options);
    vad.push(0.9);
    vad.push(0.9);
    vad.reset();
    expect(vad.speaking).toBe(false);
  });
});

describe('FrameAccumulator', () => {
  it('emits whole frames and retains the partial tail', () => {
    const acc = new FrameAccumulator(4);
    expect(acc.push(Float32Array.from([1, 2, 3, 4, 5]))).toHaveLength(1);
    expect(acc.pendingSamples).toBe(1);
    const frames = acc.push(Float32Array.from([6, 7, 8]));
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0])).toEqual([5, 6, 7, 8]);
    expect(acc.pendingSamples).toBe(0);
  });

  it('flushes a partial tail zero-padded so the last syllable is not lost', () => {
    const acc = new FrameAccumulator(4);
    acc.push(Float32Array.from([1, 2]));
    const tail = acc.flushPadded();
    expect(tail).not.toBeNull();
    expect(Array.from(tail!)).toEqual([1, 2, 0, 0]);
    expect(acc.flushPadded()).toBeNull();
  });

  it('returns subarray views (no copy per frame) but never shares the tail', () => {
    const acc = new FrameAccumulator(2);
    const frames = acc.push(Float32Array.from([1, 2, 3]));
    expect(frames[0].length).toBe(2);
    expect(acc.pendingSamples).toBe(1);
  });
});

describe('BoundedFrameQueue', () => {
  it('drops the OLDEST entries on overflow and counts them', () => {
    const queue = new BoundedFrameQueue<number>(3);
    expect(queue.push(1)).toBe(0);
    queue.push(2);
    queue.push(3);
    expect(queue.push(4)).toBe(1);
    expect(queue.size).toBe(3);
    expect(queue.droppedCount).toBe(1);
    expect(queue.shift()).toBe(2); // 1 was the oldest and is gone
    expect(queue.shift()).toBe(3);
    expect(queue.shift()).toBe(4);
    expect(queue.shift()).toBeUndefined();
  });
});
