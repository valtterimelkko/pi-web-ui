/**
 * Provider-profile boundary (plan §7, Phase 4) — the typed standard vs
 * ET-HIGH profile table and its adapter.
 *
 * The two programme arms are exactly `standard` Live and Extended Thinking
 * HIGH (one fixed effort level). This module is the single place that knows
 * what differs between the arms:
 *
 *   - connect options (thinking configuration present only where supported);
 *   - tool-reply shape (`scheduling` only on arms that support it);
 *   - idle/completion semantics (what "the interaction has settled" means);
 *   - usage reporting (whether provider thought-token evidence is expected);
 *   - resumption and contextWindowCompression support, recorded honestly.
 *
 * Rules the table enforces:
 *   - NO blind model-string substitution: the model is one field of a full
 *     profile, and every difference between arms is declared here as data;
 *   - unsupported fields are NEVER cast away: `assertProfileSupports` refuses
 *     them with a typed error naming the arm, and the bridge refuses to
 *     construct with a contradictory option;
 *   - prompts are identical across arms: the profile carries no prompt text
 *     (`promptAddendum` is null), so the comparison stays model-only;
 *   - the same logical host operations run on both arms: both declare the same
 *     NON_BLOCKING tools, and late asynchronous tool calls are handled
 *     identically after the turn boundary.
 *
 * CLIENT-NEUTRAL BY CONSTRUCTION (contract D7): no browser concept appears
 * here. The provider credential is never read in this module.
 */

import type { LiveConnectConfigShape } from './types.js';
import { VOICE_FUNCTION_DECLARATIONS } from './voice-tools.js';

/** The two programme arms (plan §7). Nothing else is selectable. */
export type VoiceLiveProfileId = 'standard' | 'et-high';

/** The one env/config key the campaign runner (child J) sets per arm. */
export const VOICE_LIVE_PROFILE_ENV_KEY = 'VOICE_LIVE_PROFILE';

/** Thinking support: standard has none; ET-HIGH is one fixed effort level. */
export type VoiceLiveThinking =
  | { readonly supported: false }
  | { readonly supported: true; readonly level: 'HIGH' };

/**
 * Tool-reply scheduling. `WHEN_IDLE` (finding F-1) keeps a declared tool call
 * from ending the turn in silence. Arms that do not support the field must
 * never send it — the adapter omits it entirely rather than casting it away.
 */
export type VoiceLiveToolReplyScheduling =
  | { readonly supported: true; readonly value: 'WHEN_IDLE' | 'SILENT' }
  | { readonly supported: false };

/**
 * Idle/completion semantics, stated per arm.
 *
 * `turnBoundary` is the provider message that ends the model's spoken turn.
 * `settled` is what may treat the interaction as idle:
 *   - `turnComplete` — the turn boundary settles the turn (standard);
 *   - `toolCallsDrained` — the boundary alone is NOT enough: accepted tool
 *     calls must be acknowledged and no further late call may be pending
 *     (Extended Thinking keeps working after it stops speaking, so a
 *     premature idle must never retire pending work or stop listening).
 */
export interface VoiceLiveIdleSemantics {
  readonly turnBoundary: 'turnComplete';
  /** Whether tool calls are expected AFTER the turn boundary (async work). */
  readonly lateToolCallsExpected: boolean;
  readonly settled: 'turnComplete' | 'toolCallsDrained';
}

/** Fields an arm may or may not support (unsupported ⇒ refused, never cast). */
export type VoiceLiveProfileField = 'thinkingConfig' | 'toolReplyScheduling' | 'contextWindowCompression';

export interface VoiceLiveProfile {
  readonly id: VoiceLiveProfileId;
  readonly model: string;
  readonly thinking: VoiceLiveThinking;
  /** Both arms declare the SAME NON_BLOCKING tools (identical tool meanings). */
  readonly toolBehavior: 'NON_BLOCKING';
  readonly toolReplyScheduling: VoiceLiveToolReplyScheduling;
  readonly idle: VoiceLiveIdleSemantics;
  /** Whether provider usage is expected to carry thought-token evidence. */
  readonly usage: { readonly expectsThoughtTokens: boolean };
  readonly resumption: { readonly supported: true };
  readonly contextWindowCompression: { readonly supported: false; readonly reason: string };
  /**
   * Unavoidable profile-specific instruction text. Null on both arms: the
   * prompts are identical in intent and content, so the comparison stays a
   * pure model comparison. Any future addendum MUST be recorded here.
   */
  readonly promptAddendum: null;
}

const CONTEXT_COMPRESSION_REASON =
  'contextWindowCompression is not enabled for this programme arm; sessions are bounded by the campaign soak design instead of compression';

/**
 * The profile table — the boundary itself. Both models are the repository
 * research names and are RE-RESOLVED BY THE LIVE PROBE before either arm is
 * declared supported (plan §7: do not trust the strings as facts).
 */
export const VOICE_LIVE_PROFILES: Readonly<Record<VoiceLiveProfileId, VoiceLiveProfile>> = {
  standard: {
    id: 'standard',
    model: 'gemini-3.8-live',
    thinking: { supported: false },
    toolBehavior: 'NON_BLOCKING',
    toolReplyScheduling: { supported: true, value: 'WHEN_IDLE' },
    idle: { turnBoundary: 'turnComplete', lateToolCallsExpected: true, settled: 'turnComplete' },
    usage: { expectsThoughtTokens: false },
    resumption: { supported: true },
    contextWindowCompression: { supported: false, reason: CONTEXT_COMPRESSION_REASON },
    promptAddendum: null,
  },
  'et-high': {
    id: 'et-high',
    model: 'gemini-3.8-live-extended-thinking',
    thinking: { supported: true, level: 'HIGH' },
    toolBehavior: 'NON_BLOCKING',
    toolReplyScheduling: { supported: false },
    idle: { turnBoundary: 'turnComplete', lateToolCallsExpected: true, settled: 'toolCallsDrained' },
    usage: { expectsThoughtTokens: true },
    resumption: { supported: true },
    contextWindowCompression: { supported: false, reason: CONTEXT_COMPRESSION_REASON },
    promptAddendum: null,
  },
};

/** Typed refusal for an unsupported field. The arm and field are named. */
export class UnsupportedVoiceProfileFieldError extends Error {
  constructor(profileId: VoiceLiveProfileId, field: VoiceLiveProfileField) {
    super(`voice live profile ${profileId} does not support ${field}; the field is refused, never cast away`);
    this.name = 'UnsupportedVoiceProfileFieldError';
  }
}

/** Typed failure for an unknown or malformed profile selection. */
export class InvalidVoiceLiveProfileError extends Error {
  constructor(raw: string) {
    super(
      `invalid ${VOICE_LIVE_PROFILE_ENV_KEY} value ${JSON.stringify(raw)}: expected one of ${Object.keys(
        VOICE_LIVE_PROFILES
      )
        .sort()
        .join(', ')}; refusing to guess which arm should run`,
    );
    this.name = 'InvalidVoiceLiveProfileError';
  }
}

export function profileFor(id: VoiceLiveProfileId): VoiceLiveProfile {
  const profile = (VOICE_LIVE_PROFILES as Record<string, VoiceLiveProfile | undefined>)[id];
  if (!profile) throw new InvalidVoiceLiveProfileError(String(id));
  return profile;
}

/**
 * Parse one raw selection. `null` means unset (the caller decides the
 * default). An unknown value throws — a typo must never silently run the
 * wrong arm.
 */
export function parseVoiceLiveProfileId(raw: string | undefined | null): VoiceLiveProfileId | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw === 'standard' || raw === 'et-high') return raw;
  throw new InvalidVoiceLiveProfileError(raw);
}

/** Resolve the arm from an env-like record. Unset ⇒ `standard`. Throws on typos. */
export function resolveVoiceLiveProfileId(env: NodeJS.ProcessEnv = process.env): VoiceLiveProfileId {
  return parseVoiceLiveProfileId(env[VOICE_LIVE_PROFILE_ENV_KEY]) ?? 'standard';
}

/** The default provider seat for a process: the resolved profile's model. */
export function defaultProviderModelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return profileFor(resolveVoiceLiveProfileId(env)).model;
}

export interface VoiceConnectConfigRequest {
  /** The driver supplies explicit activity markers (the manual-VAD profile). */
  manualActivityDetection: boolean;
  systemInstruction: string;
  resumptionHandle?: string | null;
}

/**
 * Assemble the connect config FOR ONE ARM. Pure and unit-testable.
 *
 * Everything except the profile-gated fields is byte-identical across arms:
 * same modalities, same transcriptions, same resumption, same VAD profile,
 * same declared tools, same system instruction. That identity is what makes
 * the two arms a model-only comparison (plan §7.5).
 */
export function buildVoiceConnectConfigForProfile(
  profile: VoiceLiveProfile,
  options: VoiceConnectConfigRequest
): LiveConnectConfigShape {
  const config: LiveConnectConfigShape = {
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: options.resumptionHandle ? { handle: options.resumptionHandle } : {},
    realtimeInputConfig: {
      automaticActivityDetection: options.manualActivityDetection ? { disabled: true } : {},
    },
    tools: [{ functionDeclarations: VOICE_FUNCTION_DECLARATIONS }],
    systemInstruction: { parts: [{ text: options.systemInstruction }] },
  };
  if (profile.thinking.supported) {
    assertProfileSupports(profile, 'thinkingConfig');
    config.thinkingConfig = { thinkingLevel: profile.thinking.level };
  }
  return config;
}

/**
 * The typed adapter gate: refuse an unsupported field with a typed error that
 * names the arm and the field. Callers never silently drop a field the arm
 * cannot use — refusing loudly is what keeps an arm from drifting into
 * half-configured behaviour.
 */
export function assertProfileSupports(profile: VoiceLiveProfile, field: VoiceLiveProfileField): void {
  switch (field) {
    case 'thinkingConfig':
      if (!profile.thinking.supported) throw new UnsupportedVoiceProfileFieldError(profile.id, field);
      return;
    case 'toolReplyScheduling':
      if (!profile.toolReplyScheduling.supported) {
        throw new UnsupportedVoiceProfileFieldError(profile.id, field);
      }
      return;
    case 'contextWindowCompression':
      // Recorded as unsupported-with-reason in the table; always refused here
      // until a profile explicitly declares support.
      throw new UnsupportedVoiceProfileFieldError(profile.id, field);
  }
}

const KEY_SHAPED_FIELD = /key|token|credential|secret|authorization|password/i;
const GOOGLE_KEY_MATERIAL = /AIza[0-9A-Za-z_-]{35}/;

/**
 * Deep-copy a connect config for the requested-identity record, replacing any
 * key-shaped leaf or Google key material with `[REDACTED]`. The outbound
 * config never carries the provider credential (the key is handed to the SDK
 * constructor only), so this is defence in depth: the recorded evidence must
 * be safe to paste into a handback even if a future field smuggles something
 * key-shaped in.
 */
export function redactConnectConfig(config: unknown): unknown {
  if (typeof config === 'string') {
    return GOOGLE_KEY_MATERIAL.test(config) ? '[REDACTED]' : config;
  }
  if (Array.isArray(config)) return config.map((entry) => redactConnectConfig(entry));
  if (config && typeof config === 'object') {
    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(config as Record<string, unknown>)) {
      out[field] = KEY_SHAPED_FIELD.test(field) ? '[REDACTED]' : redactConnectConfig(value);
    }
    return out;
  }
  return config;
}

/**
 * The requested-vs-actual identity record for one live session.
 *
 * `requested` is what THIS process asked for: the profile id, where the
 * selection came from, the model, and the redacted outbound config.
 * `acknowledged` is what the PROVIDER confirmed: setup completion on that
 * exact request, and usage evidence. The Live API usage metadata carries no
 * model-version field, so the honest actual-identity evidence is (a) setup
 * completion for the requested model string — the provider refuses unknown
 * models at connect — and (b) arm-discriminating usage counters (thought
 * tokens on the ET arm). Identity is NEVER taken from the model's own spoken
 * words; nothing in this record is fed from transcripts.
 */
export interface VoiceLiveIdentityRecord {
  readonly requested: {
    readonly profile: VoiceLiveProfileId;
    readonly source: 'env' | 'explicit';
    readonly model: string;
    /** Set when the first connect config is assembled; redacted for pasting. */
    connectConfig: unknown;
  };
  readonly acknowledged: {
    setupComplete: boolean;
    setupAtMs: number | null;
    usageMetadataSamples: number;
    thoughtTokenCountTotal: number;
    totalTokenCountTotal: number;
  };
}
