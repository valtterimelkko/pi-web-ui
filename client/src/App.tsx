import { useEffect, useState, useRef } from 'react';
import { useAuth, checkAuthStatus } from './hooks/useAuth';
import { useCopyShortcut } from './hooks/useCopyShortcut';
import { LoginForm } from './components/Auth/LoginForm';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/Chat';
import { ExtensionDialog } from './components/Extensions';
import { SettingsModal } from './components/Settings';
import { ToastContainer } from './components/common';
import { useSessionStore } from './store/sessionStore';
import { useUIStore } from './store/uiStore';
import { useWebSocket } from './hooks/useWebSocket';

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
  const { sendMessage } = useWebSocket();

  // Enable keyboard shortcut for copying last message (Ctrl+Shift+C)
  useCopyShortcut();

  return (
    <div className="h-screen flex bg-white dark:bg-gray-950">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <ChatView onOpenSettings={() => setSettingsOpen(true)} />
      </div>
      <ExtensionDialog
        request={extensionUIRequest}
        onResponse={(response) => {
          sendMessage({ type: 'extension_ui_response', response });
          setExtensionUIRequest(null);
        }}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ToastContainer />
    </div>
  );
}

export default App;
