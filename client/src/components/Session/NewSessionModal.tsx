import { useState, useEffect, useRef } from 'react';
import { X, Folder, FolderOpen, ChevronRight, Loader2, Home, FolderCog } from 'lucide-react';
import { api } from '../../lib/api';

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateSession: (cwd?: string) => void;
}

interface DirectoryInfo {
  path: string;
  name: string;
  isDirectory: boolean;
}

export function NewSessionModal({ isOpen, onClose, onCreateSession }: NewSessionModalProps) {
  const [currentPath, setCurrentPath] = useState<string>('/');
  const [directories, setDirectories] = useState<DirectoryInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathHistory, setPathHistory] = useState<string[]>(['/']);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch directories for the current path
  const fetchDirectories = async (path: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.get(`/api/files/browse?path=${encodeURIComponent(path)}`) as {
        entries: Array<{ name: string; path: string; isDirectory: boolean }>;
        currentPath: string;
      };
      
      // Filter only directories and sort alphabetically
      const dirs = (response.entries || [])
        .filter((entry) => entry.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name));
      
      setDirectories(dirs);
      setCurrentPath(response.currentPath || path);
    } catch (err) {
      console.error('Failed to fetch directories:', err);
      setError('Failed to load directories. Please check the path.');
      setDirectories([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Load initial directory
  useEffect(() => {
    if (isOpen) {
      fetchDirectories('/');
    }
  }, [isOpen]);

  const handleNavigate = (dir: DirectoryInfo) => {
    const newPath = dir.path;
    setPathHistory((prev) => [...prev, newPath]);
    fetchDirectories(newPath);
  };

  const handleNavigateUp = () => {
    if (pathHistory.length > 1) {
      const newHistory = pathHistory.slice(0, -1);
      setPathHistory(newHistory);
      fetchDirectories(newHistory[newHistory.length - 1]);
    }
  };

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputRef.current?.value) {
      fetchDirectories(inputRef.current.value);
    }
  };

  const handleSelectAndCreate = () => {
    onCreateSession(currentPath);
    onClose();
  };

  const handleQuickSelect = (path: string) => {
    onCreateSession(path);
    onClose();
  };

  if (!isOpen) return null;

  // Common workspace suggestions
  const quickWorkspaces = [
    { path: '/root', label: 'Root Home', icon: Home },
    { path: '/root/pi-web-ui', label: 'Pi Web UI', icon: FolderCog },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" data-testid="new-session-modal">
      <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">New Session</h2>
            <p className="text-sm text-slate-400">Select a workspace folder for your new session</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Quick Select */}
        <div className="p-4 border-b border-slate-800">
          <p className="text-xs text-slate-500 uppercase mb-2">Quick Select</p>
          <div className="flex flex-wrap gap-2">
            {quickWorkspaces.map((workspace) => {
              const Icon = workspace.icon;
              return (
                <button
                  key={workspace.path}
                  onClick={() => handleQuickSelect(workspace.path)}
                  className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300 transition-colors"
                >
                  <Icon className="w-4 h-4 text-violet-400" />
                  <span>{workspace.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Path Input */}
        <div className="p-4 border-b border-slate-800">
          <form onSubmit={handlePathSubmit} className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              defaultValue={currentPath}
              placeholder="Enter path..."
              className="flex-1 px-3 py-2 bg-slate-800 rounded-lg text-sm text-slate-200 placeholder-slate-500 border border-slate-700 focus:border-violet-500 focus:outline-none"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-slate-200 transition-colors"
            >
              Go
            </button>
          </form>
        </div>

        {/* Directory Browser */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Breadcrumb / Current Path */}
          <div className="px-4 py-2 bg-slate-800/50 border-b border-slate-800 flex items-center gap-2">
            <button
              onClick={() => fetchDirectories('/')}
              className="p-1 hover:bg-slate-700 rounded transition-colors"
              title="Go to root"
            >
              <Folder className="w-4 h-4 text-slate-400" />
            </button>
            {pathHistory.length > 1 && (
              <button
                onClick={handleNavigateUp}
                className="p-1 hover:bg-slate-700 rounded transition-colors text-sm text-slate-400"
              >
                ..
              </button>
            )}
            <ChevronRight className="w-4 h-4 text-slate-600" />
            <span className="text-sm text-slate-300 truncate flex-1">{currentPath}</span>
          </div>

          {/* Directory List */}
          <div className="flex-1 overflow-y-auto p-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
              </div>
            ) : error ? (
              <div className="text-center py-8 text-red-400 text-sm">{error}</div>
            ) : directories.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">
                No subdirectories found
              </div>
            ) : (
              <div className="space-y-1">
                {directories.map((dir) => (
                  <button
                    key={dir.path}
                    onClick={() => handleNavigate(dir)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-800 rounded-lg transition-colors text-left"
                  >
                    <FolderOpen className="w-5 h-5 text-violet-400" />
                    <span className="text-sm text-slate-200 truncate">{dir.name}</span>
                    <ChevronRight className="w-4 h-4 text-slate-500 ml-auto" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 p-4 border-t border-slate-800">
          <p className="text-xs text-slate-500">
            Selected: <span className="text-slate-400">{currentPath}</span>
          </p>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-slate-400 hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSelectAndCreate}
              className="px-4 py-2 bg-violet-600 hover:bg-violet-700 rounded-lg text-white transition-colors"
            >
              Create Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
