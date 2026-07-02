# Recent Changes

Short rolling summary of major doc-relevant changes. Use this as a delta guide, then jump to the canonical docs.

## Current highlights

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

- **Files tab Markdown editor (planned)**
  - Execution plan in place for turning the read-only Files preview into a Markdown source editor with a toggleable GitHub-flavored live preview, saving through the existing `/api/files/write` endpoint.
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
