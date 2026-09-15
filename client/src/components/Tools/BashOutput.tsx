import { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';

interface BashOutputProps {
  command: string;
  output: string;
  exitCode?: number;
  isStreaming?: boolean;
}

export function BashOutput({ command, output, exitCode, isStreaming }: BashOutputProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(command + (output ? '\n' + output : ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [command, output]);

  return (
    <div className="rounded-lg overflow-hidden bg-surface-subtle dark:bg-surface-dark-subtle border border-outline-default dark:border-outline-default-dark my-1.5 shadow-xs transition-colors">
      {/* Command line */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-surface dark:bg-surface-dark border-b border-outline-subtle dark:border-outline-subtle-dark">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-content-muted dark:text-content-muted-dark font-mono text-xs select-none">$</span>
          <span className="text-content-primary dark:text-content-primary-dark font-mono text-xs truncate">{command}</span>
        </div>
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-content-muted dark:text-content-muted-dark hover:text-content-primary dark:hover:text-content-primary-dark transition-colors shrink-0"
          title="Copy command and output"
          type="button"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>

      {/* Output */}
      <pre className="p-3 text-xs font-mono text-content-secondary dark:text-content-secondary-dark overflow-x-auto max-h-80 leading-relaxed">
        {output || (isStreaming ? '' : '(no output)')}
        {isStreaming && <span className="animate-pulse">▊</span>}
      </pre>

      {/* Exit code */}
      {exitCode !== undefined && (
        <div className={`
          px-3 py-1 text-[11px] font-mono border-t border-outline-subtle dark:border-outline-subtle-dark flex items-center gap-1.5
          ${exitCode === 0 ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/5' : 'text-red-600 dark:text-red-400 bg-red-500/5'}
        `}>
          <span className={`w-1.5 h-1.5 rounded-full ${exitCode === 0 ? 'bg-emerald-500' : 'bg-red-500'}`} />
          Exit code: {exitCode}
        </div>
      )}
    </div>
  );
}
