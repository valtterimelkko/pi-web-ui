# OpenCode Direct Integration Architecture

> Status: **implemented**
>
> Audience: maintainers working on the OpenCode Direct runtime path.
>
> This is the canonical architecture/rationale doc for the implemented OpenCode Direct path. The historical delivery plan remains in [`OPENCODE-IMPLEMENTATION-PLAN.md`](./OPENCODE-IMPLEMENTATION-PLAN.md).

## Summary

OpenCode Direct is the third runtime path in Pi Web UI.

Its job is to let Pi Web UI remain the browser interface while a **real OpenCode runtime** handles the backend session execution.

This is especially important for supported OpenCode/Z.AI GLM workflows: Pi Web UI should integrate with OpenCode, not pretend to be OpenCode.

## Why This Path Exists

Pi Web UI has three runtime paths:

1. **Pi SDK** — Pi-native sessions and extensions
2. **Claude Direct** — `claude -p` subprocess sessions
3. **OpenCode Direct** — `opencode serve` backend sessions

OpenCode Direct exists because:
- OpenCode is the supported backend tool for the relevant OpenCode/Z.AI workflows
- Pi Web UI wants to preserve its browser UX without spoofing OpenCode internals
- a server/API integration is cleaner than a subprocess-per-turn wrapper

## Design Principles

- **OpenCode is the runtime source of truth** for OpenCode-backed sessions.
- **Pi Web UI remains the UI/control plane**.
- **No spoofing** of OpenCode provider identity, user agent, or unsupported direct API usage.
- **Keep the user-facing shape similar to Claude Direct** where that helps maintainability.
- **Reuse the app's common event/session abstractions** instead of exposing OpenCode-native details directly to the browser.

## Implemented Shape

```text
Browser UI
  -> Pi Web UI server
    -> OpenCode Direct service
      -> OpenCode process manager
        -> opencode serve
          -> OpenCode session/message/permission APIs + SSE
```

## Main Modules

- `server/src/opencode/opencode-service.ts`
- `server/src/opencode/opencode-process-manager.ts`
- `server/src/opencode/opencode-client.ts`
- `server/src/opencode/opencode-event-adapter.ts`
- `server/src/opencode/opencode-history-replay.ts`
- `server/src/opencode/opencode-session-subscribers.ts`
- `server/src/opencode/opencode-types.ts`

## Responsibilities by Module

### `opencode-process-manager.ts`
Handles:
- locating `opencode`
- starting/stopping `opencode serve`
- health checks
- restart/availability logic

### `opencode-client.ts`
Handles:
- HTTP calls to the OpenCode server
- session and message API calls
- abort and permission reply calls
- event/SSE subscription

### `opencode-service.ts`
Handles:
- Pi-Web-UI-facing runtime orchestration
- session creation and lookup
- prompt dispatch
- replay loading
- running-state tracking
- pinning and lifecycle helpers
- permission bookkeeping

### `opencode-event-adapter.ts`
Handles:
- adapting OpenCode event shapes into Pi Web UI's normalized event model
- permission event conversion
- tool/text/message lifecycle mapping

### `opencode-history-replay.ts`
Handles:
- converting OpenCode message history into replay events that the frontend already understands

### `opencode-session-subscribers.ts`
Handles:
- multi-viewer fanout for browser clients watching the same OpenCode session

## Session and Persistence Model

### Unified registry
OpenCode sessions still appear in the same session list as Pi SDK and Claude Direct sessions via:
- `server/src/session-registry.ts`
- `~/.pi-web-ui/session-registry.json`

Registry entries store runtime-neutral metadata plus OpenCode-specific linkage, such as `opencodeSessionId`.

### Source of truth
Unlike Claude Direct, Pi Web UI does **not** own the full OpenCode transcript.

Instead:
- OpenCode owns the primary session/message state
- Pi Web UI stores registry metadata and derived UI summaries
- replay is reconstructed from OpenCode APIs when needed

## Prompt / Stream / Replay Flow

### Live prompt flow
1. Browser sends `prompt`
2. WebSocket connection router detects an OpenCode session
3. `OpenCodeService` sends the prompt through OpenCode APIs
4. OpenCode emits events via SSE
5. `opencode-event-adapter.ts` normalizes those events
6. Pi Web UI broadcasts them as `session_event`

### Replay flow
1. Browser switches to an OpenCode session
2. Pi Web UI loads registry entry
3. `OpenCodeService` fetches OpenCode message history
4. `opencode-history-replay.ts` converts messages into replay events
5. frontend rehydrates the session view using the same event model used elsewhere

## Permission Bridge

A key feature of OpenCode Direct is that OpenCode permission requests are bridged into the UI's existing approval mechanism.

At a high level:
1. OpenCode emits a permission request
2. Pi Web UI converts it into `extension_ui_request`
3. the browser shows the approval UI
4. the browser sends `extension_ui_response`
5. Pi Web UI resolves the permission back through OpenCode APIs

This keeps the browser experience aligned with the rest of the app instead of inventing a completely separate permission UX.

## Comparison with Other Runtime Paths

### Compared with Pi SDK
- OpenCode Direct is less Pi-native
- it uses an external backend runtime rather than Pi-managed session execution

### Compared with Claude Direct
- OpenCode Direct uses a long-lived backend and APIs/SSE
- Claude Direct uses `claude -p` subprocesses and Pi-owned replay storage
- OpenCode Direct therefore needs less of the workaround-heavy subprocess glue Claude Direct needs

## Operational Notes

OpenCode Direct depends on:
- `opencode` being installed and on PATH
- OpenCode runtime configuration being valid
- optional server password / host / port settings being aligned

Useful places to inspect:
- `server/src/routes/health.ts`
- `server/src/routes/models.ts`
- `server/src/websocket/connection.ts`

## What to Read Next

- [`../README.md`](../README.md)
- [`./ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`./PROTOCOL.md`](./PROTOCOL.md)
- [`./OPENCODE-IMPLEMENTATION-PLAN.md`](./OPENCODE-IMPLEMENTATION-PLAN.md)
