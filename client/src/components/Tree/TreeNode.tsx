import { ChevronRight, ChevronDown, MessageSquare, User, GitFork } from 'lucide-react';
import type { TreeEntry } from './TreeView';

interface TreeNodeProps {
  entry: TreeEntry;
  entries: Map<string, TreeEntry>;
  expandedEntries: Set<string>;
  currentEntryId?: string;
  depth: number;
  onToggle: (entryId: string) => void;
  onNavigate?: (entryId: string) => void;
  onFork?: (entryId: string) => void;
}

export function TreeNode({
  entry,
  entries,
  expandedEntries,
  currentEntryId,
  depth,
  onToggle,
  onNavigate,
  onFork,
}: TreeNodeProps) {
  const isExpanded = expandedEntries.has(entry.id);
  const isCurrent = entry.id === currentEntryId;
  const hasChildren = entry.children.length > 0;
  const hasBranches = entry.branches && entry.branches.length > 0;

  const childEntries = entry.children
    .map((id) => entries.get(id))
    .filter(Boolean) as TreeEntry[];

  const handleClick = () => {
    if (hasChildren) {
      onToggle(entry.id);
    }
    onNavigate?.(entry.id);
  };

  return (
    <div>
      <div
        className={`
          group flex items-center gap-2 py-2 px-3 rounded-lg cursor-pointer transition-colors
          ${isCurrent
            ? 'bg-blue-50 border border-blue-200'
            : 'hover:bg-gray-50 border border-transparent'
          }
        `}
        style={{ marginLeft: `${depth * 24}px` }}
        onClick={handleClick}
      >
        {/* Expand/collapse */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle(entry.id);
          }}
          className={`
            w-5 h-5 flex items-center justify-center rounded transition-colors
            ${hasChildren ? 'hover:bg-gray-200' : 'invisible'}
          `}
        >
          {hasChildren && (isExpanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400" />
          ))}
        </button>

        {/* Icon */}
        <div className={`
          w-6 h-6 rounded flex items-center justify-center
          ${entry.role === 'user' ? 'bg-gray-200' : 'bg-blue-100'}
        `}>
          {entry.role === 'user' ? (
            <User className="w-3.5 h-3.5 text-gray-600" />
          ) : (
            <MessageSquare className="w-3.5 h-3.5 text-blue-600" />
          )}
        </div>

        {/* Content preview */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-700 truncate">
            {entry.label || entry.content.slice(0, 60) || 'Empty message'}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-gray-400">
              {new Date(entry.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            {hasBranches && (
              <span className="text-xs text-blue-600 flex items-center gap-1">
                <GitFork className="w-3 h-3" />
                {entry.branches!.length} branch{entry.branches!.length !== 1 ? 'es' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onFork && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFork(entry.id);
              }}
              className="p-1.5 hover:bg-blue-100 rounded transition-colors"
              title="Fork from here"
            >
              <GitFork className="w-4 h-4 text-blue-600" />
            </button>
          )}
        </div>

        {/* Current indicator */}
        {isCurrent && (
          <div className="w-2 h-2 bg-blue-500 rounded-full" />
        )}
      </div>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div className="mt-1">
          {childEntries.map((child) => (
            <TreeNode
              key={child.id}
              entry={child}
              entries={entries}
              expandedEntries={expandedEntries}
              currentEntryId={currentEntryId}
              depth={depth + 1}
              onToggle={onToggle}
              onNavigate={onNavigate}
              onFork={onFork}
            />
          ))}
        </div>
      )}
    </div>
  );
}
