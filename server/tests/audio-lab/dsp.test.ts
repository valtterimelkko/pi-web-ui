/**
 * DSP primitive tests. These pin the behavioural contracts the oracle depends
 * on, so a future "small optimisation" cannot silently change what a
 * measurement means.
 */
import { describe, expect, it } from 'vitest';
import {
  amplitudeToDbfs,
  bestEnvelopeLag,
  dbfsToAmplitude,
  envelope,
  envelopeCorrelationAt,
  envelopeMean,
  envelopePeakLags,
  frameToSample,
  parabolicPeak,
  peak,
  refineLagSamples,
  resampleLinear,
  rms,
  sampleToFrame,
  silenceRuns,
} from '../../../scripts/audio-lab/lib/dsp.js';

const RATE = 16000;

describe('dsp levels', () => {
  it('converts between dBFS and amplitude consistently', () => {
    expect(dbfsToAmplitude(0)).toBeCloseTo(1, 9);
    expect(dbfsToAmplitude(-6.0206)).toBeCloseTo(0.5, 4);
    expect(amplitudeToDbfs(1)).toBeCloseTo(0, 9);
    expect(amplitudeToDbfs(0.5)).toBeCloseTo(-6.0206, 3);
    expect(amplitudeToDbfs(0)).toBeLessThan(-200);
  });

  it('computes rms and peak over a slice', () => {
    const samples = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    expect(rms(samples)).toBeCloseTo(0.5, 9);
    expect(peak(samples)).toBeCloseTo(0.5, 9);
    expect(rms(samples, 0, 2)).toBeCloseTo(0.5, 9);
    expect(rms(samples, 0, 0)).toBe(0);
  });

  it('clamps out-of-range slice bounds rather than throwing', () => {
    const samples = new Float32Array([1, 1]);
    expect(rms(samples, -100, 999)).toBeCloseTo(1, 9);
  });
});

describe('dsp resampling', () => {
  it('is an identity when the rates match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const out = resampleLinear(input, 16000, 16000);
    expect(out.length).toBe(3);
    for (let i = 0; i < input.length; i += 1) expect(out[i]).toBeCloseTo(input[i], 6);
  });

  it('scales length by the rate ratio', () => {
    const input = new Float32Array(1600).fill(0.5);
    expect(resampleLinear(input, 16000, 32000).length).toBe(3200);
    expect(resampleLinear(input, 32000, 16000).length).toBe(800);
  });

  it('preserves a constant signal under a resampling round trip', () => {
    const input = new Float32Array(1000).fill(0.25);
    const out = resampleLinear(resampleLinear(input, 16000, 44100), 44100, 16000);
    for (let i = 10; i < out.length - 10; i += 1) expect(out[i]).toBeCloseTo(0.25, 4);
  });

  it('returns an empty array for empty input', () => {
    expect(resampleLinear(new Float32Array(0), 16000, 44100).length).toBe(0);
  });
});

describe('dsp envelope', () => {
  it('produces frames at the requested hop and exposes frame/sample conversion', () => {
    const samples = new Float32Array(RATE);
    const env = envelope(samples, RATE, 10, 5);
    expect(env.hopSamples).toBe(80);
    expect(env.windowSamples).toBe(160);
    expect(env.values.length).toBe(Math.floor((RATE - 160) / 80) + 1);
    expect(frameToSample(env, 2)).toBe(2 * 80 + 80);
    expect(sampleToFrame(env, 2 * 80 + 80)).toBeCloseTo(2, 6);
  });

  it('measures a half-scale tone at ~0.35 rms', () => {
    const samples = new Float32Array(RATE);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE);
    }
    const env = envelope(samples, RATE, 10, 5);
    expect(envelopeMean(env, 0, env.values.length)).toBeCloseTo(0.354, 2);
  });

  it('reports an empty envelope for input shorter than one window', () => {
    expect(envelope(new Float32Array(10), RATE, 10, 5).values.length).toBe(0);
    expect(envelopeMean(envelope(new Float32Array(10), RATE, 10, 5), 0, 5)).toBe(0);
  });
});

describe('dsp correlation', () => {
  function burst(offset: number, width = 800): Float32Array {
    const samples = new Float32Array(RATE * 2);
    for (let i = 0; i < width; i += 1) {
      samples[offset + i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / RATE);
    }
    return samples;
  }

  it('finds a known offset in the envelope domain', () => {
    const needle = envelope(burst(0), RATE, 10, 5);
    const haystack = envelope(burst(3200), RATE, 10, 5);
    const best = bestEnvelopeLag(needle, haystack, 600);
    const found = frameToSample(haystack, best.lagFrames);
    expect(Math.abs(found - 3200)).toBeLessThan(200);
    expect(best.score).toBeGreaterThan(0.9);
  });

  it('returns zero correlation for two disjoint signals', () => {
    const a = envelope(new Float32Array(RATE).fill(0), RATE, 10, 5);
    const b = envelope(burst(0), RATE, 10, 5);
    expect(envelopeCorrelationAt(a, b, 0)).toBe(0);
  });

  it('reports several distinct peaks for a repeated needle', () => {
    const repeated = new Float32Array(RATE * 3);
    repeated.set(burst(1600, 800), 1600);
    repeated.set(burst(8000, 800), 8000);
    const needle = envelope(burst(0, 800), RATE, 10, 5);
    const env = envelope(repeated, RATE, 10, 5);
    const peaks = envelopePeakLags(needle, env, env.values.length, 0.5, 8, 10);
    expect(peaks.length).toBeGreaterThanOrEqual(2);
    expect(peaks[0].score).toBeGreaterThanOrEqual(peaks[1].score);
  });

  it('refines a lag to sample precision', () => {
    // The needle must BE the content: refineLagSamples takes a window centred
    // on the needle, so a needle padded with silence would refine against
    // silence and the test would be measuring nothing.
    const needle = burst(0, 2400).subarray(0, 2400);
    const haystack = burst(1731, 2400);
    const refined = refineLagSamples(needle, haystack, 1730, 16, 2400);
    expect(Math.abs(refined.lagSamples - 1731)).toBeLessThanOrEqual(1);
    expect(refined.score).toBeGreaterThan(0.99);
  });

  it('reports a low score when the needle is absent', () => {
    const needle = burst(0, 2400).subarray(0, 2400);
    const noise = new Float32Array(4800);
    for (let i = 0; i < noise.length; i += 1) noise[i] = Math.sin(i * 1.7) * 0.4;
    const refined = refineLagSamples(needle, noise, 0, 16, 2400);
    expect(refined.score).toBeLessThan(0.5);
  });

  it('interpolates sub-frame peaks', () => {
    const values = new Float32Array([0.1, 0.9, 0.2]);
    const peakInfo = parabolicPeak(values, 1);
    expect(peakInfo.value).toBeGreaterThan(0.9);
    expect(peakInfo.position).toBeGreaterThan(0.5);
    expect(parabolicPeak(values, 0).position).toBe(0);
  });
});

describe('dsp silence detection', () => {
  const quiet = (ms: number) => new Float32Array(Math.round((ms / 1000) * RATE));
  const loud = (ms: number) => {
    const samples = new Float32Array(Math.round((ms / 1000) * RATE));
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / RATE);
    }
    return samples;
  };
  const join = (...parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };

  it('finds a run above the minimum length and ignores a shorter one', () => {
    const samples = join(quiet(200), loud(400), quiet(30), loud(400), quiet(200));
    const env = envelope(samples, RATE, 10, 5);
    const runs = silenceRuns(env, -45, 60);
    // Leading 200, middle 30 (too short), trailing 200.
    expect(runs.length).toBe(2);
    expect(runs[0].durationMs).toBeGreaterThan(150);
    expect(runs[0].durationMs).toBeLessThan(250);
  });

  it('reports a fully silent buffer as one run', () => {
    const env = envelope(new Float32Array(RATE), RATE, 10, 5);
    const runs = silenceRuns(env, -45, 60);
    expect(runs.length).toBe(1);
    expect(runs[0].durationMs).toBeGreaterThan(900);
  });

  it('finds no runs in continuous audio', () => {
    const env = envelope(loud(1000), RATE, 10, 5);
    expect(silenceRuns(env, -45, 60).length).toBe(0);
  });

  it('respects the threshold', () => {
    // -49 dBFS rms: below the -45 dB silence floor, above the -60 dB one.
    const samples = new Float32Array(RATE);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = 0.005 * Math.sin((2 * Math.PI * 300 * i) / RATE);
    }
    const env = envelope(samples, RATE, 10, 5);
    expect(silenceRuns(env, -45, 60).length).toBe(1);
    expect(silenceRuns(env, -60, 60).length).toBe(0);
  });
});
