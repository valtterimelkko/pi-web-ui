/**
 * ConflictResolution Component
 *
 * UI for resolving merge conflicts with options: ours/theirs/AI/manual.
 */

import React from 'react';

interface Conflict {
  file: string;
  type: 'content' | 'delete/modify' | 'rename';
  oursContent?: string;
  theirsContent?: string;
  baseContent?: string;
}

interface ConflictResolutionProps {
  conflict: Conflict;
  onResolve: (resolution: 'ours' | 'theirs' | 'ai-assist' | 'manual', customContent?: string) => void;
  onSkip?: () => void;
}

export function ConflictResolution({ conflict, onResolve, onSkip }: ConflictResolutionProps) {
  const [selectedResolution, setSelectedResolution] = React.useState<'ours' | 'theirs' | 'ai-assist' | 'manual'>('ai-assist');
  const [customContent, setCustomContent] = React.useState('');
  const [showPreview, setShowPreview] = React.useState(false);

  const resolutions = [
    {
      id: 'ours' as const,
      label: 'Use Base',
      description: 'Keep the version from the base branch',
      icon: '⬆️',
    },
    {
      id: 'theirs' as const,
      label: 'Use Worktree',
      description: 'Keep the version from the worktree branch',
      icon: '⬇️',
    },
    {
      id: 'ai-assist' as const,
      label: 'AI Assist',
      description: 'Let AI intelligently merge both versions',
      icon: '🤖',
    },
    {
      id: 'manual' as const,
      label: 'Manual',
      description: 'Provide custom resolution',
      icon: '✏️',
    },
  ];

  return (
    <div className="bg-slate-900 rounded-lg border border-slate-700 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <span>⚠️</span>
          Conflict: {conflict.file}
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          Type: {conflict.type}
        </p>
      </div>

      {/* Conflict preview */}
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-slate-400">Conflict Preview</span>
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            {showPreview ? 'Hide' : 'Show'} Details
          </button>
        </div>

        {showPreview && (
          <div className="space-y-3">
            {conflict.baseContent && (
              <div>
                <div className="text-xs text-slate-500 mb-1">Base (current):</div>
                <pre className="text-xs bg-slate-800 p-2 rounded overflow-x-auto text-slate-300">
                  {conflict.baseContent.slice(0, 500)}
                  {conflict.baseContent.length > 500 && '...'}
                </pre>
              </div>
            )}
            {conflict.theirsContent && (
              <div>
                <div className="text-xs text-slate-500 mb-1">Worktree (incoming):</div>
                <pre className="text-xs bg-slate-800 p-2 rounded overflow-x-auto text-emerald-300">
                  {conflict.theirsContent.slice(0, 500)}
                  {conflict.theirsContent.length > 500 && '...'}
                </pre>
              </div>
            )}
          </div>
        )}

        {!showPreview && (
          <div className="text-xs text-slate-500 italic">
            Both versions modified this file differently
          </div>
        )}
      </div>

      {/* Resolution options */}
      <div className="p-4">
        <label className="text-sm text-slate-400 mb-2 block">Resolution</label>
        <div className="grid grid-cols-2 gap-2">
          {resolutions.map((resolution) => (
            <button
              key={resolution.id}
              onClick={() => setSelectedResolution(resolution.id)}
              className={`
                p-3 rounded-lg border text-left transition-colors
                ${selectedResolution === resolution.id
                  ? 'border-blue-500 bg-blue-900/30'
                  : 'border-slate-700 hover:border-slate-600'
                }
              `}
            >
              <div className="flex items-center gap-2">
                <span>{resolution.icon}</span>
                <span className="text-sm font-medium text-slate-200">{resolution.label}</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">{resolution.description}</p>
            </button>
          ))}
        </div>

        {/* Manual content input */}
        {selectedResolution === 'manual' && (
          <div className="mt-4">
            <label className="text-xs text-slate-400 mb-1 block">
              Custom Resolution
            </label>
            <textarea
              value={customContent}
              onChange={(e) => setCustomContent(e.target.value)}
              className="w-full h-32 px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm text-slate-200 font-mono resize-none focus:outline-none focus:border-blue-500"
              placeholder="Enter the resolved content..."
            />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-slate-700 flex justify-end gap-2">
        {onSkip && (
          <button
            onClick={onSkip}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            Skip for Now
          </button>
        )}
        <button
          onClick={() => onResolve(selectedResolution, customContent || undefined)}
          disabled={selectedResolution === 'manual' && !customContent}
          className={`
            px-4 py-2 text-sm rounded-md transition-colors flex items-center gap-2
            ${selectedResolution === 'manual' && !customContent
              ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-500 text-white'
            }
          `}
        >
          <span>✓</span>
          Apply Resolution
        </button>
      </div>
    </div>
  );
}

interface ConflictListProps {
  conflicts: Conflict[];
  onResolveAll: (resolutions: Array<{ file: string; resolution: string }>) => void;
  onCancel: () => void;
}

export function ConflictList({ conflicts, onResolveAll, onCancel }: ConflictListProps) {
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [resolutions, setResolutions] = React.useState<Map<string, string>>(new Map());

  const currentConflict = conflicts[currentIndex];
  const progress = resolutions.size;
  const total = conflicts.length;
  const allResolved = progress === total;

  const handleResolve = (resolution: string, customContent?: string) => {
    if (!currentConflict) return;

    const newResolutions = new Map(resolutions);
    newResolutions.set(currentConflict.file, customContent || resolution);
    setResolutions(newResolutions);

    if (currentIndex < conflicts.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const handleSkip = () => {
    if (currentIndex < conflicts.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  if (!currentConflict) {
    return (
      <div className="p-4 text-center text-slate-500">
        No conflicts to resolve
      </div>
    );
  }

  return (
    <div className="bg-slate-900 rounded-lg border border-slate-700 overflow-hidden">
      {/* Progress header */}
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-200">
            Resolving Conflicts
          </h3>
          <span className="text-xs text-slate-400">
            {progress}/{total} resolved
          </span>
        </div>
        <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${(progress / total) * 100}%` }}
          />
        </div>
      </div>

      {/* Current conflict */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs text-slate-500">
            Conflict {currentIndex + 1} of {total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
              disabled={currentIndex === 0}
              className="text-xs text-slate-400 hover:text-slate-200 disabled:text-slate-600"
            >
              ← Previous
            </button>
            <button
              onClick={() => setCurrentIndex(Math.min(conflicts.length - 1, currentIndex + 1))}
              disabled={currentIndex === conflicts.length - 1}
              className="text-xs text-slate-400 hover:text-slate-200 disabled:text-slate-600"
            >
              Next →
            </button>
          </div>
        </div>

        <ConflictResolution
          conflict={currentConflict}
          onResolve={handleResolve}
          onSkip={handleSkip}
        />
      </div>

      {/* Final actions */}
      <div className="p-4 border-t border-slate-700 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            const result = Array.from(resolutions.entries()).map(([file, resolution]) => ({
              file,
              resolution,
            }));
            onResolveAll(result);
          }}
          disabled={!allResolved}
          className={`
            px-4 py-2 text-sm rounded-md transition-colors flex items-center gap-2
            ${allResolved
              ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
              : 'bg-slate-700 text-slate-500 cursor-not-allowed'
            }
          `}
        >
          <span>✓</span>
          Apply All Resolutions
        </button>
      </div>
    </div>
  );
}

export default ConflictResolution;
