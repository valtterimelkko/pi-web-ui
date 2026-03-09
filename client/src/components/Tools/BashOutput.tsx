interface BashOutputProps {
  command: string;
  output: string;
  exitCode?: number;
  isStreaming?: boolean;
}

export function BashOutput({ command, output, exitCode, isStreaming }: BashOutputProps) {
  return (
    <div className="rounded-lg overflow-hidden bg-slate-950 border border-slate-800">
      {/* Command line */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-900 border-b border-slate-800">
        <span className="text-green-400">$</span>
        <span className="text-slate-300 font-mono text-sm">{command}</span>
      </div>
      
      {/* Output */}
      <pre className="p-3 text-sm font-mono text-slate-300 overflow-x-auto max-h-96">
        {output || (isStreaming ? '' : '(no output)')}
        {isStreaming && <span className="animate-pulse">▊</span>}
      </pre>
      
      {/* Exit code */}
      {exitCode !== undefined && (
        <div className={`
          px-3 py-1.5 text-xs font-mono border-t border-slate-800
          ${exitCode === 0 ? 'text-green-400 bg-green-900/10' : 'text-red-400 bg-red-900/10'}
        `}>
          Exit code: {exitCode}
        </div>
      )}
    </div>
  );
}
