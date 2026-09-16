import { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useSessionStore } from '../../store/sessionStore';
import { VirtualizedMessageList, type VirtualizedMessageListHandle } from '../Chat/VirtualizedMessageList';
import { messagesToLiveMessages } from '../../lib/messageAdapter';

export interface DriveModeSessionPaneProps {
  /** Display name of the session being driven by the voice surface. */
  sessionDisplayName: string;
  modelName: string;
  /**
   * The session this pane follows. Defaults to the tab's current session;
   * with lanes it is the ADDRESSED lane's session, so the pane always shows
   * the worker the voice mode is currently talking to.
   */
  sessionId?: string | null;
}

/**
 * The live session, in the desktop arrangement (Child V, desktop mode).
 *
 * Operator, verbatim (2026-09-16):
 *   "when the screen is split and displays the session, it's super raw content,
 *    maybe directly from the SDK stream or so — not organised like in the
 *    regular session view. fix this. it should look just like the outputs looks
 *    when in regular session view without voice mode."
 *
 * So this is deliberately not a second transcript renderer. It reads the same
 * `useSessionStore` the chat screen reads and renders the SAME list component —
 * `VirtualizedMessageList` — through the SAME adapter, which is where tool-call
 * runs collapse into `ToolGroupContainer`, skill payloads are transformed and
 * per-tool verbosity lives. The flat legacy `MessageList` (one bare bubble per
 * message, no grouping) is what made this pane look raw; it is not used here.
 *
 * With lanes, the pane follows the addressed lane's own projection
 * (`sessionMessages` / `streamingSessions`, kept fresh for subscribed
 * background sessions) rather than the tab-global current session, so taking a
 * different lane's floor shows that lane's work.
 *
 * Nothing here is a control surface — reading and watching only; the voice lane
 * remains the only thing that sends.
 */
export function DriveModeSessionPane({ sessionDisplayName, modelName, sessionId }: DriveModeSessionPaneProps) {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const shownSessionId = sessionId ?? currentSessionId;
  const globalMessages = useSessionStore((s) => s.messages);
  const projectedMessages = useSessionStore((s) =>
    shownSessionId ? s.sessionMessages[shownSessionId] : undefined
  );
  const globalStreaming = useSessionStore((s) => s.isStreaming);
  const projectedStreaming = useSessionStore((s) =>
    shownSessionId ? s.streamingSessions[shownSessionId] : undefined
  );
  const getWorkerStatus = useSessionStore((s) => s.getWorkerStatus);
  const transferReady = useSessionStore((s) =>
    shownSessionId ? s.isTransferReady(shownSessionId) : false
  );

  // The addressed session's projection when we hold one (subscribed background
  // lanes live there), the tab's current session otherwise.
  const messages = projectedMessages ?? globalMessages;
  const isStreaming = projectedStreaming ?? globalStreaming;
  const workerStatus = shownSessionId ? getWorkerStatus(shownSessionId) : undefined;

  const listRef = useRef<VirtualizedMessageListHandle>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const messageCount = messages.length;

  // Same memo as ChatView: a new array per render would defeat the list's own
  // memoisation on every store tick.
  const liveMessages = useMemo(() => messagesToLiveMessages(messages), [messages]);

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setShowScrollButton(!atBottom && messageCount > 0);
  }, [messageCount]);

  const handleScrollToBottom = useCallback(() => {
    listRef.current?.scrollToBottom();
  }, []);

  return (
    <section
      data-testid="drive-session-pane"
      data-drive-session={shownSessionId ?? ''}
      aria-label="Live session"
      className="flex flex-col h-full min-h-0 w-full bg-white dark:bg-gray-950"
    >
      <header className="flex items-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {sessionDisplayName}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{modelName}</div>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
          {isStreaming ? (
            <>
              <span
                data-testid="drive-session-streaming"
                aria-hidden="true"
                className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"
              />
              Working
            </>
          ) : (
            <>
              <span aria-hidden="true" className="w-2 h-2 rounded-full bg-gray-300 dark:bg-gray-600" />
              Idle
            </>
          )}
        </div>
      </header>
      <div className="flex-1 min-h-0 relative flex flex-col overflow-hidden">
        <VirtualizedMessageList
          ref={listRef}
          messages={liveMessages}
          isStreaming={isStreaming}
          sessionId={shownSessionId ?? undefined}
          onAtBottomChange={handleAtBottomChange}
          hasSession={!!shownSessionId}
          workerStatus={workerStatus}
          transferReady={transferReady}
        />
        {showScrollButton && (
          <button
            onClick={handleScrollToBottom}
            data-testid="drive-session-scroll-bottom"
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 p-1.5 bg-surface dark:bg-surface-dark border border-outline-default dark:border-outline-default-dark rounded-full shadow-md hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle transition-colors z-10"
            type="button"
          >
            <ArrowDown className="w-4 h-4 text-content-secondary dark:text-content-secondary-dark" />
          </button>
        )}
      </div>
    </section>
  );
}
