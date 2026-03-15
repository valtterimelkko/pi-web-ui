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
    <div className="rounded-lg overflow-hidden border border-gray-200">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100"
      >
        <span className="text-xs font-medium text-gray-500 uppercase">{type}</span>
        {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
      </button>

      {isExpanded && (
        <pre
          className={`
            text-xs font-mono p-3 overflow-auto
            ${isError ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-700'}
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
  return content;
}

function renderDiff(content: string): string {
  return content;
}
