import { Zap, Clock, Activity } from 'lucide-react';
import { useSessionStore } from '../../store';

interface StatusBarProps {
  onOpenSettings: () => void;
}

export function StatusBar({ onOpenSettings }: StatusBarProps) {
  const { isStreaming, sessions, currentSessionId, currentModel } = useSessionStore();
  const currentSession = sessions.find((s) => s.id === currentSessionId);

  // Format model name for display
  const displayModelName = currentModel 
    ? currentModel.split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
    : 'Claude Sonnet';

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
      <div className="flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-blue-400" />
        <div className="w-20 h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div className="w-1/3 h-full bg-blue-400 rounded-full" />
        </div>
        <span className="text-xs text-slate-500">33%</span>
      </div>

      {/* Session Info */}
      {currentSession && (
        <div className="flex items-center gap-2 ml-auto">
          <Clock className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-xs text-slate-500">
            {currentSession.messageCount} messages
          </span>
        </div>
      )}
    </div>
  );
}
