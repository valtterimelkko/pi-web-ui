import { describe, it, expect } from 'vitest';
import { parseDevinModelsJson, deriveDevinThinkingLevels, toDevinCatalogEntries, devinPricingFromVariant, resolveDevinLevelSwap, resolveDevinCreateModel, devinAcpConfigView, resolveDevinAcpModelValue, resolveDevinAcpThoughtLevel, type DevinModelsFamily } from '../../../src/devin/devin-models.js';

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

  it('carries the family base and a level-less display name on every entry (lane D3)', () => {
    const entries = toDevinCatalogEntries(catalogue);
    const byId = Object.fromEntries(entries.map((m) => [m.id, m]));
    // Levelled variants group under the id minus the trailing level token,
    // with the display name without the level word.
    expect(byId['swe-2-flash-medium'].family).toBe('swe-2-flash');
    expect(byId['swe-2-flash-medium'].familyName).toBe('SWE-2 Flash');
    expect(byId['swe-2-high'].family).toBe('swe-2');
    expect(byId['swe-2-high'].familyName).toBe('SWE-2');
    expect(byId['claude-opus-5-5-xhigh'].family).toBe('claude-opus-5-5');
    expect(byId['claude-opus-5-5-xhigh'].familyName).toBe('Claude Opus 5.5');
    // Axis-less models are their own family, name unchanged.
    expect(byId['swe-2-high-lightning'].family).toBe('swe-2-high-lightning');
    expect(byId['swe-2-high-lightning'].familyName).toBe('SWE-2 High Lightning');
    expect(byId['kimi-k2-6'].family).toBe('kimi-k2-6');
    expect(byId['kimi-k2-6'].familyName).toBe('Kimi K2.6');
    expect(byId['claude-opus-5-5-low-fast'].family).toBe('claude-opus-5-5-low-fast');
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

  it('review fix 3: a sibling differs ONLY in the trailing level token — another family sharing a prefix is not absorbed', () => {
    // Verdict 3 evidence shape: swe-2-medium with swe-2-flash-high and
    // swe-2-flash-xhigh in the catalogue must NOT yield a [medium, high,
    // xhigh] ladder — swe-2-flash-* has a different base.
    const variants = [
      { model_uid: 'swe-2-medium' },
      { model_uid: 'swe-2-high' },
      { model_uid: 'swe-2-flash-high' },
      { model_uid: 'swe-2-flash-xhigh' },
    ];
    expect(deriveDevinThinkingLevels(variants, 'swe-2-medium')).toEqual(['medium', 'high']);
    expect(deriveDevinThinkingLevels(variants, 'swe-2-flash-xhigh')).toEqual(['high', 'xhigh']);
    // Prefix collision (codex-style): 'x-codex-high' differs from 'x-medium'
    // in more than the trailing token — never a level sibling.
    const collision = [{ model_uid: 'x-medium' }, { model_uid: 'x-codex-high' }];
    expect(deriveDevinThinkingLevels(collision, 'x-medium')).toEqual(['medium']);
    expect(deriveDevinThinkingLevels(collision, 'x-codex-high')).toEqual(['high']);
  });
});

describe('resolveDevinCreateModel (lane D3: create honours the level; family ids accepted)', () => {
  const entries = toDevinCatalogEntries(catalogue);
  const byId = Object.fromEntries(entries.map((m) => [m.id, m]));

  it('a variant plus a level resolves to the sibling id', () => {
    expect(resolveDevinCreateModel('swe-2-flash-medium', 'high', entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'swe-2-flash-high', levelApplied: 'high' });
    // Same level as the variant already carries is a no-op resolution.
    expect(resolveDevinCreateModel('swe-2-flash-medium', 'medium', entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'swe-2-flash-medium', levelApplied: 'medium' });
  });

  it('a level the family does not have fails, naming the available levels', () => {
    const res = resolveDevinCreateModel('swe-2-flash-medium', 'xhigh', entries, 'swe-2-flash-medium');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('medium, high, max');
    // Level tokens that are not part of the Devin ladder at all fail the same way.
    const off = resolveDevinCreateModel('swe-2-flash-medium', 'off', entries, 'swe-2-flash-medium');
    expect(off.ok).toBe(false);
  });

  it('an axis-less model creates unchanged and flags the no-axis note', () => {
    expect(resolveDevinCreateModel('kimi-k2-6', 'high', entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'kimi-k2-6', noLevelAxis: true });
    expect(resolveDevinCreateModel('kimi-k2-6', undefined, entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'kimi-k2-6' });
    expect(resolveDevinCreateModel('swe-2-high-lightning', 'max', entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'swe-2-high-lightning', noLevelAxis: true });
  });

  it('a variant with no level creates unchanged (today\'s behaviour)', () => {
    expect(resolveDevinCreateModel('swe-2-flash-max', undefined, entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'swe-2-flash-max' });
  });

  it('a family base id resolves to <base>-<level>: requested level, else medium, else lowest', () => {
    // Family with medium present: medium is the default.
    expect(resolveDevinCreateModel('swe-2-flash', undefined, entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'swe-2-flash-medium', levelApplied: 'medium' });
    expect(resolveDevinCreateModel('swe-2', undefined, entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'swe-2-medium', levelApplied: 'medium' });
    // Requested level wins.
    expect(resolveDevinCreateModel('swe-2-flash', 'max', entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'swe-2-flash-max', levelApplied: 'max' });
  });

  it('a family without medium falls back to its lowest level', () => {
    const partial = toDevinCatalogEntries([
      {
        family_label: 'Partial', family_uid: 'partial', slug: 'partial',
        variants: [
          { model_uid: 'partial-high', label: 'Partial High', cost_tier: 'Free' },
          { model_uid: 'partial-low', label: 'Partial Low', cost_tier: 'Free' },
        ],
      },
    ]);
    expect(resolveDevinCreateModel('partial', undefined, partial, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'partial-low', levelApplied: 'low' });
    expect(resolveDevinCreateModel('partial', 'high', partial, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'partial-high', levelApplied: 'high' });
    const res = resolveDevinCreateModel('partial', 'max', partial, 'swe-2-flash-medium');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('low, high');
  });

  it('no model given resolves the default, honouring a requested level', () => {
    expect(resolveDevinCreateModel(undefined, undefined, entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'swe-2-flash-medium' });
    expect(resolveDevinCreateModel(undefined, 'high', entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'swe-2-flash-high', levelApplied: 'high' });
  });

  it('unknown ids keep today\'s passthrough (refused later by the runtime, never substituted)', () => {
    expect(resolveDevinCreateModel('totally-unknown', undefined, entries, 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'totally-unknown' });
    // An empty catalogue behaves the same: nothing to resolve, pass through.
    expect(resolveDevinCreateModel('swe-2-flash-medium', 'high', [], 'swe-2-flash-medium'))
      .toEqual({ ok: true, modelId: 'swe-2-flash-medium' });
  });

  it('an exact catalogue id wins over family resolution', () => {
    // `swe-2` as an EXACT axis-less catalogue entry is its own model, never
    // expanded into a sibling ladder.
    const withLoneBase = toDevinCatalogEntries([
      {
        family_label: 'Lone', family_uid: 'lone', slug: 'lone',
        variants: [
          { model_uid: 'swe-2', label: 'SWE-2 (lone)', cost_tier: 'Free' },
          { model_uid: 'swe-2-medium', label: 'SWE-2 Medium', cost_tier: 'Free' },
        ],
      },
    ]);
    expect(resolveDevinCreateModel('swe-2', undefined, withLoneBase, 'swe-2-medium'))
      .toEqual({ ok: true, modelId: 'swe-2' });
  });
});

/**
 * Lane D5 — the ACP boundary. Live shape captured 2026-11-08 (probe against
 * `devin acp` v3000.12.28, throwaway HOME): `session/new` returns FOUR config
 * options — `mode`, `model` (FLAT `{value,name,_meta}` leaves, ONE value per
 * family), `thought_level` and `speed`. Variant ids are refused live:
 * `-32602 Invalid params: Invalid value 'swe-2-flash-high' for config option
 * 'model'`. Every `session/set_config_option` response echoes the session's
 * updated configOptions (the `thought_level` values follow the model).
 */
const acpEntries = toDevinCatalogEntries(catalogue);

const liveConfigOptions = [
  { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'accept-edits', options: [{ value: 'accept-edits', name: 'Code' }, { value: 'bypass', name: 'Bypass Permissions' }] },
  {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'swe-2-high', description: 'AI model to use',
    options: [
      { value: 'adaptive', name: 'Adaptive', _meta: { 'cognition.ai/supportsImages': true } },
      { value: 'swe-2-high', name: 'SWE-2', _meta: { 'cognition.ai/supportsImages': true } },
      { value: 'swe-2-flash-medium', name: 'SWE-2 Flash', _meta: { 'cognition.ai/supportsImages': false } },
      { value: 'swe-2-high-lightning', name: 'SWE-2 High Lightning', _meta: { 'cognition.ai/supportsImages': true } },
      { value: 'kimi-k2-6', name: 'Kimi K2.6', _meta: { 'cognition.ai/supportsImages': true } },
    ],
  },
  { id: 'thought_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }] },
  { id: 'speed', name: 'Speed', category: 'model_config', type: 'select', currentValue: 'standard', options: [{ value: 'standard', name: 'Standard' }, { value: 'fast', name: 'Fast' }] },
];

describe('devin ACP config view (lane D5)', () => {
  it('extracts the model and thought_level values from the live shape, ignoring mode/speed', () => {
    const view = devinAcpConfigView(liveConfigOptions);
    expect(view.modelValues).toEqual(['adaptive', 'swe-2-high', 'swe-2-flash-medium', 'swe-2-high-lightning', 'kimi-k2-6']);
    expect(view.thoughtLevelValues).toEqual(['medium', 'high', 'max']);
  });

  it('tolerates nested option groups (a group entry contributes its leaves)', () => {
    const grouped = [
      { id: 'model', options: [{ group: 'SWE', options: [{ value: 'swe-2-high', name: 'SWE-2' }] }, { value: 'adaptive', name: 'Adaptive' }] },
    ];
    expect(devinAcpConfigView(grouped).modelValues).toEqual(['swe-2-high', 'adaptive']);
  });

  it('garbage or absent configOptions yield empty views (passthrough stays possible)', () => {
    expect(devinAcpConfigView(undefined)).toEqual({ modelValues: [], thoughtLevelValues: [] });
    expect(devinAcpConfigView('nope')).toEqual({ modelValues: [], thoughtLevelValues: [] });
    expect(devinAcpConfigView([{ id: 'model' }, { id: 'thought_level', options: 'x' }])).toEqual({ modelValues: [], thoughtLevelValues: [] });
  });
});

describe('devin ACP model value resolution (lane D5)', () => {
  const view = devinAcpConfigView(liveConfigOptions);

  it('a variant id resolves to its family\'s ACP model value', () => {
    expect(resolveDevinAcpModelValue('swe-2-flash-high', view, acpEntries).model).toBe('swe-2-flash-medium');
    expect(resolveDevinAcpModelValue('swe-2-medium', view, acpEntries).model).toBe('swe-2-high');
    expect(resolveDevinAcpModelValue('swe-2-max', view, acpEntries).model).toBe('swe-2-high');
  });

  it('an option value resolves to itself (families, adaptive, lightning, fusion ids)', () => {
    expect(resolveDevinAcpModelValue('swe-2-flash-medium', view, acpEntries).model).toBe('swe-2-flash-medium');
    expect(resolveDevinAcpModelValue('swe-2-high', view, acpEntries).model).toBe('swe-2-high');
    expect(resolveDevinAcpModelValue('adaptive', view, acpEntries).model).toBe('adaptive');
    expect(resolveDevinAcpModelValue('swe-2-high-lightning', view, acpEntries).model).toBe('swe-2-high-lightning');
  });

  it('unknown ids and unresolvable families keep today\'s passthrough', () => {
    expect(resolveDevinAcpModelValue('totally-unknown', view, acpEntries).model).toBe('totally-unknown');
    const narrow = { modelValues: ['adaptive'], thoughtLevelValues: [] };
    // The catalogue knows the family, but the session's option does not list
    // it: pass the id through (the runtime refuses with its own clear error).
    expect(resolveDevinAcpModelValue('swe-2-flash-high', narrow, acpEntries).model).toBe('swe-2-flash-high');
  });
});

describe('devin ACP thought level resolution (lane D5)', () => {
  const view = devinAcpConfigView(liveConfigOptions);

  it('ids with no level token set no thought_level (adaptive, lightning, fusion, kimi)', () => {
    expect(resolveDevinAcpThoughtLevel('adaptive', view)).toEqual({ ok: true });
    expect(resolveDevinAcpThoughtLevel('swe-2-high-lightning', view)).toEqual({ ok: true });
    expect(resolveDevinAcpThoughtLevel('fusion-a-b', view)).toEqual({ ok: true });
    expect(resolveDevinAcpThoughtLevel('kimi-k2-6', view)).toEqual({ ok: true });
    expect(resolveDevinAcpThoughtLevel('totally-unknown', view)).toEqual({ ok: true });
  });

  it('a level token the session offers resolves to a thought_level set', () => {
    expect(resolveDevinAcpThoughtLevel('swe-2-flash-high', view)).toEqual({ ok: true, thoughtLevel: 'high' });
    expect(resolveDevinAcpThoughtLevel('swe-2-max', view)).toEqual({ ok: true, thoughtLevel: 'max' });
    expect(resolveDevinAcpThoughtLevel('swe-2-medium', view)).toEqual({ ok: true, thoughtLevel: 'medium' });
    expect(resolveDevinAcpThoughtLevel('swe-2-flash-medium', view)).toEqual({ ok: true, thoughtLevel: 'medium' });
  });

  it('a level the session cannot take fails naming the available levels (never substituted)', () => {
    const limited = { modelValues: ['x-medium'], thoughtLevelValues: ['low', 'medium'] };
    expect(resolveDevinAcpThoughtLevel('x-high', limited)).toEqual({ ok: false, reason: 'thinking level "high" not available for "x-high" (available: low, medium)' });
    const none = { modelValues: ['x-medium'], thoughtLevelValues: [] };
    expect(resolveDevinAcpThoughtLevel('x-high', none)).toEqual({ ok: false, reason: 'thinking level "high" not available for "x-high" (available: none)' });
  });
});
