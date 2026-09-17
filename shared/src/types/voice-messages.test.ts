/**
 * Executable checks for the frozen v1 Voice Mode wire contract.
 *
 * Four things are proved here, and each is a real failure mode rather than a
 * style preference:
 *
 *   1. CATALOGUE COMPLETENESS — every message the contract document names has a
 *      message type in code, in the right direction, and every code catalogue
 *      entry is documented. The shipped voice work already lost time to a wire
 *      contract the client implemented and the server never sent; a doc that
 *      silently drifts from the code is that defect in advance.
 *   2. ENVELOPE SHAPE — every message carries `type`, `version`, `laneId` and
 *      `attachmentGeneration`, and survives JSON transport unchanged.
 *   3. FAIL-CLOSED VERSIONING — a missing, mismatched or unknown version, an
 *      unknown type, a cross-direction type, or a lane-less frame is refused
 *      with a named code and nothing is acted on.
 *   4. THE CONFIRM RULE — a confirmation cannot exist without a proposal
 *      identity, and no client→server voice message can carry instruction text
 *      at all (N1/N2: the operator's words travel as audio; the model never
 *      composes instruction bytes, and a client cannot post them).
 *
 * See docs/plans/VOICE-LIVE-WIRE-CONTRACT.md for the normative document.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  VOICE_AUDIO_INPUT_FORMAT,
  VOICE_AUDIO_INPUT_MIME,
  VOICE_AUDIO_OUTPUT_FORMAT,
  VOICE_AUDIO_OUTPUT_MIME,
  VOICE_CLIENT_MESSAGE_TYPES,
  VOICE_INSTRUCTION_BEARING_KEYS,
  VOICE_MESSAGE_TYPES,
  VOICE_SERVER_MESSAGE_TYPES,
  VOICE_WIRE_VERSION,
  checkVoiceEnvelope,
  isProposalConfirmMessage,
  isVoiceAudioPayloadWithinLimit,
  isVoiceMessageType,
  voicePcm16ByteLength,
  type VoiceClientMessage,
  type VoiceServerMessage,
} from './voice-messages.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const CATALOGUE_BEGIN = '<!-- catalogue:begin -->';
const CATALOGUE_END = '<!-- catalogue:end -->';
const CATALOGUE_ROW_RE = /^\|\s*`([a-z0-9_]+)`\s*\|\s*(client → server|server → client)\s*\|/gm;

const DOC_PATH = fileURLToPath(new URL('../../../docs/plans/VOICE-LIVE-WIRE-CONTRACT.md', import.meta.url));
const SOURCE_PATH = fileURLToPath(new URL('./voice-messages.ts', import.meta.url));

const LANE_ID = 'session-abc:tab7';
const ATTACHMENT_GENERATION = 3;

const ENVELOPE = {
  version: VOICE_WIRE_VERSION,
  laneId: LANE_ID,
  attachmentGeneration: ATTACHMENT_GENERATION,
} as const;

/** One valid example of every client→server message (the catalogue's shape). */
const CLIENT_EXAMPLES: Record<VoiceClientMessage['type'], VoiceClientMessage> = {
  voice_session_start: {
    ...ENVELOPE,
    type: 'voice_session_start',
    workerSessionId: 'session-abc',
    runtime: 'pi',
    captureMode: 'open-mic',
    readingLevel: 'summary',
    requestId: 'req-1',
  },
  voice_session_stop: {
    ...ENVELOPE,
    type: 'voice_session_stop',
    reason: 'operator_stop',
    requestId: 'req-2',
  },
  voice_audio_chunk: {
    ...ENVELOPE,
    type: 'voice_audio_chunk',
    seq: 0,
    mimeType: VOICE_AUDIO_INPUT_MIME,
    data: 'AAAA',
    durationMs: 20,
    capturedAtMs: 1_700_000_000_000,
  },
  voice_activity_state: {
    ...ENVELOPE,
    type: 'voice_activity_state',
    state: 'speech_start',
    atMs: 1_700_000_000_000,
  },
  proposal_confirm: {
    ...ENVELOPE,
    type: 'proposal_confirm',
    proposalId: 'prop-1',
    variant: 'tidied',
    idempotencyKey: 'idem-1',
    proposalRef: { version: 4, sha256: 'a'.repeat(64) },
    requestId: 'req-3',
  },
  proposal_cancel: {
    ...ENVELOPE,
    type: 'proposal_cancel',
    proposalId: 'prop-1',
    reason: 'operator_cancel',
  },
  proposal_presentation: {
    ...ENVELOPE,
    type: 'proposal_presentation',
    proposalId: 'prop-1',
    presentedVariant: 'tidied',
    completed: false,
    stoppedAtChar: 42,
  },
  parking_promote: {
    ...ENVELOPE,
    type: 'parking_promote',
    itemId: 'item-1',
  },
  parking_list: {
    ...ENVELOPE,
    type: 'parking_list',
    requestId: 'req-4',
  },
  voice_reading_level: {
    ...ENVELOPE,
    type: 'voice_reading_level',
    level: 'headlines',
  },
};

/** One valid example of every server→client message. */
const SERVER_EXAMPLES: Record<VoiceServerMessage['type'], VoiceServerMessage> = {
  voice_state: {
    ...ENVELOPE,
    type: 'voice_state',
    state: 'live',
    workerActivity: 'busy',
    readingLevel: 'summary',
    captureMode: 'open-mic',
    resumption: { resumable: true },
  },
  voice_audio_chunk: {
    ...ENVELOPE,
    type: 'voice_audio_chunk',
    seq: 12,
    mimeType: VOICE_AUDIO_OUTPUT_MIME,
    data: 'AAAA',
    durationMs: 20,
    atMs: 1_700_000_000_000,
  },
  transcript_delta: {
    ...ENVELOPE,
    type: 'transcript_delta',
    speaker: 'operator',
    source: 'native',
    text: 'tell it to check the tests',
    final: true,
    utteranceId: 9,
    atMs: 1_700_000_000_000,
  },
  proposal_created: {
    ...ENVELOPE,
    type: 'proposal_created',
    proposalId: 'prop-1',
    proposalVersion: 4,
    sha256: 'a'.repeat(64),
    promotionRoute: 'parked_item',
    sourceItemId: 'item-1',
    sourceUtteranceId: 9,
    original: 'tell it to check the tests',
    tidied: 'tell it to check the tests',
    presentedVariant: 'tidied',
    presentation: { completed: true },
  },
  proposal_resolved: {
    ...ENVELOPE,
    type: 'proposal_resolved',
    proposalId: 'prop-1',
    outcome: 'released',
    releaseId: 'rel-1',
  },
  receipt_event: {
    ...ENVELOPE,
    type: 'receipt_event',
    receipt: {
      releaseId: 'rel-1',
      proposalId: 'prop-1',
      idempotencyKey: 'idem-1',
      outcome: 'delivered',
      mechanism: 'steer',
      atMs: 1_700_000_000_500,
    },
  },
  parking_updated: {
    ...ENVELOPE,
    type: 'parking_updated',
    operation: 'listed',
    items: [
      {
        itemId: 'item-1',
        text: 'ask about the retry logic',
        createdAtMs: 1_700_000_000_000,
        sourceUtteranceId: 9,
      },
    ],
  },
  voice_error: {
    ...ENVELOPE,
    type: 'voice_error',
    code: 'voice_audio_chunk_too_large',
    message: 'audio chunk exceeds the 100 ms ceiling',
    fatal: false,
  },
};

function readDoc(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function parseCatalogue(markdown: string): Array<{ type: string; direction: string }> {
  const begin = markdown.indexOf(CATALOGUE_BEGIN);
  const end = markdown.indexOf(CATALOGUE_END);
  expect(begin, 'the contract document has a `catalogue:begin` marker').toBeGreaterThanOrEqual(0);
  expect(end, 'the contract document has a `catalogue:end` marker').toBeGreaterThan(begin);
  const block = markdown.slice(begin, end);
  const rows: Array<{ type: string; direction: string }> = [];
  let match: RegExpExecArray | null;
  CATALOGUE_ROW_RE.lastIndex = 0;
  while ((match = CATALOGUE_ROW_RE.exec(block)) !== null) {
    rows.push({ type: match[1], direction: match[2] });
  }
  return rows;
}

// ── 1. Catalogue completeness ───────────────────────────────────────────────

describe('voice wire v1 — catalogue completeness', () => {
  it('documents exactly the code catalogue, in both directions', () => {
    const documented = parseCatalogue(readDoc());
    const inCode = [
      ...VOICE_CLIENT_MESSAGE_TYPES.map((type) => ({ type, direction: 'client → server' })),
      ...VOICE_SERVER_MESSAGE_TYPES.map((type) => ({ type, direction: 'server → client' })),
    ];
    const key = (row: { type: string; direction: string }) => `${row.direction}\u0000${row.type}`;
    expect(new Set(documented.map(key)).size).toBe(documented.length);
    expect([...documented.map(key)].sort()).toEqual([...inCode.map(key)].sort());
  });

  it('declares every documented type in the flat catalogue union', () => {
    for (const type of [...VOICE_CLIENT_MESSAGE_TYPES, ...VOICE_SERVER_MESSAGE_TYPES]) {
      expect(VOICE_MESSAGE_TYPES).toContain(type);
      expect(isVoiceMessageType(type)).toBe(true);
    }
  });

  it('carries voice_audio_chunk in both directions', () => {
    expect(VOICE_CLIENT_MESSAGE_TYPES).toContain('voice_audio_chunk');
    expect(VOICE_SERVER_MESSAGE_TYPES).toContain('voice_audio_chunk');
    const rows = parseCatalogue(readDoc()).filter((row) => row.type === 'voice_audio_chunk');
    expect(rows.map((row) => row.direction).sort()).toEqual(['client → server', 'server → client']);
  });

  it('provides a valid example of every message and rejects unknown types', () => {
    for (const message of Object.values(CLIENT_EXAMPLES)) {
      expect(isVoiceMessageType(message.type)).toBe(true);
      expect(checkVoiceEnvelope(message, 'client-to-server')).toEqual({ ok: true });
    }
    for (const message of Object.values(SERVER_EXAMPLES)) {
      expect(isVoiceMessageType(message.type)).toBe(true);
      expect(checkVoiceEnvelope(message, 'server-to-client')).toEqual({ ok: true });
    }
    expect(isVoiceMessageType('voice_teleport')).toBe(false);
    expect(isVoiceMessageType(undefined)).toBe(false);
  });

  it('covers every message with an example (no untested message type)', () => {
    expect(Object.keys(CLIENT_EXAMPLES).sort()).toEqual([...VOICE_CLIENT_MESSAGE_TYPES].sort());
    expect(Object.keys(SERVER_EXAMPLES).sort()).toEqual([...VOICE_SERVER_MESSAGE_TYPES].sort());
  });
});

// ── 2. Envelope shape ───────────────────────────────────────────────────────

describe('voice wire v1 — envelope', () => {
  it('pins the wire version and reads a full envelope', () => {
    expect(VOICE_WIRE_VERSION).toBe(1);
    const message = SERVER_EXAMPLES.voice_state;
    expect(message.type).toBe('voice_state');
    expect(message.version).toBe(1);
    expect(message.laneId).toBe(LANE_ID);
    expect(message.attachmentGeneration).toBe(ATTACHMENT_GENERATION);
  });

  it('survives JSON transport unchanged', () => {
    for (const message of Object.values(CLIENT_EXAMPLES)) {
      const roundTripped = JSON.parse(JSON.stringify(message)) as unknown;
      expect(checkVoiceEnvelope(roundTripped, 'client-to-server')).toEqual({ ok: true });
    }
    for (const message of Object.values(SERVER_EXAMPLES)) {
      const roundTripped = JSON.parse(JSON.stringify(message)) as unknown;
      expect(checkVoiceEnvelope(roundTripped, 'server-to-client')).toEqual({ ok: true });
    }
  });
});

// ── 3. Fail-closed versioning and routing ───────────────────────────────────

describe('voice wire v1 — fail closed', () => {
  it('refuses a missing or mismatched version', () => {
    const { version: _drop, ...noVersion } = CLIENT_EXAMPLES.proposal_confirm;
    expect(checkVoiceEnvelope(noVersion, 'client-to-server')).toEqual({
      ok: false,
      code: 'voice_version_unsupported',
    });
    expect(
      checkVoiceEnvelope({ ...CLIENT_EXAMPLES.proposal_confirm, version: 2 }, 'client-to-server')
    ).toEqual({ ok: false, code: 'voice_version_unsupported' });
    expect(
      checkVoiceEnvelope({ ...CLIENT_EXAMPLES.proposal_confirm, version: '1' }, 'client-to-server')
    ).toEqual({ ok: false, code: 'voice_version_unsupported' });
  });

  it('refuses an unknown type and a type from the other direction', () => {
    expect(checkVoiceEnvelope({ ...ENVELOPE, type: 'voice_teleport' }, 'client-to-server')).toEqual({
      ok: false,
      code: 'voice_message_unknown',
    });
    // transcript_delta is server→client; a client frame claiming it is refused.
    expect(
      checkVoiceEnvelope({ ...ENVELOPE, type: 'transcript_delta', text: 'hi' }, 'client-to-server')
    ).toEqual({ ok: false, code: 'voice_message_unknown' });
    expect(
      checkVoiceEnvelope({ ...ENVELOPE, type: 'proposal_confirm' }, 'server-to-client')
    ).toEqual({ ok: false, code: 'voice_message_unknown' });
  });

  it('refuses a frame without a lane identity or a usable generation', () => {
    for (const bad of [
      { ...ENVELOPE, laneId: undefined, type: 'parking_list' },
      { ...ENVELOPE, laneId: '', type: 'parking_list' },
      { ...ENVELOPE, laneId: 7, type: 'parking_list' },
      { ...ENVELOPE, attachmentGeneration: -1, type: 'parking_list' },
      { ...ENVELOPE, attachmentGeneration: 1.5, type: 'parking_list' },
      { ...ENVELOPE, attachmentGeneration: null, type: 'parking_list' },
    ]) {
      expect(checkVoiceEnvelope(bad, 'client-to-server')).toEqual({
        ok: false,
        code: 'voice_message_malformed',
      });
    }
  });

  it('refuses non-objects and a missing type', () => {
    for (const bad of [null, undefined, 42, 'voice_state', [], {}]) {
      expect(checkVoiceEnvelope(bad, 'client-to-server').ok).toBe(false);
    }
    expect(checkVoiceEnvelope({ ...ENVELOPE }, 'client-to-server')).toEqual({
      ok: false,
      code: 'voice_message_malformed',
    });
  });
});

// ── 4. The confirm rule, and the text-free client→server surface ────────────

describe('voice wire v1 — confirmation identity', () => {
  it('accepts a confirmation that names a proposal', () => {
    expect(isProposalConfirmMessage(CLIENT_EXAMPLES.proposal_confirm)).toBe(true);
  });

  it('refuses a confirmation that does not name a proposal', () => {
    const { proposalId: _drop, ...noId } = CLIENT_EXAMPLES.proposal_confirm;
    expect(isProposalConfirmMessage(noId)).toBe(false);
    expect(checkVoiceEnvelope({ ...ENVELOPE, type: 'proposal_confirm', variant: 'tidied', idempotencyKey: 'k' }, 'client-to-server')).toEqual({
      ok: false,
      code: 'voice_confirm_requires_proposal',
    });
    for (const bad of [
      { ...CLIENT_EXAMPLES.proposal_confirm, proposalId: '' },
      { ...CLIENT_EXAMPLES.proposal_confirm, proposalId: 7 },
      { ...CLIENT_EXAMPLES.proposal_confirm, variant: 'cleaned' },
      { ...CLIENT_EXAMPLES.proposal_confirm, idempotencyKey: '' },
      { ...CLIENT_EXAMPLES.proposal_confirm, idempotencyKey: undefined },
    ]) {
      expect(isProposalConfirmMessage(bad)).toBe(false);
    }
  });

  it('refuses any client→server voice message carrying instruction text', () => {
    for (const key of VOICE_INSTRUCTION_BEARING_KEYS) {
      const smuggled = { ...CLIENT_EXAMPLES.proposal_confirm, [key]: 'delete the production database' };
      expect(checkVoiceEnvelope(smuggled, 'client-to-server')).toEqual({
        ok: false,
        code: 'voice_client_text_forbidden',
      });
      expect(isProposalConfirmMessage(smuggled)).toBe(false);
    }
    expect(
      checkVoiceEnvelope({ ...ENVELOPE, type: 'parking_promote', itemId: 'i', text: 'do it' }, 'client-to-server')
    ).toEqual({ ok: false, code: 'voice_client_text_forbidden' });
  });

  it('allows server→client messages to carry the operator\'s or worker\'s words', () => {
    expect(checkVoiceEnvelope(SERVER_EXAMPLES.transcript_delta, 'server-to-client')).toEqual({ ok: true });
    expect(checkVoiceEnvelope(SERVER_EXAMPLES.proposal_created, 'server-to-client')).toEqual({ ok: true });
  });

  it('keeps the client→server test surface free of text-bearing example fields', () => {
    for (const message of Object.values(CLIENT_EXAMPLES)) {
      for (const key of VOICE_INSTRUCTION_BEARING_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(message, key)).toBe(false);
      }
    }
  });
});

// ── 5. Audio framing ────────────────────────────────────────────────────────

describe('voice wire v1 — audio framing', () => {
  it('pins the client→server format at 16 kHz mono PCM and the server→client at 24 kHz', () => {
    expect(VOICE_AUDIO_INPUT_FORMAT.sampleRateHz).toBe(16_000);
    expect(VOICE_AUDIO_INPUT_FORMAT.channels).toBe(1);
    expect(VOICE_AUDIO_INPUT_FORMAT.encoding).toBe('pcm_s16le');
    expect(VOICE_AUDIO_INPUT_MIME).toBe('audio/pcm;rate=16000');
    expect(VOICE_AUDIO_OUTPUT_FORMAT.sampleRateHz).toBe(24_000);
    expect(VOICE_AUDIO_OUTPUT_MIME).toBe('audio/pcm;rate=24000');
    expect(VOICE_AUDIO_INPUT_FORMAT.mimeType).toBe(VOICE_AUDIO_INPUT_MIME);
    expect(VOICE_AUDIO_OUTPUT_FORMAT.mimeType).toBe(VOICE_AUDIO_OUTPUT_MIME);
  });

  it('computes PCM16 byte counts and base64 ceilings consistently', () => {
    expect(voicePcm16ByteLength(16_000, 20)).toBe(640);
    expect(voicePcm16ByteLength(24_000, 20)).toBe(960);
    expect(voicePcm16ByteLength(16_000, VOICE_AUDIO_INPUT_FORMAT.maxChunkMs)).toBe(
      VOICE_AUDIO_INPUT_FORMAT.maxChunkBytes
    );
    expect(VOICE_AUDIO_INPUT_FORMAT.suggestedChunkBytes).toBe(640);
    expect(VOICE_AUDIO_OUTPUT_FORMAT.suggestedChunkBytes).toBe(960);
    expect(VOICE_AUDIO_INPUT_FORMAT.maxBase64Chars).toBe(4_268);
    expect(VOICE_AUDIO_OUTPUT_FORMAT.maxBase64Chars).toBe(6_400);
  });

  it('bounds audio payloads and drops oversized or corrupt chunks', () => {
    const within = 'A'.repeat(VOICE_AUDIO_INPUT_FORMAT.maxBase64Chars);
    expect(isVoiceAudioPayloadWithinLimit(VOICE_AUDIO_INPUT_FORMAT, within)).toBe(true);
    expect(isVoiceAudioPayloadWithinLimit(VOICE_AUDIO_INPUT_FORMAT, `${within}A`)).toBe(false);
    expect(isVoiceAudioPayloadWithinLimit(VOICE_AUDIO_INPUT_FORMAT, '!!!not base64!!!')).toBe(false);
    expect(isVoiceAudioPayloadWithinLimit(VOICE_AUDIO_INPUT_FORMAT, '')).toBe(false);
  });
});

// ── 6. Client-neutral kernel (D7) ───────────────────────────────────────────

describe('voice wire v1 — client-neutral (D7)', () => {
  it('uses no browser globals anywhere in the contract module', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const forbidden = [
      /\bwindow\b/,
      /\bdocument\b/,
      /\bnavigator\b/,
      /\blocalStorage\b/,
      /\bsessionStorage\b/,
      /\bAudioContext\b/,
      /\bAudioWorklet\b/,
      /\brequestAnimationFrame\b/,
    ];
    for (const pattern of forbidden) {
      expect(pattern.test(source), `voice-messages.ts must not reference ${String(pattern)}`).toBe(false);
    }
  });
});
