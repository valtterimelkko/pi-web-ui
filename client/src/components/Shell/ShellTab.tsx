import { useEffect, useRef } from 'react';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { useTerminal } from '../../hooks/useTerminal';
import { useTerminalStore } from '../../store/terminalStore';
import { useSessionStore } from '../../store/sessionStore';

export function ShellTab() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { connect, disconnect } = useTerminal(containerRef);
  const { connected, error } = useTerminalStore();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const session = sessions.find((s) => s.id === currentSessionId);

  // Connect when component mounts
  useEffect(() => {
    connect();
    return () => { disconnect(); };
  }, [connect, disconnect]);

  return (
    <div className="flex-1 flex flex-col h-full bg-gray-950 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-600'}`} />
          <span className="text-xs text-gray-400">
            {connected ? 'Connected' : 'Disconnected'}
          </span>
          {session?.cwd && (
            <span className="text-xs text-gray-600 ml-2">{session.cwd}</span>
          )}
        </div>
        <button
          onClick={() => { disconnect(); setTimeout(connect, 100); }}
          className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
          title="Reconnect"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Error message */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-950 border-b border-red-800 flex-shrink-0">
          <AlertCircle size={14} className="text-red-400" />
          <span className="text-xs text-red-400">{error}</span>
        </div>
      )}

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden"
        style={{ padding: '8px' }}
      />
    </div>
  );
}
