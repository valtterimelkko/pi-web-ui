import { useState } from 'react';
import { Sparkles, ChevronDown } from 'lucide-react';

interface ThinkingBlockProps {
  content: string;
  isOpen?: boolean;
  onToggle?: () => void;
}

export function ThinkingBlock({ content, isOpen = false, onToggle }: ThinkingBlockProps) {
  const [internalOpen, setInternalOpen] = useState(isOpen);
  const isControlled = onToggle !== undefined;
  const isExpanded = isControlled ? isOpen : internalOpen;

  const handleToggle = () => {
    if (isControlled) {
      onToggle();
    } else {
      setInternalOpen(!internalOpen);
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
      {/* Header */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-100 transition-colors"
        type="button"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-gray-400" />
          <span className="text-xs font-medium text-gray-500">Thinking</span>
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${
            isExpanded ? '' : '-rotate-90'
          }`}
        />
      </button>

      {/* Content */}
      {isExpanded && (
        <div className="px-3 py-2 border-t border-gray-200">
          <p className="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed break-words overflow-hidden">
            {content}
          </p>
        </div>
      )}
    </div>
  );
}
