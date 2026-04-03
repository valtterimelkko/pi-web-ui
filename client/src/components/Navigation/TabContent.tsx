import { useState, useEffect, type ReactNode } from 'react';
import { useNavigationStore } from '../../store/navigationStore';

type Tab = 'chat' | 'shell' | 'files' | 'git' | 'tasks';

interface TabContentProps {
  tab: Tab;
  children: ReactNode;
}

// Single tab panel - mounts on first visit, stays mounted
export function TabPanel({ tab, children }: TabContentProps) {
  const activeTab = useNavigationStore((state) => state.activeTab);
  const [hasBeenMounted, setHasBeenMounted] = useState(tab === 'chat');
  const isActive = activeTab === tab;

  useEffect(() => {
    if (isActive && !hasBeenMounted) {
      setHasBeenMounted(true);
    }
  }, [isActive, hasBeenMounted]);

  if (!hasBeenMounted) return null;

  return (
    <div
      className="flex-1 overflow-hidden"
      style={{
        display: isActive ? 'flex' : 'none',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {children}
    </div>
  );
}
