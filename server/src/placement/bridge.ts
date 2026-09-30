/**
 * D0 bridge: the server publishes its placement parameters to in-process extensions
 * (background-shell `bg_run`, subagent) through one well-known global. Extensions wrap
 * ONLY when this global is present — an interactive `pi` CLI that loads the same
 * extensions never sees it and stays unplaced (01-answer.md, grant (a)).
 */
import type { PlacementConfig } from './config.js';
import { placementDegradeFilePath, placementWrapperPath } from './config.js';
import { groupPath, sessionGroupName } from './keys.js';
import { materialiseWrapper } from './wrapper.js';

export const TOOLS_PLACEMENT_GLOBAL = '__PI_WEB_UI_TOOLS_PLACEMENT__';

export interface ToolsPlacementBridge {
  /** Absolute tools root (cgroup fs path of the delegated slice). */
  root: string;
  /** Absolute path of the materialised wrapper script. */
  wrapper: string;
  /** Absolute path of the degrade log. */
  degradeFile: string;
  memMax: string;
  memHigh: string;
  pidsMax: string;
  swapMax: string;
  /** Deterministic, containment-checked cgroup dir for a Pi session (undefined → refuse). */
  groupForSession(sessionId: string): string | undefined;
}

declare global {
  // eslint-disable-next-line no-var
  var __PI_WEB_UI_TOOLS_PLACEMENT__: ToolsPlacementBridge | undefined;
}

export function exportToolsPlacementBridge(cfg: PlacementConfig): ToolsPlacementBridge {
  if (!cfg.toolsRoot) throw new Error('placement: cannot export bridge without a resolved tools root');
  const bridge: ToolsPlacementBridge = {
    root: cfg.toolsRoot,
    wrapper: materialiseWrapper(cfg),
    degradeFile: placementDegradeFilePath(cfg),
    memMax: String(cfg.perChild.memoryMaxBytes),
    memHigh: String(cfg.perChild.memoryHighBytes),
    pidsMax: String(cfg.perChild.pidsMax),
    swapMax: String(cfg.perChild.swapMaxBytes),
    groupForSession: (sessionId: string) => groupPath(cfg, sessionGroupName('pi', undefined, sessionId)),
  };
  globalThis[TOOLS_PLACEMENT_GLOBAL] = bridge;
  return bridge;
}

export function readToolsPlacementBridge(): ToolsPlacementBridge | undefined {
  return globalThis[TOOLS_PLACEMENT_GLOBAL];
}

/** Test seam. */
export function clearToolsPlacementBridge(): void {
  delete globalThis[TOOLS_PLACEMENT_GLOBAL];
}
