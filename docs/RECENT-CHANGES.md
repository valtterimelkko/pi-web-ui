# Recent Changes

Short rolling summary of major doc-relevant changes. Use this as a delta guide, then jump to the canonical docs.

## Current highlights

- **Session-discovery ergonomics (`1.30.0`, `2026-09-02`)**
  - `GET /api/v1/sessions` gains server-side filters (`?runtime=`, `?limit=`, `?since=`, `?cwd=`) with deterministic newest-first ordering; no-param responses keep their historical shape. Every entry now carries additive `archived` (server-side web-UI archive state) and `source` (`browser` | `internal-api` | `native-discovered` | `unknown`), with registry origin tagged at Internal API single/batch create, browser create, and SessionWatcher discovery.
  - New bounded read-only `GET /api/v1/sessions/native` scans the direct-CLI stores the registry never sees (claude projects, cmdc CLI + server-spawned native home, opencode storage, antigravity conversations), mtime-sorted with paths, sizes, best-effort cwd/preview and `knownInRegistry` annotation. `runtime=pi` is refused with an explanation — native pi sessions are already auto-discovered into the registry.
  - TDD (27 RED-first route tests + registry/watcher pins) and disposable-server live validation vs the real pi runtime and real host native stores; the live pass also fixed lossy dash-encoded cwd decoding (now reported only when the decoded path exists on disk).
  - Canonical docs: [`INTERNAL-API.md`](./INTERNAL-API.md) (List Sessions / Native discovery + manual scan recipe), [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.30.0), [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) (evidence-ladder step 0), [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md) (Rediscover step).

- **Five human Web UI pins per runtime (`2026-09-02`)**
  - The browser/UI residency allowance is now five sessions per runtime; a sixth human claim is rejected. Command Code now enforces the same server-side limit instead of accepting unlimited human pins.
  - Source-owned Internal API retention and watch claims remain independent and do not consume these slots. The legacy Command Code Internal API control-pin path now uses its own expiring `internal-api:` claim as the other runtimes already did.
  - RED/GREEN unit coverage and disposable browser-WebSocket validation cover Pi, Claude SDK, and Command Code; execution concurrency and the Pi four-session soft cache are unchanged. Production was not used for validation.
  - Canonical docs: [`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md), [`NOTIFICATIONS.md`](./NOTIFICATIONS.md), and the [resource-scaling plan's owner-authorised exception](./plans/PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md#35-no-automatic-concurrency-increase).

- **Claude mid-run steer on the Internal API + model-aware max thinking (`1.29.0`, `2026-08-31`)**
  - `POST /sessions/:id/prompt` with `mode: "steer"` now works for Claude SDK-backend sessions (`claudeBackendMode: "sdk"`): the steer joins the active turn at the next tool boundary via the SDK streaming-input channel, takes the full receipted/admission-checked dispatch path, and the receipt completes when the joined turn ends. Idle Claude → `409 SESSION_NOT_STREAMING`; non-SDK backends and OpenCode/Antigravity keep `400 UNSUPPORTED_OPERATION`. `runtimes.claude.supportsSteer`/`supportsSteerWhileBusy` advertise `true` only on the SDK backend.
  - Claude thinking levels: the browser `GET /api/models?sdkType=claude` response now carries model-aware `thinkingLevels` (same helper as the Internal API), and the Settings modal exposes **Max** for Sonnet/Opus even when the session reports a resolved model id (`claude-sonnet-5`) instead of the `profile:`/bare-alias selector. Live-verified against the Claude Agent SDK: `effort: max` is served verbatim for Sonnet and Opus (Stop-hook effort echo); Haiku has no effort support.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.29.0), [`INTERNAL-API.md`](./INTERNAL-API.md) (prompt mode table), [`STEERING-RUNTIME-RESEARCH.md`](./STEERING-RUNTIME-RESEARCH.md).

- **Suggested goal status (`1.28.0`, `2026-08-30` — `8d18f41`)**
  - The canonical goal projection gains a non-terminal `suggested` status: the Pi goal-engine extension's agent-initiated suggestion flow (`goal` tool actions `suggest`/`start`) records a `pendingSuggestion` on an otherwise idle goal and `GET /goal` (and `goal_state` events) report `{ status:"suggested", objective:"<proposed>" }` with `runtimeState.pendingSuggestion` carried verbatim — awaiting explicit owner approval. No `goal_end` fires; an approving owner reply mentioning the goal auto-starts it, and transitions from `suggested` behave like any fresh start or clear. The extension's completion-status parser now also tolerates a trailing `Progress:` annotation after the status marker. See [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.28.0), [`INTERNAL-API.md`](./INTERNAL-API.md) (§ Goal Function), and [`GOAL-EXTENSION-UI.md`](./GOAL-EXTENSION-UI.md).

- **Cross-runtime goal function (`1.27.0`, `2026-08-27`)**
  - The goal function — a durable objective the harness keeps working toward across runs, surviving compaction — is now programmatically usable on the Internal API for Pi, Claude (every local-CLI backend: default, sdk-subscription, cli-direct), and Command Code (goal-runner mod, provisioned server-owned).
  - Pi slash commands pass through on a busy session (`POST /prompt` no longer 409s for `/…` messages), so `/goal pause-now` works mid-run exactly like the browser path; pass-through receipts own no turn and complete at the command boundary with `documented_handler_return`.
  - New endpoints: `GET /sessions/:id/goal` (canonical projection + verbatim `runtimeState`), `POST /sessions/:id/goal` (`start|pause|resume|clear`, honest per-runtime semantics), goal fields on create (`POST /sessions`, `/sessions/batch`) and `/info`.
  - Goal transitions publish normalized `goal_state` / `goal_end` events to the broker (watchable, on `/events`, and bridged to the browser goal surface for every runtime).
  - Claude adds a bounded server-side auto-continue loop (`CLAUDE_GOAL_AUTO_CONTINUE_*`), budget exhaustion → `goal_end {failed, budget}`; Command Code ships the `goal-runner` mod (verify-command AND model verifier) in [cmd-enhancement](https://github.com/valtterimelkko/cmd-enhancement).
  - Canonical docs: [`INTERNAL-API.md`](./INTERNAL-API.md) (§ Goal Function), [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.27.0), [`GOAL-EXTENSION-UI.md`](./GOAL-EXTENSION-UI.md); plan: [`plans/CROSS-RUNTIME-GOAL-FUNCTION-PLAN.md`](./plans/CROSS-RUNTIME-GOAL-FUNCTION-PLAN.md)

- **Round-2 consumer defects fixed (`1.26.0`, `2026-08-25`)**
  - Bare Pi model ids bind again: a bare id matching exactly one advertised, unblocked model resolves to its qualified `provider/id` selector (`fallbackApplied: false`); a bare id matching several models fails with `422 MODEL_NOT_APPLIED` listing every candidate. This restores pre-`1.25.0` behaviour that `1.25.0` had silently regressed.
  - Every `GET /api/v1/models` entry now carries a copyable `selector` field whose value is exactly what `POST /sessions` accepts for that runtime — discovery clients copy rather than construct selectors.
  - New long-poll `GET /api/v1/watches/wait?ids=…[&timeout=][&cursor=]` blocks until a named watch records an unseen firing, with an opaque resumable `nextCursor` for at-least-once delivery across reconnects; condition evaluation stays server-side, so pure observer watches work unchanged.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.26.0), [`INTERNAL-API.md`](./INTERNAL-API.md); defect report: [`plans/INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25-ROUND-2.md`](./plans/INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25-ROUND-2.md)

- **Orchestration-honesty defect batch (`1.25.0`, `2026-08-25`)**
  - Model binding honesty: an explicit `model` that cannot be applied now fails creation with `422 MODEL_NOT_APPLIED` (half-created session cleaned up) instead of silently inheriting a default; success responses carry `resolvedModel` plus a `modelBinding { requested?, resolved, fallbackApplied }` report across Pi, OpenCode, and Claude.
  - `GET /sessions/:id/info` answers authoritatively with a top-level `retention { protected, leases[], latestExpiryAt? }` block, and `/info`/session-list liveness derives from runtime state (`busy`) instead of stale registry status.
  - Run receipts hoist `cessation` top-level and add a derived `workState`; `completed` now requires confirmed cessation, otherwise `turn_ended_unconfirmed`. An observed `agent_end` alone still does not confirm completion.
  - Transcript reads honour `?limit=` (1–500); `/capabilities.claudeProfiles` entries carry `claudeModel` alongside `model`.
  - Canonical doc: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.25.0); defect reports: [`plans/INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25.md`](./plans/INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25.md) and [`plans/INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25-ROUND-2.md`](./plans/INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25-ROUND-2.md)

- **Bounded reads on `/sessions/:id/events` (`1.24.0`, `2026-08-23`)**
  - The default `GET /api/v1/sessions/:id/events` behaviour is unchanged: an unbounded SSE subscription that ends only on client disconnect (correct for browser `EventSource`). An external consumer that called it as a plain HTTP GET hung for 9,000+ seconds because the 15s heartbeat defeats every idle timeout — the contract around the endpoint was the defect, not the endpoint.
  - Additive opt-ins: `?mode=snapshot` returns `{ sessionId, mode:"snapshot", count, events }` from the broker's replay buffer as a normal JSON response and closes (always terminates); `?timeout=<ms>` bounds the stream and closes it server-side with a terminal `complete {reason:"timeout"}` event (clamped to `[0, 300000]`, same as `/wait`). No parameters = byte-for-byte historical behaviour.
  - Docs now mark the endpoint unbounded everywhere it appears in monitoring tables/evidence ladders ([`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md), [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)) and point non-streaming callers at `?mode=snapshot`, `/wait`, or `/transcript`.
  - Canonical doc: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.24.0)

- **Command Code sessions as watch subjects (`1.23.0`, `2026-08-21`)**
  - A `commandcode-*` session can now be the *observed* session of a durable watch (`POST/GET/DELETE /sessions/:id/watch`), completing the watch-wake matrix: any of the five runtimes can be the watched child, and any managed runtime can be the `onFire` wake target.
  - Command Code turns reach the watch from every source (Internal API dispatch, browser, follow-ups) via a service-level observer; the subject is pinned with a source-owned `watch:<watchId>` claim. Previously these registrations returned `404 SESSION_NOT_FOUND`.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.23.0), [`INTERNAL-API.md`](./INTERNAL-API.md), [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md)

- **Opt-in `onFire` cross-session wake (`1.22.0`, `2026-08-21`)**
  - A watch can now wake a *different* session when a condition fires: the runtime-agnostic parent-wake. Watch the child, wake the parent — no operator polling loop.
  - `onFire: { type: "prompt", targetSessionId, message, mode?, maxWakeups?, cooldownSeconds?, pinTarget?, includeEvidence? }` dispatches a detached, receipted, admission-controlled prompt to the target; the target is pinned with a source-owned `watch-target:<watchId>` claim by default, and every attempt is audited in `wakeAttempts[]` (`dispatched` / `failed` / `suppressed`).
  - Watches registered without `onFire` remain byte-for-byte pure observers.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.22.0), [`INTERNAL-API.md`](./INTERNAL-API.md), [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md)

- **Mid-run steering and follow-up across runtimes (`2026-08-17`/`2026-08-21`)**
  - Server `6495262`: steer/follow-up now work on the Claude SDK and Command Code paths over the existing WebSocket shapes — Claude SDK delivers steer at the next tool boundary (streaming-input priority `next`) and queues follow-up as `later`; Command Code has no mid-run input channel, so steer interrupts the running turn and delivers the text as the immediate next prompt on the same native session, with follow-up queued server-side.
  - Client `223182c`: steer/follow-up composer for streaming Pi sessions.
  - Channel-backed and cli-direct Claude sessions do **not** steer. Per-runtime semantics: [`PROTOCOL.md`](./PROTOCOL.md); wire research: [`STEERING-RUNTIME-RESEARCH.md`](./STEERING-RUNTIME-RESEARCH.md); validation runbook: [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) §Steering

- **Rate-limit and session-hygiene fixes (`f092fc2`, `2026-08-21`)**
  - The rate limiter now applies to `/api` only (static assets and the SPA no longer consume the API budget), the documented `RATE_LIMIT_MAX_REQUESTS` env cap is actually honoured (both names accepted), 429s carry standard rate-limit headers, and the client backs off on 429 instead of retrying like a network error.
  - Preference-delta endpoints return small acknowledgements instead of the entire ~200 KB preferences object, removing the multi-second archive round-trip.
  - Session cleanup is now a two-stage funnel: auto-archive sessions idle beyond `SESSION_AUTO_ARCHIVE_DAYS` (default 30, reversible) feeding the existing 90-day retention delete with a 7-day minimum dwell in the archived state. `SESSION_CLEANUP_DRY_RUN=true` is the default — passes log would-unpin / would-archive / would-delete counts until flipped.
  - Resolution record: [`plans/PI-WEB-UI-RATE-LIMIT-AND-SESSION-HYGIENE-FIXES.md`](./plans/PI-WEB-UI-RATE-LIMIT-AND-SESSION-HYGIENE-FIXES.md); config: [`.env.example`](../.env.example), [`DEPLOYMENT.md`](../DEPLOYMENT.md)

- **Embedded Pi SDK family upgraded to `0.84.2` (`58e09d3`, `2026-08-20`)**
  - `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-agent-core` moved from `0.80.10` to `0.84.2` exact pins across the root/server/shared workspaces (the root/server packages were later bumped to `0.84.3` in `829493e`). The `0.84.0` `message_update` delta-only breaking change affects JSON/RPC serialization, not the SDK subscribe layer Pi Web UI consumes — verified before the upgrade.
  - Stale nested `node_modules/@earendil` copies at `0.80.10` that shadowed the hoisted tree were removed; typecheck, full test suites, and the pi-enhancement extension suite re-run green against the upgraded tree.

- **Command Code multi-turn message identity + client load-path fixes (`2026-08-20`)**
  - Synthetic message ids (`commandcode-message-N`) restarted at 1 on every agent turn, so a second turn re-emitted ids already in the journal; replay and the live client keyed messages by id and merged later turns' text into the first turn's bubbles, leaving later turns as empty "Processed" rows. Synthetic ids are now turn-unique (`commandcode-message-<turn>-<n>`), and the client additionally tolerates reused ids in existing journals (later copies are suffixed and routed correctly on both replay fold and live paths).
  - Replayed user bubbles now carry their content over the wire (`normEventToPiFormat` message_start passthrough); previously they rendered empty outside live echo.
  - Client load-path hardening: persisted zustand slice capped (200 recent sessions, 140-char firstMessages; the server re-fetches the full list) and stringified at most once per throttle window — an uncapped 2.2MB payload was being stringified per store write, which CPU profiling showed as ~84% of main-thread time during loads; history replay folds events into messages with a single state write; the initial scroll settle is completion-driven and hard-capped; the virtualized list is memoized against unrelated store ticks; session switching reports send failures and times out cleanly instead of showing a stuck spinner.
  - Canonical doc: [`COMMAND-CODE-INTEGRATION.md`](./COMMAND-CODE-INTEGRATION.md)

- **Command Code replay, wall-time, and observability fixes (`2026-08-20`)**
  - Replay projection: journal reads collapse per-token streaming deltas into whole messages for the browser, Internal API transcript/screen view, and session transfer (7,423-event real session → O(messages) replay; session open went from main-thread saturation to <1s desktop and mobile).
  - `COMMAND_CODE_MAX_WALL_TIME_MS` is now an inactivity cap (timer resets on stdout), so actively streaming long tasks no longer die at 15 minutes.
  - Journal reads join the write queue (no half-written line can fail a replay); a crash-truncated trailing line is skipped; WS replay failures surface as `HISTORY_REPLAY_FAILED` instead of an empty view.
  - Observability: per-replay coalescing log line, `sources.journal` stats in session evidence.
  - Canonical doc: [`COMMAND-CODE-INTEGRATION.md`](./COMMAND-CODE-INTEGRATION.md)

- **Truthful Pi create responses; disposable-server process-group teardown (`1.21.0`)**
  - Pi create responses report the model the session actually resolved to, with `modelSelector` echoing the request; a refused/unapplied selector fails with `422 MODEL_NOT_APPLIED` after cleanup instead of silently returning a session on a different model.
  - Session-list `firstMessage` no longer skips genuine user prompts that merely reference a skill path (the Agent OS envelope case); only canonical `<skill name=` injections are treated as skill content.
  - The validation server records its process identity (`server-process.json`) and `scripts/validation-server-stop.mjs` terminates the recorded process group with verification (SIGTERM → bounded wait → SIGKILL, zombie-aware) — never command-line matching.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.21.0), [`INTERNAL-API.md`](./INTERNAL-API.md)

- **Command Code becomes a full runtime path (`1.17.0`–`1.20.0`)**
  - Browser session creation with a combined model + effort selector fed by exact live discovery (`cmd --list-models`), and full Internal API session/prompt/receipt/transcript support.
  - One env gate (`COMMAND_CODE_ENABLED`, default off); the earlier containment, role-attestation, and separate browser-policy machinery was removed in `1.20.0`.
  - Weekly automated catalogue refresh (new-model detection, conservative plan-eligibility probes, commit+push, idle-aware restart) via `npm run commandcode:weekly-refresh` and the `command-code-model-refresh` systemd timer.
  - Session evidence: `debug:where` resolves `commandCodeNativeSessionId` and prints the record, normalized event journal, and native transcript paths; see the Command Code section in [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).
  - Canonical docs: [`COMMAND-CODE-INTEGRATION.md`](./COMMAND-CODE-INTEGRATION.md), [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md)

- **Internal API Pi-provider execution policy (`1.16.0`)**
  - The automation surface omits and rejects exact Pi providers `openai` and `openrouter` by default while retaining the distinct subscription-backed `openai-codex` provider.
  - Enforcement covers discovery, create/batch-create, model switching, all prompt modes, batch prompt, existing browser-created sessions addressed through the Internal API, and transfer targets.
  - Browser model use, dictation/Drive Mode dictation, and TTS remain unchanged; operators can inspect the effective policy through `/api/v1/capabilities`.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API.md`](./INTERNAL-API.md), [`SECURITY.md`](../SECURITY.md)

- **Operator-disabled runtime truthfulness (`1.15.0`)**
  - Capabilities distinguish a runtime that the operator intentionally disabled from one that is missing or unhealthy.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)

- **Orchestrated run liveness and recovery evidence (`1.14.0`)**
  - Run receipts now preserve payload-free eligible activity, idle-versus-absolute watchdog decisions, bounded terminal observations, and explicit cessation uncertainty.
  - Blind `stream_activity` heartbeats cannot extend the Internal API watchdog; late terminal evidence annotates without reopening capacity or claiming arbitrary process quiescence.
  - Session evidence now separates retention, adapter materialization, session activity, and a bounded three-run chronology.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API.md`](./INTERNAL-API.md), [`ORCHESTRATED-RUN-LIVENESS-AND-RECOVERY.md`](./ORCHESTRATED-RUN-LIVENESS-AND-RECOVERY.md)

- **Dispatch truthfulness and Pi identity integrity (`1.13.0`)**
  - Idle Pi follow-up now promotes to a real turn and reports its actual dispatch mode; busy/strict modes fail before false acceptance.
  - Claude question responses accept request/tool-call aliases, unknown ids return 404, and pending questions are observable.
  - Watchdogs terminalise stalled receipts and release capacity; Pi rehydration fails closed on missing or mismatched files.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API.md`](./INTERNAL-API.md), [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)

- **Source-owned retention and execution admission (`1.12.0`)**
  - Web UI, Internal API, and watch retention claims are independently owned; API leases do not consume the human pin slots (now five per runtime).
  - Atomic create-time `durable`/`resident` leases renew/release by lease id and expire as crash safety.
  - `/api/v1/capacity` reports turn admission, interactive reserve, and measured memory headroom; Agent OS stores and releases exact lease ids after quiescence.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)

- **Exact Claude profile binding (`1.11.0`)**
  - Profile-backed Claude create/info/list/receipt projections now separate the canonical `modelSelector` (`profile:<id>`) from the effective runtime `model` (for example `sonnet`).
  - Explicit unknown profiles, conflicting selector forms, and unavailable requested backends fail creation rather than falling through to another Claude backend.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API.md`](./INTERNAL-API.md), [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)

- **Truthful Pi completion across auto-compaction (`1.10.1`)**
  - Pi run receipts no longer terminalise merely because `agentSession.prompt()` returned at an auto-compaction boundary.
  - Ordinary Pi LLM completion now waits for normalized `agent_end`, so detached orchestrators receive truthful `agentEndAt` evidence before collecting output or releasing work; synchronous extension slash commands still complete on handler return.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)

- **Compact session evidence and troubleshooting surface (`1.10.0`)**
  - `GET /api/v1/sessions/:id/evidence` resolves internal, path, Claude/OpenCode/Antigravity-native identifiers in one bounded read.
  - The default bundle combines canonical metadata, runtime locators, process-local diagnostics, durable receipt summary, warnings, and links to deeper reads; expansions are explicit and bounded.
  - `debug:where --json` provides matching offline locator evidence, and WebSocket Pi prompts now correlate to canonical registry ids with a safe path fallback.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API.md`](./INTERNAL-API.md), [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)

- **Internal API observability and runtime-health surface (`1.9.0`)**
  - `GET /api/v1/health` adds a unified `runtimeHealth` matrix while retaining legacy availability fields for compatibility.
  - Diagnostics now accept `requestId`, `runId`, `runtime`, `component`, `since`, `minLevel`, and bounded `limit` filters, plus a privacy-safe process-local `operational` snapshot.
  - The diagnostics ring, counters, and latest health failures reset on process restart; use run receipts, transcripts, and runtime-owned files for durable evidence.
  - Canonical docs: [`OBSERVABILITY.md`](./OBSERVABILITY.md), [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API.md`](./INTERNAL-API.md)

- **Internal API multi-client and notification-ingress hardening (`1.8.0`)**
  - Disposable validation launches now default to unique locked state directories and cooperatively reserved dynamic companion ports.
  - Unix-socket ownership is fail-closed; owner-only mode is applied before readiness, and an enabled Internal API startup failure is fatal.
  - Explicit notifications support durable `202` acceptance, caller idempotency, payload-conflict detection, pollable status, restart-aware terminal spooling, and bounded Telegram requests.
  - Production-control locking and Internal API readiness helpers are available without performing deployment actions themselves.
  - Canonical docs: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md), [`NOTIFICATIONS.md`](./NOTIFICATIONS.md), [`DEPLOYMENT.md`](../DEPLOYMENT.md)

- **Internal API model-aware max thinking levels (`1.7.0`)**
  - `max` is now a documented, validated thinking level for Internal API create/control requests.
  - Pi and OpenCode create-time requests apply the level after model selection; `/models` advertises Claude model/profile support and existing Pi SDK model metadata.
  - Local consumers should capability-gate `max` on `contractVersion >= 1.7.0` and use the selected model's `thinkingLevels`.
  - Canonical docs: [`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)

- **Internal API run receipts and execution instance identity (`1.6.1`)**
  - Every accepted prompt dispatch receives a durable `runId`; optional session-scoped `idempotencyKey` retries reuse the existing run within a bounded TTL and reject same-key payload collisions.
  - Receipts persist accepted/started/completed/failed/cancelled/interrupted state, recover in-flight records after restart, and expose `GET /api/v1/runs/:runId`.
  - The `1.6.1` hardening patch releases keys for reservations rejected before runtime dispatch, waits for terminal persistence before streaming success, captures the live Pi model, and preserves terminal error codes in duplicate batch results.
  - Session list/info and receipts expose `executionInstanceId` (Claude profile id or stable local runtime default).
  - Canonical docs: [`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)

- **Claude SDK `AskUserQuestion` support**
  - First-class interactive handling of Claude Code's built-in `AskUserQuestion` tool in the browser.
  - The SDK backend emits `ask_user_question_request`, the UI renders a structured dialog for 1–4 questions, and answers are returned through the SDK permission callback so the turn continues.
  - Cancel/timeout handling prevents zombie dialogs and silent drops of late answers; includes a disconnect grace timer and `extension_ui_cancel` to the browser.
  - The tool result is persisted and replayed so the tool card no longer stays stuck in "Running".
  - Configurable timeout via `CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS` (default 30 min).
  - Canonical docs: [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md), [`PROTOCOL.md`](./PROTOCOL.md), [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md)

- **Antigravity inactivity stall watchdog + bounded retry**
  - Detects when an `agy -p` turn goes completely silent (e.g. due to an unscoped local filesystem scan) by polling the per-turn log-file mtime.
  - Kills the subprocess after a configurable stall timeout and retries up to a bounded max.
  - Configurable via `ANTIGRAVITY_STALL_TIMEOUT_MS` (default 5 min) and `ANTIGRAVITY_MAX_ATTEMPTS` (default 2).
  - Canonical doc: [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)

- **Files tab Markdown editor**
  - The Files tab's read-only preview is now a Markdown source editor for `.md`/`.mdx`/`.markdown`/`.txt`: a plain `<textarea>` with an Edit ⇄ Preview toggle (GitHub-flavored live preview via `react-markdown` + `remark-gfm`, mirroring chat rendering), explicit Save through the existing `/api/files/write`, and manual Refresh. No new dependency, no backend change.
  - Truncation safety: files loaded truncated (>200 KiB) are read-only — editing and Save are blocked at both the store and UI layers, so a partial copy can never overwrite a full file. Unsaved changes are guarded on close / refresh / file-switch.
  - Client-only: `store/filesStore.ts`, `components/Files/MarkdownEditor.tsx`, `components/Files/FilesTab.tsx`.
  - Plan: [`plans/FILES-TAB-MARKDOWN-EDITOR-PLAN.md`](./plans/FILES-TAB-MARKDOWN-EDITOR-PLAN.md)

- **Browser workspace and chat ergonomics**
  - The chat composer caps a prompt at five attachments with visible overflow feedback; code blocks expose copy feedback without leaving stale timers behind.
  - Pi subagent cards now show bounded model and aggregate tool-usage summaries live and after reopen; inner subagent transcripts are not replayed into the card.
  - Sidebar/session UX now keeps the active session visibly distinct, preserves model-aware thinking selections while catalogues load, and uses the v2 keyed metadata channel for archive/pin/display-name persistence.
  - Context transfer now leaves the target visibly ready for the next user instruction and falls back to the source CWD for new Pi targets when no target directory is supplied.
  - Drive Mode remains a frontend overlay over the ordinary session/prompt path; read-aloud provider availability is bounded in E2E rather than assumed.
  - Pi extension reload now refreshes the active session in place and advertises a safe reload capability instead of dropping the client binding.
  - Pi new-session and Drive Mode pickers expose the current GPT-5.6 Codex variants; the former compaction session-ID patch is retired after the upstream fix.
  - Canonical docs: [`SESSION-METADATA.md`](./SESSION-METADATA.md), [`DRIVE-MODE.md`](./DRIVE-MODE.md), [`PROTOCOL.md`](./PROTOCOL.md), [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md), [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md), [`SHARP-EDGES.md`](./SHARP-EDGES.md), [`PI-CODEX-COMPACTION-SESSION-ID.md`](./PI-CODEX-COMPACTION-SESSION-ID.md)

- **Runtime, persistence, and security hardening (post-`1.8.0`)**
  - Long-horizon and notification persistence writes are atomic/private and serialized; terminal notification transitions roll back surgically if the terminal write fails, while a later outbox-cleanup failure leaves the durable terminal record for startup reconciliation.
  - Pi/OpenCode model and event paths are concurrency-safe; worker, session-watcher, Claude retry, WebSocket, and Antigravity retry listeners/timers now clean up on abort/shutdown rather than accumulating.
  - Prompt-boundary checks cover browser prompt-like actions, Internal API single/batch prompts, and transfer handoffs; every WebSocket upgrade path and worktree operation remains guarded.
  - Batch dispatch, file reads, worker output, and other untrusted buffers are bounded before expensive work.
  - Canonical docs: [`SECURITY.md`](../SECURITY.md), [`OBSERVABILITY.md`](./OBSERVABILITY.md), [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md), [`SHARP-EDGES.md`](./SHARP-EDGES.md)

## Earlier highlights

- **Internal API contract `1.5.0`**
  - Added notification endpoints:
    - `POST /api/v1/sessions/:id/notifications/opt-in`
    - `DELETE /api/v1/sessions/:id/notifications/opt-in`
    - `GET /api/v1/sessions/:id/notifications`
    - `POST /api/v1/notifications`
    - `GET /api/v1/notifications`
  - Canonical docs: [`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), [`NOTIFICATIONS.md`](./NOTIFICATIONS.md)

- **Notification layer (Telegram on `agent_end`)**
  - One-way operator notifications when an agent session yields control, across all 4 runtimes (Pi/Claude/OpenCode/Antigravity)
  - Opt-in per session (decoupled from pinning); durable outbox + retry; explicit `POST /api/v1/notifications`
  - Canonical doc: [`NOTIFICATIONS.md`](./NOTIFICATIONS.md)

- **Internal API contract `1.4.0`**
  - Added the read-only screen-view transcript projection:
    `GET /api/v1/sessions/:id/transcript?view=screen`
  - Optional expansion: `expand=tools,thinking`
  - Canonical docs: [`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md)

- **Observability/introspection additions (`1.3.0`)**
  - `GET /api/v1/diagnostics`
  - `GET /api/v1/sessions/:id/diagnostics`
  - `GET /api/v1/events/types`
  - Additive `hint` / `docs` fields on actionable Internal API errors
  - Canonical docs: [`OBSERVABILITY.md`](./OBSERVABILITY.md), [`INTERNAL-API.md`](./INTERNAL-API.md)

- **Pi runtime OpenRouter model automation**
  - Pi can now surface a broader OpenRouter-backed model catalogue
  - Ad hoc refresh: `npm run pi:refresh-models`
  - Canonical doc: [`PI-OPENROUTER-MODEL-AUTOMATION.md`](./PI-OPENROUTER-MODEL-AUTOMATION.md)

## Read by need

- **Adopter wondering what changed for day-to-day use?** Start with [`../README.md`](../README.md)
- **Maintainer / agent debugging runtime behaviour?** Start with [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- **Programmatic consumer / local orchestrator?** Read [`INTERNAL-API.md`](./INTERNAL-API.md)
