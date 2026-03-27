import { useState, useEffect, useRef } from 'react';
import { X, Folder, FolderOpen, ChevronRight, Loader2, Home, FolderCog, ArrowUp, History, ChevronDown, ChevronUp, Star } from 'lucide-react';
import { api } from '../../lib/api';
import { useUIStore } from '../../store/uiStore';

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateSession: (cwd?: string) => void;
}

interface DirectoryItem {
  name: string;
  path: string;
}

export function NewSessionModal({ isOpen, onClose, onCreateSession }: NewSessionModalProps) {
  const [currentPath, setCurrentPath] = useState<string>('/root');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRecentFolders, setShowRecentFolders] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const recentDropdownRef = useRef<HTMLDivElement>(null);

  const { recentFolders, addRecentFolder, getRecentFolders } = useUIStore();
  const topRecentFolders = getRecentFolders(8);

  const fetchDirectories = async (path: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.get(`/api/files/browse?path=${encodeURIComponent(path)}`) as {
        path: string;
        parent: string | null;
        items: Array<{ name: string; type: string; path: string }>;
      };

      const dirs = (response.items || [])
        .filter((entry) => entry.type === 'directory')
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      setDirectories(dirs);
      setCurrentPath(response.path || path);
      setParentPath(response.parent);
    } catch (err) {
      console.error('Failed to fetch directories:', err);
      setError('Access denied or path not found. Try a different path.');
      setDirectories([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchDirectories('/root');
      setShowRecentFolders(true);
      setIsCreating(false);
    }
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (recentDropdownRef.current && !recentDropdownRef.current.contains(event.target as Node)) {
        // Don't close - let user toggle manually
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNavigate = (dir: DirectoryItem) => {
    fetchDirectories(dir.path);
  };

  const handleNavigateUp = () => {
    if (parentPath) {
      fetchDirectories(parentPath);
    }
  };

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputRef.current?.value) {
      fetchDirectories(inputRef.current.value);
    }
  };

  const handleSelectAndCreate = async () => {
    if (isCreating) return;
    setIsCreating(true);
    addRecentFolder(currentPath);
    onCreateSession(currentPath);
    // Don't set isCreating to false here - the modal will close
  };

  const handleQuickSelect = async (path: string) => {
    if (isCreating) return;
    setIsCreating(true);
    addRecentFolder(path);
    onCreateSession(path);
  };

  const handleRecentFolderSelect = (path: string) => {
    if (isCreating) return;
    addRecentFolder(path);
    fetchDirectories(path);
  };

  const handleCreateInRecentFolder = (e: React.MouseEvent, path: string) => {
    if (isCreating) return;
    e.stopPropagation();
    setIsCreating(true);
    addRecentFolder(path);
    onCreateSession(path);
  };

  // Close on Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const quickWorkspaces = [
    { path: '/root', label: 'Root Home', icon: Home },
    { path: '/root/pi-web-ui', label: 'Pi Web UI', icon: FolderCog },
  ];

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" data-testid="new-session-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Create New Session</h2>
            <p className="text-sm text-gray-500">Select a workspace folder for your new session</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Recent Folders Section */}
        {recentFolders.length > 0 && (
          <div className="border-b border-gray-200" ref={recentDropdownRef}>
            <button
              onClick={() => setShowRecentFolders(!showRecentFolders)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-teal-600" />
                <span className="text-sm font-medium text-gray-700">Recent Projects</span>
                <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                  {recentFolders.length}
                </span>
              </div>
              {showRecentFolders ? (
                <ChevronUp className="w-4 h-4 text-gray-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-gray-400" />
              )}
            </button>
            
            {showRecentFolders && (
              <div className="px-4 pb-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {topRecentFolders.map((folder, index) => (
                    <div
                      key={folder.path}
                      className="group flex items-center gap-2 p-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg cursor-pointer transition-all"
                      onClick={() => handleRecentFolderSelect(folder.path)}
                    >
                      <div className="flex-shrink-0 w-8 h-8 bg-teal-100 rounded-lg flex items-center justify-center">
                        {index === 0 ? (
                          <Star className="w-4 h-4 text-teal-600 fill-teal-600" />
                        ) : (
                          <Folder className="w-4 h-4 text-teal-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-700 truncate" title={folder.label}>
                          {folder.label}
                        </p>
                        <p className="text-xs text-gray-400 truncate" title={folder.path}>
                          {folder.path}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <span className="text-xs text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded">
                          {folder.count}
                        </span>
                        <button
                          onClick={(e) => handleCreateInRecentFolder(e, folder.path)}
                          disabled={isCreating}
                          className="px-2 py-1 bg-teal-600 hover:bg-teal-700 disabled:bg-teal-400 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
                        >
                          {isCreating ? '...' : 'Create'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Quick Select */}
        <div className="p-4 border-b border-gray-200">
          <p className="text-xs text-gray-400 uppercase font-medium mb-2">Quick Select</p>
          <div className="flex flex-wrap gap-2">
            {quickWorkspaces.map((workspace) => {
              const Icon = workspace.icon;
              return (
                <button
                  key={workspace.path}
                  onClick={() => handleQuickSelect(workspace.path)}
                  disabled={isCreating}
                  className="flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed border border-gray-200 rounded-lg text-sm text-gray-700 transition-colors"
                >
                  <Icon className="w-4 h-4 text-teal-600" />
                  <span>{workspace.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Path Input */}
        <div className="p-4 border-b border-gray-200">
          <form onSubmit={handlePathSubmit} className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              defaultValue={currentPath}
              placeholder="Enter path..."
              className="flex-1 px-3 py-2 bg-gray-50 rounded-lg text-sm text-gray-900 placeholder-gray-400 border border-gray-200 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 text-base"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm text-gray-700 transition-colors border border-gray-200"
            >
              Go
            </button>
          </form>
        </div>

        {/* Directory Browser */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-[200px]">
          {/* Breadcrumb */}
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
            <Folder className="w-4 h-4 text-teal-600" />
            {parentPath && (
              <button
                onClick={handleNavigateUp}
                className="p-1 hover:bg-gray-200 rounded transition-colors"
                title="Go up"
              >
                <ArrowUp className="w-4 h-4 text-gray-400" />
              </button>
            )}
            <ChevronRight className="w-4 h-4 text-gray-300" />
            <span className="text-sm text-gray-700 truncate flex-1">{currentPath}</span>
          </div>

          {/* Directory List */}
          <div className="flex-1 overflow-y-auto p-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-teal-600 animate-spin" />
              </div>
            ) : error ? (
              <div className="text-center py-8">
                <p className="text-red-500 text-sm mb-4">{error}</p>
                <button
                  onClick={() => fetchDirectories('/root')}
                  className="text-teal-600 text-sm hover:underline"
                >
                  Reset to /root
                </button>
              </div>
            ) : directories.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">
                No subdirectories found. Use this folder or enter a custom path.
              </div>
            ) : (
              <div className="space-y-0.5">
                {directories.map((dir) => (
                  <button
                    key={dir.path}
                    onClick={() => handleNavigate(dir)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-100 rounded-lg transition-colors text-left"
                  >
                    <FolderOpen className="w-5 h-5 text-teal-600" />
                    <span className="text-sm text-gray-700 truncate">{dir.name}</span>
                    <ChevronRight className="w-4 h-4 text-gray-300 ml-auto" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 p-4 border-t border-gray-200">
          <p className="text-xs text-gray-400">
            Selected: <span className="text-gray-600 font-mono">{currentPath}</span>
          </p>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={isCreating}
              className="px-4 py-2 text-gray-500 hover:text-gray-700 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSelectAndCreate}
              disabled={isCreating}
              className="px-4 py-2 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed rounded-lg text-white transition-colors flex items-center gap-2"
            >
              {isCreating && <Loader2 className="w-4 h-4 animate-spin" />}
              {isCreating ? 'Creating...' : 'Create Session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
