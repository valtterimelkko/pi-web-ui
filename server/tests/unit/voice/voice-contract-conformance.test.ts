import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract conformance suite (Track B).
 *
 * The bridge must reuse the FROZEN contract's own types, constants and runtime
 * guards — never a second copy. This suite proves that by importing the shared
 * module from source and asserting identity, not similarity:
 *   - the guards the service calls ARE the shared module's functions;
 *   - the internal format descriptors equal the contract's framing constants;
 *   - the catalogue split (bridge-owned vs kernel-owned) covers every
 *     client-to-server type exactly once;
 *   - no module under server/src/voice defines a rival validator.
 *
 * It reads the shared source by relative path on purpose: the source is the
 * authority, and the test must fail if the built copy ever drifts from it.
 */

import * as seam from '../../../src/voice/contract.js';
// The exact module the seam re-exports (same resolved file => same instance).
import * as built from '@pi-web-ui/shared/dist/types/voice-messages.js';
// The frozen SOURCE, used to prove the built module still behaves like it.
import * as source from '../../../../shared/src/types/voice-messages.js';
import { VOICE_PROVIDER_INPUT_FORMAT, VOICE_CLIENT_PLAYBACK_FORMAT } from '../../../src/voice/types.js';
import { BRIDGE_OWNED_CLIENT_MESSAGE_TYPES, KERNEL_OWNED_CLIENT_MESSAGE_TYPES } from '../../../src/voice/voice-router.js';

const voiceSrcDir = join(fileURLToPath(new URL('.', import.meta.url)), '../../../src/voice');

function readAllVoiceSources(): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) out.push({ path, source: readFileSync(path, 'utf8') });
    }
  };
  walk(voiceSrcDir);
  return out;
}

describe('the voice seam reuses the frozen contract, not a copy', () => {
  it('re-exports the built contract module by identity for every runtime guard', () => {
    expect(seam.checkVoiceEnvelope).toBe(built.checkVoiceEnvelope);
    expect(seam.isProposalConfirmMessage).toBe(built.isProposalConfirmMessage);
    expect(seam.isVoiceAudioPayloadWithinLimit).toBe(built.isVoiceAudioPayloadWithinLimit);
    expect(seam.voiceBase64DecodedByteLength).toBe(built.voiceBase64DecodedByteLength);
    expect(seam.hasNoToolArguments).toBe(built.hasNoToolArguments);
    expect(seam.voicePcm16ByteLength).toBe(built.voicePcm16ByteLength);
  });

  it('re-exports the built contract constants by identity and agrees with the frozen source', () => {
    expect(seam.VOICE_WIRE_VERSION).toBe(built.VOICE_WIRE_VERSION);
    expect(seam.VOICE_CONTEXT_COALESCE_MS).toBe(built.VOICE_CONTEXT_COALESCE_MS);
    expect(seam.VOICE_CLIENT_MESSAGE_TYPES).toBe(built.VOICE_CLIENT_MESSAGE_TYPES);
    expect(seam.VOICE_SERVER_MESSAGE_TYPES).toBe(built.VOICE_SERVER_MESSAGE_TYPES);
    expect(seam.VOICE_AUDIO_INPUT_FORMAT).toBe(built.VOICE_AUDIO_INPUT_FORMAT);
    expect(seam.VOICE_AUDIO_OUTPUT_FORMAT).toBe(built.VOICE_AUDIO_OUTPUT_FORMAT);
    expect(built.VOICE_CLIENT_MESSAGE_TYPES).toEqual(source.VOICE_CLIENT_MESSAGE_TYPES);
    expect(built.VOICE_SERVER_MESSAGE_TYPES).toEqual(source.VOICE_SERVER_MESSAGE_TYPES);
    expect(built.VOICE_AUDIO_INPUT_FORMAT).toEqual(source.VOICE_AUDIO_INPUT_FORMAT);
    expect(built.VOICE_AUDIO_OUTPUT_FORMAT).toEqual(source.VOICE_AUDIO_OUTPUT_FORMAT);
  });

  it('behaves identically to the frozen source across a refusal corpus (no drift, no rival validator)', () => {
    const frames: Array<[unknown, 'client-to-server' | 'server-to-client']> = [
      [{ type: 'parking_list', version: 1, laneId: 'x', attachmentGeneration: 0 }, 'client-to-server'],
      [{ type: 'parking_list', version: 2, laneId: 'x', attachmentGeneration: 0 }, 'client-to-server'],
      [{ type: 'parking_list', version: 1, laneId: 'x', attachmentGeneration: 0, text: 'do it' }, 'client-to-server'],
      [{ type: 'parking_list', version: 1, laneId: 'x', attachmentGeneration: 0, note: 'x' }, 'client-to-server'],
      [{ type: 'proposal_confirm', version: 1, laneId: 'x', attachmentGeneration: 0, variant: 'tidied', idempotencyKey: 'i' }, 'client-to-server'],
      [{ type: 'voice_state', version: 1, laneId: 'x', attachmentGeneration: 0, state: 'live' }, 'server-to-client'],
      [{ type: 'voice_error', version: 1, laneId: 'x', attachmentGeneration: 0 }, 'server-to-client'],
      [{ type: 'voice_note', version: 1, laneId: 'x', attachmentGeneration: 0 }, 'client-to-server'],
      ['not an object', 'client-to-server'],
    ];
    for (const [frame, direction] of frames) {
      expect(built.checkVoiceEnvelope(frame, direction)).toEqual(source.checkVoiceEnvelope(frame, direction));
      expect(seam.checkVoiceEnvelope(frame, direction)).toEqual(source.checkVoiceEnvelope(frame, direction));
    }
    expect(built.hasNoToolArguments({})).toBe(source.hasNoToolArguments({})).toBe(true);
    expect(built.hasNoToolArguments({ text: 'x' })).toBe(source.hasNoToolArguments({ text: 'x' })).toBe(false);
  });

  it('reuses the contract values for the wire version and coalescing window', () => {
    expect(seam.VOICE_WIRE_VERSION).toBe(1);
    expect(seam.VOICE_CONTEXT_COALESCE_MS).toBe(2_000);
    expect(seam.VOICE_AUDIO_INPUT_FORMAT.maxChunkBytes).toBe(3_200);
    expect(seam.VOICE_AUDIO_INPUT_FORMAT.maxBase64Chars).toBe(4_268);
    expect(seam.VOICE_AUDIO_OUTPUT_FORMAT.maxChunkBytes).toBe(4_800);
    expect(seam.VOICE_AUDIO_OUTPUT_FORMAT.maxBase64Chars).toBe(6_400);
  });

  it('keeps the internal format descriptors exactly equal to the contract framing', () => {
    for (const key of [
      'mimeType',
      'sampleRateHz',
      'channels',
      'maxChunkBytes',
      'maxBase64Chars',
    ] as const) {
      expect(VOICE_PROVIDER_INPUT_FORMAT[key]).toBe(built.VOICE_AUDIO_INPUT_FORMAT[key]);
      expect(VOICE_CLIENT_PLAYBACK_FORMAT[key]).toBe(built.VOICE_AUDIO_OUTPUT_FORMAT[key]);
    }
    expect(VOICE_PROVIDER_INPUT_FORMAT.mimeType).toBe('audio/pcm;rate=16000');
    expect(VOICE_CLIENT_PLAYBACK_FORMAT.mimeType).toBe('audio/pcm;rate=24000');
  });

  it('splits every client-to-server type exactly once between bridge and kernel ownership', () => {
    const split = [...BRIDGE_OWNED_CLIENT_MESSAGE_TYPES, ...KERNEL_OWNED_CLIENT_MESSAGE_TYPES].sort();
    expect(split).toEqual([...built.VOICE_CLIENT_MESSAGE_TYPES].sort());
    expect(new Set(split).size).toBe(split.length);
    expect(BRIDGE_OWNED_CLIENT_MESSAGE_TYPES).toEqual([
      'voice_session_start',
      'voice_session_stop',
      'voice_audio_chunk',
      'voice_activity_state',
      'voice_reading_level',
    ]);
  });

  it('defines no rival envelope validator or instruction-text blacklist in the voice module', () => {
    for (const { path, source } of readAllVoiceSources()) {
      expect(source, path).not.toMatch(/function\s+checkVoiceEnvelope/);
      expect(source, path).not.toMatch(/VOICE_INSTRUCTION_BEARING_KEYS\s*=/);
      expect(source, path).not.toMatch(/voice_message_unknown_field/);
    }
  });

  it('keeps the contract executable: the shared guards still refuse an instruction-bearing frame', () => {
    // A live self-check that the guard the router calls is genuinely the frozen one.
    expect(
      seam.checkVoiceEnvelope(
        { type: 'parking_list', version: 1, laneId: 'x', attachmentGeneration: 0, text: 'do it' },
        'client-to-server'
      )
    ).toEqual({ ok: false, code: 'voice_client_text_forbidden' });
    expect(
      seam.checkVoiceEnvelope(
        { type: 'proposal_confirm', version: 1, laneId: 'x', attachmentGeneration: 0, variant: 'tidied', idempotencyKey: 'i' },
        'client-to-server'
      )
    ).toEqual({ ok: false, code: 'voice_confirm_requires_proposal' });
  });

  it('never flattens a created proposal or a receipt in this module', () => {
    for (const { path, source } of readAllVoiceSources()) {
      expect(source, path).not.toMatch(/type:\s*'proposal_created'/);
      expect(source, path).not.toMatch(/type:\s*'receipt_event'/);
    }
  });
});

describe('the probe fixture is genuine speech, not a tone or silence', () => {
  it('is non-silent, speech-length audio with frame energy that varies', () => {
    const pcm = readFileSync(join(voiceSrcDir, 'fixtures', 'handshake-speech-16k.pcm'));
    expect(pcm.length).toBeGreaterThan(16_000); // > 0.5 s at 16 kHz mono PCM16
    expect(pcm.length % 2).toBe(0);
    const samples = pcm.length / 2;
    const seconds = samples / 16_000;
    expect(seconds).toBeGreaterThan(1.2);
    expect(seconds).toBeLessThan(4);

    let sumSquares = 0;
    const frameRms: number[] = [];
    const frameSamples = 1_600; // 100 ms
    let frameSum = 0;
    for (let i = 0; i < samples; i += 1) {
      const value = pcm.readInt16LE(i * 2);
      sumSquares += value * value;
      frameSum += value * value;
      if ((i + 1) % frameSamples === 0) {
        frameRms.push(Math.sqrt(frameSum / frameSamples));
        frameSum = 0;
      }
    }
    const rms = Math.sqrt(sumSquares / samples);
    expect(rms).toBeGreaterThan(150); // clearly audible, not digital silence
    expect(frameRms.length).toBeGreaterThan(5);
    const mean = frameRms.reduce((acc, value) => acc + value, 0) / frameRms.length;
    const variance = frameRms.reduce((acc, value) => acc + (value - mean) ** 2, 0) / frameRms.length;
    const coefficientOfVariation = Math.sqrt(variance) / Math.max(1, mean);
    // A steady sine has near-zero frame-energy variation; speech varies a lot.
    expect(coefficientOfVariation).toBeGreaterThan(0.3);
  });
});
