import { Plus, Minus, RotateCcw } from 'lucide-react';

interface FileStatus {
  path: string;
  staged: boolean;
  status: string;
}

interface GitChangesProps {
  staged: FileStatus[];
  unstaged: FileStatus[];
  untracked: FileStatus[];
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onDiscard: (path: string) => void;
  onSelectFile: (path: string, staged: boolean) => void;
  selectedFile: string | null;
}

export function GitChanges({
  staged, unstaged, untracked, onStage, onUnstage, onDiscard, onSelectFile, selectedFile,
}: GitChangesProps) {
  return (
    <div className="space-y-3">
      {/* Staged Changes */}
      {staged.length > 0 && (
        <div>
          <div className="flex items-center justify-between px-3 py-1.5">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Staged ({staged.length})
            </h3>
          </div>
          {staged.map((file) => (
            <div
              key={`staged-${file.path}`}
              className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 ${selectedFile === file.path ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
              onClick={() => onSelectFile(file.path, true)}
            >
              <span className="text-xs font-mono text-green-600 dark:text-green-400 w-4">
                {file.status}
              </span>
              <span className="text-xs text-gray-700 dark:text-gray-300 flex-1 truncate">
                {file.path}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); onUnstage(file.path); }}
                className="p-0.5 text-gray-400 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                title="Unstage"
              >
                <Minus size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Unstaged Changes */}
      {(unstaged.length > 0 || untracked.length > 0) && (
        <div>
          <div className="flex items-center justify-between px-3 py-1.5">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Changes ({unstaged.length + untracked.length})
            </h3>
            {unstaged.length + untracked.length > 0 && (
              <button
                onClick={() => unstaged.concat(untracked).forEach(f => onStage(f.path))}
                className="text-xs text-blue-500 hover:text-blue-600"
              >
                Stage all
              </button>
            )}
          </div>
          {[...unstaged, ...untracked].map((file) => (
            <div
              key={`unstaged-${file.path}`}
              className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 ${selectedFile === file.path ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
              onClick={() => onSelectFile(file.path, false)}
            >
              <span className="text-xs font-mono text-orange-500 dark:text-orange-400 w-4">
                {file.status}
              </span>
              <span className="text-xs text-gray-700 dark:text-gray-300 flex-1 truncate">
                {file.path}
              </span>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100">
                <button
                  onClick={(e) => { e.stopPropagation(); onStage(file.path); }}
                  className="p-0.5 text-gray-400 hover:text-green-500 transition-colors"
                  title="Stage"
                >
                  <Plus size={12} />
                </button>
                {file.status !== '?' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onDiscard(file.path); }}
                    className="p-0.5 text-gray-400 hover:text-red-500 transition-colors"
                    title="Discard"
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && (
        <div className="px-3 py-4 text-center text-xs text-gray-400 dark:text-gray-500">
          No changes
        </div>
      )}
    </div>
  );
}
