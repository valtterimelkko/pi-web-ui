/**
 * OrchestrationPage Component
 *
 * Main view for parallel orchestration. Integrates all orchestration components.
 */

import React from 'react';
import { WorkspaceTabs } from './WorkspaceTabs';
import { OrchestrationSidebar } from './OrchestrationSidebar';
import { WorktreeList } from './WorktreeList';
import { PlanPreview } from './PlanPreview';
import { MergePreview } from './MergePreview';
import { useOrchestrationStore, type TaskInfo } from '../../store/orchestrationStore';

interface OrchestrationPageProps {
  onSendMessage?: (sessionId: string | null, message: string) => void;
}

export function OrchestrationPage({ onSendMessage }: OrchestrationPageProps) {
  const activeOrchestration = useOrchestrationStore((s) => s.activeOrchestration);
  const worktrees = useOrchestrationStore((s) => s.worktrees);
  const tasks = useOrchestrationStore((s) => s.tasks);
  const selectedSessionId = useOrchestrationStore((s) => s.selectedSessionId);
  const mergePreview = useOrchestrationStore((s) => s.mergePreview);
  const isLoading = useOrchestrationStore((s) => s.isLoading);

  const setActiveOrchestration = useOrchestrationStore((s) => s.setActiveOrchestration);
  const setSelectedSession = useOrchestrationStore((s) => s.setSelectedSession);
  const clearMergePreview = useOrchestrationStore((s) => s.clearMergePreview);

  // Group tasks for plan preview
  const parallelGroups = tasks.reduce((acc, task) => {
    const group = task.parallelGroup || 0;
    if (!acc[group]) acc[group] = [];
    acc[group].push(task);
    return acc;
  }, [] as TaskInfo[][]);

  // If no active orchestration, show plan selection/creation
  if (!activeOrchestration) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-900">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-4">🎯</div>
          <h2 className="text-xl font-semibold text-slate-200 mb-2">
            Parallel Orchestration
          </h2>
          <p className="text-slate-400 mb-6">
            Run multiple AI agents in parallel using isolated git worktrees.
            Parse a plan file to get started.
          </p>
          <div className="space-y-3">
            <button
              className="w-full px-4 py-3 bg-violet-600 hover:bg-violet-500 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
              onClick={() => {
                // TODO: File picker for plan
                console.log('Select plan file');
              }}
            >
              <span>📄</span>
              Select Plan File
            </button>
            <button
              className="w-full px-4 py-3 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg transition-colors flex items-center justify-center gap-2"
              onClick={() => {
                // TODO: Create new plan
                console.log('Create new plan');
              }}
            >
              <span>✏️</span>
              Create New Plan
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-6">
            Use <code className="bg-slate-800 px-1 rounded">/orchestrate plan.md</code> in Pi CLI
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-slate-900">
      {/* Workspace tabs */}
      <WorkspaceTabs
        onNewWorktree={() => {
          // TODO: Open new worktree dialog
          console.log('New worktree');
        }}
      />

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-80 flex-shrink-0">
          <OrchestrationSidebar
            onStartAll={() => {
              // TODO: Start all pending tasks
              console.log('Start all');
            }}
            onPauseAll={() => {
              // TODO: Pause running tasks
              console.log('Pause all');
            }}
            onMergeReady={() => {
              // TODO: Open merge dialog
              console.log('Merge ready');
            }}
          />
        </div>

        {/* Main area - show selected session or overview */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedSessionId ? (
            // Show session chat view
            <div className="flex-1 flex flex-col">
              <div className="p-4 border-b border-slate-700">
                <h2 className="text-sm font-medium text-slate-200">
                  Session: {selectedSessionId}
                </h2>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {/* TODO: Render session messages */}
                <div className="text-center text-slate-500">
                  Session messages would appear here
                </div>
              </div>
              <div className="p-4 border-t border-slate-700">
                <input
                  type="text"
                  placeholder="Type to intervene in this session..."
                  className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-violet-500"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.currentTarget.value) {
                      onSendMessage?.(selectedSessionId, e.currentTarget.value);
                      e.currentTarget.value = '';
                    }
                  }}
                />
              </div>
            </div>
          ) : (
            // Show worktree list / overview
            <div className="flex-1 overflow-y-auto p-6">
              <h2 className="text-lg font-semibold text-slate-200 mb-4">
                Worktrees
              </h2>
              <WorktreeList
                onSelectWorktree={(worktree) => {
                  if (worktree.sessionId) {
                    setSelectedSession(worktree.sessionId);
                  }
                }}
                onMergeWorktree={(worktreeId) => {
                  // TODO: Open merge preview
                  console.log('Merge worktree:', worktreeId);
                }}
                onDeleteWorktree={(worktreeId) => {
                  // TODO: Delete worktree
                  console.log('Delete worktree:', worktreeId);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Merge preview modal */}
      {mergePreview && (
        <MergePreview
          worktreeId={mergePreview.worktreeId}
          branch=""
          baseBranch="main"
          files={mergePreview.files}
          totalAdditions={mergePreview.files.reduce((sum, f) => sum + f.additions, 0)}
          totalDeletions={mergePreview.files.reduce((sum, f) => sum + f.deletions, 0)}
          commitCount={0}
          hasConflicts={mergePreview.hasConflicts}
          onMerge={(strategy) => {
            // TODO: Execute merge
            console.log('Merge with strategy:', strategy);
            clearMergePreview();
          }}
          onCancel={clearMergePreview}
        />
      )}

      {/* Loading overlay */}
      {isLoading && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-lg p-6 text-center">
            <div className="animate-spin text-4xl mb-4">⏳</div>
            <p className="text-slate-200">Loading...</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default OrchestrationPage;
