# Pi Web UI Architecture

> Canonical architecture reference for Pi Web UI. Read [`README.md`](../README.md) first for the concise system overview, then use this document for deeper structure and data-flow detail.

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Protocol Layer](#protocol-layer)
4. [State Management](#state-management)
5. [Components](#components)
6. [Performance Optimizations](#performance-optimizations)
7. [Security Architecture](#security-architecture)
8. [Data Flow](#data-flow)

---

## Overview

Pi Web UI is a full-featured web interface for the Pi Coding Agent, providing real-time chat, session management, tool execution visualization, and extension support. Built with security-first principles and optimized for mobile performance.

### Design Principles

1. **Security First** - JWT auth, CSRF protection, origin validation
2. **Mobile Optimized** - Ref-based streaming, minimal re-renders
3. **Real-time** - WebSocket-based bidirectional communication
4. **Scalable** - Multi-session support, LRU caching
5. **Extensible** - Full extension UI protocol support

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (React + Vite)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │   Components    │    │     Hooks       │    │    Stores       │         │
│  ├─────────────────┤    ├─────────────────┤    ├─────────────────┤         │
│  │ • ChatView      │    │ • useSession    │    │ • sessionStore  │         │
│  │ • MessageList   │    │   Stream        │    │ • chatStore     │         │
│  │ • ToolCards     │    │ • useWebSocket  │    │ • draftStore    │         │
│  │ • Sidebar       │    │ • useAuth       │    │ • filesStore    │         │
│  │ • Shell / Git   │    │ • useTerminal   │    │ • gitStore      │         │
│  │ • Files / Tree  │    │                 │    │ • navigationStore│        │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘         │
│           │                      │                      │                   │
│           └──────────────────────┼──────────────────────┘                   │
│                                  │                                          │
│                    ┌─────────────┴─────────────┐                            │
│                    │    Message Adapter        │                            │
│                    │  (LiveMessage ↔ Message)  │                            │
│                    └─────────────┬─────────────┘                            │
│                                  │                                          │
│                    ┌─────────────┴─────────────┐                            │
│                    │     WebSocket Client      │                            │
│                    │   (JSON-RPC 2.0)          │                            │
│                    └─────────────┬─────────────┘                            │
│                                  │                                          │
└──────────────────────────────────┼──────────────────────────────────────────┘
                                   │ WebSocket / HTTP
                                   │
┌──────────────────────────────────┼──────────────────────────────────────────┐
│                            SERVER (Express + Node.js)                        │
├──────────────────────────────────┼──────────────────────────────────────────┤
│                                  │                                          │
│                    ┌─────────────┴─────────────┐                            │
│                    │    WebSocket Handler      │                            │
│                    │  • Connection Manager     │                            │
│                    │  • Message Router         │                            │
│                    │  • Event Broadcaster      │                            │
│                    └─────────────┬─────────────┘                            │
│                                  │                                          │
│           ┌──────────────────────┼──────────────────────┐                   │
│           │                      │                      │                   │
│  ┌────────┴────────┐  ┌──────────┴──────────┐  ┌───────┴────────┐          │
│  │  REST Routes    │  │   Pi Service Layer   │  │ Security Layer │          │
│  ├─────────────────┤  ├──────────────────────┤  ├────────────────┤          │
│  │ • /api/auth     │  │ • MultiSession       │  │ • JWT Auth     │          │
│  │ • /api/sessions │  │   Manager            │  │ • CSRF         │          │
│  │ • /api/models   │  │ • Session Pool       │  │ • Rate Limit   │          │
│  │ • /api/files    │  │ • Event Forwarder    │  │ • Origin Val.  │          │
│  │ • /api/health   │  │ • Session Watcher    │  │ • Prompt Inj.  │          │
│  └─────────────────┘  └──────────┬───────────┘  └────────────────┘          │
│                                  │                                          │
│                       ┌──────────┴───────────┐                              │
│                       │      Pi SDK          │                              │
│                       │  (@mariozechner/     │                              │
│                       │   pi-coding-agent)   │                              │
│                       └──────────┬───────────┘                              │
│                                  │                                          │
└──────────────────────────────────┼──────────────────────────────────────────┘
                                   │ File I/O
                                   │
┌──────────────────────────────────┼──────────────────────────────────────────┐
│                           FILE SYSTEM                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ~/.pi/agent/                                                                │
│  ├── sessions/                                                               │
│  │   └── --path--to--cwd/                                                    │
│  │       ├── session-abc123.jsonl    (Session files)                        │
│  │       └── session-def456.jsonl                                            │
│  ├── extensions/                      (Shared with CLI)                      │
│  │   ├── agent-discovery/                                                    │
│  │   ├── enhanced-plan-mode/                                                 │
│  │   ├── subagent/                                                           │
│  │   ├── todo/                                                               │
│  │   └── web-tools/                                                          │
│  └── agents/                          (Subagent definitions)                 │
│      ├── architect/                                                          │
│      ├── reviewer/                                                           │
│      └── worker/                                                             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Runtime Paths and Storage

Pi Web UI supports three runtime paths:

1. **Pi SDK path**
   - main files: `server/src/pi/multi-session-manager.ts`, `server/src/workers/worker-pool.ts`
   - session storage: `~/.pi/agent/sessions/`
   - extensions loaded from the Pi agent directory

2. **Claude Direct path**
   - main files: `server/src/claude/claude-service.ts`, `server/src/claude/claude-process-pool.ts`, `server/src/claude/claude-session-store.ts`
   - session storage: `~/.pi-web-ui/claude-sessions/`
   - used for `claude -p` / `--resume` session handling

3. **OpenCode Direct path**
   - main files: `server/src/opencode/opencode-service.ts`, `server/src/opencode/opencode-process-manager.ts`, `server/src/opencode/opencode-client.ts`
   - session storage: OpenCode-owned (no Pi JSONL transcript)
   - uses a long-lived `opencode serve` process with SSE events and HTTP API
   - event adapter: `server/src/opencode/opencode-event-adapter.ts` converts SSE events to Pi-normalized format
   - history replay: `server/src/opencode/opencode-history-replay.ts` converts OpenCode messages to replay events

All runtime paths are unified in the sidebar and server metadata through `server/src/session-registry.ts` and `~/.pi-web-ui/session-registry.json`.

---

## Protocol Layer

### JSON-RPC 2.0 Protocol

The WebSocket protocol follows JSON-RPC 2.0 conventions:

```typescript
// Request format
interface Request {
  type: string;        // Method name
  id?: string;         // Optional request ID
  [key: string]: any;  // Method parameters
}

// Response format
interface Response {
  type: string;        // Response type
  id?: string;         // Matches request ID
  error?: {
    code: string;
    message: string;
  };
  [key: string]: any;  // Response data
}
```

### WebSocket Endpoints

| Endpoint | Protocol | Status |
|----------|----------|--------|
| `/ws/sessions/:sessionId` | JSON-RPC 2.0 | Current |
| `/ws` | Legacy | Deprecated |

### Client Methods

| Method | Description | Response |
|--------|-------------|----------|
| `auth` | Validate CSRF token | `connection_status` |
| `prompt` | Send message to agent | Streams agent events |
| `steer` | Inject follow-up mid-turn | No direct response |
| `abort` | Cancel current turn | No direct response |
| `new_session` | Create new session | `session_created` |
| `switch_session` | Load session history | `session_switched` |
| `get_sessions` | List all sessions | `sessions_list` |
| `subscribe_session` | Subscribe to events | `session_subscribed` |
| `unsubscribe_session` | Unsubscribe | `session_unsubscribed` |
| `set_model` | Change model | `model_changed` |
| `set_thinking_level` | Set reasoning depth | `thinking_level_changed` |
| `compact` | Trigger compaction | `compaction_result` |

### Server Events

#### Connection Events
- `authenticated` - Initial connection confirmed
- `connection_status` - Auth status update
- `error` - Error notification

#### Session Events
- `sessions_list` - Available sessions
- `session_created` - New session
- `session_switched` - Session loaded with history
- `session_update` - File change notification
- `session_status` - Periodic status broadcast
- `session_event` - Wrapped agent event

#### Agent Events
- `agent_start` / `agent_end` - Turn lifecycle
- `turn_start` / `turn_end` - Turn boundaries
- `message_start` / `message_update` / `message_end` - Streaming
- `tool_execution_start` / `tool_execution_end` - Tool execution

#### Extension Events
- `extension_ui_request` - Dialog request
- `extension_error` - Extension error

See [PROTOCOL.md](./PROTOCOL.md) for complete specification.

---

## State Management

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    STATE ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              useSessionStream Hook                   │   │
│  │  ┌─────────────────────────────────────────────┐    │   │
│  │  │  LiveMessage[] (ref-based, streaming-optim) │    │   │
│  │  │  - No re-renders during streaming           │    │   │
│  │  │  - Identity guards for session switches     │    │   │
│  │  │  - Atomic teardown with useLayoutEffect     │    │   │
│  │  └─────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│                          │ messageAdapter                   │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │               sessionStore (Zustand)                 │   │
│  │  ┌─────────────────────────────────────────────┐    │   │
│  │  │  Message[] (full-featured, persisted)        │    │   │
│  │  │  - Session switching                        │    │   │
│  │  │  - LRU cache (50 sessions)                  │    │   │
│  │  │  - Background session support               │    │   │
│  │  └─────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                chatStore (Zustand)                   │   │
│  │  - Current message input                            │   │
│  │  - Streaming state                                  │   │
│  │  - UI-specific chat state                           │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Supporting stores (Zustand)             │   │
│  │  - draftStore, filesStore, gitStore                 │   │
│  │  - navigationStore, orchestrationStore             │   │
│  │  - terminalStore                                   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                 uiStore (Zustand)                    │   │
│  │  - Theme settings                                   │   │
│  │  - Modal state                                      │   │
│  │  - Global UI preferences                            │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Multi-Runtime Note

Pi Web UI has three server-side runtime paths:

- **Pi SDK path** — managed by `server/src/pi/multi-session-manager.ts` and `server/src/workers/worker-pool.ts`
- **Claude Direct path** — managed by `server/src/claude/claude-service.ts` and `server/src/claude/claude-process-pool.ts`
- **OpenCode Direct path** — managed by `server/src/opencode/opencode-service.ts` and `server/src/opencode/opencode-process-manager.ts`

The sidebar and session metadata are unified through `server/src/session-registry.ts`.

### useSessionStream Hook

The primary hook for session streaming, optimized for mobile performance.

**Location:** `client/src/hooks/useSessionStream.ts`

**Features:**
- Ref-based content accumulation (no re-renders during streaming)
- Identity guards to prevent stale callbacks
- Atomic teardown with useLayoutEffect
- Automatic subscription management

**Usage:**
```typescript
const {
  messages,          // LiveMessage[]
  streamingMessage,  // Partial message being streamed
  isStreaming,       // Boolean
  error,             // Error if any
  sendMessage,       // (message: string) => void
  abort              // () => void
} = useSessionStream(sessionId);
```

**Implementation Details:**

```typescript
// Ref-based streaming
const contentRef = useRef<string>('');
const identityRef = useRef<number>(0);

// Identity guard
const updateContent = useCallback((newContent: string, id: number) => {
  // Only update if this callback belongs to current session
  if (id !== identityRef.current) return;
  contentRef.current = newContent;
  // Trigger single re-render
  forceUpdate();
}, []);

// Atomic teardown
useLayoutEffect(() => {
  const currentIdentity = ++identityRef.current;
  
  return () => {
    // Cleanup runs before next effect
    identityRef.current++;
  };
}, [sessionId]);
```

### Message Types

#### LiveMessage (Streaming-Optimized)

```typescript
interface LiveMessage {
  id: string;
  role: 'user' | 'assistant';
  content: ContentPart[];
  timestamp: number;
  isStreaming?: boolean;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; toolUseId: string; content: any };
```

#### Message (Full-Featured)

```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  timestamp: number;
  // Additional metadata
  model?: string;
  tokens?: number;
  // ...
}
```

### Message Adapter

Converts between LiveMessage and Message types.

**Location:** `client/src/lib/messageAdapter.ts`

```typescript
export function liveToMessage(live: LiveMessage): Message;
export function messageToLive(msg: Message): LiveMessage;
export function mergeLiveIntoMessage(
  existing: Message,
  live: LiveMessage
): Message;
```

### LRU Cache

Session messages are cached with LRU eviction:

```typescript
class SessionCache {
  private cache = new LRUCache<string, CachedSession>({
    max: 50  // Max 50 sessions
  });
  
  get(sessionId: string): CachedSession | undefined;
  set(sessionId: string, data: CachedSession): void;
  delete(sessionId: string): void;
  clear(): void;
}
```

---

## Components

### Component Hierarchy

```
App
├── AuthProvider
├── WebSocketProvider
└── Layout
    ├── Sidebar
    │   ├── SessionList
    │   │   └── SessionItem
    │   └── SidebarControls
    ├── MainContent
    │   ├── ChatView
    │   │   ├── ChatHeader
    │   │   ├── VirtualizedMessageList
    │   │   │   └── MessageBubble
    │   │   │       ├── TextContent
    │   │   │       ├── ThinkingBlock
    │   │   │       └── ToolCards
    │   │   └── MessageInput
    │   ├── Files / FileBrowser
    │   ├── Shell / Git / Tasks
    │   ├── Navigation / Tree
    │   ├── Orchestration
    │   └── Extensions / Settings / Usage
    └── StatusBar
        ├── ConnectionStatus
        ├── ModelSelector
        ├── ContextUsage
        └── MessageCount
```

### Top-Level Component Areas

The current `client/src/components/` tree includes these major areas:

- `Auth`, `Layout`, `Sidebar`, `StatusBar`
- `Chat`, `Tools`, `Tree`, `Navigation`
- `Files`, `FileBrowser`, `Shell`, `Git`, `Tasks`
- `Session`, `Settings`, `Extensions`, `Orchestration`, `Usage`

Treat this section as a structural map rather than an exhaustive file listing.

### Message Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     MESSAGE FLOW                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  1. User types message                                       │
│     MessageInput → chatStore.setInput()                      │
│                                                              │
│  2. User submits (Ctrl+Enter)                                │
│     MessageInput → useSessionStream.sendMessage()            │
│                                                              │
│  3. WebSocket sends prompt                                   │
│     { type: 'prompt', sessionId, message }                   │
│                                                              │
│  4. Server processes and streams events                      │
│     agent_start → message_start → message_update (n) →       │
│     tool_execution_start → tool_execution_end →              │
│     message_end → agent_end                                  │
│                                                              │
│  5. useSessionStream receives events                         │
│     - Accumulates content in refs (no re-renders)            │
│     - Updates streamingMessage state                         │
│     - Identity guards prevent stale updates                  │
│                                                              │
│  6. VirtualizedMessageList renders                           │
│     - Only visible messages in DOM                           │
│     - MessageBubble with memoization                         │
│     - Tool cards collapsed by default                        │
│                                                              │
│  7. On message_end                                           │
│     - streamingMessage → messages array                      │
│     - Persisted to sessionStore                              │
│     - LRU cache updated                                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Tool Cards

Tool cards are collapsed by default (Kimi-style verbosity):

```typescript
// Tool card visibility logic
const visibleTools = ['read', 'subagent'];  // Shown by default
const hiddenTools = ['edit', 'bash', 'web_search', 'web_fetch'];

// In VirtualizedMessageList
const shouldShowTool = (toolName: string) => {
  return visibleTools.includes(toolName);
};
```

**SubagentToolCard** shows hierarchical view of subagent operations:
- Displays subagent task and agent name
- Shows internal tool operations (read, edit, etc.)
- Expandable to show full details

---

## Performance Optimizations

### 1. Ref-Based Streaming

**Problem:** Each character during streaming triggers re-render of entire message list.

**Solution:** Accumulate content in refs, trigger single re-render on completion.

```typescript
// Before: Re-renders on every character
const [content, setContent] = useState('');
ws.onmessage = (e) => setContent(prev => prev + newChar);

// After: Single re-render
const contentRef = useRef('');
const [, forceUpdate] = useReducer(x => x + 1, 0);

ws.onmessage = (e) => {
  contentRef.current += newChar;
  // Only force update periodically or on complete
};
```

### 2. Identity Guards

**Problem:** Callbacks from previous sessions may update current session state.

**Solution:** Track session identity, reject stale callbacks.

```typescript
const sessionIdRef = useRef(sessionId);
const callbackIdRef = useRef(0);

useEffect(() => {
  sessionIdRef.current = sessionId;
  const myCallbackId = ++callbackIdRef.current;
  
  const handler = (event) => {
    // Guard: only process if still on same session
    if (sessionIdRef.current !== sessionId) return;
    if (callbackIdRef.current !== myCallbackId) return;
    
    // Safe to update state
    setState(event.data);
  };
  
  ws.addEventListener('message', handler);
  return () => ws.removeEventListener('message', handler);
}, [sessionId]);
```

### 3. LRU Cache

**Problem:** Memory grows unbounded with many sessions.

**Solution:** LRU eviction with configurable max size.

```typescript
const sessionCache = new LRUCache<string, SessionData>({
  max: 50,  // Max 50 sessions in memory
  ttl: 1000 * 60 * 30  // 30 minute TTL
});

// On session switch
if (sessionCache.has(sessionId)) {
  return sessionCache.get(sessionId);  // Cache hit
} else {
  const data = await loadSession(sessionId);
  sessionCache.set(sessionId, data);  // May evict old entry
  return data;
}
```

### 4. Message Virtualization

**Problem:** 100+ messages cause slow renders and high memory.

**Solution:** react-virtuoso renders only visible messages.

```typescript
import { Virtuoso } from 'react-virtuoso';

<Virtuoso
  data={messages}
  itemContent={(index, message) => (
    <MessageBubble
      key={message.id}
      message={message}
      memoized={true}  // Custom comparison
    />
  )}
  overscan={5}  // Render 5 extra items
/>
```

### 5. Component Memoization

```typescript
const MessageBubble = memo(({ message }) => {
  // ...
}, (prev, next) => {
  // Custom comparison - only re-render if content changed
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.isStreaming === next.message.isStreaming
  );
});
```

---

## Security Architecture

### Authentication Flow

```
┌──────────────────────────────────────────────────────────────┐
│                  AUTHENTICATION FLOW                          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Login Request                                            │
│     POST /api/auth/login                                     │
│     { username, password }                                   │
│                                                              │
│  2. Server validates                                         │
│     - bcrypt.compare(password, AUTH_PASSWORD)                │
│     - Generate JWT token                                     │
│     - Generate CSRF token                                    │
│                                                              │
│  3. Server responds                                          │
│     Set-Cookie: jwt=...; HttpOnly; SameSite=Strict           │
│     X-CSRF-Token: ...                                        │
│                                                              │
│  4. Client stores                                            │
│     - JWT in httpOnly cookie (automatic)                     │
│     - CSRF token in authentication state                     │
│                                                              │
│  5. WebSocket connection                                     │
│     - Cookie sent automatically                              │
│     - Server validates JWT                                   │
│     - Client sends: { type: 'auth', csrfToken }              │
│                                                              │
│  6. Server validates CSRF                                    │
│     - Returns: { type: 'connection_status', status: 'auth' } │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Security Layers

| Layer | Protection | Implementation |
|-------|------------|----------------|
| **Transport** | HTTPS only | Production requirement |
| **Authentication** | JWT tokens | httpOnly cookies, 15min expiry |
| **CSRF** | Double-submit | Token in header, validated server-side |
| **WebSocket** | Origin validation | ALLOWED_ORIGINS whitelist |
| **Rate Limiting** | Request throttling | express-rate-limit |
| **Input** | Prompt injection | Pattern detection |
| **Path** | Directory traversal | validatePath() |

### Security Middleware Stack

```typescript
// Server middleware order
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(cookieParser());
app.use(express.json());

// Protected routes
router.use(cookieAuthMiddleware);  // JWT validation
router.use(apiLimiter);            // Rate limiting

// WebSocket
wss.on('connection', (ws, req) => {
  // 1. Validate origin
  if (!ALLOWED_ORIGINS.includes(req.headers.origin)) {
    return ws.close(1008, 'Origin not allowed');
  }
  
  // 2. Validate JWT
  const token = req.cookies.jwt;
  const user = verifyJWT(token);
  if (!user) return ws.close(1008, 'Unauthorized');
  
  // 3. Wait for CSRF
  ws.once('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type !== 'auth') return ws.close(1008, 'Expected auth');
    if (!validateCSRF(msg.csrfToken)) return ws.close(1008, 'Invalid CSRF');
    
    // Authenticated!
    ws.authenticated = true;
  });
});
```

---

## Data Flow

### Session Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│                   SESSION LIFECYCLE                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  1. CREATE                                                   │
│     Client: new_session { cwd }                              │
│     Server: Creates ~/.pi/agent/sessions/--cwd/session.jsonl │
│     Response: session_created { sessionId, sessionPath }     │
│                                                              │
│  2. SUBSCRIBE                                                │
│     Client: subscribe_session { sessionPath }                │
│     Server: Creates AgentSession in MultiSessionManager      │
│     Response: session_subscribed { status, messageCount }    │
│                                                              │
│  3. INTERACT                                                 │
│     Client: prompt { message }                               │
│     Server: Forwards to Pi SDK, streams events               │
│     Events: session_event { sessionId, event }               │
│                                                              │
│  4. SWITCH                                                   │
│     Client: switch_session { sessionPath }                   │
│     Server: Loads history from file                          │
│     Response: session_switched { messages, ... }             │
│                                                              │
│  5. BACKGROUND                                               │
│     - Session remains in MultiSessionManager                 │
│     - File watcher monitors changes                          │
│     - Events still forwarded to subscribed clients           │
│                                                              │
│  6. UNSUBSCRIBE                                              │
│     Client: unsubscribe_session { sessionPath }              │
│     Server: Removes from client's subscription list          │
│     Response: session_unsubscribed { sessionId }             │
│                                                              │
│  7. DELETE                                                   │
│     Client: delete_session { sessionId }                     │
│     Server: Unlinks session file                             │
│     Broadcast: session_update { changeType: 'unlink' }       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### File Watcher

The session watcher monitors `~/.pi/agent/sessions/` for changes:

```typescript
class SessionWatcher {
  private watcher: FSWatcher;
  
  start() {
    this.watcher = watch(SESSIONS_DIR, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: true
    });
    
    this.watcher.on('add', (path) => this.handleAdd(path));
    this.watcher.on('change', (path) => this.handleChange(path));
    this.watcher.on('unlink', (path) => this.handleUnlink(path));
  }
  
  private handleAdd(path: string) {
    // Extract first message for preview
    const firstMessage = this.extractFirstMessage(path);
    
    // Broadcast to all WebSocket clients
    this.broadcast({
      type: 'session_update',
      changeType: 'add',
      path,
      info: { firstMessage, ... }
    });
  }
}
```

### Multi-Session Manager

Manages multiple AgentSessions for WebSocket clients:

```typescript
class MultiSessionManager {
  private sessions = new Map<string, AgentSession>();
  private clientSubscriptions = new Map<string, Set<string>>();
  
  subscribeClient(clientId: string, sessionPath: string) {
    // Get or create AgentSession
    const session = this.getOrCreateSession(sessionPath);
    
    // Track subscription
    this.clientSubscriptions.get(clientId).add(sessionPath);
    
    return session.status;
  }
  
  private getOrCreateSession(path: string): AgentSession {
    if (!this.sessions.has(path)) {
      const session = new AgentSession(path);
      session.on('event', (event) => {
        // Broadcast to all subscribed clients
        this.broadcastToSubscribers(path, event);
      });
      this.sessions.set(path, session);
    }
    return this.sessions.get(path);
  }
}
```

---

## See Also

- [PROTOCOL.md](./PROTOCOL.md) - Complete WebSocket protocol specification
- [PROCESS-ISOLATION-DESIGN.md](./PROCESS-ISOLATION-DESIGN.md) - Worker/process isolation design record
- [../DEPLOYMENT.md](../DEPLOYMENT.md) - Production deployment and service operations
- [../SECURITY.md](../SECURITY.md) - Security architecture details
- [../API.md](../API.md) - REST API documentation
- [../AGENTS.md](../AGENTS.md) - Developer guide

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024-03-26 | Initial architecture documentation |
