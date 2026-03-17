import React, { useState, memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, Bot } from 'lucide-react';
import type { Message } from '../../store';
import { useSessionStore } from '../../store';
import { StreamingText } from './StreamingText';
import { ThinkingBlock } from './ThinkingBlock';
import { CollapsibleToolCard } from '../Tools/CollapsibleToolCard';
import { copyToClipboard } from '../../lib/clipboard';

interface MessageBubbleProps {
  message: Message;
  isLast?: boolean;
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
export const MessageBubble = memo(function MessageBubble({ message, isLast }: MessageBubbleProps) {
  const [showThinking, setShowThinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isAssistant = message.role === 'assistant';

  // Process content to extract text and thinking
  const processContent = (): { text: string; thinking: string | null } => {
    if (Array.isArray(message.content)) {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];

      for (const part of message.content) {
        if (part.type === 'text' && part.text) {
          textParts.push(part.text);
        } else if (part.type === 'thinking' && part.thinking) {
          thinkingParts.push(part.thinking);
        }
      }

      const fullText = textParts.join('');
      const thinkingMatch = fullText.match(/<thinking>([\s\S]*?)<\/thinking>/);
      if (thinkingMatch) {
        return {
          text: fullText.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim(),
          thinking: thinkingMatch[1].trim(),
        };
      }

      return {
        text: fullText,
        thinking: thinkingParts.length > 0 ? thinkingParts.join('\n\n') : null,
      };
    }

    if (typeof message.content === 'string') {
      const thinkingMatch = message.content.match(/<thinking>([\s\S]*?)<\/thinking>/);
      if (thinkingMatch) {
        return {
          text: message.content.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim(),
          thinking: thinkingMatch[1].trim(),
        };
      }
      return { text: message.content, thinking: null };
    }

    return { text: '', thinking: null };
  };

  const { text: displayText, thinking } = processContent();
  const hasThinking = !!thinking;
  const hasVisibleContent = displayText && displayText.trim().length > 0;
  const isStreamingThis = !!(isLast && isStreaming && isAssistant);

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

  // Render tool call card for tool messages (using new CollapsibleToolCard)
  if (isTool && message.toolCall) {
    return (
      <CollapsibleToolCard
        name={message.toolCall.name}
        args={message.toolCall.args}
        result={message.toolResult}
      />
    );
  }

  // For assistant messages with no visible content but thinking, 
  // auto-expand thinking block by default
  const showThinkingExpanded = !hasVisibleContent && hasThinking;

  return (
    <div className="w-full">
      {/* Thinking block */}
      {hasThinking && (
        <div className="mb-2">
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
              ? 'bg-gray-100 rounded-lg p-4 text-gray-900'
              : isTool
                ? 'bg-gray-50 border border-gray-200 rounded-lg p-4'
                : 'pl-4 pr-8 border-l-2 border-teal-400 text-gray-900'
            }
          `}
        >
          {/* Copy button - always visible on mobile, hover-only on desktop */}
          {isAssistant && !isStreamingThis && (
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
            <div className="prose prose-sm max-w-none prose-gray prose-table:w-full">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ inline, className, children, ...props }: { inline?: boolean; className?: string; children?: React.ReactNode }) {
                    const match = /language-(\w+)/.exec(className || '');
                    return !inline ? (
                      <pre className="bg-slate-100 border border-slate-200 rounded-lg p-3 overflow-x-auto my-2">
                        <code className={`text-slate-800 ${match ? `language-${match[1]}` : ''}`} {...props}>
                          {children}
                        </code>
                      </pre>
                    ) : (
                      <code className="bg-slate-200 text-slate-900 px-1.5 py-0.5 rounded text-sm font-mono font-semibold" {...props}>
                        {children}
                      </code>
                    );
                  },
                  // Table components for proper rendering
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-3">
                      <table className="w-full border-collapse border border-gray-200 text-sm">
                        {children}
                      </table>
                    </div>
                  ),
                  thead: ({ children }) => (
                    <thead className="bg-gray-50">{children}</thead>
                  ),
                  tbody: ({ children }) => (
                    <tbody className="divide-y divide-gray-200">{children}</tbody>
                  ),
                  tr: ({ children }) => (
                    <tr className="border-b border-gray-200 even:bg-gray-50/50">{children}</tr>
                  ),
                  th: ({ children }) => (
                    <th className="border border-gray-200 px-3 py-2 text-left text-xs font-semibold text-gray-700">
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td className="border border-gray-200 px-3 py-2 text-sm text-gray-700">
                      {children}
                    </td>
                  ),
                  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>,
                  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                  a: ({ children, href }) => (
                    <a href={href} className="text-teal-600 hover:text-teal-700 underline" target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {displayText}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}

      {/* Timestamp */}
      <span className="text-xs text-gray-400 mt-1 block">
        {formatTime(message.timestamp)}
      </span>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison for better memoization
  // Only re-render if message content or last status changes
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.isLast === nextProps.isLast &&
    prevProps.message.toolResult?.output === nextProps.message.toolResult?.output &&
    prevProps.message.toolResult?.isError === nextProps.message.toolResult?.isError
  );
});
