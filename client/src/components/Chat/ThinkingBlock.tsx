import { useState } from 'react';
import { Lightbulb, ChevronDown } from 'lucide-react';

interface ThinkingBlockProps {
  content: string;
  isOpen?: boolean;
  onToggle?: () => void;
}

export function ThinkingBlock({ content, isOpen = true, onToggle }: ThinkingBlockProps) {
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
    <div className="border border-amber-700/30 rounded-xl overflow-hidden bg-amber-950/20">
      {/* Header */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-amber-900/20 hover:bg-amber-900/30 transition-colors"
        type="button"
      >
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-medium text-amber-200">Thinking</span>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-amber-400 transition-transform duration-200 ${
            isExpanded ? '' : '-rotate-90'
          }`}
        />
      </button>

      {/* Content */}
      {isExpanded && (
        <div className="px-4 py-3 border-t border-amber-700/20">
          <p className="text-sm text-amber-100/80 whitespace-pre-wrap leading-relaxed break-words overflow-hidden">
            {content}
          </p>
        </div>
      )}
    </div>
  );
}
