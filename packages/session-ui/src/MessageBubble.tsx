import React, { useState, memo, useMemo } from 'react';
// Shared default-collapse rule for thinking (collapsed by default) — mirrors
// the server screen-view projection's `collapsedByDefault` for thinking items.
import { THINKING_COLLAPSED_BY_DEFAULT } from '@pi-web-ui/session-core/screen-view';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, Bot, AlertTriangle } from 'lucide-react';
import type { LiveMessage } from '@pi-web-ui/session-core/model';
import { useSessionView, type ReadAloudControls } from './SessionView';
import { StreamingText } from './StreamingText';
import { isGoalContinuationPrompt } from './goalModel';
import { ThinkingBlock } from './ThinkingBlock';
import { CollapsibleToolCard } from './CollapsibleToolCard';
import { SubagentToolCard } from './SubagentToolCard';
import { TodoToolCard } from './TodoToolCard';
import { normalizeToolName } from '@pi-web-ui/session-core/message-adapter';
import { CodeBlock as PackageCodeBlock } from './CodeBlock';

/** Read-aloud stand-in when the host supplies none (no button is rendered). */
const NO_READ_ALOUD: ReadAloudControls = { state: 'idle', speedEnabled: false, play: () => {}, stop: () => {}, toggleSpeed: () => {} };
function useNoReadAloud(_messageId: string): ReadAloudControls {
  return NO_READ_ALOUD;
}

export interface MessageBubbleProps {
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

  const view = useSessionView();
  const sdkType = view.useSdkType();
  const StreamHeartbeat = view.components?.StreamHeartbeat;

  return (
    <div className="flex items-center gap-2 text-sm text-content-muted dark:text-content-muted-dark py-1">
      <Bot className="w-4 h-4 text-content-muted dark:text-content-muted-dark shrink-0" strokeWidth={1.75} />
      <span className="truncate">{preview}</span>
      {isStreaming && sdkType !== 'claude' && (
        <span className="inline-flex items-center gap-1">
          <span className="animate-pulse">●</span>
        </span>
      )}
      {isStreaming && sdkType === 'claude' && StreamHeartbeat && (
        <StreamHeartbeat compact />
      )}
    </div>
  );
}

// Memoized MessageBubble for performance
export const MessageBubble = memo(function MessageBubble({ message, isLast, isCurrentRun, forceExpanded }: MessageBubbleProps) {
  const [showThinking, setShowThinking] = useState(!THINKING_COLLAPSED_BY_DEFAULT);
  const [copied, setCopied] = useState(false);
  const view = useSessionView();
  const CodeBlock = view.components?.CodeBlock ?? PackageCodeBlock;
  const isStreaming = view.useIsStreaming();
  // Contract 1.34.0 child surfacing: resolve a background-subagent launch's
  // live state so its card shows running/completed instead of an instant ✓.
  const currentSessionId = view.useSessionId();
  const backgroundIdentity = message.toolResult?.background;
  const backgroundChildState = view.useBackgroundChild(currentSessionId, backgroundIdentity?.taskId);
  const sessionSdkType = view.useSdkType();
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
  // Only the runtimes that ship a goal engine can produce these prompts.
  const isGoalContinuation = isUser
    && (sessionSdkType === 'pi' || sessionSdkType === 'opencode')
    && isGoalContinuationPrompt(displayText);

  // Auto-collapse long intermediate assistant messages during streaming
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const isLongContent = useMemo(() => {
    if (!displayText) return false;
    return displayText.split('\n').length > 15 || displayText.length > 800;
  }, [displayText]);
  const shouldCollapse = isStreaming && !isLast && isCurrentRun && isAssistant && hasVisibleContent && isLongContent && !manuallyExpanded;

  const useReadAloud = view.readAloud?.useReadAloud ?? useNoReadAloud;
  const ReadAloudButton = view.readAloud?.Button;
  const readAloud = useReadAloud(message.id);

  const handleCopy = async () => {
    if (!displayText) return;
    const success = await view.copy(displayText, 'Message copied to clipboard');
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleReadAloud = () => {
    if (!displayText) return;
    if (readAloud.state === 'playing') {
      readAloud.stop();
    } else {
      void readAloud.play(displayText);
    }
  };

  const CopyButton = () => (
    <button
      onClick={handleCopy}
      className={`
        p-1.5 rounded-lg transition-all duration-200 touch-manipulation
        ${copied
          ? 'bg-sv-ok-100 dark:bg-sv-ok-950/40 text-sv-ok-600 dark:text-sv-ok-400'
          : 'bg-surface dark:bg-surface-dark border border-outline-subtle dark:border-outline-subtle-dark text-content-muted dark:text-content-muted-dark sm:opacity-0 sm:group-hover:opacity-100 hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle hover:text-content-primary dark:hover:text-content-primary-dark'
        }
      `}
      title={copied ? 'Copied!' : 'Copy message'}
      aria-label={copied ? 'Copied to clipboard' : 'Copy message to clipboard'}
    >
      {copied ? (
        <Check className="w-4 h-4" strokeWidth={1.75} />
      ) : (
        <Copy className="w-4 h-4" strokeWidth={1.75} />
      )}
    </button>
  );

  const ActionButtons = () => {
    const buttons = (
      <>
        {ReadAloudButton && (
          <ReadAloudButton
            state={readAloud.state}
            speedEnabled={readAloud.speedEnabled}
            onClick={handleReadAloud}
            onToggleSpeed={readAloud.toggleSpeed}
          />
        )}
        <CopyButton />
      </>
    );

    // Step 1i item 2 (census): exactly ONE copy affordance per message at
    // every width. The bubble used to draw two action rows — this top-right
    // overlay and a bottom row — each with its own copy button. Below
    // Tailwind's sm breakpoint (640px) neither row is hover-hidden, so phones
    // showed both at once (the command centre had to hide one with local
    // CSS). The bottom row is gone; the top-right overlay (the Claude apps'
    // placement, always visible on touch widths, hover-revealed from sm up)
    // is the single action row.
    return (
      <div className="absolute top-1 right-1 flex items-center gap-1">
        {buttons}
      </div>
    );
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
          background={backgroundIdentity}
          childState={backgroundChildState}
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

  // Thinking is collapsed by default in the resting screen view; the collapsed
  // header still shows a short preview. This mirrors the shared projection's
  // `thinking` item instead of auto-expanding thinking-only messages.

  return (
    <div className="w-full">
      {/* Thinking block */}
      {hasThinking && (
        <div className="mb-1">
          <ThinkingBlock
            content={thinking}
            isOpen={showThinking}
            onToggle={() => setShowThinking(!showThinking)}
          />
        </div>
      )}

      {/* Error message rendering */}
      {isAssistant && message.error && (
        <div className="api-error-message pl-3 pr-8 border-l-2 border-sv-error-400 bg-sv-error-50 dark:bg-sv-error-950/30 rounded-r-lg py-2 px-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-sv-error-500 shrink-0 mt-0.5" strokeWidth={1.75} />
            <div className="min-w-0">
              <p className="text-sm text-sv-error-700 dark:text-sv-error-400 font-medium">API Error</p>
              <p className="text-sm text-sv-error-600 dark:text-sv-error-300 mt-0.5">{message.error.message}</p>
              {(message.error.provider || message.error.model) && (
                <p className="text-xs text-sv-error-400 mt-1">
                  {[message.error.provider, message.error.model].filter(Boolean).join(' / ')}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Activity indicator for messages with no visible content */}
      {isAssistant && !hasVisibleContent && !hasThinking && (
        <div className="pl-4 pr-8 border-l-2 border-sv-neutral-200">
          <ActivityIndicator thinking={null} isStreaming={isStreamingThis} />
        </div>
      )}

      {/* Goal-driven continuations arrive as ordinary user messages; without a
          label the transcript reads as if the operator typed them. */}
      {isUser && isGoalContinuation && (
        <div className="mb-1 text-[10px] uppercase tracking-wide text-sv-neutral-400" data-testid="goal-continuation-label">
          🎯 Goal continuation · sent automatically
        </div>
      )}

      {/* Message content */}
      {hasVisibleContent && (
        <div
          className={`
            relative group break-words overflow-hidden
            ${isUser
              ? 'bg-sv-neutral-100 dark:bg-sv-neutral-plain-800 rounded-2xl px-4 py-3 text-content-primary dark:text-content-primary-dark text-sm shadow-xs'
              : isTool
                ? 'bg-surface-subtle dark:bg-surface-dark-subtle border border-outline-default dark:border-outline-default-dark rounded-lg p-3'
                : 'pl-3 pr-8 border-l-2 border-transparent text-content-primary dark:text-content-primary-dark text-sm leading-relaxed'
            }
          `}
        >
          {/* Action buttons - top-right overlay, the single action row */}
          {isAssistant && !isStreamingThis && !shouldCollapse && (
            <ActionButtons />
          )}

          {isStreamingThis ? (
            <StreamingText text={displayText} />
          ) : (
            <>
            <div id={`msg-content-${message.id}`} className={`prose prose-sm max-w-none prose-gray prose-table:w-full prose-compact${shouldCollapse ? ' max-h-[6rem] overflow-hidden' : ''}`}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: ({ children }) => (
                    <CodeBlock>{children}</CodeBlock>
                  ),
                  code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
                    const match = /language-(\w+)/.exec(className || '');
                    return (
                      <code
                        className={`font-mono text-xs [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:rounded-none [pre_&]:text-inherit ${match ? `language-${match[1]}` : ''}`}
                        {...props}
                      >
                        {children}
                      </code>
                    );
                  },
                  // Table components - compact Kimi-style
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-1.5">
                      <table className="w-full border-collapse border border-sv-neutral-200 text-xs">
                        {children}
                      </table>
                    </div>
                  ),
                  thead: ({ children }) => (
                    <thead className="bg-sv-neutral-50">{children}</thead>
                  ),
                  tbody: ({ children }) => (
                    <tbody className="divide-y divide-sv-neutral-200">{children}</tbody>
                  ),
                  tr: ({ children }) => (
                    <tr className="border-b border-sv-neutral-200 even:bg-sv-neutral-50/50">{children}</tr>
                  ),
                  th: ({ children }) => (
                    <th className="border border-sv-neutral-200 px-2 py-1 text-left text-xs font-semibold text-sv-neutral-700">
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td className="border border-sv-neutral-200 px-2 py-1 text-xs text-sv-neutral-700">
                      {children}
                    </td>
                  ),
                  p: ({ children }) => <p className="mb-1 last:mb-0 leading-normal text-sm">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc pl-4 mb-1 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-4 mb-1 space-y-0.5">{children}</ol>,
                  li: ({ children }) => <li className="leading-normal text-sm">{children}</li>,
                  h1: ({ children }) => <h1 className="text-base font-bold mt-3 mb-1">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-sm font-bold mt-2.5 mb-1">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-0.5">{children}</h3>,
                  h4: ({ children }) => <h4 className="text-sm font-semibold mt-1.5 mb-0.5">{children}</h4>,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-2 border-sv-neutral-300 pl-3 my-1.5 text-sv-neutral-600 text-sm italic">
                      {children}
                    </blockquote>
                  ),
                  hr: () => <hr className="my-2 border-sv-neutral-200" />,
                  a: ({ children, href }) => (
                    <a href={href} className="text-sv-info-600 hover:text-sv-info-700 underline" target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {displayText}
              </ReactMarkdown>
            </div>
            {shouldCollapse && (
              <>
                <div className="h-6 -mt-6 collapse-fade-gradient pointer-events-none" />
                <button
                  onClick={() => setManuallyExpanded(true)}
                  className="text-xs text-sv-info-600 hover:text-sv-info-700 mt-0.5"
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
                className="text-xs text-sv-info-600 hover:text-sv-info-700 mt-0.5"
                type="button"
                aria-expanded={true}
                aria-controls={`msg-content-${message.id}`}
              >
                ▴ Show less
              </button>
            )}
            {/* Action buttons: none at the bottom — the top-right overlay is
                the one action row (one copy affordance at every width) */}
            </>
          )}
        </div>
      )}

      {/* Timestamp */}
      <span className="text-[10px] text-content-muted dark:text-content-muted-dark mt-1 block">
        {formatTime(message.timestamp)}
      </span>
    </div>
  );
});
