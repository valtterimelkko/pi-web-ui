import { useState, useCallback, useEffect } from 'react';
import { 
  ChevronRight, 
  ChevronDown, 
  Folder, 
  FolderOpen, 
  FileText,
  RefreshCw,
  ArrowUp
} from 'lucide-react';
import { api } from '../../lib/api';

export interface FileItem {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size: number;
}

interface FileTreeProps {
  initialPath?: string;
  onFileSelect?: (path: string) => void;
  selectedPath?: string;
}

export function FileTree({ initialPath = '.', onFileSelect, selectedPath }: FileTreeProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [items, setItems] = useState<FileItem[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

interface BrowseResponse {
  items: FileItem[];
  path: string;
}

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get(`/files/browse?path=${encodeURIComponent(path)}`) as BrowseResponse;
      setItems(response.items);
      setCurrentPath(response.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load directory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleItemClick = (item: FileItem) => {
    if (item.type === 'directory') {
      setCurrentPath(item.path);
    } else {
      onFileSelect?.(item.path);
    }
  };

  const navigateUp = () => {
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    setCurrentPath(parent);
  };

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '-';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  return (
    <div className="bg-slate-900 rounded-lg border border-slate-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <button
            onClick={navigateUp}
            disabled={currentPath === '/'}
            className="p-1.5 hover:bg-slate-800 rounded disabled:opacity-30 transition-colors"
          >
            <ArrowUp className="w-4 h-4 text-slate-400" />
          </button>
          <span className="text-sm font-mono text-slate-400 truncate max-w-[200px]">
            {currentPath}
          </span>
        </div>
        <button
          onClick={() => loadDirectory(currentPath)}
          disabled={loading}
          className="p-1.5 hover:bg-slate-800 rounded transition-colors"
        >
          <RefreshCw className={`w-4 h-4 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-900/20 border-b border-red-900/50">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* File list */}
      <div className="max-h-64 overflow-y-auto">
        {items.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-slate-500">Empty directory</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {items.map((item) => (
              <button
                key={item.path}
                onClick={() => handleItemClick(item)}
                className={`
                  w-full flex items-center gap-3 px-3 py-2 text-left transition-colors
                  ${selectedPath === item.path ? 'bg-violet-600/20' : 'hover:bg-slate-800'}
                `}
              >
                {item.type === 'directory' ? (
                  expandedDirs.has(item.path) ? (
                    <>
                      <ChevronDown className="w-4 h-4 text-slate-500" />
                      <FolderOpen className="w-5 h-5 text-amber-400" />
                    </>
                  ) : (
                    <>
                      <ChevronRight className="w-4 h-4 text-slate-500" />
                      <Folder className="w-5 h-5 text-amber-400" />
                    </>
                  )
                ) : (
                  <>
                    <span className="w-4" />
                    <FileText className="w-5 h-5 text-slate-400" />
                  </>
                )}

                <span className="flex-1 text-sm text-slate-200 truncate">
                  {item.name}
                </span>

                {item.type === 'file' && (
                  <span className="text-xs text-slate-500">
                    {formatSize(item.size)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
