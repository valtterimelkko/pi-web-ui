/**
 * Voice Mode native-voice wire contract — version 1 (FROZEN).
 *
 * The normative contract text is `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md`;
 * this module is its executable half. Read them together: the table between the
 * `catalogue:begin` / `catalogue:end` markers in that file IS the catalogue, and
 * `voice-messages.test.ts` fails if the two ever drift apart.
 *
 * Two Tracks build against this file and must not edit it:
 *   - Track B (`server/src/voice/`) implements `VoiceBridgeService` and the thin
 *     router handler, and imports the types from here;
 *   - Track C (`client/src/lib/voiceWorklet/`, `client/src/components/DriveMode/`)
 *     speaks the client side of the catalogue.
 *
 * WHAT THIS CONTRACT GUARANTEES (structural, not by convention):
 *
 *   1. NO CLIENT INSTRUCTION TEXT. No client→server voice message can carry an
 *      instruction-bearing key (`text`, `utterance`, `instruction`, `relayText`,
 *      `message`, `prompt`) — `checkVoiceEnvelope` refuses such a frame. The
 *      operator's words travel as audio only; the recognised transcript is
 *      produced server-side. Typed operator input remains the existing `prompt`
 *      message on the session socket and is deliberately outside this contract.
 *      So a buggy or hostile client cannot post instruction bytes (N1, N2).
 *   2. A CONFIRMATION NEEDS A PROPOSAL IDENTITY. `voice_proposal_confirm` carries
 *      `proposalId` + `variant` + `idempotencyKey` and nothing else; it cannot be
 *      constructed (type level) or accepted (runtime guard) without a proposal
 *      identity, and the compile-time assertions below fail the build if an
 *      instruction-text key is ever added to it.
 *   3. FAIL CLOSED. A missing, mismatched or unknown `version`, an unknown or
 *      cross-direction `type`, a missing lane identity or a non-monotonic
 *      generation is refused with a named code; nothing is acted on.
 *   4. CLIENT-NEUTRAL (D7). This module contains no browser lifecycle global —
 *      no tab, page or audio-DOM assumption may reach the kernel's contract.
 *      `voice-messages.test.ts` inspects this file's source and fails if one
 *      appears.
 */

// ── Version ─────────────────────────────────────────────────────────────────

/**
 * Wire version of every message in this catalogue. Bump ONLY for a breaking
 * change (a new required field, a removed field, a changed meaning). Purely
 * additive optional fields stay within v1 and consumers ignore unknown fields.
 */
export const VOICE_WIRE_VERSION = 1;

export type VoiceWireVersion = typeof VOICE_WIRE_VERSION;

/** Longest lane id accepted; ids are opaque to the server. */
export const VOICE_WIRE_MAX_LANE_ID_CHARS = 200;

// ── Shared vocabulary ───────────────────────────────────────────────────────

/** Worker runtimes a voice lane may attach to (the talker's supported set). */
export type VoiceRuntime = 'pi' | 'claude' | 'antigravity';

/** Capture mode (intent §20). Ambient is deferred and accepted here only so a
 *  future mobile client needs no wire bump. */
export type VoiceCaptureMode = 'open-mic' | 'push-to-talk' | 'ambient';

/** Reading level (§10); an operation, never free text. */
export type VoiceReadingLevel = 'verbatim' | 'summary' | 'headlines';

/** Lane lifecycle as the client sees it. `live` doubles as the start ack. */
export type VoiceWireState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'suspended'
  | 'stopped'
  | 'error';

/** Worker activity, host-derived structured context (§4.5) — never a guess. */
export type VoiceWorkerActivity = 'idle' | 'busy' | 'unknown';

/**
 * Stable identity of one attached lane, minted by the client on
 * `voice_session_start` (recommended shape `${workerSessionId}:${tabNonce}`).
 * Opaque to the server and to the kernel.
 */
export type VoiceLaneId = string;

/**
 * Bumped by the client when the worker attached to a lane changes, and adopted
 * by the server at `voice_session_start`. It is the anti-retarget guard of
 * §4.11: a confirmation naming a generation the server has not accepted is
 * refused, never re-pointed at the new worker.
 */
export type AttachmentGeneration = number;

/** Which retained bytes a release sends (§16.3). */
export type VoiceProposalVariant = 'tidied' | 'original';

/** The three promotion routes (§18.1 / §4.4). Nothing else creates a proposal. */
export type VoicePromotionRoute = 'directed' | 'accepted_offer' | 'parked_item';

/** How a live proposal left its slot. NOT a delivery verdict — see `receipt_event`. */
export type VoiceProposalResolution =
  | 'released'
  | 'cancelled'
  | 'refused'
  | 'replaced'
  | 'expired';

/** The honest delivery states (§16.4, N6). `unknown` is at least a real state. */
export type VoiceReceiptOutcome = 'delivered' | 'queued' | 'refused' | 'unknown';

/** Why an outcome is `unknown`; the family the intent writes as `unknown*`. */
export type VoiceReceiptUnknownCause = 'timeout' | 'disconnect' | 'transport_error';

/** Client voice-activity boundary from local detection. Speech scheduling
 *  signal only — never a release trigger (§20, N3). */
export type VoiceActivityState = 'speech_start' | 'speech_end';

/** Why a lane's native session stopped. */
export type VoiceStopReason =
  | 'operator_stop'
  | 'lane_switch'
  | 'worker_switch'
  | 'client_disconnect'
  | 'provider_error'
  | 'provider_go_away'
  | 'dispose';

/** Why a proposal was abandoned. */
export type VoiceCancelReason = 'operator_cancel' | 'replaced' | 'lane_stopped';

/** Which stream a transcript delta belongs to. */
export type VoiceTranscriptSource = 'native' | 'shadow-asr';

/** Whose words a transcript delta carries. */
export type VoiceSpeaker = 'operator' | 'talker';

/**
 * Every refusal and failure code the contract names. Refusals are healthy
 * outcomes (intent §12): they are surfaced, never silent (N9).
 */
export type VoiceErrorCode =
  // envelope / version
  | 'voice_message_malformed'
  | 'voice_message_unknown'
  | 'voice_version_unsupported'
  // lane / attachment identity
  | 'voice_lane_unknown'
  | 'voice_generation_stale'
  | 'voice_not_started'
  // gate-adjacent refusals (all narrowing — none can authorise a release)
  | 'voice_client_text_forbidden'
  | 'voice_confirm_requires_proposal'
  | 'voice_proposal_stale'
  | 'voice_presentation_incomplete'
  // audio
  | 'voice_audio_chunk_too_large'
  | 'voice_audio_chunk_corrupt'
  // service
  | 'voice_provider_unavailable'
  | 'voice_quota_exhausted'
  | 'voice_internal_error';

// ── Audio framing ───────────────────────────────────────────────────────────

/** Mono 16-bit little-endian PCM, the only encoding v1 carries. */
export type VoicePcmEncoding = 'pcm_s16le';

export interface VoicePcmFormat {
  /** MIME type carried on every chunk of this direction. */
  readonly mimeType: string;
  readonly sampleRateHz: number;
  readonly channels: 1;
  readonly encoding: VoicePcmEncoding;
  /** Client-side pacing target. */
  readonly suggestedChunkMs: number;
  readonly suggestedChunkBytes: number;
  /** Hard ceiling: a larger chunk is dropped and surfaced, never buffered. */
  readonly maxChunkMs: number;
  readonly maxChunkBytes: number;
  /** Base64 length ceiling for `maxChunkBytes` (ceil(bytes/3)*4). */
  readonly maxBase64Chars: number;
}

export const VOICE_AUDIO_INPUT_MIME = 'audio/pcm;rate=16000';
export const VOICE_AUDIO_OUTPUT_MIME = 'audio/pcm;rate=24000';

export type VoiceAudioInputMime = typeof VOICE_AUDIO_INPUT_MIME;
export type VoiceAudioOutputMime = typeof VOICE_AUDIO_OUTPUT_MIME;

/** Client → server (microphone): 16 kHz mono, base64 PCM16LE. */
export const VOICE_AUDIO_INPUT_FORMAT: VoicePcmFormat = {
  mimeType: VOICE_AUDIO_INPUT_MIME,
  sampleRateHz: 16_000,
  channels: 1,
  encoding: 'pcm_s16le',
  suggestedChunkMs: 20,
  suggestedChunkBytes: 640,
  maxChunkMs: 100,
  maxChunkBytes: 3_200,
  maxBase64Chars: 4_268,
};

/** Server → client (model speech): 24 kHz mono, base64 PCM16LE. */
export const VOICE_AUDIO_OUTPUT_FORMAT: VoicePcmFormat = {
  mimeType: VOICE_AUDIO_OUTPUT_MIME,
  sampleRateHz: 24_000,
  channels: 1,
  encoding: 'pcm_s16le',
  suggestedChunkMs: 20,
  suggestedChunkBytes: 960,
  maxChunkMs: 100,
  maxChunkBytes: 4_800,
  maxBase64Chars: 6_400,
};

/** Bytes of mono PCM16 audio in `durationMs` at `sampleRateHz`. */
export function voicePcm16ByteLength(sampleRateHz: number, durationMs: number): number {
  return Math.round((sampleRateHz * durationMs) / 1000) * 2;
}

/**
 * Whether one base64 audio payload is inside the format's ceiling. An empty
 * payload is refused: silence is not a chunk, and a client that has nothing to
 * send should send nothing. Corrupt payloads (a base64 length that cannot be a
 * multiple of four, or a non-base64 character) are refused so the caller drops
 * and surfaces them (N9) rather than feeding garbage to the transcoder.
 */
export function isVoiceAudioPayloadWithinLimit(format: VoicePcmFormat, payloadBase64: string): boolean {
  if (typeof payloadBase64 !== 'string') return false;
  if (payloadBase64.length === 0) return false;
  if (payloadBase64.length > format.maxBase64Chars) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(payloadBase64) && payloadBase64.length % 4 === 0;
}

// ── Envelope ────────────────────────────────────────────────────────────────

/**
 * Fields every voice message carries. `laneId` + `attachmentGeneration` are the
 * message's target: on a proposal they are also the target the release is bound
 * to, which is why a stale confirm cannot be re-pointed at another worker.
 *
 * `requestId` is the request/response correlation id; the server echoes it on
 * every message that answers one and reuses the client's value so a lane can
 * correlate its own requests (the same convention as `talker_turn`).
 */
export interface VoiceEnvelope {
  type: VoiceMessageType;
  version: VoiceWireVersion;
  laneId: VoiceLaneId;
  attachmentGeneration: AttachmentGeneration;
  requestId?: string;
  /** Client-stamped send time (ms since epoch). Informational; never trusted. */
  sentAtMs?: number;
}

export type VoiceDirection = 'client-to-server' | 'server-to-client';

// ── Client → server messages ────────────────────────────────────────────────

/**
 * Open (or reopen) the lane's native voice session. The server mints the
 * provider session and answers with `voice_state { state: 'live' }` once the
 * provider reports setup complete; a refusal is a `voice_error`, never silence.
 */
export interface VoiceSessionStartMessage extends VoiceEnvelope {
  type: 'voice_session_start';
  /** Worker session the lane attaches to (id or path, as `talker_turn` allows). */
  workerSessionId: string;
  /** Defaults to 'pi'. */
  runtime?: VoiceRuntime;
  /** Defaults to 'open-mic'. */
  captureMode?: VoiceCaptureMode;
  /** Defaults to 'verbatim'. */
  readingLevel?: VoiceReadingLevel;
  /** True when this start resumes the previous generation after a socket drop. */
  resume?: boolean;
}

/** Close the lane's native voice session. Never releases anything. */
export interface VoiceSessionStopMessage extends VoiceEnvelope {
  type: 'voice_session_stop';
  reason: VoiceStopReason;
}

/** The audio payload shared by the audio chunk message and the service seam. */
export interface VoiceAudioInputChunk {
  /** Monotonic per lane from 0; a gap is surfaced, never silently reordered. */
  seq: number;
  mimeType: VoiceAudioInputMime;
  /** Base64 PCM16LE mono at 16 kHz. */
  data: string;
  durationMs: number;
  capturedAtMs: number;
}

/** Client → server microphone audio. */
export interface VoiceAudioInputChunkMessage extends VoiceEnvelope, VoiceAudioInputChunk {
  type: 'voice_audio_chunk';
}

/** Local voice-activity boundary. Scheduling input only — never a send trigger. */
export interface VoiceActivityStateMessage extends VoiceEnvelope {
  type: 'voice_activity_state';
  state: VoiceActivityState;
  atMs: number;
}

/**
 * The D-card gesture, typed. `proposalId` names the proposal the operator was
 * shown; `variant` names which retained bytes to release; `idempotencyKey` is
 * minted once per confirmation gesture and REUSED verbatim when the same
 * gesture is retried after a transport drop, so a retry can never deliver
 * twice. There is no field here that can carry instruction bytes — by design,
 * by type, and by the runtime guard.
 */
export interface VoiceProposalConfirmMessage extends VoiceEnvelope {
  type: 'proposal_confirm';
  proposalId: string;
  variant: VoiceProposalVariant;
  idempotencyKey: string;
  /**
   * Optional additive echo of the identity the card displayed; when present the
   * gate requires it to still describe the current proposal (the shipped
   * D-card behaviour). Absence keeps the gate bound to `proposalId` + `variant`.
   */
  proposalRef?: { version: number; sha256: string };
}

/** Abandon a live proposal. Narrowing only: it can never release. */
export interface VoiceProposalCancelMessage extends VoiceEnvelope {
  type: 'proposal_cancel';
  proposalId: string;
  reason: VoiceCancelReason;
}

/**
 * Report whether the read-back of a proposal actually completed (§4.6). This is
 * an OPERATION, not a verdict: `completed: true` authorises nothing at all, and
 * `completed: false` can only make a later confirmation refuse
 * (`voice_presentation_incomplete`). It is the one client signal that touches
 * the gate, and it can only narrow it (N8).
 */
export interface VoiceProposalPresentationMessage extends VoiceEnvelope {
  type: 'proposal_presentation';
  proposalId: string;
  presentedVariant: VoiceProposalVariant;
  completed: boolean;
  /** Where an interrupted read-back stopped, in characters; optional. */
  stoppedAtChar?: number;
}

/**
 * Promote ONE parked item. Creates the proposal, never a delivery: the parked
 * item's text is supplied by the kernel from the operator's own words, and the
 * release still requires `proposal_confirm`. Batch promotion does not exist
 * (N3 is per instruction).
 */
export interface VoiceParkingPromoteMessage extends VoiceEnvelope {
  type: 'parking_promote';
  itemId: string;
}

/** Read the parking lot back; the server answers with `parking_updated`. */
export interface VoiceParkingListMessage extends VoiceEnvelope {
  type: 'parking_list';
}

/** Change the reading level (§10). An operation; never free text. */
export interface VoiceReadingLevelMessage extends VoiceEnvelope {
  type: 'voice_reading_level';
  level: VoiceReadingLevel;
}

// ── Server → client messages ────────────────────────────────────────────────

/** Lane lifecycle and the structured state the surface renders. */
export interface VoiceStateMessage extends VoiceEnvelope {
  type: 'voice_state';
  state: VoiceWireState;
  workerActivity?: VoiceWorkerActivity;
  readingLevel?: VoiceReadingLevel;
  captureMode?: VoiceCaptureMode;
  /** Human-readable detail for `suspended` / `error`; never a promise. */
  detail?: string;
  resumption?: { resumable: boolean };
}

/** The audio payload shared by the audio chunk message and the service seam. */
export interface VoiceAudioOutputChunk {
  /** Monotonic per lane from 0, in provider delivery order. */
  seq: number;
  mimeType: VoiceAudioOutputMime;
  /** Base64 PCM16LE mono at 24 kHz. */
  data: string;
  durationMs: number;
  atMs: number;
}

/** Server → client model speech. */
export interface VoiceAudioOutputChunkMessage extends VoiceEnvelope, VoiceAudioOutputChunk {
  type: 'voice_audio_chunk';
}

/**
 * One transcript delta. Captions and the DRAFT both read this; the draft source
 * is the FINAL operator deltas only. A late revision after a final delta is a
 * new delta, never a silent rewrite of an authorised one (§4.6).
 */
export interface VoiceTranscriptDeltaMessage extends VoiceEnvelope {
  type: 'transcript_delta';
  speaker: VoiceSpeaker;
  source: VoiceTranscriptSource;
  text: string;
  final: boolean;
  /** Kernel utterance id, present once the turn is committed. */
  utteranceId?: number;
  /** Voice turn id (`runtime:workerSessionId:turnIndex`) when available. */
  turnId?: string;
  atMs: number;
}

/**
 * A live proposal. The envelope's laneId + attachmentGeneration ARE its target;
 * `presentedVariant` records what the operator is being shown, and
 * `presentation.completed` whether that read-back finished.
 *
 * NAMING: the envelope's `version` is the WIRE version (always 1). The
 * proposal's own version counter is `proposalVersion`, and its content digest is
 * `sha256` — two different numbers must never share one name. The confirm's
 * optional echo keeps the shipped card shape `proposalRef: { version, sha256 }`,
 * where the nested object makes the meaning unambiguous.
 */
export interface VoiceProposalCreatedMessage extends VoiceEnvelope {
  type: 'proposal_created';
  proposalId: string;
  /** The proposal's own version counter (NOT the envelope's wire version). */
  proposalVersion: number;
  /** SHA-256 over the exact release bytes of the presented variant. */
  sha256: string;
  promotionRoute: VoicePromotionRoute;
  /** Present when promotionRoute is 'parked_item'. */
  sourceItemId?: string;
  /** The operator utterance the proposal came from, when there is one. */
  sourceUtteranceId?: number;
  /** The operator's semi-verbatim words, retained in full (§4.6). */
  original: string;
  /** The tidied variant actually released by a default confirm. */
  tidied: string;
  presentedVariant: VoiceProposalVariant;
  presentation: { completed: boolean; stoppedAtChar?: number };
}

/**
 * The live proposal left its slot. This is NOT a delivery verdict: `released`
 * means the release path was authorised and handed to delivery. The only
 * evidence of delivery is `receipt_event` (N6) — never say "sent" on this.
 */
export interface VoiceProposalResolvedMessage extends VoiceEnvelope {
  type: 'proposal_resolved';
  proposalId: string;
  outcome: VoiceProposalResolution;
  /** Present when outcome is 'released'. */
  releaseId?: string;
  /** Present when outcome is 'refused'. */
  refusal?: VoiceErrorCode;
}

/** The authoritative delivery receipt (§16.4). */
export interface VoiceReceipt {
  releaseId: string;
  proposalId: string;
  idempotencyKey: string;
  outcome: VoiceReceiptOutcome;
  mechanism?: 'steer' | 'prompt' | 'follow_up';
  /** Per-runtime honest disclosure (e.g. Antigravity queueing). */
  disclosure?: string;
  /** Present when outcome is 'refused'. */
  reason?: string;
  /** Present when outcome is 'unknown'; names the `unknown*` family. */
  unknownCause?: VoiceReceiptUnknownCause;
  /** True when an 'unknown' outcome must be reconciled by idempotencyKey. */
  reconcile?: boolean;
  atMs: number;
}

/** One delivery outcome. The trusted chime fires on `outcome === 'delivered'`. */
export interface VoiceReceiptEventMessage extends VoiceEnvelope {
  type: 'receipt_event';
  receipt: VoiceReceipt;
}

/** One parked item: the operator's own words, held for later promotion. */
export interface VoiceParkedItem {
  itemId: string;
  /** The operator's words. Never sent anywhere without its own confirmation. */
  text: string;
  createdAtMs: number;
  sourceUtteranceId?: number;
}

/**
 * The parking lot, as a full ordered snapshot (oldest first) so a reconnecting
 * client needs no delta bookkeeping; `operation` says what just changed so the
 * surface can announce it.
 */
export interface VoiceParkingUpdatedMessage extends VoiceEnvelope {
  type: 'parking_updated';
  operation: 'added' | 'promoted' | 'removed' | 'listed';
  items: VoiceParkedItem[];
}

/** A refusal or failure, surfaced (N9). `fatal` means the lane stopped. */
export interface VoiceErrorMessage extends VoiceEnvelope {
  type: 'voice_error';
  code: VoiceErrorCode;
  message: string;
  fatal: boolean;
}

// ── Catalogue ───────────────────────────────────────────────────────────────

/** Client → server message types, in canonical order. */
export const VOICE_CLIENT_MESSAGE_TYPES = [
  'voice_session_start',
  'voice_session_stop',
  'voice_audio_chunk',
  'voice_activity_state',
  'proposal_confirm',
  'proposal_cancel',
  'proposal_presentation',
  'parking_promote',
  'parking_list',
  'voice_reading_level',
] as const;

/** Server → client message types, in canonical order. */
export const VOICE_SERVER_MESSAGE_TYPES = [
  'voice_state',
  'voice_audio_chunk',
  'transcript_delta',
  'proposal_created',
  'proposal_resolved',
  'receipt_event',
  'parking_updated',
  'voice_error',
] as const;

/**
 * The flat type list. `voice_audio_chunk` appears once per direction; use the
 * two directional arrays when direction matters.
 */
export const VOICE_MESSAGE_TYPES = [
  ...VOICE_CLIENT_MESSAGE_TYPES,
  ...VOICE_SERVER_MESSAGE_TYPES,
] as const;

export type VoiceClientMessageType = (typeof VOICE_CLIENT_MESSAGE_TYPES)[number];
export type VoiceServerMessageType = (typeof VOICE_SERVER_MESSAGE_TYPES)[number];
export type VoiceMessageType = (typeof VOICE_MESSAGE_TYPES)[number];

export type VoiceClientMessage =
  | VoiceSessionStartMessage
  | VoiceSessionStopMessage
  | VoiceAudioInputChunkMessage
  | VoiceActivityStateMessage
  | VoiceProposalConfirmMessage
  | VoiceProposalCancelMessage
  | VoiceProposalPresentationMessage
  | VoiceParkingPromoteMessage
  | VoiceParkingListMessage
  | VoiceReadingLevelMessage;

export type VoiceServerMessage =
  | VoiceStateMessage
  | VoiceAudioOutputChunkMessage
  | VoiceTranscriptDeltaMessage
  | VoiceProposalCreatedMessage
  | VoiceProposalResolvedMessage
  | VoiceReceiptEventMessage
  | VoiceParkingUpdatedMessage
  | VoiceErrorMessage;

export type VoiceMessage = VoiceClientMessage | VoiceServerMessage;

// ── Guards and fail-closed checks ───────────────────────────────────────────

/**
 * Keys that carry instruction bytes. NO client→server voice message may carry
 * one: the operator's words travel as audio, the transcript is server-side, and
 * typed input is the separate `prompt` path. This is the wire half of N1/N2.
 */
export const VOICE_INSTRUCTION_BEARING_KEYS = [
  'text',
  'utterance',
  'instruction',
  'relayText',
  'message',
  'prompt',
] as const;

export type VoiceInstructionBearingKey = (typeof VOICE_INSTRUCTION_BEARING_KEYS)[number];

export function isVoiceMessageType(value: unknown): value is VoiceMessageType {
  return typeof value === 'string' && (VOICE_MESSAGE_TYPES as readonly string[]).includes(value);
}

export function isVoiceClientMessageType(value: unknown): value is VoiceClientMessageType {
  return typeof value === 'string' && (VOICE_CLIENT_MESSAGE_TYPES as readonly string[]).includes(value);
}

export function isVoiceServerMessageType(value: unknown): value is VoiceServerMessageType {
  return typeof value === 'string' && (VOICE_SERVER_MESSAGE_TYPES as readonly string[]).includes(value);
}

/** True when a frame carries any instruction-bearing key. */
export function carriesInstructionText(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return VOICE_INSTRUCTION_BEARING_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(record, key)
  );
}

function isAttachmentGeneration(value: unknown): value is AttachmentGeneration {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isProposalRef(value: unknown): value is { version: number; sha256: string } {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.version === 'number' &&
    Number.isInteger(ref.version) &&
    typeof ref.sha256 === 'string' &&
    ref.sha256.length > 0
  );
}

/**
 * The confirm rule, enforced at runtime: a confirmation must name a proposal
 * identity, a variant and an idempotency key, and must carry no instruction
 * text. Anything else is not a confirmation and never reaches the gate.
 */
export function isProposalConfirmMessage(value: unknown): value is VoiceProposalConfirmMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'proposal_confirm') return false;
  if (carriesInstructionText(record)) return false;
  if (typeof record.proposalId !== 'string' || record.proposalId.length === 0) return false;
  if (record.variant !== 'tidied' && record.variant !== 'original') return false;
  if (typeof record.idempotencyKey !== 'string' || record.idempotencyKey.length === 0) return false;
  if (record.proposalRef !== undefined && !isProposalRef(record.proposalRef)) return false;
  return true;
}

export type VoiceEnvelopeCheck = { ok: true } | { ok: false; code: VoiceErrorCode };

function refuse(code: VoiceErrorCode): VoiceEnvelopeCheck {
  return { ok: false, code };
}

/**
 * The one fail-closed entry check for every inbound voice frame. Order matters
 * and is part of the contract: shape → type → direction → version → lane
 * identity → text-free → confirm identity. A refusal means nothing was acted
 * on; the caller surfaces it (N9) and never coerces the frame into shape.
 */
export function checkVoiceEnvelope(value: unknown, direction: VoiceDirection): VoiceEnvelopeCheck {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('voice_message_malformed');
  }
  const record = value as Record<string, unknown>;

  const type = record.type;
  if (typeof type !== 'string' || type.length === 0) return refuse('voice_message_malformed');

  const catalogue =
    direction === 'client-to-server' ? VOICE_CLIENT_MESSAGE_TYPES : VOICE_SERVER_MESSAGE_TYPES;
  if (!(catalogue as readonly string[]).includes(type)) return refuse('voice_message_unknown');

  if (typeof record.version !== 'number' || record.version !== VOICE_WIRE_VERSION) {
    return refuse('voice_version_unsupported');
  }

  if (
    typeof record.laneId !== 'string' ||
    record.laneId.length === 0 ||
    record.laneId.length > VOICE_WIRE_MAX_LANE_ID_CHARS
  ) {
    return refuse('voice_message_malformed');
  }

  if (!isAttachmentGeneration(record.attachmentGeneration)) return refuse('voice_message_malformed');

  if (direction === 'client-to-server' && carriesInstructionText(record)) {
    return refuse('voice_client_text_forbidden');
  }

  if (type === 'proposal_confirm' && !isProposalConfirmMessage(record)) {
    return refuse('voice_confirm_requires_proposal');
  }

  return { ok: true };
}

// ── Compile-time invariants (checked by `tsc`; erased at runtime) ───────────

/** Fails the build when its argument is not exactly `true`. */
type AssertTrue<T extends true> = T;

/** Distributes over a union type and collects the instruction-bearing keys. */
type InstructionKeysOf<T> = T extends unknown ? Extract<keyof T, VoiceInstructionBearingKey> : never;

/** The confirm names a proposal — `proposalId` is required, not optional. */
type _ConfirmProposalIdIsRequired = AssertTrue<
  VoiceProposalConfirmMessage['proposalId'] extends string ? true : false
>;

/** The confirm cannot carry instruction text — assertion 2 of the header. */
type _ConfirmCarriesNoInstructionText = AssertTrue<
  InstructionKeysOf<VoiceProposalConfirmMessage> extends never ? true : false
>;

/** No client→server message may ever gain an instruction-bearing field. */
type _ClientMessagesCarryNoInstructionText = AssertTrue<
  InstructionKeysOf<VoiceClientMessage> extends never ? true : false
>;

/** Every message carries the envelope, in both directions. */
type _ClientMessagesHaveEnvelope = AssertTrue<VoiceClientMessage extends VoiceEnvelope ? true : false>;
type _ServerMessagesHaveEnvelope = AssertTrue<VoiceServerMessage extends VoiceEnvelope ? true : false>;

/** The receipt vocabulary is complete: delivered, queued, refused and unknown. */
type _ReceiptsDistinguishAllStates = AssertTrue<
  'delivered' | 'queued' | 'refused' | 'unknown' extends VoiceReceiptOutcome ? true : false
>;
type _ReceiptsOnlyThoseStates = AssertTrue<
  VoiceReceiptOutcome extends 'delivered' | 'queued' | 'refused' | 'unknown' ? true : false
>;

/** The catalogue arrays cover the union exactly (no type without a name). */
type _ClientCatalogueIsExhaustive = AssertTrue<
  Exclude<VoiceClientMessage['type'], VoiceClientMessageType> extends never ? true : false
>;
type _ServerCatalogueIsExhaustive = AssertTrue<
  Exclude<VoiceServerMessage['type'], VoiceServerMessageType> extends never ? true : false
>;

// ── Server service boundary (the interface Track B implements) ──────────────

/**
 * Declared Live functions (the lab's `TIER1_TOOL_NAMES`). Both can only SUPPRESS
 * a draft candidate or CREATE one that still needs the operator's own
 * confirmation; neither can release, and neither can supply consent or bytes
 * (N1, N8).
 */
export type VoiceBridgeToolName = 'mark_addressed_to_talker' | 'offer_ask_worker';

/**
 * Everything the bridge emits. The union is the productised shape of the lab
 * adapter's `GeminiLiveCallbacks`, so the mapping is mechanical:
 *
 *   | lab callback                 | emitted event   | wire message          |
 *   |------------------------------|-----------------|-----------------------|
 *   | onAudioPcm                   | `audio_out`     | `voice_audio_chunk`   |
 *   | onInput/OutputTranscription  | `transcript`    | `transcript_delta`    |
 *   | onTurnComplete               | `turn_complete` | (state / captions)    |
 *   | onInterrupted                | `interrupted`   | `voice_state`         |
 *   | onToolCall                   | `tool_call`     | (kernel, not the wire)|
 *   | onResumptionHandle / onGoAway| `resumption` /  | `voice_state`         |
 *   |                              | `go_away`       |                       |
 *   | socket errors / close        | `error` /       | `voice_error` /       |
 *   |                              | `state`         | `voice_state`         |
 *
 * `tool_call` never becomes a wire message: it is how the kernel is driven
 * (suppress candidate / create candidate), and the model has no send path.
 */
export type VoiceBridgeEmittedEvent =
  | VoiceBridgeAudioOutEvent
  | VoiceBridgeTranscriptEvent
  | VoiceBridgeTurnCompleteEvent
  | VoiceBridgeInterruptedEvent
  | VoiceBridgeToolCallEvent
  | VoiceBridgeResumptionEvent
  | VoiceBridgeGoAwayEvent
  | VoiceBridgeStateEvent
  | VoiceBridgeErrorEvent;

interface VoiceBridgeEventBase {
  laneId: VoiceLaneId;
  attachmentGeneration: AttachmentGeneration;
}

export interface VoiceBridgeAudioOutEvent extends VoiceBridgeEventBase, VoiceAudioOutputChunk {
  kind: 'audio_out';
}

export interface VoiceBridgeTranscriptEvent extends VoiceBridgeEventBase {
  kind: 'transcript';
  speaker: VoiceSpeaker;
  source: VoiceTranscriptSource;
  text: string;
  final: boolean;
  utteranceId?: number;
  atMs: number;
}

export interface VoiceBridgeTurnCompleteEvent extends VoiceBridgeEventBase {
  kind: 'turn_complete';
  atMs: number;
}

export interface VoiceBridgeInterruptedEvent extends VoiceBridgeEventBase {
  kind: 'interrupted';
  atMs: number;
}

export interface VoiceBridgeToolCallEvent extends VoiceBridgeEventBase {
  kind: 'tool_call';
  callId: string;
  name: VoiceBridgeToolName;
  args: Record<string, unknown>;
  atMs: number;
}

export interface VoiceBridgeResumptionEvent extends VoiceBridgeEventBase {
  kind: 'resumption';
  handle: string | null;
  resumable: boolean;
}

export interface VoiceBridgeGoAwayEvent extends VoiceBridgeEventBase {
  kind: 'go_away';
  timeLeft?: string;
}

export interface VoiceBridgeStateEvent extends VoiceBridgeEventBase {
  kind: 'state';
  state: VoiceWireState;
  detail?: string;
}

export interface VoiceBridgeErrorEvent extends VoiceBridgeEventBase {
  kind: 'error';
  code: VoiceErrorCode;
  message: string;
  fatal: boolean;
}

/** The lifecycle callback surface. Each handler receives exactly one event. */
export interface VoiceBridgeCallbacks {
  onAudioOut?(event: VoiceBridgeAudioOutEvent): void;
  onTranscript?(event: VoiceBridgeTranscriptEvent): void;
  onTurnComplete?(event: VoiceBridgeTurnCompleteEvent): void;
  onInterrupted?(event: VoiceBridgeInterruptedEvent): void;
  onToolCall?(event: VoiceBridgeToolCallEvent): void;
  onResumption?(event: VoiceBridgeResumptionEvent): void;
  onGoAway?(event: VoiceBridgeGoAwayEvent): void;
  onStateChange?(event: VoiceBridgeStateEvent): void;
  onError?(event: VoiceBridgeErrorEvent): void;
}

export interface VoiceBridgeStartOptions {
  laneId: VoiceLaneId;
  attachmentGeneration: AttachmentGeneration;
  workerSessionId: string;
  runtime: VoiceRuntime;
  captureMode: VoiceCaptureMode;
  readingLevel: VoiceReadingLevel;
  /** True when reopening after a drop; the service may reuse a resumption handle. */
  resume?: boolean;
  callbacks: VoiceBridgeCallbacks;
}

/**
 * Structured worker context, supplied by the host every turn (§4.5, §17). It is
 * host-derived state, never model output, and never a command: the bridge
 * injects it with `sendClientContent({ turnComplete: false })`, coalesced to at
 * most one update per `VOICE_CONTEXT_COALESCE_MS` and held back while the
 * operator is speaking.
 */
export interface VoiceBridgeContextUpdate {
  workerActivity: VoiceWorkerActivity;
  /** One-line current activity, host-rendered. */
  activity?: string;
  /** Background children with statuses, host-rendered. */
  children?: string[];
  /** Pending items, host-rendered. */
  pendingItems?: string[];
  /** The status line injected each turn, e.g. 'CURRENT STATUS: RUNNING'. */
  statusLine: string;
  atMs: number;
}

/** Minimum spacing between context injections, in ms (§16.2 / Phase 3). */
export const VOICE_CONTEXT_COALESCE_MS = 2_000;

/** Read-only snapshot of one lane, for the diagnostics surface. */
export interface VoiceBridgeLaneState {
  laneId: VoiceLaneId;
  attachmentGeneration: AttachmentGeneration;
  state: VoiceWireState;
  workerActivity: VoiceWorkerActivity;
  readingLevel: VoiceReadingLevel;
  captureMode: VoiceCaptureMode;
  resumable: boolean;
  startedAtMs: number | null;
  lastEventAtMs: number | null;
}

/** One local activity boundary for one lane. */
export interface VoiceActivityNote {
  laneId: VoiceLaneId;
  attachmentGeneration: AttachmentGeneration;
  state: VoiceActivityState;
  atMs: number;
}

/**
 * The service Track B implements. `server/src/voice/voice-session.ts` (or the
 * equivalent) exports one instance per server; the router handler is the only
 * caller.
 *
 * Invariants the implementation must hold:
 *   - no provider credential ever appears in an emitted event or a wire message;
 *   - `feedAudio` never throws and never buffers past the format ceiling —
 *     oversized or corrupt chunks are dropped and surfaced as `voice_error`;
 *   - `stop` never releases anything and never delivers;
 *   - the service holds no browser lifecycle assumption of any kind (D7).
 */
export interface VoiceBridgeService {
  start(options: VoiceBridgeStartOptions): Promise<void>;
  stop(laneId: VoiceLaneId, reason: VoiceStopReason): Promise<void>;
  /** One operator audio chunk. Synchronous, bounded, non-throwing. */
  feedAudio(chunk: VoiceAudioInputChunk & { laneId: VoiceLaneId; attachmentGeneration: AttachmentGeneration }): void;
  /** Local voice-activity boundary; scheduling input only (N3, §20). */
  noteActivity(note: VoiceActivityNote): void;
  /** Inject structured worker context (coalesced; suppressed during speech). */
  injectContext(laneId: VoiceLaneId, update: VoiceBridgeContextUpdate): void;
  /** Operator reading-level operation (§10). */
  setReadingLevel(laneId: VoiceLaneId, level: VoiceReadingLevel): void;
  getState(laneId: VoiceLaneId): VoiceBridgeLaneState | null;
  /** Subscribe to emitted events; returns an unsubscribe function. */
  subscribe(listener: (event: VoiceBridgeEmittedEvent) => void): () => void;
  dispose(): Promise<void>;
}

// ── Router seam (the thin handler Phase 5 registers) ────────────────────────

/** Where the handler writes server→client voice messages. */
export interface VoiceRouteContext {
  send(message: VoiceServerMessage): void;
}

/**
 * The thin handler Phase 5 registers in
 * `server/src/websocket/connection.ts`'s `routeMessage` switch — one case per
 * `VOICE_CLIENT_MESSAGE_TYPES` entry, each delegating here.
 *
 * The handler adds no capability: it validates the envelope
 * (`checkVoiceEnvelope(…, 'client-to-server')`), routes to the kernel or the
 * bridge, and relays what they return. It never releases, never composes text,
 * and never widens the gate (N8).
 *
 * Returns the refusal code when the frame was refused (nothing acted on), or
 * `null` when it was accepted and handed on.
 */
export interface VoiceRouter {
  handle(context: VoiceRouteContext, message: VoiceClientMessage): Promise<VoiceErrorCode | null>;
}
