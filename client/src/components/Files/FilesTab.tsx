import { useEffect, useState } from 'react';
import {
  FolderOpen,
  File,
  ChevronRight,
  RefreshCw,
  Plus,
  Folder,
  Trash2,
  Edit,
  ArrowUp,
  AlertCircle,
  Search,
  X,
} from 'lucide-react';
import { useFilesStore, type FileEntry } from '../../store/filesStore';
import { useSessionStore } from '../../store/sessionStore';

// ── helpers ────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

function FileIcon({ entry }: { entry: FileEntry }) {
  return entry.isDirectory
    ? <Folder size={14} className="text-blue-400 flex-shrink-0" />
    : <File   size={14} className="text-gray-400 flex-shrink-0" />;
}

// ── component ─────────────────────────────────────────────────────────────

export function FilesTab() {
  const {
    currentPath,
    items,
    selectedFile,
    previewContent,
    isLoading,
    error,
    navigate,
    refresh,
    selectFile,
    createFile,
    createDir,
    renameItem,
    deleteItem,
  } = useFilesStore();

  const [searchFilter, setSearchFilter] = useState('');
  const [newItemName, setNewItemName]   = useState('');
  const [newItemType, setNewItemType]   = useState<'file' | 'dir' | null>(null);
  const [renaming, setRenaming]         = useState<string | null>(null);
  const [renameValue, setRenameValue]   = useState('');

  // Use the CWD of the currently active session as the initial path.
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions         = useSessionStore((s) => s.sessions);
  const session          = sessions.find((s) => s.id === currentSessionId);

  useEffect(() => {
    const startPath = session?.cwd || '/root';
    navigate(startPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.cwd]);

  // ── derived ──────────────────────────────────────────────────────────────

  const parts = currentPath.split('/').filter(Boolean);

  const filteredItems = items.filter((item) =>
    item.name.toLowerCase().includes(searchFilter.toLowerCase()),
  );

  const sortedItems = [...filteredItems].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  // ── handlers ─────────────────────────────────────────────────────────────

  const handleNavigate = (item: FileEntry) => {
    if (item.isDirectory) {
      navigate(item.path);
    } else {
      selectFile(item.path);
    }
  };

  const handleGoUp = () => {
    const parent = parts.length > 0
      ? '/' + parts.slice(0, -1).join('/')
      : '/';
    navigate(parent || '/');
  };

  const handleBreadcrumb = (index: number) => {
    // index 0 → '/', index 1 → '/parts[0]', etc.
    const path = index === 0 ? '/' : '/' + parts.slice(0, index).join('/');
    navigate(path);
  };

  const handleCreateNew = async () => {
    if (!newItemName.trim() || !newItemType) return;
    const fullPath = `${currentPath}/${newItemName.trim()}`;
    if (newItemType === 'file') {
      await createFile(fullPath);
    } else {
      await createDir(fullPath);
    }
    setNewItemName('');
    setNewItemType(null);
  };

  const handleStartRename = (item: FileEntry) => {
    setRenaming(item.path);
    setRenameValue(item.name);
  };

  const handleRename = async () => {
    if (!renaming || !renameValue.trim()) return;
    const newPath = `${currentPath}/${renameValue.trim()}`;
    await renameItem(renaming, newPath);
    setRenaming(null);
    setRenameValue('');
  };

  const handleDelete = async (item: FileEntry) => {
    if (window.confirm(`Delete "${item.name}"?`)) {
      await deleteItem(item.path);
    }
  };

  const handleClosePreview = () => {
    useFilesStore.setState({ selectedFile: null, previewContent: null });
  };

  // ── render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950">

      {/* ── Header ── */}
      <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-800">

        {/* Breadcrumb row */}
        <div className="flex items-center gap-1 px-3 py-2 overflow-x-auto">
          <button
            onClick={handleGoUp}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex-shrink-0"
            title="Go up"
          >
            <ArrowUp size={14} />
          </button>

          {/* Root segment */}
          <button
            onClick={() => handleBreadcrumb(0)}
            className="text-xs text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 flex-shrink-0"
          >
            /
          </button>

          {parts.map((part, i) => (
            <div key={i} className="flex items-center gap-1 flex-shrink-0">
              <ChevronRight size={12} className="text-gray-300 dark:text-gray-600" />
              <button
                onClick={() => handleBreadcrumb(i + 1)}
                className="text-xs text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
              >
                {part}
              </button>
            </div>
          ))}

          {/* Toolbar */}
          <div className="ml-auto flex items-center gap-1 flex-shrink-0">
            <button
              onClick={refresh}
              disabled={isLoading}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setNewItemType('file')}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              title="New file"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={() => setNewItemType('dir')}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              title="New folder"
            >
              <FolderOpen size={14} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 px-2 py-1 bg-gray-50 dark:bg-gray-900 rounded-md">
            <Search size={12} className="text-gray-400 flex-shrink-0" />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Filter files…"
              className="flex-1 text-xs bg-transparent text-gray-700 dark:text-gray-300 placeholder-gray-400 focus:outline-none"
            />
          </div>
        </div>

        {/* New-item input */}
        {newItemType && (
          <div className="px-3 pb-2 flex items-center gap-2">
            <input
              type="text"
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              placeholder={newItemType === 'file' ? 'filename.txt' : 'folder-name'}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter')  handleCreateNew();
                if (e.key === 'Escape') { setNewItemType(null); setNewItemName(''); }
              }}
              className="flex-1 text-xs px-2 py-1 border border-blue-300 dark:border-blue-700 rounded-md bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleCreateNew}
              className="text-xs px-2 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Create
            </button>
            <button
              onClick={() => { setNewItemType(null); setNewItemName(''); }}
              className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-950 border-b border-red-200 dark:border-red-800 flex-shrink-0">
          <AlertCircle size={12} className="text-red-500 flex-shrink-0" />
          <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
        </div>
      )}

      {/* ── Body: list + preview ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* File list */}
        <div className={`flex-shrink-0 overflow-y-auto border-r border-gray-100 dark:border-gray-800 ${selectedFile ? 'w-64' : 'w-full'}`}>
          {sortedItems.map((item) => (
            <div
              key={item.path}
              className={`group flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${selectedFile === item.path ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
              onClick={() => handleNavigate(item)}
            >
              <FileIcon entry={item} />

              <div className="flex-1 min-w-0">
                {renaming === item.path ? (
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.stopPropagation(); handleRename(); }
                      if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); setRenameValue(''); }
                    }}
                    className="w-full text-xs px-1 py-0.5 border border-blue-400 rounded bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 focus:outline-none"
                  />
                ) : (
                  <span className="text-xs text-gray-700 dark:text-gray-300 truncate block">
                    {item.name}
                  </span>
                )}
                <div className="flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500">
                  {!item.isDirectory && <span>{formatSize(item.size)}</span>}
                  <span>{formatDate(item.modifiedAt)}</span>
                </div>
              </div>

              {/* Row actions (files only) */}
              {!item.isDirectory && (
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleStartRename(item); }}
                    className="p-1 text-gray-400 hover:text-blue-500"
                    title="Rename"
                  >
                    <Edit size={12} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); void handleDelete(item); }}
                    className="p-1 text-gray-400 hover:text-red-500"
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>
          ))}

          {sortedItems.length === 0 && !isLoading && (
            <div className="px-3 py-8 text-center text-xs text-gray-400 dark:text-gray-500">
              {searchFilter ? 'No matching files' : 'Empty directory'}
            </div>
          )}
        </div>

        {/* Preview panel */}
        {selectedFile && (
          <div className="flex-1 overflow-hidden flex flex-col min-w-0">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
              <span className="text-xs text-gray-500 truncate">
                {selectedFile.split('/').pop()}
              </span>
              <button
                onClick={handleClosePreview}
                className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 flex-shrink-0"
                title="Close preview"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              {previewContent !== null ? (
                <pre className="text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">
                  {previewContent.slice(0, 50_000)}
                  {previewContent.length > 50_000 && '\n… (truncated)'}
                </pre>
              ) : (
                <div className="text-xs text-gray-400">Loading preview…</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
