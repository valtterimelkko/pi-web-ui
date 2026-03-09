import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { User, Bot, Wrench } from 'lucide-react';
import type { Message } from '../../store';
import { StreamingText } from './StreamingText';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from '../Tools/ToolCallCard';

interface MessageBubbleProps {
  message: Message;
  isLast?: boolean;
}

export function MessageBubble({ message, isLast }: MessageBubbleProps) {
  const [showThinking, setShowThinking] = useState(true);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isAssistant = message.role === 'assistant';

  // Extract thinking blocks from content
  const extractThinking = (content: string): { text: string; thinking: string | null } => {
    const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/);
    if (thinkingMatch) {
      const thinking = thinkingMatch[1].trim();
      const text = content.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
      return { text, thinking };
    }
    return { text: content, thinking: null };
  };

  // Get content as string
  const getContentString = (): string => {
    if (typeof message.content === 'string') {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => {
          if (part.type === 'text') return part.text || '';
          return '';
        })
        .join('');
    }
    return '';
  };

  const contentString = getContentString();
  const { text: displayText, thinking } = extractThinking(contentString);
  const hasThinking = !!thinking;
  const isStreamingThis = isLast && isStreaming && isAssistant;

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
        <div className="flex gap-3 max-w-[85%]">
          <div className={`flex-shrink-0 w-8 h-8 rounded-lg ${config.bgColor} flex items-center justify-center`}>
            <Icon className={`w-4 h-4 ${config.textColor}`} />
          </div>
          <div className="flex-1 space-y-2">
            <ToolCallCard
              name={message.toolCall.name}
              args={message.toolCall.args}
              result={message.toolResult}
            />
            <span className="text-xs text-slate-500">
              {formatTime(message.timestamp)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${config.align}`}>
      <div className={`flex gap-3 max-w-[85%] ${isUser ? 'flex-row-reverse' : ''}`}>
        {/* Avatar */}
        <div className={`flex-shrink-0 w-8 h-8 rounded-lg ${config.bgColor} flex items-center justify-center`}>
          <Icon className={`w-4 h-4 ${config.textColor}`} />
        </div>

        {/* Bubble */}
        <div className="flex flex-col space-y-1">
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
            className={`px-4 py-3 rounded-2xl ${config.bubbleBg} ${config.bubbleText} ${
              isUser ? 'rounded-br-md' : 'rounded-bl-md'
            }`}
          >
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
          <span className={`text-xs text-slate-500 ${isUser ? 'text-right' : ''}`}>
            {formatTime(message.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}

// Import useSessionStore at the top
import { useSessionStore } from '../../store';
