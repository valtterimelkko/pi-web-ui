/**
 * Deterministic synthetic signals for oracle self-tests.
 *
 * These are NOT the lab's speech fixtures. They are cheap, reproducible,
 * distinguishable "pseudo-speech" signals used to prove that the oracle's
 * detectors respond to injected damage and stay quiet on clean audio. Real
 * speech fixtures are built in `fixtures.ts` and compared in the live lane.
 *
 * Each utterance derives a unique formant set from its text, so two chunks are
 * never accidentally interchangeable — a required property, because
 * missing/duplicate/reorder detection is only meaningful when the chunks are
 * distinguishable. Repeating the same text deliberately produces identical
 * audio, which exercises the repeated-text path.
 */

import { createRandom } from './mutate.js';

function hashString(text: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function makeEnvelope(length: number, rate: number, random: () => number): Float32Array {
  // Speech-like amplitude modulation: word-scale bursts separated by short
  // gaps. Three properties matter for the oracle's self-tests:
  //   * the utterance STARTS with audible content (real speech does), so a
  //     leading-silence region is never mistaken for eaten head content;
  //   * most of the utterance is audible, so whole-chunk correlation is
  //     dominated by matched content;
  //   * there are real inter-word gaps, so silence handling is exercised.
  const env = new Float32Array(length);
  const unitSamples = Math.max(1, Math.round(rate * 0.12));
  let gain = 0.9;
  for (let i = 0; i < length; i += 1) {
    if (i % unitSamples === 0) {
      const unit = i / unitSamples;
      const isLastUnit = i + unitSamples >= length;
      // The first two units and the FINAL unit are always audible. Real speech
      // starts with a word and ends with a word; making that deterministic
      // keeps the head/tail-loss controls independent of which seed happened
      // to silence the first or last 120 ms. A gated final unit would make
      // "trim 120 ms of tail" trim only trailing silence, which is correctly
      // not a defect — a test that must exercise tail loss cannot rely on it.
      gain = unit < 2 || isLastUnit || random() > 0.2 ? 0.7 + random() * 0.3 : 0;
    }
    env[i] = gain;
  }
  const fade = Math.min(Math.round(rate * 0.02), Math.floor(length / 4));
  for (let i = 0; i < fade; i += 1) {
    env[i] *= i / fade;
    env[length - 1 - i] *= i / fade;
  }
  // A tiny smoothing pass removes the hard unit edges.
  const smoothed = new Float32Array(length);
  const span = Math.max(1, Math.round(rate * 0.005));
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - span); j <= Math.min(length - 1, i + span); j += 1) {
      sum += env[j];
      count += 1;
    }
    smoothed[i] = sum / count;
  }
  return smoothed;
}

/**
 * Synthesise a deterministic utterance of `durationMs` for `text`.
 * Same text + rate + duration ⇒ byte-identical samples.
 */
export function pseudoSpeech(text: string, durationMs: number, rate: number): Float32Array {
  const seed = hashString(text);
  const random = createRandom(seed);
  const length = Math.max(1, Math.round((durationMs / 1000) * rate));
  const samples = new Float32Array(length);

  const formants = [
    180 + random() * 200,
    500 + random() * 900,
    1200 + random() * 1500,
  ];
  const weights = [1, 0.7 + random() * 0.3, 0.35 + random() * 0.4];
  const jitter = 0.01 + random() * 0.03;

  for (let i = 0; i < length; i += 1) {
    const t = i / rate;
    let value = 0;
    for (let f = 0; f < formants.length; f += 1) {
      // A little vibrato keeps the spectrum from being a pure stationary tone
      // (which would correlate too easily at any offset).
      const freq = formants[f] * (1 + jitter * Math.sin(2 * Math.PI * 2.7 * t));
      value += weights[f] * Math.sin(2 * Math.PI * freq * t);
    }
    samples[i] = value / 2.05;
  }

  const env = makeEnvelope(length, rate, random);
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    samples[i] *= env[i] * 0.6;
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  // Normalise so every utterance has the same peak regardless of the envelope
  // the PRNG happened to produce — the assertion "this chunk is audible" must
  // not depend on a lucky seed.
  if (peak > 0) for (let i = 0; i < length; i += 1) samples[i] *= 0.5 / peak;
  return samples;
}

export interface SignalChunk {
  id: string;
  text: string;
  samples: Float32Array;
}

/** Build an ordered chunk set from texts, each with a deterministic duration. */
export function makeChunks(texts: string[], rate: number, durationMs = 420): SignalChunk[] {
  return texts.map((text, index) => ({
    id: `chunk-${String(index).padStart(2, '0')}`,
    text,
    samples: pseudoSpeech(text, durationMs, rate),
  }));
}

export interface RenderOptions {
  leadInMs?: number;
  tailMs?: number;
  gapMs?: number;
  /** Per-join gap override, e.g. [0, 300] makes join 1-2 300 ms. */
  joinGapsMs?: Array<number | undefined>;
  gain?: number;
}

/** Concatenate chunks with inter-chunk silence: the "clean reference" render. */
export function renderRecording(
  chunks: SignalChunk[],
  rate: number,
  options: RenderOptions = {}
): Float32Array {
  const lead = Math.round(((options.leadInMs ?? 200) / 1000) * rate);
  const tail = Math.round(((options.tailMs ?? 200) / 1000) * rate);
  const gap = Math.round(((options.gapMs ?? 40) / 1000) * rate);
  const parts: Float32Array[] = [new Float32Array(lead)];
  chunks.forEach((chunk, index) => {
    if (index > 0) {
      const override = options.joinGapsMs?.[index - 1];
      const gapSamples = override === undefined ? gap : Math.round((override / 1000) * rate);
      parts.push(new Float32Array(Math.max(0, gapSamples)));
    }
    const scaled = options.gain === undefined ? chunk.samples : chunk.samples.map((v) => v * (options.gain as number));
    parts.push(scaled instanceof Float32Array ? scaled : Float32Array.from(scaled));
  });
  parts.push(new Float32Array(tail));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Where each chunk starts in a `renderRecording` result. */
export function chunkStarts(
  chunks: SignalChunk[],
  rate: number,
  options: RenderOptions = {}
): number[] {
  const lead = Math.round(((options.leadInMs ?? 200) / 1000) * rate);
  const gap = Math.round(((options.gapMs ?? 40) / 1000) * rate);
  const starts: number[] = [];
  let cursor = lead;
  chunks.forEach((chunk, index) => {
    if (index > 0) {
      const override = options.joinGapsMs?.[index - 1];
      cursor += override === undefined ? gap : Math.round((override / 1000) * rate);
    }
    starts.push(cursor);
    cursor += chunk.samples.length;
  });
  return starts;
}
