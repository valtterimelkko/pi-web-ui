import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';
import type { Message } from '../../store';
import { useSessionStore } from '../../store';
import { StreamingText } from './StreamingText';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from '../Tools/ToolCallCard';
import { copyToClipboard } from '../../lib/clipboard';

interface MessageBubbleProps {
  message: Message;
  isLast?: boolean;
}

export function MessageBubble({ message, isLast }: MessageBubbleProps) {
  const [showThinking, setShowThinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isAssistant = message.role === 'assistant';

  // Process content to extract text and thinking
  const processContent = (): { text: string; thinking: string | null } => {
    if (Array.isArray(message.content)) {
      let textParts: string[] = [];
      let thinkingParts: string[] = [];

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
  const isStreamingThis = isLast && isStreaming && isAssistant;

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
    return (
      <div className="w-full">
        <ToolCallCard
          name={message.toolCall.name}
          args={message.toolCall.args}
          result={message.toolResult}
        />
        <span className="text-xs text-gray-400 mt-1 block">
          {formatTime(message.timestamp)}
        </span>
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* Thinking block */}
      {hasThinking && (
        <div className="mb-2">
          <ThinkingBlock
            content={thinking}
            isOpen={showThinking}
            onToggle={() => setShowThinking(!showThinking)}
          />
        </div>
      )}

      {/* Message content */}
      <div
        className={`
          relative group break-words overflow-hidden
          ${isUser
            ? 'bg-gray-100 rounded-lg p-4 text-gray-900'
            : isTool
              ? 'bg-gray-50 border border-gray-200 rounded-lg p-4'
              : 'pl-4 border-l-2 border-teal-400 text-gray-900'
          }
        `}
      >
        {/* Copy button - show on hover for assistant messages */}
        {isAssistant && !isStreamingThis && displayText && (
          <button
            onClick={handleCopy}
            className={`
              absolute top-2 right-2 p-1.5 rounded-md transition-all duration-200
              ${copied
                ? 'bg-green-100 text-green-600'
                : 'bg-gray-100 text-gray-500 opacity-0 group-hover:opacity-100 hover:bg-gray-200 hover:text-gray-700'
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
          <div className="prose prose-sm max-w-none prose-gray">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ inline, className, children, ...props }: { inline?: boolean; className?: string; children?: React.ReactNode }) {
                  const match = /language-(\w+)/.exec(className || '');
                  return !inline ? (
                    <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto my-2">
                      <code className={match ? `language-${match[1]}` : ''} {...props}>
                        {children}
                      </code>
                    </pre>
                  ) : (
                    <code className="bg-gray-100 text-gray-800 px-1 py-0.5 rounded text-sm" {...props}>
                      {children}
                    </code>
                  );
                },
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

      {/* Timestamp */}
      <span className="text-xs text-gray-400 mt-1 block">
        {formatTime(message.timestamp)}
      </span>
    </div>
  );
}
