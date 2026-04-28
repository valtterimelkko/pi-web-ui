import { useState, useEffect, useRef } from 'react';
import {
  Info,
  AlertTriangle,
  Check,
  X,
  Loader2,
  Folder,
  FolderOpen,
  ChevronRight,
  ArrowUp,
  History,
  Star,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useTransferStore, type TransferScope } from '../../store/transferStore';
import { useSessionStore } from '../../store';
import { useUIStore } from '../../store/uiStore';
import { useWebSocket } from '../../hooks/useWebSocket';
import { api } from '../../lib/api';

interface TransferConfirmationModalProps {
  onConfirm: () => void;
}

interface DirectoryItem {
  name: string;
  path: string;
}

const RUNTIME_LABELS: Record<string, string> = {
  pi: 'Pi SDK',
  claude: 'Claude Direct',
  opencode: 'OpenCode Direct',
};

const ERROR_MESSAGES: Record<string, string> = {
  TRANSFER_TARGET_BUSY: 'The target session is currently busy. Please wait for it to become idle.',
  TRANSFER_SOURCE_NOT_FOUND: 'Source session not found.',
  TRANSFER_TARGET_NOT_FOUND: 'Target session not found.',
  TRANSFER_EMPTY_SOURCE: 'Nothing visible to transfer from this session.',
  TRANSFER_SELF_TRANSFER: 'Cannot transfer a session into itself.',
  TRANSFER_RUNTIME_UNAVAILABLE: 'The selected runtime is not available.',
};

function SdkBadge({ sdkType }: { sdkType: string }) {
  const label = RUNTIME_LABELS[sdkType] ?? sdkType;
  const colorMap: Record<string, string> = {
    pi: 'bg-blue-100 text-blue-700',
    claude: 'bg-amber-100 text-amber-700',
    opencode: 'bg-emerald-100 text-emerald-700',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colorMap[sdkType] ?? 'bg-gray-100 text-gray-700'}`}>
      {label}
    </span>
  );
}

function SessionLine({ displayName, sdkType, cwd }: { displayName: string; sdkType: string; cwd: string }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm font-medium text-gray-900">{displayName}</span>
      <span className="text-gray-300">·</span>
      <SdkBadge sdkType={sdkType} />
      <span className="text-gray-300">·</span>
      <span className="text-xs text-gray-500 font-mono truncate max-w-[260px]" title={cwd}>{cwd}</span>
    </div>
  );
}

export function TransferConfirmationModal({ onConfirm }: TransferConfirmationModalProps) {
  const status = useTransferStore((s) => s.status);
  const targetMode = useTransferStore((s) => s.targetMode);
  const source = useTransferStore((s) => s.source);
  const existingTarget = useTransferStore((s) => s.existingTarget);
  const newTargetRuntime = useTransferStore((s) => s.newTargetRuntime);
  const newTargetCwd = useTransferStore((s) => s.newTargetCwd);
  const scope = useTransferStore((s) => s.scope);
  const error = useTransferStore((s) => s.error);
  const cancel = useTransferStore((s) => s.cancel);
  const setScope = useTransferStore((s) => s.setScope);
  const setNewTargetRuntime = useTransferStore((s) => s.setNewTargetRuntime);
  const setNewTargetCwd = useTransferStore((s) => s.setNewTargetCwd);
  const createdSessionId = useTransferStore((s) => s.createdSessionId);

  const claudeAvailable = useSessionStore(s => s.claudeAvailable);
  const claudeAuthError = useSessionStore(s => s.claudeAuthError);
  const opencodeAvailable = useSessionStore(s => s.opencodeAvailable);
  const opencodeAuthError = useSessionStore(s => s.opencodeAuthError);
  const localSwitchSession = useSessionStore((s) => s.switchSession);
  const { switchSession: wsSwitchSession } = useWebSocket();
  const recentFolders = useUIStore((s) => s.recentFolders);
  const getRecentFolders = useUIStore((s) => s.getRecentFolders);

  const topRecentFolders = getRecentFolders(8);

  const [showRecentFolders, setShowRecentFolders] = useState(true);
  const [pathInput, setPathInput] = useState(newTargetCwd);
  const [browseDirectories, setBrowseDirectories] = useState<DirectoryItem[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseParentPath, setBrowseParentPath] = useState<string | null>(null);
  const recentDropdownRef = useRef<HTMLDivElement>(null);

  const isSubmitting = status === 'submitting';
  const isSucceeded = status === 'succeeded';
  const isOpen = status === 'confirming' || isSubmitting || isSucceeded || status === 'failed';

  useEffect(() => {
    setPathInput(newTargetCwd);
  }, [newTargetCwd]);

  useEffect(() => {
    if (isOpen && targetMode === 'new') {
      fetchDirectories(newTargetCwd || '/root');
      setShowRecentFolders(true);
    }
  }, [isOpen, targetMode]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) cancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, isSubmitting, cancel]);

  const fetchDirectories = async (path: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const response = await api.get(`/api/files/browse?path=${encodeURIComponent(path)}`) as {
        path: string;
        parent: string | null;
        items: Array<{ name: string; type: string; path: string }>;
      };
      const dirs = (response.items || [])
        .filter((entry) => entry.type === 'directory')
        .map((entry) => ({ name: entry.name, path: entry.path }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setBrowseDirectories(dirs);
      setBrowseParentPath(response.parent);
      const resolved = response.path || path;
      setNewTargetCwd(resolved);
      setPathInput(resolved);
    } catch (err) {
      console.error('Failed to fetch directories:', err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setBrowseError(`Access denied or path not found. (${errorMsg})`);
      setBrowseDirectories([]);
    } finally {
      setBrowseLoading(false);
    }
  };

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) fetchDirectories(pathInput.trim());
  };

  const handleNavigateUp = () => {
    if (browseParentPath) fetchDirectories(browseParentPath);
  };

  const handleRecentFolderSelect = (path: string) => {
    fetchDirectories(path);
  };

  const cwdMismatch = source
    ? targetMode === 'existing'
      ? source.cwd !== existingTarget?.cwd
      : source.cwd !== newTargetCwd
    : false;

  const confirmDisabled = isSubmitting || isSucceeded || (targetMode === 'new' && !newTargetCwd.trim());

  if (!isOpen) return null;

  const friendlyError = error
    ? ERROR_MESSAGES[error.code] ?? error.message
    : null;

  const statusText = () => {
    if (isSubmitting) return 'Transferring...';
    if (isSucceeded) return 'Transfer complete';
    if (status === 'failed') return 'Transfer failed';
    return 'Ready to transfer';
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl border border-gray-200 shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Transfer Visible Context</h2>
            <p className="text-sm text-gray-500">Hand off visible conversation to another session</p>
          </div>
          <button
            onClick={() => !isSubmitting && cancel()}
            disabled={isSubmitting}
            className={`p-2 rounded-lg transition-colors ${isSubmitting ? 'cursor-not-allowed' : 'hover:bg-gray-100'}`}
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Block A — Source */}
          {source && (
            <div className="px-4 py-3 border-b border-gray-200">
              <p className="text-xs font-medium text-gray-500 mb-1.5">Source</p>
              <SessionLine displayName={source.displayName} sdkType={source.sdkType} cwd={source.cwd} />
            </div>
          )}

          {/* Block B — Target (existing) */}
          {targetMode === 'existing' && existingTarget && (
            <div className="px-4 py-3 border-b border-gray-200">
              <p className="text-xs font-medium text-gray-500 mb-1.5">Target</p>
              <SessionLine
                displayName={existingTarget.displayName ?? 'Unknown'}
                sdkType={existingTarget.sdkType ?? 'pi'}
                cwd={existingTarget.cwd ?? ''}
              />
            </div>
          )}

          {/* Block B — Target (new) */}
          {targetMode === 'new' && (
            <div className="border-b border-gray-200">
              <div className="px-4 pt-3 pb-2">
                <p className="text-xs font-medium text-gray-500 mb-1.5">Target — New Session</p>

                {/* Runtime Selector */}
                <p className="text-xs font-medium text-gray-500 mb-1.5">Runtime</p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setNewTargetRuntime('pi')}
                    className={`flex flex-col items-start p-2 sm:p-3 rounded-lg border text-left transition-colors ${
                      newTargetRuntime === 'pi'
                        ? 'border-blue-500 bg-blue-50 text-gray-900'
                        : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-sm font-medium">Pi SDK</span>
                    <span className="text-xs text-gray-500 mt-0.5">All providers</span>
                  </button>

                  <button
                    onClick={() => claudeAvailable && setNewTargetRuntime('claude')}
                    disabled={!claudeAvailable}
                    title={claudeAuthError || undefined}
                    className={`flex flex-col items-start p-2 sm:p-3 rounded-lg border text-left transition-colors ${
                      !claudeAvailable
                        ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                        : newTargetRuntime === 'claude'
                        ? 'border-amber-500 bg-amber-50 text-gray-900'
                        : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-sm font-medium">Claude Direct</span>
                    <span className="text-xs text-gray-500 mt-0.5">
                      {claudeAvailable ? 'Subscription' : (claudeAuthError || 'Not available')}
                    </span>
                  </button>

                  <button
                    onClick={() => opencodeAvailable && setNewTargetRuntime('opencode')}
                    disabled={!opencodeAvailable}
                    title={opencodeAuthError || undefined}
                    className={`flex flex-col items-start p-2 sm:p-3 rounded-lg border text-left transition-colors ${
                      !opencodeAvailable
                        ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                        : newTargetRuntime === 'opencode'
                        ? 'border-emerald-500 bg-emerald-50 text-gray-900'
                        : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-sm font-medium">OpenCode Direct</span>
                    <span className="text-xs text-gray-500 mt-0.5">
                      {opencodeAvailable ? 'Z.AI GLM' : (opencodeAuthError || 'Not available')}
                    </span>
                  </button>
                </div>
              </div>

              {/* CWD Input */}
              <div className="px-4 py-3 border-t border-gray-100">
                <p className="text-xs font-medium text-gray-500 mb-1.5">Workspace</p>
                <form onSubmit={handlePathSubmit} className="flex gap-2">
                  <input
                    type="text"
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    placeholder="/path/to/project"
                    className="flex-1 px-3 py-2 bg-gray-50 rounded-lg text-sm text-gray-900 placeholder-gray-400 border border-gray-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm text-gray-700 transition-colors border border-gray-200"
                  >
                    Go
                  </button>
                </form>
              </div>

              {/* Recent Projects */}
              {recentFolders.length > 0 && (
                <div className="border-t border-gray-100" ref={recentDropdownRef}>
                  <button
                    onClick={() => setShowRecentFolders(!showRecentFolders)}
                    className="w-full flex items-center justify-between px-4 py-2 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <History className="w-4 h-4 text-blue-600" />
                      <span className="text-sm font-medium text-gray-700">Recent Projects</span>
                      <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                        {recentFolders.length}
                      </span>
                    </div>
                    {showRecentFolders ? (
                      <ChevronUp className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    )}
                  </button>

                  {showRecentFolders && (
                    <div className="px-4 pb-3">
                      <div className="grid grid-cols-1 gap-1.5">
                        {topRecentFolders.map((folder, index) => (
                          <div
                            key={folder.path}
                            className="group flex items-center gap-2 p-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg cursor-pointer transition-all"
                            onClick={() => handleRecentFolderSelect(folder.path)}
                          >
                            <div className="flex-shrink-0 w-7 h-7 sm:w-8 sm:h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                              {index === 0 ? (
                                <Star className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-600 fill-blue-600" />
                              ) : (
                                <Folder className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-600" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-700 truncate" title={folder.label}>
                                {folder.label}
                              </p>
                              <p className="text-xs text-gray-400 truncate" title={folder.path}>
                                {folder.path}
                              </p>
                            </div>
                            <span className="text-xs text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded hidden sm:inline">
                              {folder.count}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Directory Browser */}
              <div className="border-t border-gray-100 flex flex-col min-h-[80px]">
                <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
                  <Folder className="w-4 h-4 text-blue-600 flex-shrink-0" />
                  {browseParentPath && (
                    <button
                      onClick={handleNavigateUp}
                      className="p-1 hover:bg-gray-200 rounded transition-colors flex-shrink-0"
                      title="Go up"
                    >
                      <ArrowUp className="w-4 h-4 text-gray-400" />
                    </button>
                  )}
                  <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
                  <span className="text-sm text-gray-700 truncate">{newTargetCwd}</span>
                </div>

                <div className="p-2">
                  {browseLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
                    </div>
                  ) : browseError ? (
                    <div className="text-center py-4">
                      <p className="text-red-500 text-sm mb-2">{browseError}</p>
                      <button
                        onClick={() => fetchDirectories('/root')}
                        className="text-blue-600 text-sm hover:underline"
                      >
                        Reset to /root
                      </button>
                    </div>
                  ) : browseDirectories.length === 0 ? (
                    <div className="text-center py-4 text-gray-400 text-sm">
                      No subdirectories found.
                    </div>
                  ) : (
                    <div className="space-y-0.5 max-h-[160px] overflow-y-auto">
                      {browseDirectories.map((dir) => (
                        <div
                          key={dir.path}
                          role="button"
                          tabIndex={0}
                          onClick={() => fetchDirectories(dir.path)}
                          onKeyDown={(e) => e.key === 'Enter' && fetchDirectories(dir.path)}
                          className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-100 active:bg-gray-200 rounded-lg transition-colors cursor-pointer select-none"
                        >
                          <FolderOpen className="w-4 h-4 text-blue-600 flex-shrink-0" />
                          <span className="text-sm text-gray-700 truncate flex-1">{dir.name}</span>
                          <ChevronRight className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Block C — Scope */}
          <div className="px-4 py-3 border-b border-gray-200">
            <p className="text-xs font-medium text-gray-500 mb-2">Transfer Scope</p>
            <div className="space-y-2">
              <label className="flex items-start gap-3 cursor-pointer group">
                <div className="pt-0.5">
                  <input
                    type="radio"
                    name="transfer-scope"
                    checked={scope === 'visible_recent'}
                    onChange={() => setScope('visible_recent')}
                    className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500/20"
                  />
                </div>
                <div>
                  <span className="text-sm font-medium text-gray-900">Recent visible context</span>
                  <p className="text-xs text-gray-500">Lighter handoff for long sessions</p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer group">
                <div className="pt-0.5">
                  <input
                    type="radio"
                    name="transfer-scope"
                    checked={scope === 'visible_full'}
                    onChange={() => setScope('visible_full')}
                    className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500/20"
                  />
                </div>
                <div>
                  <span className="text-sm font-medium text-gray-900">Full visible context</span>
                  <p className="text-xs text-gray-500">Broader handoff for important or shorter sessions</p>
                </div>
              </label>
            </div>
          </div>

          {/* Block D — Info callout */}
          <div className="px-4 py-3 border-b border-gray-200">
            <div className="flex gap-2.5 p-3 bg-gray-50 rounded-lg border border-gray-200">
              <Info className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-gray-600 leading-relaxed">
                Only visible/default-rendered context will be transferred. Hidden reasoning and full tool internals are not included. The target agent will be told to wait for your next instruction.
              </p>
            </div>
          </div>

          {/* Block E — CWD mismatch warning */}
          {cwdMismatch && (
            <div className="px-4 py-3 border-b border-gray-200">
              <div className="flex gap-2.5 p-3 bg-amber-50 rounded-lg border border-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 leading-relaxed">
                  Source and target workspaces differ. The target agent will operate in a different directory.
                </p>
              </div>
            </div>
          )}

          {/* Error display */}
          {friendlyError && (
            <div className="px-4 py-3 border-b border-gray-200">
              <div className="flex gap-2.5 p-3 bg-red-50 rounded-lg border border-red-200">
                <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-red-700 leading-relaxed">{friendlyError}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 p-4 border-t border-gray-200 bg-white flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {isSucceeded ? (
              <>
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                <span className="text-sm text-emerald-600 font-medium">Transfer complete</span>
              </>
            ) : isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 text-gray-400 animate-spin flex-shrink-0" />
                <span className="text-sm text-gray-500">{statusText()}</span>
              </>
            ) : (
              <span className="text-sm text-gray-500">{statusText()}</span>
            )}
          </div>
          <div className="flex gap-2 sm:gap-3 flex-shrink-0">
            <button
              onClick={cancel}
              disabled={isSubmitting}
              className="px-3 sm:px-4 py-2 text-gray-500 hover:text-gray-700 disabled:opacity-50 transition-colors text-sm"
            >
              Cancel
            </button>
            {isSucceeded ? (
              <button
                onClick={() => {
                  const targetId = createdSessionId || (targetMode === 'existing' ? existingTarget?.sessionId : undefined);
                  if (targetId) {
                    const session = useSessionStore.getState().sessions.find(s => s.id === targetId);
                    if (session?.path) {
                      wsSwitchSession(session.path);
                    }
                    localSwitchSession(targetId);
                    cancel();
                  } else {
                    cancel();
                  }
                }}
                className="px-3 sm:px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-lg text-white transition-colors flex items-center gap-2 text-sm"
              >
                <Check className="w-4 h-4" />
                Go to target session
              </button>
            ) : (
              <button
                onClick={onConfirm}
                disabled={confirmDisabled}
                className="px-3 sm:px-4 py-2 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed rounded-lg text-white transition-colors flex items-center gap-2 text-sm"
              >
                {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {isSubmitting ? 'Transferring...' : 'Transfer Visible Context'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
