interface BashOutputProps {
  command: string;
  output: string;
  exitCode?: number;
  isStreaming?: boolean;
}

export function BashOutput({ command, output, exitCode, isStreaming }: BashOutputProps) {
  return (
    <div className="rounded-lg overflow-hidden bg-gray-50 border border-gray-200">
      {/* Command line */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 border-b border-gray-200">
        <span className="text-green-600">$</span>
        <span className="text-gray-700 font-mono text-sm">{command}</span>
      </div>

      {/* Output */}
      <pre className="p-3 text-sm font-mono text-gray-700 overflow-x-auto max-h-96">
        {output || (isStreaming ? '' : '(no output)')}
        {isStreaming && <span className="animate-pulse">▊</span>}
      </pre>

      {/* Exit code */}
      {exitCode !== undefined && (
        <div className={`
          px-3 py-1.5 text-xs font-mono border-t border-gray-200
          ${exitCode === 0 ? 'text-green-600 bg-green-50' : 'text-red-600 bg-red-50'}
        `}>
          Exit code: {exitCode}
        </div>
      )}
    </div>
  );
}
