/**
 * voiceLive/audioConstants — the one place the client's audio geometry lives.
 *
 * The numbers here are the contract's (§5 of the frozen wire contract) or the
 * client's own bounded-buffer policy. They are injected into the AudioWorklet
 * source at load time, so the processor and the main-thread pipeline cannot
 * disagree about a frame or a block size.
 */

/** Microphone format (contract §5.1). */
export const VOICE_CAPTURE_RATE = 16_000;
/** Model-speech format (contract §5.1). */
export const VOICE_PLAYBACK_RATE = 24_000;

/** Suggested chunk: 20 ms. */
export const VOICE_FRAME_MS = 20;
/** Hard maximum: 100 ms (contract §5.1). */
export const VOICE_MAX_FRAME_MS = 100;

/** One suggested capture frame at 16 kHz: 320 samples / 640 bytes. */
export const VOICE_CAPTURE_FRAME_SAMPLES = (VOICE_CAPTURE_RATE * VOICE_FRAME_MS) / 1000;
/** One suggested playback frame at 24 kHz: 480 samples / 960 bytes. */
export const VOICE_PLAYBACK_FRAME_SAMPLES = (VOICE_PLAYBACK_RATE * VOICE_FRAME_MS) / 1000;

/** How often the capture worklet hands a block to the main thread. */
export const VOICE_CAPTURE_BLOCK_MS = 20;

/** AudioWorklet processor name (must match the generated source). */
export const VOICE_CAPTURE_PROCESSOR_NAME = 'voice-live-capture';

/**
 * Bounded capture backlog: at most 1 s of un-drained audio is held. Beyond it
 * the OLDEST chunk is dropped and the dropped count surfaced (N9) — memory is
 * bounded, and the fault is never silent. Operator capture is never suppressed
 * to make room: only an already-produced chunk can be dropped.
 */
export const VOICE_CAPTURE_MAX_PENDING_CHUNKS = 50;

/** Pre-roll retained while silence is not sent, so the first word is never
 *  clipped (contract §5.2, P21). 40 ms. */
export const VOICE_CAPTURE_PREROLL_FRAMES = 2;

/**
 * Bounded playback queue: 2 s of unplayed model audio. This is the SCHEDULING
 * horizon — how far ahead of the clock audio is booked — and it is not a cap on
 * how much audio the lane may hold (see the backlog bound below).
 */
export const VOICE_PLAYBACK_MAX_QUEUED_MS = 2_000;

/**
 * The backlog bound: how much accepted-but-not-yet-booked audio the scheduler
 * will hold, measured in AUDIO rather than in chunks.
 *
 * Why it is measured in audio (2026-09-18): it used to be a count (50 chunks),
 * which silently assumed 20 ms chunks. The live lane's model audio arrives in
 * 100 ms chunks at ~4x playback speed (measured on a real Gemini Live lane: 9.9 s
 * of speech delivered in 2.1 s), so 50 chunks is 5 s of speech — and a long
 * answer therefore had its middle thrown away mid-sentence. The bound exists to
 * bound MEMORY, not to keep the client near-live, and it must comfortably hold
 * the unplayed surplus of one answer: at the measured rate that surplus is about
 * 0.75x the answer's duration, so 60 s covers answers up to ~80 s of speech for
 * about 5.8 MB.
 */
export const VOICE_PLAYBACK_MAX_PENDING_MS = 60_000;

// ── Local voice-activity detection (scheduling signal only, never authority) ─

/** Frame RMS at or above which the operator is treated as speaking. */
export const VAD_START_RMS = 0.02;
/** Frame RMS below which silence is detected (hysteresis). */
export const VAD_END_RMS = 0.012;
/** Consecutive frames above the start threshold before speech_start (40 ms). */
export const VAD_ATTACK_FRAMES = 2;
/** Consecutive frames below the end threshold before speech_end (500 ms). */
export const VAD_HANGOVER_FRAMES = 25;

/** Clamp helper shared by the pipeline (and mirrored in the worklet source). */
export function clampSample(value: number): number {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}
