import { describe, expect, it } from 'vitest';
import {
  assertPiModelAllowed,
  assertResolvedPiModelAllowed,
  blockedPiProvider,
  parseBlockedPiProviders,
  PiProviderNotAllowedError,
  providerFromPiModelReference,
} from '../../../src/internal-api/pi-provider-policy.js';

describe('Internal API Pi provider policy', () => {
  it('defaults to the two metered Pi providers and supports an explicit empty override', () => {
    expect(parseBlockedPiProviders(undefined)).toEqual(['openai', 'openrouter']);
    expect(parseBlockedPiProviders('')).toEqual([]);
    expect(parseBlockedPiProviders(' OpenAI,openrouter,openai ')).toEqual(['openai', 'openrouter']);
  });

  it('parses only the exact provider segment before the first slash', () => {
    expect(providerFromPiModelReference('openrouter/openai/gpt-5.5')).toBe('openrouter');
    expect(providerFromPiModelReference('openai-codex/gpt-5.5')).toBe('openai-codex');
    expect(providerFromPiModelReference('gpt-5.5')).toBeUndefined();
  });

  it('blocks exact provider ids without treating openai-codex as openai', () => {
    const blocked = ['openai', 'openrouter'];
    expect(blockedPiProvider('openai/gpt-5.5', blocked)).toBe('openai');
    expect(blockedPiProvider('openrouter/openai/gpt-5.5', blocked)).toBe('openrouter');
    expect(blockedPiProvider('openai-codex/gpt-5.5', blocked)).toBeUndefined();
  });

  it('fails closed when the effective provider cannot be resolved at execution time', () => {
    expect(() => assertResolvedPiModelAllowed(undefined, ['openai', 'openrouter']))
      .toThrowError(PiProviderNotAllowedError);
    try {
      assertResolvedPiModelAllowed(undefined, ['openai', 'openrouter']);
    } catch (error) {
      expect(error).toMatchObject({ code: 'PROVIDER_NOT_ALLOWED', provider: undefined });
    }
  });

  it('throws the contracted policy error for blocked execution', () => {
    expect(() => assertPiModelAllowed('openai/gpt-5.5', ['openai'])).toThrowError(PiProviderNotAllowedError);
    try {
      assertPiModelAllowed('openai/gpt-5.5', ['openai']);
    } catch (error) {
      expect(error).toMatchObject({ code: 'PROVIDER_NOT_ALLOWED', provider: 'openai' });
    }
  });
});
