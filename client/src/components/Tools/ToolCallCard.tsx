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

  const formatArgs = (): string => {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  };

  const formatResult = (): string => {
    if (!result) return '';
    try {
      const parsed = JSON.parse(result.output);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return result.output;
    }
  };

  return (
    <div className="w-full border border-gray-200 rounded-lg overflow-hidden bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <div className={`p-1.5 rounded-lg ${
            isError ? 'bg-red-50' :
            isSuccess ? 'bg-emerald-50' :
            'bg-amber-50'
          }`}>
            <Terminal className={`w-4 h-4 ${
              isError ? 'text-red-500' :
              isSuccess ? 'text-emerald-500' :
              'text-amber-500'
            }`} />
          </div>
          <div>
            <span className="font-mono text-sm font-medium text-gray-900">
              {name}
            </span>
            {isPending && (
              <span className="ml-2 text-xs text-amber-500 animate-pulse">
                Running...
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isSuccess && (
            <CheckCircle className="w-4 h-4 text-emerald-500" />
          )}
          {isError && (
            <XCircle className="w-4 h-4 text-red-500" />
          )}
        </div>
      </div>

      {/* Arguments section */}
      <div className="border-b border-gray-100 last:border-b-0">
        <button
          onClick={() => setShowArgs(!showArgs)}
          className="w-full flex items-center justify-between px-4 py-2 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors"
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
            <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto text-xs font-mono text-gray-700">
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
            <span className={`font-mono ${isError ? 'text-red-500' : 'text-emerald-600'}`}>
              {isError ? 'Error' : 'Result'}
            </span>
            {showResult ? (
              <ChevronDown className={`w-3.5 h-3.5 ${isError ? 'text-red-500' : 'text-emerald-600'}`} />
            ) : (
              <ChevronRight className={`w-3.5 h-3.5 ${isError ? 'text-red-500' : 'text-emerald-600'}`} />
            )}
          </button>
          {showResult && (
            <div className="px-4 pb-3">
              <pre className={`rounded-lg p-3 overflow-x-auto text-xs font-mono ${
                isError
                  ? 'bg-red-50 text-red-700 border border-red-200'
                  : 'bg-gray-50 text-gray-700 border border-gray-200'
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
