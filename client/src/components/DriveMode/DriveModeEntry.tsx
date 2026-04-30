import { useRef, useEffect } from 'react';
import { useSessionStore } from '../../store/sessionStore';

export interface DriveModeEntryProps {
  onNewSession: () => void;
  onContinueSession: () => void;
  onExit?: () => void;
}

export function DriveModeEntry({ onNewSession, onContinueSession, onExit }: DriveModeEntryProps) {
  const newSessionRef = useRef<HTMLButtonElement>(null);
  const sessions = useSessionStore((s) => s.sessions);
  const hasSessions = sessions.length > 0;

  useEffect(() => {
    newSessionRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-col items-center justify-center h-full w-full px-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">
        Pi Drive Mode
      </h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8">
        Voice-first, hands-free
      </p>

      <div className="w-[80%] flex flex-col gap-4">
        <button
          ref={newSessionRef}
          onClick={onNewSession}
          className="w-full min-h-16 bg-blue-600 text-white rounded-xl text-lg font-medium hover:bg-blue-700 transition-colors active:scale-[0.98] select-none touch-manipulation"
          aria-label="Start a new session"
          type="button"
        >
          New Session
        </button>

        <button
          onClick={onContinueSession}
          disabled={!hasSessions}
          className={`w-full min-h-16 rounded-xl text-lg font-medium border transition-colors select-none touch-manipulation ${
            hasSessions
              ? 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 active:scale-[0.98]'
              : 'bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600 cursor-not-allowed'
          }`}
          aria-label="Continue an existing session"
          type="button"
        >
          Continue Session
        </button>
      </div>

      <button
        onClick={() => onExit?.()}
        className="mt-8 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        type="button"
      >
        Exit Drive Mode
      </button>
    </div>
  );
}
