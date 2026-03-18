import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { Message } from '../../store';
import { MessageBubble } from './MessageBubble';

export interface VirtualizedMessageListHandle {
  scrollToIndex: (index: number, behavior?: 'auto' | 'smooth') => void;
  scrollToBottom: () => void;
}

interface VirtualizedMessageListProps {
  messages: Message[];
  isStreaming: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
  hasSession?: boolean;
  onCreateSession?: () => void;
}

type ListItem = {
  message: Message;
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

// Memoized message item component for performance
const MessageItem = React.memo(function MessageItem({
  message,
  isLast,
  isCurrentRun,
}: {
  message: Message;
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

  // Create list items from messages
  const listItems = useMemo<ListItem[]>(() =>
    messages.map((message, index) => ({ message, index })),
    [messages]
  );

  // Find the index of the last user message to scope collapsing to the current agent run
  const lastUserMessageIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return i;
    }
    return -1;
  }, [messages]);

  // Handle scroll position changes
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    onAtBottomChange?.(atBottom);
  }, [onAtBottomChange]);

  // Store scroller reference
  const handleScrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    scrollerRef.current = ref instanceof HTMLElement ? ref : null;
  }, []);

  // Follow output behavior - auto-scroll when at bottom
  const handleFollowOutput = useCallback((isAtBottom: boolean) => {
    if (isAtBottom) return 'auto' as const;
    const scroller = scrollerRef.current;
    if (scroller) {
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      // Auto-scroll if within threshold
      if (gap <= 500) return 'auto' as const;
    }
    return false;
  }, []);

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
    if (isStreaming && listItems.length > 0) {
      virtuosoRef.current?.scrollToIndex({
        index: listItems.length - 1,
        align: 'end',
        behavior: 'smooth',
      });
    }
  }, [isStreaming, listItems.length]);

  if (messages.length === 0) {
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
