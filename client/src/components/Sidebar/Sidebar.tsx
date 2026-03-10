import { useState } from 'react';
import { PanelLeft, PanelRight, Plus } from 'lucide-react';
import { useSessionStore } from '../../store';
import { useChatStore } from '../../store/chatStore';
import { useWebSocket } from '../../hooks/useWebSocket';
import { SessionList } from './SessionList';
import { SessionFilters } from './SessionFilters';

export function Sidebar() {
  const { sessions, currentSessionId } = useSessionStore();
  const { sidebarOpen, toggleSidebar } = useChatStore();
  const { createNewSession } = useWebSocket();
  const [filter, setFilter] = useState('');
  const [cwdFilter, setCwdFilter] = useState<string | null>(null);

  const filteredSessions = sessions.filter((session) => {
    const matchesText = !filter || 
      session.firstMessage?.toLowerCase().includes(filter.toLowerCase()) ||
      session.id.toLowerCase().includes(filter.toLowerCase());
    
    const matchesCwd = !cwdFilter || session.cwd === cwdFilter;
    
    return matchesText && matchesCwd;
  });

  // Get unique CWDs for filter dropdown
  const uniqueCwds = Array.from(new Set(sessions.map(s => s.cwd)));

  if (!sidebarOpen) {
    return (
      <button
        onClick={toggleSidebar}
        className="fixed left-4 top-4 z-40 p-2 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors shadow-lg"
        title="Open sidebar"
      >
        <PanelRight className="w-5 h-5 text-slate-400" />
      </button>
    );
  }

  return (
    <>
      {/* Mobile Overlay */}
      <div 
        className="fixed inset-0 bg-slate-950/50 z-40 md:hidden animate-in fade-in"
        onClick={toggleSidebar}
      />
      
      <aside className="fixed inset-y-0 left-0 w-[280px] md:relative md:w-80 h-full bg-slate-900 border-r border-slate-800 flex flex-col z-50 animate-in slide-in-from-left duration-200">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <h2 className="text-lg font-semibold text-slate-200">Sessions</h2>
          <div className="flex gap-2">
            <button
              onClick={() => createNewSession()}
              className="p-2 bg-violet-600 hover:bg-violet-700 rounded-lg transition-colors"
              title="New session"
            >
              <Plus className="w-4 h-4 text-white" />
            </button>
            <button
              onClick={toggleSidebar}
              className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
              title="Close sidebar"
            >
              <PanelLeft className="w-4 h-4 text-slate-400" />
            </button>
          </div>
        </div>

        {/* Filters */}
        <SessionFilters
          filter={filter}
          onFilterChange={setFilter}
          cwdFilter={cwdFilter}
          onCwdFilterChange={setCwdFilter}
          uniqueCwds={uniqueCwds}
        />

        {/* Session count - Fixed accessibility contrast */}
        <div className="px-4 py-2 text-xs text-slate-400 border-b border-slate-800">
          {filteredSessions.length} of {sessions.length} sessions
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-hidden">
          <SessionList
            sessions={filteredSessions}
            currentSessionId={currentSessionId}
          />
        </div>
      </aside>
    </>
  );
}
