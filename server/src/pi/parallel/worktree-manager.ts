/**
 * Worktree Manager - Git worktree operations for parallel orchestration
 *
 * Provides isolated git worktrees for parallel agent execution.
 * Each worktree has its own branch and working directory.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const execAsync = promisify(exec);

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  baseBranch: string;
  sessionId?: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'merged';
  createdAt: Date;
  taskDescription: string;
  commitCount: number;
  hasUncommittedChanges: boolean;
}

export interface CreateWorktreeOptions {
  taskId: string;
  baseBranch?: string;
  taskDescription: string;
  repoPath: string;
}

export interface SyncResult {
  success: boolean;
  message: string;
  conflicts?: string[];
}

export interface DiffResult {
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
  }>;
  totalAdditions: number;
  totalDeletions: number;
}

export interface ConflictInfo {
  file: string;
  type: 'content' | 'delete/modify' | 'rename';
  oursContent?: string;
  theirsContent?: string;
  baseContent?: string;
}

/**
 * Execute a git command in the specified directory
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout, stderr } = await execAsync(`git ${args.join(' ')}`, {
    cwd,
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
  });
  if (stderr && !stderr.includes('warning:')) {
    // Only throw on actual errors, not warnings
    if (stderr.includes('fatal:') || stderr.includes('error:')) {
      throw new Error(`Git error: ${stderr}`);
    }
  }
  return stdout.trim();
}

/**
 * Generate a unique worktree ID
 */
function generateWorktreeId(taskId: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `wt-${taskId}-${timestamp}-${random}`;
}

/**
 * Sanitize branch name from task description
 */
function sanitizeBranchName(description: string, taskId: string): string {
  // Remove special characters, convert spaces to hyphens, limit length
  const sanitized = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return `task-${taskId}-${sanitized}`;
}

/**
 * Parse porcelain output from git worktree list
 */
function parseWorktreePorcelain(output: string): Array<{ path: string; branch: string; commit: string }> {
  const worktrees: Array<{ path: string; branch: string; commit: string }> = [];
  const lines = output.split('\n');
  
  let current: Partial<{ path: string; branch: string; commit: string }> = {};
  
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current.path) {
        worktrees.push(current as { path: string; branch: string; commit: string });
      }
      current = { path: line.slice(9) };
    } else if (line.startsWith('HEAD ')) {
      current.commit = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7);
    }
  }
  
  if (current.path) {
    worktrees.push(current as { path: string; branch: string; commit: string });
  }
  
  return worktrees;
}

/**
 * Worktree Manager class
 */
export class WorktreeManager {
  private repoPath: string;
  private worktreeMetadata: Map<string, WorktreeInfo> = new Map();
  private metadataFile: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.metadataFile = path.join(repoPath, '.git', 'worktree-metadata.json');
  }

  /**
   * Initialize the worktree manager and load existing metadata
   */
  async initialize(): Promise<void> {
    try {
      const data = await fs.readFile(this.metadataFile, 'utf-8');
      const metadata = JSON.parse(data);
      this.worktreeMetadata = new Map(Object.entries(metadata));
    } catch {
      // No existing metadata, start fresh
      this.worktreeMetadata = new Map();
    }
  }

  /**
   * Save metadata to disk
   */
  private async saveMetadata(): Promise<void> {
    const metadata = Object.fromEntries(this.worktreeMetadata);
    await fs.writeFile(this.metadataFile, JSON.stringify(metadata, null, 2));
  }

  /**
   * Get the git repository root path
   */
  getRepoPath(): string {
    return this.repoPath;
  }

  /**
   * Create a new worktree for a task
   */
  async createWorktree(options: CreateWorktreeOptions): Promise<WorktreeInfo> {
    const { taskId, baseBranch = 'main', taskDescription, repoPath } = options;
    
    // Generate unique ID and branch name
    const id = generateWorktreeId(taskId);
    const branchName = sanitizeBranchName(taskDescription, taskId);
    
    // Create worktree path alongside the main repo
    const worktreePath = path.join(path.dirname(repoPath), path.basename(repoPath) + '-' + id);
    
    // Ensure base branch exists and is up to date
    try {
      await git(repoPath, 'fetch', 'origin', baseBranch);
    } catch {
      // Might be a local-only branch, that's ok
    }
    
    // Check if branch already exists
    let branchExists = false;
    try {
      await git(repoPath, 'rev-parse', '--verify', branchName);
      branchExists = true;
    } catch {
      // Branch doesn't exist, which is what we want
    }
    
    if (branchExists) {
      // Create worktree with existing branch
      await git(repoPath, 'worktree', 'add', worktreePath, branchName);
    } else {
      // Create worktree with new branch from base
      await git(repoPath, 'worktree', 'add', '-b', branchName, worktreePath, baseBranch);
    }
    
    const info: WorktreeInfo = {
      id,
      path: worktreePath,
      branch: branchName,
      baseBranch,
      status: 'idle',
      createdAt: new Date(),
      taskDescription,
      commitCount: 0,
      hasUncommittedChanges: false,
    };
    
    this.worktreeMetadata.set(id, info);
    await this.saveMetadata();
    
    return info;
  }

  /**
   * List all worktrees with their status
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const output = await git(this.repoPath, 'worktree', 'list', '--porcelain');
    const parsed = parseWorktreePorcelain(output);
    
    // Update metadata with actual git state
    for (const wt of parsed) {
      const metadata = Array.from(this.worktreeMetadata.values()).find(m => m.path === wt.path);
      if (metadata) {
        // Update commit count and uncommitted changes status
        try {
          const statusOutput = await git(wt.path, 'status', '--porcelain');
          metadata.hasUncommittedChanges = statusOutput.length > 0;
          
          const logOutput = await git(wt.path, 'rev-list', '--count', `${metadata.baseBranch}..HEAD`);
          metadata.commitCount = parseInt(logOutput, 10) || 0;
        } catch {
          // Worktree might have issues
        }
      }
    }
    
    // Return all worktrees (excluding main repo)
    return Array.from(this.worktreeMetadata.values())
      .filter(wt => wt.path !== this.repoPath)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Get a specific worktree by ID
   */
  async getWorktree(id: string): Promise<WorktreeInfo | null> {
    const info = this.worktreeMetadata.get(id);
    if (!info) return null;
    
    // Update status
    try {
      const statusOutput = await git(info.path, 'status', '--porcelain');
      info.hasUncommittedChanges = statusOutput.length > 0;
      
      const logOutput = await git(info.path, 'rev-list', '--count', `${info.baseBranch}..HEAD`);
      info.commitCount = parseInt(logOutput, 10) || 0;
    } catch {
      // Worktree might have issues
    }
    
    return info;
  }

  /**
   * Update worktree status
   */
  async updateWorktreeStatus(id: string, status: WorktreeInfo['status'], sessionId?: string): Promise<void> {
    const info = this.worktreeMetadata.get(id);
    if (!info) throw new Error(`Worktree ${id} not found`);
    
    info.status = status;
    if (sessionId !== undefined) {
      info.sessionId = sessionId;
    }
    
    await this.saveMetadata();
  }

  /**
   * Delete a worktree and optionally its branch
   */
  async deleteWorktree(id: string, deleteBranch: boolean = true): Promise<void> {
    const info = this.worktreeMetadata.get(id);
    if (!info) throw new Error(`Worktree ${id} not found`);
    
    // Remove the worktree
    try {
      await git(this.repoPath, 'worktree', 'remove', info.path, '--force');
    } catch (error) {
      // Try pruning if normal remove fails
      await git(this.repoPath, 'worktree', 'prune');
      
      // Manually remove directory if it still exists
      try {
        await fs.rm(info.path, { recursive: true, force: true });
      } catch {
        // Directory might not exist
      }
    }
    
    // Delete the branch if requested
    if (deleteBranch) {
      try {
        await git(this.repoPath, 'branch', '-D', info.branch);
      } catch {
        // Branch might already be deleted or merged
      }
    }
    
    this.worktreeMetadata.delete(id);
    await this.saveMetadata();
  }

  /**
   * Sync worktree with its base branch (fetch and optionally rebase)
   */
  async syncWorktree(id: string, rebase: boolean = false): Promise<SyncResult> {
    const info = this.worktreeMetadata.get(id);
    if (!info) throw new Error(`Worktree ${id} not found`);
    
    try {
      // Fetch latest from remote
      await git(info.path, 'fetch', 'origin', info.baseBranch);
      
      if (rebase) {
        // Attempt rebase
        try {
          await git(info.path, 'rebase', `origin/${info.baseBranch}`);
          return { success: true, message: 'Rebase completed successfully' };
        } catch (error) {
          // Check for conflicts
          const status = await git(info.path, 'status', '--porcelain');
          const conflicts = status.split('\n')
            .filter(line => line.startsWith('UU') || line.startsWith('AA'))
            .map(line => line.slice(3));
          
          if (conflicts.length > 0) {
            // Abort rebase
            await git(info.path, 'rebase', '--abort');
            return {
              success: false,
              message: 'Rebase had conflicts',
              conflicts,
            };
          }
          throw error;
        }
      } else {
        return { success: true, message: 'Fetched latest from remote' };
      }
    } catch (error) {
      return {
        success: false,
        message: `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Get diff between worktree and base branch
   */
  async getWorktreeDiff(id: string): Promise<DiffResult> {
    const info = this.worktreeMetadata.get(id);
    if (!info) throw new Error(`Worktree ${id} not found`);
    
    const output = await git(info.path, 'diff', '--numstat', `${info.baseBranch}...HEAD`);
    const statusOutput = await git(info.path, 'diff', '--name-status', `${info.baseBranch}...HEAD`);
    
    const statusMap = new Map<string, 'added' | 'modified' | 'deleted' | 'renamed'>();
    for (const line of statusOutput.split('\n')) {
      if (!line.trim()) continue;
      const [status, ...parts] = line.split('\t');
      const filePath = parts[parts.length - 1];
      statusMap.set(filePath, status as 'added' | 'modified' | 'deleted' | 'renamed');
    }
    
    const files: DiffResult['files'] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const [additions, deletions, filePath] = line.split('\t');
      const status = statusMap.get(filePath) || 'modified';
      
      const add = additions === '-' ? 0 : parseInt(additions, 10);
      const del = deletions === '-' ? 0 : parseInt(deletions, 10);
      
      files.push({
        path: filePath,
        additions: add,
        deletions: del,
        status,
      });
      
      totalAdditions += add;
      totalDeletions += del;
    }
    
    return { files, totalAdditions, totalDeletions };
  }

  /**
   * Get conflicts between worktree and base branch
   */
  async getConflicts(id: string): Promise<ConflictInfo[]> {
    const info = this.worktreeMetadata.get(id);
    if (!info) throw new Error(`Worktree ${id} not found`);
    
    // Try a merge --no-commit to detect conflicts
    try {
      await git(info.path, 'merge', '--no-commit', '--no-ff', `origin/${info.baseBranch}`);
      
      // If we get here, no conflicts
      await git(info.path, 'merge', '--abort');
      return [];
    } catch {
      // Check for conflicted files
      const status = await git(info.path, 'status', '--porcelain');
      const conflicts: ConflictInfo[] = [];
      
      for (const line of status.split('\n')) {
        if (line.startsWith('UU') || line.startsWith('AA')) {
          const filePath = line.slice(3);
          
          // Read conflict content
          try {
            const content = await fs.readFile(path.join(info.path, filePath), 'utf-8');
            conflicts.push({
              file: filePath,
              type: 'content',
              oursContent: content,
            });
          } catch {
            conflicts.push({
              file: filePath,
              type: 'content',
            });
          }
        }
      }
      
      // Abort the merge
      try {
        await git(info.path, 'merge', '--abort');
      } catch {
        // Might already be aborted
      }
      
      return conflicts;
    }
  }

  /**
   * Merge worktree branch into base branch
   */
  async mergeWorktree(
    id: string,
    strategy: 'merge' | 'squash' | 'rebase' = 'merge',
    message?: string
  ): Promise<{ success: boolean; message: string; conflicts?: ConflictInfo[] }> {
    const info = this.worktreeMetadata.get(id);
    if (!info) throw new Error(`Worktree ${id} not found`);
    
    // First, commit any uncommitted changes in the worktree
    try {
      const status = await git(info.path, 'status', '--porcelain');
      if (status.length > 0) {
        await git(info.path, 'add', '-A');
        await git(info.path, 'commit', '-m', `WIP: ${info.taskDescription}`);
      }
    } catch {
      // Might fail if nothing to commit
    }
    
    // Switch to base branch
    await git(this.repoPath, 'checkout', info.baseBranch);
    
    // Pull latest
    try {
      await git(this.repoPath, 'pull', 'origin', info.baseBranch);
    } catch {
      // Might be ahead of remote or no remote
    }
    
    try {
      if (strategy === 'squash') {
        // Squash merge
        await git(this.repoPath, 'merge', '--squash', info.branch);
        await git(this.repoPath, 'commit', '-m', message || `feat: ${info.taskDescription}`);
      } else if (strategy === 'rebase') {
        // Rebase worktree branch onto base, then fast-forward merge
        await git(info.path, 'rebase', info.baseBranch);
        await git(this.repoPath, 'merge', '--ff-only', info.branch);
      } else {
        // Regular merge
        await git(this.repoPath, 'merge', info.branch, '-m', message || `Merge ${info.branch}`);
      }
      
      // Push to remote
      try {
        await git(this.repoPath, 'push', 'origin', info.baseBranch);
      } catch {
        // Might not have remote
      }
      
      // Update status
      info.status = 'merged';
      await this.saveMetadata();
      
      return { success: true, message: `Successfully merged ${info.branch} into ${info.baseBranch}` };
    } catch (error) {
      // Check for conflicts
      const status = await git(this.repoPath, 'status', '--porcelain');
      const conflicts: ConflictInfo[] = [];
      
      for (const line of status.split('\n')) {
        if (line.startsWith('UU') || line.startsWith('AA')) {
          const filePath = line.slice(3);
          conflicts.push({
            file: filePath,
            type: 'content',
          });
        }
      }
      
      // Abort merge
      try {
        await git(this.repoPath, 'merge', '--abort');
      } catch {
        // Might not be in merge state
      }
      
      return {
        success: false,
        message: `Merge failed with ${conflicts.length} conflicts`,
        conflicts,
      };
    }
  }

  /**
   * Clean up all worktrees (for testing or reset)
   */
  async cleanup(): Promise<void> {
    const worktrees = await this.listWorktrees();
    for (const wt of worktrees) {
      try {
        await this.deleteWorktree(wt.id, true);
      } catch {
        // Best effort cleanup
      }
    }
  }
}

/**
 * Create a worktree manager for a repository
 */
export async function createWorktreeManager(repoPath: string): Promise<WorktreeManager> {
  const manager = new WorktreeManager(repoPath);
  await manager.initialize();
  return manager;
}
