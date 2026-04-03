import { useState } from 'react';

interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  refs: string;
}

interface GitLogProps {
  entries: GitLogEntry[];
}

export function GitLog({ entries }: GitLogProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (entries.length === 0) {
    return <div className="px-3 py-4 text-center text-xs text-gray-400 dark:text-gray-500">No commits yet</div>;
  }

  return (
    <div className="space-y-0">
      {entries.map((entry) => (
        <div
          key={entry.hash}
          className="border-b border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
          onClick={() => setExpanded(expanded === entry.hash ? null : entry.hash)}
        >
          <div className="px-3 py-2">
            <div className="flex items-start gap-2">
              <code className="text-xs font-mono text-blue-500 dark:text-blue-400 flex-shrink-0">
                {entry.shortHash}
              </code>
              <span className="text-xs text-gray-700 dark:text-gray-300 flex-1 truncate">
                {entry.message}
              </span>
            </div>
            {expanded === entry.hash && (
              <div className="mt-1 space-y-0.5 pl-7">
                <div className="text-xs text-gray-500 dark:text-gray-400">{entry.author}</div>
                <div className="text-xs text-gray-400 dark:text-gray-500">{entry.date}</div>
                {entry.refs && (
                  <div className="text-xs text-orange-500 dark:text-orange-400">{entry.refs}</div>
                )}
                <code className="text-xs font-mono text-gray-400 dark:text-gray-500">{entry.hash}</code>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
