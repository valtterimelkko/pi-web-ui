import { useState, useEffect } from 'react';
import { MessageSquare, Terminal, FolderOpen, GitBranch, MoreHorizontal, ListTodo, type LucideIcon } from 'lucide-react';
import { useNavigationStore } from '../../store/navigationStore';

type Tab = 'chat' | 'shell' | 'files' | 'git' | 'tasks';

const MAIN_TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'shell', label: 'Shell', icon: Terminal },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'git', label: 'Git', icon: GitBranch },
];

export function BottomNav() {
  const { activeTab, setActiveTab } = useNavigationStore();
  const [moreOpen, setMoreOpen] = useState(false);
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

  if (isKeyboardOpen) return null;

  return (
    <>
      {moreOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setMoreOpen(false)}
        />
      )}
      {moreOpen && (
        <div className="fixed bottom-16 right-4 z-50 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2">
          <button
            onClick={() => { setActiveTab('tasks'); setMoreOpen(false); }}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md w-full"
          >
            <ListTodo size={16} />
            Tasks <span className="text-[10px] font-bold bg-blue-100 text-blue-500 px-1 rounded ml-1">Soon</span>
          </button>
        </div>
      )}
      <div
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex items-center justify-around bg-white dark:bg-gray-950 border-t border-gray-200 dark:border-gray-800 h-16"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {MAIN_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex flex-col items-center gap-0.5 px-3 py-2 transition-colors ${
              activeTab === tab.id
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-400 dark:text-gray-500'
            }`}
          >
            <tab.icon size={20} />
            <span className="text-[10px] font-medium">{tab.label}</span>
          </button>
        ))}
        <button
          onClick={() => setMoreOpen((o) => !o)}
          className={`flex flex-col items-center gap-0.5 px-3 py-2 transition-colors ${
            activeTab === 'tasks' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'
          }`}
        >
          <MoreHorizontal size={20} />
          <span className="text-[10px] font-medium">More</span>
        </button>
      </div>
    </>
  );
}
