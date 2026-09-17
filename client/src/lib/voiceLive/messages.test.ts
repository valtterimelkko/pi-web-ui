import { describe, expect, it } from 'vitest';
// Vite's raw import keeps the source-inspection checks dependency-free (the
// jsdom test environment has no Node builtins).
import messagesSource from './messages.ts?raw';
import {
  VOICE_AUDIO_INPUT_FORMAT,
  VOICE_AUDIO_INPUT_MIME,
  VOICE_AUDIO_OUTPUT_FORMAT,
  VOICE_AUDIO_OUTPUT_MIME,
  VOICE_INSTRUCTION_BEARING_KEYS,
  VOICE_WIRE_VERSION,
  carriesInstructionText,
  checkVoiceEnvelope,
  isProposalConfirmMessage,
} from '@pi-web-ui/shared';
import {
  VoiceFrameRefusedError,
  base64Bytes,
  buildActivityState,
  buildAudioChunk,
  buildParkingList,
  buildParkingPromote,
  buildProposalCancel,
  buildProposalPresentation,
  buildReadingLevel,
  buildSessionStart,
  buildSessionStop,
  clientFrameFieldSet,
  createConfirmationGesture,
  createVoiceLane,
  decodeOutputChunk,
  interpretInbound,
  isDeliveredReceipt,
  isVoiceServerMessage,
  mintIdempotencyKey,
  notDeliveredReceiptTone,
  pcm16Base64,
  resetVoiceLiveCounters,
} from './messages';
import type { VoiceServerMessage } from '@pi-web-ui/shared';

// ── Fixtures ────────────────────────────────────────────────────────────────

const LANE = createVoiceLane({ workerSessionId: 'worker-1', runtime: 'pi', nonce: 'n1' });

function envelopeOf(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    version: VOICE_WIRE_VERSION,
    laneId: LANE.laneId,
    attachmentGeneration: LANE.attachmentGeneration,
    ...overrides,
  };
}

/** A minimal valid frame of every server→client type (contract §4.4). */
function serverFrame(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  switch (type) {
    case 'voice_state':
      return envelopeOf(type, { state: 'live', workerActivity: 'idle', ...payload });
    case 'voice_audio_chunk':
      return envelopeOf(type, {
        seq: 0,
        mimeType: VOICE_AUDIO_OUTPUT_MIME,
        data: pcm16Base64(new Int16Array([1, 2, 3])),
        durationMs: 20,
        atMs: 1,
        ...payload,
      });
    case 'transcript_delta':
      return envelopeOf(type, {
        speaker: 'operator',
        source: 'native',
        text: 'hello',
        final: true,
        atMs: 1,
        ...payload,
      });
    case 'proposal_created':
      return envelopeOf(type, { proposal: proposalPayload(), ...payload });
    case 'proposal_resolved':
      return envelopeOf(type, { proposalId: 'prop-1', outcome: 'released', ...payload });
    case 'receipt_event':
      return envelopeOf(type, { receipt: receiptPayload(), ...payload });
    case 'parking_updated':
      return envelopeOf(type, { operation: 'listed', items: [], ...payload });
    case 'voice_error':
      return envelopeOf(type, { code: 'voice_internal_error', message: 'x', fatal: false, ...payload });
    default:
      throw new Error(`no fixture for ${type}`);
  }
}

function proposalPayload(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: 'prop-1',
    version: 1,
    sha256: 'a'.repeat(64),
    promotionRoute: 'directed',
    original: 'ask it about the retry',
    tidied: 'ask it about the retry',
    presentedVariant: 'tidied',
    presentation: { completed: false },
    ...overrides,
  };
}

function receiptPayload(overrides: Record<string, unknown> = {}) {
  return {
    releaseId: 'rel-1',
    proposalId: 'prop-1',
    idempotencyKey: 'idem-1',
    outcome: 'delivered',
    atMs: 1,
    ...overrides,
  };
}

function asServerMessage(type: string, payload: Record<string, unknown> = {}): VoiceServerMessage {
  return serverFrame(type, payload) as unknown as VoiceServerMessage;
}

// ── Lane identity ───────────────────────────────────────────────────────────

describe('lane identity', () => {
  it('mints the contract-recommended opaque `${workerSessionId}:${nonce}` id at generation 0', () => {
    const lane = createVoiceLane({ workerSessionId: 'sess-9', runtime: 'claude' });
    expect(lane.laneId.startsWith('sess-9:')).toBe(true);
    expect(lane.laneId.length).toBeLessThanOrEqual(200);
    expect(lane.attachmentGeneration).toBe(0);
    expect(lane.workerSessionId).toBe('sess-9');
    expect(lane.runtime).toBe('claude');
  });

  it('mints distinct lane ids (two surfaces never collide)', () => {
    const a = createVoiceLane({ workerSessionId: 'sess-9' });
    const b = createVoiceLane({ workerSessionId: 'sess-9' });
    expect(a.laneId).not.toBe(b.laneId);
  });
});

// ── Builders are schema-exact and text-free ─────────────────────────────────

describe('client→server builders', () => {
  it('every builder produces a frame the contract accepts as client-to-server', () => {
    const frames = [
      buildSessionStart(LANE, { captureMode: 'open-mic', readingLevel: 'verbatim' }),
      buildSessionStop(LANE, 'operator_stop'),
      buildAudioChunk(LANE, {
        seq: 0,
        mimeType: VOICE_AUDIO_INPUT_MIME,
        data: pcm16Base64(new Int16Array(320)),
        durationMs: 20,
        capturedAtMs: 1,
      }),
      buildActivityState(LANE, 'speech_start', 1),
      createConfirmationGesture({ proposalId: 'prop-1', variant: 'tidied' }).frame(LANE),
      buildProposalCancel(LANE, { proposalId: 'prop-1', reason: 'operator_cancel' }),
      buildProposalPresentation(LANE, {
        proposalId: 'prop-1',
        presentedVariant: 'tidied',
        completed: true,
      }),
      buildParkingPromote(LANE, 'item-2'),
      buildParkingList(LANE),
      buildReadingLevel(LANE, 'headlines'),
    ];
    for (const frame of frames) {
      expect(checkVoiceEnvelope(frame, 'client-to-server')).toEqual({ ok: true });
      expect(carriesInstructionText(frame)).toBe(false);
    }
    expect(frames.length).toBe(10);
  });

  it('carries no field beyond the envelope plus the catalogue-declared fields', () => {
    const frames = [
      buildSessionStart(LANE, { captureMode: 'open-mic' }),
      buildSessionStop(LANE, 'operator_stop'),
      buildActivityState(LANE, 'speech_end', 2),
      createConfirmationGesture({ proposalId: 'prop-1', variant: 'original' }).frame(LANE, {
        version: 2,
        sha256: 'b'.repeat(64),
      }),
      buildProposalCancel(LANE, { proposalId: 'p', reason: 'replaced' }),
      buildParkingPromote(LANE, 'item-1'),
      buildParkingList(LANE),
      buildReadingLevel(LANE, 'summary'),
    ];
    for (const frame of frames) {
      const allowed = new Set(clientFrameFieldSet(frame.type));
      for (const key of Object.keys(frame)) expect(allowed.has(key)).toBe(true);
      for (const key of VOICE_INSTRUCTION_BEARING_KEYS) expect(key in frame).toBe(false);
    }
  });

  it('no client→server builder result can be extended with an instruction field without refusal', () => {
    const frame = buildReadingLevel(LANE, 'verbatim');
    const hostile = { ...frame, text: 'do the thing' };
    expect(checkVoiceEnvelope(hostile, 'client-to-server')).toEqual({
      ok: false,
      code: 'voice_client_text_forbidden',
    });
    const sneaky = { ...frame, note: 'do the thing' };
    expect(checkVoiceEnvelope(sneaky, 'client-to-server')).toEqual({
      ok: false,
      code: 'voice_message_unknown_field',
    });
  });

  it('refuses an oversize audio chunk on DECODED bytes and a wrong mime', () => {
    const overLimit = new Int16Array(Math.floor(VOICE_AUDIO_INPUT_FORMAT.maxChunkMs * 16) + 1);
    expect(() =>
      buildAudioChunk(LANE, {
        seq: 0,
        mimeType: VOICE_AUDIO_INPUT_MIME,
        data: pcm16Base64(overLimit),
        durationMs: 100,
        capturedAtMs: 1,
      }),
    ).toThrow(VoiceFrameRefusedError);
    expect(() =>
      buildAudioChunk(LANE, {
        seq: 0,
        mimeType: VOICE_AUDIO_INPUT_MIME,
        data: 'AAAA',
        durationMs: 1,
        capturedAtMs: 1,
      }),
    ).not.toThrow();
  });

  it('emits the envelope version literal, never a widened number', () => {
    expect(buildParkingList(LANE).version).toBe(VOICE_WIRE_VERSION);
    expect(buildParkingList(LANE).version).toBe(1);
  });
});

// ── Confirmation gestures ───────────────────────────────────────────────────

describe('confirmation gestures', () => {
  it('cannot exist without a proposal identity', () => {
    expect(() => createConfirmationGesture({ proposalId: '', variant: 'tidied' })).toThrow(
      VoiceFrameRefusedError,
    );
    expect(() =>
      createConfirmationGesture({ proposalId: 'p', variant: 'sideways' as never }),
    ).toThrow(VoiceFrameRefusedError);
  });

  it('reuses one idempotency key verbatim across retries of the same gesture', () => {
    resetVoiceLiveCounters();
    const gesture = createConfirmationGesture({ proposalId: 'prop-7', variant: 'tidied' });
    const first = gesture.frame(LANE, { version: 3, sha256: 'c'.repeat(64) });
    const retry = gesture.frame(LANE, { version: 3, sha256: 'c'.repeat(64) });
    expect(first.idempotencyKey).toBe(retry.idempotencyKey);
    expect(first.idempotencyKey.length).toBeGreaterThan(0);
    expect(first.proposalId).toBe('prop-7');
    expect(first.variant).toBe('tidied');
    expect(gesture.attempts).toBe(2);
    expect(isProposalConfirmMessage(first)).toBe(true);
    expect(isProposalConfirmMessage(retry)).toBe(true);
  });

  it('a fresh gesture mints a fresh key (two gestures are never the same delivery)', () => {
    const a = createConfirmationGesture({ proposalId: 'prop-7', variant: 'tidied' });
    const b = createConfirmationGesture({ proposalId: 'prop-7', variant: 'tidied' });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(mintIdempotencyKey()).not.toBe(mintIdempotencyKey());
  });

  it('carries no instruction text and no field that could hold any', () => {
    const frame = createConfirmationGesture({ proposalId: 'prop-7', variant: 'original' }).frame(LANE);
    expect(carriesInstructionText(frame)).toBe(false);
    expect(Object.keys(frame).sort()).toEqual(
      ['attachmentGeneration', 'idempotencyKey', 'laneId', 'proposalId', 'requestId', 'type', 'variant', 'version'].sort(),
    );
  });
});

// ── Inbound interpretation ──────────────────────────────────────────────────

describe('interpretInbound (fail closed)', () => {
  it('accepts every valid server→client frame for this lane and generation', () => {
    const types = [
      'voice_state',
      'voice_audio_chunk',
      'transcript_delta',
      'proposal_created',
      'proposal_resolved',
      'receipt_event',
      'parking_updated',
      'voice_error',
    ];
    for (const type of types) {
      const result = interpretInbound(serverFrame(type), LANE);
      expect(result.kind).toBe('accepted');
    }
  });

  it('refuses an unknown type, an unsupported version, a malformed frame and a missing field', () => {
    const unknown = interpretInbound(envelopeOf('voice_telepathy', {}), LANE);
    expect(unknown).toMatchObject({ kind: 'refused', reason: 'unknown-type' });

    const badVersion = interpretInbound({ ...serverFrame('voice_state'), version: 99 }, LANE);
    expect(badVersion).toMatchObject({ kind: 'refused', reason: 'unsupported-version' });

    expect(interpretInbound('not an object', LANE)).toMatchObject({ kind: 'refused', reason: 'malformed' });
    expect(interpretInbound(null, LANE)).toMatchObject({ kind: 'refused', reason: 'malformed' });
    expect(interpretInbound([], LANE)).toMatchObject({ kind: 'refused', reason: 'malformed' });

    const missing = interpretInbound(envelopeOf('proposal_created', {}), LANE);
    expect(missing).toMatchObject({ kind: 'refused', reason: 'missing-field' });
  });

  it('refuses a frame the client→server direction owns (cross-direction)', () => {
    const result = interpretInbound(buildParkingList(LANE), LANE);
    expect(result).toMatchObject({ kind: 'refused', reason: 'unknown-type' });
  });

  it('refuses another lane and a stale attachment generation', () => {
    const otherLane = interpretInbound({ ...serverFrame('voice_state'), laneId: 'other:lane' }, LANE);
    expect(otherLane).toMatchObject({ kind: 'refused', reason: 'other-lane' });

    const stale = interpretInbound({ ...serverFrame('voice_state'), attachmentGeneration: 7 }, LANE);
    expect(stale).toMatchObject({ kind: 'refused', reason: 'stale-generation' });
  });

  it('refuses a correlated frame whose requestId this lane never issued', () => {
    const correlated = { ...serverFrame('parking_updated'), requestId: 'req-foreign' };
    const issued = new Set(['req-mine']);
    expect(interpretInbound(correlated, LANE, issued)).toMatchObject({
      kind: 'refused',
      reason: 'foreign-request',
    });
    const mine = { ...serverFrame('parking_updated'), requestId: 'req-mine' };
    expect(interpretInbound(mine, LANE, issued).kind).toBe('accepted');
  });

  it('never applies anything: a refused frame is returned, not coerced', () => {
    const raw = { ...serverFrame('voice_state'), laneId: 'someone-else' };
    const result = interpretInbound(raw, LANE);
    expect(result.kind).toBe('refused');
    expect(isVoiceServerMessage(raw)).toBe(true); // the wire happened; the LANE refused it
  });
});

// ── Chime gate ──────────────────────────────────────────────────────────────

describe('delivery-chime gate', () => {
  it('chimes ONLY on a receipt_event with outcome delivered', () => {
    expect(isDeliveredReceipt(asServerMessage('receipt_event'))).toBe(true);
  });

  it('does not chime on proposal_resolved released (not delivery evidence)', () => {
    expect(isDeliveredReceipt(asServerMessage('proposal_resolved'))).toBe(false);
    expect(isDeliveredReceipt(asServerMessage('proposal_resolved', { outcome: 'refused' }))).toBe(false);
  });

  it('does not chime on queued / refused / unknown receipts', () => {
    for (const outcome of ['queued', 'refused', 'unknown'] as const) {
      const message = asServerMessage('receipt_event', { receipt: receiptPayload({ outcome }) });
      expect(isDeliveredReceipt(message)).toBe(false);
      expect(notDeliveredReceiptTone(message)).toBe(outcome);
    }
  });

  it('assigns a distinct non-delivery tone only to receipt verdicts', () => {
    expect(notDeliveredReceiptTone(asServerMessage('voice_state'))).toBeNull();
    expect(notDeliveredReceiptTone(asServerMessage('proposal_resolved'))).toBeNull();
    expect(notDeliveredReceiptTone(asServerMessage('receipt_event'))).toBeNull();
    expect(notDeliveredReceiptTone(asServerMessage('receipt_event', { receipt: receiptPayload({ outcome: 'refused' }) }))).toBe('refused');
  });
});

// ── Audio framing ───────────────────────────────────────────────────────────

describe('audio framing helpers', () => {
  it('round-trips PCM16 samples through base64', () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768]);
    const decoded = base64Bytes(pcm16Base64(samples));
    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(samples.byteLength);
  });

  it('decodes a 24 kHz output chunk to floats', () => {
    const samples = new Int16Array([16384, -16384, 0]);
    const message = asServerMessage('voice_audio_chunk', {
      data: pcm16Base64(samples),
      durationMs: 20,
    });
    const floats = decodeOutputChunk(message as never);
    expect(floats).not.toBeNull();
    expect(floats!.length).toBe(3);
    expect(floats![0]).toBeCloseTo(0.5, 3);
    expect(floats![1]).toBeCloseTo(-0.5, 3);
  });

  it('refuses a wrong mime, an odd byte length and an over-ceiling payload', () => {
    const wrongMime = asServerMessage('voice_audio_chunk', { mimeType: VOICE_AUDIO_INPUT_MIME });
    expect(decodeOutputChunk(wrongMime as never)).toBeNull();

    const odd = asServerMessage('voice_audio_chunk', { data: pcm16Base64(new Int16Array([1])) + 'I' });
    expect(decodeOutputChunk(odd as never)).toBeNull();

    const overLimit = new Int16Array(Math.floor(VOICE_AUDIO_OUTPUT_FORMAT.maxChunkMs * 24) + 2);
    const oversize = asServerMessage('voice_audio_chunk', { data: pcm16Base64(overLimit) });
    expect(decodeOutputChunk(oversize as never)).toBeNull();
  });

  it('refuses malformed base64 rather than throwing', () => {
    expect(base64Bytes('!!!!')).toBeNull();
    expect(base64Bytes('')).toBeNull();
  });
});

// ── Structural: no send path, no hand-rolled validator ──────────────────────

describe('messages module source invariants', () => {
  const source = messagesSource;

  it('has no network or send primitive (the transport owns sending, not this layer)', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest/);
    expect(source).not.toMatch(/new\s+WebSocket\s*\(/);
    expect(source).not.toMatch(/\.send\s*\(/);
  });

  it('delegates validation to the shared contract instead of hand-rolling it', () => {
    expect(source).toMatch(/checkVoiceEnvelope\s*\(/);
    expect(source).toMatch(/isVoiceAudioPayloadWithinLimit\s*\(/);
    // No duplicate catalogue literal lists in this file.
    expect(source).not.toMatch(/'voice_session_start',\s*'voice_session_stop'/);
  });
});
