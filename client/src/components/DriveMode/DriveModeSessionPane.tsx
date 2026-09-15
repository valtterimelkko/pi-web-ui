import { useEffect, useRef } from 'react';
import { useSessionStore } from '../../store/sessionStore';
import { MessageList } from '../Chat/MessageList';

export interface DriveModeSessionPaneProps {
  /** Display name of the session being driven by the voice surface. */
  sessionDisplayName: string;
  modelName: string;
}

/**
 * The live session, beside the voice surface (Child V, desktop mode).
 *
 * This is the REAL session view: it reads the same `useSessionStore` the chat
 * screen uses and renders the same `MessageBubble` through `MessageList`, so
 * there is no second transcript, no second event pipeline and no fork to drift.
 * Nothing here is a control surface — reading and watching only; the voice
 * lane remains the only thing that sends.
 */
export function DriveModeSessionPane({ sessionDisplayName, modelName }: DriveModeSessionPaneProps) {
  const messages = useSessionStore((s) => s.messages);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageCount = messages.length;

  // Follow the live end of the conversation: the point of the pane is watching
  // the work happen while the voice lane stays usable.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messageCount, isStreaming]);

  return (
    <section
      data-testid="drive-session-pane"
      aria-label="Live session"
      className="flex flex-col h-full min-h-0 w-full bg-white dark:bg-gray-950"
    >
      <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
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
      <div ref={scrollRef} data-testid="drive-session-scroll" className="flex-1 min-h-0 overflow-y-auto">
        <MessageList messages={messages} hasSession={!!currentSessionId} />
      </div>
    </section>
  );
}
