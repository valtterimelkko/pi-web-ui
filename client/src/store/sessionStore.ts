import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useUIStore } from './uiStore';
import { getPreferences, patchPreferences } from '../lib/api';

// Maximum sessions to keep in memory (LRU cache limit)
const MAX_CACHED_SESSIONS = 5;

// Track the current message ID per session for the multi-session event path.
// Raw Pi SDK events forwarded by multi-session-manager don't include message IDs,
// so we track the ID assigned at message_start to match subsequent message_update events.
const currentMessageIdBySession = new Map<string, string>();

/**
 * LRU cache entry for session messages
 */
interface SessionCache {
  messages: Message[];
  lastAccess: number;
}

/**
 * Estimate message size in bytes for cache tracking
 */
function estimateMessageSize(msg: Message): number {
  let size = 100; // Base overhead
  if (typeof msg.content === 'string') {
    size += msg.content.length * 2; // UTF-16 chars
  } else if (Array.isArray(msg.content)) {
    msg.content.forEach(block => {
      size += (block.text?.length || 0) * 2;
      size += (block.thinking?.length || 0) * 2;
    });
  }
  return size;
}

/**
 * Estimate total size of messages array in bytes
 */
function estimateMessagesSize(messages: Message[]): number {
  return messages.reduce((total, msg) => total + estimateMessageSize(msg), 0);
}

export interface Session {
  id: string;
  path: string;
  firstMessage: string;
  messageCount: number;
  cwd: string;
  name?: string;
  createdAt?: string;
  lastActivity?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; thinking?: string }>;
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
}

/**
 * Per-session data for multi-session support
 */
export interface SessionData {
  messages: Message[];
  status: 'idle' | 'busy' | 'streaming' | 'error';
  lastEventTimestamp: number;
  contextPercent: number;
  currentStep: number;
  model: string | null;
}

/**
 * Metadata for session cache to enable intelligent cache invalidation
 */
interface SessionCacheMeta {
  fileTimestamp: number;  // Server file modification time when last read
  lastLocalUpdate: number; // When we last updated from WebSocket events
  isStreaming: boolean;    // Was streaming when we last saw it
  messageCount: number;    // Number of messages in cache
  sizeBytes: number;       // Approximate memory usage
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

interface SessionState {
  sessions: Session[];
  currentSessionId: string | null;
  currentModel: string | null;
  messages: Message[];
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  extensionUIRequest: ExtensionUIRequest | null;
  sessionInfo: SessionStats | null;
  // Context usage tracking
  contextPercent: number;
  contextUsed: number;
  contextWindow: number;
  // Archive state (persisted)
  archivedSessionPaths: string[];
  // LRU cache for session messages
  sessionCache: Map<string, SessionCache>;
  // Session cache with metadata for intelligent invalidation
  sessionMessages: Record<string, Message[]>;
  sessionCacheMeta: Record<string, SessionCacheMeta>;
  // Track which sessions are streaming (for background processing)
  streamingSessions: Record<string, boolean>;
  // Loading state to prevent duplicate adds during initial session load
  isLoadingSessions: boolean;
  // Auto-compaction state
  isCompacting: boolean;
  compactionReason: string | null;

  // Multi-session data storage - per-session state for background sessions
  sessionData: Record<string, SessionData>;

  // Actions
  setSessions: (sessions: Session[]) => void;
  setCurrentSession: (sessionId: string | null) => void;
  switchSession: (newSessionId: string) => void;
  setCurrentModel: (modelId: string) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setStreaming: (isStreaming: boolean) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  clearMessages: () => void;
  setExtensionUIRequest: (request: ExtensionUIRequest | null) => void;
  setSessionInfo: (info: SessionStats | null) => void;
  archiveSession: (sessionPath: string) => void;
  unarchiveSession: (sessionPath: string) => void;
  isSessionArchived: (sessionPath: string) => boolean;
  // Web UI display names (web UI only, not synced to CLI)
  sessionDisplayNames: Record<string, string>;
  setSessionDisplayName: (sessionPath: string, displayName: string) => void;
  getSessionDisplayName: (sessionPath: string) => string | undefined;
  removeSessionDisplayName: (sessionPath: string) => void;
  initPreferences: () => Promise<void>;
  // Background session helpers
  getSessionMessages: (sessionId: string) => Message[];
  isSessionStreaming: (sessionId: string) => boolean;
  clearSessionMessages: (sessionId: string) => void;
  // Cache metadata helpers
  getSessionCacheMeta: (sessionId: string) => SessionCacheMeta | undefined;
  // LRU cache helpers
  evictIfNeeded: () => void;
  getCacheStats: () => { size: number; maxSize: number; sessions: string[] };
  
  // Multi-session data actions
  updateSessionData: (sessionId: string, updates: Partial<SessionData>) => void;
  addMessageToSession: (sessionId: string, message: Message) => void;
  updateMessageInSession: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  setSessionStatus: (sessionId: string, status: SessionData['status']) => void;
  cleanupStaleSessionData: (maxSessions?: number) => void;
  
  // WebSocket event handlers
  handleServerMessage: (message: unknown) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      currentModel: null,
      messages: [],
      isStreaming: false,
      isLoading: false,
      error: null,
      extensionUIRequest: null,
      sessionInfo: null,
      contextPercent: 0,
      contextUsed: 0,
      contextWindow: 0,
      archivedSessionPaths: [],
      sessionDisplayNames: {},
      // LRU cache for session messages
      sessionCache: new Map<string, SessionCache>(),
      // Session cache with metadata
      sessionMessages: {},
      sessionCacheMeta: {},
      streamingSessions: {},
      isLoadingSessions: false,
      // Auto-compaction state
      isCompacting: false,
      compactionReason: null,
      // Multi-session data storage
      sessionData: {},

      setExtensionUIRequest: (request) => set({ extensionUIRequest: request }),
      setSessionInfo: (info) => set({ sessionInfo: info }),
      setCurrentModel: (modelId) => set({ currentModel: modelId }),

      // LRU cache eviction: remove least recently used sessions when over limit
      evictIfNeeded: () => {
        const state = get();
        const cache = state.sessionCache;
        
        if (cache.size <= MAX_CACHED_SESSIONS) return;
        
        // Sort by lastAccess (oldest first)
        const entries = [...cache.entries()]
          .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
        
        // Remove oldest (but never current session)
        const currentSessionId = state.currentSessionId;
        const toEvict: string[] = [];
        
        for (const [id] of entries) {
          if (id !== currentSessionId && cache.size - toEvict.length > MAX_CACHED_SESSIONS) {
            toEvict.push(id);
          }
        }
        
        if (toEvict.length > 0) {
          set((s) => {
            const newCache = new Map(s.sessionCache);
            const newSessionMessages = { ...s.sessionMessages };
            const newSessionCacheMeta = { ...s.sessionCacheMeta };
            
            toEvict.forEach(id => {
              newCache.delete(id);
              delete newSessionMessages[id];
              delete newSessionCacheMeta[id];
            });
            
            return {
              sessionCache: newCache,
              sessionMessages: newSessionMessages,
              sessionCacheMeta: newSessionCacheMeta,
            };
          });
        }
      },

      // Get cache statistics
      getCacheStats: () => {
        const cache = get().sessionCache;
        return {
          size: cache.size,
          maxSize: MAX_CACHED_SESSIONS,
          sessions: [...cache.keys()],
        };
      },

      // Atomic session switch - clears old data before loading new
      switchSession: (newSessionId: string) => {
        set((state) => {
          const newCache = new Map(state.sessionCache);
          
          // Mark old session cache as accessed before switching
          if (state.currentSessionId) {
            const oldCache = newCache.get(state.currentSessionId);
            if (oldCache) {
              oldCache.lastAccess = Date.now();
            }
          }
          
          // Get cached messages for new session (or empty)
          const newSessionCache = newCache.get(newSessionId);
          const cachedMessages = newSessionCache?.messages || [];
          
          // Update lastAccess for new session
          if (newSessionCache) {
            newSessionCache.lastAccess = Date.now();
          } else {
            // Create new cache entry
            newCache.set(newSessionId, {
              messages: cachedMessages,
              lastAccess: Date.now(),
            });
          }
          
          return {
            currentSessionId: newSessionId,
            messages: cachedMessages,
            sessionCache: newCache,
            // Reset streaming state for the new session
            isStreaming: state.streamingSessions[newSessionId] || false,
          };
        });
        
        // Trigger eviction after switch
        get().evictIfNeeded();
      },

      // Background session helpers
      getSessionMessages: (sessionId: string) => {
        return get().sessionMessages[sessionId] || [];
      },
      
      isSessionStreaming: (sessionId: string) => {
        return get().streamingSessions[sessionId] || false;
      },
      
      clearSessionMessages: (sessionId: string) => {
        set((state) => {
          const newSessionMessages = { ...state.sessionMessages };
          const newSessionCacheMeta = { ...state.sessionCacheMeta };
          const newCache = new Map(state.sessionCache);
          delete newSessionMessages[sessionId];
          delete newSessionCacheMeta[sessionId];
          newCache.delete(sessionId);
          return { 
            sessionMessages: newSessionMessages,
            sessionCacheMeta: newSessionCacheMeta,
            sessionCache: newCache,
          };
        });
      },

      getSessionCacheMeta: (sessionId: string) => {
        return get().sessionCacheMeta[sessionId];
      },

      // Multi-session data actions
      updateSessionData: (sessionId, updates) => {
        set((state) => {
          const existingData = state.sessionData[sessionId] || {
            messages: [],
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

      addMessageToSession: (sessionId, message) => {
        set((state) => {
          const existingData = state.sessionData[sessionId] || {
            messages: [],
            status: 'idle' as const,
            lastEventTimestamp: 0,
            contextPercent: 0,
            currentStep: 0,
            model: null,
          };
          const newMessages = [...existingData.messages, message];
          const newCache = new Map(state.sessionCache);
          newCache.set(sessionId, {
            messages: newMessages,
            lastAccess: Date.now(),
          });
          return {
            sessionData: {
              ...state.sessionData,
              [sessionId]: {
                ...existingData,
                messages: newMessages,
                lastEventTimestamp: Date.now(),
              },
            },
            // Also update legacy sessionMessages cache for backward compatibility
            sessionMessages: {
              ...state.sessionMessages,
              [sessionId]: newMessages,
            },
            sessionCache: newCache,
          };
        });
      },

      updateMessageInSession: (sessionId, messageId, updates) => {
        set((state) => {
          const existingData = state.sessionData[sessionId];
          if (!existingData) return state;
          
          const newMessages = existingData.messages.map((msg) =>
            msg.id === messageId ? { ...msg, ...updates } : msg
          );
          const newCache = new Map(state.sessionCache);
          newCache.set(sessionId, {
            messages: newMessages,
            lastAccess: Date.now(),
          });
          return {
            sessionData: {
              ...state.sessionData,
              [sessionId]: {
                ...existingData,
                messages: newMessages,
                lastEventTimestamp: Date.now(),
              },
            },
            // Also update legacy sessionMessages cache for backward compatibility
            sessionMessages: {
              ...state.sessionMessages,
              [sessionId]: newMessages,
            },
            sessionCache: newCache,
          };
        });
      },

      setSessionStatus: (sessionId, status) => {
        set((state) => {
          const existingData = state.sessionData[sessionId] || {
            messages: [],
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
            // Also update streamingSessions for backward compatibility
            streamingSessions: {
              ...state.streamingSessions,
              [sessionId]: status === 'streaming',
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
            const newSessionMessages = { ...s.sessionMessages };
            const newStreamingSessions = { ...s.streamingSessions };
            
            toRemove.forEach(id => {
              delete newSessionData[id];
              delete newSessionMessages[id];
              delete newStreamingSessions[id];
            });
            
            return {
              sessionData: newSessionData,
              sessionMessages: newSessionMessages,
              streamingSessions: newStreamingSessions,
            };
          });
        }
      },

      archiveSession: (sessionPath) => {
        set((state) => ({
          archivedSessionPaths: state.archivedSessionPaths.includes(sessionPath)
            ? state.archivedSessionPaths
            : [...state.archivedSessionPaths, sessionPath],
        }));
        // Fire-and-forget sync to server so all devices stay in sync
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
        // Fire-and-forget sync to server so all devices stay in sync
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
            // Server is the source of truth — overrides localStorage cache
            set({ archivedSessionPaths: serverPrefs.archivedSessionPaths });
          }
          if (serverPrefs.sessionDisplayNames !== undefined) {
            // Merge server display names with local ones
            // Server wins for conflicts, but local-only entries are preserved
            const currentDisplayNames = get().sessionDisplayNames;
            const mergedDisplayNames = {
              ...currentDisplayNames,
              ...serverPrefs.sessionDisplayNames,
            };
            set({ sessionDisplayNames: mergedDisplayNames });
          }
        } catch (e) {
          // Non-fatal: fall back to whatever is already in localStorage
          console.warn('Failed to load preferences from server, using local cache:', e);
        }
      },

      setSessions: (sessions) => {
        // Deduplicate sessions by path (path is the stable identifier)
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

      setCurrentSession: (sessionId) => {
        const state = get();
        
        // First, save current session's messages to cache with metadata (if any)
        if (state.currentSessionId && state.messages.length > 0) {
          const oldMessages = state.messages;
          set((s) => {
            const newCache = new Map(s.sessionCache);
            newCache.set(s.currentSessionId!, {
              messages: oldMessages,
              lastAccess: Date.now(),
            });
            return {
              sessionCache: newCache,
              sessionMessages: {
                ...s.sessionMessages,
                [s.currentSessionId!]: oldMessages,
              },
              sessionCacheMeta: {
                ...s.sessionCacheMeta,
                [s.currentSessionId!]: {
                  fileTimestamp: s.sessionCacheMeta[s.currentSessionId!]?.fileTimestamp || 0,
                  lastLocalUpdate: Date.now(),
                  isStreaming: s.isStreaming,
                  messageCount: oldMessages.length,
                  sizeBytes: estimateMessagesSize(oldMessages),
                },
              },
            };
          });
        }
        
        // Then, switch to new session and load its cached messages (if any)
        const cachedMessages = sessionId ? get().sessionMessages[sessionId] || [] : [];
        set((s) => {
          const newCache = new Map(s.sessionCache);
          if (sessionId) {
            const existingCache = newCache.get(sessionId);
            newCache.set(sessionId, {
              messages: existingCache?.messages || cachedMessages,
              lastAccess: Date.now(),
            });
          }
          return {
            currentSessionId: sessionId,
            messages: cachedMessages,
            sessionCache: newCache,
          };
        });
        
        // Trigger eviction after session switch
        get().evictIfNeeded();
      },

      addMessage: (message) => {
        set((state) => {
          const newMessages = [...state.messages, message];
          // Also update the session caches
          const sessionId = state.currentSessionId;
          const newSessionMessages = sessionId 
            ? { ...state.sessionMessages, [sessionId]: newMessages }
            : state.sessionMessages;
          const newCache = new Map(state.sessionCache);
          if (sessionId) {
            newCache.set(sessionId, {
              messages: newMessages,
              lastAccess: Date.now(),
            });
          }
          const newSessionCacheMeta = sessionId 
            ? {
                ...state.sessionCacheMeta,
                [sessionId]: {
                  ...state.sessionCacheMeta[sessionId],
                  messageCount: newMessages.length,
                  sizeBytes: estimateMessagesSize(newMessages),
                  lastLocalUpdate: Date.now(),
                },
              }
            : state.sessionCacheMeta;
          return { 
            messages: newMessages,
            sessionMessages: newSessionMessages,
            sessionCache: newCache,
            sessionCacheMeta: newSessionCacheMeta,
          };
        });
      },

      updateMessage: (id, updates) => {
        set((state) => {
          const newMessages = state.messages.map((msg) =>
            msg.id === id ? { ...msg, ...updates } : msg
          );
          // Also update the session caches
          const sessionId = state.currentSessionId;
          const newSessionMessages = sessionId 
            ? { ...state.sessionMessages, [sessionId]: newMessages }
            : state.sessionMessages;
          const newCache = new Map(state.sessionCache);
          if (sessionId) {
            newCache.set(sessionId, {
              messages: newMessages,
              lastAccess: Date.now(),
            });
          }
          const newSessionCacheMeta = sessionId 
            ? {
                ...state.sessionCacheMeta,
                [sessionId]: {
                  ...state.sessionCacheMeta[sessionId],
                  messageCount: newMessages.length,
                  sizeBytes: estimateMessagesSize(newMessages),
                  lastLocalUpdate: Date.now(),
                },
              }
            : state.sessionCacheMeta;
          return { 
            messages: newMessages,
            sessionMessages: newSessionMessages,
            sessionCache: newCache,
            sessionCacheMeta: newSessionCacheMeta,
          };
        });
      },

      setStreaming: (isStreaming) => {
        set((state) => {
          const sessionId = state.currentSessionId;
          const newStreamingSessions = sessionId 
            ? { ...state.streamingSessions, [sessionId]: isStreaming }
            : state.streamingSessions;
          return { 
            isStreaming,
            streamingSessions: newStreamingSessions,
          };
        });
      },
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => set({ error }),

      clearMessages: () => set({ messages: [] }),

      handleServerMessage: (message: unknown) => {
        const msg = message as { type: string; [key: string]: unknown };

        switch (msg.type) {
          case 'sessions_list': {
            // Deduplicate sessions by path (path is the stable identifier)
            const rawSessions = (msg.sessions as Session[]) || [];
            const seenPaths = new Set<string>();
            const dedupedSessions = rawSessions.filter((session) => {
              if (seenPaths.has(session.path)) {
                console.warn(`[sessionStore] Duplicate session path in sessions_list: ${session.path}`);
                return false;
              }
              seenPaths.add(session.path);
              return true;
            });
            set({ sessions: dedupedSessions, isLoadingSessions: false });
            break;
          }

          case 'session_created':
            set({ 
              currentSessionId: msg.sessionId as string,
              messages: [], // Clear messages for new session
              contextPercent: 0,
              contextUsed: 0,
              contextWindow: 0,
              sessionInfo: null,
            });
            // Clear any cached messages for this session
            set((state) => {
              const newSessionMessages = { ...state.sessionMessages };
              const newSessionCacheMeta = { ...state.sessionCacheMeta };
              const newCache = new Map(state.sessionCache);
              delete newSessionMessages[msg.sessionId as string];
              delete newSessionCacheMeta[msg.sessionId as string];
              newCache.delete(msg.sessionId as string);
              return { 
                sessionMessages: newSessionMessages,
                sessionCacheMeta: newSessionCacheMeta,
                sessionCache: newCache,
              };
            });
            break;

          case 'session_switched': {
            const switchMsg = msg as unknown as {
              sessionId: string;
              model?: string;
              contextWindow?: number;
              contextUsed?: number;
              contextPercent?: number;
              messages?: Array<{
                id: string;
                role: 'user' | 'assistant';
                content: string | Array<{ type: string; text?: string; thinking?: string }>;
                timestamp: number;
              }>;
              fileTimestamp?: number;
              isStreaming?: boolean;
            };
            
            // Transform server messages to client Message format
            const serverMessages = switchMsg.messages || [];
            const clientMessages: Message[] = serverMessages.map((serverMsg) => ({
              id: serverMsg.id,
              role: serverMsg.role,
              content: serverMsg.content,
              timestamp: serverMsg.timestamp,
            }));
            
            // Save current session's messages before switching (if any)
            const currentId = get().currentSessionId;
            const currentMessages = get().messages;
            
            // Check if we should use server messages or keep local cache
            // Server file is the source of truth, but we need to handle streaming state
            const serverFileTimestamp = switchMsg.fileTimestamp || 0;
            const serverIsStreaming = switchMsg.isStreaming || false;
            
            set((state) => {
              const newSessionMessages = { ...state.sessionMessages };
              const newSessionCacheMeta = { ...state.sessionCacheMeta };
              const newCache = new Map(state.sessionCache);
              
              // Save current session's messages with metadata
              if (currentId && currentMessages.length > 0) {
                newSessionMessages[currentId] = currentMessages;
                newSessionCacheMeta[currentId] = {
                  fileTimestamp: state.sessionCacheMeta[currentId]?.fileTimestamp || 0,
                  lastLocalUpdate: Date.now(),
                  isStreaming: state.isStreaming,
                  messageCount: currentMessages.length,
                  sizeBytes: estimateMessagesSize(currentMessages),
                };
                newCache.set(currentId, {
                  messages: currentMessages,
                  lastAccess: Date.now(),
                });
              }
              
              // Store the switched session's messages with metadata from server
              if (switchMsg.sessionId) {
                newSessionMessages[switchMsg.sessionId] = clientMessages;
                newSessionCacheMeta[switchMsg.sessionId] = {
                  fileTimestamp: serverFileTimestamp,
                  lastLocalUpdate: Date.now(),
                  isStreaming: serverIsStreaming,
                  messageCount: clientMessages.length,
                  sizeBytes: estimateMessagesSize(clientMessages),
                };
                newCache.set(switchMsg.sessionId, {
                  messages: clientMessages,
                  lastAccess: Date.now(),
                });
              }
              
              return {
                currentSessionId: switchMsg.sessionId,
                currentModel: switchMsg.model ?? null,
                messages: clientMessages,
                contextPercent: switchMsg.contextPercent ?? 0,
                contextUsed: switchMsg.contextUsed ?? 0,
                contextWindow: switchMsg.contextWindow ?? 0,
                sessionMessages: newSessionMessages,
                sessionCacheMeta: newSessionCacheMeta,
                sessionCache: newCache,
                // If server says streaming, trust it
                isStreaming: serverIsStreaming,
              };
            });
            
            // Trigger eviction after session switch
            get().evictIfNeeded();
            break;
          }

          case 'agent_start':
            set((state) => {
              const sessionId = state.currentSessionId;
              const newStreamingSessions = sessionId 
                ? { ...state.streamingSessions, [sessionId]: true }
                : state.streamingSessions;
              const newSessionCacheMeta = { ...state.sessionCacheMeta };
              if (sessionId) {
                const currentMeta = newSessionCacheMeta[sessionId] || {};
                newSessionCacheMeta[sessionId] = {
                  ...currentMeta,
                  isStreaming: true,
                  lastLocalUpdate: Date.now(),
                  messageCount: currentMeta.messageCount || state.messages.length,
                  sizeBytes: currentMeta.sizeBytes || estimateMessagesSize(state.messages),
                };
              }
              return { 
                isStreaming: true, 
                isLoading: false,
                streamingSessions: newStreamingSessions,
                sessionCacheMeta: newSessionCacheMeta,
              };
            });
            break;

          case 'agent_end':
            set((state) => {
              const sessionId = state.currentSessionId;
              const newStreamingSessions = sessionId 
                ? { ...state.streamingSessions, [sessionId]: false }
                : state.streamingSessions;
              const newSessionCacheMeta = { ...state.sessionCacheMeta };
              if (sessionId) {
                const currentMeta = newSessionCacheMeta[sessionId] || {};
                newSessionCacheMeta[sessionId] = {
                  ...currentMeta,
                  isStreaming: false,
                  lastLocalUpdate: Date.now(),
                  messageCount: state.messages.length,
                  sizeBytes: estimateMessagesSize(state.messages),
                };
              }
              return { 
                isStreaming: false,
                streamingSessions: newStreamingSessions,
                sessionCacheMeta: newSessionCacheMeta,
              };
            });
            break;

          case 'message_start': {
            const messageData = (msg.message as { id: string; role: string; content: unknown }) || {};
            const newMessage: Message = {
              id: messageData.id || `msg_${Date.now()}`,
              role: messageData.role as 'user' | 'assistant' | 'tool',
              content: messageData.content as Message['content'],
              timestamp: Date.now(),
            };
            get().addMessage(newMessage);
            break;
          }

          case 'message_update': {
            // Update streaming content
            const { message: msgData, assistantMessageEvent } = msg as {
              message?: { id: string; content?: Message['content'] };
              assistantMessageEvent?: { type: string; delta?: string };
            };
            
            if (msgData?.id && assistantMessageEvent) {
              const existingMsg = get().messages.find(m => m.id === msgData.id);
              if (existingMsg) {
                // Get existing content array or create new one
                let contentArray: Array<{ type: string; text?: string; thinking?: string }>;
                if (Array.isArray(existingMsg.content)) {
                  contentArray = [...existingMsg.content];
                } else if (typeof existingMsg.content === 'string') {
                  contentArray = existingMsg.content ? [{ type: 'text', text: existingMsg.content }] : [];
                } else {
                  contentArray = [];
                }

                const eventType = assistantMessageEvent.type;
                const delta = assistantMessageEvent.delta;

                // Handle text content (text_delta)
                if (eventType === 'text_delta') {
                  const lastEntry = contentArray[contentArray.length - 1];
                  if (lastEntry && lastEntry.type === 'text') {
                    lastEntry.text = (lastEntry.text || '') + delta;
                  } else {
                    contentArray.push({ type: 'text', text: delta });
                  }
                  get().updateMessage(msgData.id, { content: contentArray });
                }
                // Handle thinking content (thinking_delta)
                else if (eventType === 'thinking_delta') {
                  const lastEntry = contentArray[contentArray.length - 1];
                  if (lastEntry && lastEntry.type === 'thinking') {
                    lastEntry.thinking = (lastEntry.thinking || '') + delta;
                  } else {
                    contentArray.push({ type: 'thinking', thinking: delta });
                  }
                  get().updateMessage(msgData.id, { content: contentArray });
                }
              }
            }
            break;
          }

          case 'message_end': {
            // Message streaming complete - update cache metadata
            const { message: msgData } = msg as { message?: { id: string } };
            if (msgData?.id) {
              set((state) => {
                const sessionId = state.currentSessionId;
                if (sessionId) {
                  const currentMeta = state.sessionCacheMeta[sessionId] || {};
                  return {
                    sessionCacheMeta: {
                      ...state.sessionCacheMeta,
                      [sessionId]: {
                        ...currentMeta,
                        lastLocalUpdate: Date.now(),
                        messageCount: state.messages.length,
                        sizeBytes: estimateMessagesSize(state.messages),
                      },
                    },
                  };
                }
                return state;
              });
            }
            break;
          }

          case 'tool_execution_start': {
            const { toolCallId, toolName, args } = msg as unknown as {
              toolCallId: string;
              toolName: string;
              args: unknown;
            };
            const toolMessage: Message = {
              id: toolCallId,
              role: 'tool',
              content: '',
              timestamp: Date.now(),
              toolCall: { id: toolCallId, name: toolName, args },
            };
            get().addMessage(toolMessage);
            break;
          }

          case 'tool_execution_update': {
            const { toolCallId, partialResult } = msg as unknown as {
              toolCallId: string;
              partialResult?: { content: Array<{ type: string; text?: string }> };
            };
            const content = partialResult?.content?.[0]?.text || '';
            get().updateMessage(toolCallId, { 
              content,
              toolResult: { output: content, isError: false },
            });
            break;
          }

          case 'tool_execution_end': {
            const { toolCallId, result, isError } = msg as unknown as {
              toolCallId: string;
              result?: { content: Array<{ type: string; text?: string }> };
              isError: boolean;
            };
            const content = result?.content?.[0]?.text || '';
            get().updateMessage(toolCallId, {
              content,
              toolResult: { output: content, isError },
            });
            break;
          }

          case 'error':
            set({ 
              error: (msg.message as string) || 'Unknown error',
              isStreaming: false,
              isLoading: false,
            });
            break;

          case 'session_update': {
            // Skip session_update events during initial load to prevent duplicates
            if (get().isLoadingSessions) {
              console.log('[sessionStore] Ignoring session_update during initial load');
              break;
            }
            
            const { type, sessionId, info } = msg as {
              type: 'add' | 'change' | 'unlink';
              sessionId: string;
              info?: Session;
            };
            
            if (type === 'unlink') {
              // Remove deleted session (use path for matching)
              set((state) => ({
                sessions: state.sessions.filter((s) => s.path !== info?.path && s.id !== sessionId),
              }));
            } else if (info) {
              // Add or update session (dedupe by path)
              set((state) => {
                // Check if session with this path already exists
                const existingByPath = state.sessions.findIndex((s) => s.path === info.path);
                const existingById = state.sessions.findIndex((s) => s.id === info.id);
                const existingIndex = existingByPath >= 0 ? existingByPath : existingById;
                
                if (existingIndex >= 0) {
                  // Update existing
                  const newSessions = [...state.sessions];
                  newSessions[existingIndex] = info;
                  return { sessions: newSessions };
                } else {
                  // Add new
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
            // Show success toast
            useUIStore.getState().addToast({
              type: 'success',
              message: `Model changed to ${modelName}`,
            });
            break;
          }

          case 'session_info': {
            const { stats } = msg as unknown as { stats: SessionStats };
            set({ sessionInfo: stats });
            
            // Record usage for dashboard (fire-and-forget)
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
              }).catch(() => {
                // Silently ignore recording errors
              });
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
            // Show toast notification, reset compaction state, and update context indicators
            set({ 
              isCompacting: false, 
              compactionReason: null,
              contextWindow: contextWindow ?? get().contextWindow,
              contextUsed: contextUsed ?? get().contextUsed,
              contextPercent: contextPercent ?? get().contextPercent,
            });
            // Also update sessionInfo if it exists to keep it in sync
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

          // Multi-session event routing
          case 'session_event': {
            const sessionEvent = msg as unknown as {
              sessionId: string;
              event: { type: string; [key: string]: unknown };
            };
            const { sessionId, event } = sessionEvent;
            
            // Route event to the correct session
            switch (event.type) {
              case 'agent_start':
                get().setSessionStatus(sessionId, 'streaming');
                // Also update current session if it matches
                if (get().currentSessionId === sessionId) {
                  set({ isStreaming: true, isLoading: false });
                }
                break;
                
              case 'agent_end':
                get().setSessionStatus(sessionId, 'idle');
                currentMessageIdBySession.delete(sessionId);
                // Also update current session if it matches
                if (get().currentSessionId === sessionId) {
                  set({ isStreaming: false });
                }
                break;
                
              case 'message_start': {
                const messageData = (event.message as { id: string; role: string; content: unknown }) || {};
                const newMessage: Message = {
                  id: messageData.id || `msg_${Date.now()}`,
                  role: messageData.role as 'user' | 'assistant' | 'tool',
                  content: messageData.content as Message['content'],
                  timestamp: Date.now(),
                };
                // Track the current message ID for this session so message_update
                // events (which may arrive without IDs from raw SDK events) can
                // be routed to the correct message.
                currentMessageIdBySession.set(sessionId, newMessage.id);
                get().addMessageToSession(sessionId, newMessage);
                // Also update current session if it matches
                if (get().currentSessionId === sessionId) {
                  get().addMessage(newMessage);
                }
                break;
              }
              
              case 'message_update': {
                const { message: msgData, assistantMessageEvent } = event as {
                  message?: { id: string; content?: Message['content'] };
                  assistantMessageEvent?: { type: string; delta?: string };
                };
                
                // Use the tracked current message ID as fallback when raw SDK
                // events arrive without IDs (multi-session-manager bypasses
                // the EventForwarder's ID injection).
                const messageId = msgData?.id || currentMessageIdBySession.get(sessionId);
                
                if (messageId && assistantMessageEvent) {
                  const sessionData = get().sessionData[sessionId];
                  if (sessionData) {
                    const existingMsg = sessionData.messages.find(m => m.id === messageId);
                    if (existingMsg) {
                      let contentArray: Array<{ type: string; text?: string; thinking?: string }>;
                      if (Array.isArray(existingMsg.content)) {
                        contentArray = [...existingMsg.content];
                      } else if (typeof existingMsg.content === 'string') {
                        contentArray = existingMsg.content ? [{ type: 'text', text: existingMsg.content }] : [];
                      } else {
                        contentArray = [];
                      }

                      const eventType = assistantMessageEvent.type;
                      const delta = assistantMessageEvent.delta;

                      if (eventType === 'text_delta') {
                        const lastEntry = contentArray[contentArray.length - 1];
                        if (lastEntry && lastEntry.type === 'text') {
                          lastEntry.text = (lastEntry.text || '') + delta;
                        } else {
                          contentArray.push({ type: 'text', text: delta });
                        }
                        get().updateMessageInSession(sessionId, messageId, { content: contentArray });
                        // Also update current session if it matches
                        if (get().currentSessionId === sessionId) {
                          get().updateMessage(messageId, { content: contentArray });
                        }
                      } else if (eventType === 'thinking_delta') {
                        const lastEntry = contentArray[contentArray.length - 1];
                        if (lastEntry && lastEntry.type === 'thinking') {
                          lastEntry.thinking = (lastEntry.thinking || '') + delta;
                        } else {
                          contentArray.push({ type: 'thinking', thinking: delta });
                        }
                        get().updateMessageInSession(sessionId, messageId, { content: contentArray });
                        // Also update current session if it matches
                        if (get().currentSessionId === sessionId) {
                          get().updateMessage(messageId, { content: contentArray });
                        }
                      }
                    }
                  }
                }
                break;
              }
              
              case 'tool_execution_start': {
                const { toolCallId, toolName, args } = event as unknown as {
                  toolCallId: string;
                  toolName: string;
                  args: unknown;
                };
                const toolMessage: Message = {
                  id: toolCallId,
                  role: 'tool',
                  content: '',
                  timestamp: Date.now(),
                  toolCall: { id: toolCallId, name: toolName, args },
                };
                get().addMessageToSession(sessionId, toolMessage);
                // Also update current session if it matches
                if (get().currentSessionId === sessionId) {
                  get().addMessage(toolMessage);
                }
                break;
              }
              
              case 'tool_execution_update': {
                const { toolCallId, partialResult } = event as unknown as {
                  toolCallId: string;
                  partialResult?: { content: Array<{ type: string; text?: string }> };
                };
                const content = partialResult?.content?.[0]?.text || '';
                get().updateMessageInSession(sessionId, toolCallId, { 
                  content,
                  toolResult: { output: content, isError: false },
                });
                // Also update current session if it matches
                if (get().currentSessionId === sessionId) {
                  get().updateMessage(toolCallId, { 
                    content,
                    toolResult: { output: content, isError: false },
                  });
                }
                break;
              }
              
              case 'tool_execution_end': {
                const { toolCallId, result, isError } = event as unknown as {
                  toolCallId: string;
                  result?: { content: Array<{ type: string; text?: string }> };
                  isError: boolean;
                };
                const content = result?.content?.[0]?.text || '';
                get().updateMessageInSession(sessionId, toolCallId, {
                  content,
                  toolResult: { output: content, isError },
                });
                // Also update current session if it matches
                if (get().currentSessionId === sessionId) {
                  get().updateMessage(toolCallId, {
                    content,
                    toolResult: { output: content, isError },
                  });
                }
                break;
              }
              
              case 'auto_compaction_start': {
                const { reason } = event as unknown as { reason: string };
                // Update current session if it matches
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
                // Update current session if it matches
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
            }
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
            
            // Update additional session data if provided
            if (currentStep !== undefined || messageCount !== undefined) {
              get().updateSessionData(sessionId, {
                currentStep: currentStep ?? get().sessionData[sessionId]?.currentStep ?? 0,
              });
            }
            
            // Sync global isStreaming if this is the current session
            // This ensures the UI (MessageInput) reflects the correct state
            // when switching sessions or receiving status updates
            if (get().currentSessionId === sessionId) {
              const isStreaming = status === 'streaming' || status === 'busy';
              set({ isStreaming });
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
        sessionCacheMeta: state.sessionCacheMeta,
      }),
    }
  )
);
