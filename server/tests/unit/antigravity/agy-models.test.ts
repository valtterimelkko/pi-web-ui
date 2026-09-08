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
 * Fixture: verbatim `agy models` output on agy 1.1.27 (2026-09-08).
 * Note gemini-3.1-pro ships ONLY high and low — thinkingLevels must derive
 * from actual siblings, never assume a full low/medium/high ladder.
 */
export const AGY_MODELS_FIXTURE = [
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
  'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
  'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
  'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
  'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

const models = parseAgyModelsOutput(AGY_MODELS_FIXTURE);
const catalog = toCatalogEntries(models);

describe('parseAgyModelsOutput', () => {
  it('parses <slug>\\t<Label> lines from the real 1.1.27 catalogue', () => {
    const parsed = parseAgyModelsOutput(AGY_MODELS_FIXTURE);
    expect(parsed).toHaveLength(14);
    expect(parsed[0]).toEqual({ slug: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' });
    expect(parsed[13]).toEqual({ slug: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' });
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
  it('full ladder for gemini-3.6-flash tiers, canonical low→high order', () => {
    expect(deriveThinkingLevels(models, 'gemini-3.6-flash-low')).toEqual(['low', 'medium', 'high']);
  });

  it('partial ladder for gemini-3.1-pro (no medium sibling exists)', () => {
    expect(deriveThinkingLevels(models, 'gemini-3.1-pro-high')).toEqual(['low', 'high']);
  });

  it('empty for claude models (no effort axis — loud-fail live-validated)', () => {
    expect(deriveThinkingLevels(models, 'claude-sonnet-4-6')).toEqual([]);
    expect(deriveThinkingLevels(models, 'claude-opus-4-6-thinking')).toEqual([]);
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
    const low = catalog.find((m) => m.id === 'gemini-3.6-flash-low');
    expect(low).toMatchObject({
      id: 'gemini-3.6-flash-low',
      selector: 'gemini-3.6-flash-low',
      name: 'Gemini 3.6 Flash (Low)',
      provider: 'antigravity',
      thinkingLevels: ['low', 'medium', 'high'],
    });
    const claude = catalog.find((m) => m.id === 'claude-sonnet-4-6');
    expect(claude?.thinkingLevels).toEqual([]);
  });
});

describe('canonicalizeAgyModelId (the --model boundary)', () => {
  it('cuts the 2026-08-27 tab-string defect shape at the tab and maps label→slug', () => {
    expect(canonicalizeAgyModelId('gemini-3.6-flash-low\tGemini 3.6 Flash (Low)', models)).toBe(
      'gemini-3.6-flash-low',
    );
  });

  it('maps a bare label to its slug (labels accepted by agy, slug is canonical)', () => {
    expect(canonicalizeAgyModelId('Gemini 3.6 Flash (Low)', models)).toBe('gemini-3.6-flash-low');
  });

  it('passes a known slug through untouched', () => {
    expect(canonicalizeAgyModelId('gemini-3.8-flash-high', models)).toBe('gemini-3.8-flash-high');
  });

  it('strips a legacy provider/ prefix then maps', () => {
    expect(canonicalizeAgyModelId('antigravity/Gemini 3.6 Flash (Low)', models)).toBe(
      'gemini-3.6-flash-low',
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
    expect(validateModelThinkingPair('gemini-3.6-flash-low', 'low', models)).toEqual({ ok: true });
  });

  it('accepts gemini slug with no explicit level', () => {
    expect(validateModelThinkingPair('gemini-3.6-flash-high', undefined, models)).toEqual({ ok: true });
  });

  it('rejects a conflicting gemini level (agy: "conflicts with --effort")', () => {
    const result = validateModelThinkingPair('gemini-3.6-flash-low', 'high', models);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/conflict/i);
  });

  it('rejects any level for claude models (agy: "--effort is not supported")', () => {
    const result = validateModelThinkingPair('claude-sonnet-4-6', 'low', models);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not supported|unsupported/i);
  });

  it('rejects a level for a sibling-less model (gpt-oss-120b-medium)', () => {
    expect(validateModelThinkingPair('gpt-oss-120b-medium', 'medium', models).ok).toBe(false);
  });

  it('accepts any model with no level requested', () => {
    expect(validateModelThinkingPair('claude-sonnet-4-6', undefined, models)).toEqual({ ok: true });
  });
});

describe('resolveModelSlug (thinking-level = sibling slug swap)', () => {
  it('swaps to the sibling slug for a different level', () => {
    expect(resolveModelSlug('gemini-3.6-flash-low', 'high', models)).toEqual({
      ok: true,
      slug: 'gemini-3.6-flash-high',
    });
  });

  it('returns the same slug when the requested level is already baked in', () => {
    expect(resolveModelSlug('gemini-3.6-flash-low', 'low', models)).toEqual({
      ok: true,
      slug: 'gemini-3.6-flash-low',
    });
  });

  it('errors when the level has no sibling (gemini-3.1-pro-high + medium)', () => {
    const result = resolveModelSlug('gemini-3.1-pro-high', 'medium', models);
    expect(result.ok).toBe(false);
  });

  it('errors for models without a level axis', () => {
    expect(resolveModelSlug('claude-sonnet-4-6', 'low', models).ok).toBe(false);
  });

  it('passes through when no level requested', () => {
    expect(resolveModelSlug('gemini-3.6-flash-low', undefined, models)).toEqual({
      ok: true,
      slug: 'gemini-3.6-flash-low',
    });
  });
});
