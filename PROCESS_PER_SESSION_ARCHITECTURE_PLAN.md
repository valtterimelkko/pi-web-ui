# Process-per-Session Architecture Refactor Plan

## Executive Summary

Transform the Pi Web UI from a single-process architecture to a multi-process architecture (inspired by Kimi CLI's approach) to achieve:
- **Memory isolation**: Each session runs in its separate Node.js worker process
- **Crash isolation**: Worker crashes don't affect other sessions or the main server
- **Scalability**: OS-level memory management instead of V8 GC unpredictability
- **Persistent multisession**: Sessions continue in background when browser/app is closed
    - **Mobile-friendly**: Preserve JSON-RPC protocol, per-session WebSockets, and LRU caching

## Current Problem
The server OOM crashes during long-running sessions due to memory accumulating in a single Node.js process. Memory grows at ~200MB/30s during streaming until hitting the 1.5GB heap limit, causing the entire server to crash and restart.

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     MAIN SERVER PROCESS                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ HTTP Server  │  │ Session      │  │ Session Process       │  │
│  │ (Express)    │  │ Manager      │  │ Manager (spawn/kill)   │  │
│  │ WebSocket   │  │ (lifecycle)    │  │                         │  │
│  └──────┬───────┘  └──────────────┘  └───────────────────────┘  │
│           │                       │                                   │
│           │  spawns per-session│                                   │
│           │  worker processes   │                                   │
┌─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    WORKER PROCESS (one per session)                    │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ Pi SDK RPC    │  │ Event       │  │ stdin/stdout              │  │
│  │ Mode          │  │ Forwarder   │  │ (JSON-RPC protocol)        │  │
│  └──────────────┘  └──────────────┘  └───────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Extensions │ Tools │ Session File │ Context Management │  │
│  └───────────────────────────────────────────────────────────────────────┘
│  └─────────────────────────────────────────────────────────────────────┘
```

---

## Files to Preserve

### From Current Codebase

1. **Event Filtering** (`server/src/pi/event-forwarder.ts`, `client/src/components/Chat/VirtualizedMessageList.tsx`)
   - Skill content filtering (hide raw skill content from placeholder)
   - Tool message filtering (show collapsed by default, expandable)
   - Subagent tool card visibility (hierarchical display)
   - Event buffering and replay

2. **Persistent Multisession Support** Sessions continue in background via file-based session files
   - Switch between sessions maintains state
   - Background processing continues when browser/app is closed

3. **Mobile-Friendly Architecture** (preserved)
   - JSON-RPC protocol
   - Per-session WebSockets
   - Ref-based streaming
   - LRU cache
   - Virtualized scrolling
   - Mobile responsive UI

4. **Extension Support**: Full extension UI protocol preserved
   - Tools from Pi SDK continue to work
   - Extension commands and slash commands supported

---

## Technical Decisions

### 1. Worker Communication Strategy
**Decision: Use Pi SDK's built-in RPC mode with stdin/stdout**

Workers spawn as:
```bash
pi --mode rpc --session <path> --thinking <level> --model <model>
```

Benefits:
- Native session resumption with `--session <path>`
- Model/thinking settings persist per session
- Built-in extension UI protocol
- Event streaming via JSONL on stdout
- Command input via JSONL on stdin

### 2. Event Format Translation
**Decision: RPC events → JSON-RPC notifications → WebSocket**

Flow:
```
Pi SDK RPC (JSONL on stdout)
    ↓
EventNormalizer (convert to internal format)
    ↓
JSONRPCNotification (wrap for WebSocket)
    ↓
WebSocket client (existing protocol)
```

The current EventForwarder is mapEventToMessage() already converts Pi SDK events. We'll adapt it to work with RPC mode's event format.

### 3. Worker Lifecycle Management
**Decision: Lazy spawn with automatic cleanup**

- Workers spawn on first WebSocket connection to session
- Workers terminate after configurable idle timeout (default: 30 min)
- Workers restart automatically if crashed while streaming
- Max concurrent workers configurable (default: 15)
- Memory limit per worker via Node.js `--max-old-space`

### 4. Session State Persistence
**Decision: File-based sessions continue regardless of worker state**

- Sessions stored in `~/.pi/agent/sessions/` (existing)
- Workers can be killed and restarted without losing session state
- Model/thinking settings stored in session file
- WebSocket clients reconnect and resume without data loss

### 5. Extension UI Protocol
**Decision: Bridge RPC extension_ui_request to WebSocket clients**

The Pi SDK RPC mode has built-in extension UI protocol:
- `extension_ui_request` sent from worker to main process
- Main process forwards to WebSocket clients
- Client sends response back to main process
- Main process forwards `extension_ui_response` to worker

This preserves all existing extension functionality.

### 6. Memory Allocation
**Decision: Each worker gets 512MB heap limit**

With 6GB total for Pi Web UI:
- Main server process: ~2GB
- Per-worker limit: 512MB (via `--max-old-space=512`)
- Max 8 concurrent workers before hitting limit
- Idle workers cleaned up after 30 minutes

---

## Module Breakdown

### Phase 0: Foundation & Design Documents
**Files:** `docs/process-isolation-design.md`, `shared/protocol-types.ts`
**Tests:** `shared/protocol-types.test.ts`
**Dependencies:** None
**Can be parallelized:** Yes

### Phase 1: Core Infrastructure
#### 1.1 Worker Process Manager (`server/src/workers/session-worker-manager.ts`)
**Files:**
- `server/src/workers/session-worker-manager.ts` (new)
- `server/src/workers/types.ts` (new)
- Tests: `server/tests/unit/workers/session-worker-manager.test.ts`

**Key Functions:**
```typescript
class SessionWorkerManager {
  // Lifecycle
  async spawnWorker(sessionPath: string, options: WorkerOptions): Promise<SessionWorker>
  async terminateWorker(sessionPath: string): Promise<void>
  async restartWorker(sessionPath: string): Promise<SessionWorker>
  
  // Status
  getWorker(sessionPath: string): SessionWorker | undefined
  getWorkerStatus(sessionPath: string): WorkerStatus
  getAllWorkers(): Map<string, SessionWorker>
  
  // Communication
  async sendCommand(sessionPath: string, command: RPCCommand): Promise<RPCResponse>
  broadcastEvent(sessionPath: string, event: AgentEvent): void
}
```

**Dependencies:** None
**Can be parallelized:** No (foundation for all other modules)

#### 1.2 RPC Protocol Bridge (`server/src/workers/rpc-protocol-bridge.ts`)
**Files:**
- `server/src/workers/rpc-protocol-bridge.ts` (new)
- Tests: `server/tests/unit/workers/rpc-protocol-bridge.test.ts`

**Key Functions:**
```typescript
class RPCProtocolBridge {
  // JSONL parsing (from Pi SDK stdout)
  parseRPCLine(line: string): RPCEvent | RPCResponse | ExtensionUIRequest
  
  // Command formatting (to Pi SDK stdin)
  formatRPCCommand(command: InternalCommand): string
  
  // Event normalization (RPC → Internal format)
  normalizeEvent(rpcEvent: RPCEvent): NormalizedEvent
  
  // Extension UI bridging
  bridgeExtensionUI(request: ExtensionUIRequest): WebSocketNotification
  formatExtensionUIResponse(response: UIClientResponse): string
}
```

**Dependencies:** Phase 1.1
**Can be parallelized:** No

### Phase 2: Worker Infrastructure
#### 2.1 Session Worker Process (`server/src/workers/session-worker.ts`)
**Files:**
- `server/src/workers/session-worker.ts` (new)
- Tests: `server/tests/unit/workers/session-worker.test.ts`

**Key Functions:**
```typescript
class SessionWorker {
  // Spawn worker process with Pi SDK RPC mode
  async spawn(sessionPath: string, options: WorkerOptions): Promise<void>
  
  // Send command to worker via stdin
  async sendCommand(command: RPCCommand): Promise<void>
  
  // Read events from worker stdout (JSONL)
  async *readEvents(): AsyncGenerator<RPCEvent>
  
  // Graceful shutdown
  async terminate(): Promise<void>
  
  // Restart worker (keep session)
  async restart(): Promise<void>
}
```

**Worker spawn command:**
```bash
pi --mode rpc --session <sessionPath> --thinking <level> --model <model>
```

**Dependencies:** Phase 1.1

#### 2.2 Worker Pool (`server/src/workers/worker-pool.ts`)
**Files:**
- `server/src/workers/worker-pool.ts` (new)
- Tests: `server/tests/unit/workers/worker-pool.test.ts`

**Key Functions:**
```typescript
class WorkerPool {
  // Get or create worker for session
  async getOrCreate(sessionPath: string): Promise<SessionWorker>
  
  // Remove idle workers
  cleanupIdle(maxIdleMs: number): number
  
  // Get pool statistics
  getStats(): { active: number; idle: number; total: number }
  
  // Shutdown all workers
  async shutdownAll(): Promise<void>
}
```

**Dependencies:** Phase 1.1
**Can be parallelized:** Yes

#### 2.3 Session RPC Client (`server/src/workers/session-rpc-client.ts`)
**Files:**
- `server/src/workers/session-rpc-client.ts` (new)
- Tests: `server/tests/unit/workers/session-rpc-client.test.ts`

**Key Functions:**
```typescript
class SessionRPCClient {
  // High-level API matching RpcClient from SDK
  async prompt(message: string): Promise<void>
  async steer(message: string): Promise<void>
  async abort(): Promise<void>
  async compact(): Promise<CompactionResult>
  async getState(): Promise<RpcSessionState>
  
  // Event subscription
  subscribe(handler: (event: NormalizedEvent) => void): () => void
}
```

**Dependencies:** Phase 1.2, Phase 2.1
**Can be parallelized:** Yes

### Phase 3: WebSocket Integration
#### 3.1 Session WebSocket Handler (`server/src/websocket/session-websocket.ts`)
**Files:**
- `server/src/websocket/session-websocket.ts` (new)
- Tests: `server/tests/unit/websocket/session-websocket.test.ts`
**Dependencies:** Phase 2
**Can be parallelized:** No

#### 3.2 Legacy Compatibility Layer (`server/src/websocket/legacy-connection.ts`)
**Files:**
- `server/src/websocket/legacy-connection.ts` (modify - wrap in adapter)
- Tests: `server/tests/unit/websocket/legacy-connection.test.ts` (existing)
**Dependencies:** None
**Can be parallelized:** No

### Phase 4: Event Translation Layer
#### 4.1 EventNormalizer (`server/src/workers/event-normalizer.ts`)
**Files:**
- `server/src/workers/event-normalizer.ts` (new)
- Tests: `server/tests/unit/workers/event-normalizer.test.ts`
**Dependencies:** Phase 1.2, Phase 3.1
**Can be parallelized:** No

#### 4.2 JSON-RPC to RPC Converter (`server/src/workers/json-rpc-to-rpc-converter.ts`)
**Files:**
- `server/src/workers/json-rpc-to-rpc-converter.ts` (new)
- Tests: `server/tests/unit/workers/json-rpc-to-rpc-converter.test.ts`
**Dependencies:** Phase 3.1
**Can be parallelized:** Yes

### Phase 5: API Layer Updates
#### 5.1 Session Routes (`server/src/routes/sessions.ts`)
**Files:**
- `server/src/routes/sessions.ts` (modify - wrap in adapter)
    Tests: `server/tests/unit/routes/sessions.test.ts` (existing)
**Dependencies:** None
**Can be parallelized:** No

#### 5.2 Health Routes (`server/src/routes/health.ts`)
**Files:**
- `server/src/routes/health.ts` (modify - add readiness check)
    Tests: `server/tests/unit/routes/health.test.ts` (existing)
**Dependencies:** None
**Can be parallelized:** No

### Phase 6: Client State Updates
#### 6.1 Session Store Refactor (`client/src/store/sessionStore.ts`)
**Files:**
- `client/src/store/sessionStore.ts` (major refactor)
- `client/tests/unit/store/sessionStore.test.tsx` (existing tests)
    `client/tests/unit/hooks/useSessionStream.test.ts` (existing tests)
**Dependencies:** Phase 1.2, Phase 3, Phase 4
**Can be parallelized:** Yes

#### 6.2 WebSocket Client Refactor (`client/src/lib/websocket.ts`)
**Files:**
- `client/src/lib/websocket.ts` (major refactor)
    Tests: `client/tests/unit/lib/websocket.test.ts`
    `client/tests/unit/hooks/useSessionStream.test.ts`
**Dependencies:** Phase 1.1, Phase 2.1
**Can be parallelized:** Yes

#### 6.3 Chat Components Update (`client/src/components/Chat/`)
**Files:**
- `client/src/components/Chat/MessageBubble.tsx` (update for virtualized list)
    `client/src/components/Chat/VirtualizedMessageList.tsx` (update for new ref-based streaming)
    `client/src/components/Chat/ChatInput.tsx` (update for mobile)
    Tests: `client/tests/unit/components/Chat/*.tsx`
    `client/tests/unit/hooks/useSessionStream.test.ts`
**Dependencies:** Phase 3, Phase 4, Phase 5
**Can be parallelized:** Yes

#### 6.4 UI Components Update (`client/src/components/ui/`)
**Files:**
- `client/src/components/ui/StatusIndicator.tsx` (update for process status display)
    Tests: `client/tests/unit/components/ui/*.tsx`
**Dependencies:** Phase 3, Phase 4.1
**Can be parallelized:** Yes

#### 6.5 Sidebar Updates (`client/src/components/Sidebar.tsx`)
**Files:**
- `client/src/components/Sidebar.tsx` (update for process status in sidebar)
    Tests: `client/tests/unit/components/Sidebar.test.tsx`
**Dependencies:** Phase 3, Phase 4.2
**Can be parallelized:** Yes

### Phase 7: Integration Testing
#### 7.1 Integration Tests (`server/tests/integration/process-isolation.test.ts`)
**Files:**
- `server/tests/integration/process-isolation.test.ts` (new)
**Dependencies:** Phase 1, Phase 2, Phase 7, Phase 8, Phase 5, Phase 6
**Can be parallelized:** Yes

#### 7.2 E2E Session Tests (`client/e2e/session.test.ts`)
**Files:**
- `client/e2e/session.test.ts` (new)
- Tests: `client/tests/e2e/*.test.ts` (new)
**Dependencies:** Phase 1, Phase 2
**Can be parallelized:** Yes

#### 7.3 Performance Tests
**Files:**
- `client/tests/performance/message-rendering.test.ts` (new)
- Tests: `client/tests/performance/*.test.ts` (new)
**Dependencies:** Phase 1, Phase 6
**Can be parallelized:** No

### Phase 8: Documentation and Deployment
#### 8.1 Update Documentation
**Files:**
- `docs/PROCESS-isolation-design.md` (update)
- `README.md` (update architecture section)
    `DEPLOYMENT.md` (update for new architecture)
    Tests: manual deployment test
**Dependencies:** All previous phases
**Can be parallelized:** Yes

#### 8.2 Update Deployment Config
**Files:**
- `systemd/systemd/pi-web-ui.service` (update)
    `nginx` config (if needed)
    Tests: manual deployment test
**Dependencies:** Phase 8.1
**Can be parallelized:** No

---

## Git Strategy

### Granular Commit Strategy
Each module gets its own commit with clear dependency tracking.

**Commit Message Format:**
```
<type>(module): <short description>

- feat(worker): implement session worker process manager
- refactor(session-worker): extract to separate module
- feat(rpc-bridge): add JSON-RPC protocol bridge
- feat(session-worker): implement isolated session worker
- feat(worker-pool): manage worker lifecycle
- feat(session-rpc-client): add RPC client for worker
- feat(event-normalizer): normalize events from Pi SDK
- test(session): verify event filtering

- refactor(event-forwarder): extract event normalization logic
- test(session-worker): test worker lifecycle
- test(rpc-bridge): test JSON-RPC protocol bridge
    test(event-normalizer): test event normalization
- test(process-isolation): test process crash recovery
- test(process-isolation): test that worker crashes don affect other sessions
    test(multi-session): verify sessions continue in background
- test(mobile-friendly-ui): verify mobile responsiveness
- test(performance): verify message rendering performance
```

---

## Edge Cases

| Area | Mitigation |
|------|----------------------------------------------------------------------------------------------------------------------------------|
| Worker OOM kills session, only that worker crashes | other sessions continue | file-based sessions continue | WebSocket reconnection | history replay |
| Memory usage is lower per worker |
    Mobile performance is maintained |
    Extension UI protocol preserved |
    UI message filtering preserved |
    Existing features preserved |

---

## Summary

- **Memory Is isolated per worker** reducing impact on main server crash
- **Crash recovery** is automatic (worker restart, WebSockets reconnect)
- **Scalability** is improved through OS-level memory management
- **Persistent multisession** background sessions continue via file-based session files
- **Mobile-friendly UI** is maintained with JSON-RPC, per-session WebSockets, LRU cache, virtualized scrolling

- All existing features (filtering, verbosity adjustments, persistent multisession, extension UI protocol) slash commands, etc.) are preserved.

