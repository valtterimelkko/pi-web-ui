# Pi Web UI Architecture

> Canonical architecture reference for Pi Web UI. Read [`README.md`](../README.md) first for the quick overview; use this document for structure, boundaries, and runtime-specific responsibilities.

## Overview

Pi Web UI is a single browser application that presents a unified chat/session UI over **four runtime paths**:

1. **Pi SDK**
2. **Claude runtime** (legacy direct or channel-backed backend)
3. **OpenCode Direct**
4. **Antigravity** (`agy` / Google Gemini)

The architectural theme of the repo is:
- keep the **frontend mostly runtime-agnostic**
- keep **runtime-specific complexity on the server**
- unify everything through a **common session registry** and a **common event language**

## High-level System Diagram

```text
React + Zustand frontend
  ├─ sessionStore / UI state
  ├─ runtime selection UI
  └─ WebSocket + REST clients
        │
        ▼
Express server
  ├─ auth / CSRF / rate limiting / prompt-injection checks
  ├─ REST routes
  ├─ Internal API (Unix socket + token-auth local automation boundary)
  ├─ WebSocket connection router
  ├─ session registry
  ├─ Pi SDK service + worker/session lifecycle
  ├─ Claude service + (legacy subprocess or channel-backed PTY/plugin backend)
  ├─ OpenCode Direct service + process manager/client/SSE adapter
  └─ Antigravity service + subprocess-per-turn `agy` adapter
```

## Major Layers

### Frontend

Key frontend responsibilities:
- render the unified session list
- create sessions for the selected runtime
- display message/tool history and streaming updates
- surface runtime availability (`claude_available`, `opencode_available`, `antigravity_available`)
- handle extension/approval UI requests

Important files:
- `client/src/store/sessionStore.ts`
- `client/src/hooks/useWebSocket.ts`
- `client/src/components/Session/NewSessionModal.tsx`
- `client/src/components/Sidebar/SessionItem.tsx`

### Backend

Key backend responsibilities:
- authenticate the browser session
- enforce CSRF, origin, rate-limit, and prompt-injection protections
- route user actions to the correct runtime path
- translate runtime-specific events into frontend-compatible events
- persist runtime-neutral metadata in a unified registry

Important files:
- `server/src/websocket/connection.ts`
- `server/src/websocket/protocol.ts`
- `server/src/internal-api/*`
- `server/src/session-registry.ts`
- `server/src/routes/*`

## Runtime Paths

### 1. Pi SDK path

**What it is**
- the Pi-native path
- supports Pi extensions, Pi session semantics, and worker lifecycle management

**Main modules**
- `server/src/pi/pi-service.ts`
- `server/src/pi/multi-session-manager.ts`
- `server/src/pi/event-forwarder.ts`
- `server/src/workers/worker-pool.ts`
- `server/src/workers/session-rpc-client.ts`

**Persistence**
- primary session storage: `~/.pi/agent/sessions/`

**Operational model**
- session lifecycle is actively managed by the app
- worker isolation, idle cleanup, stale-stream handling, and pinning are important here

### 2. Claude runtime family

**What it is**
- a Claude Code integration with **two backend implementations**
- both backends share the same UI/runtime family and Pi-owned replay store

**Backend A: legacy direct path**
- built around `claude -p`
- modules:
  - `server/src/claude/claude-service.ts`
  - `server/src/claude/claude-process-pool.ts`
  - `server/src/claude/claude-event-normalizer.ts`
  - `server/src/claude/claude-history-replay.ts`
  - `server/src/claude/claude-session-store.ts`
  - `server/src/claude/claude-session-subscribers.ts`

**Backend B: channel-backed path**
- built around Claude Code launched under PTY supervision with the local channel plugin bridge
- modules:
  - `server/src/claude/claude-service.ts`
  - `server/src/claude/claude-channel-service.ts`
  - `server/src/claude/claude-channel-process-manager.ts`
  - `server/src/claude/claude-channel-hooks-config.ts`
  - `server/src/claude/claude-channel-ws-client.ts`
  - `server/src/claude/claude-channel-event-adapter.ts`
  - `pi-claude-channel/server.ts`

**Persistence**
- Pi-owned Claude replay store: `~/.pi-web-ui/claude-sessions/`
- Claude native session state: `~/.claude/projects/`

**Operational model**
- backend selection happens on the server, while the frontend remains runtime-family neutral
- legacy direct mode is subprocess-per-turn and workaround-heavy
- channel-backed mode is richer but depends on PTY supervision, channel hooks, and plugin event bridging
- both share the same sidebar/session UX via registry integration

### 3. OpenCode Direct path

**What it is**
- an OpenCode-backed runtime path built around `opencode serve`
- used especially for supported OpenCode/Z.AI GLM workflows

**Main modules**
- `server/src/opencode/opencode-service.ts`
- `server/src/opencode/opencode-process-manager.ts`
- `server/src/opencode/opencode-client.ts`
- `server/src/opencode/opencode-event-adapter.ts`
- `server/src/opencode/opencode-history-replay.ts`
- `server/src/opencode/opencode-session-subscribers.ts`

**Persistence**
- OpenCode is the runtime source of truth
- Pi Web UI stores registry metadata, runtime mapping, and replay transforms

**Operational model**
- long-lived OpenCode backend process
- HTTP + SSE integration
- permission requests are bridged into existing extension approval UI

### 4. Antigravity path

**What it is**
- a Google Gemini path built around the local `agy` CLI
- exposed in the UI as `sdkType: 'antigravity'`

**Main modules**
- `server/src/antigravity/antigravity-service.ts`
- `server/src/antigravity/antigravity-session-store.ts`
- `server/src/antigravity/antigravity-history-replay.ts`
- `server/src/antigravity/antigravity-session-subscribers.ts`

**Persistence**
- Pi-owned Antigravity turn log: `~/.pi-web-ui/antigravity-sessions/`
- agy-owned conversation state: `~/.gemini/antigravity-cli/conversations/`

**Operational model**
- subprocess-per-turn `agy -p` execution
- no native streaming/tool-visibility surface today
- replay rebuilt from Pi-owned turn logs
- conversation continuity depends on the stored Antigravity conversation UUID matching agy's `.db` file

## Unified Session Registry

The unifying layer across all runtimes is:
- `server/src/session-registry.ts`
- `~/.pi-web-ui/session-registry.json`

Registry entries let the UI treat sessions consistently while preserving runtime-specific metadata such as:
- `sdkType`
- cwd
- model hints
- created / last activity
- Claude session IDs
- OpenCode session IDs
- Antigravity conversation IDs

For Claude specifically, the registry still uses `sdkType: 'claude'` even though the backend may be legacy direct or channel-backed. That distinction is operational, not a separate frontend runtime family.

## WebSocket Routing Model

`server/src/websocket/connection.ts` is the main runtime-aware router.

It is responsible for:
- auth handshake completion
- runtime availability announcements
- creating sessions by runtime
- switching sessions and replaying history
- routing prompts / aborts / model changes / pin operations
- broadcasting live events and session status updates to all subscribers

A useful mental model:

```text
client action
  -> websocket connection handler
    -> runtime-specific service
      -> normalized event(s)
        -> session_event / session_status / extension_ui_request
          -> sessionStore
```

## Frontend State Model

The frontend is intentionally mostly runtime-neutral.

### Main store
- `client/src/store/sessionStore.ts`

It handles:
- sessions and session metadata
- current session selection
- streaming state
- pinned / archived state
- runtime availability flags
- incoming session events and history replay

### Why this matters
Runtime-specific complexity stays on the server because the UI should not have to know whether a tool card came from:
- Pi SDK event forwarding
- Claude NDJSON normalization
- OpenCode SSE adaptation

## Internal API and Live Validation

In addition to browser-facing REST + WebSocket surfaces, Pi Web UI also exposes
an Internal API over a Unix domain socket for local automation. That API:

- reuses the same runtime services as the browser app
- is authenticated with a bearer token stored on disk
- powers browserless live validation via `scripts/live-validate.ts`

Canonical docs:
- [`./INTERNAL-API.md`](./INTERNAL-API.md)
- [`./LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)

## Security Architecture

Important server-side protections sit in front of all runtime routing:
- cookie auth
- CSRF validation
- origin validation
- rate limiting
- prompt-injection detection
- token-authenticated Internal API over a local Unix socket

See [`../SECURITY.md`](../SECURITY.md) for the canonical security view.

## Session Switching and Replay

### Pi SDK
- replay comes from Pi session data and Pi-aware service logic

### Claude runtime
- replay is reconstructed from Pi-owned Claude JSONL session data
- the active backend may also consult Claude's native JSONL session files for resume/follow-up state and context usage

### OpenCode Direct
- replay is reconstructed from OpenCode message APIs and adapted into the common event model

### Antigravity
- replay is reconstructed from Pi-owned Antigravity JSONL turn logs and registry conversation metadata
- live prompts run via `agy -p` and are emitted to the frontend as normalized message lifecycle events

This is one of the most important architectural themes in the repo: **the UI sees a common replay model even though the backing data sources are different.**

## Availability and Health Reporting

REST and WebSocket surfaces expose runtime availability:
- `claude_available`
- `opencode_available`
- `antigravity_available`
- `/api/health/ready`
- `/api/models?sdkType=opencode`
- `/api/models?sdkType=antigravity`

This allows the UI to degrade gracefully when optional runtimes are not installed.

## Testing Architecture

Important test layers:
- `server/tests/unit/` — server modules and runtime adapters
- `server/tests/integration/` — cross-module server integration
- `tests/e2e/` — browser-level behaviour across runtimes
- `docs/LIVE-VALIDATION.md` / `scripts/live-validate.ts` — browserless runtime validation over the Internal API

Notable coverage areas include:
- Claude event normalization and replay
- OpenCode client/service/event conversion
- WebSocket routing for all runtimes
- session creation and switching E2E flows

See [`../tests/README.md`](../tests/README.md).

## Related Docs

- [`../README.md`](../README.md)
- [`./PROTOCOL.md`](./PROTOCOL.md)
- [`./TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`./CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`./PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md)
- [`./OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`../SECURITY.md`](../SECURITY.md)
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
