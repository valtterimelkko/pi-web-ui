import { useState } from 'react';
import { Folder, History, Loader2 } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';

export interface DriveModeFolderPickerProps {
  onSelectFolder: (path: string) => void;
  onBack: () => void;
}

export function DriveModeFolderPicker({ onSelectFolder, onBack }: DriveModeFolderPickerProps) {
  const [isCreating, setIsCreating] = useState(false);
  const { getRecentFolders } = useUIStore();
  const topRecentFolders = getRecentFolders(8);

  const handleSelect = (path: string) => {
    if (isCreating) return;
    setIsCreating(true);
    onSelectFolder(path);
  };

  return (
    <div className="flex flex-col items-center h-full w-full px-4 py-6">
      <h2 className="text-xl font-semibold text-center text-gray-900 dark:text-gray-100 mb-6">
        Choose a Folder
      </h2>

      <div className="w-full max-w-[90%] flex-1 flex flex-col gap-4 overflow-y-auto">
        {topRecentFolders.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
              <History className="w-4 h-4" />
              <span className="text-sm font-medium">Recent Folders</span>
            </div>
            <div className="flex flex-col gap-2">
              {topRecentFolders.map((folder) => (
                <button
                  key={folder.path}
                  onClick={() => handleSelect(folder.path)}
                  disabled={isCreating}
                  className="w-full flex items-center gap-3 p-4 rounded-xl border-2 border-gray-200 dark:border-gray-700 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 active:scale-[0.98] select-none touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed"
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
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400 text-center text-sm">
            No recent folders. Start a session from the main app to populate this list.
          </div>
        )}
      </div>

      <div className="mt-auto pt-6 w-full max-w-[90%] flex items-center justify-center">
        <button
          onClick={onBack}
          disabled={isCreating}
          className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
          type="button"
        >
          Back
        </button>
      </div>

      {isCreating && (
        <div className="absolute inset-0 bg-white/80 dark:bg-gray-950/80 flex items-center justify-center z-10">
          <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm font-medium">Creating session...</span>
          </div>
        </div>
      )}
    </div>
  );
}
