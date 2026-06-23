/**
 * Merge Coordinator - Intelligent result merging with conflict resolution
 *
 * Coordinates merging of worktree branches into the base branch,
 * with AI-assisted conflict resolution capabilities.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorktreeManager, WorktreeInfo, ConflictInfo } from './worktree-manager.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('MergeCoordinator');


export type MergeStrategy = 'merge' | 'squash' | 'rebase';
export type ConflictResolution = 'ours' | 'theirs' | 'manual' | 'ai-assist';

export interface MergePreview {
  worktreeId: string;
  branch: string;
  baseBranch: string;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
  }>;
  totalAdditions: number;
  totalDeletions: number;
  commitCount: number;
  hasConflicts: boolean;
  conflicts?: ConflictInfo[];
}

export interface MergeResult {
  success: boolean;
  worktreeId: string;
  message: string;
  commitHash?: string;
  conflicts?: ConflictInfo[];
  resolvedBy?: 'user' | 'ai' | 'none';
}

export interface ConflictResolutionRequest {
  worktreeId: string;
  conflict: ConflictInfo;
  resolution: ConflictResolution;
  customContent?: string;
}

export interface AIResolutionContext {
  baseContent: string;
  oursContent: string;
  theirsContent: string;
  fileName: string;
  taskDescription: string;
}

/**
 * Merge Coordinator class
 */
export class MergeCoordinator {
  private worktreeManager: WorktreeManager;
  private pendingResolutions: Map<string, ConflictInfo[]> = new Map();

  constructor(worktreeManager: WorktreeManager) {
    this.worktreeManager = worktreeManager;
  }

  /**
   * Generate a merge preview for a worktree
   */
  async previewMerge(worktreeId: string): Promise<MergePreview> {
    const worktree = await this.worktreeManager.getWorktree(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree ${worktreeId} not found`);
    }

    const diff = await this.worktreeManager.getWorktreeDiff(worktreeId);
    const conflicts = await this.worktreeManager.getConflicts(worktreeId);

    return {
      worktreeId,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      files: diff.files,
      totalAdditions: diff.totalAdditions,
      totalDeletions: diff.totalDeletions,
      commitCount: worktree.commitCount,
      hasConflicts: conflicts.length > 0,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }

  /**
   * Execute a merge with the specified strategy
   */
  async executeMerge(
    worktreeId: string,
    strategy: MergeStrategy = 'merge',
    customMessage?: string
  ): Promise<MergeResult> {
    const worktree = await this.worktreeManager.getWorktree(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree ${worktreeId} not found`);
    }

    // Check for conflicts first
    const conflicts = await this.worktreeManager.getConflicts(worktreeId);
    
    if (conflicts.length > 0) {
      // Store conflicts for later resolution
      this.pendingResolutions.set(worktreeId, conflicts);
      
      return {
        success: false,
        worktreeId,
        message: `Merge blocked by ${conflicts.length} conflicts`,
        conflicts,
        resolvedBy: 'none',
      };
    }

    // No conflicts, proceed with merge
    const result = await this.worktreeManager.mergeWorktree(worktreeId, strategy, customMessage);

    return {
      success: result.success,
      worktreeId,
      message: result.message,
      conflicts: result.conflicts,
      resolvedBy: result.success ? 'none' : undefined,
    };
  }

  /**
   * Get pending conflicts for a worktree
   */
  getPendingConflicts(worktreeId: string): ConflictInfo[] | undefined {
    return this.pendingResolutions.get(worktreeId);
  }

  /**
   * Resolve a conflict using AI assistance
   * 
   * This is a placeholder that returns a suggested resolution.
   * In production, this would call an AI model to intelligently merge.
   */
  async resolveConflictWithAI(context: AIResolutionContext): Promise<string> {
    // Simple AI-like resolution: try to combine both versions
    // In production, this would use an actual AI model
    
    const { baseContent, oursContent, theirsContent, fileName } = context;
    
    // If one side is empty, use the non-empty one
    if (!oursContent || oursContent.trim() === '') {
      return theirsContent;
    }
    if (!theirsContent || theirsContent.trim() === '') {
      return oursContent;
    }
    
    // If contents are identical, no conflict
    if (oursContent === theirsContent) {
      return oursContent;
    }
    
    // For code files, try to intelligently merge
    if (this.isCodeFile(fileName)) {
      return this.mergeCodeContent(baseContent, oursContent, theirsContent);
    }
    
    // For other files, prefer theirs (the worktree changes) as default
    // but mark with comments
    return this.createManualResolutionMarker(baseContent, oursContent, theirsContent, fileName);
  }

  /**
   * Check if file is a code file
   */
  private isCodeFile(fileName: string): boolean {
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp'];
    return codeExtensions.some(ext => fileName.endsWith(ext));
  }

  /**
   * Attempt to merge code content
   */
  private mergeCodeContent(base: string, ours: string, theirs: string): string {
    // Simple line-based merge
    const baseLines = base.split('\n');
    const oursLines = ours.split('\n');
    const theirsLines = theirs.split('\n');
    
    // If they're similar length, try to merge line by line
    if (Math.abs(oursLines.length - theirsLines.length) <= 5) {
      const merged: string[] = [];
      const maxLen = Math.max(oursLines.length, theirsLines.length);
      
      for (let i = 0; i < maxLen; i++) {
        const oursLine = oursLines[i] || '';
        const theirsLine = theirsLines[i] || '';
        const baseLine = baseLines[i] || '';
        
        if (oursLine === theirsLine) {
          merged.push(oursLine);
        } else if (oursLine === baseLine) {
          // Base unchanged, use theirs
          merged.push(theirsLine);
        } else if (theirsLine === baseLine) {
          // Base unchanged, use ours
          merged.push(oursLine);
        } else {
          // Both changed, prefer theirs but add comment
          merged.push(theirsLine);
          if (oursLine.trim() && !oursLine.startsWith('//')) {
            merged.push(`// CONFLICT: base had: ${baseLine.trim()}`);
            merged.push(`// CONFLICT: ours had: ${oursLine.trim()}`);
          }
        }
      }
      
      return merged.join('\n');
    }
    
    // Too different, create manual resolution marker
    return this.createManualResolutionMarker(base, ours, theirs, 'code');
  }

  /**
   * Create a manual resolution marker for complex conflicts
   */
  private createManualResolutionMarker(
    base: string,
    ours: string,
    theirs: string,
    fileName: string
  ): string {
    const ext = path.extname(fileName);
    const commentStart = ext === '.py' ? '#' : '//';
    
    return `${commentStart} ========== CONFLICT REQUIRES MANUAL RESOLUTION ==========
${commentStart} File: ${fileName}
${commentStart} 
${commentStart} BASE VERSION:
${base.split('\n').map(l => `${commentStart} BASE: ${l}`).join('\n')}
${commentStart} 
${commentStart} OURS VERSION (base branch):
${ours.split('\n').map(l => `${commentStart} OURS: ${l}`).join('\n')}
${commentStart} 
${commentStart} THEIRS VERSION (worktree):
${theirs.split('\n').map(l => `${commentStart} THEIRS: ${l}`).join('\n')}
${commentStart} ========================================================

${theirs}
`;
  }

  /**
   * Apply a conflict resolution
   */
  async applyResolution(request: ConflictResolutionRequest): Promise<{ success: boolean; message: string }> {
    const { worktreeId, conflict, resolution, customContent } = request;
    
    const worktree = await this.worktreeManager.getWorktree(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree ${worktreeId} not found`);
    }

    let resolvedContent: string;

    switch (resolution) {
      case 'ours':
        resolvedContent = conflict.baseContent || '';
        break;
      case 'theirs':
        resolvedContent = conflict.oursContent || '';
        break;
      case 'manual':
        if (!customContent) {
          return { success: false, message: 'Custom content required for manual resolution' };
        }
        resolvedContent = customContent;
        break;
      case 'ai-assist':
        resolvedContent = await this.resolveConflictWithAI({
          baseContent: conflict.baseContent || '',
          oursContent: conflict.oursContent || '',
          theirsContent: conflict.theirsContent || '',
          fileName: conflict.file,
          taskDescription: worktree.taskDescription,
        });
        break;
    }

    // Write resolved content to worktree
    const filePath = path.join(worktree.path, conflict.file);
    await fs.writeFile(filePath, resolvedContent);

    // Remove from pending
    const pending = this.pendingResolutions.get(worktreeId);
    if (pending) {
      const index = pending.findIndex(c => c.file === conflict.file);
      if (index >= 0) {
        pending.splice(index, 1);
      }
      if (pending.length === 0) {
        this.pendingResolutions.delete(worktreeId);
      }
    }

    return { success: true, message: `Resolved conflict in ${conflict.file}` };
  }

  /**
   * Batch merge multiple worktrees
   */
  async batchMerge(
    worktreeIds: string[],
    strategy: MergeStrategy = 'merge',
    onProgress?: (completed: number, total: number, worktreeId: string) => void
  ): Promise<MergeResult[]> {
    const results: MergeResult[] = [];
    
    for (let i = 0; i < worktreeIds.length; i++) {
      const worktreeId = worktreeIds[i];
      const result = await this.executeMerge(worktreeId, strategy);
      results.push(result);
      
      if (onProgress) {
        onProgress(i + 1, worktreeIds.length, worktreeId);
      }
      
      // If merge failed with conflicts, stop batch
      if (!result.success && result.conflicts && result.conflicts.length > 0) {
        logger.warn(`[MergeCoordinator] Batch merge stopped at ${worktreeId} due to conflicts`);
        break;
      }
    }
    
    return results;
  }

  /**
   * Get merge statistics for an orchestration
   */
  async getMergeStats(worktreeIds: string[]): Promise<{
    total: number;
    ready: number;
    hasConflicts: number;
    completed: number;
    totalChanges: { additions: number; deletions: number };
  }> {
    let ready = 0;
    let hasConflicts = 0;
    let completed = 0;
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const worktreeId of worktreeIds) {
      try {
        const preview = await this.previewMerge(worktreeId);
        
        if (preview.hasConflicts) {
          hasConflicts++;
        } else {
          ready++;
        }
        
        totalAdditions += preview.totalAdditions;
        totalDeletions += preview.totalDeletions;
      } catch {
        // Worktree might be merged already
        completed++;
      }
    }

    return {
      total: worktreeIds.length,
      ready,
      hasConflicts,
      completed,
      totalChanges: {
        additions: totalAdditions,
        deletions: totalDeletions,
      },
    };
  }
}

/**
 * Create a merge coordinator
 */
export function createMergeCoordinator(worktreeManager: WorktreeManager): MergeCoordinator {
  return new MergeCoordinator(worktreeManager);
}
