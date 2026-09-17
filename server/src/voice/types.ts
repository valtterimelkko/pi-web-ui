/**
 * Voice bridge — internal types (Track B).
 *
 * CLIENT-NEUTRAL BY CONSTRUCTION (contract D7 / §6.1 invariant 4): nothing in
 * this module — or any other module under `server/src/voice/` — may name a
 * browser lifecycle concept. Lane identity and attachment generation replace
 * them. A source-inspection test (`tests/unit/voice/voice-client-neutrality`)
 * fails the build if one reappears.
 *
 * The wire-contract types themselves are re-exported by `./contract.js`, the
 * single seam between this service and the frozen shared module; this file holds
 * only internal (provider-facing and service-facing) shapes.
 */

// ── PCM framing ─────────────────────────────────────────────────────────────

/**
 * One mono PCM16LE format the service understands. Structurally identical to the
 * contract's `VoicePcmFormat`, but declared here so the transcoder stays free of
 * the wire contract and can be unit-tested against made-up rates.
 */
export interface Pcm16Format {
  readonly mimeType: string;
  readonly sampleRateHz: number;
  readonly channels: 1;
  readonly suggestedChunkBytes: number;
  readonly maxChunkBytes: number;
  readonly maxBase64Chars: number;
}

/**
 * What the provider accepts on `sendRealtimeInput` for operator audio.
 *
 * 16 kHz mono, exactly the client capture rate: the live probe proved
 * `gemini-3.8-live` transcribes `audio/pcm;rate=16000` directly, so the normal
 * path needs no input resample. The transcoder supports a 24 kHz provider input
 * too (see `providerInputFormatFor`), for an endpoint that asks for it.
 */
export const VOICE_PROVIDER_INPUT_FORMAT: Pcm16Format = {
  mimeType: 'audio/pcm;rate=16000',
  sampleRateHz: 16_000,
  channels: 1,
  suggestedChunkBytes: 640,
  maxChunkBytes: 3_200,
  maxBase64Chars: 4_268,
} as const;

/** 24 kHz provider input (optional endpoint profile; not the default). */
export const VOICE_PROVIDER_INPUT_FORMAT_24K: Pcm16Format = {
  mimeType: 'audio/pcm;rate=24000',
  sampleRateHz: 24_000,
  channels: 1,
  suggestedChunkBytes: 960,
  maxChunkBytes: 4_800,
  maxBase64Chars: 6_400,
} as const;

/**
 * The provider's model-speech format, which is also exactly what the client
 * consumes: 24 kHz mono PCM16LE. Output framing therefore needs re-chunking but
 * no resample on the normal path.
 */
export const VOICE_CLIENT_PLAYBACK_FORMAT: Pcm16Format = {
  mimeType: 'audio/pcm;rate=24000',
  sampleRateHz: 24_000,
  channels: 1,
  suggestedChunkBytes: 960,
  maxChunkBytes: 4_800,
  maxBase64Chars: 6_400,
} as const;

/** Pick the provider input descriptor for a configured rate. */
export function providerInputFormatFor(sampleRateHz: number): Pcm16Format | null {
  if (sampleRateHz === VOICE_PROVIDER_INPUT_FORMAT.sampleRateHz) return VOICE_PROVIDER_INPUT_FORMAT;
  if (sampleRateHz === VOICE_PROVIDER_INPUT_FORMAT_24K.sampleRateHz) return VOICE_PROVIDER_INPUT_FORMAT_24K;
  return null;
}

// ── Injectable seams (deterministic tests; no provider in the unit suite) ───

/** Monotonic-ish millisecond clock. */
export type VoiceClock = () => number;

/** Cancelable delay scheduler, so coalescing is testable without real time. */
export type VoiceScheduler = (fn: () => void, delayMs: number) => () => void;

/**
 * Minimal structured log sink. Deliberately tiny and no-op by default: the
 * bridge handles provider credentials, and a sink that cannot be handed the
 * credential is one fewer way for it to leak. Callers may bind the server logger.
 */
export interface VoiceLogSink {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const NOOP_VOICE_LOG: VoiceLogSink = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Real-clock/real-timer defaults for production use. */
export const systemVoiceClock: VoiceClock = () => Date.now();

export const systemVoiceScheduler: VoiceScheduler = (fn, delayMs) => {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
};
