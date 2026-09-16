import { X, Info, FileText, Coins, Activity, MessageSquare, Cpu, FolderOpen, RefreshCw, Box } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSessionStore } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';

interface SessionInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SessionInfoModal({ isOpen, onClose }: SessionInfoModalProps) {
  const sessionInfo = useSessionStore((state) => state.sessionInfo);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSessionSdkType = useSessionStore((state) => state.currentSessionSdkType);
  const sessionData = useSessionStore((state) => state.sessionData);
  const isClaudeSession = currentSessionSdkType === 'claude';
  const isOpencodeSession = currentSessionSdkType === 'opencode';
  const isCommandCodeSession = currentSessionSdkType === 'commandcode';
  const isAntigravitySession = currentSessionSdkType === 'antigravity';
  const quotaInfo = currentSessionId ? sessionData[currentSessionId]?.quotaInfo : null;
  const { getSessionInfo } = useWebSocket();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsLoading(true);
      setError(null);
      
      // Request session info with timeout
      const timeoutId = setTimeout(() => {
        setIsLoading(false);
        setError('Request timed out. Please try again.');
      }, 5000);
      
      try {
        getSessionInfo();
      } catch {
        setError('Failed to load session info');
      }
      
      // Clear loading state when sessionInfo arrives
      return () => clearTimeout(timeoutId);
    }
  }, [isOpen, getSessionInfo]);

  // Update loading state when sessionInfo changes
  useEffect(() => {
    if (sessionInfo) {
      setIsLoading(false);
      setError(null);
    }
  }, [sessionInfo]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const formatNumber = (num: number) => num.toLocaleString();
  const formatCost = (cost: number) => `$${cost.toFixed(4)}`;
  // Runtimes without usage data (legacy Command Code records) must render
  // zeros instead of crashing on undefined tokens/cost.
  const tokens = sessionInfo?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  const formatTimeAgo = (timestampMs: number): string => {
    const diff = Date.now() - timestampMs;
    if (diff < 0) return 'just now';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hours = Math.floor(min / 60);
    return `${hours}h ${min % 60}m ago`;
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50 animate-in fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface dark:bg-surface-dark rounded-2xl border border-outline-default dark:border-outline-default-dark shadow-2xl w-full max-w-md mx-4 animate-in zoom-in-95 text-content-primary dark:text-content-primary-dark overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-outline-default dark:border-outline-default-dark">
          <div className="flex items-center gap-3">
            <Info className="w-5 h-5 text-pi-primary" strokeWidth={1.75} />
            <h2 className="text-base font-semibold text-content-primary dark:text-content-primary-dark">Session Info</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle rounded-lg transition-colors text-content-muted dark:text-content-muted-dark hover:text-content-primary"
          >
            <X className="w-5 h-5" strokeWidth={1.75} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
          {isLoading || !sessionInfo ? (
            <div className="text-center py-8 text-content-muted dark:text-content-muted-dark">
              {error ? (
                <>
                  <Activity className="w-8 h-8 mx-auto mb-2 text-red-500" />
                  <p className="text-red-500 text-sm mb-3">{error}</p>
                  <button
                    onClick={() => {
                      setIsLoading(true);
                      setError(null);
                      try {
                        getSessionInfo();
                        // Set timeout again
                        setTimeout(() => {
                          if (!sessionInfo) {
                            setIsLoading(false);
                            setError('Request timed out. Please try again.');
                          }
                        }, 5000);
                      } catch {
                        setError('Failed to load session info');
                        setIsLoading(false);
                      }
                    }}
                    className="px-4 py-2 bg-pi-primary hover:bg-pi-hover text-white text-sm rounded-lg transition-colors flex items-center gap-2 mx-auto"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Retry
                  </button>
                </>
              ) : (
                <>
                  <Activity className="w-8 h-8 mx-auto mb-2 animate-pulse" />
                  Loading session info...
                </>
              )}
            </div>
          ) : (
            <>
              {/* Working Directory */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                  <FolderOpen className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                  <span>Working Directory</span>
                </div>
                <p className="text-xs text-content-primary dark:text-content-primary-dark bg-surface-subtle dark:bg-surface-dark-subtle border border-outline-subtle dark:border-outline-subtle-dark p-2 rounded-lg break-all font-mono">
                  {sessionInfo.cwd || 'N/A'}
                </p>
              </div>

              {/* Session File */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                  <FileText className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                  <span>Session File</span>
                </div>
                <p className="text-xs text-content-primary dark:text-content-primary-dark bg-surface-subtle dark:bg-surface-dark-subtle border border-outline-subtle dark:border-outline-subtle-dark p-2 rounded-lg break-all font-mono">
                  {sessionInfo.sessionFile || 'N/A'}
                </p>
              </div>

              {/* Native Session ID (Command Code: the CLI's own session id) */}
              {sessionInfo.nativeSessionId && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                    <Box className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                    <span>Native Session ID</span>
                  </div>
                  <p className="text-xs text-content-primary dark:text-content-primary-dark bg-surface-subtle dark:bg-surface-dark-subtle border border-outline-subtle dark:border-outline-subtle-dark p-2 rounded-lg break-all font-mono">
                    {sessionInfo.nativeSessionId}
                  </p>
                </div>
              )}

              {/* Session Type */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                  <Box className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                  <span>Session Type</span>
                </div>
                <div className="pl-5">
                  {isClaudeSession ? (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-xs font-medium bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                        CC
                      </span>
                      <span className="text-sm text-content-primary dark:text-content-primary-dark">Claude Direct</span>
                      <span className="text-xs text-content-muted dark:text-content-muted-dark">(Claude Code CLI)</span>
                    </div>
                  ) : isOpencodeSession ? (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                        OC
                      </span>
                      <span className="text-sm text-content-primary dark:text-content-primary-dark">OpenCode Direct</span>
                      <span className="text-xs text-content-muted dark:text-content-muted-dark">(OpenCode + Z.AI GLM)</span>
                    </div>
                  ) : isCommandCodeSession ? (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-xs font-medium bg-slate-500/10 text-slate-700 dark:text-slate-300 border border-slate-500/20">
                        CMD
                      </span>
                      <span className="text-sm text-content-primary dark:text-content-primary-dark">Command Code</span>
                      <span className="text-xs text-content-muted dark:text-content-muted-dark">(cmdc CLI)</span>
                    </div>
                  ) : isAntigravitySession ? (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-xs font-medium bg-sky-500/10 text-sky-700 dark:text-sky-400 border border-sky-500/20">
                        AG
                      </span>
                      <span className="text-sm text-content-primary dark:text-content-primary-dark">Antigravity</span>
                      <span className="text-xs text-content-muted dark:text-content-muted-dark">(agy CLI · stream-json)</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-xs font-medium bg-violet-500/10 text-violet-700 dark:text-violet-400 border border-violet-500/20">
                        π
                      </span>
                      <span className="text-sm text-content-primary dark:text-content-primary-dark">Pi SDK</span>
                      <span className="text-xs text-content-muted dark:text-content-muted-dark">(Full extensions & providers)</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Last Activity (Claude sessions) */}
              {isClaudeSession && sessionInfo.lastActivityAt != null && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                    <Activity className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                    <span>Last Activity</span>
                  </div>
                  <p className="text-sm text-content-primary dark:text-content-primary-dark pl-5">
                    {sessionInfo.lastActivityAt > 0
                      ? formatTimeAgo(sessionInfo.lastActivityAt)
                      : 'No PTY activity yet'}
                  </p>
                </div>
              )}

              {/* Model */}
              {sessionInfo.model && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                    <Cpu className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                    <span>Model</span>
                  </div>
                  <p className="text-sm text-content-primary dark:text-content-primary-dark pl-5 font-mono text-xs">
                    {sessionInfo.model}
                  </p>
                </div>
              )}

              {/* Context Usage */}
              {sessionInfo.contextPercent !== undefined && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                    <Activity className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                    <span>Context Window</span>
                  </div>
                  <div className="pl-5">
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="flex-1 h-2 bg-surface-subtle dark:bg-surface-dark-subtle border border-outline-subtle dark:border-outline-subtle-dark rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            sessionInfo.contextPercent > 90 ? 'bg-red-500' :
                            sessionInfo.contextPercent > 70 ? 'bg-amber-500' : 'bg-pi-primary'
                          }`}
                          style={{ width: `${Math.min(sessionInfo.contextPercent, 100)}%` }}
                        />
                      </div>
                      <span className={`text-xs font-semibold ${
                        sessionInfo.contextPercent > 90 ? 'text-red-500' :
                        sessionInfo.contextPercent > 70 ? 'text-amber-500' : 'text-content-primary dark:text-content-primary-dark'
                      }`}>
                        {sessionInfo.contextUsageEstimated ? '~' : ''}{sessionInfo.contextPercent}%
                      </span>
                    </div>
                    <p className="text-xs text-content-muted dark:text-content-muted-dark">
                      {sessionInfo.contextUsageEstimated ? '~' : ''}{formatNumber(sessionInfo.contextUsed || 0)} / {formatNumber(sessionInfo.contextWindow || 0)} tokens{sessionInfo.contextUsageEstimated ? ' (estimated until the next response)' : ''}
                    </p>
                  </div>
                </div>
              )}

              {/* Token Usage */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                  <Activity className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                  <span>Token Usage</span>
                </div>
                <div className="pl-5 grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-content-muted dark:text-content-muted-dark">Input:</span>
                    <span className="text-content-secondary dark:text-content-secondary-dark font-mono">{formatNumber(tokens.input)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-content-muted dark:text-content-muted-dark">Output:</span>
                    <span className="text-content-secondary dark:text-content-secondary-dark font-mono">{formatNumber(tokens.output)}</span>
                  </div>
                  {tokens.cacheRead > 0 && (
                    <div className="flex justify-between">
                      <span className="text-content-muted dark:text-content-muted-dark">Cache Read:</span>
                      <span className="text-content-secondary dark:text-content-secondary-dark font-mono">{formatNumber(tokens.cacheRead)}</span>
                    </div>
                  )}
                  {tokens.cacheWrite > 0 && (
                    <div className="flex justify-between">
                      <span className="text-content-muted dark:text-content-muted-dark">Cache Write:</span>
                      <span className="text-content-secondary dark:text-content-secondary-dark font-mono">{formatNumber(tokens.cacheWrite)}</span>
                    </div>
                  )}
                  <div className="flex justify-between col-span-2 pt-1.5 border-t border-outline-subtle dark:border-outline-subtle-dark">
                    <span className="text-content-secondary dark:text-content-secondary-dark font-medium">Total:</span>
                    <span className="text-content-primary dark:text-content-primary-dark font-mono font-medium">{formatNumber(tokens.total)}</span>
                  </div>
                </div>
              </div>

              {/* Cost (runtimes without cost data omit this section) */}
              {sessionInfo.cost !== undefined && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                    <Coins className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                    <span>Estimated Cost</span>
                  </div>
                  <p className="text-sm font-medium text-content-primary dark:text-content-primary-dark pl-5 font-mono">
                    {formatCost(sessionInfo.cost)}
                  </p>
                </div>
              )}

              {/* Message Count */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                  <MessageSquare className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                  <span>Messages</span>
                </div>
                <div className="pl-5 grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-content-muted dark:text-content-muted-dark">User:</span>
                    <span className="text-content-secondary dark:text-content-secondary-dark font-mono">{sessionInfo.userMessages}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-content-muted dark:text-content-muted-dark">Assistant:</span>
                    <span className="text-content-secondary dark:text-content-secondary-dark font-mono">{sessionInfo.assistantMessages}</span>
                  </div>
                  {sessionInfo.toolCalls > 0 && (
                    <div className="flex justify-between">
                      <span className="text-content-muted dark:text-content-muted-dark">Tool Calls:</span>
                      <span className="text-content-secondary dark:text-content-secondary-dark font-mono">{sessionInfo.toolCalls}</span>
                    </div>
                  )}
                  <div className="flex justify-between col-span-2 pt-1.5 border-t border-outline-subtle dark:border-outline-subtle-dark">
                    <span className="text-content-secondary dark:text-content-secondary-dark font-medium">Total:</span>
                    <span className="text-content-primary dark:text-content-primary-dark font-mono font-medium">{sessionInfo.totalMessages}</span>
                  </div>
                </div>
              </div>

              {/* Claude quota info */}
              {isClaudeSession && quotaInfo && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-content-secondary dark:text-content-secondary-dark text-xs font-medium">
                    <Activity className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark" strokeWidth={1.75} />
                    <span>Claude Quota</span>
                  </div>
                  <div className="pl-5 flex items-center gap-2">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${
                      quotaInfo.isUsingOverage ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                    }`}>
                      {quotaInfo.isUsingOverage ? '⚠ Extra use' : '✓ Subscription'}
                    </span>
                    {quotaInfo.rateLimitType && (
                      <span className="text-xs text-content-muted dark:text-content-muted-dark">{quotaInfo.rateLimitType}</span>
                    )}
                  </div>
                  {quotaInfo.resetsAt && (
                    <p className="text-xs text-content-muted dark:text-content-muted-dark pl-5">
                      Resets: {new Date(quotaInfo.resetsAt * 1000).toLocaleString()}
                    </p>
                  )}
                </div>
              )}

              {/* Session ID */}
              <div className="pt-2 border-t border-outline-subtle dark:border-outline-subtle-dark">
                <p className="text-xs text-content-muted dark:text-content-muted-dark text-center font-mono">
                  Session ID: {sessionInfo.sessionId}
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end p-4 border-t border-outline-default dark:border-outline-default-dark bg-surface-subtle/50 dark:bg-surface-dark-subtle/50">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 bg-surface dark:bg-surface-dark hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle border border-outline-default dark:border-outline-default-dark rounded-lg text-xs font-medium text-content-primary dark:text-content-primary-dark transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
