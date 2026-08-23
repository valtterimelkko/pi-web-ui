# Recent Changes

Short rolling summary of major doc-relevant changes. Use this as a delta guide, then jump to the canonical docs.

## Current highlights

- **Bounded reads on `/sessions/:id/events` (`1.24.0`, `2026-08-23`)**
  - The default `GET /api/v1/sessions/:id/events` behaviour is unchanged: an unbounded SSE subscription that ends only on client disconnect (correct for browser `EventSource`). An external consumer that called it as a plain HTTP GET hung for 9,000+ seconds because the 15s heartbeat defeats every idle timeout — the contract around the endpoint was the defect, not the endpoint.
  - Additive opt-ins: `?mode=snapshot` returns `{ sessionId, mode:"snapshot", count, events }` from the broker's replay buffer as a normal JSON response and closes (always terminates); `?timeout=<ms>` bounds the stream and closes it server-side with a terminal `complete {reason:"timeout"}` event (clamped to `[0, 300000]`, same as `/wait`). No parameters = byte-for-byte historical behaviour.
  - Docs now mark the endpoint unbounded everywhere it appears in monitoring tables/evidence ladders ([`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md), [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)) and point non-streaming callers at `?mode=snapshot`, `/wait`, or `/transcript`.
  - Canonical doc: [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) (changelog 1.24.0)

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
  - Web UI, Internal API, and watch retention claims are independently owned; API leases do not consume the two human pin slots.
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
