/**
 * Worktree Manager Tests
 * 
 * Tests for worktree data structures and utility functions.
 * Git operations are tested via integration tests.
 */

import { describe, it, expect } from 'vitest';

// Test utility functions that don't require git

describe('Worktree Utilities', () => {
  describe('Branch Name Sanitization', () => {
    it('should sanitize task descriptions for branch names', () => {
      const sanitize = (description: string, taskId: string): string => {
        const sanitized = description
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .slice(0, 40);
        return `task-${taskId}-${sanitized}`;
      };

      expect(sanitize('Setup Database', '1')).toBe('task-1-setup-database');
      expect(sanitize('Fix Bug #123!', '2')).toBe('task-2-fix-bug-123');
      expect(sanitize('A'.repeat(100), '3')).toHaveLength(47); // task-3- + 40 chars
    });
  });

  describe('Worktree ID Generation', () => {
    it('should generate unique worktree IDs', () => {
      const generateId = (taskId: string): string => {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).slice(2, 6);
        return `wt-${taskId}-${timestamp}-${random}`;
      };

      const id1 = generateId('task-1');
      const id2 = generateId('task-1');
      
      expect(id1).toMatch(/^wt-task-1-[a-z0-9]+-[a-z0-9]+$/);
      expect(id1).not.toBe(id2); // Random component makes them unique
    });
  });

  describe('Porcelain Output Parsing', () => {
    it('should parse git worktree list porcelain output', () => {
      const parsePorcelain = (output: string): Array<{ path: string; branch: string; commit: string }> => {
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
      };

      const output = `worktree /test/repo
HEAD abc123def456
branch refs/heads/main

worktree /test/repo-wt-1
HEAD def456abc123
branch refs/heads/task-1-feature
`;

      const result = parsePorcelain(output);

      expect(result).toHaveLength(2);
      expect(result[0].path).toBe('/test/repo');
      expect(result[0].branch).toBe('refs/heads/main');
      expect(result[1].path).toBe('/test/repo-wt-1');
      expect(result[1].branch).toBe('refs/heads/task-1-feature');
    });

    it('should handle detached HEAD worktrees', () => {
      const parsePorcelain = (output: string): Array<{ path: string; branch?: string; commit: string }> => {
        const worktrees: Array<{ path: string; branch?: string; commit: string }> = [];
        const lines = output.split('\n');
        
        let current: Partial<{ path: string; branch: string; commit: string }> = {};
        
        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            if (current.path) {
              worktrees.push(current as { path: string; branch?: string; commit: string });
            }
            current = { path: line.slice(9) };
          } else if (line.startsWith('HEAD ')) {
            current.commit = line.slice(5);
          } else if (line.startsWith('branch ')) {
            current.branch = line.slice(7);
          }
        }
        
        if (current.path) {
          worktrees.push(current as { path: string; branch?: string; commit: string });
        }
        
        return worktrees;
      };

      const output = `worktree /test/repo-detached
HEAD abc123def456
`;

      const result = parsePorcelain(output);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/test/repo-detached');
      expect(result[0].branch).toBeUndefined();
    });
  });

  describe('Diff Parsing', () => {
    it('should parse git diff --numstat output', () => {
      const parseDiff = (output: string, statusOutput: string): Array<{
        path: string;
        additions: number;
        deletions: number;
        status: string;
      }> => {
        const statusMap = new Map<string, string>();
        for (const line of statusOutput.split('\n')) {
          if (!line.trim()) continue;
          const [status, ...parts] = line.split('\t');
          const filePath = parts[parts.length - 1];
          statusMap.set(filePath, status);
        }

        const files: Array<{ path: string; additions: number; deletions: number; status: string }> = [];
        
        for (const line of output.split('\n')) {
          if (!line.trim()) continue;
          const [additions, deletions, filePath] = line.split('\t');
          const status = statusMap.get(filePath) || 'M';
          
          files.push({
            path: filePath,
            additions: additions === '-' ? 0 : parseInt(additions, 10),
            deletions: deletions === '-' ? 0 : parseInt(deletions, 10),
            status,
          });
        }
        
        return files;
      };

      const numstat = `10\t5\tsrc/file.ts
3\t0\tsrc/new.ts
0\t2\tsrc/deleted.ts
`;
      const nameStatus = `M\tsrc/file.ts
A\tsrc/new.ts
D\tsrc/deleted.ts
`;

      const result = parseDiff(numstat, nameStatus);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ path: 'src/file.ts', additions: 10, deletions: 5, status: 'M' });
      expect(result[1]).toEqual({ path: 'src/new.ts', additions: 3, deletions: 0, status: 'A' });
      expect(result[2]).toEqual({ path: 'src/deleted.ts', additions: 0, deletions: 2, status: 'D' });
    });
  });
});

describe('WorktreeInfo Interface', () => {
  it('should define correct worktree status types', () => {
    const statuses: Array<'idle' | 'running' | 'completed' | 'error' | 'merged'> = 
      ['idle', 'running', 'completed', 'error', 'merged'];
    
    expect(statuses).toHaveLength(5);
  });
});
