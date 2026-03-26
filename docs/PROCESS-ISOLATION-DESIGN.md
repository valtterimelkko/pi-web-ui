# Process Isolation Design Document

> Architecture design for the Pi Web UI process-per-session implementation

## Executive Summary

This document describes the design and implementation of the process-per-session architecture for Pi Web UI. This architecture transforms the system from a single-process model to a multi-process model where each AI session runs in its own isolated Node.js worker process.

## Table of Contents

1. [Motivation](#motivation)
2. [Architecture Overview](#architecture-overview)
3. [Design Decisions](#design-decisions)
4. [RPC Protocol Bridge](#rpc-protocol-bridge)
5. [Worker Pool Configuration](#worker-pool-configuration)
6. [Worker Lifecycle](#worker-lifecycle)
7. [Event Flow](#event-flow)
8. [Memory Management](#memory-management)
9. [Failure Handling](#failure-handling)
10. [Security Considerations](#security-considerations)

---

## Motivation

### The Problem

The original single-process architecture had critical limitations:

1. **Memory Accumulation**: Memory grew at ~200MB/30s during streaming until hitting the 1.5GB heap limit
2. **Crash Vulnerability**: A single OOM crash would restart the entire server, losing all active sessions
3. **GC Unpredictability**: V8 garbage collection pauses caused latency spikes during high-load periods
4. **No Isolation**: Memory leaks or infinite loops in one session affected all others

### The Solution

Process-per-session architecture provides:

- **Memory Isolation**: Each session gets its own 512MB heap; one session cannot exhaust memory for others
- **Crash Resilience**: Worker crashes only affect that session; main server and other workers continue
- **OS-Level Management**: Leverages OS process scheduler and memory management instead of V8 GC
- **Scalability**: Independent worker lifecycles allow better resource distribution

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT (React + Vite)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐ │
│  │  WebSocket      │    │ useSessionStream│    │ Zustand Stores          │ │
│  │  Client         │───▶│  Hook           │───▶│ (session, auth, ui)     │ │
│  │  (JSON-RPC 2.0) │    │                 │    │                         │ │
│  └─────────────────┘    └─────────────────┘    └─────────────────────────┘ │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ WebSocket
                                   │ /ws/sessions/:sessionId
┌──────────────────────────────────┼──────────────────────────────────────────┐
│                      MAIN SERVER PROCESS                                     │
├──────────────────────────────────┼──────────────────────────────────────────┤
│                                  │                                          │
│  ┌───────────────────────────────┴───────────────────────────────────────┐  │
│  │                    WebSocket Router                                    │  │
│  │                     (Express + ws)                                     │  │
│  └─────────────────────────────────┬─────────────────────────────────────┘  │
│                                    │                                        │
│  ┌─────────────────────────────────┴─────────────────────────────────────┐  │
│  │                  Session Worker Manager                                │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐ │  │
│  │  │ Worker Pool  │  │ RPC Protocol │  │ Session RPC Client           │ │  │
│  │  │ (lifecycle)  │  │ Bridge       │  │ (high-level API)             │ │  │
│  │  └──────┬───────┘  └──────────────┘  └──────────────────────────────┘ │  │
│  └─────────┼─────────────────────────────────────────────────────────────┘  │
│            │ spawn / stdin / stdout / terminate                             │
│            ▼                                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              WORKER PROCESS POOL (1 process per session)             │   │
│  │                                                                      │   │
│  │   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐                │   │
│  │   │ Worker  │  │ Worker  │  │ Worker  │  │ Worker  │  ...            │   │
│  │   │ (pid:1) │  │ (pid:2) │  │ (pid:3) │  │ (pid:4) │                │   │
│  │   └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘                │   │
│  │        └────────────┴────────────┴────────────┘                      │   │
│  │                     maxWorkers: 15 (configurable)                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Design Decisions

### Decision 1: Worker Communication Strategy

**Decision**: Use Pi SDK's built-in RPC mode with stdin/stdout

**Rationale**:
- Native session resumption with `--session <path>`
- Model/thinking settings persist per session
- Built-in extension UI protocol
- Event streaming via JSONL on stdout
- Command input via JSONL on stdin
- No custom protocol needed

**Spawn Command**:
```bash
pi --mode rpc --session <sessionPath> --thinking <level> --model <model>
```

**Trade-offs**:
- ✅ Simple integration with existing Pi SDK
- ✅ Automatic session persistence
- ✅ Extension protocol works out-of-the-box
- ❌ Requires Node.js subprocess management
- ❌ Slightly higher latency than in-process (acceptable for isolation benefits)

### Decision 2: Protocol Translation Layer

**Decision**: Create an RPC Protocol Bridge to translate between Pi SDK RPC format and internal WebSocket format

**Flow**:
```
Pi SDK RPC (JSONL on stdout)
    ↓
RPCProtocolBridge.parseRPCLine()
    ↓
EventNormalizer (convert to internal format)
    ↓
JSONRPCNotification (wrap for WebSocket)
    ↓
WebSocket client
```

**Rationale**:
- Maintains separation between Pi SDK format and internal format
- Allows for future format changes without affecting client
- Centralizes normalization logic

### Decision 3: Worker Lifecycle Management

**Decision**: Lazy spawn with automatic cleanup

**Policy**:
- Workers spawn on first WebSocket connection to session
- Workers terminate after 30 minutes idle
- Workers restart automatically if crashed while streaming
- Max 15 concurrent workers (configurable)
- Memory limit: 512MB per worker (`--max-old-space-size=512`)

**Rationale**:
- Lazy spawning conserves resources
- Idle timeout prevents zombie workers
- Auto-restart provides resilience
- Memory limit prevents runaway growth

### Decision 4: Session State Persistence

**Decision**: File-based sessions continue regardless of worker state

**Mechanism**:
- Sessions stored in `~/.pi/agent/sessions/` (existing mechanism)
- Workers can be killed and restarted without losing session state
- Model/thinking settings stored in session file
- WebSocket clients reconnect and resume without data loss

**Rationale**:
- Leverages existing Pi SDK session persistence
- Enables "background session" concept
- Worker crashes don't lose conversation history

---

## RPC Protocol Bridge

The RPC Protocol Bridge handles translation between Pi SDK's RPC format and the internal event format used by the WebSocket layer.

### Components

#### 1. Line Parser

Parses JSONL lines from worker stdout:

```typescript
class RPCProtocolBridge {
  parseRPCLine(line: string): RPCEvent | RPCResponse | ExtensionUIRequest {
    const data = JSON.parse(line);
    
    switch (data.type) {
      case 'event':
        return this.parseEvent(data);
      case 'response':
        return this.parseResponse(data);
      case 'extension_ui_request':
        return this.parseExtensionUIRequest(data);
      default:
        throw new Error(`Unknown RPC type: ${data.type}`);
    }
  }
}
```

#### 2. Command Formatter

Formats commands to JSONL for worker stdin:

```typescript
formatRPCCommand(command: InternalCommand): string {
  const rpcCommand = {
    type: 'command',
    method: command.method,
    params: command.params,
    id: generateId()
  };
  return JSON.stringify(rpcCommand) + '\n';
}
```

#### 3. Event Normalizer

Converts Pi SDK RPC events to internal normalized format:

```typescript
normalizeEvent(rpcEvent: RPCEvent): NormalizedEvent {
  switch (rpcEvent.eventType) {
    case 'message_start':
      return { type: 'agent_message_start', ... };
    case 'message_delta':
      return { type: 'agent_message_update', ... };
    case 'tool_execution_start':
      return { type: 'tool_execution_start', ... };
    // ... etc
  }
}
```

#### 4. Extension UI Bridging

Bridges extension UI requests between worker and WebSocket client:

```typescript
// Worker → Client
bridgeExtensionUI(request: ExtensionUIRequest): WebSocketNotification {
  return {
    type: 'extension_ui_request',
    requestId: request.id,
    uiType: request.uiType,  // 'confirm', 'select', 'input', 'editor'
    title: request.title,
    content: request.content,
    options: request.options
  };
}

// Client → Worker
formatExtensionUIResponse(response: UIClientResponse): string {
  return JSON.stringify({
    type: 'extension_ui_response',
    requestId: response.requestId,
    value: response.value,
    cancelled: response.cancelled
  }) + '\n';
}
```

### Message Flow

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   WebSocket     │      │  RPC Protocol    │      │  Worker Process │
│   Client        │◄────►│     Bridge       │◄────►│   (Pi SDK)      │
└─────────────────┘      └──────────────────┘      └─────────────────┘
       │                          │                         │
       │  1. prompt "hello"       │                         │
       │ ────────────────────────►│                         │
       │                          │  2. format to JSONL     │
       │                          │ ───────────────────────►│
       │                          │                         │
       │                          │  3. event stream        │
       │                          │ ◄───────────────────────│
       │                          │  4. parse & normalize   │
       │  5. JSON-RPC notification│                         │
       │ ◄────────────────────────│                         │
       │                          │                         │
```

---

## Worker Pool Configuration

The Worker Pool manages the lifecycle and resource allocation of session worker processes.

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxWorkers` | 15 | Maximum concurrent worker processes |
| `workerMemoryLimitMB` | 512 | Memory limit per worker (Node.js heap) |
| `idleTimeoutMs` | 1800000 (30 min) | Time before idle worker termination |
| `spawnTimeoutMs` | 30000 (30 sec) | Timeout for worker spawn operation |
| `restartDelayMs` | 5000 (5 sec) | Delay before restarting crashed worker |

### Memory Allocation Model

With default settings and 6GB total available:

```
Total System Memory: 6GB
├── Main Server Process: ~2GB
├── Worker Pool (max 15 workers): 15 × 512MB = ~7.5GB (oversubscription OK)
└── OS Buffers: ~512MB
```

**Note**: Memory is oversubscribed because not all workers use their full allocation simultaneously. The OS handles swapping if needed.

### Worker States

```
┌──────────┐    spawn     ┌──────────┐   first    ┌──────────┐
│  IDLE    │─────────────►│ SPAWNING │───────────►│ RUNNING  │
│ (none)   │              │          │  message   │          │
└──────────┘              └──────────┘            └────┬─────┘
                                                      │
                              ┌───────────────────────┼───────┐
                              │                       │       │
                              ▼                       ▼       ▼
                         ┌─────────┐            ┌────────┐ ┌────────┐
                         │STOPPING │            │ IDLE   │ │CRASHED │
                         │         │            │        │ │        │
                         └─────────┘            └───┬────┘ └───┬────┘
                              ▲                     │          │
                              │       timeout       │          │
                              └─────────────────────┘          │
                                                               │ restart
                                                               ▼
                                                         ┌──────────┐
                                                         │RESTARTING│
                                                         └──────────┘
```

### Pool Statistics

```typescript
interface WorkerPoolStats {
  active: number;      // Currently processing requests
  idle: number;        // Running but no active requests
  spawning: number;    // In the process of starting
  stopping: number;    // In the process of terminating
  crashed: number;     // Crashed, awaiting restart
  total: number;       // Total workers in any state
  maxWorkers: number;  // Configured maximum
  queueLength: number; // Requests waiting for available worker
}
```

---

## Worker Lifecycle

### 1. Spawning

```typescript
async spawnWorker(sessionPath: string, options: WorkerOptions): Promise<SessionWorker> {
  // Check pool limits
  if (this.workers.size >= this.config.maxWorkers) {
    throw new WorkerPoolError('Max workers reached');
  }
  
  // Spawn Pi SDK in RPC mode
  const child = spawn('pi', [
    '--mode', 'rpc',
    '--session', sessionPath,
    '--thinking', options.thinkingLevel,
    '--model', options.model
  ], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--max-old-space-size=${this.config.workerMemoryLimitMB}`
    }
  });
  
  // Wait for ready signal
  await this.waitForReady(child, this.config.spawnTimeoutMs);
  
  // Create worker wrapper
  const worker = new SessionWorker(child, sessionPath, options);
  this.workers.set(sessionPath, worker);
  
  return worker;
}
```

### 2. Command Execution

```typescript
async sendCommand(sessionPath: string, command: RPCCommand): Promise<void> {
  const worker = this.workers.get(sessionPath);
  if (!worker) {
    throw new WorkerNotFoundError(sessionPath);
  }
  
  const line = this.rpcBridge.formatRPCCommand(command);
  worker.stdin.write(line);
}
```

### 3. Event Streaming

```typescript
async *readEvents(sessionPath: string): AsyncGenerator<NormalizedEvent> {
  const worker = this.workers.get(sessionPath);
  if (!worker) return;
  
  const rl = createInterface(worker.stdout);
  
  for await (const line of rl) {
    try {
      const rpcEvent = this.rpcBridge.parseRPCLine(line);
      yield this.rpcBridge.normalizeEvent(rpcEvent);
    } catch (err) {
      console.error('Failed to parse RPC line:', err);
    }
  }
}
```

### 4. Termination

```typescript
async terminateWorker(sessionPath: string): Promise<void> {
  const worker = this.workers.get(sessionPath);
  if (!worker) return;
  
  // Try graceful shutdown first
  worker.state = 'stopping';
  await this.sendCommand(sessionPath, { method: 'shutdown' });
  
  // Wait for graceful exit
  const gracefulTimeout = setTimeout(() => {
    // Force kill if not exited gracefully
    worker.process.kill('SIGTERM');
  }, 5000);
  
  await once(worker.process, 'exit');
  clearTimeout(gracefulTimeout);
  
  this.workers.delete(sessionPath);
}
```

### 5. Crash Recovery

```typescript
private handleWorkerCrash(worker: SessionWorker, code: number, signal: string) {
  console.error(`Worker ${worker.sessionPath} crashed: code=${code}, signal=${signal}`);
  
  worker.state = 'crashed';
  worker.crashedAt = Date.now();
  
  // Notify subscribers
  this.emit('worker_crashed', {
    sessionPath: worker.sessionPath,
    code,
    signal,
    willRestart: worker.options.autoRestart
  });
  
  if (worker.options.autoRestart) {
    setTimeout(() => {
      this.restartWorker(worker.sessionPath);
    }, this.config.restartDelayMs);
  }
}
```

---

## Event Flow

### Complete Event Flow

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   Client    │   │  WebSocket  │   │  Worker     │   │  Pi SDK     │
│  (Browser)  │   │  Server     │   │  Process    │   │  (in worker)│
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │                 │
       │  1. Connect     │                 │                 │
       │────────────────►│                 │                 │
       │                 │  2. Spawn       │                 │
       │                 │────────────────►│                 │
       │                 │                 │  3. Start RPC   │
       │                 │                 │────────────────►│
       │                 │                 │  4. Ready       │
       │                 │◄────────────────│◄────────────────│
       │  5. prompt      │                 │                 │
       │────────────────►│                 │                 │
       │                 │  6. Forward     │                 │
       │                 │────────────────►│                 │
       │                 │                 │  7. Process     │
       │                 │                 │────────────────►│
       │                 │                 │                 │
       │                 │                 │◄────────────────│
       │                 │◄────────────────│  8. Events      │
       │◄────────────────│  9. Stream      │                 │
       │  10. Display    │                 │                 │
       │                 │                 │                 │
       │                 │                 │◄────────────────│
       │                 │◄────────────────│  11. Done       │
       │◄────────────────│  12. Complete   │                 │
       │                 │                 │                 │
```

### Event Types

#### From Pi SDK (RPC mode)

| Event Type | Description | Forwarded to Client? |
|------------|-------------|---------------------|
| `session_ready` | Worker initialized and ready | Yes |
| `message_start` | Assistant message starting | Yes |
| `message_delta` | Content chunk (streaming) | Yes |
| `message_end` | Assistant message complete | Yes |
| `tool_execution_start` | Tool execution beginning | Yes |
| `tool_execution_end` | Tool execution complete | Yes |
| `thinking` | Thinking content (if enabled) | Yes |
| `extension_ui_request` | Extension requesting UI | Yes |
| `error` | Error in worker | Yes |

#### To Pi SDK (RPC mode)

| Command | Description |
|---------|-------------|
| `prompt` | Send user message |
| `steer` | Inject follow-up mid-turn |
| `abort` | Cancel current turn |
| `compact` | Trigger context compaction |
| `extension_ui_response` | Respond to extension UI request |
| `shutdown` | Graceful worker shutdown |

---

## Memory Management

### Per-Worker Memory

Each worker process gets:

```
Worker Memory (512MB)
├── V8 Heap (~450MB usable)
│   ├── Session context
│   ├── Tool execution state
│   └── Extension data
├── Native memory (~62MB)
│   ├── HTTP connections
│   ├── File I/O buffers
│   └── Process overhead
└── Reserved for GC
```

### Main Process Memory

```
Main Process Memory (~2GB)
├── HTTP Server & Express (~200MB)
├── WebSocket connections (~50MB per 1000 connections)
├── Worker management (~100MB)
├── Session metadata cache (~500MB for 50 sessions)
└── Event buffers & queues (~200MB)
```

### Memory Monitoring

```typescript
// Worker memory monitoring
setInterval(() => {
  for (const [path, worker] of this.workers) {
    const usage = worker.process.memoryUsage();
    
    if (usage.heapUsed > this.config.workerMemoryLimitMB * 0.9 * 1024 * 1024) {
      console.warn(`Worker ${path} near memory limit`);
      this.emit('worker_memory_warning', { path, usage });
    }
  }
}, 30000);
```

---

## Failure Handling

### Failure Scenarios

| Scenario | Detection | Response | Recovery |
|----------|-----------|----------|----------|
| Worker OOM | Exit code 134 | Log, emit event | Auto-restart (state from file) |
| Worker crash | Exit code != 0 | Log, notify clients | Auto-restart (state from file) |
| Worker hang | No events for 60s | SIGTERM, then SIGKILL | Restart worker |
| Spawn failure | Timeout or error | Log error | Retry with backoff |
| Main process crash | Process exit | N/A | systemd/docker restart |
| WebSocket disconnect | Connection close | Unsubscribe client | Client reconnects |

### Recovery Procedures

#### Worker Restart with State Preservation

```typescript
async restartWorker(sessionPath: string): Promise<SessionWorker> {
  const oldWorker = this.workers.get(sessionPath);
  
  // Get state before terminating
  const state = oldWorker?.getState();
  
  // Terminate old worker
  if (oldWorker) {
    await this.terminateWorker(sessionPath);
  }
  
  // Spawn new worker with same session path
  // Pi SDK automatically loads state from file
  const newWorker = await this.spawnWorker(sessionPath, {
    ...oldWorker?.options,
    model: state?.model,
    thinkingLevel: state?.thinkingLevel
  });
  
  return newWorker;
}
```

#### Client Reconnection

```typescript
// Client reconnects after disconnect
ws.on('connection', async (socket, sessionPath) => {
  // Check if worker exists
  let worker = workerPool.getWorker(sessionPath);
  
  if (!worker || worker.state === 'crashed') {
    // Spawn new worker (state recovered from file)
    worker = await workerPool.spawnWorker(sessionPath, options);
  }
  
  // Subscribe client to worker events
  worker.subscribe(socket);
  
  // Send current state to client
  socket.send({
    type: 'session_event',
    sessionId: sessionPath,
    event: { type: 'worker_reconnected', status: worker.state }
  });
});
```

---

## Security Considerations

### Process Isolation

Workers run with the same privileges as the main process (typically root for Pi SDK access). This is acceptable because:

1. **Same trust boundary**: Workers run the same code (Pi SDK) as the main process
2. **No privilege escalation**: Workers don't have additional capabilities
3. **Resource limits**: Memory limits prevent DoS via excessive allocation

### Input Validation

All commands sent to workers are validated:

```typescript
const commandSchema = z.object({
  method: z.enum(['prompt', 'steer', 'abort', 'compact', 'extension_ui_response', 'shutdown']),
  params: z.record(z.unknown()).optional(),
  id: z.string().optional()
});

function validateCommand(input: unknown): RPCCommand {
  return commandSchema.parse(input);
}
```

### Path Validation

Session paths are validated to prevent directory traversal:

```typescript
function validateSessionPath(requestedPath: string): string | null {
  const sessionsDir = path.resolve(os.homedir(), '.pi/agent/sessions');
  const resolvedPath = path.resolve(sessionsDir, requestedPath);
  
  // Ensure path is within sessions directory
  if (!resolvedPath.startsWith(sessionsDir)) {
    return null; // Path traversal attempt
  }
  
  return resolvedPath;
}
```

### Resource Limits

- **maxWorkers**: Prevents fork bombs
- **workerMemoryLimitMB**: Prevents memory exhaustion
- **spawnTimeoutMs**: Prevents hanging spawn operations

---

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_MAX_WORKERS` | 15 | Maximum concurrent workers |
| `WORKER_MEMORY_LIMIT_MB` | 512 | Memory limit per worker |
| `WORKER_IDLE_TIMEOUT_MS` | 1800000 | Idle timeout (30 min) |
| `WORKER_SPAWN_TIMEOUT_MS` | 30000 | Spawn timeout (30 sec) |
| `WORKER_RESTART_DELAY_MS` | 5000 | Restart delay (5 sec) |
| `WORKER_AUTO_RESTART` | true | Auto-restart crashed workers |

### File Locations

- **Worker Manager**: `server/src/workers/session-worker-manager.ts`
- **Worker Pool**: `server/src/workers/worker-pool.ts`
- **RPC Bridge**: `server/src/workers/rpc-protocol-bridge.ts`
- **Session RPC Client**: `server/src/workers/session-rpc-client.ts`
- **Session Worker**: `server/src/workers/session-worker.ts`
- **Event Normalizer**: `server/src/workers/event-normalizer.ts`
- **Worker Types**: `server/src/workers/types.ts`

---

## Related Documents

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Overall system architecture
- [PROTOCOL.md](./PROTOCOL.md) - WebSocket protocol specification
- [AGENTS.md](../AGENTS.md) - Developer guide with debugging info
- [README.md](../README.md) - User documentation

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024-03-26 | Initial process isolation design document |
