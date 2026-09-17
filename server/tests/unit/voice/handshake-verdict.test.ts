import { describe, it, expect } from 'vitest';

/**
 * Unit suite for the Gate 3b pass predicate.
 *
 * The live probe must fail when the audio path delivers silence or garbage.
 * The conductor's negative control produced the hallucinated delta `¿Qué?` from
 * a silenced fixture and the old check accepted it; these tests pin the verdict
 * that closes that hole — including that exact hallucination.
 */

import {
  HANDSHAKE_EXPECTED_PHRASE,
  evaluateHandshakeTranscript,
  normaliseHandshakeTranscript,
} from '../../../src/voice/handshake-verdict.js';

describe('normaliseHandshakeTranscript', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normaliseHandshakeTranscript('  VoiceBridge   HANDSHAKE check.  ')).toBe('voicebridge handshake check');
    expect(normaliseHandshakeTranscript('¡Hola! ¿Qué?')).toBe('hola qué');
  });

  it('returns an empty string for non-strings and whitespace-only input', () => {
    expect(normaliseHandshakeTranscript(undefined)).toBe('');
    expect(normaliseHandshakeTranscript(null)).toBe('');
    expect(normaliseHandshakeTranscript(42)).toBe('');
    expect(normaliseHandshakeTranscript('  \t\n ')).toBe('');
  });
});

describe('evaluateHandshakeTranscript', () => {
  it('accepts the exact phrase', () => {
    const verdict = evaluateHandshakeTranscript(HANDSHAKE_EXPECTED_PHRASE);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe('phrase-contains');
    expect(verdict.overlapRatio).toBe(1);
    expect(verdict.matchedTokens).toEqual(['voicebridge', 'handshake', 'check']);
  });

  it('accepts casing, punctuation and whitespace variation', () => {
    for (const text of [
      '  voicebridge HANDSHAKE check.  ',
      'VoiceBridge, handshake — check!',
      'VOICEBRIDGE HANDSHAKE CHECK',
    ]) {
      expect(evaluateHandshakeTranscript(text).ok, text).toBe(true);
    }
  });

  it('accepts the provider splitting VoiceBridge into two words (token overlap)', () => {
    const verdict = evaluateHandshakeTranscript('Voice Bridge handshake check');
    expect(verdict.ok).toBe(true);
    expect(verdict.matchedTokens).toEqual(['handshake', 'check']);
    expect(verdict.overlapRatio).toBeCloseTo(2 / 3, 5);
  });

  it('accepts a correct phrase inside extra words', () => {
    expect(evaluateHandshakeTranscript('yes, the voicebridge handshake check worked').ok).toBe(true);
  });

  it('rejects the conductor negative-control hallucination', () => {
    const verdict = evaluateHandshakeTranscript('¿Qué?');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('unrelated');
    expect(verdict.normalised).toBe('qué');
    expect(verdict.overlapRatio).toBe(0);
  });

  it('rejects a single correct token and short unrelated phrases', () => {
    for (const text of ['VoiceBridge', 'check', 'handshake', 'sí', 'voice bridge', 'thanks, all good']) {
      expect(evaluateHandshakeTranscript(text).ok, text).toBe(false);
    }
  });

  it('rejects empty and whitespace-only observations with the empty reason', () => {
    for (const text of ['', '   ', undefined, null]) {
      const verdict = evaluateHandshakeTranscript(text);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe('empty');
    }
  });

  it('does not accept a bare "checking" without handshake context', () => {
    const verdict = evaluateHandshakeTranscript('just checking in');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('unrelated');
  });

  it('never mutates or throws on hostile input shapes', () => {
    expect(() => evaluateHandshakeTranscript({ text: 'voicebridge handshake check' })).not.toThrow();
    expect(evaluateHandshakeTranscript({ text: 'voicebridge handshake check' }).ok).toBe(false);
    expect(() => evaluateHandshakeTranscript(['voicebridge', 'handshake', 'check'])).not.toThrow();
  });
});
