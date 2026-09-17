/**
 * voiceLive/messages — the typed client half of the native-voice wire contract.
 *
 * Spec: `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` (FROZEN v1) and its executable
 * half `shared/src/types/voice-messages.ts`. This module is deliberately thin:
 * it *builds* client→server frames and *interprets* server→client frames, and it
 * never re-implements a validator. Every check delegates to the shared guards
 * (`checkVoiceEnvelope`, `isVoiceAudioPayloadWithinLimit`), because the contract
 * is the single source of truth and a second validator here could drift.
 *
 * Structural properties this module preserves (contract §1.4):
 *
 *   1. NO INSTRUCTION TEXT CAN BE BUILT. Every builder takes structured values
 *      (ids, enums, booleans, audio bytes) — there is no parameter anywhere on
 *      this surface that accepts the operator's words. `finalise()` then runs
 *      the contract's own client→server check on the constructed frame, so a
 *      frame carrying an instruction-bearing or unnamed field is *refused
 *      before it can be sent*, not filtered later. A client bug fails closed
 *      and loudly instead of reaching the gate.
 *   2. A CONFIRMATION NEEDS A PROPOSAL IDENTITY. `createConfirmationGesture`
 *      cannot exist without a non-empty `proposalId` and a variant; the
 *      idempotency key is minted once per gesture and reused verbatim on
 *      retry, so a transport-drop retry can never deliver twice.
 *   3. FAIL CLOSED ON INBOUND. `interpretInbound` refuses an unknown,
 *      mismatched-version, malformed, other-lane or stale-generation frame
 *      with a named reason and applies nothing; the caller surfaces it (N9).
 *
 * N1/N5 are untouched here: nothing on this surface releases anything, and
 * nothing here has any influence over capture.
 */

import {
  VOICE_AUDIO_INPUT_FORMAT,
  VOICE_AUDIO_INPUT_MIME,
  VOICE_AUDIO_OUTPUT_FORMAT,
  VOICE_AUDIO_OUTPUT_MIME,
  VOICE_CLIENT_MESSAGE_FIELDS,
  VOICE_ENVELOPE_FIELDS,
  VOICE_WIRE_VERSION,
  checkVoiceEnvelope,
  isVoiceAudioPayloadWithinLimit,
  isVoiceClientMessageType,
  isVoiceServerMessageType,
  type AttachmentGeneration,
  type VoiceActivityState,
  type VoiceActivityStateMessage,
  type VoiceAudioInputChunk,
  type VoiceAudioInputChunkMessage,
  type VoiceAudioOutputChunkMessage,
  type VoiceCancelReason,
  type VoiceCaptureMode,
  type VoiceClientMessage,
  type VoiceErrorCode,
  type VoiceErrorMessage,
  type VoiceLaneId,
  type VoiceMessageType,
  type VoiceParkingListMessage,
  type VoiceParkingPromoteMessage,
  type VoiceParkingUpdatedMessage,
  type VoiceProposalCancelMessage,
  type VoiceProposalConfirmMessage,
  type VoiceProposalCreatedMessage,
  type VoiceProposalPresentationMessage,
  type VoiceProposalResolvedMessage,
  type VoiceProposalVariant,
  type VoiceReadingLevel,
  type VoiceReadingLevelMessage,
  type VoiceReceiptEventMessage,
  type VoiceRuntime,
  type VoiceServerMessage,
  type VoiceSessionStartMessage,
  type VoiceSessionStopMessage,
  type VoiceStateMessage,
  type VoiceStopReason,
  type VoiceTranscriptDeltaMessage,
  type VoiceWorkerActivity,
} from '@pi-web-ui/shared';

// ── Lane identity ───────────────────────────────────────────────────────────

/**
 * One (client surface × worker session) attachment. `laneId` is opaque to the
 * server: it is the recommended `${workerSessionId}:${nonce}` shape (contract
 * §3.1) and carries no browser concept out of the client (D7).
 */
export interface VoiceLaneIdentity {
  laneId: VoiceLaneId;
  attachmentGeneration: AttachmentGeneration;
  workerSessionId: string;
  runtime?: VoiceRuntime;
}

/** Per-message correlation / stamping, both optional and both non-authority. */
export interface VoiceStamp {
  requestId?: string;
  sentAtMs?: number;
}

let laneNonceCounter = 0;
let requestCounter = 0;
let idempotencyCounter = 0;

/** A per-surface instance value. Never parsed, never a browser concept. */
export function mintLaneNonce(): string {
  laneNonceCounter += 1;
  return `vl-${laneNonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Correlation id for a request that expects an answer (echoed by the server). */
export function mintRequestId(): string {
  requestCounter += 1;
  return `voicereq-${requestCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One idempotency key per confirmation gesture (contract §3.3). */
export function mintIdempotencyKey(): string {
  idempotencyCounter += 1;
  return `voiceidem-${idempotencyCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Open a lane at generation 0, with the contract's recommended id shape. */
export function createVoiceLane(input: {
  workerSessionId: string;
  runtime?: VoiceRuntime;
  nonce?: string;
}): VoiceLaneIdentity {
  const nonce = input.nonce ?? mintLaneNonce();
  return {
    laneId: `${input.workerSessionId}:${nonce}`,
    attachmentGeneration: 0,
    workerSessionId: input.workerSessionId,
    ...(input.runtime ? { runtime: input.runtime } : {}),
  };
}

/** Test/reset hook: drops the in-memory counters (ids stay opaque). */
export function resetVoiceLiveCounters(): void {
  laneNonceCounter = 0;
  requestCounter = 0;
  idempotencyCounter = 0;
}

// ── Fail-closed construction ────────────────────────────────────────────────

/** Thrown when a frame this module built is not schema-exact. A client bug. */
export class VoiceFrameRefusedError extends Error {
  readonly code: VoiceErrorCode;
  readonly frameType: VoiceMessageType | 'unknown';

  constructor(code: VoiceErrorCode, frameType: VoiceMessageType | 'unknown') {
    super(`voice frame refused by the contract: ${frameType} (${code})`);
    this.name = 'VoiceFrameRefusedError';
    this.code = code;
    this.frameType = frameType;
  }
}

/**
 * The one construction gate. Every builder returns through here, so a frame
 * that would be refused on the wire is refused *here* — before it can leave
 * the process — using the contract's own check rather than a local copy.
 */
function finalise<T extends VoiceClientMessage>(frame: T): T {
  const check = checkVoiceEnvelope(frame, 'client-to-server');
  if (!check.ok) {
    const type = typeof frame.type === 'string' ? (frame.type as VoiceMessageType) : 'unknown';
    throw new VoiceFrameRefusedError(check.code, type);
  }
  return frame;
}

/** The keys a client→server frame of this type may carry, for local asserts. */
export function clientFrameFieldSet(type: VoiceMessageType): readonly string[] {
  if (!isVoiceClientMessageType(type)) return [];
  return [...VOICE_ENVELOPE_FIELDS, ...(VOICE_CLIENT_MESSAGE_FIELDS[type] as readonly string[])];
}

interface VoiceEnvelopeFields {
  version: typeof VOICE_WIRE_VERSION;
  laneId: VoiceLaneId;
  attachmentGeneration: AttachmentGeneration;
  requestId?: string;
  sentAtMs?: number;
}

function envelope(lane: VoiceLaneIdentity, stamp?: VoiceStamp): VoiceEnvelopeFields {
  return {
    version: VOICE_WIRE_VERSION,
    laneId: lane.laneId,
    attachmentGeneration: lane.attachmentGeneration,
    ...(stamp?.requestId !== undefined ? { requestId: stamp.requestId } : {}),
    ...(stamp?.sentAtMs !== undefined ? { sentAtMs: stamp.sentAtMs } : {}),
  };
}

// ── Client → server builders ────────────────────────────────────────────────

export function buildSessionStart(
  lane: VoiceLaneIdentity,
  input: {
    captureMode?: VoiceCaptureMode;
    readingLevel?: VoiceReadingLevel;
    resume?: boolean;
  } = {},
  stamp?: VoiceStamp,
): VoiceSessionStartMessage {
  return finalise({
    type: 'voice_session_start',
    ...envelope(lane, stamp),
    workerSessionId: lane.workerSessionId,
    ...(lane.runtime ? { runtime: lane.runtime } : {}),
    ...(input.captureMode ? { captureMode: input.captureMode } : {}),
    ...(input.readingLevel ? { readingLevel: input.readingLevel } : {}),
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
  });
}

export function buildSessionStop(
  lane: VoiceLaneIdentity,
  reason: VoiceStopReason,
  stamp?: VoiceStamp,
): VoiceSessionStopMessage {
  return finalise({ type: 'voice_session_stop', ...envelope(lane, stamp), reason });
}

export function buildAudioChunk(
  lane: VoiceLaneIdentity,
  chunk: VoiceAudioInputChunk,
  stamp?: VoiceStamp,
): VoiceAudioInputChunkMessage {
  if (chunk.mimeType !== VOICE_AUDIO_INPUT_MIME) {
    throw new VoiceFrameRefusedError('voice_message_malformed', 'voice_audio_chunk');
  }
  if (!isVoiceAudioPayloadWithinLimit(VOICE_AUDIO_INPUT_FORMAT, chunk.data)) {
    throw new VoiceFrameRefusedError('voice_audio_chunk_too_large', 'voice_audio_chunk');
  }
  return finalise({ type: 'voice_audio_chunk', ...envelope(lane, stamp), ...chunk });
}

export function buildActivityState(
  lane: VoiceLaneIdentity,
  state: VoiceActivityState,
  atMs: number,
  stamp?: VoiceStamp,
): VoiceActivityStateMessage {
  return finalise({ type: 'voice_activity_state', ...envelope(lane, stamp), state, atMs });
}

export function buildProposalCancel(
  lane: VoiceLaneIdentity,
  input: { proposalId: string; reason: VoiceCancelReason },
  stamp?: VoiceStamp,
): VoiceProposalCancelMessage {
  return finalise({
    type: 'proposal_cancel',
    ...envelope(lane, stamp),
    proposalId: input.proposalId,
    reason: input.reason,
  });
}

export function buildProposalPresentation(
  lane: VoiceLaneIdentity,
  input: {
    proposalId: string;
    presentedVariant: VoiceProposalVariant;
    completed: boolean;
    stoppedAtChar?: number;
  },
  stamp?: VoiceStamp,
): VoiceProposalPresentationMessage {
  return finalise({
    type: 'proposal_presentation',
    ...envelope(lane, stamp),
    proposalId: input.proposalId,
    presentedVariant: input.presentedVariant,
    completed: input.completed,
    ...(input.stoppedAtChar !== undefined ? { stoppedAtChar: input.stoppedAtChar } : {}),
  });
}

export function buildParkingPromote(
  lane: VoiceLaneIdentity,
  itemId: string,
  stamp?: VoiceStamp,
): VoiceParkingPromoteMessage {
  return finalise({ type: 'parking_promote', ...envelope(lane, stamp), itemId });
}

export function buildParkingList(lane: VoiceLaneIdentity, stamp?: VoiceStamp): VoiceParkingListMessage {
  return finalise({ type: 'parking_list', ...envelope(lane, stamp) });
}

export function buildReadingLevel(
  lane: VoiceLaneIdentity,
  level: VoiceReadingLevel,
  stamp?: VoiceStamp,
): VoiceReadingLevelMessage {
  return finalise({ type: 'voice_reading_level', ...envelope(lane, stamp), level });
}

// ── Confirmation gestures ───────────────────────────────────────────────────

/**
 * One confirmation gesture, bound to one proposal identity and one variant.
 * The key is minted once and reused for every retry of THIS gesture — that is
 * the whole point of the key, and the type makes the reuse the default rather
 * than something a caller has to remember.
 */
export interface ConfirmationGesture {
  readonly proposalId: string;
  readonly variant: VoiceProposalVariant;
  readonly idempotencyKey: string;
  /** Attempts made with this gesture (the frame is byte-identical each time). */
  readonly attempts: number;
  frame(
    lane: VoiceLaneIdentity,
    proposalRef?: { version: number; sha256: string },
  ): VoiceProposalConfirmMessage;
}

export function createConfirmationGesture(input: {
  proposalId: string;
  variant: VoiceProposalVariant;
  idempotencyKey?: string;
}): ConfirmationGesture {
  if (typeof input.proposalId !== 'string' || input.proposalId.length === 0) {
    throw new VoiceFrameRefusedError('voice_confirm_requires_proposal', 'proposal_confirm');
  }
  if (input.variant !== 'tidied' && input.variant !== 'original') {
    throw new VoiceFrameRefusedError('voice_confirm_requires_proposal', 'proposal_confirm');
  }
  const idempotencyKey = input.idempotencyKey ?? mintIdempotencyKey();
  let attempts = 0;
  const gesture: ConfirmationGesture = {
    proposalId: input.proposalId,
    variant: input.variant,
    idempotencyKey,
    get attempts() {
      return attempts;
    },
    frame(lane, proposalRef) {
      attempts += 1;
      return finalise({
        type: 'proposal_confirm',
        ...envelope(lane, { requestId: mintRequestId() }),
        proposalId: gesture.proposalId,
        variant: gesture.variant,
        idempotencyKey: gesture.idempotencyKey,
        ...(proposalRef ? { proposalRef } : {}),
      });
    },
  };
  return gesture;
}

// ── Inbound interpretation (fail closed, visible) ───────────────────────────

/** Why an inbound frame was not applied. `code` is the contract's wire code
 *  where one applies; the extra client-local reasons are lane/order rules the
 *  contract states for the client (§3.3, §3.2) rather than wire refusals. */
export type VoiceInboundRefusalReason =
  | 'malformed'
  | 'unsupported-version'
  | 'unknown-type'
  | 'missing-field'
  | 'other-lane'
  | 'stale-generation'
  | 'foreign-request';

export type VoiceInboundResult =
  | { kind: 'accepted'; message: VoiceServerMessage }
  | {
      kind: 'refused';
      reason: VoiceInboundRefusalReason;
      code: VoiceErrorCode;
      detail: string;
    };

/**
 * Decide whether one inbound frame may be applied to this lane. Nothing is
 * coerced: an unknown type, an unsupported version, a missing field, another
 * lane's frame, or a frame from a generation this lane has not accepted is
 * refused, with the contract's own code where it has one.
 *
 * `acceptedRequestIds` is the lane's set of issued-and-unapplied request ids:
 * a frame whose `requestId` was never issued by this lane is refused, exactly
 * as the shipped `talkerBus` refuses a foreign correlated result.
 */
export function interpretInbound(
  raw: unknown,
  lane: VoiceLaneIdentity,
  acceptedRequestIds?: ReadonlySet<string>,
): VoiceInboundResult {
  const check = checkVoiceEnvelope(raw, 'server-to-client');
  if (!check.ok) {
    const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const type = record.type;
    const reason: VoiceInboundRefusalReason =
      check.code === 'voice_version_unsupported'
        ? 'unsupported-version'
        : check.code === 'voice_message_unknown'
          ? 'unknown-type'
          : check.code === 'voice_message_missing_field'
            ? 'missing-field'
            : 'malformed';
    return {
      kind: 'refused',
      reason,
      code: check.code,
      detail: `refused ${typeof type === 'string' ? type : 'unnamed frame'} (${check.code})`,
    };
  }

  const message = raw as VoiceServerMessage;
  if (message.laneId !== lane.laneId) {
    return {
      kind: 'refused',
      reason: 'other-lane',
      code: 'voice_lane_unknown',
      detail: `frame targets another lane (${message.type})`,
    };
  }
  if (message.attachmentGeneration !== lane.attachmentGeneration) {
    return {
      kind: 'refused',
      reason: 'stale-generation',
      code: 'voice_generation_stale',
      detail: `frame targets generation ${message.attachmentGeneration}, lane is at ${lane.attachmentGeneration} (${message.type})`,
    };
  }
  if (
    message.requestId !== undefined &&
    acceptedRequestIds !== undefined &&
    !acceptedRequestIds.has(message.requestId)
  ) {
    return {
      kind: 'refused',
      reason: 'foreign-request',
      code: 'voice_message_unknown',
      detail: `frame carries a requestId this lane did not issue (${message.type})`,
    };
  }
  return { kind: 'accepted', message };
}

/** True when the value is a server→client voice message type (structural). */
export function isVoiceServerMessage(value: unknown): value is VoiceServerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as Record<string, unknown>).type;
  return isVoiceServerMessageType(type);
}

// ── Delivery-chime gate ─────────────────────────────────────────────────────

/**
 * The trusted chime gate (contract §8.1, N6): TRUE only for a `receipt_event`
 * whose receipt outcome is `delivered`. `proposal_resolved { outcome:
 * "released" }` is explicitly NOT delivery evidence and must never chime.
 */
export function isDeliveredReceipt(
  message: VoiceServerMessage,
): message is VoiceReceiptEventMessage {
  return message.type === 'receipt_event' && message.receipt.outcome === 'delivered';
}

/** The distinct, non-delivery tone for an honest bad outcome; `null` when the
 *  message carries no receipt verdict at all. Never returns the delivered
 *  variant for anything but a delivered receipt. */
export function notDeliveredReceiptTone(
  message: VoiceServerMessage,
): 'refused' | 'queued' | 'unknown' | null {
  if (message.type !== 'receipt_event') return null;
  switch (message.receipt.outcome) {
    case 'refused':
      return 'refused';
    case 'queued':
      return 'queued';
    case 'unknown':
      return 'unknown';
    default:
      return null;
  }
}

// ── Audio framing helpers ───────────────────────────────────────────────────

/** Encode 16-bit PCM samples as base64 (no reliance on a Node Buffer). */
export function pcm16Base64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** Decode base64 into the raw bytes, or null when the encoding is malformed. */
export function base64Bytes(payload: string): Uint8Array | null {
  if (typeof payload !== 'string' || payload.length === 0) return null;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Decode a server→client 24 kHz PCM16LE chunk to float samples, or null when
 *  it is corrupt / over the decoded-byte ceiling (drop and surface, §5.3). */
export function decodeOutputChunk(message: VoiceAudioOutputChunkMessage): Float32Array | null {
  if (message.mimeType !== VOICE_AUDIO_OUTPUT_MIME) return null;
  if (!isVoiceAudioPayloadWithinLimit(VOICE_AUDIO_OUTPUT_FORMAT, message.data)) return null;
  const bytes = base64Bytes(message.data);
  if (!bytes || bytes.length % 2 !== 0) return null;
  const frameCount = bytes.length / 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}

/** Narrowing helpers used by the controller's state machine (no casting). */
export type ServerMessageOf<K extends VoiceServerMessage['type']> = Extract<
  VoiceServerMessage,
  { type: K }
>;

export function isOfType<K extends VoiceServerMessage['type']>(
  message: VoiceServerMessage,
  type: K,
): message is ServerMessageOf<K> {
  return message.type === type;
}

export type {
  VoiceActivityState,
  VoiceAudioInputChunk,
  VoiceClientMessage,
  VoiceAudioOutputChunkMessage,
  VoiceErrorMessage,
  VoiceParkingUpdatedMessage,
  VoiceProposalCreatedMessage,
  VoiceProposalResolvedMessage,
  VoiceReceiptEventMessage,
  VoiceServerMessage,
  VoiceStateMessage,
  VoiceTranscriptDeltaMessage,
  VoiceWorkerActivity,
};
