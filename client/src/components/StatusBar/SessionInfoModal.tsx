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
      } catch (err) {
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

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 animate-in fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-md mx-4 animate-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <Info className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-900">Session Info</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {isLoading || !sessionInfo ? (
            <div className="text-center py-8 text-gray-400">
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
                      } catch (err) {
                        setError('Failed to load session info');
                        setIsLoading(false);
                      }
                    }}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors flex items-center gap-2 mx-auto"
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
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-gray-500 text-sm">
                  <FolderOpen className="w-4 h-4" />
                  <span>Working Directory</span>
                </div>
                <p className="text-xs text-gray-700 bg-gray-50 p-2 rounded break-all font-mono">
                  {sessionInfo.cwd || 'N/A'}
                </p>
              </div>

              {/* Session File */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-gray-500 text-sm">
                  <FileText className="w-4 h-4" />
                  <span>Session File</span>
                </div>
                <p className="text-xs text-gray-700 bg-gray-50 p-2 rounded break-all font-mono">
                  {sessionInfo.sessionFile || 'N/A'}
                </p>
              </div>

              {/* Session Type */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-gray-500 text-sm">
                  <Box className="w-4 h-4" />
                  <span>Session Type</span>
                </div>
                <div className="pl-6">
                  {isClaudeSession ? (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200">
                        CC
                      </span>
                      <span className="text-sm text-gray-900">Claude Direct</span>
                      <span className="text-xs text-gray-400">(Claude Code CLI)</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-violet-100 text-violet-700 border border-violet-200">
                        π
                      </span>
                      <span className="text-sm text-gray-900">Pi SDK</span>
                      <span className="text-xs text-gray-400">(Full extensions & providers)</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Model */}
              {sessionInfo.model && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-gray-500 text-sm">
                    <Cpu className="w-4 h-4" />
                    <span>Model</span>
                  </div>
                  <p className="text-sm text-gray-900 pl-6">
                    {sessionInfo.model}
                  </p>
                </div>
              )}

              {/* Context Usage */}
              {sessionInfo.contextPercent !== undefined && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-gray-500 text-sm">
                    <Activity className="w-4 h-4" />
                    <span>Context Window</span>
                  </div>
                  <div className="pl-6">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            sessionInfo.contextPercent > 90 ? 'bg-red-500' :
                            sessionInfo.contextPercent > 70 ? 'bg-amber-500' : 'bg-blue-500'
                          }`}
                          style={{ width: `${Math.min(sessionInfo.contextPercent, 100)}%` }}
                        />
                      </div>
                      <span className={`text-xs font-medium ${
                        sessionInfo.contextPercent > 90 ? 'text-red-500' :
                        sessionInfo.contextPercent > 70 ? 'text-amber-500' : 'text-blue-600'
                      }`}>
                        {sessionInfo.contextPercent}%
                      </span>
                    </div>
                    <p className="text-xs text-gray-400">
                      {formatNumber(sessionInfo.contextUsed || 0)} / {formatNumber(sessionInfo.contextWindow || 0)} tokens
                    </p>
                  </div>
                </div>
              )}

              {/* Token Usage */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-gray-500 text-sm">
                  <Activity className="w-4 h-4" />
                  <span>Token Usage</span>
                </div>
                <div className="pl-6 grid grid-cols-2 gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Input:</span>
                    <span className="text-gray-700">{formatNumber(sessionInfo.tokens.input)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Output:</span>
                    <span className="text-gray-700">{formatNumber(sessionInfo.tokens.output)}</span>
                  </div>
                  {sessionInfo.tokens.cacheRead > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Cache Read:</span>
                      <span className="text-gray-700">{formatNumber(sessionInfo.tokens.cacheRead)}</span>
                    </div>
                  )}
                  {sessionInfo.tokens.cacheWrite > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Cache Write:</span>
                      <span className="text-gray-700">{formatNumber(sessionInfo.tokens.cacheWrite)}</span>
                    </div>
                  )}
                  <div className="flex justify-between col-span-2 pt-1 border-t border-gray-200">
                    <span className="text-gray-500 font-medium">Total:</span>
                    <span className="text-gray-900 font-medium">{formatNumber(sessionInfo.tokens.total)}</span>
                  </div>
                </div>
              </div>

              {/* Cost */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-gray-500 text-sm">
                  <Coins className="w-4 h-4" />
                  <span>Estimated Cost</span>
                </div>
                <p className="text-sm text-gray-900 pl-6">
                  {formatCost(sessionInfo.cost)}
                </p>
              </div>

              {/* Message Count */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-gray-500 text-sm">
                  <MessageSquare className="w-4 h-4" />
                  <span>Messages</span>
                </div>
                <div className="pl-6 grid grid-cols-2 gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">User:</span>
                    <span className="text-gray-700">{sessionInfo.userMessages}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Assistant:</span>
                    <span className="text-gray-700">{sessionInfo.assistantMessages}</span>
                  </div>
                  {sessionInfo.toolCalls > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Tool Calls:</span>
                      <span className="text-gray-700">{sessionInfo.toolCalls}</span>
                    </div>
                  )}
                  <div className="flex justify-between col-span-2 pt-1 border-t border-gray-200">
                    <span className="text-gray-500 font-medium">Total:</span>
                    <span className="text-gray-900 font-medium">{sessionInfo.totalMessages}</span>
                  </div>
                </div>
              </div>

              {/* Claude quota info */}
              {isClaudeSession && quotaInfo && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-gray-500 text-sm">
                    <Activity className="w-4 h-4" />
                    <span>Claude Quota</span>
                  </div>
                  <div className="pl-6 flex items-center gap-2">
                    <span className={`text-sm font-medium ${
                      quotaInfo.isUsingOverage ? 'text-amber-500' : 'text-green-600'
                    }`}>
                      {quotaInfo.isUsingOverage ? '⚠ Extra use' : '✓ Subscription'}
                    </span>
                    {quotaInfo.rateLimitType && (
                      <span className="text-xs text-gray-400">{quotaInfo.rateLimitType}</span>
                    )}
                  </div>
                  {quotaInfo.resetsAt && (
                    <p className="text-xs text-gray-400 pl-6">
                      Resets: {new Date(quotaInfo.resetsAt * 1000).toLocaleString()}
                    </p>
                  )}
                </div>
              )}

              {/* Session ID */}
              <div className="pt-2 border-t border-gray-200">
                <p className="text-xs text-gray-400 text-center font-mono">
                  Session ID: {sessionInfo.sessionId}
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end p-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm text-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
