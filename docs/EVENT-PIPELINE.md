# Pi Web UI Event Pipeline

> How three different backend runtimes produce a single frontend event stream.

## High-level Flow

```
┌─────────────────┐     ┌─────────────────────────────┐     ┌──────────────────┐
│   Pi SDK        │────▶│  event-forwarder.ts         │────▶│                  │
│  (worker RPC)   │     │  (raw Pi events)            │     │                  │
└─────────────────┘     └─────────────────────────────┘     │                  │
                                                            │   connection.ts  │
┌─────────────────┐     ┌─────────────────────────────┐     │   (runtime       │────▶  session_event  ────▶  sessionStore
│  Claude Direct  │────▶│  claude-event-normalizer.ts │────▶│    router +      │
│  (NDJSON)       │     │  (NormalizedEvent)          │     │    normEventTo   │
└─────────────────┘     └─────────────────────────────┘     │    PiFormat()    │
                                                            │                  │
┌─────────────────┐     ┌─────────────────────────────┐     │                  │
│  OpenCode Direct│────▶│  opencode-event-adapter.ts  │────▶│                  │
│  (SSE)          │     │  (NormalizedEvent)          │     │                  │
└─────────────────┘     └─────────────────────────────┘     └──────────────────┘
```

## The NormalizedEvent Contract

All runtimes must eventually produce events matching `NormalizedEvent` (`shared/src/protocol-types.ts`):

```typescript
interface NormalizedEvent {
  type: string;        // e.g. 'agent_start', 'tool_execution_start', 'message_update'
  sessionId?: string;
  timestamp: number;
  data: unknown;       // runtime-specific payload
}
```

`connection.ts` then converts `NormalizedEvent` → Pi-compatible frontend format via `normEventToPiFormat()`.

## Runtime-Specific Origins

### Pi SDK

Pi workers emit native Pi SDK events. `event-forwarder.ts` wraps them and sends them through the WebSocket connection manager.

**Example: tool execution**
```
Pi worker emits: { type: 'tool_execution', toolCallId: '123', toolName: 'Bash', args: { command: 'ls' } }
  → event-forwarder.ts
  → connection.ts wraps as: { type: 'session_event', sessionId: '...', event: { type: 'tool_execution_start', ... } }
```

### Claude Direct

Claude Direct runs `claude -p` and parses NDJSON lines from stdout. `claude-event-normalizer.ts` converts these into `NormalizedEvent`.

**Example: assistant message delta**
```
Claude NDJSON line: { type: 'content_block_delta', delta: { text: 'hello' } }
  → claude-event-normalizer.ts produces: { type: 'message_update', data: { assistantMessageEvent: { type: 'text_delta', delta: 'hello' } } }
  → connection.ts converts to: { type: 'session_event', event: { type: 'message_update', assistantMessageEvent: ... } }
```

### OpenCode Direct

OpenCode emits Server-Sent Events. `opencode-event-adapter.ts` maps SSE types to `NormalizedEvent`. This adapter also handles:
- **Permission bridging:** OpenCode `permission.asked` → `extension_ui_request`
- **Tool deduplication:** Prevents duplicate tool events from being forwarded
- **Context window tracking:** Extracts token usage from `message.updated` events

**Example: tool call**
```
OpenCode SSE: { type: 'tool.call', properties: { tool: 'Bash', args: { command: 'ls' } } }
  → opencode-event-adapter.ts produces: { type: 'tool_execution_start', data: { toolCallId: '...', toolName: 'Bash', args: ... } }
  → connection.ts converts to: { type: 'session_event', event: { type: 'tool_execution_start', ... } }
```

## Frontend Ingestion

All paths converge in `client/src/store/sessionStore.ts` via `handleServerMessage()`:

- `session_event` → routed to the correct session, updates `sessionData`, `messages`, `streamingSessions`
- `session_status` → updates session status (idle/busy/streaming/error)
- `claude_available` / `opencode_available` → sets runtime availability flags
- `extension_ui_request` → surfaced as approval dialog (used by both Pi extensions and OpenCode permissions)

## Key Rule for New Runtimes

If you add a fourth runtime, you must:
1. Produce `NormalizedEvent` from your native event format.
2. Route through `connection.ts` so `normEventToPiFormat()` converts it.
3. Guarantee `agent_end` is eventually emitted, or the frontend input will stay locked.
4. Implement history replay so session switching works.
