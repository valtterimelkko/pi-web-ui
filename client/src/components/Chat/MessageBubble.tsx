import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { User, Bot, Wrench, Copy, Check } from 'lucide-react';
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
  const [showThinking, setShowThinking] = useState(true);
  const [copied, setCopied] = useState(false);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isAssistant = message.role === 'assistant';

  // Process content to extract text and thinking
  const processContent = (): { text: string; thinking: string | null } => {
    // Handle array content (new format from SDK)
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
      
      // Also check for <thinking> tags in text (old format)
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
    
    // Handle string content (may have <thinking> tags)
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

  // Handle copy message
  const handleCopy = async () => {
    if (!displayText) return;
    const success = await copyToClipboard(displayText, 'Message copied to clipboard');
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Format timestamp
  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Get avatar icon and styles based on role
  const getAvatarConfig = () => {
    if (isUser) {
      return {
        icon: User,
        bgColor: 'bg-violet-600',
        textColor: 'text-white',
        bubbleBg: 'bg-violet-600',
        bubbleText: 'text-white',
        align: 'justify-end',
      };
    }
    if (isTool) {
      return {
        icon: Wrench,
        bgColor: 'bg-amber-600',
        textColor: 'text-white',
        bubbleBg: 'bg-amber-900/30 border border-amber-700/50',
        bubbleText: 'text-amber-100',
        align: 'justify-start',
      };
    }
    return {
      icon: Bot,
      bgColor: 'bg-slate-700',
      textColor: 'text-slate-300',
      bubbleBg: 'bg-slate-800 border border-slate-700',
      bubbleText: 'text-slate-100',
      align: 'justify-start',
    };
  };

  const config = getAvatarConfig();
  const Icon = config.icon;

  // Render tool call card for tool messages
  if (isTool && message.toolCall) {
    return (
      <div className={`flex ${config.align}`}>
        <div className="flex gap-3 max-w-[85%] min-w-0">
          <div className={`flex-shrink-0 w-8 h-8 rounded-lg ${config.bgColor} flex items-center justify-center`}>
            <Icon className={`w-4 h-4 ${config.textColor}`} />
          </div>
          <div className="flex-1 space-y-2 min-w-0">
            <ToolCallCard
              name={message.toolCall.name}
              args={message.toolCall.args}
              result={message.toolResult}
            />
            <span className="text-xs text-slate-400">
              {formatTime(message.timestamp)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${config.align}`}>
      <div className={`flex gap-3 max-w-[85%] min-w-0 ${isUser ? 'flex-row-reverse' : ''}`}>
        {/* Avatar */}
        <div className={`flex-shrink-0 w-8 h-8 rounded-lg ${config.bgColor} flex items-center justify-center`}>
          <Icon className={`w-4 h-4 ${config.textColor}`} />
        </div>

        {/* Bubble */}
        <div className="flex flex-col space-y-1 min-w-0">
          {/* Thinking block */}
          {hasThinking && (
            <ThinkingBlock
              content={thinking}
              isOpen={showThinking}
              onToggle={() => setShowThinking(!showThinking)}
            />
          )}

          {/* Message content */}
          <div
            className={`
              relative max-w-3xl px-4 py-3 rounded-2xl transition-all duration-200
              hover:shadow-lg hover:shadow-black/20 group break-words overflow-hidden
              ${isUser 
                ? 'bg-violet-600 text-white rounded-br-md hover:bg-violet-500' 
                : isTool
                  ? 'bg-amber-900/30 border border-amber-800/50 rounded-bl-md'
                  : 'bg-slate-800 text-slate-100 rounded-bl-md hover:bg-slate-750'
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
                    ? 'bg-green-600 text-white' 
                    : 'bg-slate-700 text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-600 hover:text-slate-200'
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
              <div className="prose prose-invert prose-sm max-w-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ inline, className, children, ...props }: { inline?: boolean; className?: string; children?: React.ReactNode }) {
                      const match = /language-(\w+)/.exec(className || '');
                      return !inline ? (
                        <pre className="bg-slate-950 rounded-lg p-3 overflow-x-auto my-2">
                          <code className={match ? `language-${match[1]}` : ''} {...props}>
                            {children}
                          </code>
                        </pre>
                      ) : (
                        <code className="bg-slate-950 px-1.5 py-0.5 rounded text-sm" {...props}>
                          {children}
                        </code>
                      );
                    },
                    p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
                    ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>,
                    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                    a: ({ children, href }) => (
                      <a href={href} className="text-violet-400 hover:text-violet-300 underline" target="_blank" rel="noopener noreferrer">
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
          <span className={`text-xs text-slate-400 ${isUser ? 'text-right' : ''}`}>
            {formatTime(message.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}
