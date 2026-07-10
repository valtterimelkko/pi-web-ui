# Pi Web UI Event Pipeline

> How Pi, Claude, OpenCode, and Antigravity backend paths produce a single frontend event stream.

## High-level Flow

```
┌─────────────────┐     ┌─────────────────────────────┐     ┌──────────────────┐
│   Pi Coding Agent        │────▶│  event-forwarder.ts         │────▶│                  │
│  (worker RPC)   │     │  (raw Pi events)            │     │                  │
└─────────────────┘     └─────────────────────────────┘     │                  │
                                                            │   connection.ts  │
┌─────────────────┐     ┌─────────────────────────────┐     │   (runtime       │────▶  session_event  ────▶  sessionStore
│ Claude runtime  │────▶│ claude-event-normalizer.ts  │────▶│    router +      │
│ (direct/channel)│     │ or claude-channel-*.ts      │     │    normEventTo   │
└─────────────────┘     └─────────────────────────────┘     │    PiFormat()    │
                                                            │                  │
┌─────────────────┐     ┌─────────────────────────────┐     │                  │
│  OpenCode│────▶│  opencode-event-adapter.ts  │────▶│                  │
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

### Pi Coding Agent

Pi workers emit native Pi Coding Agent events. `event-forwarder.ts` wraps them and sends them through the WebSocket connection manager.

When a persisted Pi session is reopened, `pi/session-history.ts` projects its JSONL into the `session_switched` payload. It restores ordinary user/assistant messages plus **only** compact `subagent` and `evaluated_subagent` tool cards: agent identity, model where persisted, and aggregate usage. Inner subagent transcripts, individual commands, and final reports are never replayed into the browser card. The live path uses the same `SubagentToolSummary` contract.

**Example: tool execution**
```
Pi worker emits: { type: 'tool_execution', toolCallId: '123', toolName: 'Bash', args: { command: 'ls' } }
  → event-forwarder.ts
  → connection.ts wraps as: { type: 'session_event', sessionId: '...', event: { type: 'tool_execution_start', ... } }
```

### Claude runtime — SDK backend

The SDK backend (`claude-sdk-service.ts`) intercepts Claude Code's built-in `AskUserQuestion` tool call. Instead of letting the SDK use its default prompt-in-terminal behavior, it emits normalized events:

- `ask_user_question_request` — carries the question set and options to the browser so the user can answer in a structured dialog.
- `ask_user_question_closed` — emitted when the request is resolved for a non-answer reason (timeout, abort, turn end, or disconnect), so the browser can close the dialog with an explanation.

The browser answers via `extension_ui_response`; the SDK backend resolves the pending `canUseTool` callback with the user's answers and the turn continues. If the request times out or the session disconnects, the backend resolves the callback as cancelled and emits the closed event.

### Claude runtime — legacy direct backend

The legacy direct backend runs `claude -p` and parses NDJSON lines from stdout. `claude-event-normalizer.ts` converts these into `NormalizedEvent`.

**Example: assistant message delta**
```
Claude NDJSON line: { type: 'content_block_delta', delta: { text: 'hello' } }
  → claude-event-normalizer.ts produces: { type: 'message_update', data: { assistantMessageEvent: { type: 'text_delta', delta: 'hello' } } }
  → connection.ts converts to: { type: 'session_event', event: { type: 'message_update', assistantMessageEvent: ... } }
```

### Claude runtime — channel-backed backend

The channel-backed backend launches Claude Code under PTY supervision, writes managed hooks into Claude settings, and receives plugin events back through the local channel bridge.

Key modules:
- `claude-channel-process-manager.ts`
- `claude-channel-hooks-config.ts`
- `claude-channel-ws-client.ts`
- `claude-channel-event-adapter.ts`
- `pi-claude-channel/server.ts`

**Example: tool visibility**
```
Claude tool use
  → pi-claude-channel/server.ts emits reply/status/send_event activity
  → claude-channel-ws-client.ts receives the channel event
  → claude-channel-event-adapter.ts produces NormalizedEvent
  → connection.ts converts to: { type: 'session_event', event: { type: 'tool_execution_start' | 'tool_execution_end' | ... } }
```

The channel-backed path may also emit `stream_activity` so the frontend can show liveness during long-running turns.

### OpenCode

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
- `claude_available` / `opencode_available` / `antigravity_available` → sets runtime availability flags
- `extension_ui_request` → surfaced as approval/dialog UI (used by Pi extensions, OpenCode permissions, and **Claude SDK `AskUserQuestion` requests**)
- `extension_ui_cancel` → closes an open dialog when the request was resolved for a non-answer reason (e.g. `AskUserQuestion` timeout/disconnect)

## Key Rule for New Runtimes

If you add another runtime, you must:
1. Produce `NormalizedEvent` from your native event format.
2. Route through `connection.ts` so `normEventToPiFormat()` converts it.
3. Guarantee `agent_end` is eventually emitted, or the frontend input will stay locked.
4. Implement history replay so session switching works.
5. Document where its runtime-owned logs and session files live in [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).
