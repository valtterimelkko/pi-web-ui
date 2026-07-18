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
- **Canonical Pi opt-in identity (bare UUID):** Pi sessions carry two ids — the
  file basename (`<timestamp>_<uuid>`, the live sidebar `session.id` while
  streaming) and the bare UUID (`<uuid>`, the `type:"session"` header id, which is
  also the reloaded sidebar `session.id`). The opt-in is keyed on the **bare UUID**
  derived deterministically from the session path (`canonicalOptInId` in
  `@pi-web-ui/shared`, the same identity the v2 session-metadata layer's `pi:<uuid>`
  is built on), so the bell stays in sync across a reload and turning it off truly
  stops notifications. The browser UI computes this canonical id and uses it for
  GET, POST, and DELETE; the browser POST route normalizes it again from the
  server-sourced `runtime` + `sessionPath`, while its GET/DELETE façade expects the
  already-canonical id because those requests do not carry the path. The
  Internal-API route resolves the registry entry and normalizes server-side. Non-Pi
  runtimes key on the id unchanged (their id already equals their path). A
  one-time, superset-preserving normalization runs in
  `NotificationManager.init()` (before rehydration), re-keying any legacy
  basename-keyed Pi opt-ins to the bare UUID and deduping records that collapse to
  the same id (keeping the newest) — so existing broken opt-ins self-heal on the
  next restart without losing any session.
- **Opt-in is not retroactive:** the manager only reacts to a *live* `agent_end`
  arriving after its service observer attaches (`NotificationManager.attach()`
  subscribes to its broker with `replay: false`). If a turn's `agent_end` fires
  before the opt-in click lands, that turn's notification is permanently missed
  — there is no catch-up/replay of past events. This was the root cause of a
  real "I opted in but got no notification" report: the operator opted in ~5s
  after the session's last turn had already completed. The sidebar bell toggle
  (`SessionNotifyToggle.tsx`) mitigates the confusion: when opting into a
  session that is not currently `streaming`/`busy` (`sessionData[id].status` in
  the client store), it shows an inline toast — *"Notifications on — this
  session is idle, so you'll get notified starting with its next reply."* — so
  the non-retroactive behavior isn't mistaken for a bug.
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
     POST   /api/v1/notifications                       ← durable/idempotent explicit acceptance
     GET    /api/v1/notifications/:id                   ← poll delivery status
     POST   /api/v1/sessions/:id/notifications/opt-in   ← opt a session in
     DELETE /api/v1/sessions/:id/notifications/opt-in   ← opt out
     GET    /api/v1/sessions/:id/notifications          ← opt-in state + deliveries
     GET    /api/v1/notifications                       ← recent delivery log
```

### Modules (`server/src/notifications/`)

| File | Responsibility |
|---|---|
| `types.ts` | Stable contract: `Notification`, `OptInRecord`, `DeliveryRecord`, `QueuedNotification`, `NotificationChannel`. |
| `notification-store.ts` | Durable JSON persistence (atomic writes, restart reconciliation, recent-list and wider status-ledger caps). Mirrors `watch-store.ts`. |
| `notification-ingress-spool.ts` | Bounded, schema-validating local spool drainer for terminal clients that outlive a server restart window. |
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
| `NOTIFICATIONS_INGRESS_POLL_MS` | `5000` | Poll interval for locally spooled explicit notifications. Must be positive. |
| `NOTIFICATIONS_CHANNEL_TIMEOUT_MS` | `10000` | Per-attempt Telegram request timeout, including response-body read. Must be positive. |
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
| `POST /notifications` | `{ title, body, deepLink? }`; optional `Idempotency-Key` header | `202` + `{ notification, duplicate, statusUrl }` after durable acceptance; `Location` points to status |
| `GET /notifications/:notificationId` | — | `{ status: "ok", delivery: { notification, delivery } }` (`pending`, `sent`, or `failed`) |
| `GET /notifications[?limit=N]` | — | `{ deliveries }` (recent delivery log, ops/debug) |

Validation uses Zod and returns stable `{ error, code }` shapes (e.g.
`SESSION_NOT_FOUND`, `INVALID_REQUEST`) from the shared error-code catalog.
Status/idempotency lookup is bounded to pending items plus the newest 1000
terminal records; recent-list responses default to the newest 200.
An identical retry with the same `Idempotency-Key` joins the original durable
record. Reusing that key with another payload returns `409
IDEMPOTENCY_KEY_CONFLICT`. Raw keys are hashed in the delivery store.

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
- **Durable outbox:** a notification is persisted *before* `202 Accepted`; on
  crash or restart the manager reloads pending items and resumes draining.
- **Delivery semantics:** ingress retries are idempotent when callers reuse a key.
  Telegram delivery is **at least once**: a process crash after Telegram accepts
  but before local `sent` persistence can still produce a duplicate on retry.
- **Retry/backoff:** a failed delivery is retried on the manager's fixed
  five-second retry timer (not exponential backoff), up to
  `NOTIFICATIONS_MAX_DELIVERY_ATTEMPTS`; it is then marked `failed` and kept in
  the log. Pending items are also attempted again after a restart.
- **Graceful degradation:** a Telegram outage never breaks a session or the
  broker — delivery failures are captured in the outbox, not propagated.
- **Graceful shutdown:** a pending debounced `agent_end` is forced into the
  durable outbox before observer teardown; in-flight delivery/ingress work is
  joined before socket ownership is released.
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
`agent_end` delivery record — the canonical origin-independence proof. The
standard disposable server covers Pi, Claude, and OpenCode:

```
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0
npm run validate:live -- --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime <pi|claude|opencode> --scenario notify-on-agent-end --json
```

Antigravity is disabled by the disposable server because `agy` has no supported
conversation-data directory override. Test its notification path only with an
explicitly authorised, separately isolated-enough target, and record that the
real `~/.gemini` state may be touched; see [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md).

---

## 8. Observability

The three server modules each use the central logger
([`docs/OBSERVABILITY.md`](./OBSERVABILITY.md)) instead of the JSON delivery
log alone, so the *reason* a notification did or didn't fire is greppable
without reconstructing it from timestamps by hand:

| Component | Emits |
|---|---|
| `NotificationManager` | `info`: opt-in/opt-out (sessionId+runtime bound), rehydration count on boot, an `agent_end` notification queued (with id), successful delivery (with id). `warn`: **attach failed because the runtime service isn't wired** (the silent-failure blind spot — before this, an opt-in could persist with the UI showing "on" while no observer was ever attached, forever, with zero signal), enabled-but-no-channel-configured on boot, a delivery attempt failure (with attempt count + error). `debug`: observer attach/detach, `agent_end` observed pre-debounce. |
| `NotificationStore` | `warn`: a persisted file (`opt-ins.json`/`outbox.json`/`delivery-log.json`) failed to parse for a reason other than "missing" — previously silent, which meant a corrupt file reset state to empty with no trace of why. A missing file (normal on first boot) stays quiet. |
| `NotificationsRoutes` | `warn`: opt-in requested for a session the registry doesn't know about, or one whose runtime isn't supported — both indicate a registry/UI mismatch worth investigating. |

Session-scoped manager log lines are bound with `sessionId` + `runtime` via
`logger.child(...)`, so `DEBUG=NotificationManager` or a
`grep sid=<sessionId>` reconstructs one session's notification lifecycle —
opt-in → attach → `agent_end` observed → queued → delivered — in one pass.
Global lifecycle/ingress lines (for example boot counts and explicit emits) do
not have a session to bind. See [`docs/OBSERVABILITY.md`](./OBSERVABILITY.md)
for `LOG_LEVEL`, `DEBUG` namespaces, and `LOG_FORMAT=json`.

---

## 9. Self-notification from a terminal CLI harness

The `agent_end` trigger above only fires for sessions the **web UI manages**.
When you run a coding agent directly from the terminal (`claude` / `glm` / `pi`
/ `opencode` / `agy`) — e.g. to work on this repo and restart production — that
session is not observed by the web UI, so it will never trigger an `agent_end`
notification on its own.

Instead, a terminal agent can **self-notify** through the same notification
layer by calling a small helper script, which submits to the explicit-emit
endpoint ([§4](#4-internal-api)) over the local Unix socket. The helper waits
through short restart windows and, if the API remains unavailable, atomically
queues the record under the notification ingress directory for the next server
drain. **No production restart or code change is performed by the helper.**

### The helper: `scripts/notify.sh`

```
scripts/notify.sh <kind> <title> [body]
```

| Arg | Value |
|---|---|
| `kind` | `milestone` \| `done` \| `question` \| `blocked` (any other value becomes a custom label) |
| `title` | Short one-line summary — **no emoji**, the script adds the standard prefix |
| `body` | Optional detail; omit or pass `-` to read from stdin (falls back to the title) |

The script maps the kind to a standard title prefix so messages are consistent
regardless of which harness or model wrote them:

| `kind` | Resulting title |
|---|---|
| `milestone` | `📍 Milestone: <title>` |
| `done` | `✅ Done: <title>` |
| `question` | `❓ Question: <title>` |
| `blocked` | `⚠️ Blocked: <title>` |
| (custom) | `📢 <kind>: <title>` |

Examples:

```bash
scripts/notify.sh milestone "observability phase 3 complete" \
  "Health and diagnostics changes are implemented; focused tests and typecheck pass."


scripts/notify.sh done "restarted prod" \
  "Built client+server; typecheck+lint+tests green; restarted pi-web-ui.service."

scripts/notify.sh question "which DB index?" \
  "Should I add an index on sessions.userId before shipping the query change?"
```

It reads the bearer token from `~/.pi-web-ui/internal-api-token` (mode 0600) and
the socket from `~/.pi-web-ui/internal-api.sock` — both overridable via
`PI_WEB_UI_NOTIFY_TOKEN_FILE` / `PI_WEB_UI_NOTIFY_SOCKET` for non-default
installs. One UUID is reused across ambiguous retries. By default it health-waits
for up to 30 seconds, then writes a `0600` atomic record under
`~/.pi-web-ui/notifications/ingress/` (`0700`) and exits successfully. The
server drains that bounded queue at startup and periodically. Override with:

- `PI_WEB_UI_NOTIFY_WAIT_MS`, `PI_WEB_UI_NOTIFY_RETRY_MS`, and
  `PI_WEB_UI_NOTIFY_REQUEST_TIMEOUT_MS` for timing;
- `PI_WEB_UI_NOTIFY_SPOOL_DIR` for an isolated/non-default server;
- `PI_WEB_UI_NOTIFY_IDEMPOTENCY_KEY` only when a caller deliberately owns a
  stable retry key.

On direct acceptance, stderr includes the pollable `statusUrl` returned by the
server. Validation/auth/client errors (`400`-class except retryable `408`/`429`) are not
spooled and exit non-zero. Queue expiry is seven days; malformed, oversized,
expired, or symbolic-link entries are rejected. The bearer token is never
printed or placed in the spool.

### Activation — by prompt, not by config

This is **deliberately not wired into `CLAUDE.md` / `AGENTS.md`**. Those files
are read by *every* session in this repo, including ones the web UI manages —
and an agent cannot reliably tell whether it was launched from a terminal or via
the web UI. An unconditional "notify when done" instruction there would
double-notify for web-UI-managed sessions (which already fire `agent_end`).

So activation is **by the operator's opening prompt** to a terminal session,
e.g.:

> Inspect `docs/NOTIFICATIONS.md` § 9. When you finish the task, or if you have
> a question for me, call `scripts/notify.sh` to ping me on Telegram with a
> short summary.

For multi-phase autonomous work, keep notifications low-noise: send `milestone`
only after a meaningful phase/review gate, `question` or `blocked` only when
operator input is genuinely required, and exactly one `done` after final
validation. Do not notify for each test or file edit. Reuse one idempotency key
when retrying the same milestone, and do not self-notify a web-UI-managed
session that already has `agent_end` notifications enabled.

The agent reads this section and runs the script. This is **best-effort,
agent-initiated** (~80–90% reliable depending on the model's
instruction-following; for guaranteed delivery, run the session through the web
UI and opt it in). It trades perfect reliability for zero sharp edges: no
hooks, no per-harness plugins, no shared-config mutation, and the double-notify
risk is entirely under the operator's control (only terminal sessions get the
prompt).

### What to put in the message

Write a **semi-comprehensive** body: what you did, the outcome
(tests/lint/build status), anything you changed that affects production, and —
for `question` / `blocked` — exactly what decision or input you need from the
operator. The title is the one-line headline; the body is the detail.

### Works across all four harnesses

`claude`, `glm`, `pi`, `opencode`, and `agy` each expose a Bash tool and
operate at the repo root, so the same script and the same activation prompt
work for all of them — one mechanism, not four. (`glm` is just `claude` run
with GLM/Z.ai env, so it shares Claude Code's Bash tool entirely.)

### Security

The script adds no network listener or authentication surface: it reuses the
existing token-authed explicit-emit endpoint. The bearer token is read from the
`0600` file at runtime and is never queued. Spool records do contain the
notification title/body and caller idempotency key, so their directory is
forced to `0700` and each file to `0600`. Nothing secret is embedded in the
tracked script.
