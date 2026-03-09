import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface ToolOutputProps {
  content: string;
  type?: 'text' | 'json' | 'tree' | 'diff';
  isError?: boolean;
  maxHeight?: number;
}

export function ToolOutput({ content, type = 'text', isError, maxHeight = 400 }: ToolOutputProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const getContent = () => {
    switch (type) {
      case 'json':
        try {
          return JSON.stringify(JSON.parse(content), null, 2);
        } catch {
          return content;
        }
      case 'tree':
        return renderTree(content);
      case 'diff':
        return renderDiff(content);
      default:
        return content;
    }
  };

  return (
    <div className="rounded-lg overflow-hidden border border-slate-700">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-3 py-2 bg-slate-800/50 hover:bg-slate-800"
      >
        <span className="text-xs font-medium text-slate-400 uppercase">{type}</span>
        {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>
      
      {isExpanded && (
        <pre 
          className={`
            text-xs font-mono p-3 overflow-auto
            ${isError ? 'bg-red-900/20 text-red-200' : 'bg-slate-950 text-slate-300'}
          `}
          style={{ maxHeight }}
        >
          {getContent()}
        </pre>
      )}
    </div>
  );
}

function renderTree(content: string): string {
  // Simple tree rendering - could be enhanced
  return content;
}

function renderDiff(content: string): string {
  // Simple diff rendering - could be enhanced with colors
  return content;
}
