/**
 * MergePreview Component
 *
 * Shows diff preview, file list with +/- stats, and merge controls.
 */

import React from 'react';

interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

interface MergePreviewProps {
  worktreeId: string;
  branch: string;
  baseBranch: string;
  files: FileChange[];
  totalAdditions: number;
  totalDeletions: number;
  commitCount: number;
  hasConflicts: boolean;
  conflicts?: Array<{
    file: string;
    type: string;
  }>;
  onMerge: (strategy: 'merge' | 'squash' | 'rebase') => void;
  onCancel: () => void;
  onViewDiff?: (filePath: string) => void;
}

const statusColors: Record<string, string> = {
  added: 'text-emerald-400',
  modified: 'text-amber-400',
  deleted: 'text-red-400',
  renamed: 'text-blue-400',
};

const statusIcons: Record<string, string> = {
  added: '+',
  modified: '~',
  deleted: '-',
  renamed: '→',
};

export function MergePreview({
  worktreeId,
  branch,
  baseBranch,
  files,
  totalAdditions,
  totalDeletions,
  commitCount,
  hasConflicts,
  conflicts = [],
  onMerge,
  onCancel,
  onViewDiff,
}: MergePreviewProps) {
  const [selectedStrategy, setSelectedStrategy] = React.useState<'merge' | 'squash' | 'rebase'>('merge');
  const [selectedFile, setSelectedFile] = React.useState<string | null>(null);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-slate-900 rounded-lg border border-slate-700 w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
              <span>🔀</span>
              Merge Preview
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              {branch} → {baseBranch}
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-slate-500 hover:text-slate-300"
          >
            ✕
          </button>
        </div>

        {/* Stats */}
        <div className="p-4 border-b border-slate-700 grid grid-cols-4 gap-4 text-center">
          <div>
            <div className="text-xl font-bold text-slate-200">{files.length}</div>
            <div className="text-xs text-slate-500">Files</div>
          </div>
          <div>
            <div className="text-xl font-bold text-emerald-400">+{totalAdditions}</div>
            <div className="text-xs text-slate-500">Additions</div>
          </div>
          <div>
            <div className="text-xl font-bold text-red-400">-{totalDeletions}</div>
            <div className="text-xs text-slate-500">Deletions</div>
          </div>
          <div>
            <div className="text-xl font-bold text-blue-400">{commitCount}</div>
            <div className="text-xs text-slate-500">Commits</div>
          </div>
        </div>

        {/* Conflicts warning */}
        {hasConflicts && (
          <div className="p-4 bg-amber-900/20 border-b border-amber-700/50">
            <div className="flex items-center gap-2 text-amber-400">
              <span>⚠️</span>
              <span className="font-medium">Conflicts Detected</span>
            </div>
            <p className="text-sm text-amber-300/70 mt-1">
              {conflicts.length} file{conflicts.length !== 1 ? 's' : ''} will need manual resolution
            </p>
            {conflicts.length > 0 && (
              <div className="mt-2 text-xs font-mono text-amber-300/50">
                {conflicts.slice(0, 3).map((c) => c.file).join(', ')}
                {conflicts.length > 3 && ` +${conflicts.length - 3} more`}
              </div>
            )}
          </div>
        )}

        {/* File list */}
        <div className="flex-1 overflow-y-auto p-4">
          <h3 className="text-sm font-medium text-slate-300 mb-2">Changes to merge</h3>
          <div className="space-y-1">
            {files.map((file) => (
              <div
                key={file.path}
                className={`
                  flex items-center justify-between p-2 rounded cursor-pointer transition-colors
                  ${selectedFile === file.path
                    ? 'bg-slate-700'
                    : 'hover:bg-slate-800'
                  }
                `}
                onClick={() => {
                  setSelectedFile(file.path);
                  onViewDiff?.(file.path);
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={statusColors[file.status]}>
                    {statusIcons[file.status]}
                  </span>
                  <span className="text-sm text-slate-200 font-mono truncate">
                    {file.path}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs flex-shrink-0">
                  {file.additions > 0 && (
                    <span className="text-emerald-400">+{file.additions}</span>
                  )}
                  {file.deletions > 0 && (
                    <span className="text-red-400">-{file.deletions}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Strategy selection */}
        <div className="p-4 border-t border-slate-700">
          <label className="text-sm text-slate-400 mb-2 block">Merge Strategy</label>
          <div className="flex gap-2">
            {(['merge', 'squash', 'rebase'] as const).map((strategy) => (
              <button
                key={strategy}
                onClick={() => setSelectedStrategy(strategy)}
                className={`
                  flex-1 px-3 py-2 text-sm rounded-md border transition-colors
                  ${selectedStrategy === strategy
                    ? 'border-blue-500 bg-blue-900/30 text-blue-300'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                  }
                `}
              >
                {strategy.charAt(0).toUpperCase() + strategy.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-slate-700 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onMerge(selectedStrategy)}
            className={`
              px-4 py-2 text-sm rounded-md transition-colors flex items-center gap-2
              ${hasConflicts
                ? 'bg-amber-600 hover:bg-amber-500 text-white'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
              }
            `}
          >
            {hasConflicts ? (
              <>
                <span>⚠️</span>
                Merge with Conflicts
              </>
            ) : (
              <>
                <span>🔀</span>
                Merge
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default MergePreview;
