import { useRef, useEffect } from 'react';
import type { Session } from '../../store';
import { useTransferStore } from '../../store/transferStore';
import { useSessionStore } from '../../store';
import { SessionItem } from './SessionItem';

interface SessionListProps {
  sessions: Session[];
  currentSessionId: string | null;
}

export function SessionList({ sessions, currentSessionId }: SessionListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const currentItemRef = useRef<HTMLDivElement>(null);
  const transferDragging = useTransferStore(state => state.isDragging);
  const transferSource = useTransferStore(state => state.source);
  const hoverTargetId = useTransferStore(state => state.hoverTargetId);
  const setHoverTarget = useTransferStore(state => state.setHoverTarget);
  const openConfirmNew = useTransferStore(state => state.openConfirmNew);
  const openConfirmExisting = useTransferStore(state => state.openConfirmExisting);
  const endDrag = useTransferStore(state => state.endDrag);
  const getSessionDisplayName = useSessionStore(state => state.getSessionDisplayName);

  useEffect(() => {
    if (currentItemRef.current) {
      currentItemRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [currentSessionId]);

  const handleNewSessionDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setHoverTarget(null);
    const sourceId = e.dataTransfer.getData('application/session-id');
    if (!sourceId) return;
    const sourceSession = useSessionStore.getState().sessions.find(s => s.id === sourceId);
    if (!sourceSession) return;
    const displayName = getSessionDisplayName(sourceSession.path) || sourceSession.name || 'Session';
    openConfirmNew({
      sessionId: sourceSession.id,
      displayName,
      sdkType: sourceSession.sdkType || 'pi',
      cwd: sourceSession.cwd,
    });
    endDrag();
  };

  const handleNewSessionDragOver = (e: React.DragEvent) => {
    if (!transferDragging || !transferSource) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setHoverTarget('__new__');
  };

  const handleNewSessionDragLeave = () => {
    if (hoverTargetId === '__new__') {
      setHoverTarget(null);
    }
  };

  if (sessions.length === 0 && !transferDragging) {
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
            isDropTarget
          />
        </div>
      ))}

      {transferDragging && transferSource && (
        <div
          onDrop={handleNewSessionDrop}
          onDragOver={handleNewSessionDragOver}
          onDragLeave={handleNewSessionDragLeave}
          className={`
            mt-2 py-3 px-3 rounded-md border-2 border-dashed transition-all duration-150 text-center
            ${hoverTargetId === '__new__'
              ? 'border-blue-400 bg-blue-50 text-blue-600'
              : 'border-gray-300 bg-gray-50 text-gray-400 hover:border-gray-400'
            }
          `}
        >
          <p className="text-xs font-medium">Drop here to transfer to new session</p>
        </div>
      )}
    </div>
  );
}
