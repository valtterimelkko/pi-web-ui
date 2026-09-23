import { describe, it, expect } from 'vitest';

/**
 * Provider-profile boundary (plan §7, Phase 4) — the typed profile table and
 * its adapter.
 *
 * The two programme arms are exactly `standard` Live and Extended Thinking
 * HIGH. This suite pins the profile DATA (connect options, tool-reply shape,
 * idle/completion semantics, usage reporting, resumption and compression
 * support), the env selection contract (`VOICE_LIVE_PROFILE`), the redacted
 * requested-identity capture, and prompt identity across arms. No provider
 * call happens here: the real per-arm capability probe is
 * `voice-handshake-probe.ts`.
 */

import {
  InvalidVoiceLiveProfileError,
  VOICE_LIVE_PROFILE_ENV_KEY,
  VOICE_LIVE_PROFILES,
  assertProfileSupports,
  buildVoiceConnectConfigForProfile,
  defaultProviderModelFromEnv,
  parseVoiceLiveProfileId,
  profileFor,
  redactConnectConfig,
  resolveVoiceLiveProfileId,
} from '../../../src/voice/voice-profiles.js';
import { VOICE_FUNCTION_DECLARATIONS } from '../../../src/voice/gemini-live-bridge.js';

const BASE_OPTIONS = {
  manualActivityDetection: true,
  systemInstruction: 'You are a test talker.',
} as const;

describe('profile table — plan §7 arms', () => {
  it('defines exactly the two programme arms', () => {
    expect(Object.keys(VOICE_LIVE_PROFILES).sort()).toEqual(['et-high', 'standard']);
  });

  it('standard: no thinking support, WHEN_IDLE tool replies, turnComplete settle', () => {
    const p = VOICE_LIVE_PROFILES.standard;
    expect(p.model).toBeTypeOf('string');
    expect(p.model.length).toBeGreaterThan(0);
    expect(p.thinking).toEqual({ supported: false });
    expect(p.toolBehavior).toBe('NON_BLOCKING');
    expect(p.toolReplyScheduling).toEqual({ supported: true, value: 'WHEN_IDLE' });
    expect(p.idle.turnBoundary).toBe('turnComplete');
    expect(p.idle.settled).toBe('turnComplete');
    expect(p.usage.expectsThoughtTokens).toBe(false);
    expect(p.resumption).toEqual({ supported: true });
  });

  it('et-high: thinking HIGH, no tool-reply scheduling, drained settle, thought-token usage expected', () => {
    const p = VOICE_LIVE_PROFILES['et-high'];
    expect(p.thinking).toEqual({ supported: true, level: 'HIGH' });
    expect(p.toolBehavior).toBe('NON_BLOCKING');
    expect(p.toolReplyScheduling).toEqual({ supported: false });
    expect(p.idle.turnBoundary).toBe('turnComplete');
    expect(p.idle.settled).toBe('toolCallsDrained');
    expect(p.idle.lateToolCallsExpected).toBe(true);
    expect(p.usage.expectsThoughtTokens).toBe(true);
    expect(p.resumption).toEqual({ supported: true });
  });

  it('both arms declare the SAME tools and expect no profile-specific prompt text', () => {
    const standardConfig = buildVoiceConnectConfigForProfile(VOICE_LIVE_PROFILES.standard, BASE_OPTIONS);
    const etConfig = buildVoiceConnectConfigForProfile(VOICE_LIVE_PROFILES['et-high'], BASE_OPTIONS);
    expect(standardConfig.tools).toEqual([{ functionDeclarations: VOICE_FUNCTION_DECLARATIONS }]);
    expect(etConfig.tools).toEqual(standardConfig.tools);
    expect(VOICE_LIVE_PROFILES.standard.promptAddendum).toBeNull();
    expect(VOICE_LIVE_PROFILES['et-high'].promptAddendum).toBeNull();
  });

  it('both arms record context-window compression as not enabled, with the honest reason', () => {
    for (const id of ['standard', 'et-high'] as const) {
      expect(VOICE_LIVE_PROFILES[id].contextWindowCompression.supported).toBe(false);
      expect(VOICE_LIVE_PROFILES[id].contextWindowCompression.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('per-arm connect config (the typed adapter)', () => {
  it('standard requests NO thinking configuration', () => {
    const config = buildVoiceConnectConfigForProfile(VOICE_LIVE_PROFILES.standard, BASE_OPTIONS);
    expect('thinkingConfig' in config).toBe(false);
  });

  it('et-high requests thinking level HIGH and nothing else about thinking', () => {
    const config = buildVoiceConnectConfigForProfile(VOICE_LIVE_PROFILES['et-high'], BASE_OPTIONS);
    expect(config.thinkingConfig).toBeDefined();
    expect(config.thinkingConfig?.thinkingLevel).toBe('HIGH');
    expect(config.thinkingConfig?.thinkingBudget).toBeUndefined();
    expect(config.thinkingConfig?.includeThoughts).toBeUndefined();
  });

  it('everything except thinking is identical across arms for the same request', () => {
    const { thinkingConfig: _standardThinking, ...standard } = buildVoiceConnectConfigForProfile(
      VOICE_LIVE_PROFILES.standard,
      BASE_OPTIONS
    );
    const { thinkingConfig: _etThinking, ...et } = buildVoiceConnectConfigForProfile(
      VOICE_LIVE_PROFILES['et-high'],
      BASE_OPTIONS
    );
    expect(et).toEqual(standard);
  });

  it('carries the resumption handle when one is supplied (both arms)', () => {
    for (const id of ['standard', 'et-high'] as const) {
      const config = buildVoiceConnectConfigForProfile(VOICE_LIVE_PROFILES[id], {
        ...BASE_OPTIONS,
        resumptionHandle: 'handle-123',
      });
      expect(config.sessionResumption).toEqual({ handle: 'handle-123' });
    }
  });
});

describe('unsupported fields are refused, never cast away', () => {
  it('refuses thinkingConfig for the standard arm', () => {
    expect(() => assertProfileSupports(VOICE_LIVE_PROFILES.standard, 'thinkingConfig')).toThrow(
      /standard/
    );
  });

  it('refuses tool-reply scheduling for the et-high arm', () => {
    expect(() => assertProfileSupports(VOICE_LIVE_PROFILES['et-high'], 'toolReplyScheduling')).toThrow(
      /et-high/
    );
  });

  it('accepts the fields each arm does support', () => {
    expect(() => assertProfileSupports(VOICE_LIVE_PROFILES.standard, 'toolReplyScheduling')).not.toThrow();
    expect(() => assertProfileSupports(VOICE_LIVE_PROFILES['et-high'], 'thinkingConfig')).not.toThrow();
  });
});

describe('env selection contract (the J runner key)', () => {
  it('exposes VOICE_LIVE_PROFILE as the env key', () => {
    expect(VOICE_LIVE_PROFILE_ENV_KEY).toBe('VOICE_LIVE_PROFILE');
  });

  it('unset or empty means the standard arm', () => {
    expect(resolveVoiceLiveProfileId({})).toBe('standard');
    expect(resolveVoiceLiveProfileId({ [VOICE_LIVE_PROFILE_ENV_KEY]: '' })).toBe('standard');
  });

  it('accepts exactly standard and et-high (case-sensitive)', () => {
    expect(resolveVoiceLiveProfileId({ [VOICE_LIVE_PROFILE_ENV_KEY]: 'standard' })).toBe('standard');
    expect(resolveVoiceLiveProfileId({ [VOICE_LIVE_PROFILE_ENV_KEY]: 'et-high' })).toBe('et-high');
  });

  it('throws on an unknown value instead of silently running the wrong arm', () => {
    for (const bad of ['ET-HIGH', 'et_high', 'thinking', 'gemini-3.8-live']) {
      expect(() => resolveVoiceLiveProfileId({ [VOICE_LIVE_PROFILE_ENV_KEY]: bad })).toThrow(
        InvalidVoiceLiveProfileError
      );
    }
  });

  it('parse returns null for unset and throws for unknown', () => {
    expect(parseVoiceLiveProfileId(undefined)).toBeNull();
    expect(parseVoiceLiveProfileId('')).toBeNull();
    expect(() => parseVoiceLiveProfileId('nonsense')).toThrow(InvalidVoiceLiveProfileError);
  });

  it('profileFor throws on an unknown id', () => {
    expect(profileFor('standard').id).toBe('standard');
    expect(() => profileFor('nonsense' as never)).toThrow(InvalidVoiceLiveProfileError);
  });

  it('defaultProviderModelFromEnv resolves the model through the profile', () => {
    expect(defaultProviderModelFromEnv({})).toBe(VOICE_LIVE_PROFILES.standard.model);
    expect(defaultProviderModelFromEnv({ [VOICE_LIVE_PROFILE_ENV_KEY]: 'et-high' })).toBe(
      VOICE_LIVE_PROFILES['et-high'].model
    );
    expect(() => defaultProviderModelFromEnv({ [VOICE_LIVE_PROFILE_ENV_KEY]: 'bogus' })).toThrow(
      InvalidVoiceLiveProfileError
    );
  });
});

describe('redacted requested-identity capture', () => {
  it('deep-redacts key-shaped leaves without changing structure', () => {
    const redacted = redactConnectConfig({
      model: 'm',
      nested: { apiKey: 'AIzaXXX', systemInstruction: { parts: [{ text: 'hi' }] } },
      keep: 'value',
    }) as Record<string, unknown>;
    expect((redacted.nested as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect((redacted.nested as Record<string, unknown>).systemInstruction).toEqual({
      parts: [{ text: 'hi' }],
    });
    expect(redacted.keep).toBe('value');
    expect(redacted.model).toBe('m');
  });

  it('redacts anything that looks like Google key material wherever it appears', () => {
    const redacted = redactConnectConfig({
      a: { b: { c: 'AIza' + 'A'.repeat(35) } },
      sessionResumption: { handle: 'handle-xyz' },
    }) as Record<string, unknown>;
    expect(((redacted.a as Record<string, unknown>).b as Record<string, unknown>).c).toBe('[REDACTED]');
    expect(redacted.sessionResumption).toEqual({ handle: 'handle-xyz' });
  });
});
