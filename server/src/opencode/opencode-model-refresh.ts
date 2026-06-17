/**
 * OpenCode model-refresh helpers.
 *
 * Pure, testable building blocks for keeping the OpenCode model list current as
 * gateways (Kilo Gateway, OpenCode Zen, …) and upstream labs add models.
 *
 * Design notes (see docs/OPENCODE-MODEL-AUTOMATION.md):
 * - Pi Web UI never reads provider API keys. It only consumes the model list
 *   that `OpenCodeService.getAvailableModels()` derives from `/config/providers`.
 * - A long-running `opencode serve` serves its catalogue from memory, so picking
 *   up freshly-fetched models.dev data requires warming the on-disk cache AND
 *   recycling the backend. This module captures the snapshot/diff logic; the
 *   orchestration lives in `OpenCodeService.refreshModels()`.
 * - Snapshots and diffs contain provider ids and model ids only — never secrets.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';

/** A point-in-time view of which models each provider exposes. */
export interface ModelSnapshot {
  generatedAt: string;
  /** providerId -> sorted list of model ids */
  providers: Record<string, string[]>;
}

/** The difference between two snapshots, expressed as fully-qualified ids. */
export interface SnapshotDiff {
  /** Newly-available models as `provider/id`. */
  addedModels: string[];
  /** Models that disappeared as `provider/id`. */
  removedModels: string[];
  /** Provider ids present now but not before. */
  addedProviders: string[];
  /** Provider ids present before but not now. */
  removedProviders: string[];
  /** True when anything changed. */
  changed: boolean;
}

/** Minimal shape of a model entry produced by getAvailableModels(). */
export interface RefreshModelEntry {
  id: string;
  provider: string;
}

/**
 * Group a flat model list (from getAvailableModels) into a snapshot.
 * Model ids are de-duplicated and sorted per provider for stable diffs.
 */
export function buildModelSnapshot(
  models: ReadonlyArray<RefreshModelEntry>,
  now: Date = new Date(),
): ModelSnapshot {
  const providers: Record<string, Set<string>> = {};
  for (const model of models) {
    if (!model.provider || !model.id) continue;
    (providers[model.provider] ??= new Set()).add(model.id);
  }
  const sorted: Record<string, string[]> = {};
  for (const providerId of Object.keys(providers).sort()) {
    sorted[providerId] = [...providers[providerId]].sort();
  }
  return { generatedAt: now.toISOString(), providers: sorted };
}

/**
 * Compute the difference between a previous snapshot (possibly null on first run)
 * and the current one.
 */
export function diffModelSnapshots(
  prev: ModelSnapshot | null,
  next: ModelSnapshot,
): SnapshotDiff {
  const prevProviders = new Set(Object.keys(prev?.providers ?? {}));
  const nextProviders = new Set(Object.keys(next.providers));

  const addedProviders = [...nextProviders].filter((p) => !prevProviders.has(p)).sort();
  const removedProviders = [...prevProviders].filter((p) => !nextProviders.has(p)).sort();

  const qualify = (providers: Record<string, string[]>): Set<string> => {
    const out = new Set<string>();
    for (const [providerId, ids] of Object.entries(providers)) {
      for (const id of ids) out.add(`${providerId}/${id}`);
    }
    return out;
  };

  const prevModels = qualify(prev?.providers ?? {});
  const nextModels = qualify(next.providers);

  const addedModels = [...nextModels].filter((m) => !prevModels.has(m)).sort();
  const removedModels = [...prevModels].filter((m) => !nextModels.has(m)).sort();

  return {
    addedModels,
    removedModels,
    addedProviders,
    removedProviders,
    changed:
      addedModels.length > 0 ||
      removedModels.length > 0 ||
      addedProviders.length > 0 ||
      removedProviders.length > 0,
  };
}

/** Read a persisted snapshot, returning null if missing or unparseable. */
export async function readSnapshot(snapshotPath: string): Promise<ModelSnapshot | null> {
  try {
    const raw = await readFile(snapshotPath, 'utf-8');
    const parsed = JSON.parse(raw) as ModelSnapshot;
    if (parsed && typeof parsed === 'object' && parsed.providers) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Persist a snapshot (creating the parent directory). Best-effort. */
export async function writeSnapshot(snapshotPath: string, snapshot: ModelSnapshot): Promise<void> {
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
}
