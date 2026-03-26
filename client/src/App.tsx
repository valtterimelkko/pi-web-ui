import { useEffect, useState, useRef, useCallback } from 'react';
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
import { useSessionStream } from './hooks/useSessionStream.js';

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
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

  // Use the new session stream hook for the current session
  const {
    messages,
    status,
    sendPrompt,
    cancelCurrentTurn,
  } = useSessionStream(currentSessionId, {
    debug: import.meta.env.DEV,
  });

  // Handle session switching - atomic switch with automatic cleanup
  const handleSessionSwitch = useCallback((newSessionId: string) => {
    // useSessionStream's useLayoutEffect handles cleanup automatically
    // when currentSessionId changes
    useSessionStore.getState().setCurrentSession(newSessionId);
  }, []);

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
    <div className="h-screen flex bg-white dark:bg-gray-950">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <ChatView
          onOpenSettings={() => setSettingsOpen(true)}
          // New protocol props (for future use when ChatView is refactored)
          // messages={messages}
          // isStreaming={status === 'streaming'}
          // onSendMessage={sendPrompt}
          // onCancel={cancelCurrentTurn}
        />
      </div>
      <ExtensionDialog
        request={extensionUIRequest}
        onResponse={handleExtensionResponse}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ToastContainer />
    </div>
  );
}

export default App;
