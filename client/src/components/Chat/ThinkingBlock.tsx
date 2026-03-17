import { useState, useMemo } from 'react';
import { Sparkles, ChevronDown } from 'lucide-react';

interface ThinkingBlockProps {
  content: string;
  isOpen?: boolean;
  onToggle?: () => void;
}

/**
 * ThinkingBlock - Collapsible thinking content with preview
 * 
 * When collapsed, shows a brief preview of the thinking content
 * so users can understand what the agent considered without expanding.
 */
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

  // Generate a preview of the thinking content (first ~80 chars)
  const preview = useMemo(() => {
    if (!content) return '';
    // Get first line or first 80 chars, whichever is shorter
    const firstLine = content.split('\n')[0];
    const truncated = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
    return truncated;
  }, [content]);

  // Calculate word count for context
  const wordCount = useMemo(() => {
    if (!content) return 0;
    return content.split(/\s+/).filter(Boolean).length;
  }, [content]);

  return (
    <div className="border border-gray-200 rounded-md overflow-hidden bg-gray-50">
      {/* Header */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-gray-100 transition-colors group"
        type="button"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Sparkles className="w-3 h-3 text-violet-400 shrink-0" />
          <span className="text-xs text-gray-500 shrink-0">Thinking</span>
          {/* Show preview when collapsed */}
          {!isExpanded && preview && (
            <span className="text-xs text-gray-400 truncate ml-1">
              {preview}
            </span>
          )}
          {/* Show word count when expanded */}
          {isExpanded && wordCount > 0 && (
            <span className="text-xs text-gray-400 ml-1">
              ({wordCount} words)
            </span>
          )}
        </div>
        <ChevronDown
          className={`w-3 h-3 text-gray-400 transition-transform duration-200 shrink-0 ${
            isExpanded ? '' : '-rotate-90'
          }`}
        />
      </button>

      {/* Content */}
      {isExpanded && (
        <div className="px-2.5 py-1.5 border-t border-gray-200">
          <p className="text-xs text-gray-600 whitespace-pre-wrap leading-normal break-words overflow-hidden">
            {content}
          </p>
        </div>
      )}
    </div>
  );
}
