/**
 * WorkspaceTabs Component
 *
 * Tab bar for switching between worktree sessions.
 * Shows status indicators and allows quick navigation.
 */

import React from 'react';
import { useOrchestrationStore, type WorktreeInfo } from '../../store/orchestrationStore';

interface WorkspaceTabsProps {
  onNewWorktree?: () => void;
}

const statusColors: Record<string, string> = {
  idle: 'text-slate-400',
  running: 'text-amber-400 animate-pulse',
  completed: 'text-emerald-400',
  error: 'text-red-400',
  merged: 'text-violet-400',
};

const statusIcons: Record<string, string> = {
  idle: '○',
  running: '◉',
  completed: '✓',
  error: '✗',
  merged: '◈',
};

export function WorkspaceTabs({ onNewWorktree }: WorkspaceTabsProps) {
  const worktrees = useOrchestrationStore((s) => s.worktrees);
  const selectedSessionId = useOrchestrationStore((s) => s.selectedSessionId);
  const setSelectedSession = useOrchestrationStore((s) => s.setSelectedSession);

  // Group worktrees by status for visual organization
  const runningWorktrees = worktrees.filter((w) => w.status === 'running');
  const completedWorktrees = worktrees.filter((w) => w.status === 'completed');
  const otherWorktrees = worktrees.filter((w) => !['running', 'completed'].includes(w.status));

  // Sort: running first, then completed, then others
  const sortedWorktrees = [...runningWorktrees, ...completedWorktrees, ...otherWorktrees];

  return (
    <div className="flex items-center gap-1 px-4 py-2 bg-slate-900 border-b border-slate-700 overflow-x-auto">
      {/* Base tab */}
      <button
        className={`
          px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap
          ${!selectedSessionId
            ? 'bg-slate-700 text-slate-200'
            : 'text-slate-400 hover:text-slate-300 hover:bg-slate-800'
          }
        `}
        onClick={() => setSelectedSession(null)}
      >
        <span className="mr-1.5">◈</span>
        Base
      </button>

      {/* Separator */}
      {sortedWorktrees.length > 0 && (
        <div className="w-px h-5 bg-slate-700 mx-1" />
      )}

      {/* Worktree tabs */}
      {sortedWorktrees.map((worktree, index) => (
        <WorkspaceTab
          key={worktree.id}
          worktree={worktree}
          index={index + 1}
          isSelected={worktree.sessionId === selectedSessionId}
          onSelect={() => setSelectedSession(worktree.sessionId || null)}
        />
      ))}

      {/* New worktree button */}
      {onNewWorktree && (
        <>
          <div className="w-px h-5 bg-slate-700 mx-1" />
          <button
            onClick={onNewWorktree}
            className="px-2 py-1.5 text-sm text-slate-500 hover:text-slate-300 hover:bg-slate-800 rounded-md transition-colors"
            title="Add new worktree"
          >
            +
          </button>
        </>
      )}
    </div>
  );
}

interface WorkspaceTabProps {
  worktree: WorktreeInfo;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
}

function WorkspaceTab({ worktree, index, isSelected, onSelect }: WorkspaceTabProps) {
  // Shorten task description for tab
  const shortTitle = worktree.taskDescription.length > 20
    ? worktree.taskDescription.slice(0, 18) + '…'
    : worktree.taskDescription;

  return (
    <button
      className={`
        group relative px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex items-center gap-1.5
        ${isSelected
          ? 'bg-slate-700 text-slate-200'
          : 'text-slate-400 hover:text-slate-300 hover:bg-slate-800'
        }
      `}
      onClick={onSelect}
      title={`${worktree.taskDescription}\n${worktree.branch}`}
    >
      {/* Status indicator */}
      <span className={statusColors[worktree.status]}>
        {statusIcons[worktree.status]}
      </span>

      {/* Tab title */}
      <span>{shortTitle}</span>

      {/* Keyboard shortcut hint */}
      {index <= 9 && (
        <span className="text-xs text-slate-600 ml-1 hidden group-hover:inline">
          ⌃{index}
        </span>
      )}

      {/* Progress indicator for running tasks */}
      {worktree.status === 'running' && worktree.progress !== undefined && (
        <div className="absolute bottom-0 left-1 right-1 h-0.5 bg-slate-600 rounded-full overflow-hidden">
          <div
            className="h-full bg-amber-500"
            style={{ width: `${worktree.progress}%` }}
          />
        </div>
      )}
    </button>
  );
}

export default WorkspaceTabs;
