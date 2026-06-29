import React, { useState, useRef, useEffect } from 'react';
import { Trash2, Edit2, Check, X, Archive, ArchiveRestore, Download, FileText, FileJson, Code, Loader2, Pin, PinOff, GripVertical } from 'lucide-react';
import type { Session } from '../../store/sessionStore';
import { useSessionStore } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useTransferStore } from '../../store/transferStore';
import { deleteSession } from '../../lib/api';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { WorkerStatusIndicator } from './WorkerStatusIndicator';
import { SessionNotifyToggle } from './SessionNotifyToggle';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  isArchived?: boolean;
  isDropTarget?: boolean;
  onDrop?: (sourceSessionId: string) => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
}

export const SessionItem = React.memo(function SessionItem({ session, isActive, isArchived, isDropTarget, onDrop }: SessionItemProps) {
  const { switchSession, pinSession, unpinSession } = useWebSocket();
  const archiveSession = useSessionStore(state => state.archiveSession);
  const unarchiveSession = useSessionStore(state => state.unarchiveSession);
  const isSessionPinned = useSessionStore(state => state.isSessionPinned);
  const getSessionDisplayName = useSessionStore(state => state.getSessionDisplayName);
  const setSessionDisplayName = useSessionStore(state => state.setSessionDisplayName);
  const removeSessionDisplayName = useSessionStore(state => state.removeSessionDisplayName);
  const setSwitchingSession = useSessionStore(state => state.setSwitchingSession);
  const sessionData = useSessionStore(state => state.sessionData[session.id]);
  const workerStatus = useSessionStore(state => state.workerStatus[session.id]);
  const isSwitchingSession = useSessionStore(state => state.isSwitchingSession);
  const switchingToSessionId = useSessionStore(state => state.switchingToSessionId);
  const sessions = useSessionStore(state => state.sessions);
  const setSessions = useSessionStore(state => state.setSessions);
  const transferDragging = useTransferStore(state => state.isDragging);
  const transferSource = useTransferStore(state => state.source);
  const hoverTargetId = useTransferStore(state => state.hoverTargetId);
  const setHoverTarget = useTransferStore(state => state.setHoverTarget);
  const startDrag = useTransferStore(state => state.startDrag);
  const endDrag = useTransferStore(state => state.endDrag);
  const openConfirmExisting = useTransferStore(state => state.openConfirmExisting);
  
  const [showActions, setShowActions] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0 });
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  
  const itemRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  
  // Use web UI display name if set, otherwise fall back to session name or first message
  const webUIDisplayName = getSessionDisplayName(session.path);
  const [editName, setEditName] = useState(webUIDisplayName || session.name || '');

  const isSelfDrop = transferSource?.sessionId === session.id;
  const isValidDropTarget = isDropTarget && transferDragging && !isSelfDrop && !isArchived;
  const isHighlighted = isDragOver && isValidDropTarget;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isEditing || contextMenu.visible) return;
    if (e.button !== 0) return;
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    isDraggingRef.current = false;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragStartPos.current) return;
    const dx = e.clientX - dragStartPos.current.x;
    const dy = e.clientY - dragStartPos.current.y;
    if (!isDraggingRef.current && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      isDraggingRef.current = true;
      startDrag({
        sessionId: session.id,
        displayName: webUIDisplayName || session.name || session.firstMessage || 'Session',
        sdkType: session.sdkType || 'pi',
        cwd: session.cwd,
      });
    }
  };

  const handleMouseUp = () => {
    dragStartPos.current = null;
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
    }
  };

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        endDrag();
      }
      dragStartPos.current = null;
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [endDrag]);

  const handleDragOver = (e: React.DragEvent) => {
    if (!isValidDropTarget) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (hoverTargetId !== session.id) {
      setHoverTarget(session.id);
    }
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
    if (hoverTargetId === session.id) {
      setHoverTarget(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    setHoverTarget(null);
    if (!isValidDropTarget) return;
    const sourceId = e.dataTransfer.getData('application/session-id');
    if (!sourceId || sourceId === session.id) return;
    if (onDrop) {
      onDrop(sourceId);
    } else {
      const sourceSession = useSessionStore.getState().sessions.find(s => s.id === sourceId);
      if (sourceSession) {
        const sourceDisplayName = useSessionStore.getState().getSessionDisplayName(sourceSession.path) || sourceSession.name || 'Session';
        openConfirmExisting(
          {
            sessionId: sourceSession.id,
            displayName: sourceDisplayName,
            sdkType: sourceSession.sdkType || 'pi',
            cwd: sourceSession.cwd,
          },
          {
            sessionId: session.id,
            displayName: webUIDisplayName || session.name || 'Session',
            sdkType: session.sdkType || 'pi',
            cwd: session.cwd,
          },
        );
      }
    }
    endDrag();
  };

  // Check if session has active status (streaming or busy)
  const sessionStatus = sessionData?.status;
  const isActiveSession = sessionStatus === 'streaming' || sessionStatus === 'busy';
  
  // Check if this session is currently being switched to
  const isLoading = isSwitchingSession && switchingToSessionId === session.id;

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu({ visible: false, x: 0, y: 0 });
      }
    };

    if (contextMenu.visible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [contextMenu.visible]);

  const handleClick = () => {
    if (!isActive && !isEditing && !isLoading && !contextMenu.visible) {
      // Set switching state for UI feedback
      setSwitchingSession(true, session.id);
      switchSession(session.path);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Position the context menu near the cursor
    const rect = itemRef.current?.getBoundingClientRect();
    if (rect) {
      // Calculate position relative to viewport
      let x = e.clientX;
      let y = e.clientY;
      
      // Adjust if menu would go off screen
      const menuWidth = 180;
      const menuHeight = 200;
      
      if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 10;
      }
      if (y + menuHeight > window.innerHeight) {
        y = window.innerHeight - menuHeight - 10;
      }
      
      setContextMenu({ visible: true, x, y });
    }
  };

  const handleCloseContextMenu = () => {
    setContextMenu({ visible: false, x: 0, y: 0 });
  };

  const handleDelete = async () => {
    handleCloseContextMenu();
    if (confirm('Delete this session? This cannot be undone.')) {
      try {
        setIsDeleting(true);
        await deleteSession(session.id);
        // Remove session from the list
        const updatedSessions = sessions.filter(s => s.id !== session.id);
        setSessions(updatedSessions);
        // Clean up display name if exists
        removeSessionDisplayName(session.path);
      } catch (error) {
        console.error('Failed to delete session:', error);
        alert('Failed to delete session. Please try again.');
      } finally {
        setIsDeleting(false);
      }
    }
  };

  const handleArchive = () => {
    handleCloseContextMenu();
    if (isArchived) {
      unarchiveSession(session.path);
    } else {
      archiveSession(session.path);
    }
  };

  const handleTogglePin = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (isSessionPinned(session.path)) {
      unpinSession(session.path);
    } else {
      pinSession(session.path);
    }
  };

  const handleStartEdit = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    handleCloseContextMenu();
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
      setContextMenu({ visible: false, x: 0, y: 0 });
    }
  };

  const handleExport = async (format: 'markdown' | 'json' | 'html') => {
    handleCloseContextMenu();
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
    <>
      <div
        ref={itemRef}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={() => setShowActions(false)}
        onContextMenu={handleContextMenu}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/session-id', session.id);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        role="listitem"
        tabIndex={0}
        className={`
          group relative py-2 px-3 rounded-md cursor-pointer transition-all duration-150 outline-none select-none
          ${isActive
            ? 'bg-blue-50 border-l-2 border-blue-500'
            : 'hover:bg-gray-100 border-l-2 border-transparent'
          }
          ${isDeleting ? 'opacity-50 pointer-events-none' : ''}
          ${isHighlighted ? 'ring-2 ring-blue-400 bg-blue-50' : ''}
          ${transferDragging && !isValidDropTarget && transferSource?.sessionId !== session.id ? 'opacity-60' : ''}
          ${transferDragging && transferSource?.sessionId === session.id ? 'opacity-40 ring-2 ring-blue-300 bg-blue-50' : ''}
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
            <GripVertical className="w-3 h-3 text-gray-300 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab" />
            <p className="text-sm text-gray-900 truncate flex-1">
              {displayName}
            </p>
            {session.sdkType === 'claude' && (
              <span 
                className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20 cursor-help"
                title="Claude Direct - uses Claude Code CLI with subscription quota"
              >
                CC
              </span>
            )}
            {session.sdkType === 'opencode' && (
              <span
                className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-600 border border-emerald-500/20 cursor-help"
                title="OpenCode Direct - uses OpenCode runtime with Z.AI GLM"
              >
                OC
              </span>
            )}
            {session.sdkType === 'antigravity' && (
              <span
                className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/15 text-violet-600 border border-violet-500/20 cursor-help"
                title="Antigravity - uses Google Gemini via agy CLI"
              >
                AG
              </span>
            )}

            <div className="flex items-center gap-1 flex-shrink-0">
              {/* Pin indicator - always visible when pinned */}
              {isSessionPinned(session.path) && !((showActions || isActive) && !contextMenu.visible) && (
                <Pin className="w-3 h-3 text-amber-500 fill-amber-500" />
              )}
              {/* Actions: hover on desktop; always visible for active session */}
              {(showActions || isActive) && !contextMenu.visible ? (
                <>
                  <button
                    onClick={handleTogglePin}
                    className="p-1 hover:bg-gray-200 rounded transition-colors"
                    title={isSessionPinned(session.path) ? 'Unpin session (allow idle cleanup)' : 'Pin session (protect from cleanup)'}
                  >
                    {isSessionPinned(session.path) ? (
                      <Pin className="w-3 h-3 text-amber-500 fill-amber-500" />
                    ) : (
                      <Pin className="w-3 h-3 text-gray-400" />
                    )}
                  </button>
                  <SessionNotifyToggle
                    sessionId={session.id}
                    sdkType={session.sdkType || 'pi'}
                    sessionPath={session.path}
                  />
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
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete();
                    }}
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

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-[160px]"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-xs font-medium text-gray-400 border-b border-gray-100 mb-1">
            {displayName.length > 25 ? displayName.slice(0, 25) + '...' : displayName}
          </div>
          
          {!isArchived && (
            <button
              onClick={() => handleStartEdit()}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
            >
              <Edit2 className="w-3.5 h-3.5" />
              Rename
            </button>
          )}
          
          <div className="relative group/export">
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
            >
              <Download className="w-3.5 h-3.5" />
              Export
              <span className="ml-auto text-gray-400">›</span>
            </button>
            <div className="hidden group-hover/export:block absolute left-full top-0 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[120px] ml-0.5">
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
          </div>
          
          <div className="border-t border-gray-100 my-1" />
          
          <button
            onClick={handleTogglePin}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            {isSessionPinned(session.path) ? (
              <>
                <PinOff className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-amber-600">Unpin session</span>
              </>
            ) : (
              <>
                <Pin className="w-3.5 h-3.5" />
                <span>Pin session</span>
              </>
            )}
          </button>
          
          <button
            onClick={handleArchive}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            {isArchived ? (
              <>
                <ArchiveRestore className="w-3.5 h-3.5 text-blue-500" />
                <span className="text-blue-600">Restore</span>
              </>
            ) : (
              <>
                <Archive className="w-3.5 h-3.5" />
                Archive
              </>
            )}
          </button>
          
          <button
            onClick={handleDelete}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            disabled={isDeleting}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      )}
    </>
  );
});
