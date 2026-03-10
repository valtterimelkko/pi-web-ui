import { Zap, Clock, Activity, Download, Copy, Info } from 'lucide-react';
import { useSessionStore } from '../../store';
import { exportSession } from '../../lib/api';
import { copyToClipboard, extractMessageText } from '../../lib/clipboard';
import { useState } from 'react';
import { SessionInfoModal } from './SessionInfoModal';

interface StatusBarProps {
  onOpenSettings: () => void;
}

export function StatusBar({ onOpenSettings }: StatusBarProps) {
  const { isStreaming, sessions, currentSessionId, currentModel, messages, contextPercent, contextUsed, contextWindow } = useSessionStore();
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const [isExporting, setIsExporting] = useState(false);
  const [showSessionInfo, setShowSessionInfo] = useState(false);

  // Get the last assistant message for copying
  const getLastAssistantMessage = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        return messages[i];
      }
    }
    return null;
  };

  const lastAssistantMessage = getLastAssistantMessage();

  const handleCopyLastMessage = async () => {
    if (!lastAssistantMessage) return;
    const text = extractMessageText(lastAssistantMessage.content);
    if (text) {
      await copyToClipboard(text, 'Last message copied to clipboard');
    }
  };

  // Format model name for display
  const displayModelName = currentModel 
    ? currentModel.split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
    : 'No Model';

  return (
    <div className="h-10 bg-slate-900 border-t border-slate-800 flex items-center px-4 gap-6">
      {/* Connection Status */}
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-amber-400 animate-pulse' : 'bg-green-400'}`} />
        <span className="text-xs text-slate-400">
          {isStreaming ? 'Thinking...' : 'Ready'}
        </span>
      </div>

      {/* Model Indicator */}
      <button
        onClick={onOpenSettings}
        className="flex items-center gap-2 hover:bg-slate-800 px-2 py-1 rounded transition-colors"
      >
        <Zap className="w-3.5 h-3.5 text-violet-400" />
        <span className="text-xs text-slate-400">{displayModelName}</span>
      </button>

      {/* Context Usage */}
      <div className="flex items-center gap-2" title={contextWindow > 0 ? `${contextUsed.toLocaleString()} / ${contextWindow.toLocaleString()} tokens` : 'Context usage'}>
        <Activity className="w-3.5 h-3.5 text-blue-400" />
        <div className="w-20 h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div 
            className="h-full bg-blue-400 rounded-full transition-all duration-300"
            style={{ width: `${Math.min(contextPercent, 100)}%` }}
          />
        </div>
        <span className="text-xs text-slate-500">{contextPercent}%</span>
      </div>

      {/* Session Info */}
      {currentSession && (
        <div className="flex items-center gap-2 ml-auto">
          <Clock className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-xs text-slate-500">
            {currentSession.messageCount} messages
          </span>
          <button
            onClick={async () => {
              if (!currentSessionId || isExporting) return;
              setIsExporting(true);
              try {
                await exportSession(currentSessionId);
              } catch (error) {
                console.error('Export failed:', error);
                alert('Failed to export session. Please try again.');
              } finally {
                setIsExporting(false);
              }
            }}
            disabled={isExporting || !currentSessionId}
            className="flex items-center gap-1 ml-2 px-2 py-1 hover:bg-slate-800 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export session to HTML"
          >
            <Download className={`w-3.5 h-3.5 text-slate-400 ${isExporting ? 'animate-pulse' : ''}`} />
            <span className="text-xs text-slate-400">
              {isExporting ? 'Exporting...' : 'Export'}
            </span>
          </button>

          {/* Copy Last Message Button */}
          {lastAssistantMessage && (
            <button
              onClick={handleCopyLastMessage}
              className="flex items-center gap-1 ml-2 px-2 py-1 hover:bg-slate-800 rounded transition-colors"
              title="Copy last message (Ctrl+Shift+C)"
            >
              <Copy className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-xs text-slate-400">Copy</span>
            </button>
          )}
          
          {/* Session Info Button */}
          <button
            onClick={() => setShowSessionInfo(true)}
            className="flex items-center gap-1 ml-2 px-2 py-1 hover:bg-slate-800 rounded transition-colors"
            title="Session info"
          >
            <Info className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs text-slate-400">Info</span>
          </button>
        </div>
      )}
      
      {/* Session Info Modal */}
      <SessionInfoModal 
        isOpen={showSessionInfo} 
        onClose={() => setShowSessionInfo(false)} 
      />
    </div>
  );
}
