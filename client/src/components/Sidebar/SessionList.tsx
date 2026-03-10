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
        <div className="text-4xl mb-3">💬</div>
        <p className="text-slate-400 text-sm">No sessions found</p>
        <p className="text-slate-500 text-xs mt-1">
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
      className="h-full overflow-y-auto p-2 space-y-1 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
      style={{
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(148, 163, 184, 0.3) transparent',
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
