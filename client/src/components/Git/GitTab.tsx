import { useEffect, useCallback } from 'react';
import { RefreshCw, GitBranch as GitBranchIcon, AlertCircle } from 'lucide-react';
import { useGitStore } from '../../store/gitStore';
import { useSessionStore } from '../../store/sessionStore';
import { GitChanges } from './GitChanges';
import { GitDiffViewer } from './GitDiffViewer';
import { GitCommitForm } from './GitCommitForm';
import { GitLog } from './GitLog';
import { GitBranchSelector } from './GitBranchSelector';

export function GitTab() {
  const { status, branches, log, diff, isLoading, error, selectedFile, cwd } = useGitStore();
  const { fetchDiff, stage, unstage, discard, commit, push, pull, checkout, setSelectedFile, setCwd, refresh } = useGitStore();

  // Get session CWD
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const session = sessions.find((s) => s.id === currentSessionId);
  const sessionCwd = session?.cwd || '/root/pi-web-ui';

  useEffect(() => {
    if (sessionCwd !== cwd) {
      setCwd(sessionCwd);
    }
    refresh(sessionCwd);

    // Auto-refresh every 10s
    const interval = setInterval(() => refresh(sessionCwd), 10000);
    return () => clearInterval(interval);
  }, [sessionCwd]);

  const handleSelectFile = useCallback(async (path: string, staged: boolean) => {
    setSelectedFile(path);
    await fetchDiff(sessionCwd, staged, path);
  }, [sessionCwd, fetchDiff, setSelectedFile]);

  const handleCheckout = useCallback(async (branch: string) => {
    await checkout(sessionCwd, branch);
  }, [sessionCwd, checkout]);

  if (status && !status.isRepo) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <GitBranchIcon size={48} className="text-gray-300 dark:text-gray-600 mb-4" />
        <h3 className="text-lg font-semibold text-gray-600 dark:text-gray-400 mb-2">Not a git repository</h3>
        <p className="text-sm text-gray-400 dark:text-gray-500">{sessionCwd}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
        <GitBranchSelector
          current={branches.current || status?.branch || ''}
          branches={branches.list}
          onCheckout={handleCheckout}
        />
        <div className="flex items-center gap-2">
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="text-xs text-gray-400">
              ↑{status.ahead} ↓{status.behind}
            </span>
          )}
          <button
            onClick={() => refresh(sessionCwd)}
            disabled={isLoading}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-950 border-b border-red-200 dark:border-red-800 flex-shrink-0">
          <AlertCircle size={12} className="text-red-500" />
          <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
        </div>
      )}

      {/* Main content: split view */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Left: changes + commit form */}
        <div className="w-full md:w-64 flex-shrink-0 flex flex-col border-b md:border-b-0 md:border-r border-gray-200 dark:border-gray-800 overflow-y-auto">
          <GitChanges
            staged={status?.staged || []}
            unstaged={status?.unstaged || []}
            untracked={status?.untracked || []}
            onStage={(path) => stage(sessionCwd, [path])}
            onUnstage={(path) => unstage(sessionCwd, [path])}
            onDiscard={(path) => discard(sessionCwd, [path])}
            onSelectFile={handleSelectFile}
            selectedFile={selectedFile}
          />
          <GitCommitForm
            onCommit={(msg) => commit(sessionCwd, msg)}
            onPush={() => push(sessionCwd)}
            onPull={() => pull(sessionCwd)}
            isLoading={isLoading}
            ahead={status?.ahead || 0}
            behind={status?.behind || 0}
          />
        </div>

        {/* Right: diff or log */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedFile ? (
            <GitDiffViewer diff={diff} />
          ) : (
            <div className="flex-1 overflow-y-auto">
              <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Recent Commits
                </h3>
              </div>
              <GitLog entries={log} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
