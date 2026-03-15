import { Bot, PlusCircle } from 'lucide-react';
import type { Message } from '../../store';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  messages: Message[];
  hasSession: boolean;
  onCreateSession?: () => void;
}

export function MessageList({ messages, hasSession, onCreateSession }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="p-4 bg-slate-800/50 rounded-2xl mb-4">
          <Bot className="w-12 h-12 text-violet-400" />
        </div>
        
        {!hasSession ? (
          <>
            <h2 className="text-xl font-semibold text-slate-100 mb-2">
              No Active Session
            </h2>
            <p className="text-slate-400 max-w-md mb-6">
              Create a new session to start chatting with the AI assistant.
            </p>
            {onCreateSession && (
              <button
                onClick={onCreateSession}
                className="flex items-center gap-2 px-6 py-3 bg-violet-600 hover:bg-violet-700 rounded-xl text-white font-medium transition-colors"
              >
                <PlusCircle className="w-5 h-5" />
                Start New Session
              </button>
            )}
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-slate-100 mb-2">
              Ready to help
            </h2>
            <p className="text-slate-400 max-w-md">
              Start a conversation by typing a message below. I can help you with coding, analysis, and more.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col space-y-6 p-4 sm:p-6 lg:p-8">
      {messages.map((message, index) => (
        <MessageBubble
          key={message.id}
          message={message}
          isLast={index === messages.length - 1}
        />
      ))}
    </div>
  );
}
