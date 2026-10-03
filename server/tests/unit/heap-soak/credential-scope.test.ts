import { describe, expect, it } from 'vitest';
import { assertAllowedProviderPresent, parseAllowedProviders, scopeAuthJson, scopeModelsJson } from '../../../src/live-validation/heap-soak/credential-scope.js';

/**
 * E2a-1 parent condition (01-answer.md): the soak's isolated agent dir may
 * carry ONLY the approved route's credential. The binding rule (common brief;
 * agent-os-child §3) is to copy only the approved route's credential — here
 * `zai` — because a full credential copy is exactly how the unauthorised
 * OpenRouter call in smoke 1 became possible.
 *
 * Tests use SYNTHETIC credential shapes (key names only, fake values) — no
 * real secret is ever read by this suite.
 */

describe('parseAllowedProviders (HEAP_SOAK_CREDENTIAL_PROVIDERS)', () => {
  it('is undefined when unset or blank (historic full-copy behaviour)', () => {
    expect(parseAllowedProviders({})).toBeUndefined();
    expect(parseAllowedProviders({ HEAP_SOAK_CREDENTIAL_PROVIDERS: '' })).toBeUndefined();
    expect(parseAllowedProviders({ HEAP_SOAK_CREDENTIAL_PROVIDERS: '  ' })).toBeUndefined();
  });

  it('parses a comma-separated list and trims whitespace', () => {
    expect(parseAllowedProviders({ HEAP_SOAK_CREDENTIAL_PROVIDERS: 'zai' })).toEqual(['zai']);
    expect(parseAllowedProviders({ HEAP_SOAK_CREDENTIAL_PROVIDERS: ' zai , openai-codex ' })).toEqual(['zai', 'openai-codex']);
  });

  it('refuses empty tokens (a stray comma must not silently widen or empty the scope)', () => {
    expect(() => parseAllowedProviders({ HEAP_SOAK_CREDENTIAL_PROVIDERS: 'zai,' })).toThrow(/empty provider/);
    expect(() => parseAllowedProviders({ HEAP_SOAK_CREDENTIAL_PROVIDERS: ',' })).toThrow(/empty provider/);
  });
});

describe('scopeAuthJson', () => {
  const auth = {
    zai: { type: 'api', key: 'FAKE-zai' },
    openrouter: { type: 'api', key: 'FAKE-openrouter' },
    anthropic: { type: 'oauth', access: 'FAKE-a', refresh: 'FAKE-r', expires: 1 },
  };

  it('keeps only the allowed providers’ credentials', () => {
    const scoped = scopeAuthJson(auth, ['zai']);
    expect(Object.keys(scoped).sort()).toEqual(['zai']);
    expect(scoped.zai).toEqual(auth.zai);
  });

  it('returns an empty object when nothing matches (caller asserts before boot, not here)', () => {
    expect(scopeAuthJson(auth, ['nonexistent'])).toEqual({});
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(auth);
    scopeAuthJson(auth, ['zai']);
    expect(JSON.stringify(auth)).toBe(before);
  });
});

describe('scopeModelsJson', () => {
  const models = {
    providers: {
      zai: { modelOverrides: { 'glm-5.3-flash': { thinking: 'low' } } },
      openrouter: { apiKey: 'FAKE-or', models: { 'poolside/laguna-s-2.1:free': {} } },
      'glm-coding': { apiKey: 'FAKE-glm', models: {} },
      'kimi-subscription': { models: { 'kimi-k3': {} } },
    },
  };

  it('drops provider entries that carry an apiKey for a non-allowed provider, keeps the rest', () => {
    const result = scopeModelsJson(models, ['zai']);
    expect(Object.keys(result.scoped.providers).sort()).toEqual(['kimi-subscription', 'zai']);
    expect(result.droppedCredentialProviders.sort()).toEqual(['glm-coding', 'openrouter']);
  });

  it('keeps apiKey-bearing entries for allowed providers', () => {
    const withZaiKey = { providers: { zai: { apiKey: 'FAKE-zai' }, openrouter: { apiKey: 'FAKE-or' } } };
    const result = scopeModelsJson(withZaiKey, ['zai']);
    expect(result.scoped.providers.zai).toEqual({ apiKey: 'FAKE-zai' });
    expect(result.droppedCredentialProviders).toEqual(['openrouter']);
  });

  it('handles a models.json without a providers map', () => {
    const result = scopeModelsJson({}, ['zai']);
    expect(result.scoped).toEqual({});
    expect(result.droppedCredentialProviders).toEqual([]);
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(models);
    scopeModelsJson(models, ['zai']);
    expect(JSON.stringify(models)).toBe(before);
  });
});

describe('assertAllowedProviderPresent', () => {
  it('passes when every allowed provider has an auth.json credential', () => {
    expect(() => assertAllowedProviderPresent({ zai: { type: 'api' } }, ['zai'])).not.toThrow();
  });

  it('also accepts an apiKey on the models.json provider entry as the credential', () => {
    expect(() => assertAllowedProviderPresent({}, ['zai'], { providers: { zai: { apiKey: 'FAKE' } } })).not.toThrow();
  });

  it('throws when an allowed provider has NO credential anywhere (the run depends on it)', () => {
    expect(() => assertAllowedProviderPresent({}, ['zai'], { providers: { zai: {} } })).toThrow(/zai/);
    expect(() => assertAllowedProviderPresent({ openrouter: {} }, ['zai'])).toThrow(/zai/);
  });
});
