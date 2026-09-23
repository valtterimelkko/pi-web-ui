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

import type { VoiceBridgeToolName, VoiceErrorCode, VoiceWireState } from './contract.js';
import { defaultProviderModelFromEnv } from './voice-profiles.js';
import type { VoiceLiveProfileId } from './voice-profiles.js';

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
 *
 * The sink is never given audio, transcripts or the provider credential.
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

/**
 * The declared functions, mirrored from the contract's `VoiceBridgeToolName`.
 * The bridge test asserts this list covers the contract union at runtime.
 */
export type { VoiceBridgeToolName };

/** Provider-facing lifecycle callbacks, the productised lab adapter surface. */
export interface GeminiLiveBridgeCallbacks {
  onSetupComplete?(): void;
  onAudioPcm?(pcm: Buffer, mimeType: string, atMs: number): void;
  onInputTranscription?(text: string, atMs: number): void;
  onOutputTranscription?(text: string, atMs: number): void;
  onTurnComplete?(atMs: number): void;
  onInterrupted?(atMs: number): void;
  /**
   * A tool call. The return value, when there is one, becomes the tool's
   * RESPONSE — how a retrieval result reaches the model in the same turn.
   */
  onToolCall?(call: {
    name: VoiceBridgeToolName;
    args: Record<string, unknown>;
    id: string;
    atMs: number;
  }): void | Record<string, unknown> | Promise<void | Record<string, unknown>>;
  onResumptionHandle?(handle: string, resumable: boolean): void;
  onGoAway?(timeLeft: string | undefined): void;
  onState?(state: VoiceWireState, detail?: string): void;
  onError?(error: { code: VoiceErrorCode; message: string; fatal: boolean }): void;
  /** Fired when a reconnect completed and the provider reported setup complete. */
  onReconnected?(): void;
}

/** Local provider counters, reported by the handshake probe. */
export interface GeminiLiveBridgeUsage {
  messages: number;
  setupCompletes: number;
  contextSends: number;
  audioChunksIn: number;
  audioBytesIn: number;
  audioChunksOut: number;
  audioBytesOut: number;
  inputTranscriptDeltas: number;
  outputTranscriptDeltas: number;
  turnCompletes: number;
  interruptions: number;
  toolCalls: number;
  toolCallViolations: number;
  resumptionHandles: number;
  goAways: number;
  reconnects: number;
  errors: number;
  usageMetadataSamples: number;
  /** Provider-reported thinking tokens (the ET arm's actual-effort evidence). */
  thoughtTokens: number;
  /** Provider-reported total tokens, accumulated across usage samples. */
  totalTokens: number;
  /** A provider tool call whose id was already dispatched (never re-executed). */
  toolCallDuplicates: number;
  /** An accepted tool call that arrived after the turn boundary (both arms). */
  lateToolCalls: number;
  /** An `activityEnd` suppressed because this session never received its
   *  `activityStart` (dropped while connecting, or a speech span crossing a
   *  same-lane restart) — the wedge behind the soak's post-reconnect silence
   *  (SOAK-10MIN-standard/attempt-04). */
  unmatchedActivityEndsSuppressed: number;
}

export interface GeminiLiveBridgeOptions {
  laneId: string;
  attachmentGeneration: number;
  systemInstruction: string;
  callbacks: GeminiLiveBridgeCallbacks;
  model?: string;
  /** Injected in unit tests; the real factory is built from the server env key. */
  sessionFactory?: LiveSessionFactory;
  apiKeyProvider?: () => string | undefined;
  clock?: VoiceClock;
  scheduler?: VoiceScheduler;
  log?: VoiceLogSink;
  /** Default true: the driver supplies explicit activity markers. */
  manualActivityDetection?: boolean;
  /** Default true: acknowledge valid tool calls (scheduling below). */
  ackToolCalls?: boolean;
  /**
   * Scheduling for the acknowledgement of a declared function call.
   *
   * Default `WHEN_IDLE` (finding F-1): with `SILENT`, `gemini-3.8-live` answers
   * conversational speech by calling a tool and ending the turn with no audio —
   * the operator hears nothing. `WHEN_IDLE` lets the model speak first and lands
   * the acknowledgement when it is idle. `SILENT` remains available as an
   * explicit opt-in for a caller that has measured its own turn behaviour.
   */
  toolResponseScheduling?: VoiceFunctionResponseScheduling;
  reconnect?: { maxAttempts?: number; delayMs?: number };
  /** Seed a resumed lane with a handle captured before a process restart. */
  resumptionHandle?: string | null;
  /** Provider input rate. Default 16 kHz (proven live); 24 kHz supported. */
  providerInputSampleRateHz?: number;
  /**
   * The provider-profile arm this bridge runs (plan §7). Resolved from
   * `VOICE_LIVE_PROFILE` when omitted. Explicit `toolResponseScheduling` and
   * `model` options must agree with the profile or construction refuses.
   */
  profile?: VoiceLiveProfileId;
}

/**
 * The shape the session service needs from a bridge. `GeminiLiveBridge`
 * satisfies it, and so does a mock in the service's own unit suite.
 */
export interface VoiceBridgeLike {
  connect(): Promise<void>;
  sendAudio(pcm: Buffer): boolean;
  sendContextText(text: string): boolean;
  activityStart(): void;
  activityEnd(): void;
  close(): void;
  readonly resumptionHandle: string | null;
}

/** Real-clock/real-timer defaults for production use. */
export const systemVoiceClock: VoiceClock = () => Date.now();

// ── Provider wire shapes (structural; the SDK stays behind the factory) ─────
//
// Productised from the reviewed lab adapter
// (`scripts/voice-live-lab/lib/providers/gemini-live.ts`). The SDK's own types
// stay behind `LiveSessionFactory` so the bridge is unit-testable with a mock
// socket and no provider SDK in the loop.

export interface LiveConnectConfigShape {
  responseModalities?: string[];
  inputAudioTranscription?: Record<string, never>;
  outputAudioTranscription?: Record<string, never>;
  sessionResumption?: { handle?: string } | Record<string, unknown>;
  realtimeInputConfig?: {
    automaticActivityDetection?: { disabled?: boolean } | Record<string, never>;
  };
  tools?: Array<{ functionDeclarations?: unknown[] }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  /**
   * Thinking configuration. Present ONLY on profiles that support it (the
   * provider rejects the field on models without thinking); assembled by the
   * profile adapter in `voice-profiles.ts`, never hand-crafted at call sites.
   */
  thinkingConfig?: {
    includeThoughts?: boolean;
    thinkingBudget?: number;
    thinkingLevel?: string;
  };
}

export interface LiveServerMessageShape {
  setupComplete?: unknown;
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  goAway?: { timeLeft?: string };
  serverContent?: {
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    modelTurn?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
        text?: string;
      }>;
    };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  usageMetadata?: Record<string, unknown>;
  toolCall?: {
    functionCalls?: Array<{ name?: string; args?: Record<string, unknown>; id?: string }>;
  };
}

export type LiveRealtimeInput =
  | { audio: { mimeType: string; data: string } }
  | { activityStart: Record<string, never> }
  | { activityEnd: Record<string, never> };

export interface LiveCallbacks {
  onOpen: () => void;
  onMessage: (message: LiveServerMessageShape) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
}

export interface LiveSessionLike {
  sendRealtimeInput(input: LiveRealtimeInput): void;
  sendClientContent(content: {
    turns: Array<{ role: string; parts: Array<{ text: string }> }>;
    turnComplete: boolean;
  }): void;
  sendToolResponse(response: { functionResponses: Array<Record<string, unknown>> }): void;
  close(): void;
}

export interface LiveConnectRequest {
  model: string;
  config: LiveConnectConfigShape;
  callbacks: LiveCallbacks;
}

export type LiveSessionFactory = (request: LiveConnectRequest) => Promise<LiveSessionLike>;

// ── Provider defaults (the live probe proved these) ────────────────────────

/**
 * The provider seat the live engine opens sessions on: the resolved
 * provider-profile arm's model (plan §7). Resolved ONCE per process from
 * `VOICE_LIVE_PROFILE` (default `standard`) so every consumer of this
 * constant — including the diagnostics gauge — states the same seat the
 * bridge will actually request. An unknown profile value fails here, at
 * boot, rather than running the wrong arm. The live per-arm capability probe
 * re-resolves the real model names before either arm is declared supported.
 */
export const VOICE_PROVIDER_MODEL = defaultProviderModelFromEnv(process.env);

/**
 * The provider's declared functions. `relay_to_worker` is the ONE tool that
 * carries the operator's words toward the worker, and it can only create a
 * proposal the operator must approve; `read_worker_history` can only read.
 *
 * 2026-09-22: this replaced the parameterless `mark_addressed_to_talker` /
 * `offer_ask_worker` gate tools, because the native talker now decides for
 * itself what is conversation and what is a relay (owner directive).
 */
export const VOICE_TOOL_NAMES = [
  /**
   * The relay: the model hands the host the words to place in front of the
   * operator for approval. It cannot release, confirm or deliver anything —
   * the release predicate is unchanged and still requires the operator's own
   * confirmation bound to the presented proposal (N1, N2, N8).
   */
  'relay_to_worker',
  /**
   * The one tool that only READS: it asks the host for worker history beyond
   * the standing brief (intent §19.3 — read-only retrieval of more history than
   * the standing view holds, or of a specific earlier turn, fixes it properly;
   * enlarging the prompt does not). It cannot send, hold, confirm or release
   * anything.
   */
  'read_worker_history',
] as const;

/**
 * Function-response scheduling for a declared tool acknowledgement.
 *
 * `WHEN_IDLE` (the default, finding F-1): the model's spoken reply completes
 * first and the acknowledgement joins its context afterwards, so conversational
 * speech that triggers `mark_addressed_to_talker` / `offer_ask_worker` still
 * produces speech. `SILENT`: the acknowledgement joins the context without
 * triggering a turn — measured in the lab, but it made the turn end with no
 * audio when no other speech had been generated.
 */
export type VoiceFunctionResponseScheduling = 'WHEN_IDLE' | 'SILENT';

/**
 * Default scheduling for tool-call acknowledgements: `WHEN_IDLE`, so calling a
 * declared function never leaves the operator in silence (F-1). Overridable via
 * `GeminiLiveBridgeOptions.toolResponseScheduling`.
 */
export const VOICE_FUNCTION_RESPONSE_SCHEDULING: VoiceFunctionResponseScheduling = 'WHEN_IDLE';

export const systemVoiceScheduler: VoiceScheduler = (fn, delayMs) => {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
};
