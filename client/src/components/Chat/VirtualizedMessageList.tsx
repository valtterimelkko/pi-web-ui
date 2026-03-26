import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { LiveMessage } from '../../hooks/useSessionStream.js';
import { MessageBubble } from './MessageBubble';

export interface VirtualizedMessageListHandle {
  scrollToIndex: (index: number, behavior?: 'auto' | 'smooth') => void;
  scrollToBottom: () => void;
}

interface VirtualizedMessageListProps {
  messages: LiveMessage[];
  isStreaming: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
  hasSession?: boolean;
  onCreateSession?: () => void;
}

type ListItem = {
  message: LiveMessage;
  index: number;
};

// Custom scroller component for Virtuoso
const ScrollerComponent = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  function ScrollerComponent({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={`flex-1 overflow-y-auto overflow-x-hidden ${className || ''}`}
        {...props}
      />
    );
  }
);

// Custom list container component
const ListComponent = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  function ListComponent({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={`flex flex-col space-y-2 p-3 sm:p-4 lg:p-6 max-w-4xl mx-auto ${className || ''}`}
        {...props}
      />
    );
  }
);

// Empty state component
function EmptyState({ hasSession, onCreateSession }: { hasSession: boolean; onCreateSession?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-gray-100 mb-4">
        <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
        </svg>
      </div>
      {hasSession ? (
        <>
          <h2 className="text-lg font-medium text-gray-900 mb-2">
            Ready to help
          </h2>
          <p className="text-gray-500 max-w-md text-sm">
            Start a conversation by typing a message below. I can help you with coding, analysis, and more.
          </p>
        </>
      ) : (
        <>
          <h2 className="text-lg font-medium text-gray-900 mb-2">
            Create a session to begin
          </h2>
          <p className="text-gray-500 max-w-md text-sm mb-6">
            Start a new coding session to interact with the AI assistant.
          </p>
          {onCreateSession && (
            <button
              onClick={onCreateSession}
              className="px-6 py-2.5 bg-gray-900 hover:bg-gray-800 rounded-full text-white text-sm font-medium transition-colors"
            >
              Create new session
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Extract skill name from skill content (XML format)
function extractSkillName(content: string): string | null {
  // Look for <skill name="skill-name"> format
  const match = content.match(/<skill name="([^"]+)"/);
  return match ? match[1] : null;
}

// Check if message content is skill content and extract info for display
function getSkillContentInfo(message: LiveMessage): { isSkillContent: boolean; skillName?: string } {
  // Extract text content from ContentPart[]
  const content = message.content
    .map(c => c.text || c.thinking || '')
    .join('');
  
  const trimmed = content.trim();
  
  // Skill content indicators (XML format from SDK):
  // Require BOTH opening AND closing tags to avoid false positives
  const hasSkillOpenTag = trimmed.includes('<skill name="') || trimmed.includes('&lt;skill name="');
  const hasSkillCloseTag = trimmed.includes('</skill>') || trimmed.includes('&lt;/skill&gt;');
  const hasFullSkillStructure = hasSkillOpenTag && hasSkillCloseTag;
  
  // Skill content indicators (Markdown format after processing):
  const hasLectureHeader = trimmed.startsWith('# Lecture Website Builder');
  const hasSkillHeader = trimmed.startsWith('# Skill:');
  const hasSkillStructure = trimmed.includes('### Skill Purpose') && trimmed.includes('### Workflow');
  
  const isSkillContent = hasFullSkillStructure || hasLectureHeader || hasSkillHeader || hasSkillStructure;
  
  if (isSkillContent) {
    const skillName = extractSkillName(trimmed);
    return { isSkillContent: true, skillName: skillName || undefined };
  }
  
  return { isSkillContent: false };
}

// Memoized message item component for performance
const MessageItem = memo(function MessageItem({
  message,
  isLast,
  isCurrentRun,
}: {
  message: LiveMessage;
  isLast: boolean;
  isCurrentRun: boolean;
}) {
  return (
    <MessageBubble message={message} isLast={isLast} isCurrentRun={isCurrentRun} />
  );
}, (prevProps, nextProps) => {
  // Custom comparison for better memoization
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.isLast === nextProps.isLast &&
    prevProps.isCurrentRun === nextProps.isCurrentRun &&
    prevProps.message.toolResult?.output === nextProps.message.toolResult?.output
  );
});

export const VirtualizedMessageList = forwardRef<
  VirtualizedMessageListHandle,
  VirtualizedMessageListProps
>(function VirtualizedMessageList(
  { messages, isStreaming, onAtBottomChange, hasSession = true, onCreateSession },
  ref
) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);

  // Identity guard for scroll events
  const scrollIdentityRef = useRef<string>('');
  const sessionId = useMemo(() => messages[0]?.id || 'default', [messages]);

  useEffect(() => {
    const identity = crypto.randomUUID();
    scrollIdentityRef.current = identity;

    return () => {
      scrollIdentityRef.current = ''; // Invalidate scroll handlers
    };
  }, [sessionId]);

  const identity = scrollIdentityRef.current;

  // Show user + assistant messages with skill content transformation
  // Skill content (from /skill:name commands) is transformed to show a brief placeholder
  // instead of the full verbose content. This preserves message context while keeping UI clean.
  // EXCEPTION: subagent tool calls are shown with hierarchical display like CLI.
  // EXCEPTION: read tool calls are shown for skill-loading visibility (clean Kimi-style)
  const visibleMessages = useMemo(() =>
    messages
      .filter(m =>
        m.role === 'user' ||
        m.role === 'assistant' ||
        (m.role === 'tool' && m.toolCall?.name === 'subagent') ||
        (m.role === 'tool' && m.toolCall?.name === 'read')
      )
      .map(m => {
        // Transform skill content to brief placeholder
        const skillInfo = getSkillContentInfo(m);
        if (skillInfo.isSkillContent) {
          const placeholder = skillInfo.skillName
            ? `📚 **Skill loaded: ${skillInfo.skillName}**`
            : '📚 **Skill loaded**';
          return {
            ...m,
            content: [{ type: 'text' as const, text: placeholder }]
          };
        }
        return m;
      }),
    [messages]
  );

  // Create list items from visible messages
  const listItems = useMemo<ListItem[]>(() =>
    visibleMessages.map((message, index) => ({ message, index })),
    [visibleMessages]
  );

  // Find the index of the last user message to scope collapsing to the current agent run
  const lastUserMessageIndex = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].role === 'user') return i;
    }
    return -1;
  }, [visibleMessages]);

  // Handle scroll position changes with identity guard
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    if (scrollIdentityRef.current !== identity) return;
    onAtBottomChange?.(atBottom);
  }, [onAtBottomChange, identity]);

  // Store scroller reference with identity guard
  const handleScrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    if (scrollIdentityRef.current !== identity) return;
    scrollerRef.current = ref instanceof HTMLElement ? ref : null;
  }, [identity]);

  // Follow output behavior - auto-scroll when at bottom
  const handleFollowOutput = useCallback((isAtBottom: boolean) => {
    if (scrollIdentityRef.current !== identity) return false;
    if (isAtBottom) return 'auto' as const;
    const scroller = scrollerRef.current;
    if (scroller) {
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      // Auto-scroll if within threshold
      if (gap <= 500) return 'auto' as const;
    }
    return false;
  }, [identity]);

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number, behavior: 'auto' | 'smooth' = 'smooth') => {
      virtuosoRef.current?.scrollToIndex({
        index,
        align: 'center',
        behavior,
      });
    },
    scrollToBottom: () => {
      if (listItems.length > 0) {
        virtuosoRef.current?.scrollToIndex({
          index: listItems.length - 1,
          align: 'end',
          behavior: 'auto',
        });
      }
    },
  }), [listItems.length]);

  // Auto-scroll to bottom when new messages arrive during streaming
  useEffect(() => {
    if (scrollIdentityRef.current !== identity) return;
    if (isStreaming && listItems.length > 0) {
      virtuosoRef.current?.scrollToIndex({
        index: listItems.length - 1,
        align: 'end',
        behavior: 'smooth',
      });
    }
  }, [isStreaming, listItems.length, identity]);

  if (visibleMessages.length === 0) {
    return <EmptyState hasSession={hasSession} onCreateSession={onCreateSession} />;
  }

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={listItems}
      className="h-full"
      scrollerRef={handleScrollerRef}
      followOutput={handleFollowOutput}
      // Estimated item height for virtualization
      defaultItemHeight={80}
      // Render more items outside viewport for smoother scrolling
      increaseViewportBy={{ top: 400, bottom: 400 }}
      overscan={200}
      minOverscanItemCount={3}
      atBottomStateChange={handleAtBottomChange}
      // Start at the bottom (most recent messages)
      initialTopMostItemIndex={{
        index: Math.max(0, listItems.length - 1),
        align: 'end',
      }}
      components={{
        Scroller: ScrollerComponent,
        List: ListComponent,
      }}
      // Use message ID as key for stable rendering
      computeItemKey={(_index, item) => item.message.id}
      itemContent={(_index, item) => {
        const isLast = item.index === listItems.length - 1;
        const isCurrentRun = item.index > lastUserMessageIndex;
        return (
          <MessageItem
            message={item.message}
            isLast={isLast}
            isCurrentRun={isCurrentRun}
          />
        );
      }}
    />
  );
});
