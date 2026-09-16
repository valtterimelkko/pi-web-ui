import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, Terminal, FolderOpen, GitBranch, ListTodo, Info, ChevronsUpDown, ChevronUp, Car, Copy, Check, type LucideIcon } from 'lucide-react';
import { useNavigationStore } from '../../store/navigationStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUIStore } from '../../store/uiStore';
import { NotificationBell } from '../common/NotificationTray';

type Tab = 'chat' | 'shell' | 'files' | 'git' | 'tasks';

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'shell', label: 'Shell', icon: Terminal },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
];

export function IntegratedHeader({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { activeTab, setActiveTab } = useNavigationStore();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const session = sessions.find((s) => s.id === currentSessionId);
  const openSessionInfo = useUIStore((state) => state.openSessionInfo);
  const openTreeView = useUIStore((state) => state.openTreeView);
  const openDriveMode = useUIStore((state) => state.openDriveMode);
  const [copied, setCopied] = useState(false);

  const handleCopySessionId = useCallback(() => {
    if (!currentSessionId) return;
    navigator.clipboard.writeText(currentSessionId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [currentSessionId]);

  // Suppress unused warning - onOpenSettings may be used in future
  void onOpenSettings;

  return (
    <>
      {/* Desktop Header */}
      <div className="hidden md:flex items-center justify-between px-4 h-12 border-b border-outline-default dark:border-outline-default-dark bg-surface dark:bg-canvas-dark flex-shrink-0">
        {/* Left: session name */}
        <div className="text-sm font-medium text-content-primary dark:text-content-primary-dark truncate max-w-xs">
          {session?.name || session?.firstMessage?.slice(0, 40) || 'New Session'}
        </div>
        {/* Right: tab pills + session actions */}
        <div className="flex items-center gap-2">
          {/* Tab pills */}
          <div className="flex items-center gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors relative ${
                  activeTab === tab.id
                    ? 'text-content-primary dark:text-content-primary-dark bg-surface-subtle dark:bg-surface-dark-subtle border border-outline-subtle dark:border-outline-subtle-dark'
                    : 'text-content-secondary dark:text-content-secondary-dark hover:text-content-primary dark:hover:text-content-primary-dark hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle'
                }`}
              >
                <tab.icon size={14} strokeWidth={1.75} />
                {tab.label}
                {tab.id === 'tasks' && (
                  <span className="text-[9px] font-bold bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 px-1 rounded">
                    Soon
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Divider */}
          {currentSessionId && (
            <div className="w-px h-6 bg-outline-default dark:border-outline-default-dark mx-1" />
          )}

          {/* Session action buttons - only when session active */}
          {currentSessionId && (
            <div className="flex items-center gap-1">
              <button
                onClick={openSessionInfo}
                className="p-2 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle rounded-lg transition-colors text-content-secondary dark:text-content-secondary-dark hover:text-content-primary dark:hover:text-content-primary-dark"
                title="Session info"
              >
                <Info className="w-4 h-4" strokeWidth={1.75} />
              </button>
              <button
                onClick={openTreeView}
                className="p-2 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle rounded-lg transition-colors text-content-secondary dark:text-content-secondary-dark hover:text-content-primary dark:hover:text-content-primary-dark"
                title="View conversation tree"
              >
                <ChevronsUpDown className="w-4 h-4" strokeWidth={1.75} />
              </button>
              <button
                onClick={handleCopySessionId}
                className="p-2 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle rounded-lg transition-colors text-content-secondary dark:text-content-secondary-dark hover:text-content-primary dark:hover:text-content-primary-dark"
                title={copied ? 'Copied Session ID!' : 'Copy Session ID'}
                aria-label="Copy Session ID"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-600 dark:text-green-400" strokeWidth={1.75} />
                ) : (
                  <Copy className="w-4 h-4" strokeWidth={1.75} />
                )}
              </button>
            </div>
          )}

          {/* Notification history — extension notifications are one-shot */}
          <NotificationBell />

          {/* Voice Mode button - always visible */}
          <button
            onClick={openDriveMode}
            className="p-2 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle rounded-lg transition-colors text-content-secondary dark:text-content-secondary-dark hover:text-content-primary dark:hover:text-content-primary-dark"
            title="Voice Mode"
            aria-label="Enter Voice Mode"
          >
            <Car className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* Mobile Header */}
      <MobileHeader />
    </>
  );
}

// Mobile header component with collapse/expand functionality
function MobileHeader() {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const session = sessions.find((s) => s.id === currentSessionId);
  const openSessionInfo = useUIStore((state) => state.openSessionInfo);
  const openTreeView = useUIStore((state) => state.openTreeView);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopySessionId = useCallback(() => {
    if (!currentSessionId) return;
    navigator.clipboard.writeText(currentSessionId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [currentSessionId]);

  useEffect(() => {
    const handleResize = () => {
      // Detect virtual keyboard (window height shrinks significantly)
      const heightDiff = window.screen.height - window.innerHeight;
      setIsKeyboardOpen(heightDiff > 150);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Hide when keyboard is open (similar to BottomNav behavior)
  if (isKeyboardOpen) return null;

  // Show floating toggle button when collapsed
  if (isCollapsed) {
    return (
      <button
        onClick={() => setIsCollapsed(false)}
        className="md:hidden fixed top-4 right-4 z-40 p-2 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700 transition-colors"
        title="Show session info"
        aria-label="Show session info"
      >
        <Info size={18} />
      </button>
    );
  }

  return (
    <div className="md:hidden fixed top-0 left-0 right-0 z-30 bg-surface/95 dark:bg-canvas-dark/95 backdrop-blur-sm border-b border-outline-default dark:border-outline-default-dark shadow-xs">
      <div className="flex items-center justify-between px-3 h-12">
        {/* Left: session name */}
        <div className="flex-1 min-w-0 pr-2">
          <div className="text-sm font-medium text-content-primary dark:text-content-primary-dark truncate">
            {session?.name || session?.firstMessage?.slice(0, 40) || 'New Session'}
          </div>
        </div>

        {/* Right: session actions + collapse toggle */}
        <div className="flex items-center gap-1">
          {/* Session action buttons - only when session active */}
          {currentSessionId && (
            <>
              <button
                onClick={openSessionInfo}
                className="p-2 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle rounded-lg transition-colors text-content-secondary dark:text-content-secondary-dark hover:text-content-primary dark:hover:text-content-primary-dark"
                title="Session info"
                aria-label="Session info"
              >
                <Info className="w-4 h-4" strokeWidth={1.75} />
              </button>
              <button
                onClick={openTreeView}
                className="p-2 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle rounded-lg transition-colors text-content-secondary dark:text-content-secondary-dark hover:text-content-primary dark:hover:text-content-primary-dark"
                title="View conversation tree"
                aria-label="View conversation tree"
              >
                <ChevronsUpDown className="w-4 h-4" strokeWidth={1.75} />
              </button>
              <button
                onClick={handleCopySessionId}
                className="p-2 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle rounded-lg transition-colors text-content-secondary dark:text-content-secondary-dark hover:text-content-primary dark:hover:text-content-primary-dark"
                title={copied ? 'Copied Session ID!' : 'Copy Session ID'}
                aria-label="Copy Session ID"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-600 dark:text-green-400" strokeWidth={1.75} />
                ) : (
                  <Copy className="w-4 h-4" strokeWidth={1.75} />
                )}
              </button>
            </>
          )}

          {/* Notification history — the tray is the only way to re-read a
              one-shot extension notification on a phone. */}
          <NotificationBell />

          {/* Collapse toggle */}
          <button
            onClick={() => setIsCollapsed(true)}
            className="p-2 text-content-muted dark:text-content-muted-dark hover:text-content-primary dark:hover:text-content-primary-dark transition-colors"
            title="Hide header"
            aria-label="Hide header"
          >
            <ChevronUp size={18} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}
