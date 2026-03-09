import { useEffect, useState } from 'react';
import { useAuth, checkAuthStatus } from './hooks/useAuth';
import { LoginForm } from './components/Auth/LoginForm';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/Chat';
import { ExtensionDialog } from './components/Extensions';
import { SettingsModal } from './components/Settings';
import { StatusBar } from './components/StatusBar';
import { useSessionStore } from './store/sessionStore';
import { useWebSocket } from './hooks/useWebSocket';

function App() {
  const isAuthenticated = useAuth((state) => state.isAuthenticated);
  const [isChecking, setIsChecking] = useState(true);
  
  useEffect(() => {
    checkAuthStatus().then(() => setIsChecking(false));
  }, []);
  
  if (isChecking) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400">Loading...</div>
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

  return (
    <div className="h-screen flex bg-slate-950">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <div className="flex-1 overflow-hidden">
          <ChatView />
        </div>
        <StatusBar onOpenSettings={() => setSettingsOpen(true)} />
      </div>
      <ExtensionDialog
        request={extensionUIRequest}
        onResponse={(response) => {
          sendMessage({ type: 'extension_ui_response', response });
          setExtensionUIRequest(null);
        }}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default App;
