# OpenCode Integration Architecture

> Status: **implemented**
>
> Audience: maintainers working on the OpenCode runtime path.
>
> This is the canonical architecture/rationale doc for the implemented OpenCode path.

## Adopter quick take

Read this doc if you want OpenCode to be one of your main runtime paths in Pi Web UI.

Recommended public framing:
- **Who this path is for:** people who already use OpenCode or specifically want an OpenCode-backed workflow in the browser
- **Setup difficulty:** medium
- **Why many adopters like it:** it uses a cleaner local server/API integration shape than the more wrapper-heavy runtime paths
- **Main caveat:** OpenCode remains the runtime source of truth, so some behaviour and persistence are intentionally OpenCode-owned rather than Pi-Web-UI-owned

## Summary

OpenCode is one of the four runtime paths in Pi Web UI.

Its job is to let Pi Web UI remain the browser interface while a **real OpenCode runtime** handles the backend session execution.

This is especially important for supported OpenCode/Z.AI GLM workflows: Pi Web UI should integrate with OpenCode, not pretend to be OpenCode.

## Why This Path Exists

Pi Web UI has four runtime paths:

1. **Pi Coding Agent** — Pi-native sessions and extensions
2. **Claude runtime** — legacy `claude -p` or the channel-backed Claude Code path
3. **OpenCode** — `opencode serve` backend sessions
4. **Antigravity** — `agy -p` Gemini sessions

OpenCode exists because:
- OpenCode is the supported backend tool for the relevant OpenCode/Z.AI workflows
- Pi Web UI wants to preserve its browser UX without spoofing OpenCode internals
- a server/API integration is cleaner than a subprocess-per-turn wrapper

## Design Principles

- **OpenCode is the runtime source of truth** for OpenCode-backed sessions.
- **Pi Web UI remains the UI/control plane**.
- **No spoofing** of OpenCode provider identity, user agent, or unsupported direct API usage.
- **Keep the user-facing shape similar to the Claude runtime family** where that helps maintainability.
- **Reuse the app's common event/session abstractions** instead of exposing OpenCode-native details directly to the browser.

## Implemented Shape

```text
Browser UI
  -> Pi Web UI server
    -> OpenCode service
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
OpenCode sessions still appear in the same session list as Pi Coding Agent and Claude runtime sessions via:
- `server/src/session-registry.ts`
- `~/.pi-web-ui/session-registry.json`

Registry entries store runtime-neutral metadata plus OpenCode-specific linkage, such as `opencodeSessionId`.

### Source of truth
Unlike the Claude runtime, Pi Web UI does **not** own the full OpenCode transcript.

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

## Permission Bridge and Trusted Sessions

A key feature of OpenCode is that OpenCode permission requests are bridged into the UI's existing approval mechanism.

At a high level:
1. OpenCode emits a permission request
2. Pi Web UI converts it into `extension_ui_request`
3. the browser shows the approval UI
4. the browser sends `extension_ui_response`
5. Pi Web UI resolves the permission back through OpenCode APIs

By default, user approval replies use OpenCode's `always` response semantics (`OPENCODE_PERMISSION_APPROVE_MODE=always`) so repeated matching prompts in the same OpenCode session are reduced. Set `OPENCODE_PERMISSION_APPROVE_MODE=once` to preserve one-shot approval behaviour.

For long-running trusted tasks, Pi Web UI can create new OpenCode sessions with session-level permission rules by setting:

```bash
OPENCODE_TRUSTED_PERMISSIONS=true
```

In trusted mode, routine OpenCode actions are allowed automatically, including external-directory access, while Pi Web UI still adds deny rules for catastrophic shell patterns such as `mkfs *`, `dd *`, `shutdown *`, `reboot *`, `rm -rf /`, and `rm -rf /*`. This is intended for trusted deployment/maintenance sessions where repeated browser approval would prevent independent work.

This keeps the browser experience aligned with the rest of the app instead of inventing a completely separate permission UX.

## Credentials and Model Providers

### Where OpenCode stores provider authentication

Pi Web UI **never reads, stores, or echoes provider API keys**. All OpenCode
provider credentials live in OpenCode's own files on the host, outside this repo:

| File | What it holds |
|---|---|
| `~/.local/share/opencode/auth.json` | API keys / OAuth records per provider (e.g. `kilo`, `nvidia`, `moonshotai`, `zai-coding-plan`). Created and managed by `opencode auth login`. Mode `0600`. |
| `~/.config/opencode/opencode.json` | Non-secret provider/model config (model options such as GLM `thinking`), plus any provider blocks and MCP entries the user added. May contain inline keys if the user put them there manually. |

Both paths are in the user's home directory and are **not** part of this
repository and never committed. Treat them as secret-bearing host state.

The provider id in `auth.json` (its top-level key) is the same id OpenCode
reports from `GET /config/providers` and the same id Pi Web UI uses as the
`provider` field on each model (e.g. `kilo/meta-llama/llama-3.1-8b-instruct`).

To add a provider/gateway, the user runs the OpenCode CLI directly — for example
`opencode auth login` and selecting the Kilo Gateway, or providing an OpenCode
Zen key. Pi Web UI does not implement an auth UI for OpenCode providers; it
defers entirely to OpenCode.

### How models reach the web UI (credential-safe routing)

```text
opencode auth login (user, in CLI)
  -> key stored in ~/.local/share/opencode/auth.json   (host-only, secret)
    -> opencode serve exposes GET /config/providers
      -> OpenCodeService.getAvailableModels() reads the catalogue (NO keys)
        -> GET /api/models?sdkType=opencode
          -> model picker in the browser
```

Because Pi Web UI only consumes the provider **catalogue**, enabling a new
provider/gateway in the UI requires no key handling in this codebase. The keys
stay in OpenCode; the prompt dispatch (`POST /session/:id/prompt_async` with
`model: { providerID, modelID }`) lets OpenCode apply its own stored credentials.

### Provider allowlist

`OpenCodeService.getAvailableModels()` filters the reported providers through an
allowlist so the picker stays focused instead of dumping every catalogue model:

- Configured via `OPENCODE_MODEL_PROVIDERS` (see `.env.example` / `config.ts`).
- Default: `zai-coding-plan,kilo,opencode` — the Z.AI Coding Plan plus
  **Kilo Gateway** and **OpenCode Zen** (which exposes free models).
- Set to `all` (or `*`) to surface every provider OpenCode reports (e.g.
  `nvidia`, `moonshotai`, `openai` when those are authenticated).
- Model ids may contain slashes (gateway-style, e.g.
  `meta-llama/llama-3.1-8b-instruct`); these are preserved end to end.

Provider/model **discovery is automatic**: any model OpenCode lists for an
allowlisted provider appears in the picker, so new models added upstream show up
after the OpenCode server refreshes its catalogue. See
[`./OPENCODE-MODEL-AUTOMATION.md`](./OPENCODE-MODEL-AUTOMATION.md) for the
analysis of fully automating that refresh.

### Reasoning effort / thinking control (capability-aware)

Selecting a thinking level writes model `options` into `opencode.json`, which
`@ai-sdk/openai-compatible` forwards into the chat-completion request body. The
keys written depend on the model's provider and reasoning capability (resolved
from the catalogue's `capabilities.reasoning` flag via `getAvailableModels()`):

| Model | Strategy | Keys written under `options` |
|---|---|---|
| `zai-coding-plan/*` (GLM) | `zai` | `thinking` `{type:enabled\|disabled}` **and** `reasoning_effort` (`minimal\|low\|medium\|high\|max`) |
| any other provider, `reasoning`-capable | `openai-effort` | `reasoning_effort` only (clamped to `low\|medium\|high`); no `thinking` key (that key is Z.AI-specific) |
| any model without `reasoning` capability | `none` | nothing written (no-op) |

The six UI levels map onto Z.AI's `reasoning_effort` enum
(`off→thinking disabled`, `minimal/low/medium/high` 1:1, `xhigh→max`). This was
verified live against the coding-plan endpoint: `reasoning_effort` is honoured at
full granularity by GLM-5.2 (reasoning tokens scale `0 → 2482 → ~3997` for
`minimal/low/high`) and accepted-and-collapsed by older GLM models, so it is
written for every `zai-coding-plan` model without per-model special-casing. On
`off`, any stale `reasoning_effort` is removed so it cannot keep the model
reasoning. The strategy logic lives in `resolveReasoningStrategy()` /
`applyThinkingBudget()` in `opencode-config-manager.ts`.

## Comparison with Other Runtime Paths

### Compared with Pi Coding Agent
- OpenCode is less Pi-native
- it uses an external backend runtime rather than Pi-managed session execution

### Compared with the Claude runtime
- OpenCode uses a long-lived backend and APIs/SSE
- the legacy Claude direct backend uses `claude -p` subprocesses and Pi-owned replay storage
- the channel-backed Claude backend adds PTY/plugin glue instead
- OpenCode therefore needs less of the workaround-heavy subprocess glue the Claude runtime family needs

## Operational Notes

OpenCode depends on:
- `opencode` being installed and on PATH
- OpenCode runtime configuration being valid
- optional server password / host / port settings being aligned

Pi Web UI runs or attaches to a long-lived `opencode serve` process. To avoid stale backend state after long uptimes or binary upgrades, the OpenCode process manager tracks whether the server is managed or externally attached and exposes uptime in the readiness health check. The service can recycle the backend automatically when it is idle and older than:

```bash
OPENCODE_SERVER_MAX_UPTIME_MS=86400000
```

Set the value to `0` to disable idle-aware recycling. Recycling is deferred while any OpenCode session is actively running, so long-running tasks are not interrupted by a blind timer.

Useful places to inspect:
- `server/src/routes/health.ts`
- `server/src/routes/models.ts`
- `server/src/websocket/connection.ts`
- `server/src/opencode/opencode-process-manager.ts`
- `server/src/opencode/opencode-service.ts`

## What to Read Next

- [`../README.md`](../README.md)
- [`./ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`./PROTOCOL.md`](./PROTOCOL.md)
- [`./TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
