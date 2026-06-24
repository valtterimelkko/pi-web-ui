import { useState, useMemo } from 'react';
import { Sparkles, ChevronDown } from 'lucide-react';
// Shared default-collapse rule (collapsed by default) — same value the server
// screen-view projection treats as `collapsedByDefault` for thinking items.
import { THINKING_COLLAPSED_BY_DEFAULT, summarizeThinking } from '@pi-web-ui/shared';

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
export function ThinkingBlock({ content, isOpen = !THINKING_COLLAPSED_BY_DEFAULT, onToggle }: ThinkingBlockProps) {
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

  // Generate the same preview text used by the screen-view projection.
  const preview = useMemo(() => content ? summarizeThinking(content) : '', [content]);

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
          <Sparkles className="w-3 h-3 text-blue-400 shrink-0" />
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
