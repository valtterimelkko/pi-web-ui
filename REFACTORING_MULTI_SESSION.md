# Refactoring Plan: Multi-Session Background Support

## Executive Summary

**Goal:** Enable users to work on multiple sessions simultaneously, with real-time visibility into each session's state and progress. Users should be able to:
- See live streaming updates for all active sessions
- Navigate between sessions without interrupting ongoing operations
- Know the exact state of each session (idle, streaming, error, etc.)
- Preserve draft input when switching sessions

**Effort Estimate:** 3-5 days of focused development

**Risk Level:** Medium - Changes core WebSocket and session management architecture

---

## Current Architecture Analysis

### Server-Side (Current)

```
┌─────────────────────────────────────────────────────────────────┐
│  WebSocketConnectionManager                                      │
│                                                                 │
│  clients: Map<clientId, WebSocketClient>                        │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ SessionPool                                               │   │
│  │                                                           │   │
│  │ clientSessions: Map<clientId, ClientSession>            │   │
│  │                                                           │   │
│  │ Problem: ONE session per client at a time               │   │
│  │                                                           │   │
│  │ When client switches sessions:                           │   │
│  │   1. existing.session.dispose()  ← Kills the session    │   │
│  │   2. create new session for same file                   │   │
│  │   3. Old session's events are lost                      │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Current Flow:**
```
User switches from Session A to Session B:
1. Server receives switch_session request
2. Server disposes Session A's AgentSession
3. Server creates new AgentSession for Session B
4. Session A stops streaming (disposed!)
5. User sees Session B content
6. If user switches back to A, it's recreated from file (may be stale)
```

### Client-Side (Current)

```
┌─────────────────────────────────────────────────────────────────┐
│  sessionStore (Zustand)                                         │
│                                                                 │
│  currentSessionId: string | null        ← Single active ID     │
│  messages: Message[]                     ← Current session only │
│  isStreaming: boolean                    ← Current session only │
│                                                                 │
│  sessionMessages: Record<sessionId, Message[]>  ← Cache only   │
│  streamingSessions: Record<sessionId, boolean>  ← Not live     │
│                                                                 │
│  Problem: No real-time updates for non-active sessions          │
│  Problem: Draft input is lost on session switch                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Target Architecture

### Server-Side (Target)

```
┌─────────────────────────────────────────────────────────────────┐
│  WebSocketConnectionManager                                      │
│                                                                 │
│  clients: Map<clientId, WebSocketClient>                        │
│  sessionManager: MultiSessionManager  ← NEW                     │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ MultiSessionManager (NEW)                                │   │
│  │                                                           │   │
│  │ sessions: Map<sessionPath, ActiveSession>               │   │
│  │ clientSubscriptions: Map<clientId, Set<sessionPath>>    │   │
│  │                                                           │   │
│  │ ActiveSession {                                          │   │
│  │   sessionPath: string                                    │   │
│  │   agentSession: AgentSession                             │   │
│  │   status: 'idle' | 'busy' | 'error'                     │   │
│  │   subscribers: Set<clientId>                             │   │
│  │   lastActivity: Date                                     │   │
│  │ }                                                         │   │
│  │                                                           │   │
│  │ Key: Sessions persist even when no client is viewing     │   │
│  │ Key: Multiple clients can subscribe to same session      │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Target Flow:**
```
User switches from Session A to Session B:
1. Server receives switch_session request
2. Server unsubscribes client from Session A events
3. Server subscribes client to Session B events
4. Session A CONTINUES streaming (not disposed!)
5. Session A events are still broadcast to ANY clients watching A
6. User sees Session B content
7. If user switches back to A, they see live content (not stale)
```

### Client-Side (Target)

```
┌─────────────────────────────────────────────────────────────────┐
│  sessionStore (Zustand)                                         │
│                                                                 │
│  currentSessionId: string | null        ← Currently viewed     │
│                                                                 │
│  // Per-session state (all live)                                │
│  sessionData: Record<sessionId, {                              │
│    messages: Message[]                                           │
│    status: 'idle' | 'busy' | 'streaming' | 'error'             │
│    lastEventTimestamp: number                                   │
│    contextPercent: number                                       │
│    currentStep: number                                          │
│  }>                                                              │
│                                                                 │
│  // Global draft input (persists across switches)               │
│  (moved to separate draftStore)                                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  draftStore (NEW - Zustand)                                     │
│                                                                 │
│  // Global draft per session                                    │
│  drafts: Record<sessionId, string>                             │
│                                                                 │
│  setDraft(sessionId, text): void                               │
│  getDraft(sessionId): string                                   │
│  clearDraft(sessionId): void                                   │
│  sendDraft(sessionId): void  ← Sends and clears                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Detailed Implementation Plan

### Phase 1: WebSocket Protocol Enhancement

**Goal:** Add session-scoped event routing and status broadcasts.

#### 1.1 New Server → Client Messages

```typescript
// Add to protocol.ts

// Broadcast when any session's state changes
interface SessionStatusBroadcast {
  type: 'session_status';
  sessionId: string;
  sessionPath: string;
  status: 'idle' | 'busy' | 'streaming' | 'error';
  lastActivity: string;
  // Quick stats for sidebar display
  messageCount: number;
  currentStep?: number;
}

// Wrap all events with sessionId for routing
interface SessionEvent {
  type: 'session_event';
  sessionId: string;
  event: AgentSessionEvent;  // The actual event
}

// Confirmation of subscription
interface SessionSubscribed {
  type: 'session_subscribed';
  sessionId: string;
  sessionPath: string;
  status: 'idle' | 'busy' | 'streaming' | 'error';
}

// Confirmation of unsubscription
interface SessionUnsubscribed {
  type: 'session_unsubscribed';
  sessionId: string;
}
```

#### 1.2 New Client → Server Messages

```typescript
// Add to protocol.ts

// Subscribe to a session's events (replaces switch_session for event routing)
interface SubscribeSession {
  type: 'subscribe_session';
  sessionPath: string;
}

// Unsubscribe from a session's events
interface UnsubscribeSession {
  type: 'unsubscribe_session';
  sessionPath: string;
}

// Subscribe to all sessions (for sidebar status updates)
interface SubscribeAllSessions {
  type: 'subscribe_all_sessions';
}
```

---

### Phase 2: Server-Side Multi-Session Manager

**Goal:** Keep sessions alive and broadcast events to all subscribers.

#### 2.1 Create MultiSessionManager Class

**File:** `server/src/pi/multi-session-manager.ts`

```typescript
interface ActiveSession {
  sessionPath: string;
  sessionId: string;
  agentSession: AgentSession;
  status: 'idle' | 'busy' | 'streaming' | 'error';
  subscribers: Set<string>;  // clientIds
  lastActivity: Date;
  messageCount: number;
  currentStep: number;
}

export class MultiSessionManager {
  private sessions: Map<string, ActiveSession> = new Map();  // sessionPath → ActiveSession
  private clientSubscriptions: Map<string, Set<string>> = new Map();  // clientId → Set<sessionPath>
  private piService: PiService;
  private broadcastFn: (clientId: string, message: unknown) => void;
  
  // Key methods:
  async subscribeClient(clientId: string, sessionPath: string): Promise<ActiveSession>
  unsubscribeClient(clientId: string, sessionPath: string): void
  broadcastToSubscribers(sessionPath: string, message: unknown): void
  getSessionStatus(sessionPath: string): SessionStatus | undefined
  cleanupInactiveSessions(maxAgeMs: number): void
}
```

#### 2.2 Session Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│  SESSION LIFECYCLE                                              │
│                                                                 │
│  1. Client subscribes to session                                │
│     └─→ If session exists: add client to subscribers           │
│     └─→ If not: create session, add client                     │
│                                                                 │
│  2. Agent processes prompt                                      │
│     └─→ Events broadcast to ALL subscribers                    │
│     └─→ Status updates broadcast to ALL clients                │
│                                                                 │
│  3. Client unsubscribes (switches away)                         │
│     └─→ Remove client from subscribers                          │
│     └─→ Session STAYS ALIVE if other subscribers               │
│     └─→ Session STAYS ALIVE if agent is busy                   │
│                                                                 │
│  4. Cleanup (periodic)                                          │
│     └─→ Dispose sessions with no subscribers AND idle          │
│     └─→ Dispose sessions older than maxAge                      │
└─────────────────────────────────────────────────────────────────┘
```

#### 2.3 Update WebSocketConnectionManager

**File:** `server/src/websocket/connection.ts`

Changes:
- Replace `SessionPool` with `MultiSessionManager`
- Add `subscribe_session` and `unsubscribe_session` handlers
- Modify `switch_session` to use subscription model
- Add periodic cleanup for inactive sessions
- Broadcast session status changes to ALL connected clients

---

### Phase 3: Client-Side Session Data Store

**Goal:** Store live data for ALL sessions, not just current.

#### 3.1 Update sessionStore Structure

**File:** `client/src/store/sessionStore.ts`

```typescript
interface SessionData {
  messages: Message[];
  status: 'idle' | 'busy' | 'streaming' | 'error';
  lastEventTimestamp: number;
  contextPercent: number;
  currentStep: number;
  model: string | null;
}

interface SessionState {
  // Current view
  currentSessionId: string | null;
  
  // Live data for ALL sessions
  sessionData: Record<string, SessionData>;
  
  // Session list (for sidebar)
  sessions: Session[];
  
  // Computed: current session's data
  currentSessionData: SessionData | null;
  
  // Actions
  updateSessionData: (sessionId: string, updates: Partial<SessionData>) => void;
  addMessageToSession: (sessionId: string, message: Message) => void;
  updateMessageInSession: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  setSessionStatus: (sessionId: string, status: SessionData['status']) => void;
}
```

#### 3.2 Update WebSocket Event Handler

**File:** `client/src/store/sessionStore.ts`

```typescript
handleServerMessage: (message: unknown) => {
  const msg = message as { type: string; [key: string]: unknown };

  switch (msg.type) {
    case 'session_event': {
      // Route event to correct session
      const { sessionId, event } = msg as SessionEventMessage;
      handleSessionEvent(sessionId, event);
      break;
    }
    
    case 'session_status': {
      // Update session status in store
      const { sessionId, status, ...rest } = msg as SessionStatusBroadcast;
      updateSessionData(sessionId, { status, ...rest });
      break;
    }
    
    // ... other handlers
  }
}

handleSessionEvent = (sessionId: string, event: AgentSessionEvent) => {
  // All events now include sessionId for routing
  switch (event.type) {
    case 'agent_start':
      setSessionStatus(sessionId, 'streaming');
      break;
      
    case 'agent_end':
      setSessionStatus(sessionId, 'idle');
      break;
      
    case 'message_start':
      addMessageToSession(sessionId, event.message);
      break;
      
    case 'message_update':
      updateMessageInSession(sessionId, event.message.id, event.updates);
      break;
      
    // ... etc
  }
}
```

---

### Phase 4: Draft Input Persistence

**Goal:** Preserve draft input when switching sessions.

#### 4.1 Create Draft Store

**File:** `client/src/store/draftStore.ts`

```typescript
interface DraftState {
  // Draft input per session
  drafts: Record<string, string>;
  
  // Currently focused session's draft (for quick access)
  currentDraft: string;
  
  // Actions
  setDraft: (sessionId: string, text: string) => void;
  getDraft: (sessionId: string) => string;
  clearDraft: (sessionId: string) => void;
  sendDraft: (sessionId: string) => Promise<void>;
  
  // Sync current draft when switching sessions
  syncCurrentDraft: () => void;
}

export const useDraftStore = create<DraftState>()(
  persist(
    (set, get) => ({
      drafts: {},
      currentDraft: '',
      
      setDraft: (sessionId, text) => {
        set((state) => ({
          drafts: { ...state.drafts, [sessionId]: text },
          currentDraft: sessionId === useSessionStore.getState().currentSessionId 
            ? text 
            : state.currentDraft,
        }));
      },
      
      getDraft: (sessionId) => {
        return get().drafts[sessionId] || '';
      },
      
      clearDraft: (sessionId) => {
        set((state) => {
          const newDrafts = { ...state.drafts };
          delete newDrafts[sessionId];
          return { drafts: newDrafts };
        });
      },
      
      syncCurrentDraft: () => {
        const sessionId = useSessionStore.getState().currentSessionId;
        if (sessionId) {
          const draft = get().drafts[sessionId] || '';
          set({ currentDraft: draft });
        }
      },
      
      // ... other methods
    }),
    { name: 'pi-web-ui-drafts' }
  )
);
```

#### 4.2 Update MessageInput Component

**File:** `client/src/components/Chat/MessageInput.tsx`

```typescript
export function MessageInput({ disabled, onOpenSettings }: MessageInputProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentDraft = useDraftStore((state) => state.currentDraft);
  const setDraft = useDraftStore((state) => state.setDraft);
  const syncCurrentDraft = useDraftStore((state) => state.syncCurrentDraft);
  
  // Sync draft when session changes
  useEffect(() => {
    syncCurrentDraft();
  }, [currentSessionId, syncCurrentDraft]);
  
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (currentSessionId) {
      setDraft(currentSessionId, value);
    }
    // ... rest
  };
  
  // ... rest of component
}
```

---

### Phase 5: Activity Status Indicator

**Goal:** Show accurate status for each session in sidebar.

#### 5.1 Create Activity Status Component

**File:** `client/src/components/Sidebar/SessionStatusIndicator.tsx`

```typescript
interface SessionStatusIndicatorProps {
  sessionId: string;
}

export function SessionStatusIndicator({ sessionId }: SessionStatusIndicatorProps) {
  const sessionData = useSessionStore((state) => state.sessionData[sessionId]);
  
  if (!sessionData) return null;
  
  const { status, currentStep } = sessionData;
  
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn(
        "w-1.5 h-1.5 rounded-full",
        status === 'streaming' && "bg-amber-400 animate-pulse",
        status === 'busy' && "bg-blue-400 animate-pulse",
        status === 'idle' && "bg-emerald-400",
        status === 'error' && "bg-red-400"
      )} />
      <span className="text-xs text-gray-500">
        {status === 'streaming' && `Step ${currentStep}...`}
        {status === 'busy' && 'Working...'}
        {status === 'idle' && 'Ready'}
        {status === 'error' && 'Error'}
      </span>
    </div>
  );
}
```

#### 5.2 Update Sidebar Session Items

**File:** `client/src/components/Sidebar/SessionItem.tsx`

```typescript
export function SessionItem({ session, isActive, isArchived }: SessionItemProps) {
  // ... existing code
  
  return (
    <div className={...}>
      <p className="text-sm text-gray-900 truncate flex-1">
        {displayName}
      </p>
      
      {/* Show live status instead of time when streaming */}
      {sessionData?.status === 'streaming' || sessionData?.status === 'busy' ? (
        <SessionStatusIndicator sessionId={session.id} />
      ) : (
        <span className="text-[11px] text-gray-400">
          {getRelativeTime(session.lastActivity)}
        </span>
      )}
    </div>
  );
}
```

---

### Phase 6: Cleanup and Maintenance

**Goal:** Prevent memory leaks from accumulated sessions.

#### 6.1 Server-Side Cleanup

```typescript
// In MultiSessionManager
cleanupInactiveSessions(maxAgeMs: number = 30 * 60 * 1000): void {
  const now = Date.now();
  
  for (const [sessionPath, activeSession] of this.sessions.entries()) {
    const hasSubscribers = activeSession.subscribers.size > 0;
    const isIdle = activeSession.status === 'idle';
    const isOld = now - activeSession.lastActivity.getTime() > maxAgeMs;
    
    if (!hasSubscribers && isIdle && isOld) {
      console.log(`[MultiSessionManager] Cleaning up inactive session: ${sessionPath}`);
      activeSession.agentSession.dispose();
      this.sessions.delete(sessionPath);
    }
  }
}

// Start cleanup interval in constructor
constructor() {
  // Run cleanup every 5 minutes
  setInterval(() => this.cleanupInactiveSessions(), 5 * 60 * 1000);
}
```

#### 6.2 Client-Side Cleanup

```typescript
// In sessionStore
cleanupStaleSessionData(maxSessions: number = 50): void {
  const sessionIds = Object.keys(get().sessionData);
  
  if (sessionIds.length > maxSessions) {
    // Remove oldest sessions (by lastEventTimestamp)
    const sorted = sessionIds.sort((a, b) => 
      (get().sessionData[b]?.lastEventTimestamp || 0) - 
      (get().sessionData[a]?.lastEventTimestamp || 0)
    );
    
    const toRemove = sorted.slice(maxSessions);
    set((state) => {
      const newSessionData = { ...state.sessionData };
      toRemove.forEach(id => delete newSessionData[id]);
      return { sessionData: newSessionData };
    });
  }
}
```

---

## File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `server/src/pi/multi-session-manager.ts` | Multi-session lifecycle management |
| `client/src/store/draftStore.ts` | Draft input persistence |
| `client/src/components/Sidebar/SessionStatusIndicator.tsx` | Live status badges |
| `server/tests/unit/pi/multi-session-manager.test.ts` | MultiSessionManager unit tests |
| `server/tests/unit/websocket/protocol.test.ts` | Protocol type tests |
| `server/tests/integration/websocket-multi-session.test.ts` | WebSocket integration tests |
| `client/tests/unit/store/draftStore.test.ts` | Draft store unit tests |
| `client/tests/unit/components/Sidebar/SessionStatusIndicator.test.tsx` | Status indicator tests |
| `client/tests/integration/multi-session.test.ts` | Client integration tests |
| `tests/e2e/multi-session.spec.ts` | Multi-session E2E tests |
| `tests/e2e/session-status.spec.ts` | Status indicator E2E tests |
| `tests/e2e/draft-persistence.spec.ts` | Draft persistence E2E tests |

### Modified Files

| File | Changes |
|------|---------|
| `server/src/websocket/protocol.ts` | Add new message types |
| `server/src/websocket/connection.ts` | Use MultiSessionManager, add subscription handlers |
| `server/src/pi/event-forwarder.ts` | Wrap events with sessionId |
| `client/src/store/sessionStore.ts` | Per-session data storage, event routing |
| `client/src/hooks/useWebSocket.ts` | Subscribe/unsubscribe handling |
| `client/src/components/Chat/MessageInput.tsx` | Use draft store |
| `client/src/components/Sidebar/SessionItem.tsx` | Show live status |
| `client/src/components/Chat/ChatView.tsx` | Better activity indicators |

---

## Testing Strategy

### Overview

The multi-session refactoring requires comprehensive testing across three layers:
- **Unit Tests**: Test individual components in isolation
- **Integration Tests**: Test component interactions and WebSocket protocol
- **E2E Tests**: Test full user workflows in a browser

All new tests must be written before or alongside implementation (TDD approach).

---

### Unit Tests

#### 1. MultiSessionManager Tests

**File:** `server/tests/unit/pi/multi-session-manager.test.ts`

```typescript
describe('MultiSessionManager', () => {
  describe('subscribeClient', () => {
    it('should create new session when first client subscribes')
    it('should reuse existing session when second client subscribes')
    it('should add client to subscribers list')
    it('should return session status')
    it('should throw on invalid session path')
  });

  describe('unsubscribeClient', () => {
    it('should remove client from subscribers')
    it('should keep session alive if other subscribers exist')
    it('should keep session alive if agent is busy')
    it('should mark session for cleanup if no subscribers and idle')
  });

  describe('broadcastToSubscribers', () => {
    it('should send message to all subscribers')
    it('should handle disconnected clients gracefully')
    it('should not send to unsubscribed clients')
  });

  describe('getSessionStatus', () => {
    it('should return status for active session')
    it('should return undefined for non-existent session')
    it('should include message count and current step')
  });

  describe('cleanupInactiveSessions', () => {
    it('should remove sessions with no subscribers and idle')
    it('should not remove sessions with subscribers')
    it('should not remove sessions that are busy')
    it('should respect maxAge parameter')
    it('should log cleanup actions')
  });

  describe('event handling', () => {
    it('should update session status on agent_start')
    it('should update session status on agent_end')
    it('should update message count on new messages')
    it('should track lastActivity timestamp')
  });
});
```

#### 2. Protocol Tests

**File:** `server/tests/unit/websocket/protocol.test.ts`

```typescript
describe('Multi-Session Protocol', () => {
  describe('SessionStatusBroadcast', () => {
    it('should validate required fields')
    it('should include all status types')
    it('should serialize to JSON correctly')
  });

  describe('SessionEvent', () => {
    it('should wrap agent events with sessionId')
    it('should preserve original event structure')
  });

  describe('SubscribeSession', () => {
    it('should validate sessionPath')
    it('should reject missing sessionPath')
  });

  describe('SessionSubscribed', () => {
    it('should include session status on subscribe')
    it('should include current step if streaming')
  });
});
```

#### 3. sessionStore Tests (Updated)

**File:** `client/tests/unit/store/sessionStore.test.ts`

```typescript
describe('sessionStore - Multi-Session', () => {
  describe('sessionData', () => {
    it('should store data per session')
    it('should update individual session data')
    it('should not affect other sessions when updating one')
    it('should derive currentSessionData from sessionData')
  });

  describe('handleServerMessage - Session Routing', () => {
    it('should route session_event to correct session')
    it('should update status for correct session')
    it('should handle session_status broadcast')
    it('should ignore events for unknown sessions')
  });

  describe('updateSessionData', () => {
    it('should merge partial updates')
    it('should preserve existing data')
    it('should update lastEventTimestamp')
  });

  describe('addMessageToSession', () => {
    it('should add message to correct session')
    it('should increment message count')
    it('should not affect other sessions')
  });

  describe('setSessionStatus', () => {
    it('should update status for specific session')
    it('should update currentSession if matches')
    it('should handle all status types')
  });

  describe('cleanupStaleSessionData', () => {
    it('should remove oldest sessions when over limit')
    it('should preserve current session')
    it('should preserve recently active sessions')
  });
});
```

#### 4. draftStore Tests (New)

**File:** `client/tests/unit/store/draftStore.test.ts`

```typescript
describe('draftStore', () => {
  beforeEach(() => {
    // Reset store
    useDraftStore.setState({ drafts: {}, currentDraft: '' });
  });

  describe('setDraft', () => {
    it('should store draft for a session')
    it('should update currentDraft if session is current')
    it('should not affect other session drafts')
    it('should persist to localStorage')
  });

  describe('getDraft', () => {
    it('should return draft for session')
    it('should return empty string for unknown session')
  });

  describe('clearDraft', () => {
    it('should remove draft for session')
    it('should clear currentDraft if session matches')
    it('should not affect other session drafts')
  });

  describe('syncCurrentDraft', () => {
    it('should update currentDraft from session draft')
    it('should set empty string if no draft exists')
  });

  describe('sendDraft', () => {
    it('should send draft to WebSocket')
    it('should clear draft after sending')
    it('should not send if session is streaming')
  });

  describe('persistence', () => {
    it('should restore drafts from localStorage on mount')
    it('should handle corrupted localStorage data')
  });
});
```

#### 5. SessionStatusIndicator Tests (New)

**File:** `client/tests/unit/components/Sidebar/SessionStatusIndicator.test.tsx`

```typescript
describe('SessionStatusIndicator', () => {
  it('should render idle status with green dot')
  it('should render streaming status with pulsing amber dot')
  it('should render busy status with pulsing blue dot')
  it('should render error status with red dot')
  it('should show step number when streaming')
  it('should return null if session data not found')
});
```

---

### Integration Tests

#### 1. WebSocket Multi-Session Integration

**File:** `server/tests/integration/websocket-multi-session.test.ts`

```typescript
describe('WebSocket Multi-Session Integration', () => {
  describe('Subscription Model', () => {
    it('should allow client to subscribe to session')
    it('should send session_subscribed confirmation')
    it('should allow client to unsubscribe')
    it('should send session_unsubscribed confirmation')
    it('should handle subscribe to non-existent session')
  });

  describe('Event Broadcasting', () => {
    it('should broadcast events to all subscribers')
    it('should wrap events with sessionId')
    it('should not send events to unsubscribed clients')
    it('should broadcast status changes to all clients')
  });

  describe('Multi-Client Scenarios', () => {
    it('should handle two clients subscribing to same session')
    it('should handle client A unsubscribing while B stays subscribed')
    it('should handle both clients unsubscribing')
    it('should preserve session when clients disconnect')
  });

  describe('Session Lifecycle', () => {
    it('should create session on first subscribe')
    it('should keep session alive after unsubscribe if busy')
    it('should cleanup session after all clients unsubscribe and idle')
    it('should reuse existing session for new subscriber')
  });

  describe('Backward Compatibility', () => {
    it('should still support switch_session for legacy clients')
    it('should convert switch_session to subscribe/unsubscribe internally')
  });
});
```

#### 2. Client-Server Integration

**File:** `tests/integration/client-server-multi-session.test.ts`

```typescript
describe('Client-Server Multi-Session Integration', () => {
  describe('Session Data Synchronization', () => {
    it('should sync session data when subscribing')
    it('should receive live updates for subscribed session')
    it('should receive status broadcasts for all sessions')
    it('should handle reconnection gracefully')
  });

  describe('Draft Persistence Integration', () => {
    it('should preserve draft across session switches')
    it('should send draft to correct session')
    it('should clear draft after successful send')
  });

  describe('Race Conditions', () => {
    it('should handle rapid subscribe/unsubscribe')
    it('should handle events arriving after unsubscribe')
    it('should handle concurrent session switches')
  });
});
```

---

### E2E Tests

#### 1. Multi-Session Workflow Tests

**File:** `tests/e2e/multi-session.spec.ts`

```typescript
test.describe('Multi-Session Workflows', () => {
  test.beforeEach(async ({ page }) => {
    // Login
    await page.goto('/');
    await page.locator('input[type="password"]').fill(process.env.TEST_PASSWORD!);
    await page.locator('button[type="submit"]').click();
    await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 10000 });
  });

  test('should show live status in sidebar when session is streaming', async ({ page }) => {
    // Create session and start a task
    // Verify sidebar shows "Streaming..." or step indicator
    // Wait for completion
    // Verify sidebar shows "Ready"
  });

  test('should preserve draft input when switching sessions', async ({ page }) => {
    // Create session 1
    // Type draft "Hello from session 1" (don't send)
    // Create session 2
    // Type draft "Hello from session 2" (don't send)
    // Switch back to session 1
    // Verify draft "Hello from session 1" is preserved
    // Switch to session 2
    // Verify draft "Hello from session 2" is preserved
  });

  test('should continue streaming in background when switching away', async ({ page }) => {
    // Create session 1, start long-running task
    // Verify streaming indicator shows
    // Create session 2
    // Session 1 should still show streaming indicator in sidebar
    // Wait for session 1 to complete (monitor sidebar)
    // Switch back to session 1
    // Verify full response is visible
  });

  test('should show correct status for multiple concurrent sessions', async ({ page }) => {
    // Create session 1, start task
    // Create session 2, start task
    // Create session 3, don't start task
    // Verify sidebar shows:
    //   - Session 1: streaming/busy
    //   - Session 2: streaming/busy
    //   - Session 3: ready
  });

  test('should handle session status transitions correctly', async ({ page }) => {
    // Create session
    // Verify status: ready
    // Send prompt
    // Verify status transitions: ready → streaming
    // Wait for completion
    // Verify status transitions: streaming → ready
  });
});
```

#### 2. Status Indicator E2E Tests

**File:** `tests/e2e/session-status.spec.ts`

```typescript
test.describe('Session Status Indicators', () => {
  test('should show idle status for new session', async ({ page }) => {
    // Create session
    // Check sidebar shows "Ready" or green dot
  });

  test('should show streaming status during response', async ({ page }) => {
    // Send prompt
    // Check sidebar shows pulsing indicator + "Step X"
  });

  test('should show error status on failure', async ({ page }) => {
    // Trigger an error (e.g., network disconnect)
    // Check sidebar shows red indicator + "Error"
  });

  test('should update status in real-time across sessions', async ({ page }) => {
    // Create 3 sessions
    // Start task in session 1
    // Verify all 3 sessions show correct status in sidebar
    // Switch between them, verify status persists
  });
});
```

#### 3. Draft Persistence E2E Tests

**File:** `tests/e2e/draft-persistence.spec.ts`

```typescript
test.describe('Draft Input Persistence', () => {
  test('should preserve draft when switching between existing sessions', async ({ page }) => {
    // Create session 1
    // Type "Draft 1" in input
    // Create session 2
    // Type "Draft 2" in input
    // Switch to session 1
    // Verify input shows "Draft 1"
    // Switch to session 2
    // Verify input shows "Draft 2"
  });

  test('should clear draft only for session that sent message', async ({ page }) => {
    // Create session 1, type "Draft 1"
    // Create session 2, type "Draft 2"
    // Send message in session 1
    // Switch to session 2
    // Verify draft "Draft 2" still present
    // Switch to session 1
    // Verify draft is cleared
  });

  test('should restore draft after page reload', async ({ page }) => {
    // Create session 1, type "Draft 1"
    // Reload page
    // Verify draft is restored
  });
});
```

---

### Test File Structure

```
pi-web-ui/
├── server/
│   └── tests/
│       ├── unit/
│       │   ├── pi/
│       │   │   ├── pi-service.test.ts          (existing)
│       │   │   └── multi-session-manager.test.ts  (NEW)
│       │   └── websocket/
│       │       ├── connection.test.ts          (existing - update)
│       │       └── protocol.test.ts            (NEW)
│       └── integration/
│           └── websocket-multi-session.test.ts (NEW)
│
├── client/
│   └── tests/
│       ├── unit/
│       │   ├── store/
│       │   │   ├── sessionStore.test.ts        (existing - update)
│       │   │   └── draftStore.test.ts          (NEW)
│       │   └── components/
│       │       └── Sidebar/
│       │           └── SessionStatusIndicator.test.tsx (NEW)
│       └── integration/
│           └── multi-session.test.ts           (NEW)
│
└── tests/
    └── e2e/
        ├── auth.spec.ts                        (existing)
        ├── core.spec.ts                        (existing)
        ├── multi-session.spec.ts               (NEW)
        ├── session-status.spec.ts              (NEW)
        └── draft-persistence.spec.ts           (NEW)
```

---

### Test Coverage Targets

| Component | Current Coverage | Target Coverage |
|-----------|------------------|-----------------|
| MultiSessionManager | N/A (new) | 90% |
| Protocol Types | N/A (new) | 85% |
| sessionStore | ~70% | 80% |
| draftStore | N/A (new) | 85% |
| SessionStatusIndicator | N/A (new) | 80% |
| WebSocket Integration | ~50% | 75% |

---

### Test Execution Plan

#### Pre-Implementation
1. Write unit tests for MultiSessionManager (will fail - no implementation)
2. Write unit tests for draftStore (will fail - no implementation)
3. Write protocol type tests (will pass - just types)

#### During Implementation
1. Run MultiSessionManager tests with `--watch` mode
2. Run draftStore tests with `--watch` mode
3. Update sessionStore tests as store is modified
4. Run all unit tests before each commit

#### Post-Implementation
1. Run full unit test suite: `npm test`
2. Run integration tests: `npm run test:integration`
3. Run E2E tests: `npm run test:e2e`
4. Generate coverage report: `npm run test:coverage`
5. Verify coverage targets are met

---

### Mocking Strategy

#### Server Tests
```typescript
// Mock @mariozechner/pi-coding-agent
vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: vi.fn().mockResolvedValue({
    session: {
      sessionId: 'test-session',
      subscribe: vi.fn(),
      dispose: vi.fn(),
      // ... other methods
    }
  }),
  // ... other exports
}));

// Mock PiService
vi.mock('../../src/pi/pi-service.js', () => ({
  getPiService: vi.fn(),
}));
```

#### Client Tests
```typescript
// Mock WebSocket
vi.mock('../../lib/websocket', () => ({
  createWebSocketClient: vi.fn(() => ({
    connect: vi.fn(),
    send: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn(() => 'connected'),
  })),
}));

// Mock localStorage for draft persistence
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key) => store[key]),
    setItem: vi.fn((key, value) => { store[key] = value; }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });
```

---

### CI/CD Integration

Update `.github/workflows/test.yml`:

```yaml
name: Tests

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm test
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v3

  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run test:integration

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx playwright install
      - run: npm run build
      - run: npm run test:e2e
```

---

### Test Maintenance

1. **Update existing tests** when modifying sessionStore or WebSocket handlers
2. **Add regression tests** for any bugs discovered during testing
3. **Review test coverage** after each phase of implementation
4. **Document test utilities** in `tests/README.md`
5. **Keep E2E tests focused** - avoid testing implementation details

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Memory leaks from accumulated sessions | Aggressive cleanup of idle sessions with no subscribers |
| WebSocket message overload | Debounce status broadcasts, rate-limit event forwarding |
| Race conditions on rapid switches | WebSocket identity guards, event sequence numbers |
| Backward compatibility | Keep `switch_session` working for single-session clients |
| Server resource usage | Limit max concurrent sessions per client |

---

## Rollout Plan

### Phase 1: Foundation (Day 1)
- Add new protocol types
- Create MultiSessionManager (without activating)
- Add tests for MultiSessionManager

### Phase 2: Server Integration (Day 2)
- Integrate MultiSessionManager into WebSocketConnectionManager
- Update event forwarding to include sessionId
- Add subscription handlers
- Test with single client

### Phase 3: Client Updates (Day 2-3)
- Update sessionStore for per-session data
- Update WebSocket event handlers
- Create draft store
- Update MessageInput

### Phase 4: UI Polish (Day 3-4)
- Add SessionStatusIndicator
- Update sidebar with live status
- Add activity status improvements
- Test multi-session scenarios

### Phase 5: Testing & Cleanup (Day 4-5)
- Write and run MultiSessionManager unit tests
- Write and run draftStore unit tests
- Update sessionStore tests for new data structure
- Write WebSocket integration tests
- Write client-server integration tests
- Write E2E tests for multi-session workflows
- Write E2E tests for draft persistence
- Write E2E tests for status indicators
- Full test suite run with coverage report
- Verify coverage targets are met
- Performance testing (memory leaks, message throughput)
- Documentation updates

---

## Success Criteria

### Functional Criteria
1. ✅ User can start a task in Session A, switch to Session B, and see Session A's progress in sidebar
2. ✅ User can switch back to Session A and see live content (not stale)
3. ✅ User can have 5+ sessions running simultaneously
4. ✅ Draft input is preserved when switching sessions
5. ✅ Sidebar shows accurate status for each session (idle/streaming/error)
6. ✅ Memory usage remains stable over time (no leaks)
7. ✅ No regression in single-session usage

### Testing Criteria
8. ✅ All existing tests pass (93 server + 62 client + 9 e2e)
9. ✅ New MultiSessionManager tests achieve 90% coverage
10. ✅ New draftStore tests achieve 85% coverage
11. ✅ Integration tests pass for multi-client scenarios
12. ✅ E2E tests pass for draft persistence workflow
13. ✅ E2E tests pass for multi-session status indicators
14. ✅ No test flakiness in CI/CD pipeline

### Performance Criteria
15. ✅ Session switch latency < 100ms
16. ✅ Status broadcast latency < 50ms
17. ✅ No memory growth over 30-minute multi-session usage
18. ✅ 10 concurrent sessions per client without degradation

---

## Configuration Constants

These should be configurable via environment variables or config file:

| Setting | Value | Environment Variable |
|---------|-------|---------------------|
| Max concurrent sessions per client | 10 | `MAX_CLIENT_SESSIONS` |
| Max total active sessions on server | 100 | `MAX_TOTAL_SESSIONS` |
| Cleanup interval | 5 minutes | `SESSION_CLEANUP_INTERVAL_MS` |
| Inactive session timeout | 30 minutes | `SESSION_IDLE_TIMEOUT_MS` |
| Broadcast status to non-subscribers | Yes | `BROADCAST_SESSION_STATUS` |
| Max cached session data (client) | 50 | (client-side constant) |

---

## References

- Kimi CLI source: https://github.com/moonshotai/kimi-cli/tree/main/web
- Kimi useSessionStream: `/web/src/hooks/useSessionStream.ts`
- Kimi wireTypes: `/web/src/hooks/wireTypes.ts`
- Kimi App architecture: `/web/src/App.tsx`

---

## Implementation Checklist for Agent

When implementing this refactoring, the agent MUST:

### Before Writing Code
- [ ] Read this entire document thoroughly
- [ ] Read existing test files to understand testing patterns
- [ ] Read `server/src/websocket/connection.ts` to understand current architecture
- [ ] Read `client/src/store/sessionStore.ts` to understand current store structure

### Test-Driven Development
- [ ] Write failing tests for MultiSessionManager first
- [ ] Write failing tests for draftStore first
- [ ] Write failing tests for protocol types first
- [ ] Run tests to confirm they fail for the right reasons

### Server Implementation
- [ ] Create `multi-session-manager.ts` with all methods
- [ ] Add new protocol types to `protocol.ts`
- [ ] Update `event-forwarder.ts` to wrap events with sessionId
- [ ] Update `connection.ts` to use MultiSessionManager
- [ ] Add subscription handlers to connection.ts
- [ ] All server unit tests pass

### Client Implementation
- [ ] Create `draftStore.ts` with persistence
- [ ] Update `sessionStore.ts` with per-session data
- [ ] Update `useWebSocket.ts` with subscribe/unsubscribe
- [ ] Create `SessionStatusIndicator.tsx` component
- [ ] Update `MessageInput.tsx` to use draftStore
- [ ] Update `SessionItem.tsx` to show live status
- [ ] All client unit tests pass

### Integration & E2E
- [ ] Write integration tests for WebSocket subscription model
- [ ] Write E2E tests for multi-session workflow
- [ ] Write E2E tests for draft persistence
- [ ] Write E2E tests for status indicators
- [ ] All integration tests pass
- [ ] All E2E tests pass

### Final Verification
- [ ] Full test suite passes: `npm test`
- [ ] Coverage targets met
- [ ] Manual testing of multi-session scenarios
- [ ] Memory leak testing (monitor devtools)
- [ ] No regressions in single-session usage
- [ ] Update documentation
