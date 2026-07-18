import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useUIStore } from './uiStore';
import {
  getPreferences,
  archiveSessionPref,
  unarchiveSessionPref,
  archiveAllSessionsPref,
  pinSessionPref,
  unpinSessionPref,
  setDisplayNamePref,
  clearDisplayNamePref,
} from '../lib/api';
import type { ContentPart } from '../hooks/useSessionStream.js';
import type { SubagentToolSummary } from '@pi-web-ui/shared';

import { useTransferStore } from './transferStore';
import { recordBrowserDiagnostic, recordProtocolDrift } from '../lib/browserDiagnostics.js';

// ============================================================================
// Throttled localStorage for Zustand persist
// ============================================================================
// Zustand's persist middleware writes to storage on EVERY set() call.
// During streaming, this can mean 50-200+ localStorage writes per second
// which causes blocking I/O on mobile devices (10-50ms each).
//
// This wrapper debounces writes: state changes are buffered and flushed
// at most once per second. On app hide (visibilitychange), pending writes
// are flushed immediately so no state is lost.
// ============================================================================

const STORAGE_KEY = 'pi-web-ui-session';

export const TRANSFER_READY_MESSAGE = 'Context transferred — ready for your next instruction';

let throttleWriteTimer: ReturnType<typeof setTimeout> | null = null;
let throttlePendingValue: string | null = null;
let throttleCommittedValue: string | null = null;

// Flush on page hide so no state is lost
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && throttlePendingValue !== null && throttleWriteTimer !== null) {
      clearTimeout(throttleWriteTimer);
      throttleWriteTimer = null;
      try {
        localStorage.setItem(STORAGE_KEY, throttlePendingValue);
        throttleCommittedValue = throttlePendingValue;
      } catch (error) {
        recordStorageFailure('flush_on_hide', error);
      }
      throttlePendingValue = null;
    }
  });
}

function recordStorageFailure(operation: string, error: unknown): void {
  recordBrowserDiagnostic({
    kind: 'storage_error',
    operation,
    errorName: error instanceof Error ? error.name : typeof error,
  });
}

const throttledStorage = {
  getItem: (name: string): string | null => {
    try {
      const value = localStorage.getItem(name);
      throttleCommittedValue = value;
      return value;
    } catch (error) {
      recordStorageFailure('read', error);
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    // Only write if value actually changed from either the pending or last
    // committed snapshot. The committed check also prevents storage-event
    // hydration from echoing the same value back to its source tab.
    if (value === throttlePendingValue || value === throttleCommittedValue) return;
    throttlePendingValue = value;

    if (throttleWriteTimer !== null) {
      clearTimeout(throttleWriteTimer);
    }
    throttleWriteTimer = setTimeout(() => {
      throttleWriteTimer = null;
      try {
        localStorage.setItem(name, value);
        throttleCommittedValue = value;
      } catch (error) {
        recordStorageFailure('write', error);
      }
      throttlePendingValue = null;
    }, 1000);
  },
  removeItem: (name: string): void => {
    if (throttleWriteTimer !== null) {
      clearTimeout(throttleWriteTimer);
      throttleWriteTimer = null;
    }
    throttlePendingValue = null;
    throttleCommittedValue = null;
    try {
      localStorage.removeItem(name);
    } catch (error) {
      recordStorageFailure('remove', error);
    }
  },
};

/**
 * Sync a small per-item preference delta to the server with bounded retry, and
 * revert the optimistic local change on final failure.
 *
 * Write failures used to be swallowed by a `.catch(console.warn)`, leaving the UI
 * permanently diverged from the server (the optimistic change stayed even though
 * the write never landed). Retrying with backoff absorbs transient blips; on a
 * final failure we revert so the client stays server-authoritative instead of
 * silently desyncing. Every metadata mutation (archive, pin, display name) goes
 * through this one helper — the unified write/sync rule.
 */
const DELTA_RETRY_DELAYS_MS = [500, 1500, 4000];
async function syncPreferenceDelta(
  attempt: () => Promise<unknown>,
  onFinalFailure: () => void,
): Promise<void> {
  for (let attemptNum = 0; ; attemptNum++) {
    try {
      await attempt();
      return;
    } catch (e) {
      if (attemptNum >= DELTA_RETRY_DELAYS_MS.length) {
        console.warn('Preference delta write failed after retries; reverting optimistic change:', e);
        onFinalFailure();
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, DELTA_RETRY_DELAYS_MS[attemptNum]));
    }
  }
}

// Maximum sessions to keep in memory (LRU cache limit)
// Kept low (2) to reduce memory pressure on mobile devices.
// Holds current session + one recently-accessed session for fast switching.
const MAX_CACHED_SESSIONS = 2;

// Fallback shown if a Claude auth-expiry error reaches the client without a
// server-provided remediation message. The server (see `claude-auth-errors.ts`)
// normally sends a backend- and profile-aware message, which we display as-is.
const REAUTH_FALLBACK_MESSAGE =
  'Claude authentication has expired or is invalid. Re-authenticate on the server, then retry.';

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

function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const maybeContent = (result as { content?: Array<{ text?: string }> }).content;
    if (Array.isArray(maybeContent)) {
      return maybeContent.map((part) => part.text ?? '').join('');
    }
    return JSON.stringify(result);
  }
  return '';
}

export interface Session {
  id: string;
  path: string;
  firstMessage: string;
  messageCount: number;
  cwd: string;
  name?: string;
  sdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity';  // optional for backward compatibility
  model?: string;              // current model
  createdAt?: string;
  lastActivity?: string;
}

// ── v2 session metadata (keyed by stable `${sdkType}:${id}`) ────────────────
// The single source of truth for archived / pinned / display name. The legacy
// path-based arrays/map below are DERIVED projections of this map (so existing
// path-based readers keep working unchanged) and are recomputed on every
// mutation. Keys are immune to Pi .jsonl filename changes; `updatedAt` enables
// last-writer-wins convergence (enforced server-side).
export interface SessionMeta {
  archived?: true;
  pinned?: true;
  displayName?: string;
  updatedAt?: number;
  /** Original path-based key — lets the legacy arrays be derived losslessly. */
  legacyKey?: string;
}

/** Stable per-session key: `${sdkType}:${id}` (sdkType defaults to 'pi'). */
export function sessionKeyOf(session: { sdkType?: string; id: string }): string {
  return `${session.sdkType ?? 'pi'}:${session.id}`;
}

/** Derive the legacy path-based arrays/map from a keyed sessionMeta map. */
function deriveLegacyFromMeta(meta: Record<string, SessionMeta>): {
  archivedSessionPaths: string[];
  pinnedSessionPaths: string[];
  sessionDisplayNames: Record<string, string>;
} {
  const archivedSessionPaths: string[] = [];
  const pinnedSessionPaths: string[] = [];
  const sessionDisplayNames: Record<string, string> = {};
  for (const [key, rec] of Object.entries(meta)) {
    const legacy = rec.legacyKey ?? key.slice(key.indexOf(':') + 1);
    if (rec.archived) archivedSessionPaths.push(legacy);
    if (rec.pinned) pinnedSessionPaths.push(legacy);
    if (rec.displayName !== undefined) sessionDisplayNames[legacy] = rec.displayName;
  }
  return { archivedSessionPaths, pinnedSessionPaths, sessionDisplayNames };
}

/** Resolve a session path/id to its stable v2 key (falls back to unknown:<path>). */
function keyForPath(sessions: Session[], path: string): string {
  const s = sessions.find((x) => x.path === path || x.id === path);
  return s ? sessionKeyOf(s) : `unknown:${path}`;
}

/**
 * Apply a change to one sessionMeta record and return the recomputed slice
 * (sessionMeta + the derived legacy fields), so a single `set()` keeps the keyed
 * source of truth and its path-based projection in sync.
 */
function commitMeta(
  state: SessionState,
  key: string,
  build: (prev: SessionMeta | undefined) => SessionMeta | undefined,
): { sessionMeta: Record<string, SessionMeta>; archivedSessionPaths: string[]; pinnedSessionPaths: string[]; sessionDisplayNames: Record<string, string> } {
  const meta = { ...state.sessionMeta };
  const next = build(meta[key]);
  if (!next) delete meta[key];
  else meta[key] = next;
  return { sessionMeta: meta, ...deriveLegacyFromMeta(meta) };
}

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
    // Compact subagent/evaluated_subagent summary (model + tool-usage), computed
    // server-side and forwarded on `tool_execution_end`. Present only for Pi
    // subagent-family tools; absent for every other tool/runtime.
    summary?: SubagentToolSummary;
  };
  isComplete?: boolean; // Optional for backward compatibility with LiveMessage
  error?: {
    message: string;
    provider?: string;
    model?: string;
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
  quotaInfo?: {  // Claude rate-limit / quota info
    status: string;
    rateLimitType: string;
    isUsingOverage: boolean;
    resetsAt?: number;
  } | null;
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
  type: 'confirm' | 'select' | 'input' | 'editor' | 'ask_user_question';
  method: string;
  params: Record<string, unknown>;
  timeout: number;
  /** Epoch ms the request arrived (for computing the near-expiry deadline). */
  receivedAt?: number;
  /** Set when the server signalled the dialog closed (extension_ui_cancel). */
  expired?: boolean;
  /** Why the dialog closed ('timeout' | 'aborted' | 'turn_end' | 'disconnected'). */
  expiredReason?: string;
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
  /** True only while displaying Pi SDK's post-compaction token estimate. */
  contextUsageEstimated?: boolean;
  lastActivityAt?: number;
}

export type WorkerStatus = 'spawning' | 'ready' | 'streaming' | 'idle' | 'error' | 'disconnected' | 'terminated';

interface SessionState {
  sessions: Session[];
  currentSessionId: string | null;
  currentSessionSdkType: 'pi' | 'claude' | 'opencode' | 'antigravity' | null;
  currentModel: string | null;
  currentThinkingLevel: string | null;
  messages: Message[];
  isStreaming: boolean;
  lastStreamEventAt: number | null;
  /** Current tool name (or null) — updated from tool_execution_start and stream_activity. */
  currentToolName: string | null;
  /** When the most recent agent_start was received (for slow-prompt detection). */
  promptStartedAt: number | null;
  isLoading: boolean;
  // Loading state for session switching (rehydration)
  isSwitchingSession: boolean;
  switchingToSessionId: string | null;
  error: string | null;
  extensionUIRequest: ExtensionUIRequest | null;
  extensionWidgets: Record<string, string[]>;
  extensionStatuses: Record<string, string | undefined>;
  sessionExtensionWidgets: Record<string, Record<string, string[]>>;
  sessionExtensionStatuses: Record<string, Record<string, string | undefined>>;
  sessionInfo: SessionStats | null;
  // Context usage tracking
  contextPercent: number;
  contextUsed: number;
  contextWindow: number;
  /** Pi cannot know exact usage until the first assistant response after compaction. */
  contextUsageEstimated: boolean;
  // Archive state (persisted)
  archivedSessionPaths: string[];
  // Pinned sessions (persisted) - protected from idle/stale cleanup
  pinnedSessionPaths: string[];
  // v2 keyed source of truth for archived/pinned/displayName. The three fields
  // above (and sessionDisplayNames) are DERIVED from this on every mutation so
  // existing path-based readers keep working; sessionMeta itself is keyed by
  // `${sdkType}:${id}` (stable across Pi path changes) and carries `updatedAt`
  // for last-writer-wins (enforced server-side).
  sessionMeta: Record<string, SessionMeta>;
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

  // Ephemeral UI marker for a completed context transfer. This is deliberately
  // not persisted in the runtime transcript or localStorage.
  transferReadySessionIds: Record<string, boolean>;

  // Multi-session data storage - per-session state for background sessions
  sessionData: Record<string, SessionData>;

  // Worker status tracking - for worker-based session architecture
  workerStatus: Record<string, WorkerStatus>;
  // Active worker sessions - list of sessionIds with active workers
  activeWorkers: string[];

  // Claude Direct availability
  claudeAvailable: boolean;
  claudeAuthError: string | null;

  // OpenCode Direct availability
  opencodeAvailable: boolean;
  opencodeAuthError: string | null;

  // OpenCode Direct agent mode per session ('build' | 'plan')
  opencodeAgentModes: Record<string, 'build' | 'plan'>;

  // Antigravity availability
  antigravityAvailable: boolean;
  antigravityAuthError: string | null;

  // Actions
  setSessions: (sessions: Session[]) => void;
  setCurrentSession: (sessionId: string | null) => void;
  switchSession: (newSessionId: string) => void;
  setCurrentModel: (modelId: string) => void;
  setCurrentThinkingLevel: (level: string) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setStreaming: (isStreaming: boolean) => void;
  setLoading: (isLoading: boolean) => void;
  setSwitchingSession: (isSwitching: boolean, sessionId?: string | null) => void;
  setError: (error: string | null) => void;
  markTransferReady: (sessionId: string) => void;
  clearTransferReady: (sessionId: string) => void;
  isTransferReady: (sessionId: string) => boolean;
  clearMessages: () => void;
  setExtensionUIRequest: (request: ExtensionUIRequest | null) => void;
  setSessionInfo: (info: SessionStats | null) => void;
  archiveSession: (sessionPath: string) => void;
  unarchiveSession: (sessionPath: string) => void;
  archiveAllSessions: () => Promise<void>;
  isSessionArchived: (sessionPath: string) => boolean;
  pinSession: (sessionPath: string) => void;
  unpinSession: (sessionPath: string) => void;
  isSessionPinned: (sessionPath: string) => boolean;
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
  
  // Worker status tracking actions
  updateWorkerStatus: (sessionId: string, status: WorkerStatus) => void;
  getWorkerStatus: (sessionId: string) => WorkerStatus | undefined;
  removeWorkerStatus: (sessionId: string) => void;

  // Claude Direct availability
  setClaudeAvailable: (available: boolean, error?: string | null) => void;

  // OpenCode Direct availability
  setOpencodeAvailable: (available: boolean, error?: string | null) => void;

  // OpenCode Direct agent mode
  setOpencodeAgentMode: (sessionId: string, mode: 'build' | 'plan') => void;
  getOpencodeAgentMode: (sessionId: string) => 'build' | 'plan';

  // Antigravity availability
  setAntigravityAvailable: (available: boolean, error?: string | null) => void;

  // WebSocket event handlers
  handleServerMessage: (message: unknown) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      currentSessionSdkType: null,
      currentModel: null,
      currentThinkingLevel: null,
      messages: [],
      isStreaming: false,
      lastStreamEventAt: null,
      currentToolName: null,
      promptStartedAt: null,
      isLoading: false,
      isSwitchingSession: false,
      switchingToSessionId: null,
      error: null,
      extensionUIRequest: null,
      extensionWidgets: {},
      extensionStatuses: {},
      sessionExtensionWidgets: {},
      sessionExtensionStatuses: {},
      sessionInfo: null,
      contextPercent: 0,
      contextUsed: 0,
      contextWindow: 0,
      contextUsageEstimated: false,
      archivedSessionPaths: [],
      pinnedSessionPaths: [],
      sessionDisplayNames: {},
      sessionMeta: {},
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
      transferReadySessionIds: {},
      // Multi-session data storage
      sessionData: {},
      // Worker status tracking
      workerStatus: {},
      activeWorkers: [],
      // Claude Direct availability
      claudeAvailable: false,
      claudeAuthError: null,
      opencodeAvailable: false,
      opencodeAuthError: null,
      opencodeAgentModes: {},
      antigravityAvailable: false,
      antigravityAuthError: null,

      // Worker status tracking implementation
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
      setOpencodeAvailable: (available, error = null) => set({ opencodeAvailable: available, opencodeAuthError: error }),
      setAntigravityAvailable: (available, error = null) => set({ antigravityAvailable: available, antigravityAuthError: error }),

      setOpencodeAgentMode: (sessionId, mode) => set((state) => ({
        opencodeAgentModes: { ...state.opencodeAgentModes, [sessionId]: mode },
      })),
      getOpencodeAgentMode: (sessionId) => {
        return get().opencodeAgentModes[sessionId] ?? 'build';
      },

      setExtensionUIRequest: (request) => set({ extensionUIRequest: request }),
      setSessionInfo: (info) => set({ sessionInfo: info }),
      setCurrentModel: (modelId) => set({ currentModel: modelId }),
      setCurrentThinkingLevel: (level) => set({ currentThinkingLevel: level }),

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
            currentSessionSdkType: state.sessions.find((s) => s.id === newSessionId)?.sdkType ?? null,
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
        const key = keyForPath(get().sessions, sessionPath);
        const prev = get().sessionMeta[key];
        const now = Date.now();
        set((state) => commitMeta(state, key, (p) => {
          // Auto-unpin when archiving — archived sessions shouldn't consume pin slots.
          const rec: SessionMeta = { ...(p ?? {}), archived: true, updatedAt: now, legacyKey: sessionPath };
          delete rec.pinned;
          return rec;
        }));
        // Delta write (single path) — keepalive-safe and race-free on the server.
        // Reverts the optimistic archive (and restores the pin) if it can't land.
        syncPreferenceDelta(
          () => archiveSessionPref(sessionPath, now),
          () => set((state) => commitMeta(state, key, () => prev ? { ...prev, legacyKey: prev.legacyKey ?? sessionPath } : undefined)),
        );
      },

      unarchiveSession: (sessionPath) => {
        const key = keyForPath(get().sessions, sessionPath);
        const prev = get().sessionMeta[key];
        const now = Date.now();
        set((state) => commitMeta(state, key, (p) => {
          if (!p) return undefined;
          const rec: SessionMeta = { ...p, legacyKey: sessionPath };
          delete rec.archived;
          rec.updatedAt = now;
          return rec;
        }));
        // Delta write; re-archive this path only if the write can't land.
        syncPreferenceDelta(
          () => unarchiveSessionPref(sessionPath, now),
          () => set((state) => commitMeta(state, key, () => prev ? { ...prev, legacyKey: prev.legacyKey ?? sessionPath } : { archived: true, updatedAt: now, legacyKey: sessionPath })),
        );
      },

      archiveAllSessions: async () => {
        const sessions = get().sessions;
        const paths = sessions.map((s) => s.path).filter((p): p is string => !!p);
        const prevMeta = { ...get().sessionMeta };
        const now = Date.now();
        // Optimistic: archive every current session key + auto-unpin them.
        set((state) => {
          const meta = { ...state.sessionMeta };
          for (const s of sessions) {
            if (!s.path) continue;
            const k = sessionKeyOf(s);
            const rec: SessionMeta = { ...(meta[k] ?? {}), archived: true, updatedAt: now, legacyKey: s.path };
            delete rec.pinned;
            meta[k] = rec;
          }
          return { sessionMeta: meta, ...deriveLegacyFromMeta(meta) };
        });
        try {
          const prefs = await archiveAllSessionsPref(paths, now);
          // Server is authoritative — adopt its merged v2 map (with derived legacy).
          const serverMeta = (prefs.sessions as Record<string, SessionMeta> | undefined);
          if (serverMeta) {
            set((state) => ({ sessionMeta: { ...serverMeta }, ...deriveLegacyFromMeta(serverMeta) }));
          } else if (prefs.archivedSessionPaths !== undefined) {
            set({ archivedSessionPaths: prefs.archivedSessionPaths });
            if (prefs.pinnedSessionPaths !== undefined) set({ pinnedSessionPaths: prefs.pinnedSessionPaths });
          }
        } catch (e) {
          console.warn('Failed to archive all sessions on server; reverting:', e);
          set((state) => ({ sessionMeta: { ...prevMeta }, ...deriveLegacyFromMeta(prevMeta) }));
        }
      },

      isSessionArchived: (sessionPath) => {
        return get().archivedSessionPaths.includes(sessionPath);
      },

      pinSession: (sessionPath) => {
        const key = keyForPath(get().sessions, sessionPath);
        const prev = get().sessionMeta[key]; // capture BEFORE the optimistic set
        const now = Date.now();
        let added = false;
        set((state) => {
          if (state.sessionMeta[key]?.pinned) return state;

          const sessionRuntime = (path: string): Session['sdkType'] | undefined => {
            const session = state.sessions.find(s => s.path === path || s.id === path);
            return session?.sdkType;
          };
          const targetRuntime = sessionRuntime(sessionPath);
          const sameRuntimePinnedCount = state.pinnedSessionPaths.filter((path) => {
            const runtime = sessionRuntime(path);
            // Ignore stale preference entries whose sessions are no longer in
            // the sidebar; the server remains authoritative and will reject if
            // this client-side estimate is too permissive.
            return runtime !== undefined && runtime === targetRuntime;
          }).length;

          if (targetRuntime !== undefined && sameRuntimePinnedCount >= 2) return state;
          if (targetRuntime === undefined && state.pinnedSessionPaths.length >= 2) return state; // Backward-compatible fallback
          added = true;
          return commitMeta(state, key, (p) => ({ ...(p ?? {}), pinned: true, updatedAt: now, legacyKey: sessionPath }));
        });
        // Durable per-key delta. The WS runtime hop and the 2/runtime cap above
        // are unchanged; only the durable prefs write moved to the unified delta
        // channel. Reverts the pin if the write can't land.
        if (added) {
          syncPreferenceDelta(
            () => pinSessionPref(sessionPath, now),
            () => set((state) => commitMeta(state, key, () => prev ? { ...prev, legacyKey: prev.legacyKey ?? sessionPath } : undefined)),
          );
        }
      },

      unpinSession: (sessionPath) => {
        const key = keyForPath(get().sessions, sessionPath);
        const wasPinned = !!get().sessionMeta[key]?.pinned;
        const prev = get().sessionMeta[key];
        const now = Date.now();
        set((state) => commitMeta(state, key, (p) => {
          if (!p) return undefined;
          const rec: SessionMeta = { ...p, legacyKey: sessionPath };
          delete rec.pinned;
          rec.updatedAt = now;
          return rec;
        }));
        // Durable per-key delta; re-pins this path only if the write can't land.
        if (wasPinned) {
          syncPreferenceDelta(
            () => unpinSessionPref(sessionPath, now),
            () => set((state) => commitMeta(state, key, () => prev ? { ...prev, legacyKey: prev.legacyKey ?? sessionPath } : { pinned: true, updatedAt: now, legacyKey: sessionPath })),
          );
        }
      },

      isSessionPinned: (sessionPath) => {
        return get().pinnedSessionPaths.includes(sessionPath);
      },

      setSessionDisplayName: (sessionPath, displayName) => {
        const key = keyForPath(get().sessions, sessionPath);
        const prev = get().sessionMeta[key];
        const now = Date.now();
        set((state) => commitMeta(state, key, (p) => ({
          ...(p ?? {}), displayName, updatedAt: now, legacyKey: sessionPath,
        })));
        // Durable per-key delta (replaces the whole-object PATCH that re-sent the
        // entire — multi-KB — display-name map on every rename and tripped the
        // 64 KiB keepalive quota). Reverts to the previous name on final failure.
        syncPreferenceDelta(
          () => setDisplayNamePref(sessionPath, displayName, now),
          () => set((state) => commitMeta(state, key, () => prev ? { ...prev, legacyKey: prev.legacyKey ?? sessionPath } : undefined)),
        );
      },

      getSessionDisplayName: (sessionPath) => {
        return get().sessionDisplayNames[sessionPath];
      },

      removeSessionDisplayName: (sessionPath) => {
        const key = keyForPath(get().sessions, sessionPath);
        const prev = get().sessionMeta[key];
        const now = Date.now();
        set((state) => commitMeta(state, key, (p) => {
          if (!p) return undefined;
          const rec: SessionMeta = { ...p, legacyKey: sessionPath };
          delete rec.displayName;
          rec.updatedAt = now;
          return rec;
        }));
        // Durable per-key delta (name: null clears the key); restores the
        // previous name if the write can't land.
        syncPreferenceDelta(
          () => clearDisplayNamePref(sessionPath, now),
          () => set((state) => commitMeta(state, key, () => prev ? { ...prev, legacyKey: prev.legacyKey ?? sessionPath } : undefined)),
        );
      },

      initPreferences: async () => {
        try {
          const serverPrefs = await getPreferences();
          // Adopt the server's v2 keyed model (sessionMeta) as the single source
          // of truth; the path-based fields are derived from it. localStorage is a
          // pure read-cache (never merged back) — the one rule that removes the
          // whole "stale local resurrection" class across all three fields. The
          // "archived must not consume a pin slot" invariant is enforced purely
          // in-memory here (no write-back "pump").
          const meta: Record<string, SessionMeta> = {
            ...((serverPrefs.sessions as Record<string, SessionMeta> | undefined) ?? {}),
          };
          for (const rec of Object.values(meta)) {
            if (rec.archived) delete rec.pinned;
          }
          set({ sessionMeta: meta, ...deriveLegacyFromMeta(meta) });
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
            currentSessionSdkType: s.sessions.find((session) => session.id === sessionId)?.sdkType ?? null,
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
      setSwitchingSession: (isSwitching, sessionId = null) => set({ 
        isSwitchingSession: isSwitching, 
        switchingToSessionId: isSwitching ? sessionId : null 
      }),
      setError: (error) => set({ error }),
      markTransferReady: (sessionId) => {
        if (!sessionId.trim()) return;
        set((state) => ({
          transferReadySessionIds: {
            ...state.transferReadySessionIds,
            [sessionId]: true,
          },
        }));
      },
      clearTransferReady: (sessionId) => set((state) => {
        if (!state.transferReadySessionIds[sessionId]) return state;
        const transferReadySessionIds = { ...state.transferReadySessionIds };
        delete transferReadySessionIds[sessionId];
        return { transferReadySessionIds };
      }),
      isTransferReady: (sessionId) => Boolean(get().transferReadySessionIds[sessionId]),

      clearMessages: () => set({ messages: [] }),

      handleServerMessage: (message: unknown) => {
        if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') {
          recordProtocolDrift('malformed');
          return;
        }
        const msg = message as { type: string; [key: string]: unknown };
        recordBrowserDiagnostic({
          kind: 'message',
          messageType: msg.type,
          runtime: typeof msg.runtime === 'string' ? msg.runtime : undefined,
        });

        switch (msg.type) {
          case 'sessions_list': {
            // Deduplicate sessions by path (path is the stable identifier)
            const rawSessions = (msg.sessions as Array<Session & { sdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity' }>) || [];
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
                // Preserve sdkType if the server sends it
                sdkType: session.sdkType ?? undefined,
              }));
            set({ sessions: dedupedSessions, isLoadingSessions: false });
            break;
          }

          case 'session_created': {
            const createdMsg = msg as unknown as { sessionId: string; sessionPath: string; sdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity'; model?: string; thinkingLevel?: string };
            set({ 
              currentSessionId: createdMsg.sessionId,
              currentSessionSdkType: createdMsg.sdkType ?? null,
              // Reset model/thinkingLevel to the server-provided values (or null)
              // so stale state from a previous session doesn't carry over and
              // give a false impression of the active model.
              currentModel: createdMsg.model ?? null,
              currentThinkingLevel: createdMsg.thinkingLevel ?? null,
              messages: [], // Clear messages for new session
              contextPercent: 0,
              contextUsed: 0,
              contextWindow: 0,
              sessionInfo: null,
              isLoading: false,
              isSwitchingSession: false,
              switchingToSessionId: null,
            });
            // Clear any cached messages for this session
            set((state) => {
              const newSessionMessages = { ...state.sessionMessages };
              const newSessionCacheMeta = { ...state.sessionCacheMeta };
              const newCache = new Map(state.sessionCache);
              delete newSessionMessages[createdMsg.sessionId];
              delete newSessionCacheMeta[createdMsg.sessionId];
              newCache.delete(createdMsg.sessionId);
              // Add or update the newly-created session entry immediately so UI can reflect sdkType
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
              return { 
                sessions: updatedSessions,
                sessionMessages: newSessionMessages,
                sessionCacheMeta: newSessionCacheMeta,
                sessionCache: newCache,
              };
            });
            break;
          }

          case 'session_switched': {
            const switchMsg = msg as unknown as {
              sessionId: string;
              sdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity';
              model?: string;
              thinkingLevel?: string;
              contextWindow?: number;
              contextUsed?: number;
              contextPercent?: number;
              messages?: Array<{
                id: string;
                role: 'user' | 'assistant' | 'tool';
                content: string | ContentPart[];
                timestamp: number;
                toolCall?: Message['toolCall'];
                toolResult?: Message['toolResult'];
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
              ...(serverMsg.toolCall ? { toolCall: serverMsg.toolCall } : {}),
              ...(serverMsg.toolResult ? { toolResult: serverMsg.toolResult } : {}),
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
                extensionWidgets: state.sessionExtensionWidgets[switchMsg.sessionId] ?? {},
                extensionStatuses: state.sessionExtensionStatuses[switchMsg.sessionId] ?? {},
                currentThinkingLevel: switchMsg.thinkingLevel ?? null,
                messages: clientMessages,
                contextPercent: switchMsg.contextPercent ?? 0,
                contextUsed: switchMsg.contextUsed ?? 0,
                contextWindow: switchMsg.contextWindow ?? 0,
                contextUsageEstimated: false,
                sessions: updatedSessions,
                sessionMessages: newSessionMessages,
                sessionCacheMeta: newSessionCacheMeta,
                sessionCache: newCache,
                // If server says streaming, trust it
                isStreaming: serverIsStreaming,
                // Clear switching state when session is loaded
                isSwitchingSession: false,
                switchingToSessionId: null,
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
                lastStreamEventAt: Date.now(),
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
              const newMessages = state.messages.map((m) => {
                if (m.role === 'tool' && m.toolCall && !m.toolResult) {
                  return { ...m, toolResult: { output: 'Tool completed', isError: false } };
                }
                return m;
              });
              return { 
                isStreaming: false,
                lastStreamEventAt: null,
                streamingSessions: newStreamingSessions,
                sessionCacheMeta: newSessionCacheMeta,
                messages: newMessages,
              };
            });
            break;

          case 'message_start': {
            const messageData = (msg.message as { id: string; role: string; content: unknown }) || {};
            const newMessage: Message = {
              id: messageData.id || `msg_${Date.now()}`,
              role: messageData.role as 'user' | 'assistant' | 'tool',
              content: (messageData.content as Message['content']) ?? [],
              timestamp: Date.now(),
            };
            get().addMessage(newMessage);
            break;
          }

          case 'message_update': {
            set({ lastStreamEventAt: Date.now() });
            // Update streaming content
            const { message: msgData, assistantMessageEvent } = msg as {
              message?: { id: string; content?: Message['content'] };
              assistantMessageEvent?: { type: string; delta?: string };
            };
            
            if (msgData?.id && assistantMessageEvent) {
              const existingMsg = get().messages.find(m => m.id === msgData.id);
              if (existingMsg) {
                // Get existing content array or create new one
                let contentArray: ContentPart[];
                if (Array.isArray(existingMsg.content)) {
                  contentArray = [...existingMsg.content];
                } else if (typeof existingMsg.content === 'string') {
                  contentArray = existingMsg.content ? [{ type: 'text' as const, text: existingMsg.content }] : [];
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
                    contentArray.push({ type: 'text' as const, text: delta });
                  }
                  get().updateMessage(msgData.id, { content: contentArray });
                }
                // Handle thinking content (thinking_delta)
                else if (eventType === 'thinking_delta') {
                  const lastEntry = contentArray[contentArray.length - 1];
                  if (lastEntry && lastEntry.type === 'thinking') {
                    lastEntry.thinking = (lastEntry.thinking || '') + delta;
                  } else {
                    contentArray.push({ type: 'thinking' as const, thinking: delta });
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
            set({ lastStreamEventAt: Date.now() });
            const { toolCallId, toolName, args } = msg as unknown as {
              toolCallId: string;
              toolName: string;
              args: unknown;
            };
            if (toolName) {
              set({ currentToolName: toolName });
            }
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
            set({ lastStreamEventAt: Date.now() });
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
            set({ lastStreamEventAt: Date.now() });
            const { toolCallId, result, isError, resultSummary } = msg as unknown as {
              toolCallId: string;
              result?: unknown;
              isError: boolean;
              resultSummary?: SubagentToolSummary;
            };
            const content = extractToolResultText(result);
            get().updateMessage(toolCallId, {
              content,
              toolResult: { output: content, isError, summary: resultSummary },
            });
            break;
          }

          case 'error': {
            const errorMessage = (msg.message as string) || 'Unknown error';
            const errorCode = (msg as { code?: string }).code;
            // Late-answer notice: a non-blocking toast only. The AskUserQuestion
            // dialog already closed; don't disrupt streaming or show an error
            // banner — just tell the user their answer wasn't delivered.
            if (errorCode === 'ASK_ALREADY_CLOSED') {
              useUIStore.getState().addToast({ type: 'warning', message: errorMessage });
              break;
            }
            set({
              error: errorMessage,
              isStreaming: false,
              isLoading: false,
            });
            if (errorCode === 'CLAUDE_AUTH_EXPIRED') {
              useUIStore.getState().addToast({
                type: 'error',
                message: (msg.message as string) || REAUTH_FALLBACK_MESSAGE,
              });
            }
            break;
          }

          case 'session_update': {
            // Skip session_update events during initial load to prevent duplicates
            if (get().isLoadingSessions) {
              break;
            }
            
            const { type, sessionId, info } = msg as {
              type: 'add' | 'change' | 'unlink';
              sessionId: string;
              info?: Session;
            };
            
            if (type === 'unlink') {
              // Remove deleted session (use path for matching)
              set((state) => {
                const transferReadySessionIds = { ...state.transferReadySessionIds };
                delete transferReadySessionIds[sessionId];
                if (info?.id) delete transferReadySessionIds[info.id];
                return {
                  sessions: state.sessions.filter((s) => s.path !== info?.path && s.id !== sessionId),
                  transferReadySessionIds,
                };
              });
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
            const req = { ...(msg.request as ExtensionUIRequest), receivedAt: Date.now() };
            set({ extensionUIRequest: req });
            break;
          }

          case 'extension_ui_cancel': {
            // A pending AskUserQuestion closed for a non-answer reason. If it is
            // the currently-open dialog, mark it expired (keep it so the user's
            // draft is preserved) rather than clearing it outright.
            const cancel = (msg as { request?: { id?: string; reason?: string } }).request;
            const current = get().extensionUIRequest;
            if (cancel?.id && current?.id === cancel.id) {
              set({
                extensionUIRequest: {
                  ...current,
                  expired: true,
                  expiredReason: cancel.reason,
                },
              });
            }
            break;
          }

          case 'widget_content': {
            const widgetMsg = msg as unknown as { sessionId?: string; key?: string; content?: unknown };
            const key = widgetMsg.key;
            const content = widgetMsg.content;
            const targetSessionId = widgetMsg.sessionId ?? get().currentSessionId;
            if (key && Array.isArray(content) && targetSessionId) {
              const lines = content.map(String);
              set((state) => {
                const currentSessionWidgets = state.sessionExtensionWidgets[targetSessionId] ?? {};
                const nextSessionWidgets = {
                  ...state.sessionExtensionWidgets,
                  [targetSessionId]: {
                    ...currentSessionWidgets,
                    [key]: lines,
                  },
                };
                return {
                  sessionExtensionWidgets: nextSessionWidgets,
                  extensionWidgets: targetSessionId === state.currentSessionId
                    ? nextSessionWidgets[targetSessionId]
                    : state.extensionWidgets,
                };
              });
            }
            break;
          }

          case 'widget_cleared': {
            const widgetMsg = msg as unknown as { sessionId?: string; key: string };
            const targetSessionId = widgetMsg.sessionId ?? get().currentSessionId;
            if (widgetMsg.key && targetSessionId) {
              set((state) => {
                const currentSessionWidgets = { ...(state.sessionExtensionWidgets[targetSessionId] ?? {}) };
                delete currentSessionWidgets[widgetMsg.key];
                const nextSessionWidgets = {
                  ...state.sessionExtensionWidgets,
                  [targetSessionId]: currentSessionWidgets,
                };
                return {
                  sessionExtensionWidgets: nextSessionWidgets,
                  extensionWidgets: targetSessionId === state.currentSessionId
                    ? currentSessionWidgets
                    : state.extensionWidgets,
                };
              });
            }
            break;
          }

          case 'extension_status': {
            const statusMsg = msg as unknown as { sessionId?: string; status?: { key?: string; text?: string } };
            const key = statusMsg.status?.key;
            const targetSessionId = statusMsg.sessionId ?? get().currentSessionId;
            if (key && targetSessionId) {
              set((state) => {
                const currentSessionStatuses = { ...(state.sessionExtensionStatuses[targetSessionId] ?? {}) };
                if (statusMsg.status?.text === undefined) {
                  delete currentSessionStatuses[key];
                } else {
                  currentSessionStatuses[key] = statusMsg.status.text;
                }
                const nextSessionStatuses = {
                  ...state.sessionExtensionStatuses,
                  [targetSessionId]: currentSessionStatuses,
                };
                return {
                  sessionExtensionStatuses: nextSessionStatuses,
                  extensionStatuses: targetSessionId === state.currentSessionId
                    ? currentSessionStatuses
                    : state.extensionStatuses,
                };
              });
            }
            break;
          }

          case 'notification': {
            const { notification, sessionId } = msg as unknown as {
              sessionId?: string;
              notification: { message: string; type: 'info' | 'warning' | 'error' };
            };
            if (sessionId && sessionId !== get().currentSessionId) {
              break;
            }
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

          case 'thinking_level_changed': {
            const level = msg.level as string;
            set({ currentThinkingLevel: level });
            useUIStore.getState().addToast({
              type: 'success',
              message: `Thinking level set to ${level}`,
            });
            break;
          }

          case 'session_info': {
            const { stats } = msg as unknown as { stats: SessionStats };
            const isCurrentSession = stats.sessionId === get().currentSessionId;
            set({
              sessionInfo: stats,
              ...(isCurrentSession ? {
                contextWindow: stats.contextWindow ?? get().contextWindow,
                contextUsed: stats.contextUsed ?? 0,
                contextPercent: stats.contextPercent ?? 0,
                contextUsageEstimated: false,
              } : {}),
            });
            
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
            const { contextWindow, contextUsed, contextPercent } = msg as unknown as {
              contextWindow?: number;
              contextUsed?: number;
              contextPercent?: number;
            };
            // The SDK's compaction_end event is the canonical UI surface. This
            // browser-native response only supplies a fallback context update.
            set({
              isCompacting: false,
              compactionReason: null,
              contextWindow: contextWindow ?? get().contextWindow,
              contextUsed: contextUsed ?? get().contextUsed,
              contextPercent: contextPercent ?? get().contextPercent,
              contextUsageEstimated: contextUsed === undefined && contextPercent === undefined
                ? get().contextUsageEstimated
                : false,
            });
            if (get().sessionInfo) {
              set({
                sessionInfo: {
                  ...get().sessionInfo!,
                  contextWindow: contextWindow ?? get().sessionInfo!.contextWindow,
                  contextUsed: contextUsed ?? get().sessionInfo!.contextUsed,
                  contextPercent: contextPercent ?? get().sessionInfo!.contextPercent,
                  contextUsageEstimated: contextUsed === undefined && contextPercent === undefined
                    ? get().sessionInfo!.contextUsageEstimated
                    : false,
                }
              });
            }
            break;
          }

          case 'context_update': {
            const ctxMsg = msg as unknown as {
              sessionId: string;
              contextWindow?: number;
              contextUsed?: number;
              contextPercent?: number;
            };
            if (get().currentSessionId === ctxMsg.sessionId) {
              set({
                contextWindow: ctxMsg.contextWindow ?? get().contextWindow,
                contextUsed: ctxMsg.contextUsed ?? get().contextUsed,
                contextPercent: ctxMsg.contextPercent ?? get().contextPercent,
                contextUsageEstimated: false,
              });
              if (get().sessionInfo) {
                set({
                  sessionInfo: {
                    ...get().sessionInfo!,
                    contextWindow: ctxMsg.contextWindow ?? get().sessionInfo!.contextWindow,
                    contextUsed: ctxMsg.contextUsed ?? get().sessionInfo!.contextUsed,
                    contextPercent: ctxMsg.contextPercent ?? get().sessionInfo!.contextPercent,
                    contextUsageEstimated: false,
                  },
                });
              }
            }
            break;
          }

          case 'compaction_start':
          case 'auto_compaction_start': {
            const { reason } = msg as unknown as { reason: string };
            const automatic = reason !== 'manual';
            // The previous percentage belongs to the pre-compaction context.
            // Hide it while Pi is summarising rather than presenting it as live.
            set({
              isCompacting: true,
              compactionReason: reason,
              contextUsed: 0,
              contextPercent: 0,
              contextUsageEstimated: false,
            });
            if (get().sessionInfo) {
              set({
                sessionInfo: {
                  ...get().sessionInfo!,
                  contextUsed: undefined,
                  contextPercent: undefined,
                  contextUsageEstimated: false,
                },
              });
            }
            useUIStore.getState().addToast({
              type: 'info',
              message: automatic ? `Auto-compacting context: ${reason}` : 'Compacting context...',
            });
            break;
          }

          case 'compaction_end':
          case 'auto_compaction_end': {
            const { result, reason, aborted, willRetry, errorMessage } = msg as unknown as {
              result?: { estimatedTokensAfter?: number };
              reason?: string;
              aborted: boolean;
              willRetry: boolean;
              errorMessage?: string;
            };
            const estimatedTokens = result?.estimatedTokensAfter;
            const contextWindow = get().contextWindow || get().sessionInfo?.contextWindow || 0;
            const estimatedPercent = typeof estimatedTokens === 'number' && contextWindow > 0
              ? Math.round((estimatedTokens / contextWindow) * 100)
              : undefined;
            const automatic = reason !== 'manual';
            set({
              isCompacting: false,
              compactionReason: null,
              ...(estimatedPercent !== undefined ? {
                contextUsed: estimatedTokens!,
                contextPercent: estimatedPercent,
                contextUsageEstimated: true,
              } : {}),
            });
            if (get().sessionInfo && estimatedPercent !== undefined) {
              set({
                sessionInfo: {
                  ...get().sessionInfo!,
                  contextUsed: estimatedTokens,
                  contextPercent: estimatedPercent,
                  contextUsageEstimated: true,
                },
              });
            }

            if (aborted) {
              useUIStore.getState().addToast({
                type: willRetry ? 'info' : 'warning',
                message: willRetry ? 'Compaction aborted, will retry...' : 'Compaction aborted.',
              });
            } else if (errorMessage) {
              useUIStore.getState().addToast({
                type: 'error',
                message: `Compaction failed: ${errorMessage}`,
              });
            } else {
              useUIStore.getState().addToast({
                type: 'success',
                message: `${automatic ? 'Auto-compaction' : 'Compaction'} completed${estimatedPercent !== undefined ? ` — ${estimatedPercent}% estimated until the next response.` : '.'}`,
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
                if (get().currentSessionId === sessionId) {
                  set({ isStreaming: true, isLoading: false, lastStreamEventAt: Date.now(), promptStartedAt: Date.now(), currentToolName: null });
                }
                break;

              // Liveness ping from the Claude channel PTY: keeps the heartbeat
              // fresh while Claude is working but not emitting other events.
              case 'stream_activity':
                if (get().currentSessionId === sessionId && get().isStreaming) {
                  const toolName = (event as Record<string, unknown>).currentToolName as string | undefined;
                  set({ lastStreamEventAt: Date.now(), currentToolName: toolName || get().currentToolName });
                }
                break;

              case 'agent_end':
                get().setSessionStatus(sessionId, 'idle');
                currentMessageIdBySession.delete(sessionId);
                if (get().currentSessionId === sessionId) {
                  const newMessages = get().messages.map((m) => {
                    if (m.role === 'tool' && m.toolCall && !m.toolResult) {
                      return { ...m, toolResult: { output: 'Tool completed', isError: false } };
                    }
                    return m;
                  });
                  set({ isStreaming: false, lastStreamEventAt: null, promptStartedAt: null, currentToolName: null, messages: newMessages });
                }
                break;
                
              case 'message_start': {
                const messageData = (event.message as { id: string; role: string; content: unknown }) || {};
                const newMessage: Message = {
                  id: messageData.id || `msg_${Date.now()}`,
                  role: messageData.role as 'user' | 'assistant' | 'tool',
                  content: (messageData.content as Message['content']) ?? [],
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
                      let contentArray: ContentPart[];
                      if (Array.isArray(existingMsg.content)) {
                        contentArray = [...existingMsg.content];
                      } else if (typeof existingMsg.content === 'string') {
                        contentArray = existingMsg.content ? [{ type: 'text' as const, text: existingMsg.content }] : [];
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
                          contentArray.push({ type: 'text' as const, text: delta });
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
                          contentArray.push({ type: 'thinking' as const, thinking: delta });
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
                const { toolCallId, result, isError, resultSummary } = event as unknown as {
                  toolCallId: string;
                  result?: unknown;
                  isError: boolean;
                  resultSummary?: SubagentToolSummary;
                };
                const content = extractToolResultText(result);
                get().updateMessageInSession(sessionId, toolCallId, {
                  content,
                  toolResult: { output: content, isError, summary: resultSummary },
                });
                // Also update current session if it matches
                if (get().currentSessionId === sessionId) {
                  get().updateMessage(toolCallId, {
                    content,
                    toolResult: { output: content, isError, summary: resultSummary },
                  });
                }
                break;
              }
              
              case 'compaction_start':
              case 'auto_compaction_start': {
                const { reason } = event as unknown as { reason: string };
                if (get().currentSessionId === sessionId) {
                  const automatic = reason !== 'manual';
                  // Pi reports the old usage until another assistant response
                  // completes. Do not leave that stale number visible.
                  set({
                    isCompacting: true,
                    compactionReason: reason,
                    contextUsed: 0,
                    contextPercent: 0,
                    contextUsageEstimated: false,
                  });
                  if (get().sessionInfo) {
                    set({
                      sessionInfo: {
                        ...get().sessionInfo!,
                        contextUsed: undefined,
                        contextPercent: undefined,
                        contextUsageEstimated: false,
                      },
                    });
                  }
                  useUIStore.getState().addToast({
                    type: 'info',
                    message: automatic ? `Auto-compacting context: ${reason}` : 'Compacting context...',
                  });
                }
                break;
              }
              
              case 'compaction_end':
              case 'auto_compaction_end': {
                const { result, reason, aborted, willRetry, errorMessage } = event as unknown as {
                  result?: { estimatedTokensAfter?: number };
                  reason?: string;
                  aborted: boolean;
                  willRetry: boolean;
                  errorMessage?: string;
                };
                if (get().currentSessionId === sessionId) {
                  const estimatedTokens = result?.estimatedTokensAfter;
                  const contextWindow = get().contextWindow || get().sessionInfo?.contextWindow || 0;
                  const estimatedPercent = typeof estimatedTokens === 'number' && contextWindow > 0
                    ? Math.round((estimatedTokens / contextWindow) * 100)
                    : undefined;
                  const automatic = reason !== 'manual';
                  set({
                    isCompacting: false,
                    compactionReason: null,
                    ...(estimatedPercent !== undefined ? {
                      contextUsed: estimatedTokens!,
                      contextPercent: estimatedPercent,
                      contextUsageEstimated: true,
                    } : {}),
                  });
                  if (get().sessionInfo && estimatedPercent !== undefined) {
                    set({
                      sessionInfo: {
                        ...get().sessionInfo!,
                        contextUsed: estimatedTokens,
                        contextPercent: estimatedPercent,
                        contextUsageEstimated: true,
                      },
                    });
                  }
                  if (aborted) {
                    useUIStore.getState().addToast({
                      type: willRetry ? 'info' : 'warning',
                      message: willRetry ? 'Compaction aborted, will retry...' : 'Compaction aborted.',
                    });
                  } else if (errorMessage) {
                    useUIStore.getState().addToast({
                      type: 'error',
                      message: `Compaction failed: ${errorMessage}`,
                    });
                  } else {
                    useUIStore.getState().addToast({
                      type: 'success',
                      message: `${automatic ? 'Auto-compaction' : 'Compaction'} completed${estimatedPercent !== undefined ? ` — ${estimatedPercent}% estimated until the next response.` : '.'}`,
                    });
                  }
                }
                break;
              }

              case 'api_error': {
                // API error (e.g. 429 rate limit) embedded in a message with stopReason='error'
                const apiErrorMsg = (event.message as string) || 'API error occurred';
                const provider = (event.provider as string) || '';
                const model = (event.model as string) || '';
                const detail = provider ? ` (${provider}${model ? '/' + model : ''})` : '';
                
                // Add error as a persistent message in the chat so it's visible on return
                const errorId = `api-error-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
                const errorMessage: Message = {
                  id: errorId,
                  role: 'assistant',
                  content: [],
                  timestamp: Date.now(),
                  error: { message: apiErrorMsg, provider: provider || undefined, model: model || undefined },
                };
                get().addMessageToSession(sessionId, errorMessage);
                if (get().currentSessionId === sessionId) {
                  get().addMessage(errorMessage);
                  useUIStore.getState().addToast({
                    type: 'error',
                    message: `API Error${detail}: ${apiErrorMsg}`,
                  });
                }
                break;
              }

              case 'error': {
                const errorMessage = (event.message as string) || 'Unknown error';
                const errorCode = (event as { code?: string }).code;
                get().setSessionStatus(sessionId, 'error');
                // Show toast and update global state if this is the current session
                if (get().currentSessionId === sessionId) {
                  set({
                    error: errorMessage,
                    isStreaming: false,
                    isLoading: false,
                  });
                  useUIStore.getState().addToast({
                    type: 'error',
                    message: errorCode === 'CLAUDE_AUTH_EXPIRED'
                      ? (errorMessage || REAUTH_FALLBACK_MESSAGE)
                      : errorMessage,
                  });
                }
                break;
              }

              case 'session_init': {
                // Claude session initialized — update model info if available
                const initData = event as unknown as { model?: string; tools?: string[] };
                if (initData.model) {
                  // Update the session's model field in the sessions list
                  set((state) => ({
                    sessions: state.sessions.map((s) =>
                      s.id === sessionId ? { ...s, model: initData.model } : s
                    ),
                  }));
                  // Also update sessionData
                  get().updateSessionData(sessionId, { model: initData.model });
                  // Update currentModel if this is the active session
                  if (get().currentSessionId === sessionId) {
                    set({ currentModel: initData.model });
                  }
                }
                break;
              }

              case 'stale_stream_reset': {
                // Server detected a stale streaming session and reset it to idle
                const staleMsg = (event.message as string) || 'Session reset from stale streaming state.';
                get().setSessionStatus(sessionId, 'idle');
                if (get().currentSessionId === sessionId) {
                  set({
                    isStreaming: false,
                    isLoading: false,
                    error: staleMsg,
                  });
                  useUIStore.getState().addToast({
                    type: 'warning',
                    message: staleMsg,
                  });
                }
                break;
              }

              case 'rate_limit': {
                // Claude quota / rate-limit info
                const rateLimitData = event as unknown as {
                  status: string;
                  rateLimitType: string;
                  isUsingOverage: boolean;
                  resetsAt?: number;
                };
                // Persist quota info in session data
                get().updateSessionData(sessionId, {
                  quotaInfo: {
                    status: rateLimitData.status,
                    rateLimitType: rateLimitData.rateLimitType,
                    isUsingOverage: rateLimitData.isUsingOverage,
                    resetsAt: rateLimitData.resetsAt,
                  },
                });
                // Show a warning toast if using paid overage on the active session
                if (rateLimitData.isUsingOverage && get().currentSessionId === sessionId) {
                  useUIStore.getState().addToast({
                    type: 'warning',
                    message: 'Claude session is using extra quota (overage)',
                  });
                }
                break;
              }

              case 'permission_request': {
                if (get().currentSessionId === sessionId) {
                  const permData = event as unknown as {
                    requestId: string;
                    toolName: string;
                    description: string;
                    args: unknown;
                  };
                  set({
                    extensionUIRequest: {
                      id: permData.requestId || `perm-${Date.now()}`,
                      type: 'confirm' as const,
                      method: `permission.${permData.toolName || 'tool'}`,
                      params: {
                        message: permData.description || `Allow ${permData.toolName}?`,
                        details: permData.args,
                      },
                      timeout: 120000,
                    },
                  });
                }
                break;
              }

              // OpenCode/Pi goal-engine extension UI events arrive wrapped in a
              // `session_event` envelope (the server runs them through
              // normEventToPiFormat, producing spread fields). Re-dispatch them
              // through the top-level handlers so the goal widget / live goal tag
              // update for OpenCode sessions, not just Pi. Without this they were
              // silently dropped and no goal tag ever appeared.
              case 'widget_content':
              case 'widget_cleared':
              case 'extension_status': {
                get().handleServerMessage({ ...event, sessionId });
                break;
              }

              case 'message': {
                // Raw JSONL entry replayed during history replay.
                // These arrive when the client reconnects and the server replays the session JSONL.
                // We only handle error entries (stopReason=error) to surface them visibly.
                const rawMsg = event as unknown as {
                  message?: {
                    id?: string;
                    role?: string;
                    content?: unknown;
                    stopReason?: string;
                    errorMessage?: string;
                    provider?: string;
                    model?: string;
                  };
                };
                const msgData = rawMsg.message;
                if (msgData?.stopReason === 'error' && msgData?.errorMessage) {
                  // Skip if we already have an error message with the same ID (dedup)
                  const existingMsgs = get().sessionMessages[sessionId] || [];
                  if (msgData.id && existingMsgs.some(m => m.id === msgData.id)) {
                    break;
                  }
                  const replayErrorId = msgData.id || `replay-error-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
                  const replayErrorMessage: Message = {
                    id: replayErrorId,
                    role: 'assistant',
                    content: [],
                    timestamp: Date.now(),
                    error: {
                      message: msgData.errorMessage,
                      provider: msgData.provider || undefined,
                      model: msgData.model || undefined,
                    },
                  };
                  get().addMessageToSession(sessionId, replayErrorMessage);
                  if (get().currentSessionId === sessionId) {
                    get().addMessage(replayErrorMessage);
                  }
                }
                break;
              }
            }
            break;
          }

          case 'history_start': {
            const histStartMsg = msg as unknown as { sessionId: string };
            // Clear existing messages for this session to prepare for replay
            get().clearSessionMessages(histStartMsg.sessionId);
            break;
          }

          case 'history_end': {
            const histEndMsg = msg as unknown as { sessionId: string };
            // Replay complete — set session to idle
            get().setSessionStatus(histEndMsg.sessionId, 'idle');
            // Also clear the global isStreaming flag if this is the current session.
            // Without this, the UI may stay stuck in streaming state after history
            // replay (e.g. after WebSocket reconnect / re-auth).
            if (get().currentSessionId === histEndMsg.sessionId) {
              set({ isStreaming: false, isLoading: false });
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

          case 'claude_available': {
            const claudeMsg = msg as unknown as { available: boolean; error?: string | null };
            get().setClaudeAvailable(claudeMsg.available, claudeMsg.error || null);
            break;
          }

          case 'opencode_available': {
            const ocMsg = msg as unknown as { available: boolean; error?: string | null };
            get().setOpencodeAvailable(ocMsg.available, ocMsg.error || null);
            break;
          }

          case 'antigravity_available': {
            const agMsg = msg as unknown as { available: boolean; error?: string | null };
            get().setAntigravityAvailable(agMsg.available, agMsg.error || null);
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
            
            // Update worker status in store
            get().updateWorkerStatus(workerSessionId, workerStatus);
            
            // Log worker status changes for debugging
            console.log(`[WorkerStatus] Session ${workerSessionId}: ${workerMsg.previousStatus || 'unknown'} -> ${workerStatus}`);
            
            // Handle error state
            if (workerStatus === 'error' && workerError) {
              console.error(`[sessionStore] Worker error for session ${workerSessionId}:`, workerError);
              // Show error toast if this is the current session
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
            
            // Handle terminated state - clean up
            if (workerStatus === 'terminated') {
              get().removeWorkerStatus(workerSessionId);
            }
            
            break;
          }

          case 'session_pinned': {
            const pinMsg = msg as unknown as { sessionPath: string; pinned: boolean };
            if (pinMsg.pinned) {
              get().pinSession(pinMsg.sessionPath);
            } else {
              get().unpinSession(pinMsg.sessionPath);
            }
            break;
          }

          case 'session_pin_error': {
            const pinErrMsg = msg as unknown as { sessionPath: string; error: string };
            console.warn(`[sessionStore] Pin error for ${pinErrMsg.sessionPath}: ${pinErrMsg.error}`);
            useUIStore.getState().addToast({
              type: 'error' as const,
              message: pinErrMsg.error,
            });
            break;
          }

          case 'session_transfer_completed': {
            const transferMsg = msg as unknown as {
              sourceSessionId?: unknown;
              targetSessionId?: unknown;
              createdNewSession?: unknown;
            };
            if (
              typeof transferMsg.sourceSessionId !== 'string' || !transferMsg.sourceSessionId.trim()
              || typeof transferMsg.targetSessionId !== 'string' || !transferMsg.targetSessionId.trim()
              || typeof transferMsg.createdNewSession !== 'boolean'
            ) {
              console.warn('[sessionStore] Ignoring malformed session_transfer_completed event');
              break;
            }
            console.log(`[sessionStore] Transfer completed: ${transferMsg.sourceSessionId} -> ${transferMsg.targetSessionId}`);
            get().markTransferReady(transferMsg.targetSessionId);
            useTransferStore.getState().setSucceeded(transferMsg.targetSessionId);
            useUIStore.getState().addToast({
              type: 'success' as const,
              message: TRANSFER_READY_MESSAGE,
            });
            break;
          }

          case 'session_transfer_failed': {
            const failMsg = msg as unknown as {
              sourceSessionId?: unknown;
              targetSessionId?: unknown;
              message?: unknown;
              code?: unknown;
            };
            if (
              typeof failMsg.sourceSessionId !== 'string' || !failMsg.sourceSessionId.trim()
              || typeof failMsg.message !== 'string' || !failMsg.message.trim()
              || typeof failMsg.code !== 'string' || !failMsg.code.trim()
              || (failMsg.targetSessionId !== undefined && typeof failMsg.targetSessionId !== 'string')
            ) {
              console.warn('[sessionStore] Ignoring malformed session_transfer_failed event');
              break;
            }
            console.warn(`[sessionStore] Transfer failed: ${failMsg.code} - ${failMsg.message}`);
            useTransferStore.getState().setFailed(failMsg.code, failMsg.message);
            break;
          }

          default:
            recordProtocolDrift('unknown', msg.type);
            break;
        }
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => throttledStorage),
      partialize: (state) => ({
        sessions: state.sessions,
        // sessionMeta is the v2 keyed source of truth; the three legacy fields
        // are derived from it but cached too so the offline read-cache is
        // immediately usable before the first GET resolves.
        sessionMeta: state.sessionMeta,
        archivedSessionPaths: state.archivedSessionPaths,
        pinnedSessionPaths: state.pinnedSessionPaths,
        sessionDisplayNames: state.sessionDisplayNames,
        // Note: sessionCacheMeta is intentionally NOT persisted.
        // It changes on every message event (messageCount, sizeBytes) and
        // would cause excessive localStorage writes during streaming.
        // It is rebuilt from cache on app startup — lossless.
      }),
    }
  )
);

function parseCrossTabSessionMeta(raw: string): Record<string, SessionMeta> | null {
  try {
    const parsed = JSON.parse(raw) as { state?: { sessionMeta?: unknown } };
    const candidate = parsed.state?.sessionMeta;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;

    const result: Record<string, SessionMeta> = {};
    for (const [key, value] of Object.entries(candidate)) {
      if (!/^(?:pi|claude|opencode|antigravity|unknown):/.test(key)
        || !value || typeof value !== 'object' || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      if (record.archived !== undefined && record.archived !== true) return null;
      if (record.pinned !== undefined && record.pinned !== true) return null;
      if (record.displayName !== undefined && typeof record.displayName !== 'string') return null;
      if (record.legacyKey !== undefined && typeof record.legacyKey !== 'string') return null;
      if (record.updatedAt !== undefined
        && (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt))) return null;
      result[key] = record as SessionMeta;
    }
    return result;
  } catch (error) {
    recordStorageFailure('cross_tab_parse', error);
    return null;
  }
}

// Zustand persist hydrates the current tab, but browser storage events are the
// only notification for already-open sibling tabs. Merge only the canonical
// metadata slice by its server-compatible updatedAt clock; session lists remain
// owned by each tab's WebSocket. A resulting persist write is deduplicated by
// throttledStorage, preventing cross-tab echo loops.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || event.newValue === null) return;
    if (event.storageArea && event.storageArea !== localStorage) return;
    throttleCommittedValue = event.newValue;

    const incoming = parseCrossTabSessionMeta(event.newValue);
    if (!incoming) return;
    const current = useSessionStore.getState().sessionMeta;
    const merged = { ...current };
    let changed = false;
    for (const [key, record] of Object.entries(incoming)) {
      const existing = current[key];
      if (!existing || (record.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
        if (existing !== record && JSON.stringify(existing) !== JSON.stringify(record)) {
          merged[key] = record;
          changed = true;
        }
      }
    }
    if (changed) {
      useSessionStore.setState({ sessionMeta: merged, ...deriveLegacyFromMeta(merged) });
    }
  });
}
