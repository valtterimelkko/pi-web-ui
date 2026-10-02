export { resolvePlacementConfig, resolveToolsRoot, candidateToolsRootPath, placementWrapperPath, placementDegradeFilePath, DEFAULT_PER_CHILD, MEASURED_SIZING, type PlacementConfig, type ToolsRootResolution, type ToolsRootDeps, type CandidateToolsRoot } from './config.js';
export { applyStartupPlacement, placementForSpawn, getAppliedPlacement, getActivePlacementConfig, resetAppliedPlacement, startupSweepConfig, type AppliedStartupPlacement } from './apply-startup.js';
export { sanitiseId, sessionGroupName, ownGroupName, groupPath } from './keys.js';
export { PLACEMENT_WRAPPER_SCRIPT, materialiseWrapper } from './wrapper.js';
export { planSpawnForSession, planSpawnOwn, placementBashEnv, placementBashPrefixLine, buildPlacementEnv, setActiveToolsRoot, getActiveToolsRoot } from './spawn-wrap.js';
export { killGroup, removeGroup, sweepAllGroups, removeSessionGroup, realCgroupIo, type CgroupIo } from './cleanup.js';
export { PRODUCTION_TOOLS_SLICE_NAME, PRODUCTION_TOOLS_ANCHOR_SLICE, validationPlacementRefusal, validationPlacementRefusalForConfig, type ValidationPlacementInput, type ValidationPlacementCheckDeps, type ValidationPlacementRefusal } from './validation-gate.js';
export { readToolsSliceMemory, readDegradeCount, realCgroupRead, appendDegradeLine, type ToolsSliceMemory } from './capacity.js';
export {
  createPlacementBashToolDefinition,
  createPlacementSpawnHook,
  isActiveBashOurs,
  PLACEMENT_ENV_KEYS,
} from './bash-tool.js';
export { exportToolsPlacementBridge, readToolsPlacementBridge, clearToolsPlacementBridge, TOOLS_PLACEMENT_GLOBAL, type ToolsPlacementBridge } from './bridge.js';
