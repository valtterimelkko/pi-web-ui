import { describe, it, expect } from 'vitest';
import {
  parseAgyModelsOutput,
  deriveThinkingLevels,
  toCatalogEntries,
  canonicalizeAgyModelId,
  validateModelThinkingPair,
  resolveModelSlug,
} from '../../../src/antigravity/agy-models.js';

/**
 * Fixture: verbatim `agy models` output on agy 1.5.3 (2026-11-09).
 * The Claude/GPT group moved to Sonnet/Opus 5.5 sibling selectors — claude
 * models now carry a real level axis exactly like the gemini families;
 * gpt-oss-120b-medium stays axis-less. thinkingLevels must derive from
 * actual siblings, never assume a full low/medium/high ladder.
 */
export const AGY_MODELS_FIXTURE = [
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

const models = parseAgyModelsOutput(AGY_MODELS_FIXTURE);
const catalog = toCatalogEntries(models);

describe('parseAgyModelsOutput', () => {
  it('parses <slug>\\t<Label> lines from the real 1.5.3 catalogue', () => {
    const parsed = parseAgyModelsOutput(AGY_MODELS_FIXTURE);
    expect(parsed).toHaveLength(13);
    expect(parsed[0]).toEqual({ slug: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' });
    expect(parsed[12]).toEqual({ slug: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' });
  });

  it('tolerates blank lines and label-only lines (older agy)', () => {
    const parsed = parseAgyModelsOutput('\nGemini 3.5 Flash (Medium)\n\nsome-slug\tSome Slug\n');
    expect(parsed).toEqual([
      { slug: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' },
      { slug: 'some-slug', label: 'Some Slug' },
    ]);
  });
});

describe('deriveThinkingLevels (from actual siblings)', () => {
  it('full ladder for sibling-bearing families, canonical low→high order', () => {
    expect(deriveThinkingLevels(models, 'gemini-3.8-flash-low')).toEqual(['low', 'medium', 'high']);
    expect(deriveThinkingLevels(models, 'claude-sonnet-5-5-medium')).toEqual(['low', 'medium', 'high']);
    expect(deriveThinkingLevels(models, 'claude-opus-5-5-high')).toEqual(['low', 'medium', 'high']);
  });

  it('partial ladder when a middle sibling is absent (synthetic family)', () => {
    const partial = parseAgyModelsOutput('fam-x-high\tFam X (High)\nfam-x-low\tFam X (Low)');
    expect(deriveThinkingLevels(partial, 'fam-x-high')).toEqual(['low', 'high']);
  });

  it('empty for gpt-oss-120b-medium (the -medium suffix has no siblings)', () => {
    expect(deriveThinkingLevels(models, 'gpt-oss-120b-medium')).toEqual([]);
  });

  it('empty for an unknown slug', () => {
    expect(deriveThinkingLevels(models, 'not-a-model')).toEqual([]);
  });
});

describe('toCatalogEntries', () => {
  it('entries carry slug selector, label name, and derived thinkingLevels', () => {
    const low = catalog.find((m) => m.id === 'gemini-3.8-flash-low');
    expect(low).toMatchObject({
      id: 'gemini-3.8-flash-low',
      selector: 'gemini-3.8-flash-low',
      name: 'Gemini 3.8 Flash (Low)',
      provider: 'antigravity',
      thinkingLevels: ['low', 'medium', 'high'],
    });
    const claude = catalog.find((m) => m.id === 'claude-sonnet-5-5-medium');
    expect(claude?.thinkingLevels).toEqual(['low', 'medium', 'high']);
  });
});

describe('canonicalizeAgyModelId (the --model boundary)', () => {
  it('cuts the 2026-08-27 tab-string defect shape at the tab and maps label→slug', () => {
    expect(canonicalizeAgyModelId('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)', models)).toBe(
      'gemini-3.8-flash-low',
    );
  });

  it('maps a bare label to its slug (labels accepted by agy, slug is canonical)', () => {
    expect(canonicalizeAgyModelId('Gemini 3.8 Flash (Low)', models)).toBe('gemini-3.8-flash-low');
  });

  it('passes a known slug through untouched', () => {
    expect(canonicalizeAgyModelId('gemini-3.8-flash-high', models)).toBe('gemini-3.8-flash-high');
  });

  it('strips a legacy provider/ prefix then maps', () => {
    expect(canonicalizeAgyModelId('antigravity/Gemini 3.8 Flash (Low)', models)).toBe(
      'gemini-3.8-flash-low',
    );
  });

  it('passes unknown ids through unchanged (agy loud-fails them — validated)', () => {
    expect(canonicalizeAgyModelId('bogus-model-x', models)).toBe('bogus-model-x');
  });

  it('works without a catalog (tab-cut only)', () => {
    expect(canonicalizeAgyModelId('some-slug\tSome Label')).toBe('Some Label');
    expect(canonicalizeAgyModelId('some-slug')).toBe('some-slug');
  });
});

describe('validateModelThinkingPair', () => {
  it('accepts a matching gemini slug+level', () => {
    expect(validateModelThinkingPair('gemini-3.8-flash-low', 'low', models)).toEqual({ ok: true });
  });

  it('accepts gemini slug with no explicit level', () => {
    expect(validateModelThinkingPair('gemini-3.8-flash-high', undefined, models)).toEqual({ ok: true });
  });

  it('rejects a conflicting gemini level (agy: "conflicts with --effort")', () => {
    const result = validateModelThinkingPair('gemini-3.8-flash-low', 'high', models);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/conflict/i);
  });

  it('accepts a matching claude sibling level (5.5 siblings carry the axis)', () => {
    expect(validateModelThinkingPair('claude-sonnet-5-5-low', 'low', models)).toEqual({ ok: true });
  });

  it('rejects a conflicting claude sibling level', () => {
    const result = validateModelThinkingPair('claude-sonnet-5-5-low', 'high', models);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/conflict/i);
  });

  it('rejects a level for a sibling-less model (gpt-oss-120b-medium)', () => {
    expect(validateModelThinkingPair('gpt-oss-120b-medium', 'medium', models).ok).toBe(false);
  });

  it('accepts any model with no level requested', () => {
    expect(validateModelThinkingPair('claude-sonnet-5-5-medium', undefined, models)).toEqual({ ok: true });
  });
});

describe('resolveModelSlug (thinking-level = sibling slug swap)', () => {
  it('swaps to the sibling slug for a different level', () => {
    expect(resolveModelSlug('gemini-3.8-flash-low', 'high', models)).toEqual({
      ok: true,
      slug: 'gemini-3.8-flash-high',
    });
  });

  it('swaps claude siblings the same way (5.5 level axis)', () => {
    expect(resolveModelSlug('claude-sonnet-5-5-medium', 'high', models)).toEqual({
      ok: true,
      slug: 'claude-sonnet-5-5-high',
    });
  });

  it('returns the same slug when the requested level is already baked in', () => {
    expect(resolveModelSlug('gemini-3.8-flash-low', 'low', models)).toEqual({
      ok: true,
      slug: 'gemini-3.8-flash-low',
    });
  });

  it('errors when the level has no sibling (synthetic partial family)', () => {
    const partial = parseAgyModelsOutput('fam-x-high\tFam X (High)\nfam-x-low\tFam X (Low)');
    const result = resolveModelSlug('fam-x-high', 'medium', partial);
    expect(result.ok).toBe(false);
  });

  it('errors for models without a level axis', () => {
    expect(resolveModelSlug('gpt-oss-120b-medium', 'low', models).ok).toBe(false);
  });

  it('passes through when no level requested', () => {
    expect(resolveModelSlug('gemini-3.8-flash-low', undefined, models)).toEqual({
      ok: true,
      slug: 'gemini-3.8-flash-low',
    });
  });
});
