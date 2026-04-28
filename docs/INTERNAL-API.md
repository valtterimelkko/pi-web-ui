# Pi Web UI — Internal Backend API

> **Purpose:** Programmatic access to the Pi Web UI backend for other local
> applications (voice chat, agent OS, custom frontends, automation scripts).
>
> **Audience:** Agents and developers building on top of Pi Web UI.
> Do NOT read the rest of the Pi Web UI documentation unless you need to
> understand the internal implementation.

## What is Pi Web UI?

Pi Web UI is a custom-built browser interface around **three different AI
coding-agent runtimes**. It provides persistent chat sessions with real-time
streaming, tool-execution rendering, session history, and runtime management —
all behind a single unified sidebar.

Under the hood, each runtime slot exists for a different reason:

### The Three Runtimes

| Runtime | What it uses | Why it exists |
|---|---|---|
| **Pi SDK** | [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) via its SDK | The native path. When models are available through the Pi model registry and you want extensions, custom tools, and the full Pi experience. |
| **Claude Direct** | `claude -p` subprocess (Claude Code CLI) | Claude's monthly subscription does not allow external coding-agent harnesses to use Claude via the Anthropic API — Claude Code must be the agent environment. So Pi Web UI spawns Claude Code directly via its CLI, normalizes its NDJSON output into the same event model the UI understands, and owns the persistence layer so sessions survive restarts. |
| **OpenCode Direct** | `opencode serve` HTTP/SSE backend | Z.AI's GLM models (via the coding-plan provider) currently recognise OpenCode as a valid coding-agent harness but not Pi. Rather than bypass this, Pi Web UI integrates with the OpenCode server backend, adapting OpenCode SSE events into the same common event model. The OpenCode backend owns transcript storage; Pi Web UI stores registry metadata and replay transforms. |

All three runtimes are surfaced through a **unified session list** so the
runtime difference is transparent at the UI level — you create sessions,
switch between them, and see tool cards and message history the same way
regardless of backend.

### What the Web UI Offers

- **Create sessions** on any of the three runtimes with model selection
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

- **Create, list, and manage sessions** across all three runtimes
- **Send prompts** and receive answers (final text or full streaming events)
- **Discover available models** — always live, no restart needed
- **Share sessions with the web UI** — sessions created via the API appear in
  the browser sidebar in real time, and web UI sessions can be queried via
  the API

It does NOT duplicate the backend. It wraps the existing `ClaudeService`,
`OpenCodeService`, and `MultiSessionManager` objects — the same ones the
web UI uses.

## Overview

### Key Properties

- **Local-only:** The API runs on a Unix domain socket. It cannot be accessed
  over the network.
- **Auto-discovering models:** The `/models` endpoint queries live model lists
  from each runtime. New models appear immediately — no restart needed.
- **Unified sessions:** Sessions appear in both the API and the web UI. You
  can create a session via the API, then open it in the web UI.
- **Auth:** A shared API key stored at `~/.pi-web-ui/internal-api-token`.

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

    # For SSX streaming responses, use a proper HTTP client like httpx
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
  "runtimes": {
    "pi": "available",
    "claude": "available",
    "opencode": "available"
  },
  "uptime": 3600
}
```

---

### List Models

```
GET /api/v1/models
GET /api/v1/models?runtime=claude
```

Models are always queried live — new models appear immediately.

**Query parameters:**

| Param | Values | Default |
|---|---|---|
| `runtime` | `pi`, `claude`, `opencode` | all |

**Response:**
```json
{
  "models": {
    "pi": [
      { "id": "claude-sonnet-4-20250514", "displayName": "Claude Sonnet 4", "provider": "anthropic" }
    ],
    "claude": [
      { "id": "sonnet", "displayName": "Sonnet", "provider": "anthropic" },
      { "id": "opus", "displayName": "Opus", "provider": "anthropic" },
      { "id": "haiku", "displayName": "Haiku", "provider": "anthropic" }
    ],
    "opencode": [
      { "id": "glm-4-plus", "displayName": "GLM-4 Plus", "provider": "zai", "contextWindow": 128000 }
    ]
  }
}
```

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
  "model": "sonnet"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `runtime` | string | **Yes** | — | `pi`, `claude`, or `opencode` |
| `cwd` | string | No | `process.cwd()` | Working directory |
| `model` | string | No | runtime default | Model ID (from `/models`) |

**Response (201):**
```json
{
  "sessionId": "a1b2c3d4-...",
  "sessionPath": "a1b2c3d4-...",
  "runtime": "claude",
  "model": "sonnet",
  "cwd": "/home/user/myproject",
  "createdAt": "2026-04-28T12:00:00.000Z"
}
```

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
```

**Response (200):**
```json
{
  "sessionId": "a1b2c3d4-...",
  "sessionPath": "a1b2c3d4-...",
  "runtime": "claude",
  "cwd": "/home/user/myproject",
  "model": "sonnet",
  "status": "idle",
  "messageCount": 14,
  "firstMessage": "Write a function...",
  "createdAt": "2026-04-28T12:00:00.000Z",
  "lastActivity": "2026-04-28T12:05:00.000Z",
  "pinned": false,
  "tokens": { "input": 500, "output": 200, "total": 700 },
  "cost": 0.003
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
  "verbosity": "tasks"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `message` | string | **Yes** | — | The prompt to send |
| `verbosity` | string | No | `answers` | `answers`, `tasks`, or `full` |

You can also set verbosity via header: `X-Verbosity: tasks`

---

#### Verbosity: `answers` (default)

**Non-streaming.** Returns only the final assistant text after the turn
completes. The caller sees nothing while the agent works.

**Response (200):**
```json
{
  "sessionId": "a1b2c3d4-...",
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
- `409` — Session is currently busy (already streaming)
- `500` — Runtime error during execution

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
```

The API key is auto-generated on first start and written to
`~/.pi-web-ui/internal-api-token` with `0600` permissions. Any application
that can read this file can use the API.

## Quick Reference Card

```text
# Health (no auth)
GET /api/v1/health

# Models
GET /api/v1/models                    # all runtimes
GET /api/v1/models?runtime=claude     # Claude only

# Sessions
POST   /api/v1/sessions               # create
GET    /api/v1/sessions               # list all
GET    /api/v1/sessions/:id           # get one
DELETE /api/v1/sessions/:id           # delete

# Conversation
POST /api/v1/sessions/:id/prompt      # send prompt
POST /api/v1/sessions/:id/abort       # abort running

# Verbosity levels
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
