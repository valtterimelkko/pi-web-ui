import { useState, useEffect } from 'react';
import { MessageSquare, Terminal, FolderOpen, GitBranch, MoreHorizontal, ListTodo, ChevronUp, ChevronDown, type LucideIcon } from 'lucide-react';
import { useNavigationStore } from '../../store/navigationStore';

type Tab = 'chat' | 'shell' | 'files' | 'git' | 'tasks';

const MAIN_TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'shell', label: 'Shell', icon: Terminal },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'git', label: 'Git', icon: GitBranch },
];

export function BottomNav() {
  const { activeTab, setActiveTab, bottomNavCollapsed, toggleBottomNav } = useNavigationStore();
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

  // Don't show bottom nav at all when keyboard is open
  if (isKeyboardOpen) return null;

  // Show floating toggle button when collapsed
  if (bottomNavCollapsed) {
    return (
      <button
        onClick={toggleBottomNav}
        className="md:hidden fixed bottom-4 left-4 z-40 p-3 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700 transition-colors"
        style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
        title="Show navigation"
        aria-label="Show navigation"
      >
        <ChevronUp size={20} />
      </button>
    );
  }

  return (
    <>
      {moreOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setMoreOpen(false)}
        />
      )}
      {moreOpen && (
        <div className="fixed bottom-20 right-4 z-50 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2">
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
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white dark:bg-gray-950 border-t border-gray-200 dark:border-gray-800"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Collapse toggle bar */}
        <div className="flex justify-center pt-1">
          <button
            onClick={toggleBottomNav}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title="Hide navigation"
            aria-label="Hide navigation"
          >
            <ChevronDown size={16} />
          </button>
        </div>
        {/* Main tabs */}
        <div className="flex items-center justify-around h-14">
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
      </div>
    </>
  );
}
