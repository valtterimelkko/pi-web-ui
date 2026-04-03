/**
 * WorktreeList Component
 *
 * Displays list of git worktrees with status badges and controls.
 */

import React from 'react';
import { useOrchestrationStore, type WorktreeInfo } from '../../store/orchestrationStore';

interface WorktreeListProps {
  onSelectWorktree?: (worktree: WorktreeInfo) => void;
  onMergeWorktree?: (worktreeId: string) => void;
  onDeleteWorktree?: (worktreeId: string) => void;
}

const statusColors: Record<WorktreeInfo['status'], string> = {
  idle: 'text-slate-400 bg-slate-800',
  running: 'text-amber-400 bg-amber-900/30',
  completed: 'text-emerald-400 bg-emerald-900/30',
  error: 'text-red-400 bg-red-900/30',
  merged: 'text-blue-400 bg-blue-900/30',
};

const statusIcons: Record<WorktreeInfo['status'], string> = {
  idle: '○',
  running: '◉',
  completed: '✓',
  error: '✗',
  merged: '◈',
};

export function WorktreeList({ onSelectWorktree, onMergeWorktree, onDeleteWorktree }: WorktreeListProps) {
  const worktrees = useOrchestrationStore((s) => s.worktrees);
  const selectedSessionId = useOrchestrationStore((s) => s.selectedSessionId);

  if (worktrees.length === 0) {
    return (
      <div className="p-4 text-center text-slate-500">
        <p>No worktrees yet</p>
        <p className="text-sm mt-1">Start an orchestration to create worktrees</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {worktrees.map((worktree) => (
        <WorktreeCard
          key={worktree.id}
          worktree={worktree}
          isSelected={worktree.sessionId === selectedSessionId}
          onSelect={() => onSelectWorktree?.(worktree)}
          onMerge={() => onMergeWorktree?.(worktree.id)}
          onDelete={() => onDeleteWorktree?.(worktree.id)}
        />
      ))}
    </div>
  );
}

interface WorktreeCardProps {
  worktree: WorktreeInfo;
  isSelected: boolean;
  onSelect: () => void;
  onMerge: () => void;
  onDelete: () => void;
}

function WorktreeCard({ worktree, isSelected, onSelect, onMerge, onDelete }: WorktreeCardProps) {
  const [showActions, setShowActions] = React.useState(false);

  return (
    <div
      className={`
        p-3 rounded-lg border cursor-pointer transition-colors
        ${isSelected
          ? 'border-blue-500 bg-blue-900/20'
          : 'border-slate-700 bg-slate-800 hover:border-slate-600'
        }
      `}
      onClick={onSelect}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-xs px-1.5 py-0.5 rounded ${statusColors[worktree.status]}`}>
              {statusIcons[worktree.status]} {worktree.status}
            </span>
            {worktree.hasUncommittedChanges && (
              <span className="text-xs text-amber-400">●</span>
            )}
          </div>
          <h4 className="text-sm font-medium text-slate-200 mt-1 truncate">
            {worktree.taskDescription}
          </h4>
          <p className="text-xs text-slate-500 mt-0.5 font-mono truncate">
            {worktree.branch}
          </p>
        </div>

        {showActions && (
          <div className="flex gap-1">
            {worktree.status === 'completed' && (
              <button
                onClick={(e) => { e.stopPropagation(); onMerge(); }}
                className="p-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-900/30 rounded"
                title="Merge this worktree"
              >
                ⊳
              </button>
            )}
            {worktree.status !== 'running' && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="p-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded"
                title="Delete worktree"
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>

      {worktree.commitCount > 0 && (
        <div className="mt-2 text-xs text-slate-500">
          {worktree.commitCount} commit{worktree.commitCount !== 1 ? 's' : ''}
        </div>
      )}

      {worktree.status === 'running' && worktree.progress !== undefined && (
        <div className="mt-2">
          <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-500 transition-all"
              style={{ width: `${worktree.progress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default WorktreeList;
