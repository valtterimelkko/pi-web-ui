import { GitBranch, ChevronDown } from 'lucide-react';
import { useState } from 'react';

interface Branch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

interface GitBranchSelectorProps {
  current: string;
  branches: Branch[];
  onCheckout: (branch: string) => void;
}

export function GitBranchSelector({ current, branches, onCheckout }: GitBranchSelectorProps) {
  const [open, setOpen] = useState(false);
  const localBranches = branches.filter((b) => !b.isRemote);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 bg-gray-100 dark:bg-gray-800 rounded-md transition-colors"
      >
        <GitBranch size={12} />
        <span className="max-w-[120px] truncate">{current || 'HEAD'}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-20 min-w-[160px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 max-h-48 overflow-y-auto">
            {localBranches.map((b) => (
              <button
                key={b.name}
                onClick={() => { onCheckout(b.name); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${b.isCurrent ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-gray-300'}`}
              >
                {b.isCurrent ? '✓ ' : '  '}{b.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
