import { useEffect, useState } from 'react';
import { useSessionStore } from '../../store';
import { useChatStore } from '../../store/chatStore';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { TreeView, type TreeEntry } from '../Tree';
import { NewSessionModal } from '../Session';
import { Info, ChevronsUpDown, PanelRight } from 'lucide-react';
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
  const { createNewSession } = useWebSocket();

  // Get current session name
  const { sidebarOpen, toggleSidebar } = useChatStore();
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

  // Scroll to bottom when messages change
  useEffect(() => {
    const scrollArea = document.getElementById('chat-scroll-area');
    if (scrollArea) {
      scrollArea.scrollTop = scrollArea.scrollHeight;
    }
  }, [messages, isStreaming]);

  const handleCreateSession = (cwd?: string) => {
    createNewSession(cwd);
  };

  return (
    <div className="flex flex-col h-full bg-white" data-testid="chat-interface">
      {/* Header - always shown */}
      <header className="flex items-center gap-2 px-2 py-2 border-b border-gray-200 bg-white min-w-0">
        {/* Sidebar toggle */}
        {!sidebarOpen && (
          <button
            onClick={toggleSidebar}
            className="flex-shrink-0 p-2 hover:bg-gray-100 rounded-lg transition-colors"
            title="Open sidebar"
          >
            <PanelRight className="w-5 h-5 text-gray-500" />
          </button>
        )}

        {/* Session title */}
        <h1 className="flex-1 min-w-0 text-sm font-medium text-gray-900 truncate px-2">
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
              <Info className="w-4 h-4 text-gray-400" />
            </button>
            <button
              onClick={() => setShowTreeView(true)}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="View conversation tree"
            >
              <ChevronsUpDown className="w-4 h-4 text-gray-400" />
            </button>
          </div>
        )}
      </header>

      {/* Main content area */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Message List */}
        <div
          id="chat-scroll-area"
          className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
        >
          <MessageList
            messages={messages}
            hasSession={!!currentSessionId}
            onCreateSession={() => setShowNewSessionModal(true)}
          />
        </div>

        {/* Message Input */}
        <div className="bg-white pb-safe">
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
