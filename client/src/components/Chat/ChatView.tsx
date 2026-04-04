import { useEffect, useState, useRef } from 'react';
import { useSessionStore } from '../../store';
import { useNavigationStore } from '../../store/navigationStore';
import { VirtualizedMessageList, type VirtualizedMessageListHandle } from './VirtualizedMessageList';
import { MessageInput } from './MessageInput';
import { TreeView, type TreeEntry } from '../Tree';
import { NewSessionModal } from '../Session';
import { ArrowDown } from 'lucide-react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { SessionInfoModal } from '../StatusBar/SessionInfoModal';
import { messagesToLiveMessages } from '../../lib/messageAdapter';

interface ChatViewProps {
  onOpenSettings?: () => void;
}

export function ChatView({ onOpenSettings }: ChatViewProps) {
  const messages = useSessionStore((state) => state.messages);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isLoading = useSessionStore((state) => state.isLoading);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const getWorkerStatus = useSessionStore((state) => state.getWorkerStatus);
  const bottomNavCollapsed = useNavigationStore((state) => state.bottomNavCollapsed);
  const [showTreeView, setShowTreeView] = useState(false);
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [showSessionInfo, setShowSessionInfo] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const listRef = useRef<VirtualizedMessageListHandle>(null);
  const { createNewSession } = useWebSocket();

  // Get worker status for current session
  const workerStatus = currentSessionId ? getWorkerStatus(currentSessionId) : undefined;
  
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

  const handleCreateSession = (cwd?: string, sdkType?: 'pi' | 'claude') => {
    createNewSession(cwd, sdkType);
  };

  return (
    <div className="flex flex-col h-full bg-white" data-testid="chat-interface">
      {/* Main content area */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {/* Message List - Virtualized for performance */}
        <VirtualizedMessageList
          ref={listRef}
          messages={messagesToLiveMessages(messages)}
          isStreaming={isStreaming}
          onAtBottomChange={handleAtBottomChange}
          hasSession={!!currentSessionId}
          onCreateSession={() => setShowNewSessionModal(true)}
          workerStatus={workerStatus}
        />
        
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
        <div className={`bg-white pb-safe flex-shrink-0 transition-all duration-200 ${!bottomNavCollapsed ? 'pb-[70px]' : ''}`}>
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
