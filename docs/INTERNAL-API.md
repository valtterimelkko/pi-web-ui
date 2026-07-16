# Pi Web UI — Internal Backend API

> **Purpose today:** a local-only automation API for **live validation**, local integrations, and early cross-runtime orchestration work.
>
> **Audience:** agents and developers building on top of Pi Web UI, especially when they need to validate behaviour against **real runtimes** rather than only against tests or browser mocks.

## Why this API exists

The Internal API started first as a practical development tool.

Its original purpose was to let coding agents and developers verify Pi Web UI changes **end-to-end against real runtime sessions** while building or troubleshooting the project.

That matters because many issues in a project like this only appear when a real runtime is actually involved:
- session creation that fails only against a live backend
- replay/history issues that only appear with genuine runtime event sequences
- tool rendering, follow-up, or approval behaviour that passes tests but breaks in real use

So the first value of this API was **live validation**.

That is still true today.

## What this API is also becoming

The same local API is now increasingly useful for two broader purposes:

1. **Local backend integration** — other trusted local applications can use Pi Web UI's backend as their backend
2. **Cross-runtime orchestration experiments** — one parent workflow can start recruiting child sessions from different runtime families through one integrated surface

Examples of the first category include:
- voice interfaces
- custom frontends
- Agent OS style tooling
- observer/monitoring layers
- local automation scripts

Examples of the second category are still emerging rather than fully productized. The long-term idea is that a parent workflow could coordinate multiple child sessions across different runtime/provider paths — for example a Pi-backed path, an OpenCode/GLM path, an Antigravity/Gemini path, and a Claude Code path — through one local API.

Important caveat: **that orchestration vision is real, but still work in progress.**

If you want the broader story behind that direction, read [`VISION.md`](./VISION.md).

## What is Pi Web UI?

Pi Web UI is a custom-built browser interface around **four AI
coding-agent runtime paths**. It provides persistent chat sessions with real-time
streaming, tool-execution rendering, session history, and runtime management —
all behind a single unified sidebar.

Under the hood, each runtime slot exists for a different reason:

### The Runtime Paths

| Runtime family | What it uses | Why it exists |
|---|---|---|
| **Pi Coding Agent** | [Pi Coding Agent](https://shittycodingagent.ai/) via its SDK path | The native path. When models are available through the Pi model registry and you want extensions, custom tools, and the full Pi experience. |
| **Claude Code** | profile-driven SDK backend, legacy `claude -p`, **or** the channel-backed Claude Code path | Claude's monthly subscription does not allow external coding-agent harnesses to use Claude via the Anthropic API — Claude Code must be the agent environment. Pi Web UI therefore runs Claude Code directly, normalizes SDK messages, legacy NDJSON, or channel/plugin events into the common event model, and owns the replay/persistence layer so sessions survive restarts. Explicit provider profiles also let the same browser UI route Claude sessions through native Claude subscription or Anthropic-compatible providers such as GLM/Z.ai. |
| **OpenCode** | `opencode serve` HTTP/SSE backend | Z.AI's GLM models (via the coding-plan provider) currently recognise OpenCode as a valid coding-agent harness but not Pi. Rather than bypass this, Pi Web UI integrates with the OpenCode server backend, adapting OpenCode SSE events into the same common event model. The OpenCode backend owns transcript storage; Pi Web UI stores registry metadata and replay transforms. |
| **Antigravity** | `agy -p` subprocess-per-turn backend | Google Gemini via Antigravity CLI. Pi Web UI runs `agy` directly, stores Pi-owned turn logs for replay, and correlates them with agy-owned conversation SQLite DBs for follow-up continuity. |

All runtime paths are surfaced through a **unified session list** so the
runtime difference is transparent at the UI level — you create sessions,
switch between them, and see tool cards and message history the same way
regardless of backend.

### What the Web UI Offers

- **Create sessions** on any of the runtime paths with model selection
- **Real-time streaming chat** with message deltas, tool execution cards,
  thinking blocks, and agent state indicators
- **Session persistence** — sessions survive browser refresh, reconnect,
  and (for Claude and OpenCode) server restart
- **Session pinning** — protect long-running sessions from idle/timeout eviction
- **History replay** — previously sent messages and tool calls are restored
  when switching sessions
- **Model switching** — change models mid-session (runtime-dependent)
- **Session export** — export session transcripts to HTML
- **Session context transfer** — transfer the visible transcript of one session
  into another (including across runtimes)

### What the Internal API Adds

The Internal API takes all of the above backend functionality and exposes it
as a **local-only HTTP API** over a Unix domain socket. Other applications
running on the same machine can:

- **Create, list, and manage sessions** across all runtime paths
- **Send prompts** and receive answers (final text or full streaming events)
- **Discover available models** — always live, no restart needed
- **Share sessions with the web UI** — sessions created via the API appear in
  the browser sidebar in real time, and web UI sessions can be queried via
  the API

It does NOT duplicate the backend. It wraps the existing `ClaudeService`,
`OpenCodeService`, `AntigravityService`, and `MultiSessionManager` objects —
the same ones the web UI uses.

## Overview

### Key Properties

- **Contracted:** `GET /health` and `GET /capabilities` publish contract metadata (`pi-web-ui-internal-api`, `/api/v1`, contract version `1.7.0`) so local consumers can detect the API surface they are using. See [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md).
- **Local-only:** The API runs on a Unix domain socket. It cannot be accessed
  over the network.
- **Auto-discovering models:** The `/models` endpoint queries live model lists
  from each runtime. New models appear immediately — no restart needed.
- **Unified sessions:** Sessions appear in both the API and the web UI. You
  can create a session via the API, then open it in the web UI.
- **Auth:** A shared API key stored at `~/.pi-web-ui/internal-api-token`.
- **Broader than live validation:** the repo-owned `npm run validate:live`
  runner is one consumer of this API, but the same surface also exists for
  local automation and multi-agent orchestration.

### Primary use cases

- **Browserless live validation** — repo-owned runtime checks that confirm a real server/runtime path still works without opening the web UI. Validation should use a disposable validation server by default; targeting the running production Web UI requires explicit user permission and `--allow-production` in the validation CLI.
- **Local app integration** — voice chat, custom frontends, daemon processes, and other local tools that want to create sessions and send prompts.
- **Multi-agent orchestration** — parent agents spawning child sessions across Pi, Claude, OpenCode, and Antigravity, then monitoring, collecting, and transferring results.

### What this API is now good for

The current surface is strong enough for the full Tier-1 orchestration loop:
- discover runtimes and models
- create child sessions on different runtime paths
- dispatch prompts
- monitor progress
- wait for completion
- read back child transcripts/results
- transfer context into another session
- aggregate usage and cost
- tear child sessions down

### Recommended docs by task

- Need endpoint reference → [`INTERNAL-API.md`](./INTERNAL-API.md)
- Need compatibility/versioning rules → [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md)
- Need orchestration workflow patterns → [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)
- Need browserless runtime validation → [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)

### Known limitations and caveats

- **Local consumers exist beyond the browser:** the API is intended for trusted same-machine tools, including Agent OS style tooling. Treat `/api/v1` as a contracted local integration surface rather than a private implementation detail.
- **Claude channel `/events` caveat:** for parallel Claude-child monitoring on
  the same host, `GET /sessions/:id/events` can be less reliable than it is
  for Pi, OpenCode, and Antigravity. For Claude fan-out workflows, prefer
  `/wait` + `/transcript` as the safe fallback.
- **No parent/child metadata model yet:** the API does not yet expose
  `parentSessionId`, `orchestrationId`, or `GET /sessions?parent=...`.
  Orchestrators must track their own child-session relationships.
- **Run receipts are dispatch-scoped, not a queue:** every accepted Internal-API
  prompt has a durable `runId` and receipt, but Pi Web UI still does not expose
  a general-purpose job queue or scheduler. Use `GET /runs/:runId` for a
  detached run's state.
- **Pending approvals endpoint is informational:**
  `GET /sessions/:id/approvals/pending` currently reports state and guidance,
  not a true runtime-backed pending list.
- **`/history` and `/transcript` serve different needs:** `/history` is closer
  to replay/event reconstruction; `/transcript` is the easier runtime-agnostic
  result-reading surface for agents.

## Validation safety boundary

The default socket (`~/.pi-web-ui/internal-api.sock`) belongs to the running production Web UI. Agents must not use it for live validation unless the user explicitly asked to validate against production. Normal validation flow is:

1. `npm run validate:server` to boot an isolated disposable server.
2. Pass its `--socket` and `--token-path` to `validate:live`, `validate:long-horizon`, or custom validation clients.
3. Do not stop, restart, redeploy, or reconfigure `pi-web-ui.service` as part of validation unless the user explicitly asked for production service control.

The Internal API remains available for trusted local orchestration, but validation tasks are special because they are expected to exercise real runtimes without disturbing the user's active UI or real session data.

## Connection

### Socket Path

```
~/.pi-web-ui/internal-api.sock
```

This is a Unix domain socket. Only processes running on the same machine can
connect. The socket file has `0600` permissions (owner read/write only).

Configure with `INTERNAL_API_SOCKET_PATH` env var.

### Authentication

Read the API token:

```bash
cat ~/.pi-web-ui/internal-api-token
```

Include it in every request as a `Bearer` token:

```http
Authorization: Bearer <token>
```

The token is auto-generated on first startup. Set `INTERNAL_API_KEY` to
override with a fixed value.

### Making Requests (Python)

```python
import socket, json

SOCKET_PATH = "/home/user/.pi-web-ui/internal-api.sock"
TOKEN = open("/home/user/.pi-web-ui/internal-api-token").read().strip()

def api(method, path, body=None):
    """Send an HTTP request over the Unix socket."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(SOCKET_PATH)

    headers = f"{method} {path} HTTP/1.1\r\n"
    headers += f"Host: localhost\r\n"
    headers += f"Authorization: Bearer {TOKEN}\r\n"
    headers += "Content-Type: application/json\r\n"
    body_str = json.dumps(body) if body else ""
    headers += f"Content-Length: {len(body_str)}\r\n"
    headers += "\r\n"
    headers += body_str

    # For SSE streaming responses, use a proper HTTP client like httpx
    # This simple example works for non-streaming endpoints
    sock.sendall(headers.encode())
    response = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        response += chunk
    sock.close()

    # Split headers from body
    parts = response.split(b"\r\n\r\n", 1)
    if len(parts) < 2:
        return None
    return json.loads(parts[1])

# Or with httpx (recommended for streaming):
# import httpx
# client = httpx.Client(transport=httpx.HTTPTransport(uds=SOCKET_PATH))
# client.headers["Authorization"] = f"Bearer {TOKEN}"
```

### Making Requests (Node.js)

```typescript
import { request } from 'http';

const SOCKET_PATH = process.env.HOME + '/.pi-web-ui/internal-api.sock';
const TOKEN = require('fs').readFileSync(
  process.env.HOME + '/.pi-web-ui/internal-api-token', 'utf8'
).trim();

function api(method: string, path: string, body?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: SOCKET_PATH,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
```

## API Reference

### Base URL

```
http://localhost/api/v1
```

(Over Unix socket, the `Host` header is irrelevant.)

---

### Health

```
GET /api/v1/health
```

No authentication required.

**Response:**
```json
{
  "status": "ok",
  "contract": {
    "name": "pi-web-ui-internal-api",
    "routePrefix": "/api/v1",
    "majorVersion": "v1",
    "contractVersion": "1.7.0",
    "stability": "beta",
    "contractDoc": "docs/INTERNAL-API-CONTRACT.md"
  },
  "runtimes": {
    "pi": "available",
    "claude": "available",
    "opencode": "available",
    "antigravity": "available"
  },
  "uptime": 3600
}
```

---

### List Models

```
GET /api/v1/models
GET /api/v1/models?runtime=claude
GET /api/v1/models?runtime=antigravity
```

Models are always queried live — new models appear immediately. Each model may include `thinkingLevels`, the runtime-resolved levels accepted by that concrete model. Do not infer model-specific `max` support from the coarse `reasoning` flag.

Pi model levels come from the Pi SDK catalogue. Claude's base `sonnet` and `opus` aliases and provider profiles that support the Claude/Z.AI effort ceiling advertise `max`; `haiku` keeps the legacy ceiling. A client should use the selected model's `thinkingLevels` before requesting `max`.

**Query parameters:**

| Param | Values | Default |
|---|---|---|
| `runtime` | `pi`, `claude`, `opencode`, `antigravity` | all |

**Response:**
```json
{
  "models": {
    "pi": [
      { "id": "claude-sonnet-4-20250514", "displayName": "Claude Sonnet 4", "provider": "anthropic", "thinkingLevels": ["off", "minimal", "low", "medium", "high", "xhigh"] }
    ],
    "claude": [
      { "id": "sonnet", "displayName": "Sonnet", "provider": "anthropic", "reasoning": true, "thinkingLevels": ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      { "id": "opus", "displayName": "Opus", "provider": "anthropic", "reasoning": true, "thinkingLevels": ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      { "id": "haiku", "displayName": "Haiku", "provider": "anthropic", "reasoning": true, "thinkingLevels": ["off", "minimal", "low", "medium", "high", "xhigh"] },
      {
        "id": "profile:glm52-claude-sdk",
        "displayName": "GLM 5.2 — Claude SDK",
        "provider": "zai",
        "backend": "sdk-subscription",
        "claudeModel": "sonnet"
      }
    ],
    "opencode": [
      { "id": "glm-4-plus", "displayName": "GLM-4 Plus", "provider": "zai", "contextWindow": 128000 }
    ],
    "antigravity": [
      { "id": "Gemini 3.5 Flash (Medium)", "displayName": "Gemini 3.5 Flash (Medium)", "provider": "antigravity" }
    ]
  }
}
```

For Claude, automation clients can either:
- select a base alias such as `sonnet`, or
- select a specific provider profile via `model: "profile:<id>"`

Profile-backed Claude entries may include `backend` and `claudeModel` metadata so callers can deliberately choose SDK vs direct vs channel-backed sessions.

For OpenCode, which providers appear is governed by the `OPENCODE_MODEL_PROVIDERS`
allowlist (default `zai-coding-plan,kilo,opencode`; set `all` for every
authenticated provider). API keys never pass through Pi Web UI — they live only
in OpenCode's own auth storage. See
[`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md).

---

### Refresh OpenCode Models

```
POST /api/v1/models/refresh
```

Warms the models.dev catalogue cache, recycles the OpenCode backend (idle-aware —
deferred while any session is running), and returns a snapshot diff of what
changed. Drives the weekly automation (`npm run opencode:refresh-models`) but is
safe to call ad hoc. The response contains provider/model **ids only — never any
credentials**. See [`OPENCODE-MODEL-AUTOMATION.md`](./OPENCODE-MODEL-AUTOMATION.md).

**Body (optional):**

| Field | Type | Default | Description |
|---|---|---|---|
| `warmCache` | boolean | `true` | Run `opencode models` to refresh the on-disk models.dev cache first |
| `recycle` | boolean | `true` | Recycle the OpenCode backend so it reloads the catalogue (skipped while sessions run) |

**Response:**
```json
{
  "available": true,
  "cacheWarmed": true,
  "recycled": true,
  "recycleDeferred": false,
  "runningSessions": 0,
  "providerCount": 3,
  "modelCount": 355,
  "diff": {
    "addedModels": ["kilo/new-provider/new-model"],
    "removedModels": [],
    "addedProviders": [],
    "removedProviders": [],
    "changed": true
  },
  "snapshotPath": "~/.pi-web-ui/opencode-model-snapshot.json",
  "generatedAt": "2026-06-17T04:30:00.000Z"
}
```

Returns `503 OPENCODE_UNAVAILABLE` when OpenCode is not installed/enabled.

---

### Create Session

```
POST /api/v1/sessions
```

**Request:**
```json
{
  "runtime": "claude",
  "cwd": "/home/user/myproject",
  "model": "profile:glm52-claude-sdk",
  "pin": true,
  "pinTtlSeconds": 7200
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `runtime` | string | **Yes** | — | `pi`, `claude`, `opencode`, or `antigravity` |
| `cwd` | string | No | `process.cwd()` | Working directory |
| `model` | string | No | runtime default | Model ID (from `/models`). For Claude, may be a base alias such as `sonnet` or a specific profile entry such as `profile:glm52-claude-sdk`. |
| `thinkingLevel` | string | No | runtime default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; use the selected model's `thinkingLevels` from `/models` as the capability source. |
| `pin` | boolean | No | `false` | Pin the session at creation so it survives idle/timeout cleanup. Time-bounded — see [Session Pinning](#session-pinning-persistent-time-bounded). |
| `pinTtlSeconds` | number | No | `86400` (24h) | Pin lifetime in seconds when `pin:true`. Clamped to a hard max of 7 days. |
| `profileId` | string | No | — | Claude-only explicit profile selector. Equivalent to `model: "profile:<id>"` but sometimes easier for automation clients. |

**Response (201):**
```json
{
  "sessionId": "a1b2c3d4-...",
  "sessionPath": "a1b2c3d4-...",
  "runtime": "claude",
  "model": "profile:glm52-claude-sdk",
  "cwd": "/home/user/myproject",
  "createdAt": "2026-04-28T12:00:00.000Z",
  "pinned": true,
  "pinnedUntil": "2026-04-28T14:00:00.000Z"
}
```

When `pin:true` is requested but the runtime already has its maximum pinned
sessions (2), the session is still created and returned with `pinned: false`
and `"pinReason": "PIN_LIMIT_REACHED"` (unpin another session, then re-pin).

**Errors:**
- `400` — Missing `runtime` field
- `503` — Requested runtime not available

---

### List Sessions

```
GET /api/v1/sessions
```

**Response (200):**
```json
{
  "sessions": [
    {
      "sessionId": "a1b2c3d4-...",
      "sessionPath": "a1b2c3d4-...",
      "runtime": "claude",
      "executionInstanceId": "glm52-claude-sdk",
      "cwd": "/home/user/myproject",
      "model": "sonnet",
      "status": "idle",
      "messageCount": 14,
      "firstMessage": "Write a function that...",
      "createdAt": "2026-04-28T12:00:00.000Z",
      "lastActivity": "2026-04-28T12:05:00.000Z"
    }
  ]
}
```

---

### Get Session Details

```
GET /api/v1/sessions/:sessionId
GET /api/v1/sessions/:sessionId/info
```

`/info` is the preferred endpoint for live validation and local automation.
Both endpoints now return enriched runtime metadata where available.

**Response (200):**
```json
{
  "sessionId": "a1b2c3d4-...",
  "sessionPath": "a1b2c3d4-...",
  "runtime": "claude",
  "executionInstanceId": "glm52-claude-sdk",
  "backendMode": "sdk",
  "nativeSessionId": "claude-native-id",
  "sessionFile": "/root/.pi-web-ui/claude-sessions/a1b2c3d4-....jsonl",
  "cwd": "/home/user/myproject",
  "model": "profile:glm52-claude-sdk",
  "claudeProfileId": "glm52-claude-sdk",
  "claudeProfileBackend": "sdk-subscription",
  "claudeProviderId": "zai",
  "status": "idle",
  "messageCount": 14,
  "firstMessage": "Write a function...",
  "createdAt": "2026-04-28T12:00:00.000Z",
  "lastActivity": "2026-04-28T12:05:00.000Z",
  "pinned": false,
  "tokens": { "input": 500, "output": 200, "total": 700 },
  "cost": 0.003,
  "context": { "contextWindow": 200000, "used": 3200, "percent": 2 },
  "stats": {
    "userMessages": 8,
    "assistantMessages": 6,
    "toolCalls": 4,
    "toolResults": 4,
    "totalMessages": 22
  },
  "lastActivityAt": 1747744075000
}
```

**Errors:**
- `404` — Session not found

---

### Send Prompt

```
POST /api/v1/sessions/:sessionId/prompt
```

This is the main endpoint. It supports three verbosity levels that control
how much detail you receive.

**Request:**
```json
{
  "message": "Refactor this function to use async/await",
  "verbosity": "tasks",
  "mode": "prompt"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `message` | string | **Yes** | — | The prompt to send |
| `verbosity` | string | No | `answers` | `answers`, `tasks`, or `full` |
| `mode` | string | No | `prompt` | `prompt`, `follow_up`, or `steer` |
| `detach` | boolean | No | `false` | Fire-and-forget: run the pre-flight checks, start the turn, and return `202 Accepted` immediately without waiting. The turn keeps running server-side; read results later via `/info` + `/transcript`. Only valid with `verbosity=answers`. See [Detached dispatch](#detached-fire-and-forget-dispatch). |
| `idempotencyKey` | string | No | — | Session-scoped key, 1–128 characters. A matching request reuses the existing run within the default 24-hour TTL; a different request with the same live key returns `IDEMPOTENCY_KEY_CONFLICT`. The raw key is never persisted. |

You can also set verbosity via header: `X-Verbosity: tasks`

Notes:
- `follow_up` is supported on runtimes that report `supportsFollowUp=true`
- `steer` is currently Pi Coding Agent-only and returns `UNSUPPORTED_OPERATION` elsewhere

---

#### Verbosity: `answers` (default)

**Non-streaming.** Returns only the final assistant text after the turn
completes. The caller sees nothing while the agent works.

**Response (200):**
```json
{
  "sessionId": "a1b2c3d4-...",
  "runId": "run-…",
  "messageId": "msg_xyz",
  "content": "Here is the refactored function using async/await:\n\n```javascript\nasync function fetchData() {\n  const response = await fetch('/api/data');\n  return response.json();\n}\n```",
  "tokens": { "input": 150, "output": 80, "total": 230 },
  "cost": 0.001,
  "turnComplete": true
}
```

What is FILTERED OUT:
- Tool call start/update/end
- Agent start/end framing
- Turn start/end
- Thinking blocks
- Auto-compaction and auto-retry events
- System messages

Best for: voice chat, simple Q&A, any app that only wants the answer.

---

#### Verbosity: `tasks`

**Streaming (SSE).** Emits lightweight status headlines while the agent works,
plus the final answer text. Shows what's happening without raw tool details.

**Response:** `Content-Type: text/event-stream`

```
event: agent_start
data: {"type":"agent_start"}

event: task_status
data: {"type":"task_status","toolName":"Read","summary":"Reading config.json…"}

event: task_status
data: {"type":"task_status","toolName":"Bash","summary":"Running `npm test`…"}

event: task_status
data: {"type":"task_status","toolName":"Task","summary":"Delegating to architect…"}

event: message_start
data: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}

event: message_update
data: {"type":"message_update","message":{"id":"msg_1"},"text":"Here's the refactored code:..."}

event: message_end
data: {"type":"message_end","message":{"id":"msg_1"}}

event: agent_end
data: {"type":"agent_end","usage":{"input_tokens":150,"output_tokens":80}}

event: complete
data: {"sessionId":"a1b2c3d4-...","turnComplete":true}

event: done
data: {}
```

What you see:
- `X-Run-Id` response header identifies the durable run for this stream
- `task_status` events for each tool the agent runs (human-readable)
- `message_update` events with the assistant's text
- `agent_start`/`agent_end` for turn boundaries
- `error` events if something goes wrong

What is FILTERED OUT:
- Raw tool arguments and results
- Thinking blocks
- Auto-compaction/retry events

Best for: chat apps that want progress feedback without overwhelming detail.

---

#### Verbosity: `full`

**Streaming (SSE).** Every normalized event is streamed — tools, results,
thinking, everything. Identical to what the web UI sees.

**Response:** `Content-Type: text/event-stream`

```
event: agent_start
data: {"type":"agent_start"}

event: message_start
data: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}

event: message_update
data: {"type":"message_update","message":{"id":"msg_1"},"assistantMessageEvent":{...}}

event: tool_execution_start
data: {"type":"tool_execution_start","toolCallId":"tc_1","toolName":"Read","args":{"file_path":"config.json"}}

event: tool_execution_end
data: {"type":"tool_execution_end","toolCallId":"tc_1","toolName":"Read","result":"{\"port\": 3000}","isError":false}

event: message_end
data: {"type":"message_end","message":{"id":"msg_1"}}

event: agent_end
data: {"type":"agent_end","usage":{"input_tokens":200,"output_tokens":100}}

event: done
data: {}
```

Nothing is filtered. This is the raw agent event stream.

Best for: custom frontends that want full rendering control, debugging.

---

**Prompt errors:**
- `400` — Missing `message`, or prompt injection detected
- `404` — Session not found
- `409` — Session is currently busy (already streaming), or the idempotency key conflicts with a different request
- `500` — Runtime error during execution

---

### Run identity and receipts

Every prompt accepted by the Internal API receives a `runId`. Answers-mode
responses include it as a JSON field, detached responses include it alongside
`202 Accepted`, and streaming responses expose it in the additive `X-Run-Id`
header without changing the SSE event envelope.

```text
GET /api/v1/runs/:runId
```

The lookup returns the persisted receipt directly:

```json
{
  "runId": "run-…",
  "sessionId": "a1b2c3d4-…",
  "runtime": "claude",
  "executionInstanceId": "glm52-claude-sdk",
  "model": "profile:glm52-claude-sdk",
  "status": "completed",
  "acceptedAt": "2026-07-15T12:00:00.000Z",
  "startedAt": "2026-07-15T12:00:00.100Z",
  "agentEndAt": "2026-07-15T12:00:03.000Z",
  "terminalAt": "2026-07-15T12:00:03.000Z",
  "idempotencyExpiresAt": "2026-07-16T12:00:00.000Z"
}
```

Receipt statuses are `accepted`, `started`, `completed`, `failed`,
`cancelled`, and `interrupted`. `interrupted` is written during startup
recovery when a process died or was restarted while a run was accepted or
started; its `errorCode` is `SERVER_RESTART` and it is not automatically
retried. Receipts contain identity, timestamps, status, and stable error codes
only — never prompt text, transcript bodies, credentials, cookies, or tokens.

Idempotency is scoped to `(sessionId, idempotencyKey)` and defaults to 24 hours
from acceptance (`INTERNAL_API_RUN_IDEMPOTENCY_TTL_MS`). A same-key retry with
the same message/mode/verbosity/detach returns HTTP 200 with
`{ sessionId, runId, duplicate: true, receipt }` (plus `detached: true` when
applicable) and does not invoke the runtime again. A same-key request with a
different fingerprint returns `409 IDEMPOTENCY_KEY_CONFLICT`; after the TTL, the key may be reused
for a new run while the old receipt remains subject to bounded retention. If a
local busy, state-check, or receipt-persistence race rejects the reservation
*before* runtime dispatch, its receipt remains as cancelled/failed evidence but
the key is released so a later retry can perform the work.

Receipts are persisted under `INTERNAL_API_RUN_RECEIPTS_DIR` (default
`~/.pi-web-ui/run-receipts`). Retention targets terminal receipts older than 30
days and terminal receipts beyond the newest 1,000 (an unexpired 24-hour
idempotency window is never pruned early). Pruning runs during receipt writes
and server startup; old receipts may return `RUN_NOT_FOUND` after retention.

`executionInstanceId` is the Claude profile id when recorded (or
`claude-default` for older sessions without profile metadata). Pi, OpenCode,
and Antigravity use `pi-local-default`, `opencode-default`, and
`antigravity-default` respectively.

---

### Capabilities

```
GET /api/v1/capabilities
```

Use this first if you are building tools or running live validation.
It reports runtime availability, Claude backend mode, and feature flags.
For Claude, `backendMode` is broad (`sdk`, `direct`, or `channel`); use model/profile metadata from `/models` or session info when you need the exact selected provider profile.

**Response (200):**
```json
{
  "status": "ok",
  "contract": {
    "name": "pi-web-ui-internal-api",
    "routePrefix": "/api/v1",
    "majorVersion": "v1",
    "contractVersion": "1.7.0",
    "stability": "beta",
    "contractDoc": "docs/INTERNAL-API-CONTRACT.md"
  },
  "runtimes": {
    "pi": {
      "available": true,
      "backendMode": "native",
      "supportsFollowUp": true,
      "supportsSteer": true,
      "supportsModelSwitch": true,
      "supportsThinkingLevel": true,
      "supportsPinning": true,
      "supportsReplayHistory": false,
      "supportsApprovals": false,
      "supportsHeartbeat": false
    },
    "claude": {
      "available": true,
      "backendMode": "channel",
      "supportsFollowUp": true,
      "supportsSteer": false,
      "supportsModelSwitch": true,
      "supportsThinkingLevel": true,
      "supportsPinning": true,
      "supportsReplayHistory": true,
      "supportsApprovals": true,
      "supportsHeartbeat": true
    },
    "opencode": {
      "available": true,
      "backendMode": "server",
      "supportsFollowUp": true,
      "supportsSteer": false,
      "supportsModelSwitch": true,
      "supportsThinkingLevel": false,
      "supportsPinning": true,
      "supportsReplayHistory": true,
      "supportsApprovals": true,
      "supportsHeartbeat": false
    },
    "antigravity": {
      "available": true,
      "backendMode": "subprocess",
      "supportsFollowUp": true,
      "supportsSteer": false,
      "supportsModelSwitch": true,
      "supportsThinkingLevel": false,
      "supportsPinning": true,
      "supportsReplayHistory": true,
      "supportsApprovals": false,
      "supportsHeartbeat": false
    }
  }
}
```

---

### Diagnostics (self-service logs)

In-process observability over the same Unix socket agents already use — no need
to shell out to `journalctl` (often unavailable in an agent sandbox). A bounded
ring buffer captures recent structured log lines (secret-scrubbed on push), and
these endpoints return them. Authed like every other route (only `/health` is
exempt). See [`docs/OBSERVABILITY.md`](./OBSERVABILITY.md).

```
GET /api/v1/diagnostics                       # global recent logs + errors + summary
GET /api/v1/diagnostics?limit=200&minLevel=warn
GET /api/v1/sessions/:sessionId/diagnostics   # scoped to one session
```

**Query parameters:**

| Param | Values | Default | Notes |
|---|---|---|---|
| `limit` | 1–1000 | 200 | Max records returned |
| `minLevel` | `error`,`warn`,`info`,`debug` | (all) | Include this severity and above |

**Response (200):**
```json
{
  "recentLogs": [
    { "ts": "2026-06-23T12:00:00.000Z", "level": "info", "component": "InternalAPI",
      "msg": "Prompt dispatched: runtime=pi …", "requestId": "req_…", "sessionId": "…", "runtime": "pi" }
  ],
  "recentErrors": [ { "ts": "...", "level": "error", "component": "...", "msg": "...", "error": { "name": "Error", "message": "...", "stack": "..." } } ],
  "summary": { "bufferedRecords": 35, "errorCount": 0, "warnCount": 1, "oldestTs": "...", "newestTs": "..." }
}
```

Each record is a scrubbed structured log line. Secret values (tokens, passwords,
`Bearer …`, `sk-…` keys, sensitive keys like `apiKey`/`authorization`) are
redacted to `[REDACTED]` before they reach the buffer, so diagnostics never leak
credentials. `requestId`/`sessionId` are preserved so an agent can correlate a
diagnostics slice with a prompt's lifecycle.

**Errors:**
- `401` — Missing/invalid token (authed like siblings)

---

### Event-type registry

A machine-readable catalogue of the normalized event kinds emitted on the
`/events` SSE stream, so consumers no longer have to infer event shapes from
docs + source. Derived from the contracted `SSE_EVENT_TYPES` so it cannot drift
from the stream. See [`docs/EVENT-PIPELINE.md`](./EVENT-PIPELINE.md).

```
GET /api/v1/events/types
```

**Response (200):**
```json
{
  "eventTypes": [
    { "type": "agent_start", "description": "A prompt turn started.", "category": "agent", "verbosity": ["full", "tasks"] },
    { "type": "message_update", "description": "Incremental assistant content (text delta).", "category": "message", "verbosity": ["full", "tasks"] },
    { "type": "tool_execution_end", "description": "A tool call finished (result included in full).", "category": "tool", "verbosity": ["full"] }
  ]
}
```

`category` is `agent | message | tool | control`. `verbosity` lists which stream
levels include the event (`full` = every event; `tasks` = the status-headline
subset). Authed like siblings.

---

### Notifications

One-way operator notifications on `agent_end`, plus explicit emits for local
consumers such as Agent OS or scripts. See [`NOTIFICATIONS.md`](./NOTIFICATIONS.md)
for the subsystem design, delivery semantics, env vars, and browser route.

```
POST   /api/v1/sessions/:sessionId/notifications/opt-in
DELETE /api/v1/sessions/:sessionId/notifications/opt-in
GET    /api/v1/sessions/:sessionId/notifications
POST   /api/v1/notifications
GET    /api/v1/notifications
```

Use them like this:
- opt a session in when you want a Telegram ping on the next `agent_end`
- read session notification state/deliveries for ops/debug
- emit an explicit notification deterministically from another local tool
- inspect recent deliveries and failures without touching host logs

**Examples**

```json
POST /api/v1/sessions/:id/notifications/opt-in
{ "label": "Overnight refactor" }
```

```json
POST /api/v1/notifications
{ "title": "Agent OS", "body": "Review requested", "deepLink": "https://pi.example.com/?session=abc" }
```

`GET /api/v1/notifications` returns recent deliveries with `status`, `attempts`,
and `lastError`; `GET /api/v1/sessions/:id/notifications` scopes that to one
session and includes the current `optIn` record.

---

### Session Control
```
POST /api/v1/sessions/:sessionId/control
```

Examples:

```json
{ "action": "set_model", "modelId": "opus" }
{ "action": "set_thinking_level", "level": "high" }
{ "action": "set_thinking_level", "level": "max" }
{ "action": "pin" }
{ "action": "pin", "pinTtlSeconds": 7200 }
{ "action": "unpin" }
```

`pin` grants a **time-bounded** API pin (default 24h, hard max 7d) that protects
the session from idle/timeout cleanup, and returns the absolute expiry as
`pinnedUntil`. Re-pinning extends the deadline. If the runtime is already at its
maximum pinned sessions (2), the response is `pinned: false` with
`"pinReason": "PIN_LIMIT_REACHED"`. `unpin` revokes the pin and clears its expiry
record. See [Session Pinning](#session-pinning-persistent-time-bounded).

`set_thinking_level` accepts `off | minimal | low | medium | high | xhigh | max`.
For Claude, `max` is forwarded to the SDK/direct CLI/channel effort control;
for Pi it is clamped by the selected model's SDK capabilities; and for
OpenCode it maps to that model's reasoning control. Clients should use the selected model's `thinkingLevels` from `/models` before requesting it.

For the OpenCode runtime the level is translated, capability-aware, into the model's
reasoning controls in `opencode.json` (GLM → `thinking` + `reasoning_effort`;
other reasoning-capable gateway models → `reasoning_effort`; non-reasoning models
→ no-op) and the idle backend is recycled so the next prompt picks it up. See
[`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md#reasoning-effort--thinking-control-capability-aware).

---

### Session History

```
GET /api/v1/sessions/:sessionId/history
```

Returns normalized replay events. All four runtimes are supported:
- **Claude** and **OpenCode** return native normalized replay events.
- **Antigravity** returns replay events reduced from Pi-owned turn logs.
- **Pi** returns a synthesized event list derived from the Pi session
  JSONL file (each user/assistant/tool line becomes a `message_end` or
  `tool_execution_end` event). This is a best-effort path because the
  Pi Coding Agent does not persist normalized events natively.

Use `GET /api/v1/capabilities` first to discover per-runtime replay
support (`supportsReplayHistory`).

For a runtime-agnostic, easier-to-consume view, prefer
`GET /api/v1/sessions/:sessionId/transcript`.

---

### Approval Responses

```
POST /api/v1/sessions/:sessionId/approvals/:requestId/respond
```

**Request (permission response):**
```json
{ "approved": true }
```

This is currently useful for Claude channel-backed permission requests and
OpenCode permission flows.

### Claude SDK `AskUserQuestion` responses

The same `/approvals/:requestId/respond` endpoint resolves a pending Claude SDK
`AskUserQuestion` request when the session's backend is the SDK backend. The
body carries structured answers rather than a simple approval:

**Request:**
```json
{
  "approved": true,
  "answers": {
    "Which region?": "eu-west-1",
    "What size?": "small"
  },
  "annotations": {
    "Which region?": { "preview": "eu-west-1", "notes": "closest to users" }
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `approved` | boolean | **Yes** | Always `true` for a real answer; `false` is equivalent to `cancelled: true` |
| `answers` | object (string→string) | when not cancelled | Map from exact question text to the selected/checked answer(s). For multi-select questions, answers are comma-separated. |
| `annotations` | object | no | Optional per-question annotations (`preview`, `notes`). |
| `cancelled` | boolean | no | Set `true` to dismiss the dialog without answering. |

The SDK backend resolves the pending `canUseTool` callback with the answers and
Claude's turn continues. If the request is no longer pending (e.g. it just
timed out or the session disconnected), the endpoint returns:

```json
{ "error": "That question already closed, so the answer was not delivered to the assistant.", "code": "ASK_ALREADY_CLOSED" }
```

with HTTP `409`. This replaces the earlier silent-drop behavior.

---

## Orchestration Endpoints

The endpoints below turn the Internal API into a first-class surface for
**multi-agent orchestration** — e.g. a parent agent that spawns parallel
child sessions on different runtimes, monitors them, collects results,
and transfers context between them. They are additive and do not change
any existing endpoint.

### Which endpoint should an orchestrator use?

| Need | Preferred endpoint | Notes |
|---|---|---|
| Discover runtime support before planning | `GET /capabilities`, `GET /models` | Ask what exists before choosing runtimes/models |
| Create one child | `POST /sessions` | Use for explicit one-off session creation |
| Create many children | `POST /sessions/batch` | Parallel provisioning helper |
| Dispatch a prompt and only care about the final answer | `POST /sessions/:id/prompt` with `verbosity=answers` | Simplest request/response path |
| Watch progress live | `GET /sessions/:id/events` | Best for Pi / OpenCode / Antigravity, and for single-session Claude monitoring |
| Wait for a child to finish safely | `GET /sessions/:id/wait` | Recommended fallback for Claude fan-out cases |
| Read child output in a runtime-agnostic form | `GET /sessions/:id/transcript` | Best default for orchestrators |
| Read what the user sees by default | `GET /sessions/:id/transcript?view=screen` | Fastest read-only UI-faithful view |
| Reconstruct UI-style event replay | `GET /sessions/:id/history` | Lower-level replay/event shape |
| Hand child context into another session | `POST /sessions/:id/transfer` | Reuses the same transfer machinery as the web UI |
| Sum usage/cost across children | `POST /sessions/usage` | Aggregate report |
| Inspect approval state | `GET /sessions/:id/approvals/pending` | Currently informational only; use `/events` to observe approval requests live |
| Watch for a condition over a long horizon | `POST/GET /sessions/:id/watch` | Durable, restart-surviving ledger; poll instead of holding `/events`. See [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md) |

### Persistent Event Stream

```
GET /api/v1/sessions/:sessionId/events
```

Opens a long-lived SSE subscription that receives every normalized agent
 event for the session — including events emitted by other clients
(WebSocket, the runtime SDK, or another Internal API caller). This is
the recommended way to monitor a child session without holding the
prompt request open.

For **Claude channel-backed** parallel fan-out on the same host, treat this
endpoint as best-effort rather than perfect. If a Claude child matters more
than live progress rendering, use `/wait` + `/transcript` as the robust path.

**Response:** `Content-Type: text/event-stream`

```
event: agent_start
data: {"type":"agent_start","sessionId":"...","timestamp":...,"data":{}}

event: message_update
data: {"type":"message_update",...}

event: agent_end
data: {"type":"agent_end",...}
```

Each SSE event is one normalized event with `event:` set to the event
type and `data:` set to the full event JSON. The connection stays open
across multiple prompts. Up to 100 recent events are buffered per
session and replayed to late subscribers on connect (so you can open
the stream after dispatching a prompt and still see the start of the
turn). Send `Connection: close` or simply disconnect to unsubscribe.

**Errors:**
- `404` — Session not found

---

### Wait For Status

```
GET /api/v1/sessions/:sessionId/wait?status=idle&timeout=60000
```

Blocks until the session reaches the target status or the timeout
expires. Useful for polling-free orchestration: dispatch an async-style
prompt (or several), then call `/wait` on each.

**Query parameters:**

| Param | Values | Default | Notes |
|---|---|---|---|
| `status` | `idle`, `running` | `idle` | Target status to wait for |
| `timeout` | milliseconds (0–300000) | `60000` | Caps at 5 minutes |

**Response (200):**
```json
{
  "sessionId": "...",
  "status": "idle",
  "waitedMs": 1234
}
```

`status` is `timeout` if the target was never reached within `timeout`.

---

### Universal Transcript

```
GET /api/v1/sessions/:sessionId/transcript?scope=visible_recent
```

Returns a runtime-agnostic transcript for any of the four runtimes,
suitable for an orchestrator that needs to read child-session results
without parsing runtime-specific files.

**Query parameters:**

| Param | Values | Default |
|---|---|---|
| `scope` | `visible_recent`, `visible_full` | `visible_recent` |
| `view` | `screen` | (unset → transcript) |
| `expand` | `tools`, `thinking` (comma-separated) | (unset) |

`visible_recent` returns the most recent 20 visible items; `visible_full`
returns the entire visible transcript.

Pass `view=screen` to instead receive a **read-only screen-view projection** —
a faithful "what the user sees by default" snapshot of the session (visible
messages, collapsed tool cards, summarized/collapsed thinking, tool groups,
skill placeholders). This is the fastest way for an agent to read what the user
sees without driving a browser. See [Screen view (`view=screen`)](#screen-view-viewscreen)
below.

Choose the read path like this:
- use plain `/transcript` for runtime-agnostic result extraction
- use `/transcript?view=screen` for operator-visible state / what the user sees
- use `/history` for replay/debug reconstruction rather than ordinary result reading

**Response (200):**
```json
{
  "sessionId": "...",
  "runtime": "claude",
  "scope": "visible_recent",
  "itemCount": 4,
  "truncated": false,
  "items": [
    { "kind": "user", "text": "Refactor this", "timestamp": 1747744000000 },
    { "kind": "tool", "text": "...", "timestamp": 1747744001000, "toolName": "Read", "toolPrimaryArg": "/path/file" },
    { "kind": "assistant", "text": "Done.", "timestamp": 1747744002000 }
  ],
  "source": {
    "sessionId": "...",
    "displayName": "Refactor this",
    "sdkType": "claude",
    "cwd": "/root/proj",
    "createdAt": "...",
    "lastActivity": "..."
  }
}
```

`kind` is `user`, `assistant`, or `tool`. Tool items include the
human-readable result text (truncated to 200 chars), the tool name, and
the primary argument (file path, command, pattern, etc.).

**Errors:**
- `404` — Session not found, or no visible transcript (empty session)

---

### Screen view (`view=screen`)

```
GET /api/v1/sessions/:sessionId/transcript?view=screen
GET /api/v1/sessions/:sessionId/transcript?view=screen&expand=tools,thinking
```

A **read-only** projection of *what the user sees by default on screen* in the
session — the resting default view you get when you open a finished session:
visible user/assistant messages, **collapsed** tool cards (output hidden),
**summarized/collapsed** thinking, **collapsed tool groups** (3+ consecutive
tools), and skill content collapsed to a `📚 Skill loaded: …` placeholder.

This is the foundation for letting an agent (Claude or a cheaper delegated
agent) read a session exactly as the user sees it, without the bloat of raw
session logs or the auth friction of driving the UI with Playwright. It is
strictly read-only — it never starts a session, sends a prompt, or writes state
— and is safe to call against a production instance.

The session resolves by **any id form** (internal id, registry path, Claude
session id, OpenCode session id, or Antigravity conversation id) — whatever the
user reads out of the Session Info box.

`expand` is a comma-separated opt-in that surfaces content that is collapsed by
default:

| Value | Surfaces |
|---|---|
| `tools` | full (truncated-to-200-char) tool output, and un-groups tool groups into individual tool items |
| `thinking` | the full thinking text behind the summarized thinking items |

All four runtimes are supported (Pi, Claude, OpenCode, Antigravity); a
thin/empty session yields a valid (empty) view rather than an error.

**Response (200):**
```json
{
  "sessionId": "...",
  "runtime": "claude",
  "view": "screen",
  "expanded": { "tools": false, "thinking": false },
  "screenView": {
    "items": [
      { "kind": "user", "text": "Refactor this", "collapsedByDefault": false, "estimatedLines": 1, "timestamp": 1747744000000 },
      { "kind": "tool_group", "text": "(3 tools)", "collapsedByDefault": true, "groupSize": 3, "estimatedLines": 1 },
      { "kind": "assistant", "text": "Done.", "collapsedByDefault": false, "estimatedLines": 1 }
    ],
    "itemCount": 3,
    "estimatedTotalLines": 3,
    "expanded": { "tools": false, "thinking": false }
  },
  "markdown": "# Screen view\n\nItems: 3\n...\n## 👤 User\n\nRefactor this\n...",
  "source": {
    "sessionId": "...",
    "displayName": "Refactor this",
    "sdkType": "claude",
    "cwd": "/root/proj",
    "createdAt": "...",
    "lastActivity": "..."
  }
}
```

`screenView.items[].kind` is `user` | `assistant` | `tool` | `tool_group` |
`thinking`. `markdown` is a stable, rendered "text screenshot" an agent can read
directly. The projection is shared with the client (`@pi-web-ui/shared`), so the
agent's view and the user's screen are defined by one body of code.

**Errors:**
- `404` — Session not found (no id form matched)

---

### Cross-Session Context Transfer

```
POST /api/v1/sessions/:sessionId/transfer
```

Transfers the visible transcript of the session into another session
(or a freshly created one), across runtimes. Mirrors the WebSocket
`transfer_session_context` message and reuses the same `TransferService`.

**Request — into an existing session:**
```json
{
  "targetSessionId": "target-uuid",
  "scope": "visible_recent"
}
```

**Request — into a new session:**
```json
{
  "createNew": true,
  "targetRuntime": "claude",
  "targetCwd": "/root/new-project",
  "scope": "visible_full"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `targetSessionId` | string | one of targetSessionId/createNew | Existing target session |
| `createNew` | boolean | one of targetSessionId/createNew | Create a fresh target |
| `targetRuntime` | string | when `createNew` | `pi`, `claude`, `opencode`, or `antigravity` |
| `targetCwd` | string | no | CWD for new session (defaults to source CWD) |
| `scope` | string | no | `visible_recent` (default) or `visible_full` |
| `sourceDisplayName` | string | no | Label for the source in the handoff header |

**Response (200):**
```json
{
  "success": true,
  "sourceSessionId": "...",
  "targetSessionId": "new-uuid",
  "createdNewSession": true,
  "targetSessionPath": "...",
  "targetRuntime": "claude"
}
```

A successful response means the target runtime has accepted the handoff; it
does **not** wait for the target's whole agent turn to finish. The transfer
framing explicitly makes the target wait silently for the next user
instruction.

On failure the response is HTTP 400 with `success: false` and an `error`
object containing a transfer error code (e.g.
`TRANSFER_TARGET_BUSY`, `TRANSFER_EMPTY_SOURCE`).

---

### Batch Session Creation

```
POST /api/v1/sessions/batch
```

Creates multiple sessions in one call. All entries are dispatched in
parallel.

**Request:**
```json
{
  "sessions": [
    { "runtime": "claude", "cwd": "/root/a", "model": "sonnet", "thinkingLevel": "max", "pin": true },
    { "runtime": "opencode", "cwd": "/root/b" },
    { "runtime": "antigravity", "model": "Gemini 3.5 Flash (Medium)" }
  ]
}
```

Each entry accepts the same fields as `POST /sessions`, including
`thinkingLevel`, `pin`, and `pinTtlSeconds` (see [Session Pinning](#session-pinning-persistent-time-bounded));
each result item echoes `pinned` / `pinnedUntil` when pinned.

**Response (200):**
```json
{
  "created": [
    { "index": 0, "success": true, "sessionId": "...", "sessionPath": "...", "runtime": "claude", "model": "sonnet", "cwd": "/root/a" },
    { "index": 1, "success": false, "runtime": "opencode", "error": { "code": "SESSION_CREATE_FAILED", "message": "..." } }
  ],
  "createdCount": 1,
  "failedCount": 1
}
```

---

### Batch Prompt Dispatch

```
POST /api/v1/sessions/batch/prompt
```

Sends a prompt to each of several sessions in one call. Each entry
runs in `answers` mode (final text only). By default all prompts run
in parallel; set `parallel: false` to run them sequentially.

**Request:**
```json
{
  "prompts": [
    { "sessionId": "child-1", "message": "Summarise this file", "idempotencyKey": "child-1-summarise-1" },
    { "sessionId": "child-2", "message": "Write a unit test" }
  ],
  "parallel": true
}
```

**Response (200):**
```json
{
  "results": [
    { "index": 0, "sessionId": "child-1", "success": true, "content": "...", "tokens": { "input": 10, "output": 20, "total": 30 } },
    { "index": 1, "sessionId": "child-2", "success": false, "error": { "code": "RUNTIME_ERROR", "message": "..." } }
  ],
  "successCount": 1,
  "failedCount": 1
}
```

Each entry is independently prompt-injection-checked. Missing sessions,
busy runtimes, and runtime failures are reported per-item without aborting the
batch. An idempotent retry returns `runId`, `duplicate: true`, and the current
`receipt`; duplicate batch results intentionally omit `content` because
receipts never persist transcript bodies. Fetch the session transcript if the
answer text is needed again.

---

### Aggregate Usage

```
POST /api/v1/sessions/usage
```

Sums token usage and cost across a set of sessions.

**Request:**
```json
{ "sessionIds": ["child-1", "child-2", "child-3"] }
```

**Response (200):**
```json
{
  "sessionIds": ["child-1", "child-2", "child-3"],
  "counted": ["child-1", "child-2"],
  "missing": ["child-3"],
  "totals": { "input": 27, "output": 35, "total": 62, "cost": 0.0085 },
  "perSession": [
    { "sessionId": "child-1", "runtime": "claude", "input": 20, "output": 30, "total": 50, "cost": 0.0065 },
    { "sessionId": "child-2", "runtime": "opencode", "input": 7, "output": 5, "total": 12, "cost": 0.0020 }
  ]
}
```

Sessions that cannot be found are listed under `missing` and excluded
from the totals.

---

### List Pending Approvals

```
GET /api/v1/sessions/:sessionId/approvals/pending
```

Returns the current pending-approval state for a session. Note: the
runtime services do not yet expose a synchronous pending list, so the
`approvals` array is currently always empty. To observe approvals as
they arise, subscribe to `GET /sessions/:id/events` and watch for
`permission_request` events.

**Response (200):**
```json
{
  "sessionId": "...",
  "runtime": "claude",
  "status": "idle",
  "approvals": [],
  "note": "Pending approvals must be observed via GET /sessions/:id/events. ..."
}
```

---



### Watch (long-horizon validation)

A **watch** is a durable, server-side standing observer on a session. It
evaluates generic, runtime-neutral conditions against the normalized event
stream and records every match to a disk-backed ledger that survives the
observer disconnecting, the session going idle, and a **server restart**. This
decouples observation from the observer's liveness: a headless validator can
register a watch, sleep for an hour, then poll for what fired — without holding
any connection open. See [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md).

```
POST   /api/v1/sessions/:sessionId/watch     # register (one per session); pins the subject
GET    /api/v1/sessions/:sessionId/watch     # poll: fired conditions + ledger + snapshot
DELETE /api/v1/sessions/:sessionId/watch     # tear down
```

**Register body:**
```json
{
  "conditions": [
    { "id": "sentinel", "type": "text", "contains": "GOAL-OK" },
    { "type": "event_type", "eventType": "session_compaction" },
    { "type": "tool", "toolName": "Bash", "phase": "end", "argIncludes": "PASS" }
  ],
  "pin": true,
  "label": "goal-survives-compaction"
}
```

Condition types (all generic): `event_type` (`eventType` + optional `dataMatch`),
`tool` (`toolName`, `phase`, `argIncludes`), `text` (`contains` or
`pattern`/`patternFlags`, `source`). Common fields: `id` (auto `c0`,`c1`,…),
`once` (default `true`). Registering pins the subject by default so idle
eviction can't kill it mid-watch.

**Poll response (200):**
```json
{
  "watchId": "watch-...",
  "sessionId": "...",
  "runtime": "pi",
  "status": "active",
  "pinned": true,
  "conditions": [ { "id": "sentinel", "type": "text", "fired": true, "fireCount": 1, "firstFiredAt": 1747744002000 } ],
  "firings": [ { "conditionId": "sentinel", "firedAt": 1747744002000, "eventType": "message_update", "evidence": "…GOAL-OK…" } ],
  "firingCount": 1,
  "pendingConditionIds": [],
  "allFired": true,
  "snapshot": { "status": "idle", "eventCount": 12, "toolCallCount": 2, "sawAgentEnd": true }
}
```

`GET ...?sinceIndex=N` returns only firings after the caller's last poll;
`firingCount` stays the absolute total. `status` is `active`, `detached`
(reloaded from disk after a restart — past firings readable, new ones need a
re-register), or `closed`.

**Errors:**
- `400` — empty `conditions`, or an invalid regex `pattern`
- `404 WATCH_NOT_FOUND` — no watch registered (GET/DELETE)
- `404 SESSION_NOT_FOUND` — session does not exist (POST)

---

### Session Pinning (persistent, time-bounded)

A **pin** protects a session from idle/timeout eviction so a longer-running task
isn't cleaned up while it works. The web UI has always pinned sessions (max 2 per
runtime); the Internal API now exposes the same guarantee as a first-class,
**standalone** operation — no watch or long-horizon machinery required.

Use it for the common agent workflow: *"kick off a longer task, make sure it
survives, and check back later — without being locked into polling."*

```
POST /api/v1/sessions                       # { "runtime": "claude", "pin": true, "pinTtlSeconds": 7200 }
POST /api/v1/sessions/:id/control           # { "action": "pin", "pinTtlSeconds": 3600 }
POST /api/v1/sessions/:id/control           # { "action": "unpin" }
GET  /api/v1/sessions/:id/info              # reports pinned + pinnedUntil
```

**Behaviour and rules (read these):**

- **Time-bounded by default.** Every API pin carries an absolute expiry returned
  as `pinnedUntil` (ISO). Default lifetime **24h**; hard maximum **7 days**
  (longer requests are clamped). This is deliberate: a pin must not hold a slot
  forever. Configure via `INTERNAL_API_PIN_DEFAULT_TTL_MS` /
  `INTERNAL_API_PIN_MAX_TTL_MS`.
- **Renewable.** Calling `pin` again (create-time or control) extends the
  deadline — re-pin periodically to keep a genuinely long task alive.
- **Auto-revoked.** A background sweep revokes pins past their `pinnedUntil`, so
  resources are reclaimed even if the caller disappears.
- **Restart-safe.** Pin records are persisted to a disk-backed ledger
  (`~/.pi-web-ui/pins/`). On server restart, still-valid pins are re-applied and
  already-expired ones are revoked immediately.
- **Max 2 per runtime per server instance**, same as the web UI. A production
  server and an isolated validation server each have their own pin slots and
  durable pin ledger. At the limit, `pin:true` still creates the session but
  returns `pinned: false`, `pinReason: PIN_LIMIT_REACHED`.
- **Independent of the watch.** A long-horizon watch also pins by default, but
  you can pin with no watch at all. Deleting a watch does **not** unpin — pin and
  watch are separate primitives.

**Pin-only vs pin+watch vs nothing:**

| Goal | Use |
|---|---|
| Long task that should survive cleanup; check back whenever | **pin only** (`pin:true` on create, or `control pin`) |
| Long task where you also want durable, restart-surviving condition detection | **pin + watch** (the watch pins by default) |
| Short, synchronous task | neither — just `prompt` and read the answer |

Combine pin-only with [detached dispatch](#detached-fire-and-forget-dispatch) for
the full "set a long task and walk away" pattern: create a pinned session,
dispatch a detached prompt, then read `/info` + `/transcript` later.

---

### Detached (fire-and-forget) dispatch

```
POST /api/v1/sessions/:sessionId/prompt      # { "message": "...", "detach": true }
```

`detach: true` runs the normal pre-flight checks (session exists, not busy,
prompt-injection scan), **starts the turn, and returns `202 Accepted`
immediately** without waiting for it to complete:

```json
{ "sessionId": "a1b2c3d4-...", "runId": "run-…", "detached": true, "status": "accepted" }
```

The turn keeps running server-side — a disconnected request does **not** abort
it — and every event still flows into the broker, so `GET /sessions/:id/events`
and `GET /sessions/:id/transcript` observe progress whenever you look. This is
exactly how the long-horizon runner dispatches seeds, promoted to a declared
contract.

Rules:

- Only valid with `verbosity=answers` (streaming needs the connection). Any other
  verbosity with `detach:true` returns `400 INVALID_REQUEST`.
- Still subject to the busy check — a session processes one prompt at a time.
- Read results later via `GET /sessions/:id/info` (`status: idle|running`) and
  `GET /sessions/:id/transcript`.

---

### Abort Session

```
POST /api/v1/sessions/:sessionId/abort
```

Cancels a running prompt.

**Response (200):**
```json
{ "success": true }
```

**Errors:**
- `404` — Session not found

---

### Delete Session

```
DELETE /api/v1/sessions/:sessionId
```

Removes the session from the registry. If the session is running, it will
be aborted first.

**Response (200):**
```json
{ "success": true }
```

**Errors:**
- `404` — Session not found

---

## End-to-End Example

### Python: Simple voice-chat style usage

```python
import socket, json, os

SOCKET = os.path.expanduser("~/.pi-web-ui/internal-api.sock")
TOKEN = open(os.path.expanduser("~/.pi-web-ui/internal-api-token")).read().strip()

def request(method, path, body=None):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(SOCKET)
    body_str = json.dumps(body) if body else ""
    req = f"{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {len(body_str)}\r\n\r\n{body_str}"
    sock.sendall(req.encode())
    resp = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk: break
        resp += chunk
    sock.close()
    _, body = resp.split(b"\r\n\r\n", 1)
    return json.loads(body)

# 1. List available models
models = request("GET", "/api/v1/models")
print("Claude models:", [m["id"] for m in models["models"]["claude"]])

# 2. Create a session
session = request("POST", "/api/v1/sessions", {
    "runtime": "claude",
    "model": "sonnet",
})
print(f"Session: {session['sessionId']}")

# 3. Ask a question (answers mode — just the final text)
result = request("POST", f"/api/v1/sessions/{session['sessionId']}/prompt", {
    "message": "What is the capital of France?",
    "verbosity": "answers",
})
print(f"Answer: {result['content']}")

# 4. The same session now appears in the Pi Web UI sidebar!
```

### Node.js: Full-verbosity streaming consumer

```typescript
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';

const SOCKET = `${os.homedir()}/.pi-web-ui/internal-api.sock`;
const TOKEN = fs.readFileSync(`${os.homedir()}/.pi-web-ui/internal-api-token`, 'utf8').trim();

function streamPrompt(sessionId: string, message: string, onEvent: (event: any) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: SOCKET,
      path: `/api/v1/sessions/${sessionId}/prompt`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
    }, (res) => {
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        // Parse SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            onEvent(data);
            if (data.type === 'agent_end') resolve();
          }
        }
      });
      res.on('end', resolve);
    });

    req.on('error', reject);
    req.write(JSON.stringify({ message, verbosity: 'full' }));
    req.end();
  });
}

// Usage
const session = { sessionId: 'abc-123' };
await streamPrompt(session.sessionId, 'Build a todo app', (event) => {
  if (event.type === 'tool_execution_start') {
    console.log(`🔧 ${event.toolName}: ${event.args?.command || ''}`);
  } else if (event.type === 'message_update') {
    process.stdout.write(event.text || '');
  }
});
```

## Error Format

All errors follow this shape:

```json
{
  "error": "Human-readable message",
  "code": "SESSION_NOT_FOUND"
}
```

Actionable errors may also include additive `hint` (next step) and `docs`
(anchor) fields — existing consumers can ignore them.

**Common error codes:**

| Code | HTTP Status | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `SESSION_NOT_FOUND` | 404 | Session ID doesn't exist |
| `SESSION_BUSY` | 409 | Session is currently streaming |
| `SESSION_CREATE_FAILED` | 500 | Could not create session |
| `RUNTIME_UNAVAILABLE` | 503 | Requested runtime not installed |
| `RUNTIME_ERROR` | 500 | Runtime failed during execution |
| `PROMPT_INJECTION` | 400 | Prompt blocked by safety filter |
| `INVALID_REQUEST` | 400 | Missing required field |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `RUN_NOT_FOUND` | 404 | Run receipt is unknown or retention-pruned |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Key reused for a different request |

## Configuration

Environment variables (add to `.env`):

```bash
# Enable/disable the internal API (default: true)
INTERNAL_API_ENABLED=true

# Unix socket path (default: ~/.pi-web-ui/internal-api.sock)
INTERNAL_API_SOCKET_PATH=/home/user/.pi-web-ui/internal-api.sock

# Pre-set API key (auto-generated if empty — recommended to leave unset)
INTERNAL_API_KEY=

# Path for auto-generated token (default: ~/.pi-web-ui/internal-api-token)
INTERNAL_API_TOKEN_PATH=

# Directory for persisted run receipts (default: ~/.pi-web-ui/run-receipts)
INTERNAL_API_RUN_RECEIPTS_DIR=

# Session-scoped idempotency replay window (default 24h, milliseconds)
INTERNAL_API_RUN_IDEMPOTENCY_TTL_MS=86400000

# Directory for durable API-pin expiry ledger (default: ~/.pi-web-ui/pins)
INTERNAL_API_PIN_DIR=

# API-pin lifetime: default 24h, hard max 7d (milliseconds)
INTERNAL_API_PIN_DEFAULT_TTL_MS=86400000
INTERNAL_API_PIN_MAX_TTL_MS=604800000

# How often expired API pins are swept (default 5 min, milliseconds)
INTERNAL_API_PIN_EXPIRY_INTERVAL_MS=300000
```

The API key is auto-generated on first start and written to
`~/.pi-web-ui/internal-api-token` with `0600` permissions. Any application
that can read this file can use the API.

## Quick Reference Card

If you are building an orchestrator rather than a chat client, the usual
control flow is:

```text
capabilities/models
  -> create session(s)
  -> prompt
  -> events OR wait
  -> transcript
  -> transfer (optional)
  -> usage
  -> delete
```


```text
# Health (no auth)
GET /api/v1/health

# Models
GET /api/v1/models                        # all runtimes
GET /api/v1/models?runtime=claude         # Claude only
GET /api/v1/models?runtime=antigravity    # Antigravity only

# Sessions
POST   /api/v1/sessions               # create (optional pin:true, pinTtlSeconds)
GET    /api/v1/sessions               # list all
GET    /api/v1/sessions/:id           # get one
GET    /api/v1/sessions/:id/info      # get one (rich, includes pinned + pinnedUntil)
DELETE /api/v1/sessions/:id           # delete

# Conversation
POST /api/v1/sessions/:id/prompt      # send prompt (detach:true → 202 fire-and-forget)
POST /api/v1/sessions/:id/abort       # abort running
POST /api/v1/sessions/:id/control     # set_model / set_thinking_level / pin / unpin

# Session pinning (persistent, time-bounded — independent of the watch)
# pin:true on create, or control {action:"pin", pinTtlSeconds:N} → pinnedUntil
# default 24h, hard max 7d, renewable, auto-revoked, restart-safe. Max 2/runtime/server.

# Orchestration
GET  /api/v1/sessions/:id/events      # persistent SSE event stream
GET  /api/v1/sessions/:id/wait        # wait for status (idle/running)
GET  /api/v1/sessions/:id/transcript  # runtime-agnostic transcript
POST /api/v1/sessions/:id/transfer    # cross-session context transfer
POST /api/v1/sessions/batch           # batch-create child sessions
POST /api/v1/sessions/batch/prompt    # batch-dispatch prompts
POST /api/v1/sessions/usage           # aggregate token usage / cost

# Diagnostics (self-service scrubbed logs; authed like siblings)
GET  /api/v1/diagnostics                       # recent logs + errors + summary
GET  /api/v1/sessions/:id/diagnostics          # same, scoped to one session

# Event-type registry (machine-readable SSE taxonomy; authed like siblings)
GET  /api/v1/events/types                      # event kinds on the /events stream
GET  /api/v1/sessions/:id/approvals/pending   # pending-approval state

# Watch (long-horizon validation)
POST   /api/v1/sessions/:id/watch     # register durable condition watch (pins subject)
GET    /api/v1/sessions/:id/watch     # poll fired conditions + ledger (?sinceIndex=N)
DELETE /api/v1/sessions/:id/watch     # tear down

# Verbosity levels (for /prompt)
answers  — final text only (non-streaming, default)
tasks    — status headlines + answer (streaming)
full     — every event (streaming, like web UI)
```

## FAQ

**Q: How do sessions appear in the web UI?**
A: Automatically. Sessions are stored in the unified session registry. Both
the API and the web UI read from the same registry.

**Q: Can I use a session created in the web UI from the API?**
A: Yes. Get the session ID from `GET /api/v1/sessions` and send prompts to it.

**Q: Does the API "steal" sessions from the web UI?**
A: No. Both clients share the same sessions. If you're chatting via the API
and open the web UI, you'll see the live conversation.

**Q: What happens if I abort from the API while the web UI is watching?**
A: Both see the abort. The session becomes idle.

**Q: Do I need to restart when models change?**
A: No. `/api/v1/models` always queries live. The response reflects the
current state.

**Q: Can I have two APIs sending prompts to the same session?**
A: No. A session can only process one prompt at a time. The second caller
will get a `409 SESSION_BUSY` error.

**Q: Should an orchestrator use `/history` or `/transcript`?**
A: Usually `/transcript`. It is the runtime-agnostic, easier-to-consume
surface for reading child results. Use `/history` when you specifically want
replay/event-like output closer to what the UI reconstructs.

**Q: Is `/events` equally reliable on all runtimes?**
A: No. It is the best live-monitoring path overall, but for **Claude
channel-backed** parallel child monitoring on the same host it can be less
reliable than on Pi, OpenCode, and Antigravity. In those cases prefer
`/wait` + `/transcript`.

**Q: Can the API tell me which child sessions belong to a parent session?**
A: Not yet. There is no parent/child metadata or `GET /sessions?parent=...`
filter today. Orchestrators must track those relationships themselves.
