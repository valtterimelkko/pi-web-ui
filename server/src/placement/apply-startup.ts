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
  } else {
    applied = { active: false, config: cfg, reason: resolution.reason };
  }
  return applied;
}

/** The applied config, or null before start-up applied it. */
export function getAppliedPlacement(): AppliedStartupPlacement | null {
  return applied;
}

/** Convenience for consumers that need an ACTIVE config (else null). */
export function getActivePlacementConfig(): PlacementConfig | null {
  return applied?.active ? applied.config : null;
}

/** Test seam. */
export function resetAppliedPlacement(): void {
  applied = null;
}
