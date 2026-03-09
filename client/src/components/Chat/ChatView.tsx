import { useEffect } from 'react';
import { useSessionStore } from '../../store';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { Sparkles } from 'lucide-react';

export function ChatView() {
  const messages = useSessionStore((state) => state.messages);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isLoading = useSessionStore((state) => state.isLoading);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

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
            <p className="text-xs text-slate-500">
              {currentSessionId ? 'Session active' : 'No session'}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-2 text-sm ${getStatusColor()}`}>
            <span className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-amber-400 animate-pulse' : isLoading ? 'bg-blue-400' : 'bg-emerald-400'}`} />
            <span className="font-medium">{getStatusText()}</span>
          </div>
        </div>
      </header>

      {/* Message List */}
      <div 
        id="chat-scroll-area"
        className="flex-1 overflow-y-auto"
      >
        <MessageList messages={messages} />
      </div>

      {/* Message Input */}
      <div className="border-t border-slate-800 bg-slate-900/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto p-4">
          <MessageInput disabled={!currentSessionId || isLoading} />
        </div>
      </div>
    </div>
  );
}
