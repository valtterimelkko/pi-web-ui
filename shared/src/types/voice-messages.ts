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
 *   2. A CONFIRMATION NEEDS A PROPOSAL IDENTITY. `proposal_confirm` carries
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
 * `voice_session_start`. The server and the kernel treat it as an opaque string:
 * no browser lifecycle concept may be read out of it (D7), so the recommended
 * shape is `${workerSessionId}:${clientNonce}` where the nonce is any per-surface
 * instance value the client chooses.
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
  // envelope / version / shape
  | 'voice_message_malformed'
  | 'voice_message_unknown'
  | 'voice_message_unknown_field'
  | 'voice_message_missing_field'
  | 'voice_version_unsupported'
  // lane / attachment identity
  | 'voice_lane_unknown'
  | 'voice_generation_stale'
  | 'voice_not_started'
  // ADDITIVE (Wave 3 correction M): the lane table is bounded (H2), and a
  // genuine cap must be refused as a capacity outcome rather than mislabelled
  // `voice_internal_error`. Track K's mount emits this code on the wire; it
  // joins the catalogue here so both consumers can name it. Nothing is renamed
  // or removed, and no existing code changes meaning.
  | 'voice_lane_capacity'
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
 * Bytes of PCM16 audio a base64 payload decodes to, or null when the payload is
 * not well-formed base64 (bad length, bad character, or bad padding). Padding is
 * counted, so the ceiling cannot be gamed with an unpadded string of the
 * maximum encoded length.
 */
export function voiceBase64DecodedByteLength(payloadBase64: unknown): number | null {
  if (typeof payloadBase64 !== 'string' || payloadBase64.length === 0) return null;
  if (payloadBase64.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payloadBase64)) return null;
  const padding = payloadBase64.endsWith('==') ? 2 : payloadBase64.endsWith('=') ? 1 : 0;
  const dataChars = payloadBase64.length - padding;
  if (padding > 0 && !/^[A-Za-z0-9+/]$/.test(payloadBase64[dataChars - 1] ?? '')) return null;
  const bytes = (payloadBase64.length / 4) * 3 - padding;
  return bytes > 0 ? bytes : null;
}

/**
 * Whether one base64 audio payload is inside the format's decoded-byte ceiling.
 *
 * The check is on the DECODED byte length, not the encoded character count: a
 * 4 268-character payload with no padding is 3 201 bytes and is refused, while
 * the exactly-3 200-byte payload (4 268 characters including its padding)
 * passes. An empty payload is refused — silence is not a chunk, and a client
 * with nothing to send should send nothing. Malformed base64 is refused too, so
 * the caller drops and surfaces it (N9) rather than feeding garbage to the
 * transcoder.
 */
export function isVoiceAudioPayloadWithinLimit(format: VoicePcmFormat, payloadBase64: unknown): boolean {
  if (typeof payloadBase64 !== 'string') return false;
  if (payloadBase64.length > format.maxBase64Chars) return false;
  const bytes = voiceBase64DecodedByteLength(payloadBase64);
  if (bytes === null) return false;
  return bytes <= format.maxChunkBytes;
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
/**
 * A capture fault the CLIENT observed — a worklet that would not load, a device
 * that refused, backpressure. It rides the activity frame as an additive
 * optional field so the server can record it: a microphone that cannot start is
 * then a fact in the server's own diagnostics and journal, not only in the one
 * operator's browser console (the 2026-09-18 native-lane field failure was
 * visible nowhere on the server side). The reason is a short machine token, so
 * the server's counters keep bounded cardinality.
 */
export interface VoiceCaptureFault {
  reason: string;
  detail?: string;
  atMs: number;
}

export interface VoiceActivityStateMessage extends VoiceEnvelope {
  type: 'voice_activity_state';
  state: VoiceActivityState;
  atMs: number;
  captureFault?: VoiceCaptureFault;
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
 * The retained payload a `proposal_created` message carries.
 *
 * NESTING IS DELIBERATE: the envelope already uses `version` for the WIRE
 * version (always 1), so the proposal's own version counter lives inside this
 * object, where its meaning is unambiguous and the brief's field name `version`
 * survives intact. This also matches the shipped card convention
 * (`talker_turn_result.proposal` in server/src/websocket/protocol.ts). Do not
 * flatten these fields onto the message: the compile-time assertion below fails
 * the build if anyone tries.
 */
export interface VoiceCreatedProposal {
  /** Stable identity; what a confirmation names. */
  proposalId: string;
  /** The proposal's own version counter (distinct from the envelope's wire version). */
  version: number;
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
 * A live proposal. The envelope's laneId + attachmentGeneration ARE its target;
 * `proposal.presentedVariant` records what the operator is being shown, and
 * `proposal.presentation.completed` whether that read-back finished.
 */
export interface VoiceProposalCreatedMessage extends VoiceEnvelope {
  type: 'proposal_created';
  proposal: VoiceCreatedProposal;
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

// ── Per-message field maps (the schema half of the envelope check) ───────────

/** Fields every voice message carries, in both directions. */
export const VOICE_ENVELOPE_FIELDS = [
  'type',
  'version',
  'laneId',
  'attachmentGeneration',
  'requestId',
  'sentAtMs',
] as const;

export type VoiceEnvelopeField = (typeof VOICE_ENVELOPE_FIELDS)[number];

/** A message's own declared fields, excluding the inherited envelope fields. */
type OwnFields<T, K> = Exclude<keyof Extract<T, { type: K }>, keyof VoiceEnvelope>;

/**
 * EVERY key a client→server message may carry (the message's own fields only;
 * the envelope fields are added by the check). The value type forces each entry
 * to be a real declared field of that exact message, and the assertion below the
 * maps forces every declared field to appear — so the map cannot drift.
 *
 * THIS MAP IS ENFORCED, NOT ADVISORY. A client→server frame carrying any other
 * key is refused with `voice_message_unknown_field`. That is what makes the
 * text-free guarantee structural rather than a six-name blacklist: instruction
 * bytes cannot ride in under an unlisted key such as `note`. Server→client frames
 * are the host's own words and ignore unknown fields, per the additive rule.
 */
export const VOICE_CLIENT_MESSAGE_FIELDS: {
  [K in VoiceClientMessageType]: readonly OwnFields<VoiceClientMessage, K>[];
} = {
  voice_session_start: ['workerSessionId', 'runtime', 'captureMode', 'readingLevel', 'resume'],
  voice_session_stop: ['reason'],
  voice_audio_chunk: ['seq', 'mimeType', 'data', 'durationMs', 'capturedAtMs'],
  voice_activity_state: ['state', 'atMs', 'captureFault'],
  proposal_confirm: ['proposalId', 'variant', 'idempotencyKey', 'proposalRef'],
  proposal_cancel: ['proposalId', 'reason'],
  proposal_presentation: ['proposalId', 'presentedVariant', 'completed', 'stoppedAtChar'],
  parking_promote: ['itemId'],
  parking_list: [],
  voice_reading_level: ['level'],
};

/** The subset of {@link VOICE_CLIENT_MESSAGE_FIELDS} that must be present. */
export const VOICE_CLIENT_REQUIRED_FIELDS: {
  [K in VoiceClientMessageType]: readonly OwnFields<VoiceClientMessage, K>[];
} = {
  voice_session_start: ['workerSessionId'],
  voice_session_stop: ['reason'],
  voice_audio_chunk: ['seq', 'mimeType', 'data', 'durationMs', 'capturedAtMs'],
  voice_activity_state: ['state', 'atMs'],
  proposal_confirm: ['proposalId', 'variant', 'idempotencyKey'],
  proposal_cancel: ['proposalId', 'reason'],
  proposal_presentation: ['proposalId', 'presentedVariant', 'completed'],
  parking_promote: ['itemId'],
  parking_list: [],
  voice_reading_level: ['level'],
};

/**
 * The subset of the server→client schema that must be present. The client uses
 * this with `checkVoiceEnvelope(..., 'server-to-client')` to refuse a malformed
 * host frame instead of rendering a half-built state.
 */
export const VOICE_SERVER_REQUIRED_FIELDS: {
  [K in VoiceServerMessageType]: readonly OwnFields<VoiceServerMessage, K>[];
} = {
  voice_state: ['state'],
  voice_audio_chunk: ['seq', 'mimeType', 'data', 'durationMs', 'atMs'],
  transcript_delta: ['speaker', 'source', 'text', 'final', 'atMs'],
  proposal_created: ['proposal'],
  proposal_resolved: ['proposalId', 'outcome'],
  receipt_event: ['receipt'],
  parking_updated: ['operation', 'items'],
  voice_error: ['code', 'message', 'fatal'],
};

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

function requiredFieldMissing(record: Record<string, unknown>, required: readonly string[]): string | null {
  for (const key of required) {
    if (record[key] === undefined || record[key] === null) return key;
  }
  return null;
}

function firstUnknownClientField(record: Record<string, unknown>, type: VoiceClientMessageType): string | null {
  const allowed = new Set<string>([
    ...VOICE_ENVELOPE_FIELDS,
    ...(VOICE_CLIENT_MESSAGE_FIELDS[type] as readonly string[]),
  ]);
  return Object.keys(record).find((key) => !allowed.has(key)) ?? null;
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
 * and is part of the contract:
 *
 *   shape → type/direction → version → lane identity → instruction text →
 *   unknown field (client→server) → confirm identity → required fields
 *
 * A refusal means nothing was acted on; the caller surfaces it (N9) and never
 * coerces the frame into shape. The client uses the same function with
 * `'server-to-client'` to refuse a malformed host frame.
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

  if (direction === 'client-to-server') {
    const clientType = type as VoiceClientMessageType;
    if (carriesInstructionText(record)) return refuse('voice_client_text_forbidden');
    if (firstUnknownClientField(record, clientType) !== null) {
      return refuse('voice_message_unknown_field');
    }
    if (type === 'proposal_confirm' && !isProposalConfirmMessage(record)) {
      return refuse('voice_confirm_requires_proposal');
    }
    if (requiredFieldMissing(record, VOICE_CLIENT_REQUIRED_FIELDS[clientType]) !== null) {
      return refuse('voice_message_missing_field');
    }
    return { ok: true };
  }

  if (requiredFieldMissing(record, VOICE_SERVER_REQUIRED_FIELDS[type as VoiceServerMessageType]) !== null) {
    return refuse('voice_message_missing_field');
  }

  return { ok: true };
}

// ── Compile-time invariants (checked by `tsc`; erased at runtime) ───────────
//
// Every assertion below uses the DIRECT indexed-type form (`T['k'] extends E`),
// because that is the form demonstrated to fail the build when the property is
// made optional or removed. Derived forms (mapped-type sweeps, `Pick`/`Required`
// comparisons) were tried and PROVED VACUOUS by probe — `tsc` stayed green with
// the field optional — so they are deliberately absent; the completeness of the
// field maps is asserted at runtime by the test instead.

/** Fails the build when its argument is not exactly `true`. */
type AssertTrue<T extends true> = T;

/** Distributes over a union type and collects the instruction-bearing keys. */
type InstructionKeysOf<T> = T extends unknown ? Extract<keyof T, VoiceInstructionBearingKey> : never;

/** The confirm names a proposal identity; each field is required. */
type _ConfirmProposalIdIsRequired = AssertTrue<
  VoiceProposalConfirmMessage['proposalId'] extends string ? true : false
>;
type _ConfirmVariantIsRequired = AssertTrue<
  VoiceProposalConfirmMessage['variant'] extends VoiceProposalVariant ? true : false
>;
type _ConfirmIdempotencyKeyIsRequired = AssertTrue<
  VoiceProposalConfirmMessage['idempotencyKey'] extends string ? true : false
>;

/** The confirm, and every client→server message, carries no instruction text. */
type _ConfirmCarriesNoInstructionText = AssertTrue<
  InstructionKeysOf<VoiceProposalConfirmMessage> extends never ? true : false
>;
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

/** The error catalogue is additive: the lane-capacity refusal (H2) is a code,
 *  and the pre-existing lane codes keep their meaning. */
type _LaneCapacityIsCatalogueCode = AssertTrue<
  'voice_lane_capacity' extends VoiceErrorCode ? true : false
>;
type _LaneCodesAreStillPresent = AssertTrue<
  'voice_lane_unknown' | 'voice_generation_stale' | 'voice_not_started' extends VoiceErrorCode
    ? true
    : false
>;

/** Payloads and verdicts that must be present for authority to exist at all. */
type _CreatedProposalPayloadIsRequired = AssertTrue<
  VoiceProposalCreatedMessage['proposal'] extends VoiceCreatedProposal ? true : false
>;
type _ReceiptPayloadIsRequired = AssertTrue<
  VoiceReceiptEventMessage['receipt'] extends VoiceReceipt ? true : false
>;
type _ErrorMessageIsRequired = AssertTrue<VoiceErrorMessage['message'] extends string ? true : false>;
type _ProposalResolvedOutcomeIsRequired = AssertTrue<
  VoiceProposalResolvedMessage['outcome'] extends VoiceProposalResolution ? true : false
>;

/** The created proposal keeps its own `version` INSIDE `proposal`, never flattened. */
type _CreatedProposalVersionIsRequired = AssertTrue<
  VoiceCreatedProposal['version'] extends number ? true : false
>;
type _CreatedProposalIsNotFlattened = AssertTrue<
  Extract<keyof VoiceProposalCreatedMessage, 'proposalId' | 'sha256' | 'presentedVariant'> extends never
    ? true
    : false
>;

/**
 * Consumes every assertion alias above so the compiler remains the only judge and
 * a later edit cannot quietly orphan one (an orphaned alias asserts nothing, and
 * the lint gate rightly refuses to let it pass unnoticed).
 */
export type VoiceContractAssertions = [
  _ConfirmProposalIdIsRequired,
  _ConfirmVariantIsRequired,
  _ConfirmIdempotencyKeyIsRequired,
  _ConfirmCarriesNoInstructionText,
  _ClientMessagesCarryNoInstructionText,
  _ClientMessagesHaveEnvelope,
  _ServerMessagesHaveEnvelope,
  _ReceiptsDistinguishAllStates,
  _ReceiptsOnlyThoseStates,
  _ClientCatalogueIsExhaustive,
  _ServerCatalogueIsExhaustive,
  _LaneCapacityIsCatalogueCode,
  _LaneCodesAreStillPresent,
  _CreatedProposalPayloadIsRequired,
  _ReceiptPayloadIsRequired,
  _ErrorMessageIsRequired,
  _ProposalResolvedOutcomeIsRequired,
  _CreatedProposalVersionIsRequired,
  _CreatedProposalIsNotFlattened,
];

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
  /** Kernel utterance id, present once the turn is committed. */
  utteranceId?: number;
  /** Voice turn id (`runtime:workerSessionId:turnIndex`) when available. */
  turnId?: string;
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
  /**
   * Both declared functions are PARAMETERLESS (the lab declares an empty
   * parameter object for each), so this is typed as an empty record on purpose:
   * a tool call can never carry an arbitrary payload into the kernel. The bridge
   * validates the provider's raw value with `hasNoToolArguments` before emitting,
   * and surfaces a violation instead of forwarding it.
   */
  args: Record<string, never>;
  atMs: number;
}

/** Runtime half of the parameterless-tool rule above. */
export function hasNoToolArguments(value: unknown): value is Record<string, never> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
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
