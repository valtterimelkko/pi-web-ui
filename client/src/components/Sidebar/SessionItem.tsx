import { useState } from 'react';
import { Trash2, Edit2, Check, X } from 'lucide-react';
import type { Session } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
}

export function SessionItem({ session, isActive }: SessionItemProps) {
  const { switchSession, setSessionName } = useWebSocket();
  const [showActions, setShowActions] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name || '');

  const handleClick = () => {
    if (!isActive && !isEditing) {
      switchSession(session.path);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Delete this session? This cannot be undone.')) {
      // TODO: Implement delete via API
      console.log('Delete session:', session.id);
    }
  };

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
    setEditName(session.name || '');
  };

  const handleCancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(false);
    setEditName(session.name || '');
  };

  const handleSaveEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    const trimmedName = editName.trim();
    if (trimmedName) {
      setSessionName(session.id, trimmedName);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (isEditing) {
        const trimmedName = editName.trim();
        if (trimmedName) {
          setSessionName(session.id, trimmedName);
        }
        setIsEditing(false);
      } else {
        handleClick();
      }
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditName(session.name || '');
    }
  };

  // Format relative time
  const getRelativeTime = (date: Date | string) => {
    const now = new Date();
    const then = new Date(date);
    const diffMs = now.getTime() - then.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    return then.toLocaleDateString();
  };

  // Get display name (custom name or first message)
  const displayName = session.name || session.firstMessage || 'New session';

  return (
    <div
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      role="listitem"
      tabIndex={0}
      className={`
        group relative py-2 px-3 rounded-md cursor-pointer transition-all duration-150 outline-none
        ${isActive
          ? 'bg-teal-50 border-l-2 border-teal-500'
          : 'hover:bg-gray-100 border-l-2 border-transparent'
        }
      `}
    >
      {isEditing ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 px-2 py-1 text-sm bg-white border border-gray-300 rounded text-gray-900 focus:outline-none focus:border-teal-500 text-base"
            placeholder="Session name"
            autoFocus
          />
          <button
            onClick={handleSaveEdit}
            className="p-1 hover:bg-gray-200 rounded transition-colors"
            title="Save"
          >
            <Check className="w-3.5 h-3.5 text-green-600" />
          </button>
          <button
            onClick={handleCancelEdit}
            className="p-1 hover:bg-gray-200 rounded transition-colors"
            title="Cancel"
          >
            <X className="w-3.5 h-3.5 text-red-500" />
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-gray-900 truncate flex-1">
            {displayName}
          </p>

          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Actions: hover on desktop; always visible for active session */}
            {(showActions || isActive) ? (
              <>
                <button
                  onClick={handleStartEdit}
                  className="p-1 hover:bg-gray-200 rounded transition-colors"
                  title="Rename session"
                >
                  <Edit2 className="w-3 h-3 text-gray-400" />
                </button>
                <button
                  onClick={handleDelete}
                  className="p-1 hover:bg-gray-200 rounded transition-colors"
                  title="Delete session"
                >
                  <Trash2 className="w-3 h-3 text-gray-400" />
                </button>
              </>
            ) : (
              <span className="text-[11px] text-gray-400">
                {getRelativeTime(session.lastActivity || session.createdAt || new Date())}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
