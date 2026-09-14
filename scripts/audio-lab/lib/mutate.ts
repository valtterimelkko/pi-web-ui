/**
 * Adversarial damage injection for the oracle's negative controls.
 *
 * A green run only means something if the same detectors demonstrably fail on
 * damaged audio. Each function here injects one named defect into a
 * known-good recording; `oracle-adversarial.test.ts` requires the oracle to
 * fail for that specific measured reason, and the clean controls in
 * `cleanControl()` require it to keep passing.
 *
 * Every function is pure and deterministic — the mutations are evidence, so
 * they must be reproducible from the recorded seed alone.
 */

/** Deterministic PRNG (mulberry32) so injected noise is reproducible. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function msToSamples(ms: number, rate: number): number {
  return Math.round((ms / 1000) * rate);
}

function copy(samples: Float32Array): Float32Array {
  return samples.slice();
}

function concat(parts: Float32Array[], totalLength: number): Float32Array {
  const out = new Float32Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Remove the first `ms` of a recording (head-loss control). */
export function trimHead(samples: Float32Array, ms: number, rate: number): Float32Array {
  return samples.slice(msToSamples(ms, rate));
}

/** Remove the last `ms` of a recording (tail-loss control). */
export function trimTail(samples: Float32Array, ms: number, rate: number): Float32Array {
  const cut = samples.length - msToSamples(ms, rate);
  return samples.slice(0, Math.max(1, cut));
}

/** Excise a region entirely (omitted-chunk control). */
export function removeRegion(samples: Float32Array, startSample: number, endSample: number): Float32Array {
  const from = Math.max(0, Math.min(samples.length, Math.floor(startSample)));
  const to = Math.max(from, Math.min(samples.length, Math.floor(endSample)));
  return concat([samples.slice(0, from), samples.slice(to)], samples.length - (to - from));
}

/** Repeat a region immediately after itself (duplicated-chunk control). */
export function duplicateRegion(samples: Float32Array, startSample: number, endSample: number): Float32Array {
  const from = Math.max(0, Math.min(samples.length, Math.floor(startSample)));
  const to = Math.max(from, Math.min(samples.length, Math.floor(endSample)));
  const region = samples.slice(from, to);
  return concat(
    [samples.slice(0, to), region, samples.slice(to)],
    samples.length + region.length
  );
}

/** Swap two equally sized regions (reordered-chunk control). */
export function swapRegions(
  samples: Float32Array,
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
): Float32Array {
  const out = copy(samples);
  const first = samples.slice(firstStart, firstEnd);
  const second = samples.slice(secondStart, secondEnd);
  if (first.length !== second.length) {
    throw new Error('swapRegions requires regions of equal length');
  }
  out.set(second, firstStart);
  out.set(first, secondStart);
  return out;
}

/** Insert digital silence at a point (inserted-gap control). */
export function insertSilence(samples: Float32Array, atSample: number, ms: number, rate: number): Float32Array {
  const at = Math.max(0, Math.min(samples.length, Math.floor(atSample)));
  const silence = new Float32Array(msToSamples(ms, rate));
  return concat([samples.slice(0, at), silence, samples.slice(at)], samples.length + silence.length);
}

/** Scale a region's gain (unintended gain-loss control). */
export function scaleGain(
  samples: Float32Array,
  factor: number,
  fromSample: number,
  toSample: number
): Float32Array {
  const out = copy(samples);
  const from = Math.max(0, Math.min(out.length, Math.floor(fromSample)));
  const to = Math.max(from, Math.min(out.length, Math.floor(toSample)));
  for (let i = from; i < to; i += 1) out[i] *= factor;
  return out;
}

/** Linear resample without updating the declared rate, which is exactly the
 *  wrong-sample-rate defect: the audio plays at the wrong speed/pitch. */
export function resampleToRate(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return copy(samples);
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  const last = samples.length - 1;
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const left = Math.min(last, Math.floor(position));
    const right = Math.min(last, left + 1);
    const frac = position - left;
    out[i] = samples[left] * (1 - frac) + samples[right] * frac;
  }
  return out;
}

/** Keep only the first fraction of a recording (truncated-capture control). */
export function truncateFraction(samples: Float32Array, fraction: number): Float32Array {
  return samples.slice(0, Math.max(1, Math.floor(samples.length * fraction)));
}

/** Replace everything with digital silence (dead-capture control: the
 *  detector must NOT read silence as a pass). */
export function silenceAll(samples: Float32Array): Float32Array {
  return new Float32Array(samples.length);
}

/** Add deterministic noise at the given amplitude (robustness control). */
export function addNoise(samples: Float32Array, amplitude: number, seed = 1): Float32Array {
  const random = createRandom(seed);
  const out = copy(samples);
  for (let i = 0; i < out.length; i += 1) {
    out[i] += (random() * 2 - 1) * amplitude;
  }
  return out;
}

/** Simulate an independent A/D-D/A round trip at another rate (tolerance
 *  control: this is *not* a defect and must keep passing). */
export function roundTripResample(samples: Float32Array, rate: number, targetRate: number): Float32Array {
  return resampleToRate(resampleToRate(samples, rate, targetRate), targetRate, rate);
}

/** Trim/pad the ends to the nearest 10 ms and shorten by one frame — models
 *  the ±10 ms boundary jitter of any real capture, and must keep passing. */
export function jitterBoundaries(samples: Float32Array, rate: number, ms = 10): Float32Array {
  const cut = msToSamples(ms, rate);
  if (samples.length <= cut * 3) return copy(samples);
  return samples.slice(cut, samples.length - cut);
}
