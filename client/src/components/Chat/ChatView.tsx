import { useEffect, useState } from 'react';
import { useSessionStore } from '../../store';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { TreeView, type TreeEntry } from '../Tree';
import { Sparkles, GitBranch } from 'lucide-react';

export function ChatView() {
  const messages = useSessionStore((state) => state.messages);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isLoading = useSessionStore((state) => state.isLoading);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [showTreeView, setShowTreeView] = useState(false);

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

  const getStatusText = () => {
    if (isStreaming) return 'Thinking...';
    if (isLoading) return 'Loading...';
    return 'Ready';
  };

  const getStatusColor = () => {
    if (isStreaming) return 'text-amber-400';
    if (isLoading) return 'text-blue-400';
    return 'text-emerald-400';
  };

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/50 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-violet-600/20 rounded-lg">
            <Sparkles className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-100">
              Chat
            </h1>
            <p className="text-xs text-slate-400">
              {currentSessionId ? 'Session active' : 'No session'}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTreeView(true)}
            className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
            title="View conversation tree"
          >
            <GitBranch className="w-5 h-5 text-slate-300" />
          </button>
          <div className={`flex items-center gap-2 text-sm ${getStatusColor()}`}>
            <span className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-amber-400 animate-pulse' : isLoading ? 'bg-blue-400' : 'bg-emerald-400'}`} />
            <span className="font-medium">{getStatusText()}</span>
          </div>
        </div>
      </header>

      {/* Main content area with landmark */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Message List */}
        <div 
          id="chat-scroll-area"
          className="flex-1 overflow-y-auto overflow-x-hidden"
        >
          <MessageList messages={messages} />
        </div>

        {/* Message Input */}
        <div className="border-t border-slate-800 bg-slate-900/50 backdrop-blur-sm">
          <div className="max-w-4xl mx-auto p-4">
            <MessageInput disabled={!currentSessionId || isLoading} />
          </div>
        </div>
      </main>

      {/* Tree View Modal */}
      {showTreeView && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="w-full max-w-2xl mx-4">
            <TreeView
              entries={treeEntries}
              onClose={() => setShowTreeView(false)}
              onNavigate={(id) => {
                // Handle navigation to specific entry
                console.log('Navigate to:', id);
              }}
              onFork={(id) => {
                // Handle forking at entry
                console.log('Fork at:', id);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
