import { describe, expect, it } from 'vitest';

import { VOICE_MODE_ENGINES, config, resolveVoiceModeEngine } from '../../../src/config.js';

/**
 * Phase 8 (Gate 8): `VOICE_MODE_ENGINE=gemini-live|cascade`, default `cascade`.
 * The flag must be reversible (unset returns today's behaviour), validated
 * (an unknown value fails fast and loudly) and surfaced on the resolved config
 * so the engine selection site can consult exactly one value.
 */
describe('VOICE_MODE_ENGINE resolution', () => {
  it('defaults to cascade — today’s talker cascade — when unset or blank', () => {
    expect(resolveVoiceModeEngine({})).toBe('cascade');
    expect(resolveVoiceModeEngine({ VOICE_MODE_ENGINE: '' })).toBe('cascade');
    expect(resolveVoiceModeEngine({ VOICE_MODE_ENGINE: '   ' })).toBe('cascade');
  });

  it('accepts the two documented engines, case-insensitively and trimmed', () => {
    expect(resolveVoiceModeEngine({ VOICE_MODE_ENGINE: 'cascade' })).toBe('cascade');
    expect(resolveVoiceModeEngine({ VOICE_MODE_ENGINE: 'gemini-live' })).toBe('gemini-live');
    expect(resolveVoiceModeEngine({ VOICE_MODE_ENGINE: ' Gemini-Live ' })).toBe('gemini-live');
    expect(resolveVoiceModeEngine({ VOICE_MODE_ENGINE: 'CASCADE' })).toBe('cascade');
  });

  it('rejects an unknown value with a clear message naming the allowed set', () => {
    expect(() => resolveVoiceModeEngine({ VOICE_MODE_ENGINE: 'live' })).toThrow(/VOICE_MODE_ENGINE/);
    expect(() => resolveVoiceModeEngine({ VOICE_MODE_ENGINE: 'live' })).toThrow(/gemini-live/);
    expect(() => resolveVoiceModeEngine({ VOICE_MODE_ENGINE: 'live' })).toThrow(/cascade/);
  });

  it('exposes the resolved engine on the config singleton with the documented values', () => {
    expect(VOICE_MODE_ENGINES).toEqual(['gemini-live', 'cascade']);
    expect(VOICE_MODE_ENGINES).toContain(config.voiceModeEngine);
  });
});
