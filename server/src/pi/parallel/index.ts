/**
 * Parallel Orchestration Module
 *
 * Exports for the parallel orchestrator system.
 */

export { WorktreeManager, createWorktreeManager, type WorktreeInfo, type CreateWorktreeOptions, type SyncResult, type DiffResult, type ConflictInfo } from './worktree-manager.js';
export { SessionOrchestrator, createSessionOrchestrator, type OrchestrationSession, type OrchestrationConfig, type OrchestrationState, type SessionEvent } from './session-orchestrator.js';
export { MergeCoordinator, createMergeCoordinator, type MergeStrategy, type ConflictResolution, type MergePreview, type MergeResult, type AIResolutionContext } from './merge-coordinator.js';
export { parsePlanFile, parsePlanContent, validatePlan, type TaskNode, type ParsedPlan, type DependencyGraph } from './plan-parser.js';
