import { useEffect, useState, useRef } from 'react';
import { useSessionStore } from '../../store';
import { VirtualizedMessageList, type VirtualizedMessageListHandle } from './VirtualizedMessageList';
import { MessageInput } from './MessageInput';
import { TreeView, type TreeEntry } from '../Tree';
import { NewSessionModal } from '../Session';
import { Info, ChevronsUpDown, ArrowDown } from 'lucide-react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { SessionInfoModal } from '../StatusBar/SessionInfoModal';

interface ChatViewProps {
  onOpenSettings?: () => void;
}

export function ChatView({ onOpenSettings }: ChatViewProps) {
  const messages = useSessionStore((state) => state.messages);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isLoading = useSessionStore((state) => state.isLoading);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const [showTreeView, setShowTreeView] = useState(false);
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [showSessionInfo, setShowSessionInfo] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const listRef = useRef<VirtualizedMessageListHandle>(null);
  const { createNewSession } = useWebSocket();

  // Get current session name
  const currentSession = sessions.find(s => s.id === currentSessionId);
  const sessionTitle = currentSession?.name || currentSession?.firstMessage || 'New Session';

  // Convert messages to tree entries
  const treeEntries: TreeEntry[] = messages.map((msg, index) => ({
    id: msg.id,
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : '',
    timestamp: msg.timestamp,
    parentId: index > 0 ? messages[index - 1].id : undefined,
    children: index < messages.length - 1 ? [messages[index + 1].id] : [],
  }));

  // Handle scroll position changes
  const handleAtBottomChange = (atBottom: boolean) => {
    setIsAtBottom(atBottom);
    setShowScrollButton(!atBottom && messages.length > 0);
  };

  // Scroll to bottom button handler
  const handleScrollToBottom = () => {
    listRef.current?.scrollToBottom();
  };

  // Auto-scroll to bottom during streaming when at bottom
  useEffect(() => {
    if (isStreaming && isAtBottom && messages.length > 0) {
      listRef.current?.scrollToBottom();
    }
  }, [isStreaming, isAtBottom, messages.length]);

  const handleCreateSession = (cwd?: string) => {
    createNewSession(cwd);
  };

  return (
    <div className="flex flex-col h-full bg-white" data-testid="chat-interface">
      {/* Header - always shown */}
      <header className="flex items-center gap-2 px-2 py-2 border-b border-gray-200 bg-white min-w-0">
        {/* Session title — left-padded to clear the fixed sidebar toggle button */}
        <h1 className="flex-1 min-w-0 text-sm font-medium text-gray-900 truncate pl-12 pr-2">
          {currentSessionId ? sessionTitle : ''}
        </h1>

        {/* Right actions – only when session active */}
        {currentSessionId && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setShowSessionInfo(true)}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="Session info"
            >
              <Info className="w-5 h-5 text-gray-600" />
            </button>
            <button
              onClick={() => setShowTreeView(true)}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="View conversation tree"
            >
              <ChevronsUpDown className="w-5 h-5 text-gray-600" />
            </button>
          </div>
        )}
      </header>

      {/* Main content area */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {/* Message List - Virtualized for performance */}
        <VirtualizedMessageList
          ref={listRef}
          messages={messages}
          isStreaming={isStreaming}
          onAtBottomChange={handleAtBottomChange}
        />
        
        {/* Empty state when no session */}
        {!currentSessionId && messages.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center pointer-events-none">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-gray-100 mb-4">
              <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
              </svg>
            </div>
            <h2 className="text-lg font-medium text-gray-900 mb-2">
              Create a session to begin
            </h2>
            <p className="text-gray-500 max-w-md text-sm mb-6">
              Start a new coding session to interact with the AI assistant.
            </p>
            <button
              onClick={() => setShowNewSessionModal(true)}
              className="pointer-events-auto px-6 py-2.5 bg-gray-900 hover:bg-gray-800 rounded-full text-white text-sm font-medium transition-colors"
            >
              Create new session
            </button>
          </div>
        )}
        
        {/* Scroll to bottom button */}
        {showScrollButton && (
          <button
            onClick={handleScrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 p-2 bg-white border border-gray-200 rounded-full shadow-md hover:bg-gray-50 transition-colors z-10"
            title="Scroll to bottom"
          >
            <ArrowDown className="w-4 h-4 text-gray-600" />
          </button>
        )}

        {/* Message Input */}
        <div className="bg-white pb-safe flex-shrink-0">
          <div className="max-w-4xl mx-auto px-4 pb-4 pt-2">
            <MessageInput disabled={!currentSessionId || isLoading} onOpenSettings={onOpenSettings} />
          </div>
        </div>
      </main>

      {/* Tree View Modal */}
      {showTreeView && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="w-full max-w-2xl mx-4">
            <TreeView
              entries={treeEntries}
              onClose={() => setShowTreeView(false)}
              onNavigate={(id) => {
                console.log('Navigate to:', id);
              }}
              onFork={(id) => {
                console.log('Fork at:', id);
              }}
            />
          </div>
        </div>
      )}

      {/* New Session Modal */}
      <NewSessionModal
        isOpen={showNewSessionModal}
        onClose={() => setShowNewSessionModal(false)}
        onCreateSession={handleCreateSession}
      />

      {/* Session Info Modal */}
      <SessionInfoModal
        isOpen={showSessionInfo}
        onClose={() => setShowSessionInfo(false)}
      />
    </div>
  );
}
