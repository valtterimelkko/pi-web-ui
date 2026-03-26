import { Sparkles } from 'lucide-react';
import type { Message } from '../../store';
import { MessageBubble } from './MessageBubble';
import { messageToLiveMessage } from '../../lib/messageAdapter';

interface MessageListProps {
  messages: Message[];
  hasSession: boolean;
  onCreateSession?: () => void;
}

export function MessageList({ messages, hasSession, onCreateSession }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <Sparkles className="w-10 h-10 text-gray-300 mb-4" />

        {!hasSession ? (
          <>
            <h2 className="text-lg font-medium text-gray-900 mb-2">
              Create a session to begin
            </h2>
            <p className="text-gray-500 max-w-md mb-6 text-sm">
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
        ) : (
          <>
            <h2 className="text-lg font-medium text-gray-900 mb-2">
              Ready to help
            </h2>
            <p className="text-gray-500 max-w-md text-sm">
              Start a conversation by typing a message below. I can help you with coding, analysis, and more.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col space-y-4 p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto">
      {messages.map((message, index) => (
        <MessageBubble
          key={message.id}
          message={messageToLiveMessage(message)}
          isLast={index === messages.length - 1}
        />
      ))}
    </div>
  );
}
