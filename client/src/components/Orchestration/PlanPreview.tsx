/**
 * PlanPreview Component
 *
 * Visualizes a parsed plan with parallel groups and task dependencies.
 */

import React from 'react';
import type { TaskInfo } from '../../store/orchestrationStore';

interface PlanPreviewProps {
  title: string;
  description?: string;
  tasks: TaskInfo[];
  parallelGroups: TaskInfo[][];
  onStart?: () => void;
  onCancel?: () => void;
}

export function PlanPreview({
  title,
  description,
  tasks,
  parallelGroups,
  onStart,
  onCancel,
}: PlanPreviewProps) {
  const [selectedTask, setSelectedTask] = React.useState<TaskInfo | null>(null);

  // Count tasks by group
  const groupStats = parallelGroups.map((group) => ({
    total: group.length,
    canParallelize: group.length > 1,
  }));

  const totalParallelizable = groupStats.filter((g) => g.canParallelize).length;
  const estimatedTime = parallelGroups.length * 3; // Rough estimate: 3 min per group

  return (
    <div className="bg-slate-900 rounded-lg border border-slate-700 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <h2 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
          <span>🎯</span>
          Orchestration Setup
        </h2>
        <h3 className="text-sm text-violet-400 mt-1">{title}</h3>
        {description && (
          <p className="text-xs text-slate-400 mt-2">{description}</p>
        )}
      </div>

      {/* Stats */}
      <div className="p-4 border-b border-slate-700 grid grid-cols-3 gap-4 text-center">
        <div>
          <div className="text-2xl font-bold text-slate-200">{tasks.length}</div>
          <div className="text-xs text-slate-500">Tasks</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-violet-400">{parallelGroups.length}</div>
          <div className="text-xs text-slate-500">Groups</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-emerald-400">{totalParallelizable}</div>
          <div className="text-xs text-slate-500">Parallelizable</div>
        </div>
      </div>

      {/* Parallel groups visualization */}
      <div className="p-4 max-h-96 overflow-y-auto">
        {parallelGroups.map((group, groupIndex) => (
          <div key={groupIndex} className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-medium text-slate-400">
                Parallel Group {groupIndex + 1}
              </span>
              {group.length > 1 && (
                <span className="text-xs px-1.5 py-0.5 bg-violet-900/30 text-violet-400 rounded">
                  {group.length} parallel
                </span>
              )}
              {groupIndex > 0 && (
                <span className="text-xs text-slate-500">
                  (depends on group {groupIndex})
                </span>
              )}
            </div>

            <div className="flex gap-2 overflow-x-auto pb-2">
              {group.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  isSelected={selectedTask?.id === task.id}
                  onClick={() => setSelectedTask(selectedTask?.id === task.id ? null : task)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Selected task details */}
      {selectedTask && (
        <div className="p-4 border-t border-slate-700 bg-slate-800/50">
          <div className="flex items-start justify-between">
            <div>
              <h4 className="text-sm font-medium text-slate-200">{selectedTask.title}</h4>
              <p className="text-xs text-slate-400 mt-1 max-w-md">
                {selectedTask.description}
              </p>
              {selectedTask.files.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {selectedTask.files.map((file, i) => (
                    <span key={i} className="text-xs px-1.5 py-0.5 bg-slate-700 text-slate-300 rounded font-mono">
                      {file}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => setSelectedTask(null)}
              className="text-slate-500 hover:text-slate-300"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="p-4 border-t border-slate-700 flex justify-end gap-2">
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
        )}
        {onStart && (
          <button
            onClick={onStart}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-md transition-colors flex items-center gap-2"
          >
            <span>▶</span>
            Start Orchestration
          </button>
        )}
      </div>
    </div>
  );
}

interface TaskCardProps {
  task: TaskInfo;
  isSelected: boolean;
  onClick: () => void;
}

function TaskCard({ task, isSelected, onClick }: TaskCardProps) {
  return (
    <div
      className={`
        flex-shrink-0 w-48 p-3 rounded-lg border cursor-pointer transition-colors
        ${isSelected
          ? 'border-violet-500 bg-violet-900/20'
          : 'border-slate-700 bg-slate-800 hover:border-slate-600'
        }
      `}
      onClick={onClick}
    >
      <h5 className="text-sm font-medium text-slate-200 truncate">{task.title}</h5>
      <p className="text-xs text-slate-500 mt-1 line-clamp-2">{task.description}</p>

      <div className="flex items-center gap-2 mt-2 text-xs text-slate-400">
        {task.files.length > 0 && (
          <span title={`${task.files.length} files`}>
            📄 {task.files.length}
          </span>
        )}
        {task.dependencies.length > 0 && (
          <span title={`${task.dependencies.length} dependencies`}>
            ⛓ {task.dependencies.length}
          </span>
        )}
        {task.agent && (
          <span className="text-violet-400">{task.agent}</span>
        )}
      </div>

      <div className="mt-2">
        <span className={`
          text-xs px-1.5 py-0.5 rounded
          ${task.estimatedComplexity === 'low' ? 'bg-emerald-900/30 text-emerald-400' : ''}
          ${task.estimatedComplexity === 'medium' ? 'bg-amber-900/30 text-amber-400' : ''}
          ${task.estimatedComplexity === 'high' ? 'bg-red-900/30 text-red-400' : ''}
        `}>
          {task.estimatedComplexity}
        </span>
      </div>
    </div>
  );
}

export default PlanPreview;
