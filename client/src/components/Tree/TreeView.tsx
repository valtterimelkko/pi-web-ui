import { useState } from 'react';
import { GitBranch, X } from 'lucide-react';
import type { Message } from '../../store';
import { TreeNode } from './TreeNode';

// Tree entry type based on Pi SDK session.tree structure
export interface TreeEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  parentId?: string;
  children: string[];
  branches?: string[]; // IDs of forked branches
  label?: string;
}

interface TreeViewProps {
  entries: TreeEntry[];
  currentEntryId?: string;
  onNavigate?: (entryId: string) => void;
  onFork?: (entryId: string) => void;
  onClose?: () => void;
}

export function TreeView({
  entries,
  currentEntryId,
  onNavigate,
  onFork,
  onClose,
}: TreeViewProps) {
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(
    () => new Set(entries.map((e) => e.id))
  );

  // Build tree structure from flat entries
  const entryMap = new Map(entries.map((e) => [e.id, e]));
  const rootEntries = entries.filter((e) => !e.parentId);

  const toggleExpanded = (entryId: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  };

  if (entries.length === 0) {
    return (
      <div className="p-8 text-center">
        <GitBranch className="w-12 h-12 text-slate-600 mx-auto mb-4" />
        <p className="text-slate-400">No conversation tree available</p>
      </div>
    );
  }

  return (
    <div className="bg-slate-900 rounded-lg border border-slate-800">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <GitBranch className="w-5 h-5 text-violet-400" />
          <h3 className="text-lg font-semibold text-slate-200">
            Conversation Tree
          </h3>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        )}
      </div>

      {/* Tree */}
      <div className="p-4 max-h-[60vh] overflow-auto">
        <div className="space-y-1">
          {rootEntries.map((entry) => (
            <TreeNode
              key={entry.id}
              entry={entry}
              entries={entryMap}
              expandedEntries={expandedEntries}
              currentEntryId={currentEntryId}
              depth={0}
              onToggle={toggleExpanded}
              onNavigate={onNavigate}
              onFork={onFork}
            />
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="px-4 py-3 border-t border-slate-800 text-sm text-slate-500">
        {entries.length} entries • {rootEntries.length} root(s)
      </div>
    </div>
  );
}
