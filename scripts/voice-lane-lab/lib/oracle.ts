/**
 * The overlap oracle — what a live lane's audio did, decided mechanically.
 *
 * WHY THIS EXISTS. On 2026-09-18 the operator reported that the native talker's
 * voice "starts talking on top of each other … several sentences at the same
 * time … they all kind of go on top of each other and it becomes … I can't really
 * understand what it's saying". The server's own observability could not see it:
 * `voice-kernel` counts turns, briefs, receipts and capture faults, but nothing
 * records the SHAPE of the audio that reached the client. A listening impression
 * is not evidence, and "it sounded wrong" cannot be root-caused.
 *
 * So this is a detector for exactly that class of defect, with the same stance as
 * the audio regression lab (`docs/AUDIO-REGRESSION-LAB.md`): a clean control must
 * pass, and every injected defect must fail for the intended reason, or the
 * oracle is not trusted.
 *
 * WHAT IT MEASURES, and what it does not. It is fed
 *   (a) the audio chunks the SERVER sent, as the client received them, and
 *   (b) the schedule the SHIPPED client scheduler produced for them
 *       (`client/src/lib/voiceLive/playbackSession.ts` driven through a recording
 *       backend — the real arithmetic, not a model of it),
 * plus the page-level facts that decide whether a second output chain exists at
 * all (how many AudioContexts, how many mounted lane surfaces, how many lanes).
 *
 * An overlap in that schedule is an overlap in reality: Web Audio starts a booked
 * source at the time it was booked. What this CANNOT see is anything after the
 * graph — a device-level dropout, a Bluetooth route, another tab, another
 * machine's speakers. Those are named as out of scope rather than folded into a
 * pass.
 *
 * Pure by construction: no I/O, no clock, no browser. Every number is an input.
 */

/** One chunk of model speech, exactly as the client received it. */
export interface CapturedAudioChunk {
  /** Monotonic per lane from the server, in provider delivery order. */
  seq: number;
  /** Wall-clock arrival at the client (ms since epoch). */
  arrivedAtMs: number;
  /** The duration the SERVER declared for this chunk. */
  declaredDurationMs: number;
  /** The chunk's true duration, from the decoded samples. */
  actualDurationMs: number;
  /** sha256 of the decoded payload — identical content delivered twice is a defect. */
  sha256: string;
  /** The mime type the server sent (the rate the client contracts to decode at). */
  mimeType: string;
}

/** One source the shipped scheduler booked into the audio graph. */
export interface ScheduledSource {
  seq: number;
  /** Backend clock (AudioContext.currentTime in production), seconds. */
  startAt: number;
  durationSeconds: number;
}

/** Page-level facts: a second output chain is the one thing a single scheduler cannot produce. */
export interface PageFacts {
  /** AudioContexts the page created. A correct client creates exactly one. */
  audioContexts: number;
  /** Mounted native-lane surfaces. More than one means two players for one lane. */
  mountedLaneSurfaces: number;
  /** Distinct lane ids that streamed audio into this page. */
  laneIds: string[];
}

export interface LaneAudioMeasurement {
  chunks: CapturedAudioChunk[];
  schedule: ScheduledSource[];
  /** Chunks the scheduler accepted but had not booked when the stream ended. */
  strandedSeqs: number[];
  /** Chunks the scheduler refused (corrupt/oversized). */
  droppedChunks: number;
  /** Scheduler faults, as the product itself reported them. */
  faults: Array<{ reason: string; detail: string }>;
  page: PageFacts;
}

export const LANE_AUDIO_TOLERANCES = {
  /**
   * Scheduled sources may touch but must not overlap. Booked audio is contiguous
   * by construction, so any real overlap is a second writer, not rounding.
   */
  overlapMs: 5,
  /**
   * Declared vs decoded duration. The client books from the SAMPLES, so a
   * mismatch is a format disagreement between server and client — reported
   * because it is the shape a wrong sample rate takes. 15 ms is the floor
   * (chunks are 20–100 ms here); 25 % catches a wrong rate on longer chunks.
   */
  durationMismatchMs: 15,
  /** Stranded audio worth reporting: below this a stream's tail is just a tail. */
  strandedMs: 120,
  /** Queued horizon above which the product's own bound (2 s) is being exceeded. */
  maxQueuedMs: 2_000,
} as const;

export type LaneAudioFindingCode =
  | 'chunk_overlap'
  | 'duplicate_audio'
  | 'stranded_audio'
  | 'dropped_audio'
  | 'seq_not_contiguous'
  | 'declared_duration_mismatch'
  | 'second_audio_context'
  | 'second_lane_surface'
  | 'second_lane';

export interface LaneAudioFinding {
  code: LaneAudioFindingCode;
  detail: string;
  /** The measured numbers behind the finding, so it can be argued with. */
  measured: Record<string, number | string>;
}

export interface LaneAudioVerdict {
  /** `clean` means: no finding. Anything else names the first defect found. */
  verdict: 'clean' | LaneAudioFindingCode;
  findings: LaneAudioFinding[];
  summary: {
    chunks: number;
    scheduled: number;
    /** Total speech booked into the graph, ms. */
    bookedMs: number;
    /** The window the booked speech occupies, ms — shorter than bookedMs means overlap. */
    bookedSpanMs: number;
    overlapMs: number;
    strandedMs: number;
    droppedChunks: number;
    audioContexts: number;
    mountedLaneSurfaces: number;
    laneIds: number;
  };
}

/**
 * Decide what a lane's audio did. Findings are ordered so the FIRST one is the
 * operator's symptom when it is present: overlapping speech outranks everything.
 */
export function analyseLaneAudio(measurement: LaneAudioMeasurement): LaneAudioVerdict {
  const { chunks, schedule, page } = measurement;
  const findings: LaneAudioFinding[] = [];

  // 1. Overlap, in the schedule the shipped scheduler actually produced.
  const ordered = [...schedule].sort((a, b) => a.startAt - b.startAt);
  let overlapMs = 0;
  let overlapDetail: LaneAudioFinding | null = null;
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    const overlap = (previous.startAt + previous.durationSeconds - current.startAt) * 1000;
    if (overlap > LANE_AUDIO_TOLERANCES.overlapMs) {
      overlapMs = Math.max(overlapMs, overlap);
      if (!overlapDetail) {
        overlapDetail = {
          code: 'chunk_overlap',
          detail: `seq ${previous.seq} and seq ${current.seq} were booked ${Math.round(overlap)} ms on top of each other`,
          measured: {
            firstSeq: previous.seq,
            secondSeq: current.seq,
            overlapMs: Math.round(overlap),
            firstEndsMs: Math.round((previous.startAt + previous.durationSeconds) * 1000),
            secondStartsMs: Math.round(current.startAt * 1000),
          },
        };
      }
    }
  }
  if (overlapDetail) findings.push(overlapDetail);

  // 2. The same audio twice — the operator hears the same words from two sources.
  const byHash = new Map<string, number[]>();
  for (const chunk of chunks) {
    const list = byHash.get(chunk.sha256) ?? [];
    list.push(chunk.seq);
    byHash.set(chunk.sha256, list);
  }
  const duplicated = [...byHash.entries()].filter(([, seqs]) => seqs.length > 1);
  if (duplicated.length > 0) {
    findings.push({
      code: 'duplicate_audio',
      detail: `${duplicated.length} audio payload(s) were delivered more than once`,
      measured: {
        payloads: duplicated.length,
        exampleSeqs: duplicated[0][1].join(','),
      },
    });
  }

  // 3. Audio the scheduler took and never played.
  const strandedMs = measurement.strandedSeqs.reduce((total, seq) => {
    const chunk = chunks.find((candidate) => candidate.seq === seq);
    return total + (chunk?.actualDurationMs ?? 0);
  }, 0);
  if (strandedMs >= LANE_AUDIO_TOLERANCES.strandedMs) {
    findings.push({
      code: 'stranded_audio',
      detail: `${measurement.strandedSeqs.length} chunk(s), ${Math.round(strandedMs)} ms of speech, were accepted and never booked`,
      measured: { strandedChunks: measurement.strandedSeqs.length, strandedMs: Math.round(strandedMs) },
    });
  }

  // 4. Audio the scheduler refused.
  if (measurement.droppedChunks > 0) {
    findings.push({
      code: 'dropped_audio',
      detail: `${measurement.droppedChunks} chunk(s) were refused by the scheduler`,
      measured: { droppedChunks: measurement.droppedChunks },
    });
  }

  // 5. Sequence continuity, from the server's own numbering.
  const seqs = chunks.map((chunk) => chunk.seq);
  const unique = new Set(seqs);
  const contiguous = seqs.every((seq, index) => index === 0 || seq === seqs[index - 1] + 1);
  if (unique.size !== seqs.length || !contiguous) {
    findings.push({
      code: 'seq_not_contiguous',
      detail: `the server's chunk sequence is not contiguous (${seqs.length} chunks, ${unique.size} distinct)`,
      measured: {
        chunks: seqs.length,
        distinctSeqs: unique.size,
        firstSeq: seqs[0] ?? -1,
        lastSeq: seqs[seqs.length - 1] ?? -1,
      },
    });
  }

  // 6. Declared vs decoded duration — the shape a sample-rate disagreement takes.
  for (const chunk of chunks) {
    const delta = Math.abs(chunk.declaredDurationMs - chunk.actualDurationMs);
    const tolerance = Math.max(LANE_AUDIO_TOLERANCES.durationMismatchMs, chunk.actualDurationMs * 0.25);
    if (delta > tolerance) {
      findings.push({
        code: 'declared_duration_mismatch',
        detail: `seq ${chunk.seq} declared ${Math.round(chunk.declaredDurationMs)} ms but decoded as ${Math.round(chunk.actualDurationMs)} ms (${chunk.mimeType})`,
        measured: {
          seq: chunk.seq,
          declaredMs: Math.round(chunk.declaredDurationMs),
          actualMs: Math.round(chunk.actualDurationMs),
          deltaMs: Math.round(delta),
          mimeType: chunk.mimeType,
        },
      });
      break;
    }
  }

  // 7-9. A second output chain. One scheduler cannot overlap itself; two can.
  if (page.audioContexts > 1) {
    findings.push({
      code: 'second_audio_context',
      detail: `the page created ${page.audioContexts} AudioContexts; each one plays the same lane independently`,
      measured: { audioContexts: page.audioContexts },
    });
  }
  if (page.mountedLaneSurfaces > 1) {
    findings.push({
      code: 'second_lane_surface',
      detail: `${page.mountedLaneSurfaces} native-lane surfaces were mounted at once`,
      measured: { mountedLaneSurfaces: page.mountedLaneSurfaces },
    });
  }
  if (page.laneIds.length > 1) {
    findings.push({
      code: 'second_lane',
      detail: `${page.laneIds.length} lanes streamed audio into one page (${page.laneIds.join(', ')})`,
      measured: { laneIds: page.laneIds.length, ids: page.laneIds.join(',') },
    });
  }

  const bookedMs = ordered.reduce((total, source) => total + source.durationSeconds * 1000, 0);
  const bookedSpanMs =
    ordered.length === 0
      ? 0
      : (ordered[ordered.length - 1].startAt + ordered[ordered.length - 1].durationSeconds - ordered[0].startAt) * 1000;

  return {
    verdict: findings.length > 0 ? findings[0].code : 'clean',
    findings,
    summary: {
      chunks: chunks.length,
      scheduled: schedule.length,
      bookedMs: Math.round(bookedMs),
      bookedSpanMs: Math.round(bookedSpanMs),
      overlapMs: Math.round(overlapMs),
      strandedMs: Math.round(strandedMs),
      droppedChunks: measurement.droppedChunks,
      audioContexts: page.audioContexts,
      mountedLaneSurfaces: page.mountedLaneSurfaces,
      laneIds: page.laneIds.length,
    },
  };
}
