# Recent Changes

Short rolling summary of major doc-relevant changes. Use this as a delta guide, then jump to the canonical docs.

## Current highlights

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
