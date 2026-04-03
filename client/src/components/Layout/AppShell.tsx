import { type ReactNode } from 'react';
import { Sidebar } from '../Sidebar';

interface AppShellProps {
  children: ReactNode;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="h-screen flex bg-white dark:bg-gray-950">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
