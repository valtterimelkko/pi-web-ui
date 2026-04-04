import { MessageSquare, Terminal, FolderOpen, GitBranch, ListTodo, Info, ChevronsUpDown, type LucideIcon } from 'lucide-react';
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

  // Suppress unused warning - onOpenSettings may be used in future
  void onOpenSettings;

  return (
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
      </div>
    </div>
  );
}
