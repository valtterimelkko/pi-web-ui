# Pi Web UI — Known Sharp Edges

> Living list of architectural traps, brittle patterns, and known limitations. Read this before debugging or extending a runtime.

Quick jump:
- [Session-ID diagnosis](#session-id-diagnosis)
- [Internal API / validation](#internal-api--validation)
- [Notifications](#notifications)
- [Claude SDK backend](#claude-sdk-backend)
- [Claude Direct](#claude-direct)
- [Claude channel-backed mode](#claude-channel-backed-mode)
- [OpenCode](#opencode)
- [Antigravity](#antigravity)
- [Pi Coding Agent](#pi-coding-agent)
- [Session Registry](#session-registry)
- [WebSocket / Auth](#websocket--auth)
- [Frontend](#frontend)

## Session-ID diagnosis

- **Do not start with a global grep.** Run `npm run debug:where -- <id-or-path>` first. It resolves the registry entry and prints the relevant runtime-owned session file, native id, log source, and useful checks.
- **Identifier forms are not interchangeable in every route.** The locator accepts the Pi Web UI internal id, registry path, Claude native id, OpenCode native id, and Antigravity conversation id. The read-only `transcript?view=screen` route resolves those forms; session-scoped diagnostics use the resolved internal id, while `GET /runs/:runId` uses the `runId` returned by prompt dispatch.
- **Use narrow evidence in order:** screen transcript → scoped diagnostics → run receipt / durable ledger → runtime-specific file and bounded journal query. `LOG_FORMAT=json` is for field filtering; pretty logs use `sid=`, `run=`, `req=`, `rt=`, and `exec=` suffixes.

## Internal API / validation

- **The default Unix socket is production.** Live validation must use the socket/token printed by `npm run validate:server`; production requires explicit `--allow-production` (and user authorisation).
- **`--runtime all` is not all four runtimes in disposable mode.** The runner's current `all` set is Pi, Claude, and OpenCode. Antigravity is disabled by disposable validation because `agy` has no supported isolated conversation directory; validate it only through an explicitly authorised workflow.
- **A detached prompt is the disconnect-safe path.** `verbosity=answers` with `detach:true` keeps the turn running after the caller disconnects. `tasks`/`full` streaming is supervision, not fire-and-forget: a client disconnect cancels the run and aborts the runtime.
- **A watch's ledger survives restart, not its observer.** A reloaded watch is `detached`; its past firings remain readable, but it must be registered again to observe new events. Watch pinning is separate from API pins and is not automatically cleared by deleting the watch; explicitly unpin or delete the session when finished.

## Notifications

- **`202 Accepted` is queue acceptance, not Telegram delivery.** Poll the returned status URL or `GET /api/v1/notifications`; `pending` can persist while notifications are disabled or no channel is configured, and Telegram delivery is at-least-once.
- **Terminal self-notification is opt-in by prompt.** Use `scripts/notify.sh` only for meaningful milestones, blockers/questions, and one final completion message. Web-UI-managed sessions already have the `agent_end` path and should not be double-notified.

## Claude SDK backend

### `Options.env` replaces the subprocess environment, it does not merge

The `@anthropic-ai/claude-agent-sdk` accepts an `env` field in its `Options`. Pi Web UI uses this to inject profile env vars (base URL, auth token, model aliases). This env **replaces** the subprocess environment entirely rather than extending it. Do not assume parent-process env vars are visible to the SDK subprocess unless they are explicitly included in the resolved env. The replacement is intentional — it is how `ANTHROPIC_API_KEY` stripping is enforced.

### `ANTHROPIC_API_KEY` is always stripped — do not re-add it

For all profile-backed sessions, `ANTHROPIC_API_KEY` is unconditionally removed from the subprocess environment. This is by design to prevent accidental pay-per-use charges when routing through a provider profile. If you see `apiKeySource: "none"` in session info, that is correct. If you see an error message suggesting the key is missing, the provider is not Anthropic-compatible and this path does not support it.

### `authTokenPath` must be absolute and non-symlink

The profile validator rejects `authTokenPath` values that are:
- relative paths
- symbolic links (resolved or not)
- unreadable by the service user

If a secret file path looks correct but loading fails at startup, check `ls -la <path>` — symlinks are rejected even if the target is readable.

### Profile Zod validation is terminal at startup

Profiles are loaded and validated when the server starts. A Zod parse error in any profile causes startup to fail for the profile manager — it does not silently skip the invalid profile. If the model picker shows no profile entries and profiles are enabled, check journal output for Zod validation errors before the first request.

### `@anthropic-ai/claude-agent-sdk` is a hard dependency for the SDK backend

If the package is absent or fails to install, `ClaudeSdkService` cannot initialise and sessions using `backend: 'sdk-subscription'` will fail at creation time. Confirm the package is present with `ls node_modules/@anthropic-ai/claude-agent-sdk`.

### Per-profile concurrency limit applies globally, not per-user

`maxConcurrent` in a profile is a cap on total simultaneous SDK sessions using that profile across all connected browser clients. It is not per-user. Two simultaneous browser connections that both start sessions on the same profile count toward the same limit.

## Claude Direct

### No true mid-turn steer
`claude -p` is turn-oriented. The UI can send follow-up prompts, but there is no interactive mid-turn control channel. Do not attempt to implement Pi Coding Agent-style `steer` for Claude Direct — it is an architectural limitation of the subprocess model.

### Follow-up detection is file-existence based
Whether a new prompt uses `--resume` vs `--session-id` is determined by:
1. In-memory tracker (`sessionsWithHistory`)
2. Registry `messageCount`
3. Existence of Claude's own JSONL session file on disk

If the file exists but the in-memory tracker was cleared (server restart), the first prompt may incorrectly think it is a follow-up.

### Abort recovery requires process exit waiting
`claudeService.abort()` kills the subprocess, but the next prompt must wait for the process to fully exit. `handleClaudePrompt()` polls `isRunning()` with a 30s max wait. Do not remove this wait — spawning a new process while the old one is still cleaning up causes lock errors.

### Subprocess locks
Claude session files can hold stale locks after crashes. The process pool has lock-cleaning logic, but if you see "session locked" errors, check `claude-process-pool.ts` lock cleanup and file existence.

## Claude channel-backed mode

### PTY idle detection is heuristic
The channel-backed path no longer trusts a single visible prompt frame as proof that a turn is finished. It relies on busy-state indicators plus a quiet window. If you change `claude-channel-process-manager.ts`, be careful: small PTY-output assumptions can create false `agent_end` or permanently-busy sessions.

### `stream_activity` is advisory, not completion
The channel-backed path emits `stream_activity` so the frontend can show long-turn liveness. It does **not** mean the turn is complete. Completion still depends on the channel service's end-of-turn handling.

### Auth expiry can masquerade as a stuck session
If Claude Code loses auth mid-turn, the session may appear to stall unless the auth-expiry path surfaces correctly. Always run `claude auth status --json` before assuming the PTY logic is wrong.

### Hook config drift breaks event bridging
The channel path depends on managed HTTP hook entries in `~/.claude/settings.json`. If those entries are removed, duplicated, or rewritten into an unexpected shape, stop/post-tool/session-start notifications can silently stop reaching Pi Web UI.

### Tool visibility depends on plugin-side events
The UI only shows Claude channel tool activity if the plugin bridge emits the expected events back through `pi-claude-channel/server.ts` and `claude-channel-event-adapter.ts`. Claude can still be working even when the UI looks quiet.

## OpenCode

### SSE duplicate tool events
OpenCode SSE can deliver the same tool event multiple times, and multiple local
consumers must not fan out the same source event repeatedly. The adapter owns
runtime-specific tool deduplication; the service makes one normalized pass and
fans each event out to the prompt callback and API observers. If you see
repeated tool cards or diverging watchers, check `opencode-event-adapter.ts` and
the observer fan-out owner in `opencode-service.ts`.

### Context window defaults to 0 until model cache resolves
`contextWindow` is 0 until `cacheModelContextWindows()` successfully fetches models from OpenCode. On slow starts, the context ring may show 0% or fail to render until the cache populates.

### Permission bridge auto-approves transfer permissions
Transfer dispatch into OpenCode auto-approves permission requests for the handoff injection. This is intentional (see `transfer-service.ts`), but if you add other automated prompts, be aware that permissions may be silently approved.

### Server recycling is idle-aware
`OPENCODE_SERVER_MAX_UPTIME_MS` triggers recycling only when **no** OpenCode session is actively running. A long-running task will defer recycling indefinitely. Do not rely on this timer for guaranteed restarts during active work.

### Trusted permissions still block catastrophic patterns
Even with `OPENCODE_TRUSTED_PERMISSIONS=true`, shell patterns like `rm -rf /`, `mkfs *`, `dd *`, `shutdown *`, `reboot *` are denied. Do not remove these deny rules.

## Antigravity

### Subprocess output is batch-shaped
`agy -p` does not provide native tool visibility or response streaming. The UI
gets one response batch plus synthetic `stream_activity` heartbeats; a heartbeat
is liveness only, never completion. Diagnose a silent turn through the per-turn
`agy-logs/` mtime/watchdog evidence and the Antigravity conversation id, not by
assuming the browser has seen every tool call.

### Stall retries are bounded and abortable
`ANTIGRAVITY_STALL_TIMEOUT_MS` kills a silent attempt and
`ANTIGRAVITY_MAX_ATTEMPTS` bounds retries. Aborting a session must cancel pending
retry work; if a supposedly aborted turn starts again, inspect retry cancellation
in `antigravity-service.ts` before changing timeout values.

### Disposable validation cannot isolate agy conversations
The disposable validation server disables Antigravity because `agy` writes its
conversation DB under the user's `~/.gemini` tree. An Antigravity live check is
an explicitly authorised operation, not part of the normal `--runtime all`
disposable matrix.

## Pi Coding Agent

### `agentSession.dispose()` must be try/catch guarded
Disposing a worker session can throw if the worker crashed. `multi-session-manager.ts` wraps every `dispose()` in try/catch. If you add new dispose paths, do the same.

### API-error grace timers must be cancelled on new events
When a Pi Coding Agent message has `stopReason === 'error'`, a 60s grace timer starts. If no event arrives in 60s, a synthetic `agent_end` is emitted. Any new event must cancel this timer via `cancelApiErrorGraceTimer()`. Forgetting this causes premature session idle states.

### Memory monitoring aggressive cleanup at 2.5GB
If heap usage exceeds 2500MB, `multi-session-manager.ts` triggers aggressive cleanup: all idle non-pinned sessions are disposed, oldest first, then `global.gc()` is called if available. This is a last-ditch defense against OOM — do not raise the threshold without adjusting systemd `MemoryHigh`/`MemoryMax`.

### Stale streaming reset applies to pinned sessions too
Pinning protects from idle cleanup, but a 15-minute stale stream is still detected and reset to idle. The session stays in memory; only the status changes.

### Model catalogue refresh is concurrency-sensitive
Pi model catalogue loading/refresh is shared and retryable. Do not add a second
uncoordinated refresh path or assume an in-flight refresh has already populated
the model registry; use the existing `pi-service.ts`/OpenRouter refresh seam and
inspect its bounded retry state when models intermittently disappear.

### Skill content transformation requires both open and close tags
`getSkillContentInfo()` checks for `<skill name="...">` **and** `</skill>`. Partial skill injection (missing close tag) is not transformed and will render raw markup.

### `/compact` is a browser-side interception, not a prompt
The frontend turns `/compact` into a `{type:'compact'}` WebSocket message. Sending the literal text `/compact` through the Internal API prompt endpoint reaches the LLM as plain text. Extension commands (like `/autocompact75`) execute on both paths.

### Extension reload is in place
Pi's extension `reload` action now calls `PiService.reloadSession()` for the
active session rather than removing the client and waiting for a future session
creation. Preserve the in-place identity/event bindings and the advertised
`pi-web-ui:in-place-extension-reload` capability when changing extension UI
adapters.

### Extension tree navigation must use the active AgentSession
Pi extension command `ctx.navigateTree()` delegates through
`PiService.navigateSessionTree()` to the currently bound `AgentSession`. Do not
replace this with a UI-only acknowledgement or a `SessionManager` leaf update:
the SDK method also rebuilds the agent's in-memory LLM context. AutoCompact75's
safe append-only handoff refresh depends on this synchronization before the Web
UI claims a session that advanced in the CLI.

## Session Registry

### Always use tmp+rename writes
`session-registry.ts` writes to `.tmp` then renames. Do not change this to direct overwrite — crashes during write corrupt the registry.

### `updateStatus` errors must be caught
`registry.updateStatus()` can throw if the file is corrupt or locked. If uncaught, it propagates up and can crash the WebSocket message handler. All callers must catch and log.

### Registry rebuild can create duplicate entries
`rebuildFromPiSessions()` walks `~/.pi/agent/sessions/` and creates registry entries for directories it finds. If a session was already in the registry with a different path format, duplicates may appear.

## WebSocket / Auth

### Every upgrade path is guarded
`/ws`, session WebSockets, and terminal upgrades all pass the central pre-upgrade
origin/auth/rate-limit guard before `handleUpgrade`; the post-connection CSRF
handshake still applies. Do not add a special upgrade path that only checks one
of those layers.

### CSRF tokens are wiped on server restart
The server stores CSRF tokens in memory. After a restart, all clients must refresh the page to get a new token. The connection handler sends `CSRF_TOKEN_REFRESH_REQUIRED` in this case.

### Origin validation happens before auth
WebSocket upgrades are rejected at the origin check before authentication is even attempted. If you see "Origin not allowed" in logs, check `ALLOWED_ORIGINS` first.

## Persistence and privileged paths

### Persistence failures must not silently corrupt ledgers
Run receipts, watches, notification state, and other local ledgers use private,
atomic/serialised write paths and may roll back an in-memory terminal transition
when the durable write fails. Preserve that ordering when changing persistence;
never report a terminal success before the corresponding durable record exists.

### Worktree paths are privileged input
Worktree REST operations are authenticated/rate-limited and canonicalise repo/plan
paths before invoking Git. Keep `realpath`/regular-file/repository checks and
argument-array execution; shell interpolation or a new unvalidated path input
would re-open traversal/injection risk.

## Frontend

### Session cache LRU eviction (2 sessions)
`MAX_CACHED_SESSIONS = 2` (reduced from 5 for mobile CPU/memory optimization). Holds current + one recently-accessed session. Switching between many sessions causes cache eviction — if messages appear to disappear when switching back, they are being re-fetched from the server replay path.

### Zustand persist is throttled
`sessionStore.ts` uses a debounced `localStorage` wrapper: writes are batched to at most once per second instead of on every `set()` call. This prevents streaming from causing 50-200+ blocking I/O writes per second. On tab hide, pending writes are flushed immediately.

### Zustand selectors prevent over-render
Heavy components (Sidebar, TransferConfirmationModal, NewSessionModal) subscribe via individual Zustand selectors, not the entire store. If you add a new component to the session store, use `useSessionStore(s => s.specificField)` instead of destructuring `useSessionStore()`.

### `agent_end` is the frontend's streaming unlock signal
The frontend input box stays disabled from `agent_start` until `agent_end`. If your runtime adapter forgets to emit `agent_end`, the UI appears frozen even though the backend is idle.

### Claude and OpenCode availability checks are async
Availability is not known at page load. The UI must handle `claudeAvailable: false` and `opencodeAvailable: false` gracefully until the server announces status after WebSocket auth.
