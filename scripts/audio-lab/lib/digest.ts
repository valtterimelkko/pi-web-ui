/**
 * Compact, comparable digests of a measurement.
 *
 * The full measurement of a 20-chunk read is large. The manifest carries this
 * digest instead: the numbers a reader actually checks (loss, gaps, coverage,
 * per-chunk status), rounded to a stable precision so that a digest comparison
 * means "the measurement is the same", not "the float was bit-identical".
 */

import type { Measurement } from './oracle.js';

export interface ScenarioDigest {
  analysisRate: number;
  recordingSeconds: number;
  recordingFrames: number;
  recordingPeakDbfs: number;
  recordingRmsDbfs: number;
  sourceDurationMs: number;
  matchedCoverage: number;
  levelRatio: number;
  referenceRatio: number;
  headLossMs: number;
  tailLossMs: number;
  joinGapP50Ms: number;
  joinGapP95Ms: number;
  joinGapMaxMs: number;
  joinGapCount: number;
  missingChunks: string[];
  duplicatedChunks: string[];
  misordered: boolean;
  unexplainedMs: number;
  duckEventCount: number;
  gainLossRunCount: number;
  invalid: string[];
  chunks: Array<{
    id: string;
    status: string;
    score: number;
    startSample: number;
    headLossMs: number;
    tailLossMs: number;
    duplicateAtSample: number | null;
  }>;
}

function round(value: number, places = 3): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function computeScenarioDigest(measurement: Measurement | null): ScenarioDigest | null {
  if (!measurement) return null;
  return {
    analysisRate: measurement.analysisRate,
    recordingSeconds: round(measurement.recordingSeconds),
    recordingFrames: measurement.recordingFrames,
    recordingPeakDbfs: round(measurement.recordingPeak <= 0 ? -120 : 20 * Math.log10(measurement.recordingPeak), 2),
    recordingRmsDbfs: round(measurement.recordingRmsDbfs, 2),
    sourceDurationMs: round(measurement.sourceDurationMs, 1),
    matchedCoverage: round(measurement.matchedCoverage, 4),
    levelRatio: round(measurement.levelRatio, 4),
    referenceRatio: round(measurement.referenceRatio, 4),
    headLossMs: round(measurement.totalHeadLossMs, 1),
    tailLossMs: round(measurement.totalTailLossMs, 1),
    joinGapP50Ms: round(measurement.joinGapP50Ms, 1),
    joinGapP95Ms: round(measurement.joinGapP95Ms, 1),
    joinGapMaxMs: round(measurement.joinGapMaxMs, 1),
    joinGapCount: measurement.joinGapMs.length,
    missingChunks: [...measurement.missingChunks],
    duplicatedChunks: [...measurement.duplicatedChunks],
    misordered: measurement.misordered,
    unexplainedMs: round(measurement.unexplainedMs, 1),
    duckEventCount: measurement.duckEvents.length,
    gainLossRunCount: measurement.gainLossRuns.length,
    invalid: [...measurement.invalid],
    chunks: measurement.chunks.map((chunk) => ({
      id: chunk.id,
      status: chunk.status,
      score: round(chunk.score, 3),
      startSample: chunk.startSample,
      headLossMs: round(chunk.headLossMs, 1),
      tailLossMs: round(chunk.tailLossMs, 1),
      duplicateAtSample: chunk.duplicateAtSample,
    })),
  };
}

/** Human-readable one-line summary used in logs and the HTML header. */
export function describeDigest(digest: ScenarioDigest | null): string {
  if (!digest) return 'no measurement';
  const present = digest.chunks.filter((chunk) => chunk.status === 'present').length;
  return [
    `${present}/${digest.chunks.length} chunks audible`,
    `head ${digest.headLossMs} ms`,
    `tail ${digest.tailLossMs} ms`,
    `join p95 ${digest.joinGapP95Ms} ms`,
    `coverage ${(digest.matchedCoverage * 100).toFixed(0)}%`,
    digest.missingChunks.length ? `missing ${digest.missingChunks.join('+')}` : null,
    digest.duplicatedChunks.length ? `duplicated ${digest.duplicatedChunks.join('+')}` : null,
    digest.misordered ? 'misordered' : null,
  ]
    .filter(Boolean)
    .join(', ');
}
