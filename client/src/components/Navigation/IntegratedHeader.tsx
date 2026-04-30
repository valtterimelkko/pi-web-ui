import { useState, useEffect } from 'react';
import { MessageSquare, Terminal, FolderOpen, GitBranch, ListTodo, Info, ChevronsUpDown, ChevronUp, Car, type LucideIcon } from 'lucide-react';
import { useNavigationStore } from '../../store/navigationStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUIStore } from '../../store/uiStore';

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

  // Suppress unused warning - onOpenSettings may be used in future
  void onOpenSettings;

  return (
    <>
      {/* Desktop Header */}
      <div className="hidden md:flex items-center justify-between px-4 h-12 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 flex-shrink-0">
        {/* Left: session name */}
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate max-w-xs">
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
                    ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                <tab.icon size={14} />
                {tab.label}
                {tab.id === 'tasks' && (
                  <span className="text-[9px] font-bold bg-blue-100 dark:bg-blue-900 text-blue-500 dark:text-blue-400 px-1 rounded">
                    Soon
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Divider */}
          {currentSessionId && (
            <div className="w-px h-6 bg-gray-200 dark:bg-gray-700 mx-1" />
          )}

          {/* Session action buttons - only when session active */}
          {currentSessionId && (
            <div className="flex items-center gap-1">
              <button
                onClick={openSessionInfo}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                title="Session info"
              >
                <Info className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              </button>
              <button
                onClick={openTreeView}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                title="View conversation tree"
              >
                <ChevronsUpDown className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              </button>
            </div>
          )}

          {/* Drive Mode button - always visible */}
          <button
            onClick={openDriveMode}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            title="Drive Mode"
            aria-label="Enter Drive Mode"
          >
            <Car className="w-4 h-4 text-gray-500 dark:text-gray-400" />
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
    <div className="md:hidden fixed top-0 left-0 right-0 z-30 bg-white/95 dark:bg-gray-950/95 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800 shadow-sm">
      <div className="flex items-center justify-between px-3 h-12">
        {/* Left: session name */}
        <div className="flex-1 min-w-0 pr-2">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
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
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                title="Session info"
                aria-label="Session info"
              >
                <Info className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              </button>
              <button
                onClick={openTreeView}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                title="View conversation tree"
                aria-label="View conversation tree"
              >
                <ChevronsUpDown className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              </button>
            </>
          )}

          {/* Collapse toggle */}
          <button
            onClick={() => setIsCollapsed(true)}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title="Hide header"
            aria-label="Hide header"
          >
            <ChevronUp size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
