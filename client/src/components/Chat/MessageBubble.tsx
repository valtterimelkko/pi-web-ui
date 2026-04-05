import React, { useState, memo, useMemo } from 'react';
import { Copy, Check, Bot } from 'lucide-react';
import type { LiveMessage } from '../../hooks/useSessionStream.js';
import { useSessionStore } from '../../store';
import { StreamingText } from './StreamingText';
import { ThinkingBlock } from './ThinkingBlock';
import { CollapsibleToolCard } from '../Tools/CollapsibleToolCard';
import { SubagentToolCard } from '../Tools/SubagentToolCard';
import { TodoToolCard } from '../Tools/TodoToolCard';
import { copyToClipboard } from '../../lib/clipboard';
import { normalizeToolName } from '../../lib/messageAdapter';
import { MarkdownRenderer } from '../../lib/markdown';

interface MessageBubbleProps {
  message: LiveMessage;
  isLast?: boolean;
  isCurrentRun?: boolean;
  forceExpanded?: boolean; // passed from "Expand all" group toggle
}

/**
 * ActivityIndicator - Shows a brief summary for assistant messages with no visible text
 * 
 * This helps users understand what happened when the agent only thought/reasoned
 * but didn't produce any visible output.
 */
function ActivityIndicator({ 
  thinking, 
  isStreaming 
}: { 
  thinking: string | null;
  isStreaming: boolean;
}) {
  // Generate a brief preview of activity
  const preview = useMemo(() => {
    if (!thinking) return isStreaming ? 'Thinking...' : 'Processed';
    
    // Get first sentence or first 60 chars of thinking
    const firstSentence = thinking.split(/[.!?]\s/)[0];
    const truncated = firstSentence.length > 60 
      ? firstSentence.slice(0, 60) + '…' 
      : firstSentence;
    return truncated;
  }, [thinking, isStreaming]);

  return (
    <div className="flex items-center gap-2 text-sm text-gray-500 py-1">
      <Bot className="w-4 h-4 text-gray-400 shrink-0" />
      <span className="truncate">{preview}</span>
      {isStreaming && (
        <span className="inline-flex items-center gap-1">
          <span className="animate-pulse">●</span>
        </span>
      )}
    </div>
  );
}

// Memoized MessageBubble for performance
export const MessageBubble = memo(function MessageBubble({ message, isLast, isCurrentRun, forceExpanded }: MessageBubbleProps) {
  const [showThinking, setShowThinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isAssistant = message.role === 'assistant';

  // Process content to extract text and thinking
  // LiveMessage has content: ContentPart[] (always array)
  const processContent = (): { text: string; thinking: string | null } => {
    const content = message.content;
    const textParts: string[] = [];
    const thinkingParts: string[] = [];

    for (const part of content) {
      if (part.type === 'text' && part.text) {
        textParts.push(part.text);
      } else if (part.type === 'thinking' && part.thinking) {
        thinkingParts.push(part.thinking);
      }
    }

    return {
      text: textParts.join(''),
      thinking: thinkingParts.length > 0 ? thinkingParts.join('\n\n') : null,
    };
  };

  const { text: displayText, thinking } = processContent();
  const hasThinking = !!thinking;
  const hasVisibleContent = displayText && displayText.trim().length > 0;
  const isStreamingThis = !!(isLast && isStreaming && isAssistant);

  // Auto-collapse long intermediate assistant messages during streaming
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const isLongContent = useMemo(() => {
    if (!displayText) return false;
    return displayText.split('\n').length > 6 || displayText.length > 300;
  }, [displayText]);
  const shouldCollapse = isStreaming && !isLast && isCurrentRun && isAssistant && hasVisibleContent && isLongContent && !manuallyExpanded;

  const handleCopy = async () => {
    if (!displayText) return;
    const success = await copyToClipboard(displayText, 'Message copied to clipboard');
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Render tool call card for tool messages
  if (isTool && message.toolCall) {
    // Normalize Claude PascalCase tool names to Pi equivalents for routing.
    // The original name is still passed to the card so headers show the real name.
    const normalizedName = normalizeToolName(message.toolCall.name);

    // Use SubagentToolCard for subagent tools to show hierarchical view
    if (normalizedName === 'subagent') {
      return (
        <SubagentToolCard
          name={message.toolCall.name}
          args={message.toolCall.args}
          result={message.toolResult}
          startTime={message.timestamp}
        />
      );
    }
    // Use TodoToolCard for todo tools to show visual todo list
    if (normalizedName === 'todo') {
      return (
        <TodoToolCard
          name={message.toolCall.name}
          args={message.toolCall.args}
          result={message.toolResult}
          startTime={message.timestamp}
        />
      );
    }
    // Use CollapsibleToolCard for all other tools
    return (
      <CollapsibleToolCard
        name={message.toolCall.name}
        args={message.toolCall.args}
        result={message.toolResult}
        startTime={message.timestamp}
        forceExpanded={forceExpanded}
      />
    );
  }

  // For assistant messages with no visible content but thinking,
  // auto-expand thinking block by default (but not for intermediate messages during streaming)
  const showThinkingExpanded = !hasVisibleContent && hasThinking && !(isStreaming && !isLast && isCurrentRun);

  return (
    <div className="w-full">
      {/* Thinking block */}
      {hasThinking && (
        <div className="mb-1">
          <ThinkingBlock
            content={thinking}
            isOpen={showThinking || showThinkingExpanded}
            onToggle={() => setShowThinking(!showThinking)}
          />
        </div>
      )}

      {/* Activity indicator for messages with no visible content */}
      {isAssistant && !hasVisibleContent && !hasThinking && (
        <div className="pl-4 pr-8 border-l-2 border-gray-200">
          <ActivityIndicator thinking={null} isStreaming={isStreamingThis} />
        </div>
      )}

      {/* Message content */}
      {hasVisibleContent && (
        <div
          className={`
            relative group break-words overflow-hidden
            ${isUser
              ? 'bg-gray-100 rounded-lg p-3 text-gray-900 text-sm'
              : isTool
                ? 'bg-gray-50 border border-gray-200 rounded-lg p-3'
                : 'pl-3 pr-8 border-l-2 border-blue-400 text-gray-900'
            }
          `}
        >
          {/* Copy button - always visible on mobile, hover-only on desktop; hidden when collapsed */}
          {isAssistant && !isStreamingThis && !shouldCollapse && (
            <button
              onClick={handleCopy}
              className={`
                absolute top-1 right-1 p-1.5 rounded-md transition-all duration-200
                ${copied
                  ? 'bg-green-100 text-green-600'
                  : 'bg-gray-100 text-gray-500 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-gray-200 hover:text-gray-700'
                }
              `}
              title={copied ? 'Copied!' : 'Copy message'}
            >
              {copied ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          )}

          {isStreamingThis ? (
            <StreamingText text={displayText} />
          ) : (
            <>
            <div id={`msg-content-${message.id}`} className={`prose prose-sm max-w-none prose-gray prose-table:w-full prose-compact${shouldCollapse ? ' max-h-[6rem] overflow-hidden' : ''}`}>
              <MarkdownRenderer content={displayText} />
            </div>
            {shouldCollapse && (
              <>
                <div className="h-6 -mt-6 collapse-fade-gradient pointer-events-none" />
                <button
                  onClick={() => setManuallyExpanded(true)}
                  className="text-xs text-blue-600 hover:text-blue-700 mt-0.5"
                  type="button"
                  aria-expanded={false}
                  aria-controls={`msg-content-${message.id}`}
                >
                  ▾ Show more
                </button>
              </>
            )}
            {!shouldCollapse && manuallyExpanded && isStreaming && !isLast && isCurrentRun && isLongContent && (
              <button
                onClick={() => setManuallyExpanded(false)}
                className="text-xs text-blue-600 hover:text-blue-700 mt-0.5"
                type="button"
                aria-expanded={true}
                aria-controls={`msg-content-${message.id}`}
              >
                ▴ Show less
              </button>
            )}
            </>
          )}
        </div>
      )}

      {/* Timestamp */}
      <span className="text-[10px] text-gray-400 mt-0.5 block">
        {formatTime(message.timestamp)}
      </span>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison for better memoization
  // Only re-render if message content or last status changes
  // LiveMessage.content is ContentPart[], compare as JSON for simplicity
  return (
    prevProps.message.id === nextProps.message.id &&
    JSON.stringify(prevProps.message.content) === JSON.stringify(nextProps.message.content) &&
    prevProps.isLast === nextProps.isLast &&
    prevProps.isCurrentRun === nextProps.isCurrentRun &&
    prevProps.message.toolResult?.output === nextProps.message.toolResult?.output &&
    prevProps.message.toolResult?.isError === nextProps.message.toolResult?.isError &&
    prevProps.forceExpanded === nextProps.forceExpanded
  );
});
