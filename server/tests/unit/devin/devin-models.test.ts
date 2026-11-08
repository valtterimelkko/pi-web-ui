import { describe, it, expect } from 'vitest';
import { parseDevinModelsJson, deriveDevinThinkingLevels, toDevinCatalogEntries, devinPricingFromVariant, resolveDevinLevelSwap, type DevinModelsFamily } from '../../../src/devin/devin-models.js';

/**
 * Shapes mirrored from the live `devin models list --format json` output
 * (v3000.12.28, paid plan, 2026-11-08). Content trimmed/synthesised; ids,
 * cost tiers and level suffixes are faithful. Speed variants (-fast,
 * -lightning, -priority) and fusion-* combos exist in the real catalogue;
 * level derivation must treat them as separate models, not levels (plan D4).
 */

const catalogue: DevinModelsFamily[] = [
  {
    family_label: 'SWE-2', family_uid: 'swe-2', slug: 'swe-2', aliases: ['swe'],
    variants: [
      { model_uid: 'swe-2-high', label: 'SWE-2 High', max_context_tokens: 262000, cost_tier: 'Free' },
      { model_uid: 'swe-2-medium', label: 'SWE-2 Medium', max_context_tokens: 262000, cost_tier: 'Free' },
      { model_uid: 'swe-2-max', label: 'SWE-2 Max', max_context_tokens: 262000, cost_tier: 'Free' },
      { model_uid: 'swe-2-high-lightning', label: 'SWE-2 High Lightning', max_context_tokens: 262144, cost_tier: 'High cost' },
    ],
  },
  {
    family_label: 'SWE-2 Flash', family_uid: 'swe-2-flash', slug: 'swe-2-flash', aliases: [],
    variants: [
      { model_uid: 'swe-2-flash-medium', label: 'SWE-2 Flash Medium', max_context_tokens: 262000, cost_tier: 'Free', is_new: true },
      { model_uid: 'swe-2-flash-high', label: 'SWE-2 Flash High', max_context_tokens: 262000, cost_tier: 'Free', is_new: true },
      { model_uid: 'swe-2-flash-max', label: 'SWE-2 Flash Max', max_context_tokens: 262000, cost_tier: 'Free', is_new: true },
    ],
  },
  {
    family_label: 'Claude Opus 5.5', family_uid: 'claude-opus-5.5', slug: 'claude-opus-5.5', aliases: [],
    variants: [
      { model_uid: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 Medium', max_context_tokens: 1000000, cost_tier: 'High cost' },
      { model_uid: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 Low', max_context_tokens: 1000000, cost_tier: 'High cost' },
      { model_uid: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 High', max_context_tokens: 1000000, cost_tier: 'High cost' },
      { model_uid: 'claude-opus-5-5-xhigh', label: 'Claude Opus 5.5 XHigh', max_context_tokens: 1000000, cost_tier: 'High cost' },
      { model_uid: 'claude-opus-5-5-max', label: 'Claude Opus 5.5 Max', max_context_tokens: 1000000, cost_tier: 'High cost' },
      { model_uid: 'claude-opus-5-5-low-fast', label: 'Claude Opus 5.5 Low Fast', max_context_tokens: 1000000, cost_tier: 'High cost' },
      { model_uid: 'claude-opus-5-5-high-priority', label: 'Claude Opus 5.5 High Thinking Fast', max_context_tokens: 1000000, cost_tier: 'High cost' },
    ],
  },
  {
    family_label: 'Kimi K2.6', family_uid: 'kimi-k2.6', slug: 'kimi-k2.6', aliases: [],
    variants: [
      { model_uid: 'kimi-k2-6', label: 'Kimi K2.6', max_context_tokens: 262000, cost_tier: 'High cost' },
    ],
  },
];

const flat = catalogue.flatMap((f) => f.variants);

describe('devin models catalogue parsing', () => {
  it('flattens families into model entries with selector = native id', () => {
    const entries = toDevinCatalogEntries(catalogue);
    expect(entries.length).toBe(flat.length);
    const flash = entries.find((m) => m.id === 'swe-2-flash-medium');
    expect(flash).toBeDefined();
    expect(flash?.selector).toBe('swe-2-flash-medium');
    expect(flash?.name).toBe('SWE-2 Flash Medium');
    expect(flash?.provider).toBe('devin');
    // Owner ruling 01 (2026-11-08): no allow-list — the CLI's cost reporting
    // travels as an additive pricing field instead.
    expect(flash?.pricing).toEqual({ free: true, raw: 'Free', costTier: 'Free' });
    expect(flash?.contextWindow).toBe(262000);
  });

  it('pricing parses paid cost text and marks free only for the Free tier (ruling 01)', () => {
    expect(devinPricingFromVariant({ cost_tier: 'High cost', cost_summary: '$1 / 1M Input · $0.1 / 1M Cached input · $5 / 1M Output' }))
      .toEqual({ free: false, raw: '$1 / 1M Input · $0.1 / 1M Cached input · $5 / 1M Output', costTier: 'High cost' });
    expect(devinPricingFromVariant({ cost_tier: 'Free' })).toEqual({ free: true, raw: 'Free', costTier: 'Free' });
    expect(devinPricingFromVariant({})).toEqual({ free: false, raw: '', costTier: undefined });
  });

  it('derives thinking levels from sibling ids differing only in the trailing level token', () => {
    const entries = toDevinCatalogEntries(catalogue);
    const byId = Object.fromEntries(entries.map((m) => [m.id, m]));
    // swe-2 ladder is high/medium/max
    expect(byId['swe-2-medium'].thinkingLevels).toEqual(['medium', 'high', 'max']);
    // swe-2-flash ladder is medium/high/max
    expect(byId['swe-2-flash-medium'].thinkingLevels).toEqual(['medium', 'high', 'max']);
    // opus 5.5 full ladder
    expect(byId['claude-opus-5-5-low'].thinkingLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('speed variants are separate models with their own (no) levels — plan D4', () => {
    const entries = toDevinCatalogEntries(catalogue);
    const byId = Object.fromEntries(entries.map((m) => [m.id, m]));
    // -fast suffix is not a level token: `claude-opus-5-5-low-fast` is axis-less
    // and NOT a sibling of claude-opus-5-5-low.
    expect(byId['claude-opus-5-5-low-fast'].thinkingLevels).toEqual([]);
    expect(byId['claude-opus-5-5-low'].thinkingLevels).not.toContain('fast');
    // lightning (on swe-2) and priority (opus) likewise.
    expect(byId['swe-2-high-lightning'].thinkingLevels).toEqual([]);
    expect(byId['claude-opus-5-5-high-priority'].thinkingLevels).toEqual([]);
    // The base swe-2 ladder must not absorb the lightning sibling.
    expect(byId['swe-2-high'].thinkingLevels).toEqual(['medium', 'high', 'max']);
  });

  it('a lone model with a level-looking suffix has no level axis', () => {
    const entries = toDevinCatalogEntries(catalogue);
    const kimi = entries.find((m) => m.id === 'kimi-k2-6');
    expect(kimi?.thinkingLevels).toEqual([]);
  });

  it('derives levels directly from a flat variant list', () => {
    expect(deriveDevinThinkingLevels(flat, 'swe-2-flash-max')).toEqual(['medium', 'high', 'max']);
    expect(deriveDevinThinkingLevels(flat, 'claude-opus-5-5-xhigh')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(deriveDevinThinkingLevels(flat, 'kimi-k2-6')).toEqual([]);
  });

  it('parses real JSON output text', () => {
    const json = JSON.stringify({ families: catalogue });
    const parsed = parseDevinModelsJson(json);
    expect(parsed.families.length).toBe(catalogue.length);
  });

  it('tolerates malformed JSON output (empty families, no throw)', () => {
    expect(parseDevinModelsJson('garbage').families).toEqual([]);
    expect(parseDevinModelsJson('{"nope":1}').families).toEqual([]);
  });

  it('resolves a level swap: sibling id for a requested level, null when unsupported', () => {
    const entries = toDevinCatalogEntries(catalogue);
    const byId = Object.fromEntries(entries.map((m) => [m.id, m]));
    expect(resolveDevinLevelSwap(byId['swe-2-flash-medium'], 'high', entries)).toEqual({ ok: true, slug: 'swe-2-flash-high' });
    expect(resolveDevinLevelSwap(byId['swe-2-flash-medium'], 'xhigh', entries).ok).toBe(false);
    expect(resolveDevinLevelSwap(byId['kimi-k2-6'], 'high', entries).ok).toBe(false);
    expect(resolveDevinLevelSwap(byId['swe-2-flash-medium'], 'medium', entries)).toEqual({ ok: true, slug: 'swe-2-flash-medium' });
  });
});
