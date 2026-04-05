import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useUIStore } from './uiStore';
import { getPreferences, patchPreferences } from '../lib/api';
import type { ContentPart } from '../hooks/useSessionStream.js';

// Message ID tracking and per-session message caching moved to useSessionStream hook.
// This store handles ONLY session metadata, worker status, and UI state.

export interface Session {
  id: string;
  path: string;
  firstMessage: string;
  messageCount: number;
  cwd: string;
  name?: string;
  sdkType?: 'pi' | 'claude';  // optional for backward compatibility
  model?: string;              // current model
  createdAt?: string;
  lastActivity?: string;
}

/**
 * Message type retained for backward-compatible type exports only.
 * Message state is managed by useSessionStream, not this store.
 */
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  timestamp: number;
  toolCall?: {
    id: string;
    name: string;
    args: unknown;
  };
  toolResult?: {
    output: string;
    isError: boolean;
  };
  isComplete?: boolean;
}

/**
 * Per-session metadata (NO messages — those live in useSessionStream)
 */
export interface SessionData {
  status: 'idle' | 'busy' | 'streaming' | 'error';
  lastEventTimestamp: number;
  contextPercent: number;
  currentStep: number;
  model: string | null;
  quotaInfo?: {  // Claude rate-limit / quota info
    status: string;
    rateLimitType: string;
    isUsingOverage: boolean;
    resetsAt?: number;
  } | null;
}

interface ExtensionUIRequest {
  id: string;
  type: 'confirm' | 'select' | 'input' | 'editor';
  method: string;
  params: Record<string, unknown>;
  timeout: number;
}

export interface SessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  cwd?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  model?: string;
  contextWindow?: number;
  contextUsed?: number;
  contextPercent?: number;
}

export type WorkerStatus = 'spawning' | 'ready' | 'streaming' | 'idle' | 'error' | 'disconnected' | 'terminated';

interface SessionState {
  // Session list metadata
  sessions: Session[];
  currentSessionId: string | null;
  currentSessionSdkType: 'pi' | 'claude' | null;
  currentModel: string | null;

  // UI state
  isStreaming: boolean;
  isLoading: boolean;
  isSwitchingSession: boolean;
  switchingToSessionId: string | null;
  error: string | null;

  // Extension UI
  extensionUIRequest: ExtensionUIRequest | null;
  sessionInfo: SessionStats | null;

  // Context usage tracking
  contextPercent: number;
  contextUsed: number;
  contextWindow: number;

  // Archive state (persisted)
  archivedSessionPaths: string[];

  // Session loading flag
  isLoadingSessions: boolean;

  // Auto-compaction state
  isCompacting: boolean;
  compactionReason: string | null;

  // Per-session lightweight metadata (NO messages)
  sessionData: Record<string, SessionData>;

  // Worker status tracking
  workerStatus: Record<string, WorkerStatus>;
  activeWorkers: string[];

  // Claude Direct availability
  claudeAvailable: boolean;
  claudeAuthError: string | null;

  // Web UI display names (persisted)
  sessionDisplayNames: Record<string, string>;

  // ─── Actions ───────────────────────────────────────────

  // Session list
  setSessions: (sessions: Session[]) => void;
  setCurrentSession: (sessionId: string | null) => void;
  switchSession: (newSessionId: string) => void;
  setCurrentModel: (modelId: string) => void;

  // UI state
  setStreaming: (isStreaming: boolean) => void;
  setLoading: (isLoading: boolean) => void;
  setSwitchingSession: (isSwitching: boolean, sessionId?: string | null) => void;
  setError: (error: string | null) => void;
  setExtensionUIRequest: (request: ExtensionUIRequest | null) => void;
  setSessionInfo: (info: SessionStats | null) => void;

  // Archive / display names
  archiveSession: (sessionPath: string) => void;
  unarchiveSession: (sessionPath: string) => void;
  isSessionArchived: (sessionPath: string) => boolean;
  setSessionDisplayName: (sessionPath: string, displayName: string) => void;
  getSessionDisplayName: (sessionPath: string) => string | undefined;
  removeSessionDisplayName: (sessionPath: string) => void;

  // Preferences sync
  initPreferences: () => Promise<void>;

  // Session data actions
  updateSessionData: (sessionId: string, updates: Partial<SessionData>) => void;
  setSessionStatus: (sessionId: string, status: SessionData['status']) => void;
  cleanupStaleSessionData: (maxSessions?: number) => void;

  // Worker status tracking
  updateWorkerStatus: (sessionId: string, status: WorkerStatus) => void;
  getWorkerStatus: (sessionId: string) => WorkerStatus | undefined;
  removeWorkerStatus: (sessionId: string) => void;

  // Claude Direct availability
  setClaudeAvailable: (available: boolean, error?: string | null) => void;

  // WebSocket event handler
  handleServerMessage: (message: unknown) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      currentSessionSdkType: null,
      currentModel: null,
      isStreaming: false,
      isLoading: false,
      isSwitchingSession: false,
      switchingToSessionId: null,
      error: null,
      extensionUIRequest: null,
      sessionInfo: null,
      contextPercent: 0,
      contextUsed: 0,
      contextWindow: 0,
      archivedSessionPaths: [],
      sessionDisplayNames: {},
      isLoadingSessions: false,
      isCompacting: false,
      compactionReason: null,
      sessionData: {},
      workerStatus: {},
      activeWorkers: [],
      claudeAvailable: false,
      claudeAuthError: null,

      // ─── Worker status tracking ───────────────────────────

      updateWorkerStatus: (sessionId: string, status: WorkerStatus) => {
        set((state) => {
          const newWorkerStatus = { ...state.workerStatus, [sessionId]: status };
          const newActiveWorkers = Object.entries(newWorkerStatus)
            .filter(([_, s]) => s !== 'terminated' && s !== 'error')
            .map(([id]) => id);
          return {
            workerStatus: newWorkerStatus,
            activeWorkers: newActiveWorkers,
          };
        });
      },

      getWorkerStatus: (sessionId: string) => {
        return get().workerStatus[sessionId];
      },

      removeWorkerStatus: (sessionId: string) => {
        set((state) => {
          const newWorkerStatus = { ...state.workerStatus };
          delete newWorkerStatus[sessionId];
          const newActiveWorkers = Object.entries(newWorkerStatus)
            .filter(([_, s]) => s !== 'terminated' && s !== 'error')
            .map(([id]) => id);
          return {
            workerStatus: newWorkerStatus,
            activeWorkers: newActiveWorkers,
          };
        });
      },

      setClaudeAvailable: (available, error = null) => set({ claudeAvailable: available, claudeAuthError: error }),

      setExtensionUIRequest: (request) => set({ extensionUIRequest: request }),
      setSessionInfo: (info) => set({ sessionInfo: info }),
      setCurrentModel: (modelId) => set({ currentModel: modelId }),

      // ─── Session switching ────────────────────────────────
      // Messages are managed by useSessionStream, not the store.
      // Message loading happens via useSessionStream + server history replay.

      switchSession: (newSessionId: string) => {
        set((state) => ({
          currentSessionId: newSessionId,
          currentSessionSdkType: state.sessions.find((s) => s.id === newSessionId)?.sdkType ?? null,
          isStreaming: false,
        }));
      },

      setCurrentSession: (sessionId) => {
        set((s) => ({
          currentSessionId: sessionId,
          currentSessionSdkType: s.sessions.find((session) => session.id === sessionId)?.sdkType ?? null,
        }));
      },

      // ─── Session data (metadata only) ─────────────────────

      updateSessionData: (sessionId, updates) => {
        set((state) => {
          const existingData = state.sessionData[sessionId] || {
            status: 'idle' as const,
            lastEventTimestamp: 0,
            contextPercent: 0,
            currentStep: 0,
            model: null,
          };
          return {
            sessionData: {
              ...state.sessionData,
              [sessionId]: {
                ...existingData,
                ...updates,
                lastEventTimestamp: Date.now(),
              },
            },
          };
        });
      },

      setSessionStatus: (sessionId, status) => {
        set((state) => {
          const existingData = state.sessionData[sessionId] || {
            status: 'idle' as const,
            lastEventTimestamp: 0,
            contextPercent: 0,
            currentStep: 0,
            model: null,
          };
          return {
            sessionData: {
              ...state.sessionData,
              [sessionId]: {
                ...existingData,
                status,
                lastEventTimestamp: Date.now(),
              },
            },
          };
        });
      },

      cleanupStaleSessionData: (maxSessions = 50) => {
        const state = get();
        const sessionIds = Object.keys(state.sessionData);
        
        if (sessionIds.length <= maxSessions) return;
        
        // Sort by lastEventTimestamp (most recent first)
        const sorted = sessionIds.sort((a, b) => 
          (state.sessionData[b]?.lastEventTimestamp || 0) - 
          (state.sessionData[a]?.lastEventTimestamp || 0)
        );
        
        // Keep current session and most recent sessions
        const currentSessionId = state.currentSessionId;
        const toRemove = sorted.filter(id => id !== currentSessionId).slice(maxSessions - 1);
        
        if (toRemove.length > 0) {
          set((s) => {
            const newSessionData = { ...s.sessionData };
            toRemove.forEach(id => {
              delete newSessionData[id];
            });
            return { sessionData: newSessionData };
          });
        }
      },

      // ─── Archive / display names ──────────────────────────

      archiveSession: (sessionPath) => {
        set((state) => ({
          archivedSessionPaths: state.archivedSessionPaths.includes(sessionPath)
            ? state.archivedSessionPaths
            : [...state.archivedSessionPaths, sessionPath],
        }));
        patchPreferences({ archivedSessionPaths: get().archivedSessionPaths }).catch((e) => {
          console.warn('Failed to sync archive state to server:', e);
        });
      },

      unarchiveSession: (sessionPath) => {
        set((state) => ({
          archivedSessionPaths: state.archivedSessionPaths.filter(p => p !== sessionPath),
        }));
        patchPreferences({ archivedSessionPaths: get().archivedSessionPaths }).catch((e) => {
          console.warn('Failed to sync archive state to server:', e);
        });
      },

      isSessionArchived: (sessionPath) => {
        return get().archivedSessionPaths.includes(sessionPath);
      },

      setSessionDisplayName: (sessionPath, displayName) => {
        set((state) => ({
          sessionDisplayNames: {
            ...state.sessionDisplayNames,
            [sessionPath]: displayName,
          },
        }));
        patchPreferences({ sessionDisplayNames: get().sessionDisplayNames }).catch((e) => {
          console.warn('Failed to sync display name to server:', e);
        });
      },

      getSessionDisplayName: (sessionPath) => {
        return get().sessionDisplayNames[sessionPath];
      },

      removeSessionDisplayName: (sessionPath) => {
        set((state) => {
          const newDisplayNames = { ...state.sessionDisplayNames };
          delete newDisplayNames[sessionPath];
          return { sessionDisplayNames: newDisplayNames };
        });
        patchPreferences({ sessionDisplayNames: get().sessionDisplayNames }).catch((e) => {
          console.warn('Failed to sync display name removal to server:', e);
        });
      },

      initPreferences: async () => {
        try {
          const serverPrefs = await getPreferences();
          if (serverPrefs.archivedSessionPaths !== undefined) {
            set({ archivedSessionPaths: serverPrefs.archivedSessionPaths });
          }
          if (serverPrefs.sessionDisplayNames !== undefined) {
            const currentDisplayNames = get().sessionDisplayNames;
            const mergedDisplayNames = {
              ...currentDisplayNames,
              ...serverPrefs.sessionDisplayNames,
            };
            set({ sessionDisplayNames: mergedDisplayNames });
          }
        } catch (e) {
          console.warn('Failed to load preferences from server, using local cache:', e);
        }
      },

      // ─── Session list ─────────────────────────────────────

      setSessions: (sessions) => {
        const seenPaths = new Set<string>();
        const dedupedSessions = sessions.filter((session) => {
          if (seenPaths.has(session.path)) {
            return false;
          }
          seenPaths.add(session.path);
          return true;
        });
        set({ sessions: dedupedSessions, isLoadingSessions: false });
      },

      // ─── Streaming / loading ──────────────────────────────

      setStreaming: (isStreaming) => set({ isStreaming }),
      setLoading: (isLoading) => set({ isLoading }),
      setSwitchingSession: (isSwitching, sessionId = null) => set({ 
        isSwitchingSession: isSwitching, 
        switchingToSessionId: isSwitching ? sessionId : null 
      }),
      setError: (error) => set({ error }),

      // ─── WebSocket event handler ──────────────────────────

      handleServerMessage: (message: unknown) => {
        const msg = message as { type: string; [key: string]: unknown };

        switch (msg.type) {
          case 'sessions_list': {
            const rawSessions = (msg.sessions as Array<Session & { sdkType?: 'pi' | 'claude' }>) || [];
            const seenPaths = new Set<string>();
            const dedupedSessions = rawSessions
              .filter((session) => {
                if (seenPaths.has(session.path)) {
                  console.warn(`[sessionStore] Duplicate session path in sessions_list: ${session.path}`);
                  return false;
                }
                seenPaths.add(session.path);
                return true;
              })
              .map((session) => ({
                ...session,
                sdkType: session.sdkType ?? undefined,
              }));
            set({ sessions: dedupedSessions, isLoadingSessions: false });
            break;
          }

          case 'session_created': {
            const createdMsg = msg as unknown as { sessionId: string; sessionPath: string; sdkType?: 'pi' | 'claude' };
            set({ 
              currentSessionId: createdMsg.sessionId,
              currentSessionSdkType: createdMsg.sdkType ?? null,
              contextPercent: 0,
              contextUsed: 0,
              contextWindow: 0,
              sessionInfo: null,
              isLoading: false,
              isSwitchingSession: false,
              switchingToSessionId: null,
            });
            // Add or update the session entry so UI can reflect sdkType
            set((state) => {
              const existingSession = state.sessions.find((s) => s.id === createdMsg.sessionId);
              const updatedSessions = existingSession
                ? state.sessions.map((s) =>
                    s.id === createdMsg.sessionId
                      ? { ...s, path: createdMsg.sessionPath, sdkType: createdMsg.sdkType ?? s.sdkType }
                      : s
                  )
                : [
                    {
                      id: createdMsg.sessionId,
                      path: createdMsg.sessionPath,
                      firstMessage: 'New session',
                      messageCount: 0,
                      cwd: '',
                      sdkType: createdMsg.sdkType ?? undefined,
                    },
                    ...state.sessions,
                  ];
              return { sessions: updatedSessions };
            });
            break;
          }

          case 'session_switched': {
            const switchMsg = msg as unknown as {
              sessionId: string;
              sdkType?: 'pi' | 'claude';
              model?: string;
              contextWindow?: number;
              contextUsed?: number;
              contextPercent?: number;
              isStreaming?: boolean;
            };
            
            set((state) => {
              // Update sdkType on the switched-to session if server provides it
              const updatedSessions = switchMsg.sdkType
                ? state.sessions.map((s) =>
                    s.id === switchMsg.sessionId
                      ? { ...s, sdkType: switchMsg.sdkType }
                      : s
                  )
                : state.sessions;

              return {
                currentSessionId: switchMsg.sessionId,
                currentSessionSdkType: switchMsg.sdkType ?? state.sessions.find((s) => s.id === switchMsg.sessionId)?.sdkType ?? null,
                currentModel: switchMsg.model ?? null,
                contextPercent: switchMsg.contextPercent ?? 0,
                contextUsed: switchMsg.contextUsed ?? 0,
                contextWindow: switchMsg.contextWindow ?? 0,
                sessions: updatedSessions,
                isStreaming: switchMsg.isStreaming || false,
                isSwitchingSession: false,
                switchingToSessionId: null,
              };
            });
            break;
          }

          case 'agent_start':
            set({ isStreaming: true, isLoading: false });
            break;

          case 'agent_end':
            set({ isStreaming: false });
            break;

          case 'error':
            set({ 
              error: (msg.message as string) || 'Unknown error',
              isStreaming: false,
              isLoading: false,
            });
            break;

          case 'session_update': {
            if (get().isLoadingSessions) {
              break;
            }
            
            const { type, sessionId, info } = msg as {
              type: 'add' | 'change' | 'unlink';
              sessionId: string;
              info?: Session;
            };
            
            if (type === 'unlink') {
              set((state) => ({
                sessions: state.sessions.filter((s) => s.path !== info?.path && s.id !== sessionId),
              }));
            } else if (info) {
              set((state) => {
                const existingByPath = state.sessions.findIndex((s) => s.path === info.path);
                const existingById = state.sessions.findIndex((s) => s.id === info.id);
                const existingIndex = existingByPath >= 0 ? existingByPath : existingById;
                
                if (existingIndex >= 0) {
                  const newSessions = [...state.sessions];
                  newSessions[existingIndex] = info;
                  return { sessions: newSessions };
                } else {
                  return { sessions: [info, ...state.sessions] };
                }
              });
            }
            break;
          }

          case 'extension_ui_request': {
            set({ extensionUIRequest: msg.request as ExtensionUIRequest });
            break;
          }

          case 'notification': {
            const { notification } = msg as unknown as {
              notification: { message: string; type: 'info' | 'warning' | 'error' };
            };
            useUIStore.getState().addToast({
              type: notification.type,
              message: notification.message,
            });
            break;
          }

          case 'model_changed': {
            const modelId = msg.modelId as string;
            const modelName = modelId.split('/').pop()?.replace(/-/g, ' ') || modelId;
            set({ currentModel: modelId });
            useUIStore.getState().addToast({
              type: 'success',
              message: `Model changed to ${modelName}`,
            });
            break;
          }

          case 'session_info': {
            const { stats } = msg as unknown as { stats: SessionStats };
            set({ sessionInfo: stats });
            
            if (stats && stats.tokens.total > 0) {
              import('../lib/api').then(({ recordUsage }) => {
                recordUsage({
                  sessionId: stats.sessionId,
                  sessionPath: stats.sessionFile || '',
                  cwd: stats.cwd || '',
                  model: stats.model || '',
                  tokens: stats.tokens,
                  cost: stats.cost,
                  messageCount: stats.totalMessages,
                });
              }).catch(() => {});
            }
            break;
          }

          case 'compaction_result': {
            const { tokensBefore, contextWindow, contextUsed, contextPercent } = msg as unknown as { 
              summary: string; 
              tokensBefore: number;
              contextWindow?: number;
              contextUsed?: number;
              contextPercent?: number;
            };
            set({ 
              isCompacting: false, 
              compactionReason: null,
              contextWindow: contextWindow ?? get().contextWindow,
              contextUsed: contextUsed ?? get().contextUsed,
              contextPercent: contextPercent ?? get().contextPercent,
            });
            if (get().sessionInfo) {
              set({
                sessionInfo: {
                  ...get().sessionInfo!,
                  contextWindow: contextWindow ?? get().sessionInfo!.contextWindow,
                  contextUsed: contextUsed ?? get().sessionInfo!.contextUsed,
                  contextPercent: contextPercent ?? get().sessionInfo!.contextPercent,
                }
              });
            }
            useUIStore.getState().addToast({
              type: 'success',
              message: `Context compacted successfully! ${tokensBefore} tokens summarized.`,
            });
            break;
          }

          case 'auto_compaction_start': {
            const { reason } = msg as unknown as { reason: string };
            set({ isCompacting: true, compactionReason: reason });
            useUIStore.getState().addToast({
              type: 'info',
              message: `Auto-compacting context: ${reason}`,
            });
            break;
          }

          case 'auto_compaction_end': {
            const { aborted, willRetry, errorMessage } = msg as unknown as {
              result: unknown;
              aborted: boolean;
              willRetry: boolean;
              errorMessage?: string;
            };
            set({ isCompacting: false, compactionReason: null });
            
            if (aborted) {
              if (willRetry) {
                useUIStore.getState().addToast({
                  type: 'info',
                  message: 'Auto-compaction aborted, will retry...',
                });
              } else {
                useUIStore.getState().addToast({
                  type: 'warning',
                  message: 'Auto-compaction aborted.',
                });
              }
            } else if (errorMessage) {
              useUIStore.getState().addToast({
                type: 'error',
                message: `Auto-compaction failed: ${errorMessage}`,
              });
            } else {
              useUIStore.getState().addToast({
                type: 'success',
                message: 'Auto-compaction completed successfully.',
              });
            }
            break;
          }

          case 'session_name_updated':
          case 'session_name_changed': {
            const nameMsg = msg as unknown as { sessionId: string; name: string };
            set((state) => ({
              sessions: state.sessions.map((s) =>
                s.id === nameMsg.sessionId ? { ...s, name: nameMsg.name } : s
              ),
            }));
            break;
          }

          // ─── Multi-session event routing ─────────────────
          case 'session_event': {
            const sessionEvent = msg as unknown as {
              sessionId: string;
              event: { type: string; [key: string]: unknown };
            };
            const { sessionId, event } = sessionEvent;
            
            switch (event.type) {
              case 'agent_start':
                get().setSessionStatus(sessionId, 'streaming');
                if (get().currentSessionId === sessionId) {
                  set({ isStreaming: true, isLoading: false });
                }
                break;
                
              case 'agent_end':
                get().setSessionStatus(sessionId, 'idle');
                if (get().currentSessionId === sessionId) {
                  set({ isStreaming: false });
                }
                break;
                
              // Message/tool events are handled by useSessionStream hook.
              // The following cases were moved to useSessionStream for ref-based
              // streaming without re-renders on every delta:
              //   message_start, message_update, message_end,
              //   tool_execution_start, tool_execution_update, tool_execution_end
              
              case 'auto_compaction_start': {
                const { reason } = event as unknown as { reason: string };
                if (get().currentSessionId === sessionId) {
                  set({ isCompacting: true, compactionReason: reason });
                  useUIStore.getState().addToast({
                    type: 'info',
                    message: `Auto-compacting context: ${reason}`,
                  });
                }
                break;
              }
              
              case 'auto_compaction_end': {
                const { aborted, willRetry, errorMessage } = event as unknown as {
                  result: unknown;
                  aborted: boolean;
                  willRetry: boolean;
                  errorMessage?: string;
                };
                if (get().currentSessionId === sessionId) {
                  set({ isCompacting: false, compactionReason: null });
                  
                  if (aborted) {
                    if (willRetry) {
                      useUIStore.getState().addToast({
                        type: 'info',
                        message: 'Auto-compaction aborted, will retry...',
                      });
                    } else {
                      useUIStore.getState().addToast({
                        type: 'warning',
                        message: 'Auto-compaction aborted.',
                      });
                    }
                  } else if (errorMessage) {
                    useUIStore.getState().addToast({
                      type: 'error',
                      message: `Auto-compaction failed: ${errorMessage}`,
                    });
                  } else {
                    useUIStore.getState().addToast({
                      type: 'success',
                      message: 'Auto-compaction completed successfully.',
                    });
                  }
                }
                break;
              }

              case 'session_init': {
                const initData = event as unknown as { model?: string; tools?: string[] };
                if (initData.model) {
                  set((state) => ({
                    sessions: state.sessions.map((s) =>
                      s.id === sessionId ? { ...s, model: initData.model } : s
                    ),
                  }));
                  get().updateSessionData(sessionId, { model: initData.model });
                  if (get().currentSessionId === sessionId) {
                    set({ currentModel: initData.model });
                  }
                }
                break;
              }

              case 'rate_limit': {
                const rateLimitData = event as unknown as {
                  status: string;
                  rateLimitType: string;
                  isUsingOverage: boolean;
                  resetsAt?: number;
                };
                get().updateSessionData(sessionId, {
                  quotaInfo: {
                    status: rateLimitData.status,
                    rateLimitType: rateLimitData.rateLimitType,
                    isUsingOverage: rateLimitData.isUsingOverage,
                    resetsAt: rateLimitData.resetsAt,
                  },
                });
                if (rateLimitData.isUsingOverage && get().currentSessionId === sessionId) {
                  useUIStore.getState().addToast({
                    type: 'warning',
                    message: 'Claude session is using extra quota (overage)',
                  });
                }
                break;
              }
            }
            break;
          }

          case 'history_start': {
            // History replay start — message management is in useSessionStream
            break;
          }

          case 'history_end': {
            const histEndMsg = msg as unknown as { sessionId: string };
            get().setSessionStatus(histEndMsg.sessionId, 'idle');
            break;
          }

          case 'session_status': {
            const statusMsg = msg as unknown as {
              sessionId: string;
              sessionPath: string;
              status: 'idle' | 'busy' | 'streaming' | 'error';
              lastActivity?: string;
              messageCount?: number;
              currentStep?: number;
            };
            const { sessionId, status, currentStep, messageCount } = statusMsg;
            
            get().setSessionStatus(sessionId, status);
            
            if (currentStep !== undefined || messageCount !== undefined) {
              get().updateSessionData(sessionId, {
                currentStep: currentStep ?? get().sessionData[sessionId]?.currentStep ?? 0,
              });
            }
            
            // Sync global isStreaming if this is the current session
            if (get().currentSessionId === sessionId) {
              const isStreaming = status === 'streaming' || status === 'busy';
              set({ isStreaming });
            }
            break;
          }

          case 'claude_available': {
            const claudeMsg = msg as unknown as { available: boolean; error?: string | null };
            get().setClaudeAvailable(claudeMsg.available, claudeMsg.error || null);
            break;
          }

          case 'worker_status': {
            const workerMsg = msg as unknown as {
              sessionId: string;
              status: WorkerStatus;
              error?: string;
              previousStatus?: WorkerStatus;
              timestamp?: number;
            };
            const { sessionId: workerSessionId, status: workerStatus, error: workerError } = workerMsg;
            
            get().updateWorkerStatus(workerSessionId, workerStatus);
            
            console.log(`[WorkerStatus] Session ${workerSessionId}: ${workerMsg.previousStatus || 'unknown'} -> ${workerStatus}`);
            
            if (workerStatus === 'error' && workerError) {
              console.error(`[sessionStore] Worker error for session ${workerSessionId}:`, workerError);
              if (get().currentSessionId === workerSessionId) {
                useUIStore.getState().addToast({
                  type: 'error',
                  message: `Worker error: ${workerError}`,
                });
                set({ 
                  isStreaming: false,
                  isLoading: false,
                  error: workerError,
                });
              }
            }
            
            if (workerStatus === 'terminated') {
              get().removeWorkerStatus(workerSessionId);
            }
            
            break;
          }
        }
      },
    }),
    {
      name: 'pi-web-ui-session',
      partialize: (state) => ({ 
        sessions: state.sessions,
        archivedSessionPaths: state.archivedSessionPaths,
        sessionDisplayNames: state.sessionDisplayNames,
      }),
    }
  )
);
