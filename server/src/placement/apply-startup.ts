/**
 * Correction-06 finding 1 (major): the resolved tools root must reach EVERY
 * consumer. `resolveToolsRoot` is applied exactly once at server start-up and
 * the resulting config (with the verified absolute root) is stored here; all
 * consumers — planning, bridge, health sampler, startup sweep, session cleanup,
 * split admission read — read this applied config instead of re-resolving (a
 * slice NAME never yields a root from `resolvePlacementConfig` alone).
 */
import type { PlacementConfig } from './config.js';
import { resolveToolsRoot, type ToolsRootDeps } from './config.js';
import { setActiveToolsRoot } from './spawn-wrap.js';

export interface AppliedStartupPlacement {
  active: boolean;
  config: PlacementConfig;
  reason?: string;
}

let applied: AppliedStartupPlacement | null = null;

/** Apply (resolve + verify + store) once at server start-up. */
export function applyStartupPlacement(cfg: PlacementConfig, deps?: ToolsRootDeps): AppliedStartupPlacement {
  const resolution = resolveToolsRoot(cfg, deps);
  if (resolution.available && resolution.toolsRoot) {
    applied = { active: true, config: { ...cfg, toolsRoot: resolution.toolsRoot } };
    setActiveToolsRoot(resolution.toolsRoot);
  } else {
    applied = { active: false, config: cfg, reason: resolution.reason };
    setActiveToolsRoot(undefined);
  }
  return applied;
}

/**
 * Correction-08 finding 1: THE accessor for every spawn site. Returns the config
 * applied at start-up (with the verified absolute root), or null when placement
 * was not applied — callers fall back byte-identically. Spawn paths must never
 * re-resolve the config themselves: a slice NAME only resolves here.
 */
export function placementForSpawn(): PlacementConfig | null {
  return getActivePlacementConfig();
}

/**
 * J6 correction 02: the startup and shutdown sweeps run ONLY for an applied
 * config that is ACTIVE (resolved and verified, canonical root). A failed or
 * refused resolution must leave no sweepable root: a raw `toolsRoot` from an
 * unapplied config — the absolute-path form carries one before verification —
 * must never reach `sweepAllGroups`.
 */
export function startupSweepConfig(applied: AppliedStartupPlacement): PlacementConfig {
  if (applied.active && applied.config.toolsRoot) return applied.config;
  return { ...applied.config, enabled: false, toolsRoot: undefined };
}

/** The applied config, or null before start-up applied it. */
export function getAppliedPlacement(): AppliedStartupPlacement | null {
  return applied;
}

/** Convenience for consumers that need an ACTIVE config (else null). */
export function getActivePlacementConfig(): PlacementConfig | null {
  return applied?.active ? applied.config : null;
}

/** Test seam. Also clears the spawn-side root — one mechanism, one reset. */
export function resetAppliedPlacement(): void {
  applied = null;
  setActiveToolsRoot(undefined);
}
