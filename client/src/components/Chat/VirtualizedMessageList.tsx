import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Loader2, AlertCircle } from 'lucide-react';
import type { LiveMessage } from '../../hooks/useSessionStream.js';
import type { WorkerStatus } from '../../store';
import { MessageBubble } from './MessageBubble';
// Screen-view rule primitives are imported from the shared package so the
// message list and the Internal API `view=screen` projection are defined by
// ONE body of code (the agent sees exactly what the user sees). See
// shared/src/screen-view.ts and SCREEN-VIEW-OBSERVABILITY-PLAN.md §3.
import {
  isVisibleTool,
  detectSkillContent,
  skillPlaceholder,
  findConsecutiveToolRuns,
} from '@pi-web-ui/shared';

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
  workerStatus?: WorkerStatus;
  /**
   * Stable identifier for the current session. Used to scope the scroll
   * identity guard so it resets exactly once per session switch — not every
   * time the first visible message changes during history replay.
   */
  sessionId?: string;
}

type MessageListItem = {
  kind: 'message';
  message: LiveMessage;
  index: number;
};

type ToolGroupListItem = {
  kind: 'tool_group';
  groupId: string;
  groupSize: number;
  startIndex: number;
};

type ListItem = MessageListItem | ToolGroupListItem;

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

// Worker status indicator component
function WorkerStatusIndicator({ status }: { status: WorkerStatus }) {
  const statusConfig: Record<WorkerStatus, { icon: typeof Loader2; text: string; className: string; animate: string }> = {
    spawning: {
      icon: Loader2,
      text: 'Connecting...',
      className: 'text-blue-600 bg-blue-50 border-blue-200',
      animate: 'animate-spin',
    },
    ready: {
      icon: Loader2,
      text: 'Ready',
      className: 'text-green-600 bg-green-50 border-green-200',
      animate: '',
    },
    streaming: {
      icon: Loader2,
      text: 'Streaming...',
      className: 'text-blue-600 bg-blue-50 border-blue-200',
      animate: 'animate-spin',
    },
    idle: {
      icon: Loader2,
      text: 'Idle',
      className: 'text-gray-600 bg-gray-50 border-gray-200',
      animate: '',
    },
    terminated: {
      icon: AlertCircle,
      text: 'Disconnected',
      className: 'text-gray-600 bg-gray-50 border-gray-200',
      animate: '',
    },
    disconnected: {
      icon: AlertCircle,
      text: 'Disconnected',
      className: 'text-gray-600 bg-gray-50 border-gray-200',
      animate: '',
    },
    error: {
      icon: AlertCircle,
      text: 'Error',
      className: 'text-red-600 bg-red-50 border-red-200',
      animate: '',
    },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${config.className} text-sm`}>
      <Icon className={`w-4 h-4 ${config.animate}`} />
      <span className="font-medium">{config.text}</span>
    </div>
  );
}

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

function ToolGroupToggle({
  size,
  isExpanded,
  onToggle,
}: {
  size: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 mb-1 transition-colors"
      type="button"
    >
      {isExpanded ? '▲ Collapse all' : '▼ Expand all'}
      <span className="text-gray-400">({size} tools)</span>
    </button>
  );
}

// Memoized message item component for performance
const MessageItem = memo(function MessageItem({
  message,
  isLast,
  isCurrentRun,
  forceExpanded,
}: {
  message: LiveMessage;
  isLast: boolean;
  isCurrentRun: boolean;
  forceExpanded?: boolean;
}) {
  return (
    <MessageBubble message={message} isLast={isLast} isCurrentRun={isCurrentRun} forceExpanded={forceExpanded} />
  );
}, (prevProps, nextProps) => {
  // Custom comparison for better memoization
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.isLast === nextProps.isLast &&
    prevProps.isCurrentRun === nextProps.isCurrentRun &&
    prevProps.message.toolResult?.output === nextProps.message.toolResult?.output &&
    prevProps.forceExpanded === nextProps.forceExpanded
  );
})

export const VirtualizedMessageList = forwardRef<
  VirtualizedMessageListHandle,
  VirtualizedMessageListProps
>(function VirtualizedMessageList(
  // isStreaming stays in the props API (callers pass it) but auto-scroll is now
  // driven entirely by Virtuoso's followOutput, so it is intentionally not read here.
  { messages, onAtBottomChange, hasSession = true, onCreateSession, workerStatus, sessionId },
  ref
) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  // Expand-all state keyed by the ID of the first message in each tool group
  const [toolGroupExpanded, setToolGroupExpanded] = useState<Record<string, boolean>>({});

  // Identity guard for scroll events. Keyed on the real session id when
  // provided so it resets once per session switch, falling back to the first
  // message id only when no session id is supplied.
  const scrollIdentityRef = useRef<string>('');
  const sessionKey = sessionId || messages[0]?.id || 'default';

  useEffect(() => {
    const identity = crypto.randomUUID();
    scrollIdentityRef.current = identity;

    return () => {
      scrollIdentityRef.current = ''; // Invalidate scroll handlers
    };
  }, [sessionKey]);

  const identity = scrollIdentityRef.current;

  // Show user + assistant messages with skill content transformation
  // Skill content (from /skill:name commands) is transformed to show a brief placeholder
  // instead of the full verbose content. This preserves message context while keeping UI clean.
  // EXCEPTION: subagent / Agent / Task tool calls are shown with hierarchical display like CLI.
  // EXCEPTION: read / Read tool calls are shown for skill-loading visibility.
  // EXCEPTION: todo / TodoWrite / TodoRead tool calls are shown with visual todo list display.
  const visibleMessages = useMemo(() =>
    messages
      .filter(m =>
        m.role === 'user' ||
        m.role === 'assistant' ||
        (m.role === 'tool' && !!m.toolCall?.name && isVisibleTool(m.toolCall.name))
      )
      .map(m => {
        // Transform skill content to brief placeholder (shared rule — same as
        // the server-side screen-view projection).
        const joined = m.content.map(c => c.text || c.thinking || '').join('');
        const skill = detectSkillContent(joined);
        if (skill.isSkill) {
          return {
            ...m,
            content: [{ type: 'text' as const, text: skillPlaceholder(skill.skillName) }]
          };
        }
        return m;
      }),
    [messages]
  );

  // Compute group metadata for consecutive runs of 3+ tool messages, using the
  // shared grouping primitive (same rule the server screen-view projection uses).
  const toolGroupMeta = useMemo(() => {
    const meta: Record<string, { groupId: string; groupSize: number; isFirst: boolean }> = {};
    const runs = findConsecutiveToolRuns(
      visibleMessages.length,
      (idx) => visibleMessages[idx].role === 'tool',
    );
    for (const run of runs) {
      const groupId = visibleMessages[run.start].id;
      for (let k = run.start; k < run.start + run.size; k++) {
        meta[visibleMessages[k].id] = { groupId, groupSize: run.size, isFirst: k === run.start };
      }
    }
    return meta;
  }, [visibleMessages]);

  // Create list items from visible messages. In the default/resting view, a
  // consecutive run of 3+ tools is represented by a single group row, matching
  // `projectDefaultViewFromEvents`. Expanding the group replaces that row with
  // the individual tool cards.
  const listItems = useMemo<ListItem[]>(() => {
    const items: ListItem[] = [];
    let i = 0;
    while (i < visibleMessages.length) {
      const meta = toolGroupMeta[visibleMessages[i].id];
      if (meta?.isFirst) {
        const isExpanded = toolGroupExpanded[meta.groupId] ?? false;
        if (!isExpanded) {
          items.push({
            kind: 'tool_group',
            groupId: meta.groupId,
            groupSize: meta.groupSize,
            startIndex: i,
          });
          i += meta.groupSize;
          continue;
        }
      }

      items.push({ kind: 'message', message: visibleMessages[i], index: i });
      i++;
    }
    return items;
  }, [visibleMessages, toolGroupMeta, toolGroupExpanded]);

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

  // Follow output behavior — the single source of streaming auto-scroll truth.
  // Only follow when the user is already pinned to the bottom; never yank a
  // user who has scrolled up back down. Instant ('auto') rather than 'smooth'
  // so streaming height growth doesn't fight an in-flight animation. Initial
  // bottom positioning on open/session-switch is handled by Virtuoso's
  // initialTopMostItemIndex (see below), not a competing effect.
  const handleFollowOutput = useCallback((isAtBottom: boolean) => {
    return isAtBottom ? ('auto' as const) : false;
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

  if (visibleMessages.length === 0) {
    return <EmptyState hasSession={hasSession} onCreateSession={onCreateSession} />;
  }

  // Show worker status when actively processing (spawning, streaming, or error)
  const showWorkerStatus = workerStatus && workerStatus !== 'idle' && workerStatus !== 'terminated' && workerStatus !== 'ready';

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        <Virtuoso
          ref={virtuosoRef}
          data={listItems}
          className="h-full"
          followOutput={handleFollowOutput}
          // Estimated item height for virtualization. Set to a realistic
          // median (reasoning blocks, tool cards, and code output are tall) so
          // unmeasured items don't trigger large scroll corrections — the main
          // cause of scroll "jumping" when scrolling up through long sessions.
          defaultItemHeight={240}
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
          // Use stable keys for message and collapsed group rows
          computeItemKey={(_index, item) =>
            item.kind === 'tool_group' ? `tool-group:${item.groupId}` : item.message.id
          }
          itemContent={(_index, item) => {
            if (item.kind === 'tool_group') {
              return (
                <ToolGroupToggle
                  size={item.groupSize}
                  isExpanded={false}
                  onToggle={() =>
                    setToolGroupExpanded(prev => ({
                      ...prev,
                      [item.groupId]: true,
                    }))
                  }
                />
              );
            }

            const isLast = item.index === visibleMessages.length - 1;
            const isCurrentRun = item.index > lastUserMessageIndex;
            const groupMeta = toolGroupMeta[item.message.id];
            const isGroupExpanded = groupMeta
              ? (toolGroupExpanded[groupMeta.groupId] ?? false)
              : false;
            return (
              <>
                {groupMeta?.isFirst && (
                  <ToolGroupToggle
                    size={groupMeta.groupSize}
                    isExpanded={isGroupExpanded}
                    onToggle={() =>
                      setToolGroupExpanded(prev => ({
                        ...prev,
                        [groupMeta.groupId]: !prev[groupMeta.groupId],
                      }))
                    }
                  />
                )}
                <MessageItem
                  message={item.message}
                  isLast={isLast}
                  isCurrentRun={isCurrentRun}
                  forceExpanded={groupMeta ? isGroupExpanded : undefined}
                />
              </>
            );
          }}
        />
      </div>
      {/* Worker status indicator - shown at bottom when active */}
      {showWorkerStatus && (
        <div className="flex-shrink-0 px-4 py-2 bg-white border-t border-gray-100">
          <WorkerStatusIndicator status={workerStatus} />
        </div>
      )}
    </div>
  );
});
