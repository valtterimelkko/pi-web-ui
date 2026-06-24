import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useSessionStore, useDraftStore } from '../../store';
import { useNavigationStore } from '../../store/navigationStore';
import { useUIStore } from '../../store/uiStore';
import { VirtualizedMessageList, type VirtualizedMessageListHandle } from './VirtualizedMessageList';
import { MessageInput } from './MessageInput';

import { TreeView, type TreeEntry } from '../Tree';
import { NewSessionModal } from '../Session';
import { ArrowDown } from 'lucide-react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useDictation } from '../../hooks/useDictation';
import { SessionInfoModal } from '../StatusBar/SessionInfoModal';
import { messagesToLiveMessages } from '../../lib/messageAdapter';
import { deriveGoalTag } from '../../lib/piExtensionControls';

interface ChatViewProps {
  onOpenSettings?: () => void;
}

export function ChatView({ onOpenSettings }: ChatViewProps) {
  const messages = useSessionStore((state) => state.messages);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isLoading = useSessionStore((state) => state.isLoading);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSessionSdkType = useSessionStore((state) => state.currentSessionSdkType);
  const extensionWidgets = useSessionStore((state) => state.extensionWidgets);
  const goalEngineStatus = useSessionStore((state) => state.extensionStatuses['goal-engine']);
  const getWorkerStatus = useSessionStore((state) => state.getWorkerStatus);
  const bottomNavCollapsed = useNavigationStore((state) => state.bottomNavCollapsed);
  const sessionInfoOpen = useUIStore((state) => state.sessionInfoOpen);
  const treeViewOpen = useUIStore((state) => state.treeViewOpen);
  const closeSessionInfo = useUIStore((state) => state.closeSessionInfo);
  const closeTreeView = useUIStore((state) => state.closeTreeView);
  const openDriveMode = useUIStore((state) => state.openDriveMode);
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const listRef = useRef<VirtualizedMessageListHandle>(null);
  const { createNewSession, goalControl } = useWebSocket();
  const setDraft = useDraftStore((s) => s.setDraft);
  const [confirmClearGoal, setConfirmClearGoal] = useState(false);

  const handleDictationTranscript = useCallback((text: string) => {
    if (currentSessionId) {
      const existing = useDraftStore.getState().getDraft(currentSessionId);
      const separator = existing ? '\n' : '';
      setDraft(currentSessionId, existing + separator + text);
    }
  }, [currentSessionId, setDraft]);

  const dictation = useDictation(handleDictationTranscript);

  // Get worker status for current session
  const workerStatus = currentSessionId ? getWorkerStatus(currentSessionId) : undefined;

  // Live goal indicator (OpenCode/Pi goal engine). Pulses "running…" during the
  // long silent model-thinking gaps so an active goal never looks frozen.
  const goalTag = deriveGoalTag(goalEngineStatus, isStreaming);

  // Goal controls (pause / resume / clear) are driven server-side and are
  // OpenCode-only; Pi handles its own goal slash commands.
  const goalControlsEnabled = goalTag.active && currentSessionSdkType === 'opencode';

  // Reset the clear-confirmation when the goal is no longer active.
  useEffect(() => {
    if (!goalTag.active) setConfirmClearGoal(false);
  }, [goalTag.active]);

  // Memoize message conversion to avoid creating new arrays on every render
  // Only recomputes when the messages array reference changes
  const liveMessages = useMemo(() => messagesToLiveMessages(messages), [messages]);

  // Convert messages to tree entries
  const treeEntries: TreeEntry[] = messages.map((msg, index) => ({
    id: msg.id,
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : '',
    timestamp: msg.timestamp,
    parentId: index > 0 ? messages[index - 1].id : undefined,
    children: index < messages.length - 1 ? [messages[index + 1].id] : [],
  }));

  // Handle scroll position changes. Auto-scroll during streaming is owned
  // entirely by VirtualizedMessageList's followOutput; here we only drive the
  // manual "scroll to bottom" affordance.
  const handleAtBottomChange = (atBottom: boolean) => {
    setShowScrollButton(!atBottom && messages.length > 0);
  };

  // Scroll to bottom button handler
  const handleScrollToBottom = () => {
    listRef.current?.scrollToBottom();
  };

  const handleCreateSession = (cwd?: string, sdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity', model?: string, thinkingLevel?: string) => {
    createNewSession(cwd, sdkType, model, thinkingLevel);
  };

  return (
    <div className="flex flex-col h-full bg-white" data-testid="chat-interface">
      {/* Main content area */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {/* Message List - Virtualized for performance */}
        <VirtualizedMessageList
          ref={listRef}
          messages={liveMessages}
          isStreaming={isStreaming}
          sessionId={currentSessionId ?? undefined}
          onAtBottomChange={handleAtBottomChange}
          hasSession={!!currentSessionId}
          onCreateSession={() => setShowNewSessionModal(true)}
          workerStatus={workerStatus}
        />

        {/* Scroll to bottom button */}
        {showScrollButton && (
          <button
            onClick={handleScrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 p-2 bg-white border border-gray-200 rounded-full shadow-md hover:bg-gray-50 transition-colors z-10"
            title="Scroll to bottom"
          >
            <ArrowDown className="w-4 h-4 text-gray-600" />
          </button>
        )}

        {/* Message Input */}
        <div className={`bg-white pb-safe flex-shrink-0 transition-all duration-200 ${!bottomNavCollapsed ? 'pb-[70px]' : ''}`}>
          <div className="max-w-4xl mx-auto px-4 pb-4 pt-2">
            {goalTag.active && (
              <div className="mb-2 flex items-center" data-testid="goal-tag">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                    goalTag.paused
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  }`}
                  title={goalEngineStatus}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      goalTag.paused ? 'bg-amber-500' : 'bg-emerald-500'
                    } ${goalTag.pulsing ? 'animate-pulse' : ''}`}
                    data-testid={goalTag.pulsing ? 'goal-tag-pulse' : undefined}
                  />
                  <span>
                    🎯 Goal {goalTag.label}
                    {goalTag.run !== null ? ` · Run ${goalTag.run}` : ''}
                  </span>
                </span>
                {goalControlsEnabled && currentSessionId && (
                  <span className="ml-2 inline-flex items-center gap-1" data-testid="goal-controls">
                    {goalTag.paused ? (
                      <button
                        type="button"
                        onClick={() => goalControl(currentSessionId, 'resume')}
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                        title="Resume goal"
                        data-testid="goal-resume"
                      >
                        ▶ Resume
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => goalControl(currentSessionId, 'pause')}
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
                        title="Pause goal (stops the current run and halts auto-continuation)"
                        data-testid="goal-pause"
                      >
                        ⏸ Pause
                      </button>
                    )}
                    {confirmClearGoal ? (
                      <button
                        type="button"
                        onClick={() => { goalControl(currentSessionId, 'clear'); setConfirmClearGoal(false); }}
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-white bg-red-500 hover:bg-red-600"
                        title="Confirm: clear this goal"
                        data-testid="goal-clear-confirm"
                      >
                        Clear?
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmClearGoal(true)}
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-gray-500 hover:bg-gray-100"
                        title="Clear goal (removes it entirely)"
                        data-testid="goal-clear"
                      >
                        ✕ Clear
                      </button>
                    )}
                  </span>
                )}
              </div>
            )}
            {Object.entries(extensionWidgets).length > 0 && (
              <div className="mb-2 space-y-2" data-testid="extension-widgets">
                {Object.entries(extensionWidgets).map(([key, lines]) => (
                  <div key={key} className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-950 shadow-sm" data-testid={`extension-widget-${key}`}>
                    {lines.map((line, index) => (
                      <div key={index} className={line.trim() === '' ? 'h-2' : 'whitespace-pre-wrap'}>{line}</div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <MessageInput
              disabled={!currentSessionId || isLoading}
              onOpenSettings={onOpenSettings}
              dictationState={dictation.state}
              onDictationToggle={dictation.toggle}
              dictationErrorMessage={dictation.errorMessage}
            />
          </div>
        </div>
      </main>

      {/* Tree View Modal */}
      {treeViewOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="w-full max-w-2xl mx-4">
            <TreeView
              entries={treeEntries}
              onClose={closeTreeView}
              onNavigate={(id) => {
                console.log('Navigate to:', id);
              }}
              onFork={(id) => {
                console.log('Fork at:', id);
              }}
            />
          </div>
        </div>
      )}

      {/* New Session Modal */}
      <NewSessionModal
        isOpen={showNewSessionModal}
        onClose={() => setShowNewSessionModal(false)}
        onCreateSession={handleCreateSession}
        onOpenDriveMode={() => {
          setShowNewSessionModal(false);
          openDriveMode();
        }}
      />

      {/* Session Info Modal */}
      <SessionInfoModal
        isOpen={sessionInfoOpen}
        onClose={closeSessionInfo}
      />
    </div>
  );
}
