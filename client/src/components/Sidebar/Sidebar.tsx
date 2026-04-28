import { useState } from 'react';
import { PanelLeft, PanelRight, Plus, RefreshCw, Sun, Moon, ChevronRight, Coins } from 'lucide-react';
import { useSessionStore, useUIStore } from '../../store';
import { useChatStore } from '../../store/chatStore';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useTransferStore } from '../../store/transferStore';
import { SessionList } from './SessionList';
import { SessionFilters } from './SessionFilters';
import { NewSessionModal } from '../Session';
import { TransferConfirmationModal } from './TransferConfirmationModal';
import { SessionItem } from './SessionItem';
import { TokenUsageDashboard } from '../Usage';

export function Sidebar() {
  const sessions = useSessionStore(s => s.sessions);
  const currentSessionId = useSessionStore(s => s.currentSessionId);
  const archivedSessionPaths = useSessionStore(s => s.archivedSessionPaths);
  const sessionDisplayNames = useSessionStore(s => s.sessionDisplayNames);
  const { sidebarOpen, toggleSidebar } = useChatStore();
  const { createNewSession, getSessions } = useWebSocket();
  const { theme, toggleTheme } = useUIStore();
  const [filter, setFilter] = useState('');
  const [cwdFilter, setCwdFilter] = useState<string | null>(null);
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [archiveExpanded, setArchiveExpanded] = useState(false);
  const [showUsageDashboard, setShowUsageDashboard] = useState(false);

  // Helper to get display name for a session
  const getDisplayName = (session: { path: string; name?: string; firstMessage?: string }) => {
    return sessionDisplayNames[session.path] || session.name || session.firstMessage || 'New session';
  };

  // Split sessions into active and archived
  const activeSessions = sessions.filter(s => !archivedSessionPaths.includes(s.path));
  const archivedSessions = sessions.filter(s => archivedSessionPaths.includes(s.path));

  const filteredSessions = activeSessions.filter((session) => {
    const displayName = getDisplayName(session);
    const matchesText = !filter ||
      displayName.toLowerCase().includes(filter.toLowerCase()) ||
      session.firstMessage?.toLowerCase().includes(filter.toLowerCase()) ||
      session.id.toLowerCase().includes(filter.toLowerCase());

    const matchesCwd = !cwdFilter || session.cwd === cwdFilter;

    return matchesText && matchesCwd;
  });

  const filteredArchivedSessions = archivedSessions.filter((session) => {
    const displayName = getDisplayName(session);
    const matchesText = !filter ||
      displayName.toLowerCase().includes(filter.toLowerCase()) ||
      session.firstMessage?.toLowerCase().includes(filter.toLowerCase()) ||
      session.id.toLowerCase().includes(filter.toLowerCase());
    return matchesText;
  });

  // Get unique CWDs for filter dropdown
  const uniqueCwds = Array.from(new Set(activeSessions.map(s => s.cwd)));

  const handleCreateSession = (cwd?: string, sdkType?: 'pi' | 'claude' | 'opencode') => {
    createNewSession(cwd, sdkType);
  };

  const transferStatus = useTransferStore(state => state.status);
  const transferSource = useTransferStore(state => state.source);
  const transferTargetMode = useTransferStore(state => state.targetMode);
  const existingTarget = useTransferStore(state => state.existingTarget);
  const newTargetRuntime = useTransferStore(state => state.newTargetRuntime);
  const newTargetCwd = useTransferStore(state => state.newTargetCwd);
  const transferScope = useTransferStore(state => state.scope);
  const transferSetSubmitting = useTransferStore(state => state.setSubmitting);
  const transferSetSucceeded = useTransferStore(state => state.setSucceeded);
  const transferSetFailed = useTransferStore(state => state.setFailed);
  const transferReset = useTransferStore(state => state.reset);
  const { sendMessage } = useWebSocket();

  const handleTransferConfirm = () => {
    if (!transferSource) return;
    transferSetSubmitting();
    const payload: Record<string, unknown> = {
      type: 'transfer_session_context',
      sourceSessionId: transferSource.sessionId,
      scope: transferScope,
      sourceDisplayName: transferSource.displayName,
    };
    if (transferTargetMode === 'existing' && existingTarget?.sessionId) {
      payload.targetSessionId = existingTarget.sessionId;
    } else if (transferTargetMode === 'new') {
      payload.createNew = true;
      payload.targetSdkType = newTargetRuntime;
      payload.targetCwd = newTargetCwd;
    }
    sendMessage(payload);
  };

  const isTransferModalOpen = transferStatus === 'confirming' || transferStatus === 'submitting' || transferStatus === 'succeeded' || transferStatus === 'failed';

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
          {filteredSessions.length} of {activeSessions.length} sessions
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-hidden">
            <SessionList
              sessions={filteredSessions}
              currentSessionId={currentSessionId}
            />
          </div>

          {/* Archive section */}
          {(archivedSessions.length > 0 || archiveExpanded) && (
            <div className="border-t border-gray-200 flex-shrink-0">
              <button
                onClick={() => setArchiveExpanded(!archiveExpanded)}
                className="w-full flex items-center justify-between px-4 py-2 hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <ChevronRight
                    className={`w-3.5 h-3.5 text-gray-400 transition-transform ${archiveExpanded ? 'rotate-90' : ''}`}
                  />
                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                    Archived
                  </span>
                </div>
                {archivedSessions.length > 0 && (
                  <span className="text-[10px] font-medium text-gray-400 bg-gray-200 rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                    {archivedSessions.length}
                  </span>
                )}
              </button>

              {archiveExpanded && filteredArchivedSessions.length > 0 && (
                <div
                  className="overflow-y-auto px-2 py-1 space-y-0.5 bg-gray-50/50"
                  style={{ maxHeight: '200px', scrollbarWidth: 'thin', scrollbarColor: 'rgba(209,213,219,0.5) transparent' }}
                >
                  {filteredArchivedSessions.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      isActive={session.id === currentSessionId}
                      isArchived={true}
                    />
                  ))}
                </div>
              )}

              {archiveExpanded && filteredArchivedSessions.length === 0 && (
                <div className="px-4 py-2 text-[11px] text-gray-400 text-center">
                  No archived sessions
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom section */}
        <div className="border-t border-gray-200 px-3 py-3 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowUsageDashboard(true)}
              className="p-2 hover:bg-gray-200 rounded-lg transition-colors"
              title="Token usage dashboard"
            >
              <Coins className="w-4 h-4 text-gray-400" />
            </button>
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
          </div>
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

      {/* Token Usage Dashboard */}
      <TokenUsageDashboard
        isOpen={showUsageDashboard}
        onClose={() => setShowUsageDashboard(false)}
      />

      {/* Transfer Confirmation Modal */}
      {isTransferModalOpen && (
        <TransferConfirmationModal onConfirm={handleTransferConfirm} />
      )}
    </>
  );
}
