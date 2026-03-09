import { useEffect, useState } from 'react';
import { useAuth, checkAuthStatus } from './hooks/useAuth';
import { LoginForm } from './components/Auth/LoginForm';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/Chat';

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
  
  return (
    <div className="h-screen flex bg-slate-950">
      <Sidebar />
      <div className="flex-1">
        <ChatView />
      </div>
    </div>
  );
}

export default App;
