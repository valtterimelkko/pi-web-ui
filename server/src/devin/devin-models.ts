/**
 * Devin model catalogue — parsing of `devin models list --format json`,
 * thinking-level derivation (plan D4), and level-swap resolution.
 *
 * Live-validated against the CLI v3000.12.28 (2026-11-08):
 * - JSON output is `{ families: [{ family_label, family_uid, slug, aliases,
 *   variants: [{ model_uid, label, max_context_tokens?, cost_tier?,
 *   cost_summary?, is_new?, is_beta? }] }] }`.
 * - Reasoning level is part of the model id: siblings differ only in the
 *   trailing level token among `low|medium|high|xhigh|max`. `none` is NOT a
 *   level token (it names a no-thinking variant, which stays a separate
 *   model). Speed variants (`-fast`, `-lightning`, `-priority`) and
 *   `fusion-*` combos are separate models, never levels.
 * - The selector is the native `model_uid`; it is set per session through
 *   `session/set_config_option` (the `--model` flag loses to the config
 *   file — plan §2), never by spawn flag.
 *
 * Owner ruling 01 (2026-11-08): NO cost allow-list. Every catalogue model is
 * usable everywhere; the CLI's cost reporting travels additively as the
 * `pricing` field (`free` + raw string) so callers and UIs can show which
 * models are free. Live validation uses `swe-2-flash-medium` only.
 */

export interface DevinModelVariant {
  model_uid: string;
  label: string;
  max_context_tokens?: number;
  cost_tier?: string;
  cost_summary?: string;
  is_new?: boolean;
  is_beta?: boolean;
}

export interface DevinModelsFamily {
  family_label: string;
  family_uid: string;
  slug: string;
  aliases?: string[];
  variants: DevinModelVariant[];
}

export interface DevinModelsOutput {
  families: DevinModelsFamily[];
}

/** Additive per-entry pricing projection (ruling 01): `free` is true only
 *  for the CLI's `Free` cost tier; `raw` carries the CLI text verbatim. */
export interface DevinModelPricing {
  free: boolean;
  raw: string;
  costTier?: string;
}

export function devinPricingFromVariant(variant: Partial<DevinModelVariant>): DevinModelPricing {
  const costTier = variant.cost_tier;
  const free = costTier === 'Free';
  const raw = free ? 'Free' : (variant.cost_summary ?? costTier ?? '');
  return {
    free,
    raw,
    ...(costTier !== undefined ? { costTier } : {}),
  };
}

export interface DevinModelEntry {
  /** Native model id — the canonical selector for session/set_config_option. */
  id: string;
  selector: string;
  name: string;
  provider: 'devin';
  /** Levels with a sibling id in the catalogue, canonical low→max order. */
  thinkingLevels: string[];
  /** Additive cost projection (ruling 01) — informational, never a gate. */
  pricing: DevinModelPricing;
  contextWindow?: number;
  isNew?: boolean;
  isBeta?: boolean;
  /** Lane D3: the family base id (the id minus its trailing level token),
   *  or the id itself when the model has no level axis. */
  family: string;
  /** Lane D3: display name without the level word (e.g. "SWE-2 Flash");
   *  axis-less models keep their own label. */
  familyName: string;
}

/** The level tokens a sibling id may end with (plan D4, frozen). */
const LEVEL_TOKENS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Level = (typeof LEVEL_TOKENS)[number];

const LEVEL_ORDER: Record<Level, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

function isLevelToken(value: string): value is Level {
  return (LEVEL_TOKENS as readonly string[]).includes(value);
}

function levelOf(modelUid: string): Level | null {
  const idx = modelUid.lastIndexOf('-');
  if (idx < 0) return null;
  const token = modelUid.slice(idx + 1);
  return isLevelToken(token) ? token : null;
}

/** Lane D3: the family base id — the id minus its trailing level token when
 *  it ends in one, else the id itself (axis-less models are their own family). */
export function devinFamilyBase(modelUid: string): string {
  const level = levelOf(modelUid);
  return level === null ? modelUid : modelUid.slice(0, modelUid.length - level.length - 1);
}

/** Lane D3: the display name without the level word. The catalogue labels
 *  end with the capitalised level token for levelled variants ("SWE-2 Flash
 *  Medium"); strip that word only when it matches the model's own level
 *  (case-insensitive), keeping the label unchanged otherwise. */
export function devinFamilyName(label: string, modelUid: string): string {
  const level = levelOf(modelUid);
  if (level === null) return label;
  const words = label.split(/\s+/);
  const last = words[words.length - 1] ?? '';
  if (words.length > 1 && last.toLowerCase() === level.toLowerCase()) {
    return words.slice(0, -1).join(' ');
  }
  return label;
}

/**
 * Sibling-group extraction: a model's level axis is the set of catalogue ids
 * that differ ONLY in the trailing level token. `swe-2-flash-medium` →
 * {medium, high, max}; `claude-opus-5-5-low-fast` has no axis (`fast` is a
 * speed suffix, not a level) and is never absorbed into another model's
 * ladder because it differs in more than the trailing token.
 */
export function deriveDevinThinkingLevels(
  variants: Array<Pick<DevinModelVariant, 'model_uid'>>,
  modelUid: string,
): string[] {
  const level = levelOf(modelUid);
  if (level === null) return [];
  const base = modelUid.slice(0, modelUid.length - level.length - 1);
  const levels = new Set<Level>([level]);
  for (const variant of variants) {
    if (variant.model_uid === modelUid) continue;
    const siblingLevel = levelOf(variant.model_uid);
    if (siblingLevel === null) continue;
    // Review fix 3: the sibling test is EXACT equality — variant id ===
    // base + '-' + level. A startsWith check absorbs other families that
    // merely share the prefix (swe-2-flash-* into swe-2, 'x-codex-high' into
    // 'x-medium'), producing levels whose swap target does not exist.
    if (variant.model_uid !== `${base}-${siblingLevel}`) continue;
    levels.add(siblingLevel);
  }
  return [...levels].sort((a, b) => LEVEL_ORDER[a] - LEVEL_ORDER[b]);
}

export function toDevinCatalogEntries(families: DevinModelsFamily[]): DevinModelEntry[] {
  const variants = families.flatMap((f) => f.variants);
  return variants.map((v) => ({
    id: v.model_uid,
    selector: v.model_uid,
    name: v.label,
    provider: 'devin' as const,
    thinkingLevels: deriveDevinThinkingLevels(variants, v.model_uid),
    pricing: devinPricingFromVariant(v),
    ...(v.max_context_tokens !== undefined ? { contextWindow: v.max_context_tokens } : {}),
    ...(v.is_new ? { isNew: true } : {}),
    ...(v.is_beta ? { isBeta: true } : {}),
    family: devinFamilyBase(v.model_uid),
    familyName: devinFamilyName(v.label, v.model_uid),
  }));
}

/** Parse `devin models list --format json` stdout. Malformed output yields an
 *  empty families list instead of throwing (the caller decides fail-open). */
export function parseDevinModelsJson(stdout: string): DevinModelsOutput {
  try {
    const parsed = JSON.parse(stdout) as { families?: unknown };
    if (!parsed || !Array.isArray(parsed.families)) return { families: [] };
    return { families: parsed.families as DevinModelsFamily[] };
  } catch {
    return { families: [] };
  }
}

export type DevinLevelSwapResolution =
  | { ok: true; slug: string }
  | { ok: false; reason: string };

/** Thinking-level selection = sibling id swap (plan D4). Fails loudly for an
 *  unsupported level or an axis-less model so callers can 409/400 cleanly. */
export function resolveDevinLevelSwap(
  current: DevinModelEntry | undefined,
  level: string,
  _catalogue: DevinModelEntry[],
): DevinLevelSwapResolution {
  if (!current) return { ok: false, reason: `current model unknown` };
  if (current.thinkingLevels.length === 0) {
    return { ok: false, reason: `model "${current.id}" has no thinking-level axis` };
  }
  if (!current.thinkingLevels.includes(level)) {
    return { ok: false, reason: `thinking level "${level}" not available for "${current.id}" (available: ${current.thinkingLevels.join(', ')})` };
  }
  const currentLevel = levelOf(current.id);
  if (currentLevel === null) return { ok: false, reason: `model "${current.id}" has no thinking-level axis` };
  const base = current.id.slice(0, current.id.length - currentLevel.length - 1);
  return { ok: true, slug: `${base}-${level}` };
}

export type DevinCreateModelResolution =
  | { ok: true; modelId: string; levelApplied?: string; noLevelAxis?: boolean }
  | { ok: false; reason: string };

/** Lane D3: create-time model+level resolution (design frozen, 2026-11-08).
 *
 *  - A variant id plus a `thinkingLevel` resolves to its sibling id via
 *    {@link resolveDevinLevelSwap}; a level the family does not have fails
 *    with a reason naming the available levels (callers answer 400, never
 *    substitute).
 *  - A family base id (the catalogue id minus its trailing level token) is
 *    accepted: it resolves to `<base>-<level>` with the requested level, else
 *    `medium` when the family has it, else the family's lowest level.
 *  - An axis-less model (`*-lightning`, a fusion id, a lone catalogue id)
 *    creates unchanged; when a level was requested the result carries
 *    `noLevelAxis` so callers can attach a `thinkingLevelNote`.
 *  - Unknown ids keep today's passthrough (the runtime refuses them at
 *    first use; never a substitution here).
 *
 *  An exact catalogue id always wins over family resolution: a model that
 *  exists under the base name is that model, never a ladder.
 *  An empty/unavailable catalogue behaves like unknown ids: passthrough. */
export function resolveDevinCreateModel(
  requested: string | undefined,
  thinkingLevel: string | undefined,
  catalogue: DevinModelEntry[],
  defaultModel: string,
): DevinCreateModelResolution {
  const modelId = requested ?? defaultModel;
  const exact = catalogue.find((m) => m.id === modelId);
  if (exact) {
    if (!thinkingLevel) return { ok: true, modelId: exact.id };
    if (exact.thinkingLevels.length === 0) {
      return { ok: true, modelId: exact.id, noLevelAxis: true };
    }
    const swap = resolveDevinLevelSwap(exact, thinkingLevel, catalogue);
    return swap.ok
      ? { ok: true, modelId: swap.slug, levelApplied: thinkingLevel }
      : swap;
  }
  // Family resolution: any levelled catalogue entries sharing the base id.
  const familyVariants = catalogue.filter(
    (m) => m.thinkingLevels.length > 0 && devinFamilyBase(m.id) === modelId,
  );
  if (familyVariants.length === 0) {
    return { ok: true, modelId }; // unknown id: today's passthrough
  }
  const levels = [...new Set(familyVariants.flatMap((m) => m.thinkingLevels))]
    .sort((a, b) => {
      const ia = LEVEL_ORDER[a as Level];
      const ib = LEVEL_ORDER[b as Level];
      return (ia ?? 0) - (ib ?? 0);
    });
  if (!thinkingLevel) {
    const target = levels.includes('medium') ? 'medium' : levels[0];
    return { ok: true, modelId: `${modelId}-${target}`, levelApplied: target };
  }
  if (!levels.includes(thinkingLevel)) {
    return {
      ok: false,
      reason: `thinking level "${thinkingLevel}" not available for "${modelId}" (available: ${levels.join(', ')})`,
    };
  }
  return { ok: true, modelId: `${modelId}-${thinkingLevel}`, levelApplied: thinkingLevel };
}

// ── Lane D5: the ACP boundary (contract 1.69.1) ─────────────────────────────
//
// Devin's ACP `model` config option takes ONE value per family (flat
// `{value, name, _meta}` leaves; live-probed `devin acp` v3000.12.28,
// 2026-11-08: `swe-2-high` = "SWE-2", `swe-2-flash-medium` = "SWE-2 Flash",
// plus `adaptive`, fusion ids and legacy singles). A variant id such as
// `swe-2-flash-high` is REFUSED on the wire (`-32602 Invalid params: Invalid
// value 'swe-2-flash-high' for config option 'model'`), so the public
// vocabulary (variant ids) translates at the boundary: the family's option
// value plus a `thought_level` set. `session/new` returns FOUR options —
// `mode`, `model`, `thought_level` and `speed`; every
// `session/set_config_option` response echoes the session's updated
// configOptions (the thought_level values follow the session's model).

/** The values a session's `model` and `thought_level` options accept. */
export interface DevinAcpConfigView {
  modelValues: string[];
  thoughtLevelValues: string[];
}

function flattenAcpOptionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const out: string[] = [];
  for (const item of options) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { value?: unknown; options?: unknown };
    if (typeof record.value === 'string') {
      out.push(record.value);
      continue;
    }
    // A group entry contributes its leaves (defensive: the live shape is flat).
    if (Array.isArray(record.options)) out.push(...flattenAcpOptionValues(record.options));
  }
  return out;
}

/** Extract the view from a configOptions payload (a `session/new`/`session/load`
 *  result or a `session/set_config_option` echo). Garbage yields empty views;
 *  callers then pass the requested id through unchanged (today's behaviour). */
export function devinAcpConfigView(configOptions: unknown): DevinAcpConfigView {
  const view: DevinAcpConfigView = { modelValues: [], thoughtLevelValues: [] };
  if (!Array.isArray(configOptions)) return view;
  for (const entry of configOptions) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, options } = entry as { id?: unknown; options?: unknown };
    if (id !== 'model' && id !== 'thought_level') continue;
    const values = flattenAcpOptionValues(options);
    if (id === 'model') view.modelValues = values;
    else view.thoughtLevelValues = values;
  }
  return view;
}

/** Pick the ACP `model` option value for a public model id: the id itself
 *  when the session offers it; otherwise the option value belonging to the
 *  id's catalogue family. Unknown ids and ids whose family the session does
 *  not list pass through unchanged (the runtime refuses them with its own
 *  clear error — never a substitution here). */
export function resolveDevinAcpModelValue(
  requested: string,
  view: DevinAcpConfigView,
  catalogue: DevinModelEntry[],
): { model: string } {
  if (view.modelValues.includes(requested)) return { model: requested };
  const entry = catalogue.find((m) => m.id === requested);
  if (entry) {
    const familyValue = view.modelValues.find(
      (value) => catalogue.find((m) => m.id === value)?.family === entry.family,
    );
    if (familyValue) return { model: familyValue };
  }
  return { model: requested };
}

/** Resolve the `thought_level` a public model id implies, against the view
 *  CURRENT at write time (post-model-set: the echo updates it). Ids with no
 *  level token (lightning, fusion, adaptive, legacy singles) set none; a
 *  level the session cannot take fails naming the available levels — never
 *  substituted silently. */
export function resolveDevinAcpThoughtLevel(
  requested: string,
  view: DevinAcpConfigView,
): { ok: true; thoughtLevel?: string } | { ok: false; reason: string } {
  const level = levelOf(requested);
  if (level === null) return { ok: true };
  if (!view.thoughtLevelValues.includes(level)) {
    const available = view.thoughtLevelValues.length > 0 ? view.thoughtLevelValues.join(', ') : 'none';
    return { ok: false, reason: `thinking level "${level}" not available for "${requested}" (available: ${available})` };
  }
  return { ok: true, thoughtLevel: level };
}
