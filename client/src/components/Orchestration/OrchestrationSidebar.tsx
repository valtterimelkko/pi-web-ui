/**
 * OrchestrationSidebar Component
 *
 * Sidebar showing task tree, progress bars, and control buttons.
 */

import React from 'react';
import { useOrchestrationStore, type TaskInfo } from '../../store/orchestrationStore';

interface OrchestrationSidebarProps {
  onStartAll?: () => void;
  onPauseAll?: () => void;
  onMergeReady?: () => void;
}

const statusColors: Record<TaskInfo['status'], string> = {
  pending: 'text-slate-400 border-slate-600',
  running: 'text-amber-400 border-amber-500',
  completed: 'text-emerald-400 border-emerald-500',
  error: 'text-red-400 border-red-500',
  merged: 'text-blue-400 border-blue-500',
};

const statusBgColors: Record<TaskInfo['status'], string> = {
  pending: 'bg-slate-800',
  running: 'bg-amber-900/20',
  completed: 'bg-emerald-900/20',
  error: 'bg-red-900/20',
  merged: 'bg-blue-900/20',
};

const statusIcons: Record<TaskInfo['status'], string> = {
  pending: '○',
  running: '◉',
  completed: '✓',
  error: '✗',
  merged: '◈',
};

export function OrchestrationSidebar({ onStartAll, onPauseAll, onMergeReady }: OrchestrationSidebarProps) {
  const activeOrchestration = useOrchestrationStore((s) => s.activeOrchestration);
  const tasks = useOrchestrationStore((s) => s.tasks);
  const summary = useOrchestrationStore((s) => s.getSummary());
  const updateTaskStatus = useOrchestrationStore((s) => s.updateTaskStatus);

  if (!activeOrchestration) {
    return (
      <div className="p-4 text-center text-slate-500">
        <p className="text-2xl mb-2">🎯</p>
        <p>No active orchestration</p>
        <p className="text-sm mt-1">Use /orchestrate to start</p>
      </div>
    );
  }

  // Group tasks by parallel group
  const groups = tasks.reduce((acc, task) => {
    const group = task.parallelGroup || 0;
    if (!acc[group]) acc[group] = [];
    acc[group].push(task);
    return acc;
  }, {} as Record<number, TaskInfo[]>);

  const allCompleted = summary.running === 0 && summary.pending === 0 && summary.total > 0;
  const hasRunning = summary.running > 0;

  return (
    <div className="h-full flex flex-col bg-slate-900 border-r border-slate-700">
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <span>📋</span>
          {activeOrchestration.planTitle}
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          Group {activeOrchestration.currentGroup + 1} of {activeOrchestration.totalGroups}
        </p>
      </div>

      {/* Progress summary */}
      <div className="p-4 border-b border-slate-700">
        <div className="flex justify-between text-xs text-slate-400 mb-2">
          <span>Progress</span>
          <span>{summary.completed}/{summary.total} completed</span>
        </div>
        <div className="h-2 bg-slate-700 rounded-full overflow-hidden flex">
          {summary.completed > 0 && (
            <div
              className="bg-emerald-500"
              style={{ width: `${(summary.completed / summary.total) * 100}%` }}
            />
          )}
          {summary.running > 0 && (
            <div
              className="bg-amber-500"
              style={{ width: `${(summary.running / summary.total) * 100}%` }}
            />
          )}
          {summary.error > 0 && (
            <div
              className="bg-red-500"
              style={{ width: `${(summary.error / summary.total) * 100}%` }}
            />
          )}
        </div>
        <div className="flex gap-3 mt-2 text-xs">
          {summary.running > 0 && (
            <span className="text-amber-400">◉ {summary.running} running</span>
          )}
          {summary.completed > 0 && (
            <span className="text-emerald-400">✓ {summary.completed} done</span>
          )}
          {summary.error > 0 && (
            <span className="text-red-400">✗ {summary.error} failed</span>
          )}
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-2">
        {Object.entries(groups).map(([groupIndex, groupTasks]) => (
          <div key={groupIndex} className="mb-4">
            <div className="text-xs text-slate-500 px-2 py-1">
              Parallel Group {parseInt(groupIndex) + 1}
            </div>
            <div className="space-y-1">
              {groupTasks.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Control buttons */}
      <div className="p-4 border-t border-slate-700 space-y-2">
        {!hasRunning && !allCompleted && (
          <button
            onClick={onStartAll}
            className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-md transition-colors flex items-center justify-center gap-2"
          >
            <span>▶</span>
            Start All
          </button>
        )}

        {hasRunning && (
          <button
            onClick={onPauseAll}
            className="w-full px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded-md transition-colors flex items-center justify-center gap-2"
          >
            <span>⏸</span>
            Pause
          </button>
        )}

        {allCompleted && (
          <button
            onClick={onMergeReady}
            className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-md transition-colors flex items-center justify-center gap-2"
          >
            <span>🔀</span>
            Merge Ready ({summary.completed})
          </button>
        )}
      </div>
    </div>
  );
}

interface TaskCardProps {
  task: TaskInfo;
}

function TaskCard({ task }: TaskCardProps) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div
      className={`
        rounded-lg border transition-colors cursor-pointer
        ${statusBgColors[task.status]}
        ${statusColors[task.status].split(' ')[1]}
      `}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="p-2 flex items-start gap-2">
        <span className={statusColors[task.status].split(' ')[0]}>
          {statusIcons[task.status]}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-slate-200 truncate">{task.title}</div>
          {task.agent && (
            <div className="text-xs text-slate-500">Agent: {task.agent}</div>
          )}
        </div>
        {task.status === 'running' && task.progress > 0 && (
          <div className="text-xs text-amber-400">{task.progress}%</div>
        )}
      </div>

      {/* Progress bar for running tasks */}
      {task.status === 'running' && (
        <div className="px-2 pb-2">
          <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-500 transition-all"
              style={{ width: `${task.progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="px-2 pb-2 text-xs text-slate-400 border-t border-slate-700/50">
          <div className="pt-2">
            {task.description.slice(0, 200)}
            {task.description.length > 200 && '...'}
          </div>
          {task.files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {task.files.slice(0, 5).map((file, i) => (
                <span key={i} className="px-1 py-0.5 bg-slate-700 rounded text-slate-300 font-mono">
                  {file}
                </span>
              ))}
              {task.files.length > 5 && (
                <span className="text-slate-500">+{task.files.length - 5} more</span>
              )}
            </div>
          )}
          {task.dependencies.length > 0 && (
            <div className="mt-2 text-slate-500">
              Depends on: {task.dependencies.join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default OrchestrationSidebar;
