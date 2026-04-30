import { useState, useEffect } from 'react';
import { Folder, FolderOpen, ChevronRight, Loader2, ArrowUp, History } from 'lucide-react';
import { api } from '../../lib/api';
import { useUIStore } from '../../store/uiStore';

interface DirectoryItem {
  name: string;
  path: string;
}

export interface DriveModeFolderPickerProps {
  onSelectFolder: (path: string) => void;
  onBack: () => void;
}

export function DriveModeFolderPicker({ onSelectFolder, onBack }: DriveModeFolderPickerProps) {
  const [currentPath, setCurrentPath] = useState<string>('/root');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const { getRecentFolders } = useUIStore();
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
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Access denied or path not found. (${errorMsg})`);
      setDirectories([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDirectories('/root');
  }, []);

  const handleNavigate = (dir: DirectoryItem) => {
    fetchDirectories(dir.path);
  };

  const handleNavigateUp = () => {
    if (parentPath) {
      fetchDirectories(parentPath);
    }
  };

  const handleSelectRecent = (path: string) => {
    setSelectedPath(path);
    fetchDirectories(path);
  };

  const handleConfirm = () => {
    const path = selectedPath || currentPath;
    if (isCreating) return;
    setIsCreating(true);
    onSelectFolder(path);
  };

  const isConfirmEnabled = !isCreating;

  return (
    <div className="flex flex-col items-center h-full w-full px-4 py-6">
      <h2 className="text-xl font-semibold text-center text-gray-900 dark:text-gray-100 mb-6">
        Choose a Folder
      </h2>

      <div className="w-full max-w-[90%] flex-1 flex flex-col gap-4 overflow-y-auto">
        {/* Recent Folders */}
        {topRecentFolders.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
              <History className="w-4 h-4" />
              <span className="text-sm font-medium">Recent Folders</span>
            </div>
            <div className="flex flex-col gap-2">
              {topRecentFolders.map((folder) => (
                <button
                  key={folder.path}
                  onClick={() => handleSelectRecent(folder.path)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-colors ${
                    selectedPath === folder.path
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                      : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                  type="button"
                >
                  <Folder className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {folder.label}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {folder.path}
                    </p>
                  </div>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                    Select
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Browse Section */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
            <FolderOpen className="w-4 h-4" />
            <span className="text-sm font-medium">Browse</span>
          </div>

          {/* Breadcrumb */}
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
            {parentPath && (
              <button
                onClick={handleNavigateUp}
                className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors flex-shrink-0"
                title="Go up"
                type="button"
              >
                <ArrowUp className="w-4 h-4 text-gray-400 dark:text-gray-500" />
              </button>
            )}
            <ChevronRight className="w-4 h-4 text-gray-300 dark:text-gray-600 flex-shrink-0" />
            <span className="text-sm text-gray-700 dark:text-gray-300 truncate">{currentPath}</span>
          </div>

          {/* Directory List */}
          <div className="flex flex-col min-h-[100px]">
            {isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-6 h-6 text-blue-600 dark:text-blue-400 animate-spin" />
              </div>
            ) : error ? (
              <div className="text-center py-6">
                <p className="text-red-500 text-sm mb-3">{error}</p>
                <button
                  onClick={() => fetchDirectories('/root')}
                  className="text-blue-600 dark:text-blue-400 text-sm hover:underline"
                  type="button"
                >
                  Reset to /root
                </button>
              </div>
            ) : directories.length === 0 ? (
              <div className="text-center py-6 text-gray-400 dark:text-gray-500 text-sm">
                No subdirectories. Use this folder or select a recent folder.
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {directories.map((dir) => (
                  <button
                    key={dir.path}
                    onClick={() => handleNavigate(dir)}
                    className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 active:bg-gray-200 dark:active:bg-gray-700 rounded-lg transition-colors text-left"
                    type="button"
                  >
                    <FolderOpen className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                    <span className="text-sm text-gray-700 dark:text-gray-300 truncate flex-1">{dir.name}</span>
                    <ChevronRight className="w-4 h-4 text-gray-300 dark:text-gray-600 flex-shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Select This Folder */}
          <button
            onClick={() => {
              setSelectedPath(currentPath);
              handleConfirm();
            }}
            disabled={!isConfirmEnabled}
            className={`w-full mt-2 px-4 py-3 rounded-xl text-sm font-medium transition-colors border-2 ${
              isConfirmEnabled
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/50'
                : 'border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed'
            }`}
            type="button"
          >
            {isCreating ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating Session...
              </span>
            ) : (
              'Select This Folder'
            )}
          </button>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-auto pt-6 w-full max-w-[90%] flex items-center justify-between">
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          type="button"
        >
          Back
        </button>
        <button
          onClick={handleConfirm}
          disabled={!isConfirmEnabled}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            isConfirmEnabled
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500'
          }`}
          type="button"
        >
          {isCreating ? 'Creating...' : 'Create Session'}
        </button>
      </div>
    </div>
  );
}
