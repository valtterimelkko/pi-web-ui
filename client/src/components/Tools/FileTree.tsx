import { useState } from 'react';
import { Folder, FolderOpen, FileText, ChevronRight, ChevronDown } from 'lucide-react';

interface FileTreeItem {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  children?: FileTreeItem[];
}

interface FileTreeProps {
  items: FileTreeItem[];
  onFileClick?: (path: string) => void;
}

export function FileTree({ items, onFileClick }: FileTreeProps) {
  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 p-2">
      {items.map((item) => (
        <TreeNode key={item.path} item={item} depth={0} onFileClick={onFileClick} />
      ))}
    </div>
  );
}

interface TreeNodeProps {
  item: FileTreeItem;
  depth: number;
  onFileClick?: (path: string) => void;
}

function TreeNode({ item, depth, onFileClick }: TreeNodeProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const isDirectory = item.type === 'directory';

  return (
    <div>
      <button
        onClick={() => {
          if (isDirectory) {
            setIsExpanded(!isExpanded);
          } else {
            onFileClick?.(item.path);
          }
        }}
        className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-gray-100 text-left"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isDirectory ? (
          <>
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
            )}
            {isExpanded ? (
              <FolderOpen className="w-4 h-4 text-blue-500" />
            ) : (
              <Folder className="w-4 h-4 text-blue-500" />
            )}
          </>
        ) : (
          <>
            <span className="w-3.5" />
            <FileText className="w-4 h-4 text-gray-400" />
          </>
        )}

        <span className="text-sm text-gray-700">{item.name}</span>

        {item.size !== undefined && item.size > 0 && (
          <span className="text-xs text-gray-400 ml-auto">
            {formatSize(item.size)}
          </span>
        )}
      </button>

      {isDirectory && isExpanded && item.children && (
        <div>
          {item.children.map((child) => (
            <TreeNode
              key={child.path}
              item={child}
              depth={depth + 1}
              onFileClick={onFileClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
