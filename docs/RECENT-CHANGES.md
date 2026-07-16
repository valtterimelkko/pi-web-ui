# Recent Changes

Short rolling summary of major doc-relevant changes. Use this as a delta guide, then jump to the canonical docs.

## Current highlights

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
  - Truncation safety: files loaded truncated (>200KB) are read-only — editing and Save are blocked at both the store and UI layers, so a partial copy can never overwrite a full file. Unsaved changes are guarded on close / refresh / file-switch.
  - Client-only: `store/filesStore.ts`, `components/Files/MarkdownEditor.tsx`, `components/Files/FilesTab.tsx`.
  - Plan: [`plans/FILES-TAB-MARKDOWN-EDITOR-PLAN.md`](./plans/FILES-TAB-MARKDOWN-EDITOR-PLAN.md)

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
