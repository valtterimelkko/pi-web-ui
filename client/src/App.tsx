import { useEffect, useState } from 'react';
import { useAuth, checkAuthStatus } from './hooks/useAuth';
import { LoginForm } from './components/Auth/LoginForm';

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
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="flex h-screen">
        {/* Main content area */}
        <main className="flex-1 p-4">
          <h1 className="text-2xl font-bold mb-4">Pi Web UI</h1>
          <p className="text-slate-400">Chat interface will be implemented in Wave 3</p>
        </main>
      </div>
    </div>
  );
}

export default App;
