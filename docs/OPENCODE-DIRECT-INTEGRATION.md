# OpenCode Direct Integration Architecture

> Status: implemented
>
> Audience: Pi Web UI maintainers implementing a new runtime path after the existing Pi SDK and Claude Direct paths.
>
> See `docs/OPENCODE-IMPLEMENTATION-PLAN.md` for the phased implementation plan.

## 1. Intent

The intent of **OpenCode Direct integration** is:

1. **Preserve Pi Web UI as the primary user interface**.
2. **Use GLM Coding Plan only through a genuinely supported backend tool**.
3. **Avoid policy-risky spoofing** of OpenCode identifiers, User-Agent strings, provider IDs, or HTTP request fingerprints.
4. **Keep the integration as similar as practical to the existing Claude Direct integration** so the codebase remains understandable and operationally consistent.
5. **Treat OpenCode as the actual runtime** for OpenCode-backed sessions, while Pi Web UI acts as:
   - the browser UI,
   - the unified session list,
   - the protocol adapter,
   - and the cross-runtime history renderer.

This architecture is specifically motivated by Z.ai GLM Coding Plan policy changes. The compliance intent must remain visible throughout implementation:

- Pi Web UI should **not** call GLM Coding Plan directly.
- Pi Web UI should **not** pretend to be OpenCode.
- OpenCode-backed GLM usage should flow through a **real OpenCode runtime** using its supported provider configuration.

## 2. Why this path exists

Pi Web UI currently has two runtime paths:

1. **Pi SDK path** — in-process Pi sessions with worker/session lifecycle managed by Pi-specific code.
2. **Claude Direct path** — `claude -p` subprocesses with custom persistence, replay, and normalization.

OpenCode Direct becomes the third runtime path:

3. **OpenCode Direct path** — OpenCode is the actual agent runtime, while Pi Web UI integrates with it through supported headless surfaces.

This path exists because:

- Z.ai documents OpenCode as a supported GLM Coding Plan tool.
- Pi Web UI is not named as a supported GLM Coding Plan tool.
- A backend-through-OpenCode design is safer than direct Pi → Z.ai Coding Plan calls.

## 3. Existing Claude Direct patterns to preserve

The existing Claude Direct implementation is the closest architectural analogue and should be treated as the baseline pattern.

### 3.0 Where to inspect Claude Direct in detail

Agents implementing OpenCode Direct should read the Claude Direct path carefully before planning changes.

Start with these repo docs:

- `README.md`
  - overall product/runtime summary
  - confirms the two current runtime paths and where Claude Direct fits operationally
- `docs/ARCHITECTURE.md`
  - system architecture and runtime-path overview
- `docs/CLAUDE-DIRECT-UX-ISSUES.md`
  - highly relevant analysis of the Claude Direct path, including implemented fixes, architectural trade-offs, and why some Claude Direct constraints came from `claude -p`
- `docs/PROTOCOL.md`
  - shared client/server event contract used by the UI

Then inspect these implementation files:

- `server/src/claude/claude-service.ts`
  - Claude session lifecycle, registry integration, prompt dispatch, persistence hooks
- `server/src/claude/claude-process-pool.ts`
  - subprocess spawning, permission-mode strategy, abort handling, busy/retry/lock recovery
- `server/src/claude/claude-event-normalizer.ts`
  - raw Claude stream → Pi Web UI normalized events
- `server/src/claude/claude-session-store.ts`
  - Claude-specific JSONL persistence owned by Pi Web UI
- `server/src/claude/claude-history-replay.ts`
  - conversion from stored Claude JSONL entries into replayable Pi Web UI events
- `server/src/claude/claude-session-subscribers.ts`
  - multi-viewer subscriber fanout model
- `server/src/websocket/connection.ts`
  - runtime routing, session switching, replay triggering, subscriber broadcasts, abort path, status broadcasting
- `server/src/session-registry.ts`
  - unified session registry used across Pi SDK and Claude Direct

Also inspect the client-side consumers that make the runtime paths feel unified:

- `client/src/store/sessionStore.ts`
  - message/event handling for live streaming, replay, tool cards, and session status
- `client/src/lib/history-replay.ts`
  - frontend replay buffering/ordering behaviour
- `client/src/hooks/useSessionStream.ts`
  - streaming/session interaction model

Useful tests for understanding expected Claude Direct behaviour:

- `server/tests/unit/claude/claude-event-normalizer.test.ts`
- `server/tests/unit/claude/claude-history-replay.test.ts`
- `server/tests/unit/claude/claude-process-pool.test.ts`
- `server/tests/unit/websocket/claude-ux-fixes.test.ts`
- `tests/e2e/claude-session-chat.spec.ts`
- `tests/e2e/claude-model-selector.spec.ts`

Commit history worth reading for practical improvements and regressions:

```bash
git log --oneline --decorate -50
git log --oneline --decorate --grep="Claude Direct"
```

Especially inspect these recent Claude Direct commits and related docs:

- `c7b42b2` — dual-SDK architecture introduction
- `8b402e6` — use `--resume` for follow-up turns
- `8335a3e` — capture confirmed Claude session ID
- `8f5a782` / `181c131` / `6a81913` — permission mode evolution
- `09f131e` — abort recoverability improvements
- `aff8fbc` — multi-subscriber broadcasting
- `58826a0` — session replay/tool-running fixes
- `819b080` — Claude Direct UX fixes
- `3be49e1` — stale last-prompt lock recovery
- `b42403d` and `docs/CLAUDE-DIRECT-UX-ISSUES.md` — architecture/UX analysis

OpenCode Direct should be planned only after reading enough of the above to understand:

1. how Claude Direct is made to look like the Pi SDK path in the UI,
2. which pieces are generic reusable patterns,
3. and which pieces were Claude-specific workarounds that OpenCode should avoid.

### 3.1 What Claude Direct currently does

The Claude Direct runtime path uses:

- `server/src/claude/claude-service.ts`
- `server/src/claude/claude-process-pool.ts`
- `server/src/claude/claude-event-normalizer.ts`
- `server/src/claude/claude-session-store.ts`
- `server/src/claude/claude-history-replay.ts`
- `server/src/claude/claude-session-subscribers.ts`
- `server/src/websocket/connection.ts`
- `server/src/session-registry.ts`

Core Claude Direct patterns worth preserving:

1. **Separate runtime manager/service**
   - Claude logic is isolated under `server/src/claude/`.
   - WebSocket connection code routes Claude sessions into that service.

2. **Unified session registry**
   - Claude sessions are stored in the same sidebar/session registry model as Pi sessions.
   - Runtime-specific metadata is hidden behind a shared UI/session abstraction.

3. **Custom event normalization**
   - Raw Claude NDJSON is converted into the app’s common event language:
     - `message_start`
     - `message_update`
     - `message_end`
     - `tool_execution_start`
     - `tool_execution_end`
     - `agent_end`
     - etc.

4. **Custom history persistence + replay**
   - Claude session activity is persisted into Pi-Web-UI-owned JSONL files.
   - Replay reconstructs messages and tool cards in the same UI model used elsewhere.

5. **Subscriber-based event fanout**
   - Multiple browser tabs viewing the same session can receive the same runtime events.

6. **Abort / busy / resume handling**
   - The Claude path has accumulated important fixes around:
     - process busy checks,
     - waiting for prior exit before re-prompting,
     - lock cleanup,
     - status broadcasting,
     - stale session recovery,
     - multi-subscriber completion broadcasting.

### 3.2 Claude Direct constraints we do **not** want to copy blindly

Claude Direct exists because `claude -p` is comparatively primitive from a server-integration perspective. That forced Pi Web UI to build many things itself.

Examples:

- custom JSONL persistence,
- custom replay logic,
- manual NDJSON parsing,
- lock-file recovery,
- implicit process lifecycle management,
- lack of true mid-turn interaction.

OpenCode Direct should mirror Claude Direct’s **external shape**, but not necessarily its internal compromises.

## 4. OpenCode headless surfaces available

Research found three distinct OpenCode integration surfaces.

### 4.1 Surface A — OpenCode server API (`opencode serve` / `opencode web`)

This is the strongest candidate.

OpenCode exposes a headless HTTP server:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Documented capabilities include:

- session CRUD
- prompt/message submission
- async prompting
- abort
- permission response APIs
- provider/config APIs
- file/search APIs
- SSE event streams
- session status APIs

Relevant documented endpoints include:

- `GET /session`
- `POST /session`
- `GET /session/status`
- `GET /session/:id`
- `POST /session/:id/abort`
- `POST /session/:id/message`
- `POST /session/:id/prompt_async`
- `GET /session/:id/message`
- `POST /session/:id/permissions/:permissionID`
- `GET /event`
- `GET /global/event`
- `GET /config/providers`
- `PUT /auth/:id`

The server also supports:

- **basic auth** via `OPENCODE_SERVER_PASSWORD`
- **CORS** configuration for custom frontends
- shared state between multiple clients
- a documented OpenAPI surface

### 4.2 Surface B — OpenCode SDK (`@opencode-ai/sdk`)

This is also a strong candidate, and pairs naturally with the server API.

Documented SDK capabilities include:

- creating or attaching to an OpenCode server,
- creating/listing/updating sessions,
- prompting sessions,
- aborting sessions,
- reading messages,
- provider/config access,
- SSE event subscription,
- auth/config calls.

The SDK can either:

- spawn its own server (`createOpencode()`), or
- connect to a running server (`createOpencodeClient({ baseUrl })`).

For Pi Web UI, the preferred use is:

- **Pi Web UI owns the process lifecycle**,
- **Pi Web UI talks to a local OpenCode server**,
- server-side code may optionally use the SDK as a typed client rather than calling raw HTTP.

### 4.3 Surface C — CLI command mode (`opencode run`)

OpenCode also supports non-interactive CLI operation:

```bash
opencode run "Explain async/await"
opencode run --attach http://localhost:4096 "Explain async/await"
opencode run --format json "Explain async/await"
```

Important command-mode findings:

- `opencode run` supports:
  - `--continue`
  - `--session`
  - `--fork`
  - `--model`
  - `--agent`
  - `--attach`
  - `--format json`
  - `--dangerously-skip-permissions`
- its JSON mode emits raw event-like JSON to stdout
- it can attach to an already-running OpenCode server
- it has explicit auto-reject / auto-approve behaviour for permissions in CLI mode

However, command mode is a weaker fit for Pi Web UI than server/API mode because it trends back toward the Claude Direct model:

- more subprocess orchestration,
- more stdout parsing,
- weaker interactive permission UX,
- less natural multi-client control,
- more duplication of things OpenCode server mode already provides.

### 4.4 Recommended conclusion

**Primary architecture should use Surface A + optionally Surface B.**

That means:

- run a real OpenCode backend server,
- talk to it through HTTP/SDK,
- subscribe to SSE,
- adapt its runtime into Pi Web UI.

`opencode run` should be treated as:

- a research reference,
- a debugging aid,
- or a fallback/temporary exploration mode,
- but **not** the primary production integration shape.

## 5. Proposed architecture

## 5.1 High-level shape

```text
Browser (Pi Web UI)
  -> Pi Web UI Express/WebSocket server
    -> OpenCode Direct service (new runtime path)
      -> OpenCode backend process: `opencode serve`
        -> OpenCode sessions / providers / tools
          -> Z.AI Coding Plan via OpenCode provider config
```

Pi Web UI remains the public UI.

OpenCode becomes the agent backend for sessions whose `sdkType` is `opencode`.

## 5.2 Core design principle

For OpenCode-backed sessions:

- **OpenCode is the source of truth for runtime state**.
- Pi Web UI should **adapt**, not replace, OpenCode’s own:
  - session model,
  - event model,
  - permission model,
  - abort model,
  - storage model.

This differs from Claude Direct, where Pi Web UI had to invent much more of the runtime contract itself.

## 5.3 New server-side module family

A plausible new module family:

- `server/src/opencode/opencode-service.ts`
- `server/src/opencode/opencode-process-manager.ts`
- `server/src/opencode/opencode-client.ts`
- `server/src/opencode/opencode-event-adapter.ts`
- `server/src/opencode/opencode-history-replay.ts`
- `server/src/opencode/opencode-session-subscribers.ts`
- `server/src/opencode/opencode-types.ts`

### Responsibilities

#### `opencode-process-manager.ts`
Responsible for:

- starting/stopping a local `opencode serve` process,
- ensuring one server per configured workspace strategy,
- health checks,
- auth/basic-auth setup,
- restart on crash,
- log capture,
- preventing duplicate server startups.

This is the closest equivalent to `claude-process-pool.ts`, but the unit is **backend server process**, not **one process per prompt**.

#### `opencode-client.ts`
Responsible for:

- low-level API client wrapper around OpenCode server,
- typed REST calls,
- SSE subscription management,
- translating auth/basic-auth config.

This can be built either on:

- the OpenCode SDK, or
- raw HTTP + EventSource/fetch.

Recommendation: prefer SDK where it is mature and materially simplifies the integration; use raw HTTP only where SDK coverage is awkward.

#### `opencode-service.ts`
Responsible for:

- Pi-Web-UI-facing runtime service,
- session creation/listing/loading,
- prompt dispatch,
- abort,
- permission reply,
- mapping registry entries to OpenCode session IDs,
- managing subscriber fanout.

This is the closest equivalent to `claude-service.ts`.

#### `opencode-event-adapter.ts`
Responsible for:

- converting OpenCode SSE / bus events into Pi Web UI’s normalized session event format,
- preserving enough metadata for tool cards, text streaming, status, and permission prompts.

This is the closest equivalent to `claude-event-normalizer.ts`, but should likely adapt from SSE events and/or message part data rather than NDJSON lines.

#### `opencode-history-replay.ts`
Responsible for:

- reconstructing OpenCode session history into Pi Web UI replay events,
- likely using OpenCode message APIs instead of a Pi-owned JSONL store.

This is the closest equivalent to `claude-history-replay.ts`.

#### `opencode-session-subscribers.ts`
Responsible for:

- tracking which browser clients are viewing which OpenCode-backed session,
- fanout of live events to all viewers.

This can mirror the Claude subscriber model almost directly.

## 6. Session model

## 6.1 Registry model

Pi Web UI should continue using the unified session registry.

For OpenCode-backed sessions, the registry should store at least:

- Pi Web UI session ID or canonical registry ID
- `sdkType: 'opencode'`
- OpenCode session ID
- workspace / cwd
- provider/model metadata
- createdAt / lastActivity
- firstMessage / messageCount summary fields
- status hints
- optional backend server identity if multiple servers are supported

Example conceptual entry:

```json
{
  "id": "pi-opencode-session-uuid",
  "sdkType": "opencode",
  "opencodeSessionId": "oc_session_123",
  "cwd": "/root/pi-web-ui",
  "provider": "zai-coding-plan",
  "model": "glm-4.7",
  "createdAt": "...",
  "lastActivity": "...",
  "status": "idle"
}
```

## 6.2 Source of truth difference vs Claude Direct

Claude Direct:
- Pi Web UI owns the durable session log.

OpenCode Direct:
- OpenCode should remain the durable session source where possible.
- Pi Web UI should avoid duplicating the full authoritative transcript unless needed for caching/performance.

So, unlike Claude Direct, the default design should be:

- **registry in Pi Web UI**,
- **message history in OpenCode**,
- **optional local cache in Pi Web UI**.

## 7. Event and message flow

## 7.1 Live flow

Recommended live flow:

1. Pi Web UI creates or opens an OpenCode session through the OpenCode API.
2. Pi Web UI subscribes to OpenCode SSE streams (`/event` and possibly `/global/event`).
3. OpenCode emits session/message/part/permission/status events.
4. `opencode-event-adapter.ts` maps them into Pi Web UI normalized events.
5. Pi Web UI broadcasts them to all WebSocket subscribers viewing that session.

Conceptually:

```text
OpenCode SSE event
  -> OpenCode event adapter
    -> Pi-normalized session_event
      -> browser session store
```

## 7.2 Suggested event mapping strategy

Pi Web UI should keep the same frontend contract it already uses.

Candidate mappings:

- OpenCode assistant message creation/update
  - `message_start`
  - `message_update`
  - `message_end`
- OpenCode tool part start/completion
  - `tool_execution_start`
  - `tool_execution_update` if available
  - `tool_execution_end`
- OpenCode session running/idle transitions
  - `agent_start`
  - `agent_end`
  - plus `session_status`
- OpenCode permission requests
  - either:
    - Pi-native `extension_ui_request` style event, or
    - a new dedicated permission event path adapted into existing UI patterns

## 7.3 Important difference vs Claude Direct

Claude Direct normalizes a runtime that does **not** expose Pi Web UI’s preferred event shapes.

OpenCode already has:

- structured messages,
- structured parts,
- structured tools,
- structured permission requests,
- status APIs,
- event streams.

Therefore OpenCode Direct should do **less lossy normalization** than Claude Direct.

## 8. History replay

## 8.1 Recommended replay strategy

On session switch:

1. Pi Web UI looks up registry entry.
2. If `sdkType === 'opencode'`, call OpenCode APIs:
   - `GET /session/:id`
   - `GET /session/:id/message`
   - maybe additional detail endpoints as needed.
3. Convert returned messages/parts into replayable Pi session events.
4. Emit:
   - `session_switched`
   - `history_start`
   - replayed `session_event`s
   - `history_end`

This mirrors Claude Direct’s frontend behaviour while avoiding Pi-owned transcript duplication.

## 8.2 Why not copy Claude’s JSONL replay model

Because OpenCode already has:

- a session store,
- message APIs,
- part APIs,
- session status,
- export/import facilities.

Rebuilding a second full transcript system inside Pi Web UI would increase drift risk and operational complexity.

## 8.3 Optional cache layer

A small Pi-side cache may still be valuable for:

- quick session switching,
- offline-ish UI responsiveness,
- minimizing repeated replay transforms.

But it should be a **cache**, not the primary source of truth.

## 9. Prompt dispatch

## 9.1 Recommended production prompt path

Use OpenCode’s server prompt endpoints:

- `POST /session/:id/message` for synchronous request/response calls
- or `POST /session/:id/prompt_async` plus SSE for async/live streaming

For Pi Web UI, the likely best fit is:

- submit prompt asynchronously,
- consume live events over SSE,
- rely on status changes to know when a turn has finished.

This is more like the Pi SDK path than the Claude Direct path.

## 9.2 Command-mode alternative

`opencode run` with `--format json` can emit raw JSON events and supports `--session` / `--continue`.

But as a primary integration it is weaker because:

- permission handling is CLI-oriented,
- a subprocess-per-run model reintroduces Claude-like orchestration pain,
- multi-subscriber live UI behaviour is less natural,
- server API already exists.

Recommended architecture stance:

- **document command mode**,
- **test it as fallback/reference**,
- **do not make it the default runtime architecture**.

## 10. Abort / stop / resume

## 10.1 Abort

OpenCode explicitly exposes:

- `POST /session/:id/abort`
- SDK `session.abort({ path })`

This is materially better than Claude Direct, where abort is a manual SIGTERM path.

Pi Web UI should mirror its current UX:

- user clicks stop,
- Pi backend calls OpenCode abort,
- Pi backend updates/broadcasts session status,
- UI exits streaming state.

## 10.2 Resume / follow-up

OpenCode sessions are first-class server objects, so follow-up turns should work by reusing the same OpenCode session ID.

That is conceptually cleaner than Claude Direct’s `--session-id`/`--resume` split.

## 10.3 Mid-turn steer

Unknown / likely limited.

Open questions:

- Can Pi Web UI inject a follow-up while OpenCode is already running a turn?
- Does OpenCode support a true analogue to Pi SDK `steer()`?
- Or should follow-up remain “after current turn reaches idle”?

Current architectural assumption:

- **do not promise true mid-turn steer until tested**.
- initial version should support:
  - prompt,
  - abort,
  - follow-up after idle,
  - maybe queued follow-up if practical.

## 11. Permissions handling

## 11.1 Why OpenCode is better positioned than Claude Direct

Claude Direct currently lacks a real interactive permission callback channel because `claude -p` is subprocess-oriented.

OpenCode already has:

- permission rules/config,
- pending permission APIs,
- permission reply APIs,
- permission-related SSE/bus events,
- web/TUI patterns for approvals.

This makes OpenCode Direct a much better fit for browser-mediated approvals.

## 11.2 Proposed Pi integration pattern

When OpenCode emits a permission request:

1. Pi backend captures it from SSE or by polling/listing pending permissions.
2. Pi backend transforms it into a Pi UI approval request.
3. Browser shows approval dialog.
4. Browser responds to Pi backend.
5. Pi backend calls OpenCode permission reply API.

This is the highest-value place to make OpenCode Direct feel better than Claude Direct.

## 11.3 Recommended UX goal

Match Pi’s existing approval ergonomics as closely as possible:

- readable action summary,
- file/path/command preview,
- approve once / reject,
- if supported, remember/always semantics.

## 11.4 Important API difference to note

OpenCode docs use permission reply concepts like:

- route: `/session/:id/permissions/:permissionID`
- internal route/source also exposes `/permission/:requestID/reply`
- body shape may differ slightly between SDK/server docs and internal routes (`response` vs `reply` naming)

This must be tested against the actual server implementation before coding assumptions harden.

## 12. Backend process model

## 12.1 Recommended process strategy

Use a **long-lived OpenCode server process** rather than spawning one process per prompt.

This yields:

- session continuity,
- lower cold-start overhead,
- stable permission flows,
- cleaner browser integration,
- less lock/process churn than Claude Direct.

## 12.2 Single server vs per-workspace server

Initial recommendation:

- start with **one local OpenCode server process** for the Pi Web UI service.

Reasons:

- simpler operations,
- easier event subscription,
- easier auth/configuration,
- enough for first implementation.

Potential later evolution:

- per-workspace server instances if isolation or cwd coupling requires it.

This should be kept as an explicit design question, not assumed upfront.

## 13. Provider/auth model

## 13.1 Recommended ownership

OpenCode should own provider auth for OpenCode sessions.

That means Pi Web UI should not store GLM Coding Plan credentials as if it were the runtime.

Instead, OpenCode provider auth should be configured using supported OpenCode mechanisms, eg:

- `opencode auth login`
- auth/config files under `~/.local/share/opencode/`
- or documented auth endpoints if used programmatically.

## 13.2 Z.ai Coding Plan alignment

For OpenCode-backed GLM usage, provider config should point to the **real OpenCode Z.AI Coding Plan provider**, not a Pi-created imitation.

## 14. Similarities vs differences with Claude Direct

Before implementing this section in code, re-read Section 3.0 above and inspect the actual Claude Direct files and tests. The implementation goal is not to copy Claude Direct line-for-line, but to preserve its successful integration patterns while replacing Claude-specific subprocess workarounds with OpenCode-native server/API flows.

## 14.1 Similarities we want

1. Separate runtime service folder
2. Unified session registry/sidebar
3. Subscriber-based fanout for multiple viewers
4. Runtime-specific history replay adapter
5. Stop/busy/status handling integrated into the same frontend UX
6. Minimal impact on the existing client session model

## 14.2 Differences we should embrace

1. **Long-lived server instead of one subprocess per prompt**
2. **OpenCode-owned session storage instead of Pi-owned JSONL source of truth**
3. **SSE/API integration instead of NDJSON stdout parsing**
4. **Native permission APIs instead of subprocess workarounds**
5. **Cleaner abort semantics**
6. **Potentially richer session/message/part metadata than Claude Direct**

## 15. Recommended implementation direction

## 15.1 Preferred architecture decision

Build OpenCode Direct around:

- `opencode serve`
- OpenCode server API
- SSE subscription
- optional SDK wrapper on top of the API

and **not** around `opencode run` as the primary runtime.

## 15.2 Why this is the best fit

It best satisfies all of the following:

- policy intent,
- runtime stability,
- browser approvals,
- stop/resume UX,
- multi-client subscription support,
- similarity to Pi Web UI’s existing runtime abstractions.

## 16. Questions that must be tested

The following are the main areas where documentation/research was helpful but not sufficient for 100% certainty.

### 16.1 Event mapping questions

1. Which exact SSE events are emitted during a normal assistant turn?
2. What is the most stable event source for browser-live rendering:
   - `/event`
   - `/global/event`
   - or message polling + status polling?
3. Are tool part lifecycle events sufficient to reconstruct Pi-style tool cards without polling message detail endpoints?

### 16.2 Session replay questions

4. Does `GET /session/:id/message` alone provide enough data to reconstruct a full assistant transcript with tools, reasoning, and user turns?
5. Do we need extra per-message detail calls for part completeness?
6. Is replay ordering stable enough for one-pass transformation into Pi events?

### 16.3 Prompt/streaming questions

7. Is `prompt_async` + SSE the best practical live-stream path, or is synchronous `message` plus status polling simpler/more reliable?
8. Are there race conditions between async prompt submission and initial SSE event subscription?
9. What is the exact completion signal Pi should trust:
   - session status idle,
   - message completion event,
   - or both?

### 16.4 Permission questions

10. Which route/body contract is the stable one to reply to permission requests in real server usage?
11. Can Pi present “approve once” and “always/remember” semantics cleanly using OpenCode’s permission system?
12. How are pending permissions correlated back to a specific session and tool part in the live UI?

### 16.5 Abort / steer / resume questions

13. Does abort always transition session status promptly to idle, or are there lingering intermediate states?
14. Can a new prompt be safely sent immediately after abort, or should Pi wait for a confirmed idle event?
15. Is true mid-turn steer unsupported, unsupported-but-queueable, or possible through another API surface?

### 16.6 Storage / lifecycle questions

16. Does one long-lived OpenCode server behave correctly across many different cwd/project contexts for Pi Web UI use?
17. Is a single server process enough, or do some features implicitly bind too tightly to the launch directory?
18. What exact files/directories should Pi rely on, and which should be treated as internal implementation details that may change?

### 16.7 Compliance / operational questions

19. Is Pi Web UI controlling a local OpenCode backend acceptable enough for Z.ai’s supported-tool intent, or should written clarification still be obtained?
20. Should Pi Web UI visibly label these sessions as “OpenCode Direct” to make the supported-backend model explicit to the user?

## 17. Practical next-step recommendation

The executable implementation plan derived from this document should assume:

1. **New runtime type:** `opencode`
2. **New backend process manager:** one long-lived `opencode serve`
3. **New service layer:** OpenCode API/SDK client + SSE subscription
4. **New adapter layer:** OpenCode events/messages → Pi normalized events
5. **Unified registry integration:** sidebar/session list parity with Pi and Claude Direct
6. **Permission bridge:** browser approval dialog backed by OpenCode permission APIs
7. **First milestone scope:**
   - create session
   - list/switch session
   - send prompt
   - live streaming
   - abort
   - replay history
   - follow-up after idle
8. **Deferred until proven:**
   - true mid-turn steer
   - per-workspace server topology
   - command-mode backend

## 18. Summary

OpenCode Direct integration should be implemented as a **real OpenCode-backed runtime path**, not as a Claude-style subprocess wrapper around stdout.

The design should stay **externally similar** to Claude Direct:

- separate runtime path,
- unified sidebar,
- normalized events,
- replay support,
- stop/resume UX,
- browser subscriber model.

But internally it should use OpenCode’s stronger primitives:

- headless server,
- typed API/SDK,
- session storage,
- SSE events,
- abort endpoint,
- permission APIs.

That gives Pi Web UI the best chance of:

- preserving its UI investment,
- reducing compliance risk,
- and delivering a more capable integration than the current Claude Direct path.
