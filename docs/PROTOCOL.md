# Pi Web UI Protocol Documentation

> Canonical WebSocket protocol reference for Pi Web UI. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for structure and [`README.md`](../README.md) for the operational overview.

## Scope

This document describes the **browser ↔ Pi Web UI server** protocol.

It does **not** document:
- internal Pi worker RPC details
- Claude NDJSON internals
- OpenCode HTTP/SSE internals

Those are runtime implementation details behind the server boundary.

## Transport

### Primary endpoint
- `/ws`

### Session endpoint
- `/ws/sessions/:sessionId`

The app uses JSON messages with a `type` field rather than strict JSON-RPC framing.

## Connection Lifecycle

1. Browser authenticates over REST and receives auth cookie.
2. Browser opens WebSocket.
3. Server sends:
   ```json
   { "type": "authenticated", "sessionId": "..." }
   ```
4. Browser sends:
   ```json
   { "type": "auth", "csrfToken": "..." }
   ```
5. Server replies:
   ```json
   { "type": "connection_status", "status": "authenticated" }
   ```
6. Server may then emit runtime availability information such as:
   - `claude_available`
   - `opencode_available`

## Client → Server Messages

### Auth and session discovery

```typescript
{ type: 'auth', csrfToken: string }
{ type: 'get_sessions', cwd?: string }
{ type: 'get_session_info' }
{ type: 'get_session_tree', sessionId: string }
```

### Session lifecycle

```typescript
{ type: 'new_session', cwd?: string, sdkType?: 'pi' | 'claude' | 'opencode' }
{ type: 'switch_session', sessionPath: string }
{ type: 'subscribe_session', sessionPath: string }
{ type: 'unsubscribe_session', sessionPath: string }
{ type: 'pin_session', sessionPath: string }
{ type: 'unpin_session', sessionPath: string }
{ type: 'set_session_name', sessionId: string, name: string }
```

### Conversation control

```typescript
{ type: 'prompt', sessionId: string, message: string, images?: ImageContent[] }
{ type: 'follow_up', message: string }
{ type: 'steer', message: string }
{ type: 'abort' }
{ type: 'compact', customInstructions?: string }
```

### Session configuration

```typescript
{ type: 'set_model', modelId: string }
{ type: 'set_thinking_level', level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
```

### Approval / extension UI

```typescript
{ type: 'extension_ui_response', response: { id: string, approved?: boolean, value?: unknown, cancelled?: boolean } }
```

### Session context transfer

Transfer the visible transcript of one session into another (including across runtimes).

```typescript
{
  type: 'transfer_session_context';
  sourceSessionId: string;
  targetSessionId?: string;       // required when not creating new
  createNew?: boolean;
  targetSdkType?: 'pi' | 'claude' | 'opencode';  // required when createNew
  targetCwd?: string;             // required when createNew
  scope: 'visible_recent' | 'visible_full';
  sourceDisplayName?: string;     // optional: sidebar name override
}
```

The server responds with either `session_transfer_completed` or `session_transfer_failed`.

## Server → Client Messages

### Connection and runtime availability

```typescript
{ type: 'authenticated', sessionId: string }
{ type: 'connection_status', status: string }
{ type: 'claude_available', available: boolean, error: string | null }
{ type: 'opencode_available', available: boolean, error: string | null }
{ type: 'error', message: string, code?: string }
```

### Session list and switching

```typescript
{ type: 'sessions_list', sessions: SessionInfo[] }
{ type: 'session_created', sessionId: string, sessionPath: string }
{ type: 'session_switched', sessionId: string, sessionPath: string, model?: string, contextWindow?: number, contextUsed?: number, contextPercent?: number, messages?: SessionMessage[], fileTimestamp?: number, isStreaming?: boolean }
{ type: 'session_info', stats: SessionStats }
{ type: 'session_tree', tree: TreeNode[] }
{ type: 'session_name_changed', sessionId: string, name: string }
{ type: 'session_name_updated', sessionId: string, name: string }
```

### Session status and event routing

```typescript
{ type: 'session_status', sessionId: string, sessionPath: string, status: 'idle' | 'busy' | 'streaming' | 'error', lastActivity: string, messageCount: number, currentStep?: number }
{ type: 'session_event', sessionId: string, event: unknown }
{ type: 'session_subscribed', sessionId: string, sessionPath: string, status: 'idle' | 'busy' | 'streaming' | 'error', messageCount?: number, currentStep?: number }
{ type: 'session_unsubscribed', sessionId: string, sessionPath?: string }
{ type: 'session_pinned', sessionPath: string, pinned: boolean }
{ type: 'session_pin_error', sessionPath: string, error: string }
{ type: 'session_update', changeType: 'add' | 'change' | 'unlink', path: string, sessionId?: string, cwd?: string, info?: SessionInfo }
```

### Common forwarded runtime events

These are the normalized event shapes the frontend usually sees inside `session_event.event`:

```typescript
{ type: 'agent_start' }
{ type: 'agent_end', messages?: unknown[] }
{ type: 'turn_start', turnIndex?: number }
{ type: 'turn_end', turnIndex?: number, message?: unknown, toolResults?: unknown[] }
{ type: 'message_start', message: unknown }
{ type: 'message_update', message: unknown, assistantMessageEvent: unknown }
{ type: 'message_end', message: unknown }
{ type: 'tool_execution_start', toolCallId: string, toolName: string, args: unknown }
{ type: 'tool_execution_update', toolCallId: string, toolName: string, args: unknown, partialResult: unknown }
{ type: 'tool_execution_end', toolCallId: string, toolName: string, result: unknown, isError: boolean }
{ type: 'auto_compaction_start', reason: string }
{ type: 'auto_compaction_end', result: unknown, aborted: boolean, willRetry: boolean }
{ type: 'auto_retry_start', attempt: number, maxAttempts: number, delayMs: number, errorMessage: string }
{ type: 'auto_retry_end', success: boolean, attempt: number, finalError?: string }
```

### Extension / approval UI

```typescript
{ type: 'extension_ui_request', request: { id: string, type: 'confirm' | 'select' | 'input' | 'editor', method: string, params: Record<string, unknown>, timeout: number } }
{ type: 'extension_error', extensionPath: string, event: string, error: string }
```

### Session context transfer responses

```typescript
{ type: 'session_transfer_completed', sourceSessionId: string, targetSessionId: string, createdNewSession: boolean }
{ type: 'session_transfer_failed', sourceSessionId: string, targetSessionId?: string, message: string, code: string }
```

Transfer error codes:
- `TRANSFER_SOURCE_NOT_FOUND` — source session does not exist
- `TRANSFER_TARGET_NOT_FOUND` — target session does not exist
- `TRANSFER_TARGET_BUSY` — target session is streaming
- `TRANSFER_SELF_TRANSFER` — source and target are the same
- `TRANSFER_EMPTY_SOURCE` — no visible content to transfer
- `TRANSFER_INVALID_SCOPE` — scope is not `visible_recent` or `visible_full`
- `TRANSFER_INVALID_REQUEST` — malformed request
- `TRANSFER_RUNTIME_UNAVAILABLE` — requested runtime not available
- `TRANSFER_DISPATCH_FAILED` — handoff injection failed

## Runtime-specific Behaviour Behind the Same Protocol

### Pi SDK
- Native Pi events are forwarded and wrapped for the frontend.

### Claude Direct
- Claude output is normalized into the common event model.
- History replay is reconstructed from Pi-owned Claude session storage.

### OpenCode Direct
- OpenCode SSE and message APIs are adapted into the common event model.
- Permission requests are transformed into `extension_ui_request` so the browser can approve or reject them.

This is important: the protocol is intentionally **more stable than any one runtime’s native event stream**.

## History Replay

When switching sessions, the server may send:
- `session_switched`
- then replay-related `session_event` messages
- and surrounding markers such as `history_start` / `history_end` in runtime-specific flows handled by the client

The backing source differs by runtime, but the frontend contract is kept consistent.

## Error Codes

Common codes include:
- `UNAUTHORIZED`
- `SESSION_NOT_FOUND`
- `INVALID_MESSAGE`
- `INVALID_JSON`
- `PROMPT_INJECTION`
- `RATE_LIMIT`
- `INTERNAL_ERROR`
- `OPENCODE_ERROR`
- `TRANSFER_SOURCE_NOT_FOUND`
- `TRANSFER_TARGET_NOT_FOUND`
- `TRANSFER_TARGET_BUSY`
- `TRANSFER_SELF_TRANSFER`
- `TRANSFER_EMPTY_SOURCE`
- `TRANSFER_INVALID_SCOPE`
- `TRANSFER_INVALID_REQUEST`
- `TRANSFER_RUNTIME_UNAVAILABLE`
- `TRANSFER_DISPATCH_FAILED`

Example:

```json
{
  "type": "error",
  "message": "Potentially malicious content",
  "code": "PROMPT_INJECTION"
}
```

## Files to Read with This Doc

- `server/src/websocket/protocol.ts`
- `server/src/websocket/connection.ts`
- `client/src/store/sessionStore.ts`
- `client/src/hooks/useWebSocket.ts`
