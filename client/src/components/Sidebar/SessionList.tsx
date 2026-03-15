import { useRef, useEffect } from 'react';
import type { Session } from '../../store';
import { SessionItem } from './SessionItem';

interface SessionListProps {
  sessions: Session[];
  currentSessionId: string | null;
}

export function SessionList({ sessions, currentSessionId }: SessionListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const currentItemRef = useRef<HTMLDivElement>(null);

  // Scroll current session into view
  useEffect(() => {
    if (currentItemRef.current) {
      currentItemRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [currentSessionId]);

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 text-center">
        <p className="text-gray-400 text-sm">No sessions found</p>
        <p className="text-gray-400 text-xs mt-1">
          Create a new session to get started
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="list"
      aria-label="Sessions"
      tabIndex={0}
      className="h-full overflow-y-auto px-2 py-1 space-y-0.5 focus:outline-none"
      style={{
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(209, 213, 219, 0.5) transparent',
      }}
    >
      {sessions.map((session) => (
        <div
          key={session.id}
          ref={session.id === currentSessionId ? currentItemRef : undefined}
        >
          <SessionItem
            session={session}
            isActive={session.id === currentSessionId}
          />
        </div>
      ))}
    </div>
  );
}
