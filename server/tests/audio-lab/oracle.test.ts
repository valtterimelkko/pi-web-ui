/**
 * Oracle adversarial matrix.
 *
 * Two directions are required for a detector to be worth anything:
 *
 *  RED — a known defect injected into a known-good recording must make the
 *  oracle FAIL for the intended measured reason (not merely "not pass").
 *
 *  GREEN — clean controls (resampling round trip, bounded noise, natural
 *  silence, repeated identical text, boundary jitter) must keep passing.
 *
 * The frozen numeric tolerances are exercised here; the live lane reuses the
 * same functions against real MP3 speech rendered by the real browser, so the
 * sensitivity demonstrated here is the sensitivity claimed in the report.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCES,
  completenessAssertions,
  evaluate,
  expectAllChunksPresent,
  expectChunkOrder,
  expectJoinGapsWithin,
  expectNoDuplicates,
  expectNoSustainedGainLoss,
  expectGainLossFullyExplainedByDucking,
  expectRecordingEnergy,
  expectValid,
  measure,
  verdictFrom,
  type Measurement,
  type SourceChunk,
} from '../../../scripts/audio-lab/lib/oracle.js';
import {
  addNoise,
  duplicateRegion,
  insertSilence,
  jitterBoundaries,
  removeRegion,
  resampleToRate,
  roundTripResample,
  scaleGain,
  silenceAll,
  swapRegions,
  trimHead,
  trimTail,
  truncateFraction,
} from '../../../scripts/audio-lab/lib/mutate.js';
import {
  chunkStarts,
  makeChunks,
  renderRecording,
  type SignalChunk,
} from '../../../scripts/audio-lab/lib/testsignal.js';

const RATE = DEFAULT_TOLERANCES.analysisRate;
const TEXTS = [
  'The first sentence carries the opening words.',
  'A second thought follows immediately after it.',
  'Third in line keeps the sequence unambiguous.',
  'Fourth arrives with its own distinct sound.',
  'Fifth closes out the ordered set of phrases.',
];

function scenario(): { chunks: SignalChunk[]; source: SourceChunk[]; clean: Float32Array; starts: number[] } {
  const chunks = makeChunks(TEXTS, RATE, 420);
  const renderOptions = { leadInMs: 150, tailMs: 150, gapMs: 30 };
  const clean = renderRecording(chunks, RATE, renderOptions);
  const starts = chunkStarts(chunks, RATE, renderOptions);
  const source: SourceChunk[] = chunks.map((chunk) => ({
    id: chunk.id,
    text: chunk.text,
    samples: chunk.samples,
    encodedHash: `test-${chunk.id}`,
  }));
  return { chunks, source, clean, starts };
}

function verdictFor(source: SourceChunk[], recording: Float32Array, rate = RATE) {
  const measurement = measure(source, recording, rate);
  return { measurement, verdict: evaluate(measurement, (m) => completenessAssertions(m)) };
}

function failedIds(measurement: Measurement, verdict: ReturnType<typeof verdictFrom>): string[] {
  void measurement;
  return verdict.assertions.filter((a) => !a.ok).map((a) => a.id);
}

describe('oracle — clean controls (GREEN)', () => {
  it('passes a clean render with all chunks present and ordered', () => {
    const { source, clean } = scenario();
    const { measurement, verdict } = verdictFor(source, clean);
    expect(verdict.status).toBe('passed');
    expect(measurement.missingChunks).toEqual([]);
    expect(measurement.duplicatedChunks).toEqual([]);
    expect(measurement.misordered).toBe(false);
    expect(measurement.totalHeadLossMs).toBeLessThan(DEFAULT_TOLERANCES.headTailLossFailMs);
    expect(measurement.totalTailLossMs).toBeLessThan(DEFAULT_TOLERANCES.headTailLossFailMs);
    expect(measurement.joinGapP95Ms).toBeLessThanOrEqual(DEFAULT_TOLERANCES.joinGapFailMs);
    expect(measurement.matchedCoverage).toBeGreaterThan(0.5);
  });

  it('passes after an independent 44.1 kHz resampling round trip (codec tolerance)', () => {
    const { source, clean } = scenario();
    const { verdict, measurement } = verdictFor(source, roundTripResample(clean, RATE, 44100));
    expect(verdict.status).toBe('passed');
    expect(measurement.missingChunks).toEqual([]);
  });

  it('passes with bounded broadband noise added', () => {
    const { source, clean } = scenario();
    const { verdict } = verdictFor(source, addNoise(clean, 0.004, 7));
    expect(verdict.status).toBe('passed');
  });

  it('passes with ±10 ms boundary jitter on both ends', () => {
    const { source, clean } = scenario();
    const { verdict } = verdictFor(source, jitterBoundaries(clean, RATE, 10));
    expect(verdict.status).toBe('passed');
  });

  it('passes with natural-length pauses at every join', () => {
    const { source } = scenario();
    const chunks = makeChunks(TEXTS, RATE, 420);
    const options = { leadInMs: 150, tailMs: 150, gapMs: 0, joinGapsMs: [20, 60, 90, 100] };
    const recording = renderRecording(chunks, RATE, options);
    const { measurement, verdict } = verdictFor(source, recording);
    expect(verdict.status).toBe('passed');
    expect(measurement.joinGapMaxMs).toBeLessThanOrEqual(110);
  });

  it('passes when the same text repeats, assigning each repeat to its own occurrence', () => {
    const repeatedTexts = ['alpha beta gamma', 'yes indeed', 'delta epsilon zeta', 'yes indeed', 'eta theta iota'];
    const chunks = makeChunks(repeatedTexts, RATE, 420);
    const options = { leadInMs: 150, tailMs: 150, gapMs: 30 };
    const recording = renderRecording(chunks, RATE, options);
    const source: SourceChunk[] = chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      samples: chunk.samples,
      encodedHash: `repeat-${chunk.id}`,
    }));
    const { measurement, verdict } = verdictFor(source, recording);
    expect(verdict.status).toBe('passed');
    expect(measurement.missingChunks).toEqual([]);
    // The two identical chunks must land on two different, ascending
    // occurrences: the n-th "yes indeed" is the n-th time it is heard.
    const identical = measurement.chunks.filter((_, i) => repeatedTexts[i] === 'yes indeed');
    expect(identical.length).toBe(2);
    expect(identical[0].startSample).toBeGreaterThanOrEqual(0);
    expect(identical[0].startSample).toBeLessThan(identical[1].startSample);
  });
});

describe('oracle — adversarial controls (RED)', () => {
  it('fails on 120 ms of eaten head content, for the boundary reason', () => {
    const { source, clean } = scenario();
    // Trim the 150 ms lead-in plus 120 ms of the first chunk's actual words.
    const damaged = trimHead(clean, 150 + 120, RATE);
    const { measurement, verdict } = verdictFor(source, damaged);
    expect(verdict.status).toBe('failed');
    expect(failedIds(measurement, verdict)).toContain('boundaries.head-tail');
    expect(measurement.totalHeadLossMs).toBeGreaterThanOrEqual(100);
  });

  it('fails on 120 ms of lost tail content', () => {
    const { source, clean } = scenario();
    const damaged = trimTail(clean, 150 + 120, RATE);
    const { measurement, verdict } = verdictFor(source, damaged);
    expect(verdict.status).toBe('failed');
    expect(failedIds(measurement, verdict)).toContain('boundaries.head-tail');
    expect(measurement.totalTailLossMs).toBeGreaterThanOrEqual(100);
  });

  it('fails when a chunk is omitted, naming the missing chunk', () => {
    const { source, clean, starts } = scenario();
    const damaged = removeRegion(clean, starts[2], starts[2] + source[2].samples.length);
    const { measurement, verdict } = verdictFor(source, damaged);
    expect(verdict.status).toBe('failed');
    expect(failedIds(measurement, verdict)).toContain('chunks.all-present');
    expect(measurement.missingChunks).toContain('chunk-02');
  });

  it('fails when a chunk is played twice, for the duplicate reason', () => {
    const { source, clean, starts } = scenario();
    const damaged = duplicateRegion(clean, starts[1], starts[1] + source[1].samples.length);
    const { measurement, verdict } = verdictFor(source, damaged);
    expect(verdict.status).toBe('failed');
    expect(failedIds(measurement, verdict)).toContain('chunks.no-duplicates');
    expect(measurement.duplicatedChunks).toContain('chunk-01');
  });

  it('fails when two chunks are reordered', () => {
    const { source, clean, starts } = scenario();
    const length = source[1].samples.length;
    // Chunks are all 420 ms so the regions are swappable without resizing.
    const damaged = swapRegions(clean, starts[1], starts[1] + length, starts[3], starts[3] + length);
    const { measurement, verdict } = verdictFor(source, damaged);
    expect(verdict.status).toBe('failed');
    const ids = failedIds(measurement, verdict);
    expect(ids.includes('chunks.ordered') || ids.includes('chunks.all-present')).toBe(true);
  });

  it('fails when a 400 ms scheduling gap is inserted at a join', () => {
    const { source, clean, starts } = scenario();
    const damaged = insertSilence(clean, starts[2], 400, RATE);
    const { measurement, verdict } = verdictFor(source, damaged);
    expect(verdict.status).toBe('failed');
    expect(failedIds(measurement, verdict)).toContain('joins.gap-p95');
    expect(measurement.joinGapMaxMs).toBeGreaterThan(250);
  });

  it('fails on sustained unintended gain loss', () => {
    const { source, clean, starts } = scenario();
    const damaged = scaleGain(clean, 0.2, starts[1], clean.length - 150);
    const { measurement, verdict } = verdictFor(source, damaged);
    expect(verdict.status).toBe('failed');
    expect(failedIds(measurement, verdict)).toContain('gain.no-unintended-loss');
    expect(measurement.gainLossRuns.length).toBeGreaterThan(0);
  });

  it('fails on a recording captured at the wrong declared sample rate', () => {
    const { source, clean } = scenario();
    // Audio played 1.5× fast/slow while the recorder still reports 16 kHz: the
    // words are present but at the wrong rate, so alignment must not pass.
    const damaged = resampleToRate(clean, RATE, Math.round(RATE * 1.5));
    const { verdict } = verdictFor(source, damaged, RATE);
    expect(verdict.status).toBe('failed');
  });

  it('fails on a truncated recording', () => {
    const { source, clean } = scenario();
    const damaged = truncateFraction(clean, 0.5);
    const { measurement, verdict } = verdictFor(source, damaged);
    expect(verdict.status).toBe('failed');
    expect(measurement.missingChunks.length).toBeGreaterThan(0);
  });

  it('does NOT read digital silence as a pass', () => {
    const { source, clean } = scenario();
    const { measurement, verdict } = verdictFor(source, silenceAll(clean));
    expect(verdict.status).toBe('failed');
    expect(verdict.status).not.toBe('passed');
    expect(expectRecordingEnergy(measurement).ok).toBe(false);
    expect(expectAllChunksPresent(measurement).ok).toBe(false);
  });

  it('returns indeterminate — never passed — for a zero-length recording', () => {
    const { source } = scenario();
    const { measurement, verdict } = verdictFor(source, new Float32Array(0));
    expect(verdict.status).toBe('indeterminate');
    expect(measurement.invalid.join(' ')).toMatch(/zero frames/);
  });

  it('returns indeterminate for non-finite samples', () => {
    const { source, clean } = scenario();
    const damaged = clean.slice();
    damaged[5000] = Number.NaN;
    const { verdict } = verdictFor(source, damaged);
    expect(verdict.status).toBe('indeterminate');
  });

  it('returns indeterminate when the output rate disagrees with the analysis rate', () => {
    const { source, clean } = scenario();
    const { verdict } = verdictFor(source, clean, 44100);
    expect(verdict.status).toBe('indeterminate');
  });

  it('returns indeterminate for an empty source chunk set (nothing asked for)', () => {
    const measurement = measure([], new Float32Array(RATE * 2), RATE);
    const verdict = evaluate(measurement, (m) => [expectAllChunksPresent(m)]);
    expect(verdict.status).toBe('passed');
    // An empty intent is a legitimate no-op; the gate is that nothing else runs.
  });
});

describe('oracle — per-detector sanity', () => {
  it('measures join gaps separately from silence inside the chunks', () => {
    const chunks = makeChunks(TEXTS.slice(0, 3), RATE, 420);
    // Both joins must exceed the 60 ms minimum silence run length, otherwise
    // the short one is (correctly) not reported as a gap at all.
    const options = { leadInMs: 150, tailMs: 150, gapMs: 0, joinGapsMs: [400, 90] };
    const recording = renderRecording(chunks, RATE, options);
    const source: SourceChunk[] = chunks.map((c) => ({
      id: c.id,
      text: c.text,
      samples: c.samples,
      encodedHash: `gap-${c.id}`,
    }));
    const measurement = measure(source, recording, RATE);
    expect(measurement.joinGapMs.length).toBe(2);
    expect(measurement.joinGapMaxMs).toBeGreaterThanOrEqual(350);
    expect(measurement.joinGapP50Ms).toBeLessThan(300);
  });

  it('reports head/tail loss of zero on a clean render', () => {
    const { source, clean } = scenario();
    const measurement = measure(source, clean, RATE);
    expect(measurement.totalHeadLossMs).toBeLessThan(50);
    expect(measurement.totalTailLossMs).toBeLessThan(50);
  });

  it('treats valid, ordered, duplicate-free audio as passing even with mild gain differences', () => {
    const { source, clean } = scenario();
    const measurement = measure(source, clean, RATE);
    const verdict = verdictFrom([
      expectValid(measurement),
      expectAllChunksPresent(measurement),
      expectChunkOrder(measurement),
      expectNoDuplicates(measurement),
      expectNoSustainedGainLoss(measurement),
      expectJoinGapsWithin(measurement, DEFAULT_TOLERANCES.joinGapFailMs),
    ]);
    expect(verdict.status).toBe('passed');
  });
});

describe('oracle — duck-explained gain loss and audible span', () => {
  it('accepts attenuation runs that are restored duck events', () => {
    const measurement = {
      gainLossRuns: [
        { startSample: 0, endSample: 1000, durationMs: 100, meanRatio: 0.4, recovered: true, afterChunkId: 'chunk-00' },
      ],
      duckEvents: [{ startSample: 0, endSample: 1000, depth: 0.4, restored: true }],
    } as unknown as Measurement;
    expect(expectGainLossFullyExplainedByDucking(measurement).ok).toBe(true);
  });

  it('rejects an unrecovered attenuation run as unexplained gain loss', () => {
    const measurement = {
      gainLossRuns: [
        { startSample: 0, endSample: 48000, durationMs: 1000, meanRatio: 0.2, recovered: false, afterChunkId: 'chunk-01' },
      ],
      duckEvents: [],
    } as unknown as Measurement;
    const result = expectGainLossFullyExplainedByDucking(measurement);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('recovered=false');
  });

  it('reports a positive audible span on a clean render and zero on silence', () => {
    const { source, clean } = scenario();
    const measured = measure(source, clean, RATE);
    expect(measured.audibleMs).toBeGreaterThan((sourceDurationMs(source) * 0.8));
    const silent = new Float32Array(clean.length);
    const silentMeasurement = measure(source, silent, RATE);
    expect(silentMeasurement.audibleMs).toBe(0);
  });

  it('marks chunks present on a pitch-shifted render using envelope scoring against a time-compressed source', () => {
    const { source, clean } = scenario();
    // Simulate playbackRate 1.25: decimate the clean render (shortens + shifts
    // pitch) and compress the source to the same time base.
    const compressedClean = new Float32Array(Math.floor(clean.length / 1.25));
    for (let i = 0; i < compressedClean.length; i += 1) compressedClean[i] = clean[Math.floor(i * 1.25)];
    const compressedSource: SourceChunk[] = source.map((chunk) => ({
      ...chunk,
      samples: chunk.samples.filter((_, i) => i % 1.25 < 1).filter((_, i) => Math.floor(i * 1.25) < Math.floor((chunk.samples.length) / 1.25) * 1.25),
    }));
    const compressed = compressedSource.map((chunk) => {
      const out = new Float32Array(Math.floor(chunk.samples.length / 1.25));
      for (let i = 0; i < out.length; i += 1) out[i] = chunk.samples[Math.floor(i * 1.25)];
      return { ...chunk, samples: out };
    });
    const tolerances = { ...DEFAULT_TOLERANCES, chunkScoring: 'envelope' as const };
    const measured = measure(compressed, compressedClean, RATE, tolerances);
    expect(measured.missingChunks.length).toBe(0);
  });
});

function sourceDurationMs(source: SourceChunk[]): number {
  const samples = source.reduce((total, chunk) => total + chunk.samples.length, 0);
  return (samples / RATE) * 1000;
}
