# Modules — Detailed Specifications

Each module below is a self-contained unit of work. Agents should read the "Context" and "Interfaces" sections before starting.

---

## Module 0: pi-claude-channel Plugin

**Agent:** Agent A (Phase 1)
**Location:** `pi-claude-channel/` (new top-level directory in repo root)
**Runtime:** Bun (must use Bun, not Node.js — Claude Code requires Bun for channel plugins)
**Dependencies:** None (fully standalone, testable without Pi Web UI)

### What It Is

A Claude Code channel plugin that bridges interactive Claude Code ↔ Pi Web UI. It is a single Bun process that serves three roles simultaneously:

1. **MCP server on stdio** — Claude Code spawns it and communicates via stdin/stdout
2. **WebSocket server on port 3100** — Pi Web UI connects here
3. **HTTP hook receiver on port 3101** — Claude Code hooks POST tool events here

### Architecture

```
pi-claude-channel/
├── .claude-plugin/
│   └── plugin.json          # Plugin metadata for Claude Code
├── server.ts                 # Main entry point
├── package.json
├── tsconfig.json
└── README.md
```

### `plugin.json`

```json
{
  "name": "pi-claude-channel",
  "version": "1.0.0",
  "description": "Pi Web UI bridge for Claude Code — receives prompts via WebSocket, pushes into Claude, forwards responses and tool events back",
  "author": "Pi Web UI",
  "channel": {
    "entrypoint": "server.ts",
    "runtime": "bun"
  }
}
```

### `package.json`

```json
{
  "name": "pi-claude-channel",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "bun run server.ts",
    "dev": "bun --watch server.ts",
    "typecheck": "bun --check server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["server.ts"]
}
```

### `server.ts` — Full Specification

The server MUST implement these three interfaces simultaneously on a single Bun process:

#### 3a. MCP Server (stdio transport)

**Registered tools** (Claude Code calls these):

```
tool: reply
  parameters: { chat_id: string, text: string }
  behavior: Forwards the text to all WebSocket clients subscribed to chat_id as:
    { type: "message_start", sessionId: chat_id, message: { id, role: "assistant" } }
    { type: "message_update", sessionId: chat_id, message: { id }, 
      assistantMessageEvent: { type: "text_delta", delta: text } }
    { type: "message_end", sessionId: chat_id, message: { id } }
    Also appends to the in-memory history buffer for that session.

tool: status
  parameters: { chat_id: string, status: string, detail?: string }
  behavior: Forwards to WebSocket clients as:
    { type: "status", sessionId: chat_id, status, detail }

tool: fetch_history
  parameters: { session_id: string, limit?: number }
  behavior: Returns the in-memory history buffer for the session.

tool: request_permission
  parameters: { chat_id: string, request_id: string, tool_name: string, description: string, args: unknown }
  behavior: Forwards to WebSocket as permission_request. Sets up a pending promise
           that resolves when the client sends permission_response.

tool: send_event
  parameters: { chat_id: string, event_type: string, event_data: Record<string, unknown> }
  behavior: Generic event forwarding. Converts to Pi-compatible event and broadcasts.
```

**Channel notification pushes** (Plugin → Claude Code):

When a WebSocket client sends a prompt, the plugin pushes it into Claude Code as a channel notification with content: the user's prompt text. The notification format follows the [Channels reference](https://code.claude.com/docs/en/channels-reference):
- Use `server.notification()` from `@modelcontextprotocol/sdk`
- The notification method is `notifications/message`
- Parameters include the message text and sender info

#### 3b. WebSocket Server (port 3100, bound to 127.0.0.1)

**Client → Server messages:**

```typescript
{ type: "prompt", sessionId: string, content: string, cwd?: string }
  → Pushes as channel notification into Claude Code
  → Emits agent_start to WebSocket clients
  → Emits session_status: "streaming"

{ type: "abort", sessionId: string }
  → Forwards abort signal (best effort — interactive mode SIGTERM on stdin)

{ type: "permission_response", requestId: string, allowed: boolean }
  → Resolves the pending permission promise
  → Returns result to Claude via MCP tool response

{ type: "fetch_history", sessionId: string, limit?: number }
  → Returns buffered history events for the session

{ type: "set_model", sessionId: string, model: string }
  → Stores model preference (passed to Claude on next prompt)
```

**Server → Client events** (exact Pi Web UI format):

```typescript
// These MUST match exactly what connection.ts expects:

{ type: "session_init", sessionId, model, cwd, tools, timestamp }
{ type: "agent_start", sessionId, timestamp }
{ type: "message_start", sessionId, message: { id, role } }
{ type: "message_update", sessionId, message: { id }, 
  assistantMessageEvent: { type: "text_delta", delta } }
{ type: "message_end", sessionId, message: { id } }
{ type: "tool_execution_start", sessionId, toolCallId, toolName, args, timestamp }
{ type: "tool_execution_end", sessionId, toolCallId, result, isError, timestamp }
{ type: "agent_end", sessionId, result, usage, timestamp }
{ type: "rate_limit", sessionId, status, rateLimitType, isUsingOverage, resetsAt }
{ type: "permission_request", sessionId, requestId, toolName, description, args }
{ type: "session_status", sessionId, status: "idle"|"busy"|"streaming"|"error" }
{ type: "history", sessionId, events: Array<NormalizedEvent> }
{ type: "error", sessionId, message, code? }
```

**History buffer:**
- In-memory Map<string, Array> keyed by sessionId
- Each array holds events in order
- `fetch_history` returns up to `limit` events from the buffer
- Buffer is cleared on plugin restart (session replay comes from JSONL, not the buffer)

**Session multiplexing:**
- Multiple Pi Web UI clients can connect with different sessionId query params: `ws://127.0.0.1:3100?session=abc123`
- Events for a session are broadcast to ALL clients connected with that sessionId
- A session without connected clients for 30 minutes has its buffer pruned

#### 3c. HTTP Hook Receiver (port 3101, bound to 127.0.0.1)

Endpoints that Claude Code hooks POST to:

```
POST /hook/session-start
  Body: { session_id, model, cwd, tools, timestamp }
  → Emits session_init via WebSocket

POST /hook/post-tool-use
  Body: { session_id, tool_name, tool_input, tool_output, tool_call_id, 
          tool_error?, timestamp }
  → If tool_output: emits tool_execution_start + tool_execution_end via WebSocket
  → If tool_error: emits tool_execution_end with isError: true
  → Appends to history buffer

POST /hook/stop
  Body: { session_id, usage: { input_tokens, output_tokens, cache_read, cache_write }, 
          stop_reason, timestamp }
  → Emits agent_end via WebSocket with usage data
  → Emits session_status: "idle"

POST /hook/user-prompt
  Body: { session_id, prompt_text, timestamp }
  → Emits agent_start via WebSocket
  → Appends user message to history buffer
```

Hook bodies arrive as JSON. The plugin validates, normalizes, and broadcasts.

### Testing Module 0

Module 0 is testable WITHOUT Pi Web UI or Claude Code:

1. **Unit test the WebSocket server:**
   - Start the plugin
   - Connect a WS client, send a prompt
   - Verify the prompt is pushed as MCP notification (mock the stdio)
   - Send tool events via HTTP endpoint, verify WebSocket broadcasts
   - Test session multiplexing: connect two clients with same sessionId, verify both receive events

2. **Unit test the MCP server:**
   - Use `@modelcontextprotocol/sdk` client to connect via stdio
   - Call `status` tool, verify it broadcasts via WebSocket
   - Call `reply` tool, verify message events

3. **Test with fakechat simulator:**
   - Claude Code ships a `fakechat` channel for testing
   - Start `claude --channels plugin:fakechat` to verify channel architecture works
   - Then swap in pi-claude-channel

### Environment Variables

```
CLAUDE_CHANNEL_WS_PORT=3100       # WebSocket server port
CLAUDE_CHANNEL_HOOK_PORT=3101     # HTTP hook receiver port
```

---

## Module 1: claude-channel-process-manager.ts

**Agent:** Agent D (Phase 2)
**Location:** `server/src/claude/claude-channel-process-manager.ts`
**Depends On:** Module 0 (plugin exists; port numbers known)
**Dependencies:** `child_process`, config module

### Interface

```typescript
export interface ChannelProcessState {
  process: ChildProcess | null;
  status: 'stopped' | 'starting' | 'running' | 'error';
  startedAt: number | null;
  error?: string;
}

export class ClaudeChannelProcessManager {
  constructor(cfg: {
    pluginDir: string;          // Path to pi-claude-channel/
    wsPort: number;              // WebSocket port (3100)
    hookPort: number;            // HTTP hook port (3101)
    cwd: string;                 // Working directory for Claude
    claudePath?: string;        // Path to Claude binary (default: 'claude')
    permissionMode?: string;    // 'acceptEdits' | 'dontAsk' | 'default'
  });

  // Start Claude Code with the channel plugin
  async start(): Promise<void>;
  
  // Stop Claude Code gracefully (SIGTERM, then SIGKILL after timeout)
  async stop(): Promise<void>;
  
  // Check if process is alive
  isRunning(): boolean;
  
  // Get current state
  getState(): ChannelProcessState;
  
  // Wait for the MCP channel to be ready (WebSocket connectable)
  async waitForReady(timeoutMs?: number): Promise<void>;
  
  // Health check — returns true if WS is connectable and Claude is alive
  async healthCheck(): Promise<boolean>;
}
```

### Implementation Details

**Start:**
```typescript
async start(): Promise<void> {
  // 1. Validate plugin exists at pluginDir
  // 2. Build CLI args:
  //    claude --channels plugin:pi-claude-channel
  //           --plugin-dir <pluginDir>
  //           --permission-mode acceptEdits
  //           (if development: --dangerously-load-development-channels)
  // 3. Set env: CLAUDE_CHANNEL_WS_PORT, CLAUDE_CHANNEL_HOOK_PORT
  // 4. Spawn as child_process with stdio: ['pipe', 'pipe', 'pipe']
  // 5. Monitor stdout/stderr for startup confirmation
  // 6. Poll WebSocket port until connectable (max 30s)
  // 7. Set status: 'running'
}
```

**Stop:**
```typescript
async stop(): Promise<void> {
  // 1. Send SIGTERM to Claude process
  // 2. Wait up to 10s for clean exit
  // 3. If still alive, send SIGKILL
  // 4. Wait for 'exit' event
  // 5. Set status: 'stopped'
}
```

**Stdout monitoring:**
- Claude Code interactive mode outputs terminal-formatted text
- Parse for error patterns (rate limits, auth failures)
- If `rate_limit_event` patterns detected, emit warning

**Stderr monitoring:**
- Log all stderr output
- Detect fatal errors (auth failures, permission denied)

### Testing

```typescript
// server/tests/unit/claude/claude-channel-process-manager.test.ts

describe('ClaudeChannelProcessManager', () => {
  it('should start Claude with channel plugin flags');
  it('should detect when WS port becomes connectable');
  it('should gracefully stop on SIGTERM');
  it('should force kill after timeout');
  it('should report errors from stderr');
  it('should handle missing plugin directory');
  it('should handle Claude binary not found');
});
```

---

## Module 2: claude-channel-ws-client.ts

**Agent:** Agent B (Phase 1)
**Location:** `server/src/claude/claude-channel-ws-client.ts`
**Depends On:** None (only needs the protocol spec from Module 0)
**Dependencies:** `ws` (already in server deps), EventEmitter pattern

### Interface

```typescript
export type ChannelEventType =
  | 'session_init'
  | 'agent_start'
  | 'agent_end'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'tool_execution_start'
  | 'tool_execution_end'
  | 'permission_request'
  | 'rate_limit'
  | 'session_status'
  | 'error'
  | 'history';

export interface ChannelEvent {
  type: ChannelEventType;
  sessionId: string;
  [key: string]: unknown;
}

export interface ChannelPromptRequest {
  type: 'prompt';
  sessionId: string;
  content: string;
  cwd?: string;
}

export interface ChannelAbortRequest {
  type: 'abort';
  sessionId: string;
}

export interface ChannelPermissionResponse {
  type: 'permission_response';
  requestId: string;
  allowed: boolean;
}

export type ChannelClientRequest =
  | ChannelPromptRequest
  | ChannelAbortRequest
  | ChannelPermissionResponse
  | { type: 'fetch_history'; sessionId: string; limit?: number }
  | { type: 'set_model'; sessionId: string; model: string };

export class ClaudeChannelWsClient extends EventEmitter {
  constructor(url: string, options?: {
    reconnectDelay?: number;       // Default: 1000ms
    maxReconnectDelay?: number;    // Default: 30000ms
    reconnect?: boolean;           // Default: true
    heartbeatInterval?: number;    // Default: 30000ms
  });

  // Connect to plugin's WebSocket server
  async connect(): Promise<void>;
  
  // Disconnect and stop reconnecting
  disconnect(): void;
  
  // Send a message to the plugin
  send(message: ChannelClientRequest): void;
  
  // Check connection state
  isConnected(): boolean;
  
  // Events emitted:
  //   'event' → ChannelEvent
  //   'connected' → void
  //   'disconnected' → void
  //   'error' → Error
  
  // Type-safe event listeners:
  onEvent(handler: (event: ChannelEvent) => void): void;
  onConnected(handler: () => void): void;
  onDisconnected(handler: () => void): void;
  onError(handler: (err: Error) => void): void;
}
```

### Implementation Details

- **Reconnect:** Exponential backoff with jitter. Max delay 30s, initial 1s.
- **Heartbeat:** Ping every 30s. If no pong within 10s, disconnect and reconnect.
- **Message validation:** Validate incoming JSON against expected event shapes before emitting.
- **Queueing:** If disconnected, queue outgoing messages. Flush on reconnect (max 100 queued).
- **Error handling:** Parse error responses from plugin and emit as error events.

### Testing

```typescript
// server/tests/unit/claude/claude-channel-ws-client.test.ts

describe('ClaudeChannelWsClient', () => {
  // Use a mock WS server for testing

  it('should connect and emit connected event');
  it('should send prompt messages as JSON');
  it('should receive and parse incoming JSON events');
  it('should emit typed events via onEvent');
  it('should queue messages while disconnected');
  it('should flush queue on reconnect');
  it('should reconnect with exponential backoff');
  it('should stop reconnecting after disconnect() called');
  it('should handle malformed JSON gracefully');
  it('should ping/pong for heartbeat');
  it('should disconnect on heartbeat timeout');
});
```

---

## Module 3: claude-channel-event-adapter.ts

**Agent:** Agent C (Phase 1)
**Location:** `server/src/claude/claude-channel-event-adapter.ts`
**Depends On:** None (only needs NormalizedEvent type from shared package)
**Dependencies:** `@pi-web-ui/shared`

### Interface

```typescript
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { ChannelEvent } from './claude-channel-ws-client.js';

export class ClaudeChannelEventAdapter {
  /**
   * Convert a raw ChannelEvent from the plugin WebSocket into one or more
   * NormalizedEvent objects. The resulting NormalizedEvents are IDENTICAL
   * in shape to those produced by ClaudeEventNormalizer.normalize().
   */
  normalize(event: ChannelEvent, timestamp?: number): NormalizedEvent[];

  /**
   * Convert a normalized event back to the format expected by the
   * frontend sessionStore via WebSocket session_event messages.
   * (This is the same transformation done by normEventToPiFormat in connection.ts.)
   */
  toPiFormat(event: NormalizedEvent): Record<string, unknown>;
}
```

### Event Mapping Table

| Plugin WebSocket Event | → NormalizedEvent(s) |
|---|---|
| `session_init` | `{ type: 'session_init', data: { tools, model, sessionId, cwd, permissionMode } }` |
| `agent_start` | `{ type: 'agent_start', data: { sessionId } }` |
| `message_start` | `{ type: 'message_start', data: { id: message.id, role: message.role } }` |
| `message_update` | `{ type: 'message_update', data: { id: message.id, assistantMessageEvent: { type: 'text_delta', delta } } }` |
| `message_end` | `{ type: 'message_end', data: { id: message.id } }` |
| `tool_execution_start` | `{ type: 'tool_execution_start', data: { toolCallId, toolName, args } }` |
| `tool_execution_end` | `{ type: 'tool_execution_end', data: { toolCallId, result, isError } }` |
| `agent_end` | `{ type: 'agent_end', data: { result, usage } }` |
| `rate_limit` | `{ type: 'rate_limit', data: { status, rateLimitType, isUsingOverage, resetsAt } }` |
| `permission_request` | `{ type: 'permission_request', data: { requestId, toolName, description, args, sessionId } }` |
| `session_status` | `{ type: 'session_status', data: { status } }` (internal use) |
| `error` | `{ type: 'error', data: { message, code } }` |

### Implementation Notes

- `normalize()` must produce the EXACT same NormalizedEvent shapes as `ClaudeEventNormalizer.normalize()`
- Timestamps: use event-level timestamps if present, otherwise fall back to `Date.now()`
- Unknown event types: emit as `{ type: 'claude_channel_raw', data: event }` for forward compatibility
- The adapter is stateless — a new instance per event is fine, or a singleton

### Testing

```typescript
// server/tests/unit/claude/claude-channel-event-adapter.test.ts

describe('ClaudeChannelEventAdapter', () => {
  describe('normalize', () => {
    it('should convert session_init correctly');
    it('should convert agent_start correctly');
    it('should convert message_start/message_update/message_end correctly');
    it('should convert tool_execution_start correctly');
    it('should convert tool_execution_end with result correctly');
    it('should convert tool_execution_end with error correctly');
    it('should convert agent_end with usage stats correctly');
    it('should convert rate_limit correctly');
    it('should convert permission_request correctly');
    it('should pass through unknown event types');
    it('should use event timestamp when provided');
    it('should fall back to Date.now() when no timestamp');
  });

  describe('toPiFormat', () => {
    it('should produce format identical to normEventToPiFormat in connection.ts');
  });
});

// CRITICAL TEST: Compare adapter output with ClaudeEventNormalizer output
describe('Cross-adapter compatibility', () => {
  it('should produce identical NormalizedEvent shapes to ClaudeEventNormalizer');
});
```

---

## Module 4: claude-channel-service.ts

**Agent:** Agent F (Phase 3)
**Location:** `server/src/claude/claude-channel-service.ts`
**Depends On:** Modules 1, 2, 3 (Process Manager, WS Client, Event Adapter)
**Dependencies:** `claude-session-store.ts`, `session-registry.ts`, `config.ts`

### Interface

```typescript
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { ClaudeAuthStatus } from './claude-service.js';

export class ClaudeChannelService {
  constructor(cfg: {
    claudeSessionDir: string;
    registryPath: string;
    pluginDir: string;
    wsPort: number;
    hookPort: number;
    cwd: string;
  });

  // ── Lifecycle ───────────────────────────────────────────────

  /** Start the Claude process + connect WebSocket + wire events */
  async start(): Promise<void>;

  /** Stop gracefully */
  async stop(): Promise<void>;

  /** Health check — is Claude running and WS connected? */
  async isHealthy(): Promise<boolean>;

  // ── Session Lifecycle ──────────────────────────────────────

  /** Create a new session (allocates IDs, registers in registry, init JSONL) */
  async createSession(cwd: string, model?: string): Promise<{
    sessionId: string;
    claudeSessionId: string;
  }>;

  // ── Prompt Execution ───────────────────────────────────────

  /** Send a prompt to a session. Streams NormalizedEvents via onEvent. */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<void>;

  // ── Control ─────────────────────────────────────────────────

  /** Abort the running prompt for a session */
  abort(sessionId: string): void;

  /** Return true if a prompt is currently running for the session */
  isRunning(sessionId: string): boolean;

  // ── History & Info ─────────────────────────────────────────

  /** Load session history from JSONL */
  async loadSessionHistory(sessionId: string): Promise<ClaudeMessageEntry[]>;

  /** Set model for a session */
  async setModel(sessionId: string, model: string): Promise<string>;

  /** Get session from registry */
  async getSession(sessionId: string): Promise<SessionRegistryEntry | null>;

  /** List all Claude sessions */
  async listSessions(): Promise<SessionRegistryEntry[]>;

  /** Build session stats */
  async getSessionStats(sessionId: string): Promise<SessionStats | null>;

  // ── Pinning (mirrors ClaudeService) ─────────────────────────

  pinSession(sessionId: string): boolean;
  unpinSession(sessionId: string): boolean;
  isSessionPinned(sessionId: string): boolean;
  hasSession(sessionId: string): boolean;

  // ── Auth ────────────────────────────────────────────────────

  async validateAuth(): Promise<ClaudeAuthStatus>;
  async isAvailable(): Promise<boolean>;
}
```

### Implementation Details

**`start()` — Initialization sequence:**
1. Write hooks config to `~/.claude/settings.json` via `ClaudeChannelHooksConfig` (Module 9)
2. Start the Claude Code process via `ClaudeChannelProcessManager.start()`
3. Wait for Claude Code to be ready (WebSocket port connectable)
4. Connect `ClaudeChannelWsClient` to `ws://127.0.0.1:{wsPort}`
5. Wire up event handler:
   ```
   wsClient.onEvent((channelEvent) => {
     const normalizedEvents = eventAdapter.normalize(channelEvent);
     for (const ne of normalizedEvents) {
       // Route to the correct session's onEvent callback
       const pending = pendingPrompts.get(ne.sessionId);
       if (pending) pending.onEvent(ne);
       // Persist to JSONL
       this.persistEvent(ne.sessionId, ne);
     }
   });
   ```
6. Periodically check health (every 30s); auto-restart if Claude dies

**`sendPrompt()` — Prompt flow:**
1. Look up session in registry
2. Persist user message to JSONL
3. Update registry status to 'running'
4. Emit `agent_start` via onEvent
5. Register the onEvent callback in `pendingPrompts` map
6. Send prompt via `wsClient.send({ type: 'prompt', sessionId, content: prompt, cwd })`
7. When `agent_end` arrives (or error), resolve the pending prompt, call onComplete

**`persistEvent()` — Same logic as current ClaudeService:**
```typescript
private async persistEvent(sessionId: string, event: NormalizedEvent): Promise<void> {
  // Identical switch statement to ClaudeService.persistEvent():
  //   message_update → appendEntry type: 'assistant'
  //   tool_execution_start → appendEntry type: 'tool'
  //   tool_execution_end → appendEntry type: 'tool_result'
  //   agent_end → appendEntry type: 'meta' with usage
}
```

### Testing

```typescript
// server/tests/unit/claude/claude-channel-service.test.ts

describe('ClaudeChannelService', () => {
  describe('start', () => {
    it('should write hooks config before starting Claude');
    it('should start process manager');
    it('should connect WS client');
    it('should wire up event handler');
    it('should throw if Claude fails to start');
    it('should auto-restart if Claude dies');
  });

  describe('sendPrompt', () => {
    it('should persist user message to JSONL');
    it('should send prompt via WS client');
    it('should emit agent_start before sending');
    it('should route events to correct session callback');
    it('should persist tool events to JSONL');
    it('should emit agent_end and call onComplete');
    it('should handle errors and call onComplete with error');
    it('should update registry status');
  });

  describe('abort', () => {
    it('should send abort via WS client');
    it('should resolve pending prompt');
  });

  describe('session lifecycle', () => {
    it('should create sessions with unique IDs');
    it('should register sessions in registry');
    it('should initialize JSONL file');
    it('should load history from JSONL');
    it('should set model');
  });

  describe('pinning', () => {
    it('should pin sessions');
    it('should unpin sessions');
    it('should enforce max pinned limit');
    it('should check if session is pinned');
  });
});
```

---

## Module 5: ClaudeService Refactor

**Agent:** Agent G (Phase 4)
**Location:** `server/src/claude/claude-service.ts` (modify existing)
**Depends On:** Module 4 (ClaudeChannelService)

### Changes

Add a `CLAUDE_CHANNEL_ENABLED` config flag. When enabled, delegate to `ClaudeChannelService`. When disabled, use existing `ClaudeProcessPool` path.

```typescript
// In ClaudeService constructor:
constructor(cfg: {
  claudeSessionDir: string;
  registryPath: string;
  maxProcesses?: number;
  // NEW:
  useChannel?: boolean;          // Default: false (opt-in)
  channelPluginDir?: string;     // Path to pi-claude-channel/
  channelWsPort?: number;        // Default: 3100
  channelHookPort?: number;      // Default: 3101
}) {
  if (cfg.useChannel && cfg.channelPluginDir) {
    this.channelService = new ClaudeChannelService({
      claudeSessionDir: cfg.claudeSessionDir,
      registryPath: cfg.registryPath,
      pluginDir: cfg.channelPluginDir,
      wsPort: cfg.channelWsPort ?? 3100,
      hookPort: cfg.channelHookPort ?? 3101,
      cwd: process.cwd(),
    });
  }
  // Keep existing process pool for fallback
  this.processPool = new ClaudeProcessPool(cfg.maxProcesses ?? 10);
  // ...
}

// Add a start() method that initializes the channel:
async startChannel(): Promise<void> {
  if (this.channelService) {
    await this.channelService.start();
  }
}
```

All existing public methods (`createSession`, `sendPrompt`, `abort`, etc.) check `this.channelService` and delegate:

```typescript
async sendPrompt(
  sessionId: string,
  prompt: string,
  onEvent: (event: NormalizedEvent) => void,
  onComplete: (error?: Error) => void,
): Promise<void> {
  if (this.channelService?.isHealthy()) {
    return this.channelService.sendPrompt(sessionId, prompt, onEvent, onComplete);
  }
  // Fallback to claude -p path
  // ... existing implementation ...
}
```

### Config changes (`server/src/config.ts`)

```typescript
// NEW config fields:
export const config = {
  // ... existing ...
  claudeChannelEnabled: process.env.CLAUDE_CHANNEL_ENABLED === 'true',
  claudeChannelPluginDir: process.env.CLAUDE_CHANNEL_PLUGIN_DIR 
    ?? path.join(process.cwd(), 'pi-claude-channel'),
  claudeChannelWsPort: parseInt(process.env.CLAUDE_CHANNEL_WS_PORT || '3100', 10),
  claudeChannelHookPort: parseInt(process.env.CLAUDE_CHANNEL_HOOK_PORT || '3101', 10),
};
```

### `.env.example` additions:

```bash
# Claude Channel Integration (opt-in, uses subscription quota instead of SDK credit)
# Set to 'true' to enable the channel-based Claude path
CLAUDE_CHANNEL_ENABLED=false

# Path to the pi-claude-channel plugin directory
CLAUDE_CHANNEL_PLUGIN_DIR=./pi-claude-channel

# Ports for the channel plugin's WebSocket and HTTP hook receivers
CLAUDE_CHANNEL_WS_PORT=3100
CLAUDE_CHANNEL_HOOK_PORT=3101
```

### `server/src/claude/index.ts` changes

Add exports for new modules:
```typescript
export { ClaudeChannelService } from './claude-channel-service.js';
export { ClaudeChannelProcessManager } from './claude-channel-process-manager.js';
export { ClaudeChannelWsClient } from './claude-channel-ws-client.js';
export { ClaudeChannelEventAdapter } from './claude-channel-event-adapter.js';
export { ClaudeChannelHooksConfig } from './claude-channel-hooks-config.js';
// ... keep existing exports ...
```

---

## Module 6: connection.ts Amendments

**Agent:** Agent I (Phase 5)
**Location:** `server/src/websocket/connection.ts` (modify existing)
**Depends On:** Module 5 (ClaudeService refactor complete)

### Changes

**1. Import new types and the `permission_request` event handler:**
```typescript
// Add to imports (minimal — most are already imported)
import type { NormalizedEvent } from '@pi-web-ui/shared';
```

**2. Add `permission_request` handling in `handleClaudePrompt`'s onEvent callback:**

In the existing `(normalizedEvent) => { ... }` callback, add a case BEFORE `normEventToPiFormat`:

```typescript
(normalizedEvent) => {
  // NEW: Handle permission requests from channel
  if (normalizedEvent.type === 'permission_request') {
    const data = normalizedEvent.data as Record<string, unknown>;
    const uiRequest = {
      type: 'extension_ui_request' as const,
      request: {
        id: data.requestId as string,
        type: 'confirm' as const,
        method: `claude.permission.${data.toolName || 'tool'}`,
        params: {
          title: `Allow ${data.toolName}?`,
          description: data.description || `Claude wants to use ${data.toolName}`,
          toolName: data.toolName,
          args: data.args,
        },
        timeout: 120000,
      },
    };
    const subscribers = this.claudeSubs.getSubscribers(sessionId);
    if (subscribers.size > 0) {
      for (const subId of subscribers) {
        this.sendMessage(subId, uiRequest);
      }
    } else {
      this.sendMessage(clientId, uiRequest);
    }
    return;
  }

  // Existing code (unchanged):
  const piEvent = normEventToPiFormat(normalizedEvent);
  // ... broadcast ...
}
```

**3. Add `extension_ui_response` handling for Claude permission responses:**

In the main message dispatch switch, add handling for `extension_ui_response` messages that target Claude permissions:

```typescript
case 'extension_ui_response':
  await this.handleExtensionUiResponse(clientId, message);
  break;
```

And in the handler (or extend existing handler):

```typescript
private async handleExtensionUiResponse(
  clientId: string, 
  message: { type: 'extension_ui_response'; response: { id: string; approved?: boolean; cancelled?: boolean } }
): Promise<void> {
  // If this is a Claude permission response, relay to channel
  const requestId = message.response.id;
  if (this.pendingClaudePermissions.has(requestId)) {
    const sessionId = this.pendingClaudePermissions.get(requestId)!;
    // Send permission response through the Claude service
    this.claudeService.sendPermissionResponse(sessionId, requestId, message.response.approved ?? false);
    this.pendingClaudePermissions.delete(requestId);
    return;
  }
  
  // Otherwise, delegate to existing Pi SDK handler
  // ... existing code ...
}
```

**4. Start the Claude channel on server startup (in constructor or init):**

```typescript
// After existing startup code:
if (config.claudeChannelEnabled) {
  this.claudeService.startChannel().catch((err) => {
    console.error('[WebUI] Failed to start Claude channel:', err);
  });
}
```

---

## Module 7: Frontend Integration

**Agent:** Agent J (Phase 6)
**Location:** `client/src/store/sessionStore.ts`, `client/src/components/`
**Depends On:** Module 6 (connection.ts changes complete)

### Changes

**1. `sessionStore.ts` — Handle `permission_request` events for Claude:**

In the `session_event` handler, add a case for `permission_request` from Claude:

```typescript
// In the session_event handler switch statement:
case 'permission_request': {
  // Channel-based Claude permission requests arrive as session_events
  // with type 'permission_request'. These need to trigger the extension UI
  // approval modal (same as Pi SDK extensions).
  const { requestId, toolName, description, args } = event;
  // Store pending permission for the UI to handle
  set((state) => ({
    pendingPermissions: {
      ...state.pendingPermissions,
      [requestId]: { sessionId, toolName, description, args, runtime: 'claude' },
    },
  }));
  break;
}
```

**2. Permission response handling:**

When the user approves/rejects a permission, send the response back. This is already handled by the `extension_ui_response` message type. Ensure the `handleExtensionUiResponse` in `useWebSocket.ts` sends the correct format:

```typescript
// In useWebSocket.ts, ensure extension_ui_response works for Claude:
const respondToPermission = (requestId: string, approved: boolean) => {
  sendMessage({
    type: 'extension_ui_response',
    response: { id: requestId, approved },
  });
};
```

**3. UI: Permission approval modal (if not already covered by extension_ui_request):**

The existing `extension_ui_request` handler in `sessionStore.ts` already shows an approval modal for Pi SDK extensions. Claude channel permission requests arrive as `extension_ui_request` messages (converted in `connection.ts` step 2 above). The existing `ExtensionUIRequestModal` component should handle these automatically.

If the modal is not rendering for Claude requests, verify that `sessionStore` dispatches `extension_ui_request` to the modal component, and that the modal renders `confirm` type requests with the Claude-specific params.

### Changes Summary (Frontend)

| File | Change | Lines |
|------|--------|-------|
| `client/src/store/sessionStore.ts` | Handle `permission_request` events inside `session_event` | ~15 lines |
| `client/src/hooks/useWebSocket.ts` | Ensure `extension_ui_response` works for Claude runtime | ~0 lines (should work already) |
| `client/src/components/` | Verify permission modal renders for Claude requests | ~0 lines (should work already) |

### Minimal Frontend Change Philosophy

The channel integration deliberately minimizes frontend changes. Claude channel events use the EXACT same `session_event` envelope and NormalizedEvent types as the current `claude -p` path. The only new event type is `permission_request`, which is handled identically to existing Pi SDK permission requests.

---

## Module 8: Tests

**Agent H:** Unit tests for Modules 0–4 (Phase 4, parallel with Module 5)
**Agent K:** Integration + E2E tests (Phase 6, parallel with Module 7)

See `plan/TESTING.md` for the complete testing strategy.

---

## Module 9: Hooks Config Manager

**Agent:** Agent E (Phase 2)
**Location:** `server/src/claude/claude-channel-hooks-config.ts`
**Depends On:** Module 0 (hook endpoint URLs known)

### Interface

```typescript
export interface HooksConfig {
  hooks: Record<string, HookEntry[]>;
}

export interface HookEntry {
  matcher: string;
  hooks: HookHandler[];
}

export type HookHandler =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'command'; command: string };

export class ClaudeChannelHooksConfig {
  constructor(cfg: {
    hookPort: number;        // Port of the HTTP hook receiver
    claudeSettingsPath?: string;  // Default: ~/.claude/settings.json
  });

  /**
   * Read the existing settings.json, merge in the hooks config, and write back.
   * Preserves any existing settings that aren't hooks-related.
   */
  async writeHooksConfig(): Promise<void>;

  /**
   * Remove the hooks config entries that this class manages.
   * Leaves other settings intact.
   */
  async removeHooksConfig(): Promise<void>;

  /**
   * Generate the hooks config object (does not write).
   */
  buildHooksConfig(): HooksConfig;
}
```

### Generated Config

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:{hookPort}/hook/post-tool-use"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:{hookPort}/hook/stop"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:{hookPort}/hook/session-start"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:{hookPort}/hook/user-prompt"
          }
        ]
      }
    ]
  }
}
```

### Testing

```typescript
// server/tests/unit/claude/claude-channel-hooks-config.test.ts

describe('ClaudeChannelHooksConfig', () => {
  it('should generate correct hooks JSON');
  it('should merge with existing settings.json');
  it('should preserve non-hook settings');
  it('should remove only its own hooks on cleanup');
  it('should create settings file if it does not exist');
  it('should handle malformed existing settings.json');
});
```
