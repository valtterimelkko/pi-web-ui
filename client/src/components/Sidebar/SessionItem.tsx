import { useState } from 'react';
import { MessageSquare, Trash2, MoreVertical, Terminal } from 'lucide-react';
import type { Session } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
}

export function SessionItem({ session, isActive }: SessionItemProps) {
  const { switchSession } = useWebSocket();
  const [showActions, setShowActions] = useState(false);

  const handleClick = () => {
    if (!isActive) {
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

  // Format relative time
  const getRelativeTime = (date: Date | string) => {
    const now = new Date();
    const then = new Date(date);
    const diffMs = now.getTime() - then.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return then.toLocaleDateString();
  };

  return (
    <div
      onClick={handleClick}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      className={`
        group relative p-3 rounded-lg cursor-pointer transition-all duration-200
        hover:translate-x-1
        ${isActive 
          ? 'bg-violet-600/20 border border-violet-600/50' 
          : 'hover:bg-slate-800 border border-transparent'
        }
      `}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`
          flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center
          ${isActive ? 'bg-violet-600' : 'bg-slate-800'}
        `}>
          {session.path.includes('cli') ? (
            <Terminal className="w-4 h-4 text-slate-300" />
          ) : (
            <MessageSquare className="w-4 h-4 text-slate-300" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-200 truncate">
            {session.firstMessage || 'New session'}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-slate-500">
              {session.messageCount} messages
            </span>
            <span className="text-xs text-slate-600">•</span>
            <span className="text-xs text-slate-500">
              {getRelativeTime(session.lastActivity || session.createdAt || new Date())}
            </span>
          </div>
          {session.cwd && (
            <p className="text-xs text-slate-600 truncate mt-1" title={session.cwd}>
              {session.cwd}
            </p>
          )}
        </div>

        {/* Actions */}
        {showActions && (
          <div className="flex items-center gap-1">
            <button
              onClick={handleDelete}
              className="p-1.5 hover:bg-red-600/20 rounded transition-colors"
              title="Delete session"
            >
              <Trash2 className="w-4 h-4 text-slate-400 hover:text-red-400" />
            </button>
          </div>
        )}
      </div>

      {/* Active indicator */}
      {isActive && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-violet-500 rounded-r" />
      )}
    </div>
  );
}
