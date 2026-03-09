import { useState } from 'react';
import { Terminal, CheckCircle, XCircle, ChevronDown, ChevronRight } from 'lucide-react';

interface ToolCallCardProps {
  name: string;
  args: unknown;
  result?: {
    output: string;
    isError: boolean;
  } | null;
}

export function ToolCallCard({ name, args, result }: ToolCallCardProps) {
  const [showArgs, setShowArgs] = useState(false);
  const [showResult, setShowResult] = useState(true);

  const hasResult = result !== undefined && result !== null;
  const isError = hasResult && result.isError;
  const isSuccess = hasResult && !result.isError;
  const isPending = !hasResult;

  // Format arguments for display
  const formatArgs = (): string => {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  };

  // Format result for display
  const formatResult = (): string => {
    if (!result) return '';
    try {
      // Try to parse as JSON for formatting
      const parsed = JSON.parse(result.output);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return result.output;
    }
  };

  return (
    <div className="w-full border border-slate-700 rounded-xl overflow-hidden bg-slate-900/50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-800/80 border-b border-slate-700">
        <div className="flex items-center gap-3">
          <div className={`p-1.5 rounded-lg ${
            isError ? 'bg-red-500/20' : 
            isSuccess ? 'bg-emerald-500/20' : 
            'bg-amber-500/20'
          }`}>
            <Terminal className={`w-4 h-4 ${
              isError ? 'text-red-400' : 
              isSuccess ? 'text-emerald-400' : 
              'text-amber-400'
            }`} />
          </div>
          <div>
            <span className="font-mono text-sm font-medium text-slate-200">
              {name}
            </span>
            {isPending && (
              <span className="ml-2 text-xs text-amber-400 animate-pulse">
                Running...
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Status icon */}
          {isSuccess && (
            <CheckCircle className="w-4 h-4 text-emerald-400" />
          )}
          {isError && (
            <XCircle className="w-4 h-4 text-red-400" />
          )}
        </div>
      </div>

      {/* Arguments section */}
      <div className="border-b border-slate-700/50 last:border-b-0">
        <button
          onClick={() => setShowArgs(!showArgs)}
          className="w-full flex items-center justify-between px-4 py-2 text-xs text-slate-400 hover:text-slate-300 hover:bg-slate-800/50 transition-colors"
          type="button"
        >
          <span className="font-mono">Arguments</span>
          {showArgs ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>
        {showArgs && (
          <div className="px-4 pb-3">
            <pre className="bg-slate-950 rounded-lg p-3 overflow-x-auto text-xs font-mono text-slate-300">
              <code>{formatArgs()}</code>
            </pre>
          </div>
        )}
      </div>

      {/* Result section */}
      {hasResult && (
        <div>
          <button
            onClick={() => setShowResult(!showResult)}
            className="w-full flex items-center justify-between px-4 py-2 text-xs transition-colors"
            type="button"
          >
            <span className={`font-mono ${isError ? 'text-red-400' : 'text-emerald-400'}`}>
              {isError ? 'Error' : 'Result'}
            </span>
            {showResult ? (
              <ChevronDown className={`w-3.5 h-3.5 ${isError ? 'text-red-400' : 'text-emerald-400'}`} />
            ) : (
              <ChevronRight className={`w-3.5 h-3.5 ${isError ? 'text-red-400' : 'text-emerald-400'}`} />
            )}
          </button>
          {showResult && (
            <div className="px-4 pb-3">
              <pre className={`rounded-lg p-3 overflow-x-auto text-xs font-mono ${
                isError 
                  ? 'bg-red-950/30 text-red-200 border border-red-900/50' 
                  : 'bg-slate-950 text-slate-300 border border-slate-800'
              }`}>
                <code>{formatResult()}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
