/**
 * Talker-quiescence accounting (W4 campaign, conductor).
 *
 * The confirm turns are spoken only after the talker has gone quiet: a
 * confirmation spoken while the assistant is still talking is dropped as
 * echo-suspect and the release never fires. The original wait watched the
 * lab's egress counter (audio the server sent the lane) — but the et-high
 * model produces whole text turns with no audio at all
 * (C01-et-high/attempt-04: talker transcripts at 17.7–25.1 s, no egress
 * chunks between 12.4 s and 34.1 s), so an audio-only counter says "quiet"
 * while the model is still mid-turn.
 *
 * This module counts BOTH signals — the egress audio and the talker's own
 * inbound wire activity (transcripts and audio frames) — so quiescence means
 * the talker's turn has actually settled, whatever medium it used.
 */

export interface TalkerActivityFrame {
  direction: string;
  type: string;
  frame?: { speaker?: unknown };
}

export interface TalkerActivityInput {
  /** Audio chunks the server sent the lane (lab egress counter). */
  egressCount: number;
  /** The lab page's inbound/outbound wire-frame log (bounded, newest last). */
  wireFrames: readonly TalkerActivityFrame[];
}

/**
 * A monotonically-increasing count of everything the talker has done: its
 * audio (egress chunks) plus its inbound transcript deltas and audio frames.
 * Quiescence = this count unchanged for the quiet window.
 */
export function talkerActivityCount(input: TalkerActivityInput): number {
  let count = input.egressCount;
  for (const row of input.wireFrames) {
    if (row.direction !== 'inbound') continue;
    if (row.type === 'transcript_delta') {
      if (row.frame?.speaker === 'talker') count += 1;
      continue;
    }
    if (row.type === 'voice_audio_chunk') count += 1;
  }
  return count;
}
