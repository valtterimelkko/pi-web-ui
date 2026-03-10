import { X, Info, FileText, Coins, Activity, MessageSquare, Cpu } from 'lucide-react';
import { useEffect } from 'react';
import { useSessionStore, type SessionStats } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';

interface SessionInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SessionInfoModal({ isOpen, onClose }: SessionInfoModalProps) {
  const sessionInfo = useSessionStore((state) => state.sessionInfo);
  const { getSessionInfo } = useWebSocket();

  // Fetch session info when modal opens
  useEffect(() => {
    if (isOpen) {
      getSessionInfo();
    }
  }, [isOpen, getSessionInfo]);

  // Close on escape
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
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-in fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md mx-4 animate-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <Info className="w-5 h-5 text-violet-400" />
            <h2 className="text-lg font-semibold text-slate-100">Session Info</h2>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {!sessionInfo ? (
            <div className="text-center py-8 text-slate-400">
              <Activity className="w-8 h-8 mx-auto mb-2 animate-pulse" />
              Loading session info...
            </div>
          ) : (
            <>
              {/* Session Path */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <FileText className="w-4 h-4" />
                  <span>Session Path</span>
                </div>
                <p className="text-xs text-slate-300 bg-slate-800/50 p-2 rounded break-all font-mono">
                  {sessionInfo.sessionFile || 'N/A'}
                </p>
              </div>

              {/* Model */}
              {sessionInfo.model && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-slate-400 text-sm">
                    <Cpu className="w-4 h-4" />
                    <span>Model</span>
                  </div>
                  <p className="text-sm text-slate-200 pl-6">
                    {sessionInfo.model}
                  </p>
                </div>
              )}

              {/* Context Usage */}
              {sessionInfo.contextPercent !== undefined && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-slate-400 text-sm">
                    <Activity className="w-4 h-4" />
                    <span>Context Window</span>
                  </div>
                  <div className="pl-6">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full transition-all ${
                            sessionInfo.contextPercent > 90 ? 'bg-red-500' : 
                            sessionInfo.contextPercent > 70 ? 'bg-amber-500' : 'bg-blue-400'
                          }`}
                          style={{ width: `${Math.min(sessionInfo.contextPercent, 100)}%` }}
                        />
                      </div>
                      <span className={`text-xs font-medium ${
                        sessionInfo.contextPercent > 90 ? 'text-red-400' : 
                        sessionInfo.contextPercent > 70 ? 'text-amber-400' : 'text-blue-400'
                      }`}>
                        {sessionInfo.contextPercent}%
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {formatNumber(sessionInfo.contextUsed || 0)} / {formatNumber(sessionInfo.contextWindow || 0)} tokens
                    </p>
                  </div>
                </div>
              )}

              {/* Token Usage */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <Activity className="w-4 h-4" />
                  <span>Token Usage</span>
                </div>
                <div className="pl-6 grid grid-cols-2 gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Input:</span>
                    <span className="text-slate-300">{formatNumber(sessionInfo.tokens.input)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Output:</span>
                    <span className="text-slate-300">{formatNumber(sessionInfo.tokens.output)}</span>
                  </div>
                  {sessionInfo.tokens.cacheRead > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Cache Read:</span>
                      <span className="text-slate-300">{formatNumber(sessionInfo.tokens.cacheRead)}</span>
                    </div>
                  )}
                  {sessionInfo.tokens.cacheWrite > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Cache Write:</span>
                      <span className="text-slate-300">{formatNumber(sessionInfo.tokens.cacheWrite)}</span>
                    </div>
                  )}
                  <div className="flex justify-between col-span-2 pt-1 border-t border-slate-800">
                    <span className="text-slate-400 font-medium">Total:</span>
                    <span className="text-slate-200 font-medium">{formatNumber(sessionInfo.tokens.total)}</span>
                  </div>
                </div>
              </div>

              {/* Cost */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <Coins className="w-4 h-4" />
                  <span>Estimated Cost</span>
                </div>
                <p className="text-sm text-slate-200 pl-6">
                  {formatCost(sessionInfo.cost)}
                </p>
              </div>

              {/* Message Count */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <MessageSquare className="w-4 h-4" />
                  <span>Messages</span>
                </div>
                <div className="pl-6 grid grid-cols-2 gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">User:</span>
                    <span className="text-slate-300">{sessionInfo.userMessages}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Assistant:</span>
                    <span className="text-slate-300">{sessionInfo.assistantMessages}</span>
                  </div>
                  {sessionInfo.toolCalls > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Tool Calls:</span>
                      <span className="text-slate-300">{sessionInfo.toolCalls}</span>
                    </div>
                  )}
                  <div className="flex justify-between col-span-2 pt-1 border-t border-slate-800">
                    <span className="text-slate-400 font-medium">Total:</span>
                    <span className="text-slate-200 font-medium">{sessionInfo.totalMessages}</span>
                  </div>
                </div>
              </div>

              {/* Session ID */}
              <div className="pt-2 border-t border-slate-800">
                <p className="text-xs text-slate-500 text-center font-mono">
                  Session ID: {sessionInfo.sessionId}
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end p-4 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
