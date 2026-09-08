/**
 * agy model catalogue — parsing, thinking-level derivation, canonicalisation,
 * and model+thinking pair validation (plan Phase 2 / T2.1–T2.3).
 *
 * All rules here are live-validated against agy 1.1.27 (2026-09-08):
 * - `agy models` prints `<slug>\t<Label>`.
 * - `--model` accepts BOTH the slug and the label; unknown ids loud-fail with
 *   an ERROR envelope (the old silent-downgrade class is gone). We treat the
 *   slug as canonical because `init.model` echoes it verbatim.
 * - `--effort` conflicts with a baked-level gemini slug unless it matches, and
 *   is unsupported for claude/gpt-oss models. The integration never passes
 *   `--effort` (owner decision O-defaults: thinking level = sibling slug
 *   swap); these validators guard the API boundary instead.
 */

export interface AgyModelEntry {
  /** Slug — the canonical selector passed to `--model` (echoed by init.model). */
  id: string;
  selector: string;
  name: string;
  provider: 'antigravity';
  /** Levels with a sibling slug in the catalogue, canonical low→high order. */
  thinkingLevels: string[];
}

export interface ParsedAgyModel {
  slug: string;
  label: string;
}

const LEVEL_ORDER = ['low', 'medium', 'high'] as const;
type Level = (typeof LEVEL_ORDER)[number];

function isLevel(value: string): value is Level {
  return (LEVEL_ORDER as readonly string[]).includes(value);
}

export function parseAgyModelsOutput(stdout: string): ParsedAgyModel[] {
  const models: ParsedAgyModel[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const tab = line.lastIndexOf('\t');
    if (tab >= 0) {
      const slug = line.slice(0, tab).trim();
      const label = line.slice(tab + 1).trim();
      models.push({ slug: slug || line, label: label || line });
    } else {
      // Label-only output (older agy): slug unknown, use the line for both.
      models.push({ slug: line, label: line });
    }
  }
  return models;
}

/**
 * Sibling-group extraction: `<base>-<level>` only counts as a level axis when
 * at least one OTHER entry shares the base with a different level. This keeps
 * `gpt-oss-120b-medium` (its -medium has no siblings) axis-less while giving
 * `gemini-3.1-pro-high` a real (partial) ladder.
 */
function levelSiblings(
  models: ParsedAgyModel[],
  slug: string,
): { base: string; levels: Level[] } | null {
  for (const level of LEVEL_ORDER) {
    if (!slug.endsWith(`-${level}`)) continue;
    const base = slug.slice(0, slug.length - level.length - 1);
    const siblings = models.filter(
      (m) =>
        m.slug !== slug &&
        m.slug.startsWith(`${base}-`) &&
        isLevel(m.slug.slice(base.length + 1)),
    );
    if (siblings.length === 0) return null;
    const levels = new Set<Level>([level]);
    for (const sibling of siblings) {
      const siblingLevel = sibling.slug.slice(base.length + 1);
      if (isLevel(siblingLevel)) levels.add(siblingLevel);
    }
    return {
      base,
      levels: LEVEL_ORDER.filter((l) => levels.has(l)),
    };
  }
  return null;
}

export function deriveThinkingLevels(
  models: ParsedAgyModel[],
  slug: string,
): string[] {
  const group = levelSiblings(models, slug);
  return group ? [...group.levels] : [];
}

export function toCatalogEntries(models: ParsedAgyModel[]): AgyModelEntry[] {
  return models.map((m) => ({
    id: m.slug,
    selector: m.slug,
    name: m.label,
    provider: 'antigravity' as const,
    thinkingLevels: deriveThinkingLevels(models, m.slug),
  }));
}

/**
 * Canonicalise any caller-supplied model id to the slug form agy resolves
 * best. Handles, in order: the raw `agy models` tab-string (cut at the tab),
 * a legacy `provider/` prefix, a label (mapped through the catalogue when
 * available), and passthrough for unknown ids (agy loud-fails those — the
 * integration surfaces that as a turn error instead of guessing).
 */
export function canonicalizeAgyModelId(
  input: string,
  catalog?: ParsedAgyModel[],
): string {
  let candidate = input.trim();
  const tab = candidate.lastIndexOf('\t');
  if (tab >= 0) candidate = candidate.slice(tab + 1).trim();
  const slash = candidate.indexOf('/');
  if (slash >= 0) candidate = candidate.slice(slash + 1);
  if (!candidate) return candidate;
  if (catalog) {
    const bySlug = catalog.find((m) => m.slug === candidate);
    if (bySlug) return bySlug.slug;
    const byLabel = catalog.find((m) => m.label.toLowerCase() === candidate.toLowerCase());
    if (byLabel) return byLabel.slug;
  }
  return candidate;
}

export type ModelThinkingValidation =
  | { ok: true }
  | { ok: false; reason: string; code: 'level-conflict' | 'level-unsupported' };

/**
 * Mirror of agy's own `--model`+`--effort` validation (live-validated):
 * the pair is coherent only when the requested level equals the slug's own
 * baked suffix (for sibling-bearing models), and any level is unsupported
 * for axis-less models. The integration never passes --effort; this guards
 * API-boundary inputs where a caller pairs a model with a level directly.
 */
export function validateModelThinkingPair(
  slug: string,
  level: string | undefined,
  catalog: ParsedAgyModel[],
): ModelThinkingValidation {
  if (!level) return { ok: true };
  const group = levelSiblings(catalog, slug);
  if (!group) {
    return {
      ok: false,
      code: 'level-unsupported',
      reason: `--effort is not supported for model "${slug}" (no thinking-level axis)`,
    };
  }
  const baked = group.levels.find((l) => slug === `${group.base}-${l}`);
  if (baked !== level) {
    return {
      ok: false,
      code: 'level-conflict',
      reason: `--model ${slug} conflicts with --effort "${level}" (use ${group.base}-${level} or drop the level)`,
    };
  }
  return { ok: true };
}

export type ModelSlugResolution =
  | { ok: true; slug: string }
  | { ok: false; reason: string; code: 'level-conflict' | 'level-unsupported' };

/** Thinking-level selection = sibling slug swap (never an --effort flag). */
export function resolveModelSlug(
  slug: string,
  level: string | undefined,
  catalog: ParsedAgyModel[],
): ModelSlugResolution {
  if (!level) return { ok: true, slug };
  const group = levelSiblings(catalog, slug);
  if (!group) {
    return {
      ok: false,
      code: 'level-unsupported',
      reason: `--effort is not supported for model "${slug}" (no thinking-level axis)`,
    };
  }
  if (!group.levels.includes(level as Level)) {
    return {
      ok: false,
      code: 'level-conflict',
      reason: `--model ${slug} conflicts with thinking level "${level}" (available: ${group.levels.join(', ')})`,
    };
  }
  return { ok: true, slug: `${group.base}-${level}` };
}
