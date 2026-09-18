/**
 * The overlap oracle's teeth.
 *
 * The audio regression lab's rule applies here unchanged: an oracle is only
 * trusted when a clean control passes AND every injected defect fails for the
 * intended reason. The defects below are the ways a live lane's audio can reach
 * the operator's ear wrong, and the one the operator actually reported
 * ("talking on top of each other") is the first.
 */
import { describe, expect, it } from 'vitest';
import {
  analyseLaneAudio,
  type CapturedAudioChunk,
  type LaneAudioMeasurement,
  type ScheduledSource,
} from '../../../scripts/voice-lane-lab/lib/oracle.js';

/** 20 ms of nominal speech per chunk, booked contiguously — the correct case. */
function cleanMeasurement(overrides: Partial<LaneAudioMeasurement> = {}): LaneAudioMeasurement {
  const chunks: CapturedAudioChunk[] = Array.from({ length: 6 }, (_, seq) => ({
    seq,
    arrivedAtMs: 1_700_000_000_000 + seq * 20,
    declaredDurationMs: 20,
    actualDurationMs: 20,
    sha256: `payload-${seq}`,
    mimeType: 'audio/pcm;rate=24000',
  }));
  const schedule: ScheduledSource[] = chunks.map((chunk, index) => ({
    seq: chunk.seq,
    startAt: 1 + index * 0.02,
    durationSeconds: 0.02,
  }));
  return {
    chunks,
    schedule,
    strandedSeqs: [],
    droppedChunks: 0,
    faults: [],
    page: { audioContexts: 1, mountedLaneSurfaces: 1, laneIds: ['worker:vl-1-abc'] },
    ...overrides,
  };
}

describe('analyseLaneAudio', () => {
  it('passes the clean control', () => {
    const verdict = analyseLaneAudio(cleanMeasurement());

    expect(verdict.verdict).toBe('clean');
    expect(verdict.findings).toEqual([]);
    expect(verdict.summary.scheduled).toBe(6);
    expect(verdict.summary.overlapMs).toBe(0);
  });

  it('FAILS when two chunks are booked on top of each other — the operator\'s symptom', () => {
    // Exactly the reported defect: several sentences at once, unintelligible.
    const base = cleanMeasurement();
    const schedule = [
      { seq: 0, startAt: 0, durationSeconds: 0.1 },
      { seq: 1, startAt: 0.05, durationSeconds: 0.1 },
    ];

    const verdict = analyseLaneAudio({ ...base, schedule });

    expect(verdict.verdict).toBe('chunk_overlap');
    expect(verdict.findings[0].code).toBe('chunk_overlap');
    expect(verdict.findings[0].measured.overlapMs).toBe(50);
    expect(verdict.findings[0].measured.firstSeq).toBe(0);
    expect(verdict.findings[0].detail).toContain('on top of each other');
  });

  it('does NOT call touching chunks an overlap (contiguous booking is correct)', () => {
    const verdict = analyseLaneAudio(cleanMeasurement());
    expect(verdict.findings.filter((finding) => finding.code === 'chunk_overlap')).toEqual([]);
  });

  it('FAILS when the same audio payload is delivered twice', () => {
    const base = cleanMeasurement();
    const chunks = base.chunks.map((chunk) => (chunk.seq === 4 ? { ...chunk, sha256: 'payload-3' } : chunk));

    const verdict = analyseLaneAudio({ ...base, chunks });

    expect(verdict.verdict).toBe('duplicate_audio');
    expect(verdict.findings[0].measured.payloads).toBe(1);
  });

  it('FAILS when accepted audio was never booked (speech the operator never heard)', () => {
    const base = cleanMeasurement();
    const chunks = Array.from({ length: 10 }, (_, seq) => ({
      seq,
      arrivedAtMs: 1_700_000_000_000 + seq * 20,
      declaredDurationMs: 20,
      actualDurationMs: 20,
      sha256: `payload-${seq}`,
      mimeType: 'audio/pcm;rate=24000',
    }));
    const verdict = analyseLaneAudio({ ...base, chunks, strandedSeqs: [3, 4, 5, 6, 7, 8, 9] });

    expect(verdict.verdict).toBe('stranded_audio');
    expect(verdict.findings[0].measured.strandedMs).toBe(140);
    expect(verdict.findings[0].measured.strandedChunks).toBe(7);
  });

  it('does not report a sub-tolerance tail as stranded', () => {
    const verdict = analyseLaneAudio(cleanMeasurement({ strandedSeqs: [5] }));
    // 20 ms of a stream's tail is a tail, not a defect.
    expect(verdict.findings.filter((finding) => finding.code === 'stranded_audio')).toEqual([]);
  });

  it('FAILS when the scheduler refused chunks', () => {
    const verdict = analyseLaneAudio(cleanMeasurement({ droppedChunks: 2 }));
    expect(verdict.verdict).toBe('dropped_audio');
  });

  it('FAILS when the server\'s chunk sequence has a gap or a repeat', () => {
    const base = cleanMeasurement();
    const chunks = base.chunks.map((chunk) => (chunk.seq === 5 ? { ...chunk, seq: 3 } : chunk));

    const verdict = analyseLaneAudio({ ...base, chunks });

    expect(verdict.findings.map((finding) => finding.code)).toContain('seq_not_contiguous');
  });

  it('FAILS when a chunk decodes to a different length than the server declared (the sample-rate shape)', () => {
    const base = cleanMeasurement();
    const chunks = base.chunks.map((chunk) => (chunk.seq === 2 ? { ...chunk, actualDurationMs: 40 } : chunk));

    const verdict = analyseLaneAudio({ ...base, chunks });

    expect(verdict.verdict).toBe('declared_duration_mismatch');
    expect(verdict.findings[0].measured.deltaMs).toBe(20);
    expect(verdict.findings[0].measured.seq).toBe(2);
  });

  it('FAILS when the page created a second AudioContext — a second output chain', () => {
    const base = cleanMeasurement();
    const verdict = analyseLaneAudio({ ...base, page: { ...base.page, audioContexts: 2 } });

    expect(verdict.verdict).toBe('second_audio_context');
    expect(verdict.findings[0].measured.audioContexts).toBe(2);
  });

  it('FAILS when two lane surfaces are mounted at once', () => {
    const base = cleanMeasurement();
    const verdict = analyseLaneAudio({ ...base, page: { ...base.page, mountedLaneSurfaces: 2 } });

    expect(verdict.verdict).toBe('second_lane_surface');
  });

  it('FAILS when two lanes stream audio into one page', () => {
    const base = cleanMeasurement();
    const verdict = analyseLaneAudio({
      ...base,
      page: { ...base.page, laneIds: ['worker:vl-1-abc', 'worker:vl-2-def'] },
    });

    expect(verdict.verdict).toBe('second_lane');
    expect(verdict.findings[0].measured.laneIds).toBe(2);
  });

  it('reports the operator\'s symptom FIRST when several defects are present', () => {
    // An overlap plus a second context: the overlap is what the operator hears,
    // so it must be the verdict rather than being buried behind page facts.
    const base = cleanMeasurement();
    const schedule = base.schedule.map((source) => (source.seq === 2 ? { ...source, startAt: 1.0 } : source));

    const verdict = analyseLaneAudio({ ...base, schedule, page: { ...base.page, audioContexts: 2 } });

    expect(verdict.verdict).toBe('chunk_overlap');
    expect(verdict.findings.map((finding) => finding.code)).toEqual(['chunk_overlap', 'second_audio_context']);
  });

  it('reports booked speech against the span it occupies, so overlap is visible in the summary', () => {
    const base = cleanMeasurement();
    // Two streams of booked speech, each contiguous on its own 20 ms grid.
    const schedule = [
      { seq: 0, startAt: 0, durationSeconds: 0.06 },
      { seq: 1, startAt: 0.01, durationSeconds: 0.06 },
      { seq: 2, startAt: 0.02, durationSeconds: 0.06 },
    ];

    const verdict = analyseLaneAudio({ ...base, schedule });

    // 180 ms of speech squeezed into an 80 ms window is the arithmetic of overlap.
    expect(verdict.summary.bookedMs).toBe(180);
    expect(verdict.summary.bookedSpanMs).toBe(80);
    expect(verdict.summary.overlapMs).toBeGreaterThan(0);
  });
});
