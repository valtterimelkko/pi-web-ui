/**
 * Deterministic signal-measurement primitives for the audio oracle.
 *
 * Everything here is pure: given the same samples it returns the same numbers,
 * with no tolerance that silently widens when the input is bad. The oracle
 * (see `oracle.ts`) composes these into verdicts; the adversarial controls
 * (`mutate.ts`) damage a known-good recording and require these same functions
 * to notice. That pairing is what makes a green verdict mean something: a
 * detector that cannot fail on damaged audio is not a detector.
 */

export const EPSILON = 1e-12;

/** Amplitude for a linear gain relative to full scale. */
export function dbfsToAmplitude(db: number): number {
  return Math.pow(10, db / 20);
}

export function amplitudeToDbfs(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, EPSILON));
}

/** Linear-interpolating resampler. Adequate for aligning and scoring speech
 *  envelopes; the oracle never claims sample-exact reconstruction. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  if (input.length === 0) return new Float32Array(0);
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  const last = input.length - 1;
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, last);
    const frac = position - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return out;
}

/** Root-mean-square of a slice, optionally windowed. */
export function rms(samples: Float32Array, start = 0, end = samples.length): number {
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(samples.length, Math.floor(end));
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
}

/** Peak absolute amplitude of a slice. */
export function peak(samples: Float32Array, start = 0, end = samples.length): number {
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(samples.length, Math.floor(end));
  let max = 0;
  for (let i = from; i < to; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > max) max = value;
  }
  return max;
}

export interface Envelope {
  /** Absolute amplitude per frame (0 = digital silence). */
  values: Float32Array;
  /** Hop between frame starts, in samples. */
  hopSamples: number;
  /** Analysis window length, in samples. */
  windowSamples: number;
  sampleRate: number;
}

/** Short-time RMS envelope. Frame `k` covers `[k*hop, k*hop + window)`. */
export function envelope(
  samples: Float32Array,
  sampleRate: number,
  windowMs = 10,
  hopMs = 5
): Envelope {
  const windowSamples = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const hopSamples = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const frames = samples.length < windowSamples ? 0 : Math.floor((samples.length - windowSamples) / hopSamples) + 1;
  const values = new Float32Array(frames);
  for (let k = 0; k < frames; k += 1) {
    values[k] = rms(samples, k * hopSamples, k * hopSamples + windowSamples);
  }
  return { values, hopSamples, windowSamples, sampleRate };
}

/** Convert a frame index into a sample offset (window centre). */
export function frameToSample(env: Envelope, frame: number): number {
  return frame * env.hopSamples + env.windowSamples / 2;
}

export function sampleToFrame(env: Envelope, sample: number): number {
  return (sample - env.windowSamples / 2) / env.hopSamples;
}

/** Mean amplitude of a slice of an envelope. */
export function envelopeMean(env: Envelope, startFrame: number, endFrame: number): number {
  const from = Math.max(0, Math.floor(startFrame));
  const to = Math.min(env.values.length, Math.ceil(endFrame));
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += env.values[i];
  return sum / (to - from);
}

/** Normalised cross-correlation of two envelopes at an integer frame lag.
 *  Returns a value in [-1, 1]; 1 means identical shape and scale. */
export function envelopeCorrelationAt(a: Envelope, b: Envelope, lagFrames: number): number {
  const startA = Math.max(0, -lagFrames);
  const endA = Math.min(a.values.length, b.values.length - lagFrames);
  const count = endA - startA;
  if (count < 3) return 0;
  let sumAB = 0;
  let sumAA = 0;
  let sumBB = 0;
  for (let i = startA; i < endA; i += 1) {
    const va = a.values[i];
    const vb = b.values[i + lagFrames];
    sumAB += va * vb;
    sumAA += va * va;
    sumBB += vb * vb;
  }
  const denominator = Math.sqrt(sumAA * sumBB);
  if (denominator < EPSILON) return 0;
  return sumAB / denominator;
}

export interface CorrelationPeak {
  lagFrames: number;
  score: number;
}

/** Best lag (positive = `needle` starts later in `haystack`) by normalised
 *  envelope correlation, searched within `±maxLagFrames`. */
export function bestEnvelopeLag(
  needle: Envelope,
  haystack: Envelope,
  maxLagFrames: number
): CorrelationPeak {
  let best: CorrelationPeak = { lagFrames: 0, score: -1 };
  // Require an overlap long enough that a high score cannot come from a
  // handful of coincident frames.
  const minOverlap = Math.min(6, Math.max(3, Math.floor(needle.values.length * 0.25)));
  for (let lag = -maxLagFrames; lag <= maxLagFrames; lag += 1) {
    const startA = Math.max(0, -lag);
    const endA = Math.min(needle.values.length, haystack.values.length - lag);
    if (endA - startA < minOverlap) continue;
    const score = envelopeCorrelationAt(needle, haystack, lag);
    if (score > best.score) best = { lagFrames: lag, score };
  }
  return best;
}

/** Locate every local maximum of the *unshifted* correlation surface above
 *  `threshold`, used to tell a duplicate from a single occurrence. */
export function envelopePeakLags(
  needle: Envelope,
  haystack: Envelope,
  maxLagFrames: number,
  threshold: number,
  maxPeaks = 8,
  excludeFrames = 0
): CorrelationPeak[] {
  const scores: { lagFrames: number; score: number }[] = [];
  for (let lag = -maxLagFrames; lag <= maxLagFrames; lag += 1) {
    scores.push({ lagFrames: lag, score: envelopeCorrelationAt(needle, haystack, lag) });
  }
  const peaks: CorrelationPeak[] = [];
  for (let i = 0; i < scores.length; i += 1) {
    const current = scores[i];
    if (current.score < threshold) continue;
    const before = scores[i - 1];
    const after = scores[i + 1];
    if (before && before.score > current.score) continue;
    if (after && after.score >= current.score) continue;
    peaks.push(current);
  }
  peaks.sort((a, b) => b.score - a.score);
  const accepted: CorrelationPeak[] = [];
  for (const candidate of peaks) {
    if (accepted.some((p) => Math.abs(p.lagFrames - candidate.lagFrames) <= excludeFrames)) continue;
    accepted.push(candidate);
    if (accepted.length >= maxPeaks) break;
  }
  return accepted;
}

/** Sample-level refinement of a coarse frame lag using raw-sample
 *  correlation of a Hann-windowed segment around the needle. */
export function refineLagSamples(
  needle: Float32Array,
  haystack: Float32Array,
  coarseLagSamples: number,
  searchSamples = 64,
  windowSamples?: number
): { lagSamples: number; score: number } {
  const window = Math.min(
    windowSamples ?? needle.length,
    Math.max(32, Math.min(needle.length, 2400))
  );
  if (window < 8 || haystack.length < window + 1) return { lagSamples: coarseLagSamples, score: 0 };
  const gain = new Float32Array(window);
  for (let i = 0; i < window; i += 1) gain[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (window - 1));
  const needleOffset = Math.max(0, Math.floor((needle.length - window) / 2));
  let best = { lagSamples: coarseLagSamples, score: -1 };
  for (let delta = -searchSamples; delta <= searchSamples; delta += 1) {
    const lag = coarseLagSamples + delta;
    let sumAB = 0;
    let sumAA = 0;
    let sumBB = 0;
    for (let i = 0; i < window; i += 1) {
      const a = needle[needleOffset + i] * gain[i];
      const index = needleOffset + i + lag;
      const b = index >= 0 && index < haystack.length ? haystack[index] * gain[i] : 0;
      sumAB += a * b;
      sumAA += a * a;
      sumBB += b * b;
    }
    const denom = Math.sqrt(sumAA * sumBB);
    const score = denom < EPSILON ? 0 : sumAB / denom;
    if (score > best.score) best = { lagSamples: lag, score };
  }
  return best;
}

export interface SilenceRun {
  startSample: number;
  endSample: number;
  durationMs: number;
}

/** Contiguous runs where the envelope stays below `thresholdDb`, at least
 *  `minMs` long. Digital silence at either end of the buffer is reported too;
 *  callers decide whether leading/trailing silence is expected. */
export function silenceRuns(
  env: Envelope,
  thresholdDb = -45,
  minMs = 60
): SilenceRun[] {
  const threshold = dbfsToAmplitude(thresholdDb);
  const minFrames = Math.max(1, Math.ceil(minMs / (env.hopSamples / env.sampleRate * 1000)));
  const runs: SilenceRun[] = [];
  let runStart = -1;
  for (let i = 0; i <= env.values.length; i += 1) {
    const quiet = i < env.values.length && env.values[i] < threshold;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      if (i - runStart >= minFrames) {
        const startSample = runStart * env.hopSamples;
        const endSample = Math.min(
          (i - 1) * env.hopSamples + env.windowSamples,
          env.values.length * env.hopSamples + env.windowSamples
        );
        runs.push({
          startSample,
          endSample,
          durationMs: ((endSample - startSample) / env.sampleRate) * 1000,
        });
      }
      runStart = -1;
    }
  }
  return runs;
}

/**
 * Estimate the fundamental frequency of a (near-)periodic signal by
 * autocorrelation.
 *
 * Used to prove that a recording contains the audio that was asked for, not
 * merely that it contains energy: a capture chain that resampled or reordered
 * bytes could still show plenty of energy while playing the wrong thing.
 * Returns 0 when no convincing periodicity exists in the search band.
 */
export function estimateFundamental(
  samples: Float32Array,
  sampleRate: number,
  minHz = 80,
  maxHz = 2000
): { frequencyHz: number; confidence: number } {
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(Math.floor(samples.length / 2), Math.ceil(sampleRate / minHz));
  if (maxLag <= minLag) return { frequencyHz: 0, confidence: 0 };

  // Work on the loudest contiguous region so leading/trailing silence does not
  // dilute the correlation.
  const windowSamples = Math.min(samples.length, Math.round(sampleRate * 0.25));
  let bestOffset = 0;
  let bestEnergy = -1;
  const step = Math.max(1, Math.floor(windowSamples / 4));
  for (let start = 0; start + windowSamples <= samples.length; start += step) {
    let energy = 0;
    for (let i = start; i < start + windowSamples; i += 1) energy += samples[i] * samples[i];
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestOffset = start;
    }
  }
  const window = samples.subarray(bestOffset, bestOffset + windowSamples);
  let zeroLag = 0;
  for (let i = 0; i < window.length; i += 1) zeroLag += window[i] * window[i];
  if (zeroLag <= EPSILON) return { frequencyHz: 0, confidence: 0 };

  let bestLag = 0;
  let bestValue = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < window.length; i += 1) sum += window[i] * window[i + lag];
    const normalised = sum / zeroLag;
    if (normalised > bestValue) {
      bestValue = normalised;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || bestValue < 0.2) {
    return { frequencyHz: 0, confidence: Math.max(0, bestValue) };
  }
  return { frequencyHz: sampleRate / bestLag, confidence: Math.min(1, bestValue) };
}

/** Peak of a signal with parabolic sub-frame interpolation, in frames. */
export function parabolicPeak(values: Float32Array, index: number): { position: number; value: number } {
  if (index <= 0 || index >= values.length - 1) {
    return { position: index, value: values[index] ?? 0 };
  }
  const left = values[index - 1];
  const centre = values[index];
  const right = values[index + 1];
  const denominator = left - 2 * centre + right;
  if (Math.abs(denominator) < EPSILON) return { position: index, value: centre };
  const shift = (0.5 * (left - right)) / denominator;
  const clamped = Math.max(-0.5, Math.min(0.5, shift));
  return { position: index + clamped, value: centre - 0.25 * (left - right) * clamped };
}
