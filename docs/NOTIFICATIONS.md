# Notification Layer

A unified, **one-way** notification subsystem inside Pi Web UI that pings the
operator on **Telegram** when an agent session **yields control back to the
human** — i.e. on `agent_end` (the agent either finished its work or stopped to
ask a question). It works **reliably across all four runtimes** (Pi, Claude,
OpenCode, Antigravity) and is architected to extend cleanly to richer
notifications later without a rewrite.

> See [`NOTIFICATION-LAYER-MVP-PLAN.md`](./NOTIFICATION-LAYER-MVP-PLAN.md) for
> the design rationale and locked decisions.

---

## 1. Intent

- **Trigger:** `agent_end` only. In this operator's setup all runtimes
  auto-approve, so an agent only stops when it finished or wrote its final
  question — both are `agent_end`. "Done" and "has a question" are the *same
  event* with different *content*; the operator reads the tail and decides.
- **No classification:** the message is **session identity + the truncated tail
  of what the agent last said + a deep link** (Option A). No heuristic/LLM label.
- **Session name in the header:** the title shows the session's current display
  name (the operator-renamed name if set, else the runtime/auto name). It is
  resolved **live at flush time** from `web-ui-prefs.json` (`sessionDisplayNames`,
  keyed by session path), with the opt-in snapshot `label` and the runtime label
  as fallbacks — so renaming a session *after* opting in is reflected in later
  notifications. The name is clamped in the title so an un-renamed session's long
  first-message auto-name stays readable.
- **Opt-in, decoupled from pinning:** notifications fire only for sessions the
  operator opted in. Opt-in is a persisted per-session flag, independent of the
  2-session pin limit.
- **Explicit emit:** `POST /api/v1/notifications` lets Agent OS / scripts emit a
  notification directly (deterministic; additive, never load-bearing for the
  core feature).

---

## 2. Architecture

```
4 runtimes ──service observer──▶ NotificationManager (own InternalApiEventBroker)
                                       ├─ filters to opted-in sessions
                                       ├─ triggers on agent_end (debounced)
                                       ├─ builds Notification (formatter: tail + deep link)
                                       ├─ enqueues to durable outbox
                                       └─ ChannelRouter ─▶ TelegramChannel
   Internal API routes:
     POST   /api/v1/notifications                       ← explicit emit
     POST   /api/v1/sessions/:id/notifications/opt-in   ← opt a session in
     DELETE /api/v1/sessions/:id/notifications/opt-in   ← opt out
     GET    /api/v1/sessions/:id/notifications          ← opt-in state + deliveries
     GET    /api/v1/notifications                       ← recent delivery log
```

### Modules (`server/src/notifications/`)

| File | Responsibility |
|---|---|
| `types.ts` | Stable contract: `Notification`, `OptInRecord`, `DeliveryRecord`, `QueuedNotification`, `NotificationChannel`. |
| `notification-store.ts` | Durable JSON persistence (atomic writes, reload, log capping). Mirrors `watch-store.ts`. |
| `notification-formatter.ts` | Builds `{ title, body, deepLink }` from metadata + the agent's tail; truncation; clamps the session name in the title. |
| `notification-manager.ts` | Orchestration: own broker, per-session observer attach/detach, debounce, durable outbox + retry, restart rehydration, explicit emit, **live session-name resolution** at flush time. |
| `channels/notification-channel.ts` | `NotificationChannel` interface + `ChannelRouter`. |
| `channels/telegram-channel.ts` | Telegram Bot API `sendMessage`; injectable transport; 4096 cap; token redaction. |
| `../internal-api/routes/notifications.ts` | The REST handlers. |

### Origin-independence (the key design point)

The manager attaches a **service-level observer** to each opted-in session on its
runtime's service (`multiSessionManager` / `claudeService` / `opencodeService` /
`antigravityService`), and publishes that session's normalized events into its
**own** `InternalApiEventBroker`. It subscribes to that broker and reacts to
`agent_end`.

Because the observer hooks the **service** (not the Internal-API prompt path),
`agent_end` is captured **regardless of who started the prompt** — a
browser/WebSocket-started session is handled identically to an Internal-API one.
Pi/OpenCode already had `addApiObserver`; **Claude and Antigravity had it added**
(`addApiObserver`/`removeApiObserver` tapping their event streams), closing the
origin-independence gap. The manager owns a private broker (not the one in
`routes/sessions.ts`) so there is no double-publish and no dependency on that
broker's lazy observer attachment.

---

## 3. Configuration

All vars are documented in [`.env.example`](../.env.example) (names only).

| Env var | Default | Purpose |
|---|---|---|
| `NOTIFICATIONS_ENABLED` | `false` | Master switch. Off → manager is inert (no observers, no sends). |
| `NOTIFICATIONS_DIR` | `~/.pi-web-ui/notifications` | Persistence dir (opt-ins + outbox + log). |
| `NOTIFICATIONS_DEBOUNCE_MS` | `1500` | Coalesce window for repeated `agent_end`s on one session. |
| `NOTIFICATIONS_TAIL_MAX_CHARS` | `1200` | Tail length before truncation (well under Telegram's 4096). |
| `NOTIFICATIONS_PUBLIC_BASE_URL` | first `ALLOWED_ORIGIN` | Base for deep links (`<base>?session=<id>`). |
| `NOTIFICATIONS_MAX_DELIVERY_ATTEMPTS` | `5` | Outbox retry cap before a delivery is marked `failed`. |
| `TELEGRAM_BOT_TOKEN` | _(unset)_ | Dedicated bot token. Unset → Telegram reports not configured. |
| `TELEGRAM_CHAT_ID` | _(unset)_ | Operator's chat id. |

**Secret handling:** the bot token lives **only** in the un-committed `.env`
(never in a tracked file, log, test fixture, or commit). It is redacted from any
thrown error. Tests use injected fake transports + fake creds — no test ever
calls the real Telegram API. In **validation mode** (`PI_WEB_UI_VALIDATION_MODE`)
the server uses an in-process capture channel instead of real Telegram, so
disposable validation never emits real external messages.

---

## 4. Internal API

Token-authed like every Internal API route (bearer token). Base path `/api/v1`.

| Method & path | Body | Returns |
|---|---|---|
| `POST /sessions/:id/notifications/opt-in` | `{ label?: string }` | opt-in record (runtime + path resolved from the registry) |
| `DELETE /sessions/:id/notifications/opt-in` | — | `{ optIn: null }` |
| `GET /sessions/:id/notifications` | — | `{ optIn, deliveries }` (pending + recent, for this session) |
| `POST /notifications` | `{ title, body, deepLink? }` | `{ notification: { id, createdAt } }` (explicit emit) |
| `GET /notifications[?limit=N]` | — | `{ deliveries }` (recent delivery log, ops/debug) |

Validation uses Zod and returns stable `{ error, code }` shapes (e.g.
`SESSION_NOT_FOUND`, `INVALID_REQUEST`) from the shared error-code catalog.

### Browser-facing route

Because the browser cannot reach the Internal API Unix socket directly, Pi Web UI
also exposes a cookie-auth REST facade for the session toggle used in the sidebar:

| Method & path | Purpose |
|---|---|
| `GET /api/sessions/:id/notifications` | read current opt-in state + recent deliveries |
| `POST /api/sessions/:id/notifications/opt-in` | opt the session in |
| `DELETE /api/sessions/:id/notifications/opt-in` | opt the session out |

The browser route is intentionally thin: it forwards to the same
`NotificationManager` and exists only so the UI can reuse normal browser auth.

### Deep links (`?session=<id>`)

The formatter emits `<base>?session=<sessionId>` links. The client honors them:
`useDeepLinkSession` (`client/src/hooks/useDeepLinkSession.ts`), mounted in the
authenticated app, reads the `?session` param on load, waits for the session list
+ WebSocket to be ready, then drives the same switch the sidebar uses (WS
`switch_session` by path). The param is stripped after read so a refresh returns
to the normal default view. Unknown ids are ignored silently. This is the
minimal reader; the URL bar is not otherwise kept in sync with the active session.

---

## 5. Ops

- **Delivery log:** `GET /api/v1/notifications` shows recent deliveries with
  `status` (`pending` / `sent` / `failed`), `attempts`, and `lastError`.
- **Durable outbox:** a notification is persisted *before* dispatch; on crash or
  restart the manager reloads pending items and resumes draining (idempotent
  notification ids prevent double-sends).
- **Retry/backoff:** a failed delivery is retried with backoff up to
  `NOTIFICATIONS_MAX_DELIVERY_ATTEMPTS`, then marked `failed` (kept in the log).
- **Graceful degradation:** a Telegram outage never breaks a session or the
  broker — delivery failures are captured in the outbox, not propagated.
- **Rehydration:** on boot the manager re-attaches service observers for every
  still-opted-in session and resumes the outbox.

---

## 6. Extension points

- **Add a channel** (Slack, email, web push): implement `NotificationChannel`
  (`id`, `isConfigured()`, `send()`) and `router.register(it)`. The formatter is
  channel-agnostic.
- **Two-way Telegram** (inbound replies → session actions): the explicit
  endpoint + session-correlated notifications leave room; not built in the MVP.
- **Classification labels** (heuristic/LLM "done vs question"): Option A is
  tail-only by design; labels can be layered later without touching the trigger.
- **Agent OS goal-level notifications:** Agent OS can already call
  `POST /api/v1/notifications`; richer goal semantics are future work.

---

## 7. Live validation

The `notify-on-agent-end` scenario (`server/src/live-validation/scenarios.ts`)
opts a session in, runs a real turn, and asserts the manager produced an
`agent_end` delivery record — the canonical origin-independence proof, runnable
for each runtime against a disposable server:

```
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0
npm run validate:live -- --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime <pi|claude|opencode|antigravity> --scenario notify-on-agent-end --json
```
