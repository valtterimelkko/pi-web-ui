# API Documentation

> API surface index for Pi Web UI. Start with [`README.md`](./README.md) for the public overview and [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) for the detailed WebSocket message contract.

## API Surfaces

Pi Web UI exposes three main surfaces:

1. **WebSocket** for session control, streaming, replay, and runtime events
2. **REST** for browser auth, health, config, models, files, sessions, and extensions
3. **Internal API** (a local automation API) for browserless live validation, local integrations, and multi-agent orchestration over a Unix socket

## WebSocket

### Endpoint

- Main app socket: `/ws`
- Session-specific replay/live endpoint: `/ws/sessions/:sessionId`

Use `ws://` locally and `wss://` in production.

### Authentication Flow

1. Authenticate over REST (`POST /api/auth/login`) to receive the JWT cookie.
2. Open the WebSocket.
3. Send the first message:

```json
{ "type": "auth", "csrfToken": "..." }
```

4. Server replies with:

```json
{ "type": "connection_status", "status": "authenticated" }
```

### Common Client → Server Messages

```typescript
{ type: 'auth', csrfToken: string }
{ type: 'get_sessions', cwd?: string }
{ type: 'new_session', cwd?: string, sdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity' }
{ type: 'switch_session', sessionPath: string }
{ type: 'prompt', sessionId: string, message: string, images?: ImageContent[] }
{ type: 'follow_up', message: string }
{ type: 'steer', message: string }
{ type: 'abort' }
{ type: 'set_model', modelId: string }
{ type: 'set_thinking_level', level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
{ type: 'compact', customInstructions?: string }
{ type: 'pin_session', sessionPath: string }
{ type: 'unpin_session', sessionPath: string }
{ type: 'extension_ui_response', response: { id, approved?, value?, cancelled? } }
```

### Common Server → Client Messages

```typescript
{ type: 'authenticated', sessionId: string }
{ type: 'connection_status', status: 'authenticated' | 'disconnected' }
{ type: 'sessions_list', sessions: SessionInfo[] }
{ type: 'session_created', sessionId: string, sessionPath: string, sdkType?: string }
{ type: 'session_switched', sessionId: string, sessionPath: string, model?: string, isStreaming?: boolean }
{ type: 'session_status', sessionId: string, sessionPath: string, status: 'idle' | 'busy' | 'streaming' | 'error', lastActivity: string, messageCount: number }
{ type: 'session_event', sessionId: string, event: unknown }
{ type: 'claude_available', available: boolean, error: string | null }
{ type: 'opencode_available', available: boolean, error: string | null }
{ type: 'antigravity_available', available: boolean, error: string | null }
{ type: 'extension_ui_request', request: ExtensionUIRequest }
{ type: 'error', message: string, code?: string }
```

### Runtime-specific Notes

#### Pi Coding Agent
- Native Pi session lifecycle
- Extensions and extension UI requests come directly from Pi Coding Agent pathways
- Session files live under `~/.pi/agent/sessions/`

#### Claude runtime
- Uses one Claude runtime family in the UI, but can run through three backend modes: SDK/provider-profile, direct `claude -p`, or the channel-backed Claude Code path
- Pi Web UI owns Claude replay JSONL persistence under `~/.pi-web-ui/claude-sessions/`
- Claude Code also keeps native session JSONL under `~/.claude/projects/`
- Profile-backed model entries appear as `profile:<id>` when Claude profiles are enabled
- Availability is announced with `claude_available`

#### OpenCode
- Uses `opencode serve` via server-side HTTP/SSE integration
- Availability is announced with `opencode_available`
- OpenCode permission requests are bridged into existing `extension_ui_request` UI flows
- Full transcript storage remains OpenCode-owned; Pi Web UI stores registry metadata and replay adapters

#### Antigravity
- Uses `agy -p` via server-side subprocess-per-turn execution
- Availability is announced with `antigravity_available`
- Pi Web UI stores Antigravity turn logs under `~/.pi-web-ui/antigravity-sessions/`
- agy owns the resumed-conversation SQLite DBs under `~/.gemini/antigravity-cli/conversations/`

For complete message shapes and event semantics, see [`docs/PROTOCOL.md`](./docs/PROTOCOL.md).

## Internal API

The Internal API is documented in [`docs/INTERNAL-API.md`](./docs/INTERNAL-API.md). It is a trusted same-host multi-client surface, not a multi-tenant boundary; possession of its bearer token grants session control.
It began as the preferred surface for **live end-to-end validation against real runtimes** and is now also the preferred local automation surface for integrations, agent-to-agent orchestration, and the live-validation runner. It uses:

- Unix socket transport: `~/.pi-web-ui/internal-api.sock`
- bearer token auth: `~/.pi-web-ui/internal-api-token`
- SSE for streaming prompt responses and persistent session event monitoring

Reference docs:
- [`docs/INTERNAL-API.md`](./docs/INTERNAL-API.md) — endpoint reference and known limitations
- [`docs/INTERNAL-API-CONTRACT.md`](./docs/INTERNAL-API-CONTRACT.md) — contract metadata, compatibility rules, and local-consumer coordination notes
- [`docs/INTERNAL-API-ORCHESTRATION.md`](./docs/INTERNAL-API-ORCHESTRATION.md) — recommended orchestration patterns across Pi / Claude / OpenCode / Antigravity
- [`docs/LIVE-VALIDATION.md`](./docs/LIVE-VALIDATION.md) — validation runner built on the same API

`GET /api/v1/health` and `GET /api/v1/capabilities` publish contract metadata (`pi-web-ui-internal-api`, `/api/v1`, current contract version `1.10.0`) for local consumers such as Agent OS style tooling. Health also exposes additive per-runtime `runtimeHealth`; diagnostics are filtered by correlation/runtime selectors and include a bounded process-local operational snapshot; `/sessions/:id/evidence` provides the one-call troubleshooting bundle.

Important endpoints include:
- `GET /api/v1/capabilities`
- `GET /api/v1/models`
- `POST /api/v1/models/refresh` (OpenCode and Pi runtime catalogue refresh; Pi uses `{"runtime":"pi"}` for the OpenRouter-backed catalogue)
- `GET /api/v1/diagnostics`
- `GET /api/v1/sessions/:id/diagnostics`
- `GET /api/v1/sessions/:id/evidence` (canonical alias resolution plus bounded diagnostic/receipt evidence)
- `GET /api/v1/events/types`
- `POST /api/v1/sessions` (supports Claude `profileId` or `model: "profile:<id>"`)
- `POST /api/v1/sessions/:id/prompt` (`detach:true` supported only with `verbosity=answers`; retain the returned `runId`)
- `GET /api/v1/sessions/:id/info`
- `GET /api/v1/sessions/:id/history`
- `GET /api/v1/sessions/:id/events`
- `GET /api/v1/sessions/:id/wait`
- `GET /api/v1/sessions/:id/transcript`
- `GET /api/v1/sessions/:id/transcript?view=screen` (read-only “what the user sees” projection; optional `expand=tools,thinking`)
- `POST /api/v1/sessions/:id/transfer`
- `POST /api/v1/sessions/batch`
- `POST /api/v1/sessions/batch/prompt`
- `POST /api/v1/sessions/usage`
- `GET /api/v1/sessions/:id/approvals/pending`
- `GET /api/v1/runs/:runId` (durable accepted/started/terminal receipt)
- `POST /api/v1/sessions/:id/control` (including standalone pin/unpin)
- `POST /api/v1/sessions/:id/approvals/:requestId/respond`
- `POST /api/v1/sessions/:id/notifications/opt-in`
- `DELETE /api/v1/sessions/:id/notifications/opt-in`
- `GET /api/v1/sessions/:id/notifications`
- `POST /api/v1/notifications`
- `GET /api/v1/notifications`
- `POST/GET/DELETE /api/v1/sessions/:id/watch`

Use the session read paths like this:
- `/transcript` — runtime-agnostic result reading; use `scope=visible_recent` for compact context
- `/transcript?view=screen` — faithful read-only projection of what the user sees by default
- `/history` — lower-level replay/debug detail

Known caveat: for Claude channel-backed sessions, `GET /sessions/:id/events`
can be less reliable for multi-child parallel monitoring than it is for the
other runtimes. When building orchestrators, prefer `/wait` + `/transcript`
as the safe fallback for Claude fan-out scenarios.

## REST API

Protected routes use cookie auth.

### Authentication

#### `POST /api/auth/login`
Body:
```json
{ "username": "...", "password": "..." }
```
Response:
```json
{ "success": true, "csrfToken": "..." }
```
Sets the auth JWT cookie.

#### `POST /api/auth/logout`
Response:
```json
{ "success": true }
```

#### `GET /api/auth/me`
Response:
```json
{ "user": { "id": "...", "username": "..." } }
```

### Health and Config

#### `GET /api/health`
Basic health response.

#### `GET /api/health/live`
Liveness probe.

#### `GET /api/health/ready`
Readiness probe including Pi path, worker pool, env checks, and OpenCode availability summary.

#### `GET /api/config/validate`
Validate config and environment assumptions.

### Models

#### `GET /api/models`
Returns models for the default Pi Coding Agent path.

#### `GET /api/models?sdkType=claude`
Returns Claude base aliases plus any enabled profile-backed entries as `profile:<id>`. Those entries may also include `provider`, `backend`, and `claudeModel` metadata so the browser can build the structured Claude selector.

#### `GET /api/models?sdkType=opencode`
Returns models exposed through OpenCode.

#### `GET /api/models?sdkType=antigravity`
Returns models exposed through the Antigravity / `agy` runtime.

#### `PUT /api/models/current`
Validates a model selection payload. Actual model switching is session-scoped and typically happens over WebSocket.

### Sessions

#### `GET /api/sessions`
List sessions.

#### `GET /api/sessions/:id`
Get one session.

#### `DELETE /api/sessions/:id`
Delete one session.

#### `GET /api/sessions/:id/export`
Export session transcript/output.

### Files

#### `GET /api/files/browse?path=/path`
Browse a directory.

#### `GET /api/files/read?path=/file`
Read file contents. Reads are bounded at 200 KiB; larger files return a newline-safe prefix with `truncated: true`, `totalSize`, and `readSize`. Truncated Markdown remains read-only in the UI.

### Extensions

#### `GET /api/extensions`
List extensions.

#### `POST /api/extensions/:name/toggle`
Enable or disable an extension.

### Notifications (browser cookie-auth surface)

#### `GET /api/sessions/:id/notifications`
Returns whether that session is opted in plus recent deliveries.

#### `POST /api/sessions/:id/notifications/opt-in`
Opts the session into `agent_end` notifications. The browser sends the server-sourced runtime + session path for the sidebar session row.

#### `DELETE /api/sessions/:id/notifications/opt-in`
Opts the session out.

This browser-facing route group exists because the browser cannot reach the Internal API Unix socket directly. For the deeper subsystem/ops view, see [`docs/NOTIFICATIONS.md`](./docs/NOTIFICATIONS.md).

### Other route groups

Additional route groups exist for operational features such as:
- preferences
- terminal
- git
- usage

See `server/src/routes/` for the exact route modules.

## Error Format

REST errors generally return:

```json
{
  "error": "Error message"
}
```

Internal API errors use a stable `{ error, code }` shape and may also include additive `hint` and `docs` fields for the most actionable cases.

WebSocket errors generally use:

```json
{
  "type": "error",
  "message": "Error message",
  "code": "ERROR_CODE"
}
```

Common codes:
- `UNAUTHORIZED`
- `SESSION_NOT_FOUND`
- `INVALID_MESSAGE`
- `INVALID_JSON`
- `PROMPT_INJECTION`
- `RATE_LIMIT`
- `INTERNAL_ERROR`
- `OPENCODE_ERROR`
