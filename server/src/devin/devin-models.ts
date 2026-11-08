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
    if (!variant.model_uid.startsWith(`${base}-`)) continue;
    const siblingLevel = levelOf(variant.model_uid);
    if (siblingLevel !== null) levels.add(siblingLevel);
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
