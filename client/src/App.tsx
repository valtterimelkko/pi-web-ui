import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth, checkAuthStatus } from './hooks/useAuth';
import { useCopyShortcut } from './hooks/useCopyShortcut';
import { LoginForm } from './components/Auth/LoginForm';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/Chat';
import { IntegratedHeader, BottomNav, TabPanel } from './components/Navigation';
import { ShellTab } from './components/Shell';
import { GitTab } from './components/Git';
import { FilesTab } from './components/Files';
import { TasksPlaceholder } from './components/Tasks';
import { ExtensionDialog } from './components/Extensions';
import { SettingsModal } from './components/Settings';
import { DriveModeOverlay } from './components/DriveMode';
import { ToastContainer } from './components/common';
import { useSessionStore } from './store/sessionStore';
import { useUIStore } from './store/uiStore';

function App() {
  const isAuthenticated = useAuth((state) => state.isAuthenticated);
  const [isChecking, setIsChecking] = useState(true);
  const hasChecked = useRef(false);
  const theme = useUIStore((state) => state.theme);

  // Sync theme to document element
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  useEffect(() => {
    // Prevent duplicate calls in React StrictMode
    if (hasChecked.current) return;
    hasChecked.current = true;

    checkAuthStatus().then(() => {
      setIsChecking(false);
    });
  }, []);

  if (isChecking) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginForm />;
  }

  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const extensionUIRequest = useSessionStore((state) => state.extensionUIRequest);
  const setExtensionUIRequest = useSessionStore((state) => state.setExtensionUIRequest);
  const initPreferences = useSessionStore((state) => state.initPreferences);

  // Enable keyboard shortcut for copying last message (Ctrl+Shift+C)
  useCopyShortcut();

  // Load server-side preferences (archive state, etc.) on mount
  useEffect(() => {
    initPreferences();
  }, [initPreferences]);

  // Handle extension UI response
  const handleExtensionResponse = useCallback((response: { id: string; approved?: boolean; value?: unknown; cancelled?: boolean }) => {
    // For extension UI responses, we still need to use the legacy sendMessage
    // This is a temporary bridge until extensions are migrated to the new protocol
    // The extension dialog is rare enough that this is acceptable
    import('./lib/websocket.js').then(({ createWebSocketClient }) => {
      const client = createWebSocketClient({
        onMessage: () => {},
        onStatusChange: () => {},
        onError: () => {},
      });
      client.send({ type: 'extension_ui_response', response });
    });
    setExtensionUIRequest(null);
  }, [setExtensionUIRequest]);

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-gray-950 overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <IntegratedHeader onOpenSettings={() => setSettingsOpen(true)} />
          <div className="flex-1 overflow-hidden relative flex pt-12 md:pt-0">
            <TabPanel tab="chat">
              <ChatView onOpenSettings={() => setSettingsOpen(true)} />
            </TabPanel>
            <TabPanel tab="shell">
              <ShellTab />
            </TabPanel>
            <TabPanel tab="files">
              <FilesTab />
            </TabPanel>
            <TabPanel tab="git">
              <GitTab />
            </TabPanel>
            <TabPanel tab="tasks">
              <TasksPlaceholder />
            </TabPanel>
          </div>
        </div>
      </div>
      <BottomNav />
      <ExtensionDialog
        request={extensionUIRequest}
        onResponse={handleExtensionResponse}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DriveModeOverlay />
      <ToastContainer />
    </div>
  );
}

export default App;
