import { useState } from 'react';
import { Trash2, Edit2, Check, X, Archive, ArchiveRestore, Download, FileText, FileJson, Code, Loader2 } from 'lucide-react';
import type { Session } from '../../store/sessionStore';
import { useSessionStore } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { WorkerStatusIndicator } from './WorkerStatusIndicator';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  isArchived?: boolean;
}

export function SessionItem({ session, isActive, isArchived }: SessionItemProps) {
  const { switchSession } = useWebSocket();
  const archiveSession = useSessionStore(state => state.archiveSession);
  const unarchiveSession = useSessionStore(state => state.unarchiveSession);
  const getSessionDisplayName = useSessionStore(state => state.getSessionDisplayName);
  const setSessionDisplayName = useSessionStore(state => state.setSessionDisplayName);
  const setSwitchingSession = useSessionStore(state => state.setSwitchingSession);
  const sessionData = useSessionStore(state => state.sessionData[session.id]);
  const workerStatus = useSessionStore(state => state.workerStatus[session.id]);
  const isSwitchingSession = useSessionStore(state => state.isSwitchingSession);
  const switchingToSessionId = useSessionStore(state => state.switchingToSessionId);
  const [showActions, setShowActions] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  // Use web UI display name if set, otherwise fall back to session name or first message
  const webUIDisplayName = getSessionDisplayName(session.path);
  const [editName, setEditName] = useState(webUIDisplayName || session.name || '');

  // Check if session has active status (streaming or busy)
  const sessionStatus = sessionData?.status;
  const isActiveSession = sessionStatus === 'streaming' || sessionStatus === 'busy';
  
  // Check if this session is currently being switched to
  const isLoading = isSwitchingSession && switchingToSessionId === session.id;

  const handleClick = () => {
    if (!isActive && !isEditing && !isLoading) {
      // Set switching state for UI feedback
      setSwitchingSession(true, session.id);
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
    setEditName(webUIDisplayName || session.name || '');
  };

  const handleCancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(false);
    setEditName(webUIDisplayName || session.name || '');
  };

  const handleSaveEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    const trimmedName = editName.trim();
    if (trimmedName) {
      setSessionDisplayName(session.path, trimmedName);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (isEditing) {
        const trimmedName = editName.trim();
        if (trimmedName) {
          setSessionDisplayName(session.path, trimmedName);
        }
        setIsEditing(false);
      } else {
        handleClick();
      }
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditName(webUIDisplayName || session.name || '');
      setShowExportMenu(false);
    }
  };

  const handleExport = async (format: 'markdown' | 'json' | 'html') => {
    try {
      const response = await fetch(`/api/sessions/${session.id}/export?format=${format}`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Export failed');
      
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${session.id.slice(0, 8)}.${format === 'markdown' ? 'md' : format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setShowExportMenu(false);
    } catch (error) {
      console.error('Export failed:', error);
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

  // Filter skill content from session preview (for old sessions created before server fix)
  const isSkillContent = (text: string): boolean => {
    return text.includes('<skill name="') ||
           text.includes('</skill>') ||
           text.includes('SKILL.md');
  };

  // Get display name (web UI custom name > session name > first message)
  // Filter out skill content for clean session previews
  const rawName = webUIDisplayName || session.name || session.firstMessage || 'New session';
  const displayName = isSkillContent(rawName) ? 'New session' : rawName;

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
          ? 'bg-blue-50 border-l-2 border-blue-500'
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
            className="flex-1 px-2 py-1 text-sm bg-white border border-gray-300 rounded text-gray-900 focus:outline-none focus:border-blue-500 text-base"
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
          {session.sdkType === 'claude' && (
            <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
              CC
            </span>
          )}

          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Actions: hover on desktop; always visible for active session */}
            {(showActions || isActive) ? (
              <>
                {!isArchived && (
                  <button
                    onClick={handleStartEdit}
                    className="p-1 hover:bg-gray-200 rounded transition-colors"
                    title="Rename session"
                  >
                    <Edit2 className="w-3 h-3 text-gray-400" />
                  </button>
                )}
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowExportMenu(!showExportMenu);
                    }}
                    className="p-1 hover:bg-gray-200 rounded transition-colors"
                    title="Export session"
                  >
                    <Download className="w-3 h-3 text-gray-400" />
                  </button>
                  {showExportMenu && (
                    <div 
                      className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-[120px]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => handleExport('markdown')}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        Markdown
                      </button>
                      <button
                        onClick={() => handleExport('json')}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                      >
                        <FileJson className="w-3.5 h-3.5" />
                        JSON
                      </button>
                      <button
                        onClick={() => handleExport('html')}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                      >
                        <Code className="w-3.5 h-3.5" />
                        HTML
                      </button>
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isArchived) {
                      unarchiveSession(session.path);
                    } else {
                      archiveSession(session.path);
                    }
                  }}
                  className="p-1 hover:bg-gray-200 rounded transition-colors"
                  title={isArchived ? 'Restore from archive' : 'Archive session'}
                >
                  {isArchived ? (
                    <ArchiveRestore className="w-3 h-3 text-blue-500" />
                  ) : (
                    <Archive className="w-3 h-3 text-gray-400" />
                  )}
                </button>
                <button
                  onClick={handleDelete}
                  className="p-1 hover:bg-gray-200 rounded transition-colors"
                  title="Delete session"
                >
                  <Trash2 className="w-3 h-3 text-gray-400" />
                </button>
              </>
            ) : isLoading ? (
              <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
            ) : workerStatus ? (
              <WorkerStatusIndicator sessionId={session.id} />
            ) : isActiveSession ? (
              <SessionStatusIndicator sessionId={session.id} />
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
