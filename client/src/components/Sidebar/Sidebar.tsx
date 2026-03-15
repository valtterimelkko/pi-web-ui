import { useState } from 'react';
import { PanelLeft, PanelRight, Plus, RefreshCw, Sun, Moon } from 'lucide-react';
import { useSessionStore, useUIStore } from '../../store';
import { useChatStore } from '../../store/chatStore';
import { useWebSocket } from '../../hooks/useWebSocket';
import { SessionList } from './SessionList';
import { SessionFilters } from './SessionFilters';
import { NewSessionModal } from '../Session';

export function Sidebar() {
  const { sessions, currentSessionId } = useSessionStore();
  const { sidebarOpen, toggleSidebar } = useChatStore();
  const { createNewSession, getSessions } = useWebSocket();
  const { theme, toggleTheme } = useUIStore();
  const [filter, setFilter] = useState('');
  const [cwdFilter, setCwdFilter] = useState<string | null>(null);
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);

  const filteredSessions = sessions.filter((session) => {
    const matchesText = !filter ||
      session.firstMessage?.toLowerCase().includes(filter.toLowerCase()) ||
      session.id.toLowerCase().includes(filter.toLowerCase());

    const matchesCwd = !cwdFilter || session.cwd === cwdFilter;

    return matchesText && matchesCwd;
  });

  // Get unique CWDs for filter dropdown
  const uniqueCwds = Array.from(new Set(sessions.map(s => s.cwd)));

  const handleCreateSession = (cwd?: string) => {
    createNewSession(cwd);
  };

  if (!sidebarOpen) {
    return (
      <button
        onClick={toggleSidebar}
        className="fixed left-4 top-4 z-40 p-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors shadow-sm"
        title="Open sidebar"
      >
        <PanelRight className="w-5 h-5 text-gray-500" />
      </button>
    );
  }

  return (
    <>
      {/* Mobile Overlay */}
      <div
        className="fixed inset-0 bg-black/30 z-40 md:hidden animate-in fade-in"
        onClick={toggleSidebar}
      />

      <aside className="fixed inset-y-0 left-0 w-60 md:relative md:w-60 h-full bg-gray-50 border-r border-gray-200 flex flex-col z-50 animate-in slide-in-from-left duration-200">
        {/* Header - Brand */}
        <div className="px-4 pt-4 pb-2">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-gray-900">Pi Code</span>
              <span className="text-[10px] font-medium text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded">v1.0</span>
            </div>
          </div>

          {/* Sessions header with actions */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Sessions</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => getSessions?.()}
                className="p-1.5 hover:bg-gray-200 rounded-md transition-colors"
                title="Refresh sessions"
              >
                <RefreshCw className="w-3.5 h-3.5 text-gray-400" />
              </button>
              <button
                onClick={() => setShowNewSessionModal(true)}
                className="p-1.5 hover:bg-gray-200 rounded-md transition-colors"
                title="New session"
              >
                <Plus className="w-3.5 h-3.5 text-gray-400" />
              </button>
            </div>
          </div>
        </div>

        {/* Search */}
        <SessionFilters
          filter={filter}
          onFilterChange={setFilter}
          cwdFilter={cwdFilter}
          onCwdFilterChange={setCwdFilter}
          uniqueCwds={uniqueCwds}
        />

        {/* Session count */}
        <div className="px-4 py-1.5 text-[11px] text-gray-400">
          {filteredSessions.length} of {sessions.length} sessions
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-hidden">
          <SessionList
            sessions={filteredSessions}
            currentSessionId={currentSessionId}
          />
        </div>

        {/* Bottom section */}
        <div className="border-t border-gray-200 px-3 py-3 flex items-center justify-between">
          <button
            onClick={toggleTheme}
            className="p-2 hover:bg-gray-200 rounded-lg transition-colors"
            title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {theme === 'light' ? (
              <Moon className="w-4 h-4 text-gray-400" />
            ) : (
              <Sun className="w-4 h-4 text-gray-400" />
            )}
          </button>
          <button
            onClick={toggleSidebar}
            className="p-2 hover:bg-gray-200 rounded-lg transition-colors"
            title="Close sidebar"
          >
            <PanelLeft className="w-4 h-4 text-gray-400" />
          </button>
        </div>
      </aside>

      {/* New Session Modal */}
      <NewSessionModal
        isOpen={showNewSessionModal}
        onClose={() => setShowNewSessionModal(false)}
        onCreateSession={handleCreateSession}
      />
    </>
  );
}
