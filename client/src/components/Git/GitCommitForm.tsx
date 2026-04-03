import { useState } from 'react';
import { GitCommit, ArrowUp, ArrowDown } from 'lucide-react';

interface GitCommitFormProps {
  onCommit: (message: string) => Promise<void>;
  onPush: () => Promise<void>;
  onPull: () => Promise<void>;
  isLoading: boolean;
  ahead: number;
  behind: number;
}

export function GitCommitForm({ onCommit, onPush, onPull, isLoading, ahead, behind }: GitCommitFormProps) {
  const [message, setMessage] = useState('');
  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);

  const handleCommit = async () => {
    if (!message.trim()) return;
    await onCommit(message.trim());
    setMessage('');
  };

  const handlePush = async () => {
    setIsPushing(true);
    try { await onPush(); } finally { setIsPushing(false); }
  };

  const handlePull = async () => {
    setIsPulling(true);
    try { await onPull(); } finally { setIsPulling(false); }
  };

  return (
    <div className="p-3 space-y-2">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Commit message..."
        className="w-full text-xs resize-none rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 p-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
        rows={3}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) handleCommit();
        }}
      />
      <div className="flex gap-2">
        <button
          onClick={handleCommit}
          disabled={!message.trim() || isLoading}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 dark:disabled:bg-gray-700 text-white disabled:text-gray-400 text-xs font-medium rounded-md transition-colors"
        >
          <GitCommit size={12} />
          Commit
        </button>
        <button
          onClick={handlePull}
          disabled={isPulling}
          className="flex items-center gap-1 px-2 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs rounded-md transition-colors"
          title={`Pull (${behind} behind)`}
        >
          <ArrowDown size={12} />
          {behind > 0 && <span className="text-orange-500">{behind}</span>}
        </button>
        <button
          onClick={handlePush}
          disabled={isPushing || ahead === 0}
          className="flex items-center gap-1 px-2 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 text-gray-700 dark:text-gray-300 text-xs rounded-md transition-colors"
          title={`Push (${ahead} ahead)`}
        >
          <ArrowUp size={12} />
          {ahead > 0 && <span className="text-blue-500">{ahead}</span>}
        </button>
      </div>
    </div>
  );
}
