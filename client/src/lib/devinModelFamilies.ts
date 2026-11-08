/**
 * Lane D3 (devin-parity): one model choice per Devin family.
 *
 * `GET /api/models?sdkType=devin` returns one entry per level variant, each
 * carrying the server-derived `family` (base id) and `familyName` (display
 * name without the level word). The browser groups by `family` so the New
 * Session modal and the session header show ONE entry per family plus a level
 * dropdown, and send the resolved variant id (`<family>-<level>`) — never a
 * separate selector per level (owner, 2026-11-08).
 *
 * Level order is Devin's canonical ladder; unknown levels sort last, stable.
 */

export interface DevinCatalogModel {
  id: string;
  name?: string;
  pricing?: { free: boolean; raw: string; costTier?: string };
  thinkingLevels?: string[];
  /** Server-derived family base id (or the id itself when axis-less). */
  family?: string;
  /** Server-derived display name without the level word. */
  familyName?: string;
}

export interface DevinFamily {
  /** Family base id — the request-level grouping key. */
  family: string;
  /** Display name without the level word (e.g. "SWE-2 Flash"). */
  name: string;
  /** Levels with a sibling id, canonical low→max order; [] when axis-less. */
  levels: string[];
  /** medium when the family has it, else its lowest level; null when axis-less. */
  defaultLevel: string | null;
  /** True only when EVERY variant is free (a mixed family shows no badge). */
  free: boolean;
  variants: DevinCatalogModel[];
}

const LEVEL_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

function levelRank(level: string): number {
  return LEVEL_ORDER[level] ?? 100;
}

/** Group the per-variant catalogue into one entry per family, preserving the
 *  catalogue's first-seen order (the CLI's own family order). */
export function groupDevinModelsByFamily(models: DevinCatalogModel[]): DevinFamily[] {
  const groups = new Map<string, DevinFamily>();
  for (const model of models) {
    const familyId = model.family ?? model.id;
    let group = groups.get(familyId);
    if (!group) {
      group = {
        family: familyId,
        name: model.familyName ?? model.name ?? familyId,
        levels: [],
        defaultLevel: null,
        free: true,
        variants: [],
      };
      groups.set(familyId, group);
    }
    group.variants.push(model);
    // A family is free only when every variant is free; a family mixing free
    // and paid levels shows no badge (the dropdown exposes the difference).
    if (model.pricing && !model.pricing.free) group.free = false;
  }
  const families = [...groups.values()];
  for (const group of families) {
    const levels = new Set<string>();
    for (const variant of group.variants) {
      for (const level of variant.thinkingLevels ?? []) levels.add(level);
    }
    group.levels = [...levels].sort((a, b) => levelRank(a) - levelRank(b));
    group.defaultLevel = group.levels.includes('medium')
      ? 'medium'
      : (group.levels[0] ?? null);
  }
  return families;
}

/** The variant id the create request sends: `<family>-<level>`, or the family
 *  id itself for an axis-less family (level null). */
export function resolveDevinVariantId(family: DevinFamily, level: string | null): string {
  if (!level || family.levels.length === 0) return family.family;
  return `${family.family}-${level}`;
}
