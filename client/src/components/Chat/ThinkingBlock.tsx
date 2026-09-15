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
    <div className="border border-outline-default dark:border-outline-default-dark rounded-lg overflow-hidden bg-surface-subtle dark:bg-surface-dark-subtle my-1.5 transition-colors">
      {/* Header */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-surface dark:hover:bg-surface-dark transition-colors group text-left"
        type="button"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Sparkles className="w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark shrink-0" />
          <span className="text-xs font-medium text-content-secondary dark:text-content-secondary-dark shrink-0">Thinking</span>
          {/* Show preview when collapsed */}
          {!isExpanded && preview && (
            <span className="text-xs text-content-muted dark:text-content-muted-dark truncate ml-1 font-normal">
              {preview}
            </span>
          )}
          {/* Show word count when expanded */}
          {isExpanded && wordCount > 0 && (
            <span className="text-xs text-content-muted dark:text-content-muted-dark ml-1 font-normal">
              ({wordCount} words)
            </span>
          )}
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark transition-transform duration-200 shrink-0 ${
            isExpanded ? '' : '-rotate-90'
          }`}
        />
      </button>

      {/* Content */}
      {isExpanded && (
        <div className="px-3.5 py-2.5 border-t border-outline-subtle dark:border-outline-subtle-dark bg-surface/50 dark:bg-surface-dark/50">
          <p className="text-xs text-content-secondary dark:text-content-secondary-dark whitespace-pre-wrap leading-relaxed break-words font-sans">
            {content}
          </p>
        </div>
      )}
    </div>
  );
}
