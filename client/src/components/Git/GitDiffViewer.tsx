interface GitDiffViewerProps {
  diff: string;
}

export function GitDiffViewer({ diff }: GitDiffViewerProps) {
  if (!diff) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-gray-400 dark:text-gray-500">
        Select a file to view diff
      </div>
    );
  }

  const lines = diff.split('\n');
  return (
    <div className="overflow-auto h-full font-mono text-xs">
      {lines.map((line, i) => {
        let cls = 'text-gray-600 dark:text-gray-400';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400';
        else if (line.startsWith('@@')) cls = 'text-blue-500 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/10';
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) cls = 'text-gray-500 dark:text-gray-500';
        return (
          <div key={i} className={`px-3 py-0.5 whitespace-pre ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}
