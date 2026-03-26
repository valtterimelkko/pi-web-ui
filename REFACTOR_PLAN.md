# Pi Web UI Complete Refactor Plan

## Executive Summary

This plan outlines a complete architectural refactor of the Pi Web UI to address mobile performance issues and establish a Kimi-style architecture with JSON-RPC 2.0 protocol, per-session WebSocket connections, and ref-based streaming.

**Duration:** 5-6 weeks
**Risk Level:** Medium-High
**Mobile Performance Fix:** 95%+
**Long-term Value:** Very High

---

## Principles & Preservation

### What We Preserve (Non-Negotiable)

These features represent significant investment and must be maintained:

#### 1. Pi SDK Filtering Logic
**Location:** `server/src/pi/event-forwarder.ts`
**What it does:**
- Skill content detection (`<skill name="...">` tags)
- Skill content transformation to brief placeholder
- Tool message filtering logic
- Message type mapping from Pi SDK events

**Git Commits:** `fe24a46`, `8240f44`, `2782e1f`, `381c210`

```
Preserve: getSkillContentInfo(), transformSkillContent(), mapEventToMessage()
```

#### 2. Verbosity Adjustments (UI Components)
**Locations:**
- `client/src/components/Tools/SubagentToolCard.tsx` - Hierarchical subagent display
- `client/src/components/Tools/CollapsibleToolCard.tsx` - Collapsible tool output
- `client/src/components/Chat/MessageBubble.tsx` - Message filtering, activity indicators

**What they do:**
- Collapse long tool outputs by default
- Show hierarchical view of subagent internal operations
- Filter toolResult messages from visible list
- Activity indicators for thinking-only messages
- Skill content brief display

**Git Commits:** `441f097`, `27eb777`, `0a07197`, `0892d6a`

```
Preserve: All display logic, truncation, collapsing, hierarchical views
```

#### 3. Persistent Multisession Architecture
**Locations:**
- `server/src/pi/multi-session-manager.ts` - Session lifecycle management
- `server/src/pi/session-pool.ts` - Agent session pooling
- `server/src/pi/session-watcher.ts` - File watching for CLI sessions
- `client/src/store/sessionStore.ts` - Session state management

**What they do:**
- Sessions continue running in background when browser closes
- Multiple sessions can be active simultaneously
- CLI and Web UI share session files
- Session archiving, renaming, export

**Git Commits:** `b90c261`, `5fcc8a5`, `cfd1353`

```
Preserve: Background execution, file-based persistence, session lifecycle
```

---

## Architecture Target

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TARGET ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ CLIENT (React + TypeScript + Vite)                               │   │
│  │                                                                  │   │
│  │  ┌─────────────────┐  ┌─────────────────────────────────────┐   │   │
│  │  │ useSessionStream│  │ Per-Session State                    │   │   │
│  │  │ (Refs for stream│  │ - messages: LiveMessage[]            │   │   │
│  │  │  accumulation)  │  │ - status: ChatStatus                 │   │   │
│  │  │                 │  │ - contextUsage: number               │   │   │
│  │  │ - wsRef         │  │ - Cleared on unmount                 │   │   │
│  │  │ - textRef       │  │                                      │   │   │
│  │  │ - thinkingRef   │  └─────────────────────────────────────┘   │   │
│  │  │ - toolCallsRef  │                                          │   │
│  │  └────────┬────────┘                                          │   │
│  │           │                                                    │   │
│  │           │ Identity Guards                                    │   │
│  │           │ if (wsRef.current !== ws) return;                 │   │
│  │           │                                                    │   │
│  │  ┌────────▼────────────────────────────────────────────────┐   │   │
│  │  │ WebSocket Client (Per-Session)                           │   │   │
│  │  │                                                          │   │   │
│  │  │ Endpoint: /ws/sessions/:sessionId                        │   │   │
│  │  │ Protocol: JSON-RPC 2.0                                   │   │   │
│  │  │ - Request IDs for correlation                            │   │   │
│  │  │ - Method namespacing                                     │   │   │
│  │  │ - Capability negotiation                                 │   │   │
│  │  └────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│                         WebSocket per session                          │
│                                    │                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ SERVER (Express + Pi SDK)                                        │   │
│  │                                                                  │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │ Session WebSocket Handler (/ws/sessions/:sessionId)      │    │   │
│  │  │                                                          │    │   │
│  │  │ - History replay on connect                              │    │   │
│  │  │ - JSON-RPC request/response                              │    │   │
│  │  │ - Request correlation                                     │    │   │
│  │  │ - Cancellation support                                    │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  │                           │                                      │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │ JSON-RPC Protocol Layer                                  │    │   │
│  │  │                                                          │    │   │
│  │  │ Methods:                                                 │    │   │
│  │  │ - initialize (capability negotiation)                    │    │   │
│  │  │ - prompt (send message)                                  │    │   │
│  │  │ - cancel (abort operation)                               │    │   │
│  │  │ - steer (inject mid-turn)                                │    │   │
│  │  │ - replay (load history)                                  │    │   │
│  │  │                                                          │    │   │
│  │  │ Events (server → client):                                │    │   │
│  │  │ - ContentPart, ToolCall, ToolResult, etc.                │    │   │
│  │  │ - StatusUpdate, TurnBegin, TurnEnd                       │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  │                           │                                      │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │ Event Forwarder (Preserved + Enhanced)                   │    │   │
│  │  │                                                          │    │   │
│  │  │ ✓ Skill content filtering                               │    │   │
│  │  │ ✓ Tool message filtering                                │    │   │
│  │  │ ✓ Message type mapping                                  │    │   │
│  │  │ + JSON-RPC envelope wrapping                             │    │   │
│  │  │ + Request ID tracking                                    │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  │                           │                                      │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │ MultiSessionManager (Preserved)                          │    │   │
│  │  │                                                          │    │   │
│  │  │ ✓ Background session execution                          │    │   │
│  │  │ ✓ Session lifecycle management                          │    │   │
│  │  │ ✓ Memory cleanup                                        │    │   │
│  │  │ ✓ CLI session watching                                  │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Compression Middleware (NEW)                                     │   │
│  │ - GZip for responses > 1KB                                       │   │
│  │ - Reduces bandwidth for large messages                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Module Breakdown

### Wave 0: Foundation & Protocol Definition
**Duration:** 2 days
**Dependencies:** None
**Parallelizable:** No (foundation for all other modules)

#### Modules

##### M0.1: JSON-RPC Protocol Types
**Path:** `shared/protocol/jsonrpc.ts` (NEW)

```typescript
// Define JSON-RPC 2.0 types
// Request, Response, Notification, Error
// Method types for Pi Web UI
// Event types (ContentPart, ToolCall, etc.)
// Capability negotiation types
```

**Deliverables:**
- `JSONRPCRequest<T>` interface
- `JSONRPCResponse<T>` interface
- `JSONRPCNotification<T>` interface
- `JSONRPCError` interface
- All method parameter/result types
- All event payload types
- TypeScript strict mode compatible
- Zod schemas for runtime validation

**Tests:** `shared/protocol/jsonrpc.test.ts`
- Type serialization/deserialization
- Schema validation
- Error code handling

**Git Tag:** `refactor/m0.1-jsonrpc-types`

---

##### M0.2: Protocol Documentation
**Path:** `docs/PROTOCOL.md` (NEW)

**Deliverables:**
- Complete JSON-RPC API documentation
- Method signatures
- Event types
- Error codes
- Capability negotiation flow
- Examples for each method/event

**Git Tag:** `refactor/m0.2-protocol-docs`

---

### Wave 1: Server Protocol Layer
**Duration:** 3 days
**Dependencies:** Wave 0
**Parallelizable:** Partially (M1.1-M1.3 can be parallel, M1.4 depends on them)

#### Modules

##### M1.1: JSON-RPC Message Handler
**Path:** `server/src/protocol/jsonrpc-handler.ts` (NEW)

**Deliverables:**
- Message parsing and validation
- Request ID generation and tracking
- Response correlation
- Error handling with proper codes
- Batch request support

**Tests:** `server/tests/unit/protocol/jsonrpc-handler.test.ts`
- Valid message parsing
- Invalid message rejection
- Request/response correlation
- Error code mapping

**Git Tag:** `refactor/m1.1-jsonrpc-handler`

**Edge Cases:**
- Malformed JSON
- Missing required fields
- Unknown method
- Invalid params
- Duplicate request IDs
- Request timeout handling

---

##### M1.2: Session WebSocket Endpoint
**Path:** `server/src/websocket/session-websocket.ts` (NEW)

**Deliverables:**
- Per-session WebSocket endpoint `/ws/sessions/:sessionId`
- Connection lifecycle management
- History replay on connect
- Live event streaming
- Graceful disconnect handling

**Tests:** `server/tests/unit/websocket/session-websocket.test.ts`
- Connection establishment
- History replay
- Live event routing
- Disconnect cleanup
- Reconnection handling

**Git Tag:** `refactor/m1.2-session-websocket`

**Edge Cases:**
- Session doesn't exist
- Session file corrupted
- Concurrent connections to same session
- Connection drop during replay
- Partial replay on reconnect

---

##### M1.3: JSON-RPC Methods Implementation
**Path:** `server/src/protocol/methods/` (NEW)

**Sub-modules:**
- `initialize.ts` - Capability negotiation
- `prompt.ts` - Send message to session
- `cancel.ts` - Abort in-flight operation
- `steer.ts` - Inject mid-turn message
- `replay.ts` - Replay session history
- `setPlanMode.ts` - Toggle plan mode

**Deliverables:**
- Each method as separate module
- Parameter validation
- Result formatting
- Error handling

**Tests:** `server/tests/unit/protocol/methods/*.test.ts`
- Each method tested independently
- Parameter validation
- Error conditions
- Success cases

**Git Tag:** `refactor/m1.3-methods`

**Edge Cases:**
- `prompt` while busy
- `cancel` with no operation
- `steer` with no turn
- `replay` with no history
- Capability mismatch

---

##### M1.4: History Replay System
**Path:** `server/src/protocol/history-replay.ts` (NEW)

**Deliverables:**
- Read session JSONL file
- Parse and replay events in order
- Buffer live events during replay
- Flush buffer after replay complete
- Progress reporting

**Tests:** `server/tests/unit/protocol/history-replay.test.ts`
- Empty session replay
- Large session replay (100+ events)
- Live event buffering
- Replay interruption
- Partial replay recovery

**Git Tag:** `refactor/m1.4-history-replay`

**Edge Cases:**
- Corrupted JSONL file
- Missing events
- Large files (streaming read)
- Replay during concurrent write
- Replay cancellation

---

### Wave 2: Server Event System Enhancement
**Duration:** 2 days
**Dependencies:** Wave 1
**Parallelizable:** Yes (M2.1 and M2.2 can be parallel)

#### Modules

##### M2.1: Enhanced Event Forwarder
**Path:** `server/src/pi/event-forwarder.ts` (MODIFY)

**What Changes:**
- Add JSON-RPC envelope wrapping
- Add request ID tracking for correlated events
- Preserve existing filtering logic (skill content, tool messages)
- Add event buffering for replay scenario

**What Stays Same:**
- `getSkillContentInfo()` - Skill detection
- `transformSkillContent()` - Skill transformation
- `mapEventToMessage()` - Pi SDK event mapping
- All filtering logic

**Tests:** `server/tests/unit/pi/event-forwarder.test.ts`
- Existing tests must pass
- New tests for JSON-RPC wrapping
- New tests for request correlation

**Git Tag:** `refactor/m2.1-event-forwarder`

---

##### M2.2: Session Status Broadcasting
**Path:** `server/src/pi/session-broadcaster.ts` (NEW)

**Deliverables:**
- Broadcast session status changes
- Per-session subscriber management
- Status diff detection (only broadcast changes)
- Heartbeat for connection health

**Tests:** `server/tests/unit/pi/session-broadcaster.test.ts`
- Status change detection
- Subscriber management
- Heartbeat mechanism
- Cleanup on disconnect

**Git Tag:** `refactor/m2.2-session-broadcaster`

---

### Wave 3: Server Middleware & Routing
**Duration:** 1 day
**Dependencies:** Wave 2
**Parallelizable:** No

#### Modules

##### M3.1: Compression Middleware
**Path:** `server/src/middleware/compression.ts` (NEW)

**Deliverables:**
- GZip compression for responses > 1KB
- Configurable compression level
- Content-type filtering
- Performance metrics

**Tests:** `server/tests/unit/middleware/compression.test.ts`
- Compression threshold
- Content-type handling
- Performance impact

**Git Tag:** `refactor/m3.1-compression`

---

##### M3.2: Session Router Update
**Path:** `server/src/routes/sessions.ts` (MODIFY)

**What Changes:**
- Add WebSocket upgrade endpoint for sessions
- Update REST endpoints for new protocol
- Add capability negotiation endpoint

**What Stays Same:**
- Session CRUD operations
- File operations
- Archive/rename/export

**Tests:** `server/tests/unit/routes/sessions.test.ts`
- Existing tests must pass
- New WebSocket upgrade tests

**Git Tag:** `refactor/m3.2-session-router`

---

### Wave 4: Client Protocol Layer
**Duration:** 3 days
**Dependencies:** Wave 0 (can start parallel with Wave 1)
**Parallelizable:** Partially

#### Modules

##### M4.1: JSON-RPC Client
**Path:** `client/src/lib/jsonrpc-client.ts` (NEW)

**Deliverables:**
- JSON-RPC request generation
- Response correlation
- Timeout handling
- Retry logic
- Event listener management

**Tests:** `client/tests/unit/lib/jsonrpc-client.test.ts`
- Request generation
- Response correlation
- Timeout handling
- Retry logic

**Git Tag:** `refactor/m4.1-jsonrpc-client`

---

##### M4.2: Session WebSocket Client
**Path:** `client/src/lib/session-websocket.ts` (NEW)

**Deliverables:**
- Per-session WebSocket connection
- Identity guard pattern (wsRef.current !== ws)
- Connection lifecycle management
- Reconnection with backoff
- Watchdog for stale connections

**Tests:** `client/tests/unit/lib/session-websocket.test.ts`
- Connection lifecycle
- Identity guards
- Reconnection logic
- Watchdog mechanism

**Git Tag:** `refactor/m4.2-session-websocket`

**Edge Cases:**
- Multiple rapid session switches
- Network disconnect during operation
- Server restart
- Browser tab background/foreground

---

##### M4.3: History Replay Handler
**Path:** `client/src/lib/history-replay.ts` (NEW)

**Deliverables:**
- `isReplayingHistory` state management
- Live event buffering during replay
- Buffer flush after replay complete
- Progress reporting

**Tests:** `client/tests/unit/lib/history-replay.test.ts`
- Buffer management
- Flush timing
- Progress events

**Git Tag:** `refactor/m4.3-history-replay`

---

### Wave 5: Client State Management Rewrite
**Duration:** 4 days
**Dependencies:** Wave 4
**Parallelizable:** No (core state management)

#### Modules

##### M5.1: useSessionStream Hook (Complete Rewrite)
**Path:** `client/src/hooks/useSessionStream.ts` (NEW - replaces useWebSocket)

**Deliverables:**
- Ref-based streaming (no state for accumulation)
  - `textRef = useRef("")`
  - `thinkingRef = useRef("")`
  - `toolCallsRef = useRef(new Map())`
- State only for complete messages
- Identity guards on all callbacks
- useLayoutEffect for atomic teardown
- History replay integration
- Request correlation

**Pattern:**
```typescript
// Refs for accumulation (no re-renders)
const textRef = useRef("");
const thinkingRef = useRef("");
const toolCallsRef = useRef<Map<string, ToolCallState>>(new Map());

// State only for complete messages
const [messages, setMessages] = useState<LiveMessage[]>([]);
const [status, setStatus] = useState<ChatStatus>("ready");

// WebSocket identity guard
const wsRef = useRef<WebSocket | null>(null);

// Atomic teardown before paint
useLayoutEffect(() => {
  const ws = wsRef.current;
  return () => {
    if (ws) {
      ws.close();
      // Clear refs
      textRef.current = "";
      thinkingRef.current = "";
      toolCallsRef.current.clear();
    }
  };
}, [sessionId]);
```

**Tests:** `client/tests/unit/hooks/useSessionStream.test.ts`
- Ref accumulation without re-renders
- Identity guard effectiveness
- Atomic teardown
- History replay handling

**Git Tag:** `refactor/m5.1-session-stream`

---

##### M5.2: Session Store Refactor
**Path:** `client/src/store/sessionStore.ts` (MODIFY)

**What Changes:**
- Remove global message accumulation
- Add per-session state slices
- Add LRU cache for session messages (max 5 sessions)
- Add session cache metadata tracking
- Improve session switching atomicity

**What Stays Same:**
- Session list management
- Archive state
- Display names
- Preferences sync

**Tests:** `client/tests/unit/store/sessionStore.test.ts`
- Existing tests must pass
- New LRU cache tests
- Session switching tests

**Git Tag:** `refactor/m5.2-session-store`

---

##### M5.3: Chat Store Simplification
**Path:** `client/src/store/chatStore.ts` (MODIFY)

**What Changes:**
- Remove redundant state (moved to useSessionStream)
- Simplify to UI-only state

**Tests:** `client/tests/unit/store/chatStore.test.ts`

**Git Tag:** `refactor/m5.3-chat-store`

---

### Wave 6: Client UI Components Update
**Duration:** 2 days
**Dependencies:** Wave 5
**Parallelizable:** Yes (components are independent)

#### Modules

##### M6.1: VirtualizedMessageList Update
**Path:** `client/src/components/Chat/VirtualizedMessageList.tsx` (MODIFY)

**What Changes:**
- Use new message type (LiveMessage)
- Add identity guards for scroll events
- Improve performance with memo

**What Stays Same:**
- React-virtuoso integration
- Message filtering logic
- Empty state handling

**Tests:** `client/tests/unit/components/Chat/VirtualizedMessageList.test.tsx`

**Git Tag:** `refactor/m6.1-virtualized-list`

---

##### M6.2: MessageBubble Preservation
**Path:** `client/src/components/Chat/MessageBubble.tsx` (MINIMAL CHANGES)

**What Changes:**
- Accept new LiveMessage type
- Update props interface

**What Stays Same (CRITICAL):**
- ActivityIndicator logic
- Thinking block handling
- Skill content detection
- Tool card rendering (SubagentToolCard, CollapsibleToolCard)

**Tests:** `client/tests/unit/components/Chat/MessageBubble.test.tsx`

**Git Tag:** `refactor/m6.2-message-bubble`

---

##### M6.3: Tool Cards (No Changes)
**Paths:**
- `client/src/components/Tools/SubagentToolCard.tsx` (PRESERVE)
- `client/src/components/Tools/CollapsibleToolCard.tsx` (PRESERVE)

**What Stays Same:**
- All hierarchical display logic
- Collapsing/truncation
- Tool icons
- Progress indicators

**Tests:** Existing tests must pass

**Git Tag:** `refactor/m6.3-tool-cards` (verification only)

---

### Wave 7: Integration & Migration
**Duration:** 3 days
**Dependencies:** Waves 1-6
**Parallelizable:** No

#### Modules

##### M7.1: Dual Protocol Support
**Path:** `server/src/websocket/connection.ts` (MODIFY)

**Deliverables:**
- Support both old and new protocol during migration
- Protocol detection on connect
- Route to appropriate handler

**Tests:** `server/tests/unit/websocket/connection.test.ts`
- Old protocol handling
- New protocol handling
- Protocol detection

**Git Tag:** `refactor/m7.1-dual-protocol`

---

##### M7.2: App Integration
**Path:** `client/src/App.tsx` (MODIFY)

**What Changes:**
- Replace useWebSocket with useSessionStream
- Update session switching logic
- Add atomic session switching

**Tests:** E2E tests

**Git Tag:** `refactor/m7.2-app-integration`

---

##### M7.3: Legacy Protocol Deprecation
**Path:** Multiple files

**Deliverables:**
- Remove old protocol code
- Update all imports
- Clean up unused code

**Tests:** Full test suite

**Git Tag:** `refactor/m7.3-legacy-removal`

---

### Wave 8: Testing & Documentation
**Duration:** 2 days
**Dependencies:** Wave 7
**Parallelizable:** Yes

#### Modules

##### M8.1: E2E Test Update
**Path:** `tests/e2e/*.spec.ts` (MODIFY)

**Deliverables:**
- Update all E2E tests for new protocol
- Add mobile-specific tests
- Add session switching stress tests

**Git Tag:** `refactor/m8.1-e2e-tests`

---

##### M8.2: Performance Benchmarks
**Path:** `tests/benchmarks/` (NEW)

**Deliverables:**
- Mobile performance benchmarks
- Memory usage benchmarks
- Session switching latency tests
- Comparison with baseline

**Git Tag:** `refactor/m8.2-benchmarks`

---

##### M8.3: Documentation Update
**Paths:**
- `README.md` (UPDATE)
- `API.md` (UPDATE)
- `AGENTS.md` (UPDATE)
- `docs/ARCHITECTURE.md` (NEW)

**Git Tag:** `refactor/m8.3-documentation`

---

## Dependency Graph

```
                    ┌─────────────┐
                    │   Wave 0    │
                    │ Foundation  │
                    └──────┬──────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
    ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
    │   Wave 1    │ │   Wave 4    │ │   Wave 0    │
    │   Server    │ │   Client    │ │  Protocol   │
    │  Protocol   │ │  Protocol   │ │    Docs     │
    └──────┬──────┘ └──────┬──────┘ └─────────────┘
           │               │       (parallel)
    ┌──────▼──────┐       │
    │   Wave 2    │       │
    │   Server    │       │
    │   Events    │       │
    └──────┬──────┘       │
           │               │
    ┌──────▼──────┐       │
    │   Wave 3    │       │
    │   Server    │       │
    │ Middleware  │       │
    └──────┬──────┘       │
           │               │
           └───────┬───────┘
                   │
           ┌───────▼───────┐
           │    Wave 5     │
           │    Client     │
           │    State      │
           └───────┬───────┘
                   │
           ┌───────▼───────┐
           │    Wave 6     │
           │    Client     │
           │      UI       │
           └───────┬───────┘
                   │
           ┌───────▼───────┐
           │    Wave 7     │
           │ Integration   │
           └───────┬───────┘
                   │
           ┌───────▼───────┐
           │    Wave 8     │
           │ Testing &     │
           │    Docs       │
           └───────────────┘

Parallelization Opportunities:
- Wave 0.1 and 0.2 can run in parallel
- Wave 1.1, 1.2, 1.3 can run in parallel (after 0.1)
- Wave 2.1 and 2.2 can run in parallel
- Wave 4.1, 4.2, 4.3 can run in parallel
- Wave 6.1, 6.2, 6.3 can run in parallel
- Wave 8.1, 8.2, 8.3 can run in parallel
```

---

## Git Strategy

### Branch Naming Convention

```
refactor/wave-{N}/module-{M}.{S}-{description}

Examples:
- refactor/wave-0/module-0.1-jsonrpc-types
- refactor/wave-1/module-1.2-session-websocket
- refactor/wave-5/module-5.1-session-stream
```

### Merge Strategy

1. **Feature Branches** - Each module gets its own branch
2. **Wave Branches** - Aggregate feature branches into wave branch
3. **Integration Branch** - `refactor/integration` for final integration
4. **Main Branch** - Merge integration after full test suite passes

### Rollback Strategy

Each module is tagged, enabling granular rollback:

```bash
# Rollback specific module
git revert refactor/m1.2-session-websocket

# Rollback entire wave
git revert refactor/wave-1

# Rollback to specific point
git checkout refactor/wave-3-complete
```

### Commit Message Format

```
refactor(wave-N): module-M.S - Brief description

- Detailed change 1
- Detailed change 2

Preserves: [what existing functionality is preserved]
Changes: [what is modified]
Adds: [what is new]

Tests: [test coverage notes]
```

---

## Test Suite Updates

### Per-Module Test Requirements

| Module | New Tests | Modified Tests | Preserved Tests |
|--------|-----------|----------------|-----------------|
| M0.1 | jsonrpc.test.ts | - | - |
| M1.1 | jsonrpc-handler.test.ts | - | - |
| M1.2 | session-websocket.test.ts | - | - |
| M1.3 | methods/*.test.ts | - | - |
| M1.4 | history-replay.test.ts | - | - |
| M2.1 | - | event-forwarder.test.ts | All existing |
| M3.2 | - | sessions.test.ts | All existing |
| M4.1 | jsonrpc-client.test.ts | - | - |
| M4.2 | session-websocket.test.ts | - | - |
| M5.1 | useSessionStream.test.ts | - | - |
| M5.2 | - | sessionStore.test.ts | All existing |
| M6.1 | - | VirtualizedMessageList.test.tsx | All existing |
| M7.1 | - | connection.test.ts | All existing |
| M8.1 | - | e2e/*.spec.ts | All existing |

### Test Coverage Targets

| Layer | Target Coverage |
|-------|-----------------|
| Protocol Layer | 95% |
| Server WebSocket | 90% |
| Client Hooks | 90% |
| Client Store | 85% |
| Integration | 80% |

---

## Edge Cases Catalog

### Session Management

| Edge Case | Module | Handling |
|-----------|--------|----------|
| Session doesn't exist | M1.2 | Return error, suggest creation |
| Session file corrupted | M1.4 | Graceful degradation, partial replay |
| Concurrent connections | M1.2 | Multiple subscribers, shared state |
| Connection drop during replay | M1.4 | Resume from last position |
| Session deleted while connected | M1.2 | Notify client, redirect to list |

### WebSocket

| Edge Case | Module | Handling |
|-----------|--------|----------|
| Malformed JSON | M1.1 | Return parse error, log |
| Unknown method | M1.1 | Return method not found |
| Duplicate request ID | M1.1 | Reject with error |
| Request timeout | M1.1 | Cancel operation, notify client |
| Network disconnect | M4.2 | Auto-reconnect with backoff |
| Server restart | M4.2 | Detect via watchdog, reconnect |

### State Management

| Edge Case | Module | Handling |
|-----------|--------|----------|
| Rapid session switches | M5.1 | Atomic teardown, identity guards |
| Large session (500+ messages) | M5.2 | LRU cache, virtualization |
| Memory pressure | M5.2 | Aggressive cache eviction |
| Concurrent state updates | M5.1 | Ref pattern prevents race |

### Mobile Specific

| Edge Case | Module | Handling |
|-----------|--------|----------|
| Tab background/foreground | M4.2 | Pause/resume, state sync |
| Low memory warning | M5.2 | Cache eviction |
| Slow network | M3.1 | Compression, batching |
| Touch vs mouse events | M6.1 | Proper event handling |

---

## Risk Mitigation

### High-Risk Areas

1. **Session Switching Logic** (M5.1)
   - Risk: State corruption during rapid switches
   - Mitigation: Identity guards, atomic teardown, extensive testing

2. **History Replay** (M1.4, M4.3)
   - Risk: Incomplete replay, event loss
   - Mitigation: Buffering, checksum verification, resume capability

3. **Dual Protocol Support** (M7.1)
   - Risk: Breaking existing clients
   - Mitigation: Feature detection, gradual rollout

### Rollback Triggers

- Any test suite regression > 5%
- Mobile performance regression
- Memory leak detection
- Session data corruption

### Validation Gates

Each wave must pass before proceeding:
1. All new tests pass
2. All existing tests pass
3. No TypeScript errors
4. No ESLint errors
5. Manual smoke test

---

## Timeline

```
Week 1:
├─ Days 1-2: Wave 0 (Foundation)
├─ Days 3-5: Wave 1 (Server Protocol)
│             Wave 4 (Client Protocol) [parallel]

Week 2:
├─ Days 1-2: Wave 2 (Server Events)
├─ Days 3-4: Wave 3 (Server Middleware)
├─ Day 5: Integration checkpoint

Week 3:
├─ Days 1-4: Wave 5 (Client State)
├─ Days 5: Wave 6 start (UI Components)

Week 4:
├─ Days 1-2: Wave 6 complete
├─ Days 3-5: Wave 7 (Integration)

Week 5:
├─ Days 1-3: Wave 8 (Testing)
├─ Days 4-5: Buffer / Polish

Week 6:
├─ Days 1-3: Staged rollout
├─ Days 4-5: Monitoring, fixes
```

---

## Success Criteria

### Performance Targets

| Metric | Before | Target | Measurement |
|--------|--------|--------|-------------|
| Mobile session switch | 60-120s | <1s | Manual testing |
| Mobile typing latency | 2-5s | <100ms | Manual testing |
| Desktop session switch | 1-3s | <200ms | Automated benchmark |
| Memory per session | ~15MB | ~5MB | Chrome DevTools |
| Bundle size | ~150KB | ~180KB | Build output |

### Functional Requirements

- [ ] All existing features work identically
- [ ] Skill content filtering preserved
- [ ] Subagent hierarchical display preserved
- [ ] Background sessions continue after browser close
- [ ] CLI session sync works
- [ ] All E2E tests pass
- [ ] No TypeScript errors
- [ ] No console errors in browser

### Quality Gates

- [ ] Test coverage maintained or improved
- [ ] No regression in existing tests
- [ ] Performance benchmarks show improvement
- [ ] Mobile testing on real device passes
- [ ] Accessibility audit passes

---

## Post-Refactor Enhancements (Future)

These are NOT part of this refactor but become easier after:

1. **Cancellation API** - Proper abort handling
2. **Steering API** - Mid-turn guidance
3. **Capability Negotiation** - Feature detection
4. **Offline Support** - Service worker caching
5. **Push Notifications** - Background session alerts
6. **Session Forking** - Branch conversations
7. **Multi-tab Sync** - State synchronization

---

## Appendix A: Files Changed Summary

### New Files

```
shared/
├── protocol/
│   └── jsonrpc.ts

server/src/
├── protocol/
│   ├── jsonrpc-handler.ts
│   ├── history-replay.ts
│   └── methods/
│       ├── initialize.ts
│       ├── prompt.ts
│       ├── cancel.ts
│       ├── steer.ts
│       ├── replay.ts
│       └── setPlanMode.ts
├── websocket/
│   └── session-websocket.ts
├── pi/
│   └── session-broadcaster.ts
└── middleware/
    └── compression.ts

client/src/
├── lib/
│   ├── jsonrpc-client.ts
│   ├── session-websocket.ts
│   └── history-replay.ts
└── hooks/
    └── useSessionStream.ts

docs/
├── PROTOCOL.md
└── ARCHITECTURE.md

tests/
└── benchmarks/
    ├── mobile-performance.ts
    └── memory-usage.ts
```

### Modified Files

```
server/src/
├── pi/
│   └── event-forwarder.ts (add JSON-RPC wrapping)
├── routes/
│   └── sessions.ts (add WebSocket endpoint)
├── websocket/
│   └── connection.ts (dual protocol support)
└── app.ts (add compression middleware)

client/src/
├── store/
│   ├── sessionStore.ts (add LRU cache)
│   └── chatStore.ts (simplify)
├── components/
│   ├── Chat/
│   │   ├── VirtualizedMessageList.tsx (new message type)
│   │   └── MessageBubble.tsx (minimal changes)
│   └── App.tsx (use new hook)
└── hooks/
    └── useWebSocket.ts (DEPRECATE → useSessionStream)
```

### Preserved Files (No Changes)

```
client/src/components/Tools/
├── SubagentToolCard.tsx
├── CollapsibleToolCard.tsx
└── ToolProgressIndicator.tsx

server/src/pi/
├── multi-session-manager.ts
├── session-pool.ts
└── session-watcher.ts
```

---

## Appendix B: Preservation Checklist

Before each wave merge, verify:

- [ ] Skill content filtering works (`<skill name="...">` detection)
- [ ] Skill content transformed to brief placeholder
- [ ] SubagentToolCard shows hierarchical view
- [ ] CollapsibleToolCard collapses by default
- [ ] Tool messages filtered from visible list
- [ ] Activity indicator shows for thinking-only messages
- [ ] Background sessions continue after browser close
- [ ] CLI sessions appear in sidebar
- [ ] Session archiving works
- [ ] Session renaming works
- [ ] Session export works

---

*Plan Version: 1.0*
*Created: 2026-03-26*
*Estimated Duration: 5-6 weeks*
