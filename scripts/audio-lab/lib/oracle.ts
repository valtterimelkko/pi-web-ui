/**
 * The deterministic audio oracle.
 *
 * Input: the decoded source fixtures (the exact MP3 bytes the player was asked
 * to speak) and the independent OS-level recording of what the browser
 * actually rendered. Output: a structured measurement plus a three-state
 * verdict.
 *
 * Design rules that keep verdicts honest:
 *
 *  - Alignment is derived from the AUDIO, never from timestamps. Timestamps
 *    are used only to explain a measurement, so a skewed clock cannot turn a
 *    broken render into a passing one.
 *  - Chunk ordering is resolved by monotonic sequence alignment (dynamic
 *    programming over every candidate occurrence), not by greedy per-chunk
 *    search. That is what makes repeated identical text ("Yes. Yes. Yes.")
 *    work: the n-th identical chunk is assigned to the n-th occurrence, and a
 *    genuine reorder forces a chunk out of the monotonic path.
 *  - `indeterminate` is a first-class outcome: an empty recording, a NaN, a
 *    rate mismatch or a sub-second capture can never be scored as a pass.
 *  - Every detector has an adversarial control in `mutate.ts` that must make
 *    it fail. A detector that cannot fail on damaged audio is not a detector.
 */

import {
  bestEnvelopeLag,
  dbfsToAmplitude,
  envelope,
  envelopePeakLags,
  frameToSample,
  refineLagSamples,
  rms,
  silenceRuns,
  type Envelope,
} from './dsp.js';

/** Frozen tolerance set. Changing any of these requires new RED evidence —
 *  the oracle must never be quietly loosened to manufacture a green run. */
export interface OracleTolerances {
  /** Analysis rate for alignment and scoring (speech band). */
  analysisRate: number;
  envelopeWindowMs: number;
  envelopeHopMs: number;
  /** Minimum normalised envelope correlation for a chunk to count as present. */
  chunkMatchMin: number;
  /** Candidates below this are not even considered by the alignment DP. */
  candidateFloor: number;
  /** Minimum separation between two distinct candidate occurrences. */
  candidateSeparationMs: number;
  maxCandidatesPerChunk: number;
  /** Search radius around a segment's expected position when re-scoring it. */
  probeSearchMs: number;
  firstChunkSearchMs: number;
  /** Head/tail loss at or above this is a functional failure. */
  headTailLossFailMs: number;
  /** A silence run at a chunk join above this fails; p50/p95/max are reported. */
  joinGapFailMs: number;
  silenceThresholdDb: number;
  silenceMinMs: number;
  /** Sustained level below this fraction of the matched-source level is
   *  "unintended gain loss" (intentional ducking measures ~0.15). */
  gainLossMinRatio: number;
  gainLossMinMs: number;
  duckRatio: number;
  duckRestoreRatio: number;
  /** Maximum timestamp inconsistency tolerated between events and capture. */
  timestampSkewFailMs: number;
  minRecordingSeconds: number;
  /** Minimum content coverage a recording must explain to be scorable. */
  minCoverageForValidity: number;
}

export const DEFAULT_TOLERANCES: OracleTolerances = {
  analysisRate: 16000,
  envelopeWindowMs: 10,
  envelopeHopMs: 5,
  chunkMatchMin: 0.6,
  candidateFloor: 0.35,
  candidateSeparationMs: 200,
  maxCandidatesPerChunk: 16,
  probeSearchMs: 80,
  firstChunkSearchMs: 8000,
  headTailLossFailMs: 100,
  joinGapFailMs: 100,
  silenceThresholdDb: -45,
  silenceMinMs: 60,
  gainLossMinRatio: 0.5,
  gainLossMinMs: 200,
  duckRatio: 0.5,
  duckRestoreRatio: 0.8,
  timestampSkewFailMs: 750,
  minRecordingSeconds: 1,
  minCoverageForValidity: 0,
};

export interface SourceChunk {
  /** Stable id (e.g. `chunk-03`) used in reports and assertions. */
  id: string;
  text: string;
  /** Mono PCM already resampled to `tolerances.analysisRate`. */
  samples: Float32Array;
  /** SHA-256 of the exact encoded bytes served as this chunk's audio. */
  encodedHash: string;
}

export type ChunkStatus = 'present' | 'missing' | 'misordered';

export interface ChunkMeasurement {
  id: string;
  index: number;
  score: number;
  startSample: number;
  endSample: number;
  durationMs: number;
  status: ChunkStatus;
  headLossMs: number;
  tailLossMs: number;
  duplicateAtSample: number | null;
  duplicateScore: number;
  minProbeScore: number;
}

export interface GapMeasurement {
  startSample: number;
  durationMs: number;
  kind: 'join' | 'intra' | 'lead' | 'tail' | 'unexplained';
  afterChunkId: string | null;
}

export interface GainLossRun {
  startSample: number;
  durationMs: number;
  meanRatio: number;
  minRatio: number;
  recovered: boolean;
  afterChunkId: string | null;
}

export interface Measurement {
  analysisRate: number;
  recordingSeconds: number;
  recordingFrames: number;
  recordingPeak: number;
  recordingRmsDbfs: number;
  noiseFloorDbfs: number;
  sourceDurationMs: number;
  /** Overall output/source level ratio across matched regions (median). */
  levelRatio: number;
  /** Loud reference level (90th percentile of matched-frame ratios) used to
   *  decide what counts as unintended attenuation. */
  referenceRatio: number;
  chunks: ChunkMeasurement[];
  gaps: GapMeasurement[];
  joinGapMs: number[];
  joinGapP50Ms: number;
  joinGapP95Ms: number;
  joinGapMaxMs: number;
  gainLossRuns: GainLossRun[];
  duckEvents: Array<{ startSample: number; endSample: number; depth: number; restored: boolean }>;
  totalHeadLossMs: number;
  totalTailLossMs: number;
  duplicatedChunks: string[];
  missingChunks: string[];
  misordered: boolean;
  /** Fraction of recording frames covered by an assigned chunk region. */
  matchedCoverage: number;
  /** Content with no source explanation, above the silence threshold. */
  unexplainedMs: number;
  /** Populated when the measurement itself is untrustworthy. */
  invalid: string[];
}

export interface AssertionResult {
  id: string;
  ok: boolean;
  detail: string;
  /** An assertion that could not be evaluated marks the scenario indeterminate. */
  indeterminate?: boolean;
}

export type VerdictStatus = 'passed' | 'failed' | 'indeterminate';

export interface Verdict {
  status: VerdictStatus;
  assertions: AssertionResult[];
  reasons: string[];
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function msToSamples(ms: number, rate: number): number {
  return Math.round((ms / 1000) * rate);
}

function hasNonFinite(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i])) return true;
  }
  return false;
}

function peakOf(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > max) max = value;
  }
  return max;
}

export interface ChunkCandidate {
  lagSamples: number;
  /** Sample-domain normalised correlation — content-specific. */
  score: number;
  /** Envelope correlation at the same lag (diagnostic only). */
  envelopeScore: number;
}

/** Every distinct occurrence of a chunk's audio in the recording, above the
 *  candidate floor.
 *
 *  Two-stage on purpose. The RMS envelope is cheap enough to scan the whole
 *  recording, but it is NOT discriminative: the envelope of any two spoken
 *  sentences is a similar pattern of bursts and pauses, so envelope-only
 *  scoring reports high confidence for a chunk at another chunk's position
 *  (measured: a removed chunk still "matched" at 0.98 on a neighbour). Each
 *  envelope peak is therefore re-scored on the sample waveform, which is
 *  voice- and content-specific, and the waveform score is what the caller
 *  thresholds on. */
export function findChunkCandidates(
  chunk: SourceChunk,
  env: Envelope,
  output: Float32Array,
  tolerances: OracleTolerances
): ChunkCandidate[] {
  const rate = tolerances.analysisRate;
  if (chunk.samples.length === 0 || output.length === 0) return [];
  const chunkEnv = envelope(chunk.samples, rate, tolerances.envelopeWindowMs, tolerances.envelopeHopMs);
  if (chunkEnv.values.length === 0) return [];
  const searchFrames = Math.max(1, env.values.length);
  const minSeparationFrames = Math.max(
    1,
    Math.round(msToSamples(tolerances.candidateSeparationMs, rate) / env.hopSamples)
  );
  const peaks = envelopePeakLags(
    chunkEnv,
    env,
    searchFrames,
    // A low envelope floor here: the waveform re-score does the rejecting.
    0.2,
    tolerances.maxCandidatesPerChunk,
    minSeparationFrames
  );
  const candidates: ChunkCandidate[] = [];
  for (const peak of peaks) {
    const coarse = peak.lagFrames * env.hopSamples;
    const refined = refineLagSamples(
      chunk.samples,
      output,
      coarse,
      Math.max(16, env.hopSamples),
      chunk.samples.length
    );
    candidates.push({ lagSamples: refined.lagSamples, score: refined.score, envelopeScore: peak.score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

interface AlignmentNode {
  /** Index into the candidate list of this node's own layer. */
  candidateIndex: number;
  /** Which chunk layer this node belongs to. */
  layerIndex: number;
  /** Cumulative best score of the monotonic chain ending at this node. */
  score: number;
  previous: AlignmentNode | null;
}

/** Monotonic maximum-score assignment of chunks to candidate occurrences.
 *  Leaving a chunk unmatched costs exactly `chunkMatchMin`, so a chunk is
 *  dropped only when no in-order candidate beats that. */
export function alignMonotonic(
  candidatesPerChunk: ChunkCandidate[][],
  chunkMatchMin: number
): Array<ChunkCandidate | null> {
  const layers: AlignmentNode[][] = [];
  for (let i = 0; i < candidatesPerChunk.length; i += 1) {
    const layer: AlignmentNode[] = [];
    for (const candidate of candidatesPerChunk[i]) {
      let bestPreviousScore = 0;
      let bestPrevious: AlignmentNode | null = null;
      for (const previousLayer of layers) {
        for (const node of previousLayer) {
          if (node.score <= bestPreviousScore) continue;
          const previousCandidate = candidatesPerChunk[node.layerIndex][node.candidateIndex];
          if (previousCandidate.lagSamples >= candidate.lagSamples) continue;
          bestPreviousScore = node.score;
          bestPrevious = node;
        }
      }
      layer.push({
        candidateIndex: layer.length,
        layerIndex: i,
        score: bestPreviousScore + candidate.score,
        previous: bestPrevious,
      });
    }
    layers.push(layer);
  }

  // Best final node by total score, including the option of stopping early.
  let best: { node: AlignmentNode | null; layerIndex: number; score: number } = {
    node: null,
    layerIndex: -1,
    score: 0,
  };
  for (let i = 0; i < layers.length; i += 1) {
    for (const node of layers[i]) {
      if (node.score > best.score) best = { node, layerIndex: i, score: node.score };
    }
  }

  const assignment: Array<ChunkCandidate | null> = new Array(candidatesPerChunk.length).fill(null);
  let node: AlignmentNode | null = best.node;
  while (node) {
    assignment[node.layerIndex] = candidatesPerChunk[node.layerIndex][node.candidateIndex];
    node = node.previous;
  }
  // A matched candidate that cannot beat the "leave unmatched" penalty is not
  // evidence of speech: drop it so it reports as missing, not as a weak match.
  for (let i = 0; i < assignment.length; i += 1) {
    const candidate = assignment[i];
    if (candidate && candidate.score < chunkMatchMin) assignment[i] = null;
  }
  return assignment;
}

interface BoundaryResult {
  headLossMs: number;
  tailLossMs: number;
  /** Correlation of each third of the chunk against the recording, with a
   *  lag tolerance — diagnostic for damage that is inside a chunk rather than
   *  at its edges. */
  segmentScores: number[];
  minProbeScore: number;
}
/** Envelope-frame activity mask relative to the signal's own peak. */
function activeFrames(env: Envelope, relativeFloor: number): { first: number; last: number; peak: number } {
  let peak = 0;
  for (let i = 0; i < env.values.length; i += 1) {
    if (env.values[i] > peak) peak = env.values[i];
  }
  const floor = Math.max(peak * relativeFloor, 1e-6);
  let first = -1;
  let last = -1;
  for (let i = 0; i < env.values.length; i += 1) {
    if (env.values[i] >= floor) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return { first, last, peak };
}

/**
 * Head/tail loss by comparing where audible content actually STARTS and ENDS
 * inside the aligned chunk region, against where it starts and ends in the
 * source.
 *
 * This deliberately does not probe fixed windows for "presence": a window that
 * falls on an intra-word pause in the source correlates with nothing, so a
 * probe-based detector reports ~150 ms of phantom head loss on perfectly clean
 * speech (which is exactly what an early version of this oracle did).
 * Comparing content onset/offset positions is frame-accurate, insensitive to
 * inter-word pauses, and directly expressible in milliseconds.
 */
function measureBoundaries(
  chunk: SourceChunk,
  output: Float32Array,
  startSample: number,
  tolerances: OracleTolerances
): BoundaryResult {
  const rate = tolerances.analysisRate;
  const chunkMs = (chunk.samples.length / rate) * 1000;
  if (chunk.samples.length === 0) {
    return { headLossMs: chunkMs, tailLossMs: 0, segmentScores: [], minProbeScore: 0 };
  }

  const srcEnv = envelope(chunk.samples, rate, tolerances.envelopeWindowMs, tolerances.envelopeHopMs);
  const src = activeFrames(srcEnv, 0.06);

  // The aligned region is [startSample, startSample + chunkLength). It can
  // begin before sample 0 when a chunk's head was eaten: the recording starts
  // mid-chunk, so the alignment legitimately lands at a negative offset. Only
  // the intersection with the recording is audible.
  const regionStart = startSample;
  const regionEnd = startSample + chunk.samples.length;
  const visibleStart = Math.max(0, regionStart);
  const visibleEnd = Math.min(output.length, regionEnd);

  let headLossMs = 0;
  let tailLossMs = 0;
  if (src.first < 0) {
    // The source carries no audible content of its own.
    headLossMs = 0;
    tailLossMs = 0;
  } else if (visibleEnd <= visibleStart) {
    // The chunk falls entirely outside the recording.
    headLossMs = chunkMs;
    tailLossMs = 0;
  } else {
    const regionEnv = envelope(
      output.subarray(visibleStart, visibleEnd),
      rate,
      tolerances.envelopeWindowMs,
      tolerances.envelopeHopMs
    );
    const out = activeFrames(regionEnv, 0.06);
    if (out.first < 0 || out.peak < 1e-5) {
      headLossMs = chunkMs;
      tailLossMs = 0;
    } else {
      // Convert the output's content extent into source coordinates using the
      // alignment, then compare with the source's own content extent. Loss is
      // the part of the source's content that has no counterpart in the
      // recording. Note this is CONTENT loss: losing 120 ms of leading silence
      // that precedes the first word is not a listener-visible defect, and is
      // reported as 0 ms rather than inflated into a failure.
      const outFirstInSource = visibleStart + out.first * regionEnv.hopSamples - regionStart;
      const outLastInSource = visibleStart + out.last * regionEnv.hopSamples - regionStart;
      headLossMs = Math.max(
        0,
        Math.min(chunkMs, ((outFirstInSource - src.first * srcEnv.hopSamples) / rate) * 1000)
      );
      tailLossMs = Math.max(
        0,
        Math.min(chunkMs, ((src.last * srcEnv.hopSamples - outLastInSource) / rate) * 1000)
      );
    }
  }

  // Segment diagnostics: three windows across the chunk, each correlated
  // against a search window around its expected position.
  const searchSamples = msToSamples(tolerances.probeSearchMs, rate);
  const segmentScores: number[] = [];
  const windowSamples = Math.max(1, Math.floor(chunk.samples.length / 3));
  for (let s = 0; s < 3; s += 1) {
    if (chunk.samples.length < 3) break;
    const offset = s * windowSamples;
    const segment = chunk.samples.subarray(offset, Math.min(chunk.samples.length, offset + windowSamples));
    const segmentEnv = envelope(segment, rate, tolerances.envelopeWindowMs, tolerances.envelopeHopMs);
    if (segmentEnv.values.length === 0) continue;
    const expected = startSample + offset;
    const cropStart = Math.max(0, expected - searchSamples);
    const cropEnd = Math.min(output.length, expected + windowSamples + searchSamples);
    if (cropEnd <= cropStart) continue;
    const croppedEnv = envelope(
      output.subarray(cropStart, cropEnd),
      rate,
      tolerances.envelopeWindowMs,
      tolerances.envelopeHopMs
    );
    const best = bestEnvelopeLag(segmentEnv, croppedEnv, croppedEnv.values.length);
    segmentScores.push(best.score);
  }
  const minProbeScore = segmentScores.length === 0 ? 0 : Math.min(...segmentScores);
  return { headLossMs, tailLossMs, segmentScores, minProbeScore };
}

/** Full measurement of one recording against the ordered source chunks. */
export function measure(
  chunks: SourceChunk[],
  output: Float32Array,
  outputSampleRate: number,
  tolerances: OracleTolerances = DEFAULT_TOLERANCES
): Measurement {
  const rate = tolerances.analysisRate;
  const invalid: string[] = [];
  const recordingSeconds = output.length / outputSampleRate;

  if (outputSampleRate !== rate) {
    // The caller resamples; a mismatch here is a harness bug, not a product
    // fault, and must never be silently tolerated.
    invalid.push(`output sample rate ${outputSampleRate} != analysis rate ${rate}`);
  }
  if (output.length === 0) invalid.push('recording contains zero frames');
  if (hasNonFinite(output)) invalid.push('recording contains non-finite samples');
  if (output.length > 0 && recordingSeconds < tolerances.minRecordingSeconds) {
    invalid.push(`recording shorter than ${tolerances.minRecordingSeconds}s floor`);
  }
  for (const chunk of chunks) {
    if (chunk.samples.length === 0) invalid.push(`source chunk ${chunk.id} has zero samples`);
    if (hasNonFinite(chunk.samples)) invalid.push(`source chunk ${chunk.id} has non-finite samples`);
  }

  const env = envelope(output, rate, tolerances.envelopeWindowMs, tolerances.envelopeHopMs);
  const recordingPeak = output.length === 0 ? 0 : peakOf(output);
  const recordingRms = rms(output);
  const leadInSamples = Math.min(output.length, msToSamples(80, rate));
  const noiseFloorDbfs =
    output.length === 0 ? -120 : 20 * Math.log10(Math.max(rms(output, 0, leadInSamples), 1e-12));
  const sourceDurationMs = chunks.reduce((sum, c) => sum + (c.samples.length / rate) * 1000, 0);

  // ---- candidates + monotonic alignment ----------------------------------
  const candidatesPerChunk = chunks.map((chunk) =>
    output.length === 0 ? [] : findChunkCandidates(chunk, env, output, tolerances)
  );  const assignment = alignMonotonic(candidatesPerChunk, tolerances.chunkMatchMin);

  const measured: ChunkMeasurement[] = [];
  const assignedRegions: Array<{ start: number; end: number; chunkIndex: number }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const chunkMs = (chunk.samples.length / rate) * 1000;
    const candidate = assignment[index];
    const bestUnconstrained = candidatesPerChunk[index].reduce(
      (best, c) => (c.score > best.score ? c : best),
      { lagSamples: -1, score: 0 }
    );

    if (!candidate) {
      // Present but out of order? Then it is misordered, not missing — the
      // words were audible, just in the wrong place.
      const outOfOrder =
        bestUnconstrained.score >= tolerances.chunkMatchMin &&
        assignedRegions.some((region) => region.start > bestUnconstrained.lagSamples);
      measured.push({
        id: chunk.id,
        index,
        score: bestUnconstrained.score,
        startSample: outOfOrder ? bestUnconstrained.lagSamples : -1,
        endSample: outOfOrder ? bestUnconstrained.lagSamples + chunk.samples.length : -1,
        durationMs: chunkMs,
        status: outOfOrder ? 'misordered' : 'missing',
        headLossMs: chunkMs,
        tailLossMs: 0,
        duplicateAtSample: null,
        duplicateScore: 0,
        minProbeScore: 0,
      });
      if (outOfOrder) {
        assignedRegions.push({
          start: bestUnconstrained.lagSamples,
          end: bestUnconstrained.lagSamples + chunk.samples.length,
          chunkIndex: index,
        });
      }
      continue;
    }

    const probes = measureBoundaries(chunk, output, candidate.lagSamples, tolerances);
    measured.push({
      id: chunk.id,
      index,
      score: candidate.score,
      startSample: candidate.lagSamples,
      endSample: candidate.lagSamples + chunk.samples.length,
      durationMs: chunkMs,
      status: 'present',
      headLossMs: probes.headLossMs,
      tailLossMs: probes.tailLossMs,
      duplicateAtSample: null,
      duplicateScore: 0,
      minProbeScore: probes.minProbeScore,
    });
    assignedRegions.push({
      start: candidate.lagSamples,
      end: candidate.lagSamples + chunk.samples.length,
      chunkIndex: index,
    });
  }

  const matched = measured.filter((m) => m.status === 'present' || m.status === 'misordered');
  let misordered = measured.some((m) => m.status === 'misordered');
  for (let i = 1; i < matched.length && !misordered; i += 1) {
    if (matched[i].startSample < matched[i - 1].startSample) misordered = true;
  }

  // ---- duplicate detection: unexplained repeated chunk audio --------------
  // 10 ms resolution: fine enough that a duplicated half-second chunk cannot
  // hide behind a coarse "this second was covered" bit.
  const coverageBinSamples = Math.max(1, Math.round(rate / 100));
  const coverageMask = new Uint8Array(
    Math.max(1, Math.ceil(output.length / coverageBinSamples) + 1)
  );
  const markCov = (from: number, to: number) => {
    const a = Math.max(0, Math.floor(from / coverageBinSamples));
    const b = Math.min(coverageMask.length, Math.ceil(to / coverageBinSamples));
    for (let i = a; i < b; i += 1) coverageMask[i] = 1;
  };
  for (const region of assignedRegions) markCov(region.start, region.end);

  const duplicatedChunks: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    for (const candidate of candidatesPerChunk[index]) {
      if (candidate.score < tolerances.chunkMatchMin) continue;
      const from = Math.floor(candidate.lagSamples / coverageBinSamples);
      const to = Math.min(
        coverageMask.length,
        Math.ceil((candidate.lagSamples + chunk.samples.length) / coverageBinSamples)
      );
      let covered = 0;
      for (let i = Math.max(0, from); i < to; i += 1) if (coverageMask[i] === 1) covered += 1;
      const span = Math.max(1, to - Math.max(0, from));
      const coveredFraction = covered / span;
      if (coveredFraction < 0.25) {
        const entry = measured[index];
        const assigned = assignment[index];
        const scoreFloor = assigned ? Math.max(tolerances.chunkMatchMin, assigned.score * 0.8) : tolerances.chunkMatchMin;
        if (candidate.score < scoreFloor) continue;
        if (entry.duplicateAtSample === null || candidate.score > entry.duplicateScore) {
          entry.duplicateAtSample = candidate.lagSamples;
          entry.duplicateScore = candidate.score;
        }
        if (!duplicatedChunks.includes(chunk.id)) duplicatedChunks.push(chunk.id);
      }
    }
  }

  // ---- level ratio, gain loss, ducking ------------------------------------
  // The reference level is the LOUD (90th percentile) part of the matched
  // audio, not the median. A defect that attenuates most of a reading must not
  // be able to move the reference down with it: with a median reference, a
  // reading that is uniformly quiet looks perfectly normal to itself.
  const gains: { sample: number; ratio: number; chunkId: string }[] = [];
  const frameSamples = msToSamples(20, rate);
  for (const entry of matched) {
    const chunk = chunks[entry.index];
    const skipSamples = Math.max(0, msToSamples(entry.headLossMs, rate));
    for (let offset = skipSamples; offset + frameSamples <= chunk.samples.length; offset += frameSamples) {
      const sourceRms = rms(chunk.samples, offset, offset + frameSamples);
      const outStart = entry.startSample + offset;
      if (sourceRms < dbfsToAmplitude(-50) || outStart + frameSamples > output.length) continue;
      if (entry.startSample < 0) continue;
      const outRms = rms(output, outStart, outStart + frameSamples);
      gains.push({ sample: outStart, ratio: outRms / sourceRms, chunkId: entry.id });
    }
  }
  const levelRatio = median(gains.map((g) => g.ratio));
  const referenceRatio = percentile(gains.map((g) => g.ratio), 0.9);

  const gainLossRuns: GainLossRun[] = [];
  const duckEvents: Measurement['duckEvents'] = [];
  let runStart = -1;
  for (let i = 0; i <= gains.length; i += 1) {
    const below =
      i < gains.length &&
      referenceRatio > 0 &&
      gains[i].ratio < tolerances.gainLossMinRatio * referenceRatio;
    if (below && runStart < 0) runStart = i;
    if (!below && runStart >= 0) {
      const slice = gains.slice(runStart, i);
      const durationMs = slice.length * 20;
      if (durationMs >= tolerances.gainLossMinMs) {
        const meanRatio = slice.reduce((s, g) => s + g.ratio, 0) / slice.length;
        const minRatio = Math.min(...slice.map((g) => g.ratio));
        const after = gains[i];
        const recovered =
          after !== undefined && referenceRatio > 0 && after.ratio >= tolerances.duckRestoreRatio * referenceRatio;
        gainLossRuns.push({
          startSample: slice[0].sample,
          durationMs,
          meanRatio,
          minRatio,
          recovered,
          afterChunkId: slice[0].chunkId,
        });
        if (referenceRatio > 0 && meanRatio < tolerances.duckRatio * referenceRatio) {
          duckEvents.push({
            startSample: slice[0].sample,
            endSample: slice[slice.length - 1].sample + frameSamples,
            depth: meanRatio / referenceRatio,
            restored: recovered,
          });
        }
      }
      runStart = -1;
    }
  }

  // ---- silence runs, gap classification, unexplained content --------------
  const runs = output.length === 0 ? [] : silenceRuns(env, tolerances.silenceThresholdDb, tolerances.silenceMinMs);
  const gaps: GapMeasurement[] = [];
  const joinGaps: number[] = [];
  const orderedAssigned = [...assignedRegions].sort((a, b) => a.start - b.start);
  let matchedSamples = 0;
  for (const region of orderedAssigned) {
    matchedSamples += Math.max(0, Math.min(output.length, region.end) - Math.max(0, region.start));
  }

  // Is the SOURCE silent across this output interval? Natural inter-word
  // pauses live inside the source chunks; only silence the source does not
  // account for is a defect. Without this check every inter-word pause is
  // reported as an inserted gap, which is noise, not measurement.
  const sourceSilentAt = (start: number, end: number): boolean => {
    const region = orderedAssigned.find((r) => start >= r.start && start < r.end);
    if (!region) return false;
    const chunk = chunks[region.chunkIndex];
    if (!chunk) return false;
    // Shrink by an inset rather than expand by a margin: the detected run's
    // edges are blurred by the envelope window and its smoothing, so the
    // edges can reach into an adjacent audible unit. Judging the run's core
    // asks the question we actually mean — "is the source quiet here?".
    const inset = msToSamples(15, rate);
    const from = Math.max(0, start - region.start + inset);
    const to = Math.min(chunk.samples.length, end - region.start - inset);
    if (to <= from) return false;
    const localPeak = peakOf(chunk.samples);
    if (localPeak <= 0) return true;
    return peakOf(chunk.samples.subarray(from, to)) < localPeak * 0.05;
  };

  let unexplainedSamples = 0;
  for (const run of runs) {
    const start = run.startSample;
    const end = run.endSample;
    const containingIndex = orderedAssigned.findIndex((r) => r.start <= start && end <= r.end);
    let kind: GapMeasurement['kind'];
    let afterChunkId: string | null = null;
    if (containingIndex >= 0) {
      kind = 'intra';
      afterChunkId = chunks[orderedAssigned[containingIndex].chunkIndex]?.id ?? null;
      // Silence that the source itself contains is expected, not unexplained.
      if (!sourceSilentAt(start, end)) unexplainedSamples += end - start;
    } else {
      let beforeIndex = -1;
      for (let i = 0; i < orderedAssigned.length; i += 1) {
        if (orderedAssigned[i].end <= start) beforeIndex = i;
      }
      let afterIndex = -1;
      for (let i = 0; i < orderedAssigned.length; i += 1) {
        if (orderedAssigned[i].start >= end) {
          afterIndex = i;
          break;
        }
      }
      if (afterIndex >= 0 && beforeIndex >= 0 && beforeIndex + 1 === afterIndex) {
        // A genuine inter-chunk join: the gap sits between two consecutive
        // assigned chunks, with no other assigned chunk in between.
        kind = 'join';
        afterChunkId = chunks[orderedAssigned[beforeIndex].chunkIndex]?.id ?? null;
        joinGaps.push(run.durationMs);
      } else if (beforeIndex < 0 && afterIndex >= 0) {
        kind = 'lead';
      } else if (beforeIndex >= 0 && afterIndex < 0) {
        kind = 'tail';
      } else {
        kind = 'tail';
      }
    }
    gaps.push({ startSample: start, durationMs: run.durationMs, kind, afterChunkId });
  }
  // Non-silent audio outside every assigned chunk region is unexplained: this
  // is what catches a duplicated chunk, which is audible but unaccounted for.
  // Regions between assigned chunks are examined explicitly, and so are the
  // lead-in and tail-out (a loud lead-in is not a quiet capture).
  const loudOutsideRuns = (from: number, to: number): boolean => {
    if (to <= from) return false;
    let cursor = from;
    for (const run of runs) {
      if (run.endSample <= cursor || run.startSample >= to) continue;
      const segStart = Math.max(cursor, run.startSample);
      if (segStart > cursor && rms(output, cursor, segStart) > dbfsToAmplitude(tolerances.silenceThresholdDb)) {
        return true;
      }
      cursor = Math.max(cursor, run.endSample);
    }
    return cursor < to && rms(output, cursor, to) > dbfsToAmplitude(tolerances.silenceThresholdDb);
  };
  const addUnexplained = (from: number, to: number, afterChunkId: string | null) => {
    if (!loudOutsideRuns(from, to)) return;
    unexplainedSamples += to - from;
    gaps.push({
      startSample: from,
      durationMs: ((to - from) / rate) * 1000,
      kind: 'unexplained',
      afterChunkId,
    });
  };
  if (orderedAssigned.length > 0) {
    addUnexplained(0, orderedAssigned[0].start, null);
    addUnexplained(orderedAssigned[orderedAssigned.length - 1].end, output.length, null);
    for (let i = 1; i < orderedAssigned.length; i += 1) {
      addUnexplained(
        orderedAssigned[i - 1].end,
        orderedAssigned[i].start,
        chunks[orderedAssigned[i - 1].chunkIndex]?.id ?? null
      );
    }
  }

  const missing = measured.filter((m) => m.status === 'missing').map((m) => m.id);
  const presentOrdered = measured.filter((m) => m.status === 'present');
  const totalHeadLossMs = presentOrdered.length > 0 ? presentOrdered[0].headLossMs : 0;
  const totalTailLossMs = presentOrdered.length > 0 ? presentOrdered[presentOrdered.length - 1].tailLossMs : 0;

  const matchedCoverage = output.length === 0 ? 0 : Math.min(1, matchedSamples / output.length);
  if (
    output.length > 0 &&
    invalid.length === 0 &&
    matched.length > 0 &&
    matchedCoverage < tolerances.minCoverageForValidity
  ) {
    invalid.push(`matched coverage ${(matchedCoverage * 100).toFixed(1)}% below validity floor`);
  }

  return {
    analysisRate: rate,
    recordingSeconds,
    recordingFrames: output.length,
    recordingPeak,
    recordingRmsDbfs: output.length === 0 ? -120 : 20 * Math.log10(Math.max(recordingRms, 1e-12)),
    noiseFloorDbfs,
    sourceDurationMs,
    levelRatio,
  referenceRatio,
    chunks: measured,
    gaps,
    joinGapMs: joinGaps,
    joinGapP50Ms: percentile(joinGaps, 0.5),
    joinGapP95Ms: percentile(joinGaps, 0.95),
    joinGapMaxMs: joinGaps.length === 0 ? 0 : Math.max(...joinGaps),
    gainLossRuns,
    duckEvents,
    totalHeadLossMs,
    totalTailLossMs,
    duplicatedChunks,
    missingChunks: missing,
    misordered,
    matchedCoverage,
    unexplainedMs: (unexplainedSamples / rate) * 1000,
    invalid,
  };
}

/** First sample whose envelope crosses the content threshold (diagnostic). */
export function contentOnsetMs(output: Float32Array, rate: number, thresholdDb = -45): number | null {
  const env = envelope(output, rate, 10, 5);
  const threshold = dbfsToAmplitude(thresholdDb);
  for (let i = 0; i < env.values.length; i += 1) {
    if (env.values[i] >= threshold) return (frameToSample(env, i) / rate) * 1000;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assertions: declarative gates the scenarios compose. Each returns a result
// with a stable id so a report can name exactly which gate failed.
// ---------------------------------------------------------------------------

export function expectValid(measurement: Measurement): AssertionResult {
  return {
    id: 'measurement.valid',
    ok: measurement.invalid.length === 0,
    indeterminate: measurement.invalid.length > 0,
    detail: measurement.invalid.length === 0 ? 'measurement inputs well-formed' : measurement.invalid.join('; '),
  };
}

export function expectAllChunksPresent(measurement: Measurement): AssertionResult {
  const missing = measurement.missingChunks;
  return {
    id: 'chunks.all-present',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `${measurement.chunks.length} chunks matched`
        : `missing: ${missing.join(', ')}`,
  };
}

export function expectChunkOrder(measurement: Measurement): AssertionResult {
  return {
    id: 'chunks.ordered',
    ok: !measurement.misordered,
    detail: measurement.misordered
      ? 'matched chunk positions are not monotonically ordered'
      : 'chunk order preserved',
  };
}

export function expectNoDuplicates(measurement: Measurement): AssertionResult {
  return {
    id: 'chunks.no-duplicates',
    ok: measurement.duplicatedChunks.length === 0,
    detail:
      measurement.duplicatedChunks.length === 0
        ? 'no repeated chunk audio detected'
        : `duplicated: ${measurement.duplicatedChunks.join(', ')}`,
  };
}

export function expectHeadTailWithin(measurement: Measurement, limitMs: number): AssertionResult {
  const ok = measurement.totalHeadLossMs < limitMs && measurement.totalTailLossMs < limitMs;
  return {
    id: 'boundaries.head-tail',
    ok,
    detail: `head loss ${measurement.totalHeadLossMs.toFixed(0)} ms, tail loss ${measurement.totalTailLossMs.toFixed(0)} ms (limit <${limitMs} ms)`,
  };
}

export function expectJoinGapsWithin(measurement: Measurement, limitMs: number): AssertionResult {
  const offending = measurement.joinGapMs.filter((gap) => gap > limitMs);
  return {
    id: 'joins.gap-p95',
    ok: offending.length === 0,
    detail:
      measurement.joinGapMs.length === 0
        ? 'no inter-chunk silence detected'
        : `p50 ${measurement.joinGapP50Ms.toFixed(0)} ms, p95 ${measurement.joinGapP95Ms.toFixed(0)} ms, max ${measurement.joinGapMaxMs.toFixed(0)} ms (limit ${limitMs} ms; ${offending.length} offending)`,
  };
}

export function expectNoSustainedGainLoss(measurement: Measurement): AssertionResult {
  const unexpected = measurement.gainLossRuns.filter((run) => !run.recovered || run.durationMs >= 1000);
  return {
    id: 'gain.no-unintended-loss',
    ok: unexpected.length === 0,
    detail:
      unexpected.length === 0
        ? 'no unrecovered gain loss'
        : unexpected
            .map((r) => `${r.durationMs.toFixed(0)} ms at ${(r.meanRatio * 100).toFixed(0)}% after ${r.afterChunkId}`)
            .join('; '),
  };
}

export function expectRecordingEnergy(measurement: Measurement): AssertionResult {
  const ok = measurement.recordingFrames > 0 && measurement.recordingPeak > dbfsToAmplitude(-40);
  return {
    id: 'recording.energy',
    ok,
    detail: `peak ${(20 * Math.log10(Math.max(measurement.recordingPeak, 1e-12))).toFixed(1)} dBFS, rms ${measurement.recordingRmsDbfs.toFixed(1)} dBFS`,
  };
}

export function expectCoverage(measurement: Measurement, minRatio: number): AssertionResult {
  return {
    id: 'recording.source-coverage',
    ok: measurement.matchedCoverage >= minRatio,
    detail: `matched coverage ${(measurement.matchedCoverage * 100).toFixed(1)}% (min ${(minRatio * 100).toFixed(0)}%)`,
  };
}

export function expectNoUnexplainedContent(measurement: Measurement, limitMs = 0): AssertionResult {
  return {
    id: 'recording.no-unexplained-content',
    ok: measurement.unexplainedMs <= limitMs,
    detail: `unexplained content ${measurement.unexplainedMs.toFixed(0)} ms (limit ${limitMs} ms)`,
  };
}

/** Fold assertions into the three-state verdict. A demonstrated failure always
 *  wins over indeterminate; indeterminate always wins over pass. */
export function verdictFrom(assertions: AssertionResult[]): Verdict {
  const failed = assertions.filter((a) => !a.ok && !a.indeterminate);
  const indeterminate = assertions.filter((a) => !a.ok && a.indeterminate);
  const reasons = [...failed, ...indeterminate].map((a) => `${a.id}: ${a.detail}`);
  if (failed.length > 0) return { status: 'failed', assertions, reasons };
  if (indeterminate.length > 0) return { status: 'indeterminate', assertions, reasons };
  return { status: 'passed', assertions, reasons: [] };
}

/** Scenario-level aggregation. An untrustworthy measurement can never be
 *  scored, whatever the individual assertions happen to say: missing frames,
 *  NaNs, a rate mismatch or an absent recording are indeterminate proof, not a
 *  demonstrated regression. This is the single place that rule is enforced, so
 *  no scenario can accidentally certify an unmeasurable capture. */
export function evaluate(
  measurement: Measurement,
  assertions: (measurement: Measurement) => AssertionResult[]
): Verdict {
  if (measurement.invalid.length > 0) {
    return {
      status: 'indeterminate',
      assertions: [expectValid(measurement)],
      reasons: [`measurement.valid: ${measurement.invalid.join('; ')}`],
    };
  }
  return verdictFrom(assertions(measurement));
}

/** Convenience: the standard "complete and ordered" gate set. */
export function completenessAssertions(
  measurement: Measurement,
  tolerances: OracleTolerances = DEFAULT_TOLERANCES
): AssertionResult[] {
  return [
    expectRecordingEnergy(measurement),
    expectAllChunksPresent(measurement),
    expectChunkOrder(measurement),
    expectNoDuplicates(measurement),
    expectHeadTailWithin(measurement, tolerances.headTailLossFailMs),
    expectJoinGapsWithin(measurement, tolerances.joinGapFailMs),
    expectNoSustainedGainLoss(measurement),
  ];
}
