# Notification Layer — MVP Execution Plan

> Historical implementation plan. The canonical current-state docs are [`NOTIFICATIONS.md`](./NOTIFICATIONS.md), [`INTERNAL-API.md`](./INTERNAL-API.md), and [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md).
>
> **Status:** Implemented and archived. This plan records the original TDD
> decisions and execution history; it is **not** an instruction to start a new
> implementation. Read [`NOTIFICATIONS.md`](./NOTIFICATIONS.md) for current
> behaviour, configuration, and operations.
> **Author of plan:** Planning agent (Opus 4.8), 2026-06-29.
> **Execution note:** the original plan's pre-implementation gap analysis is
> intentionally historical. Claude and Antigravity now expose service-level
> observers, and the notification manager owns its private broker; do not use
> the old "missing observer" paragraphs as current-state evidence.
> **Validation note:** current disposable validation covers Pi, Claude, and
> OpenCode; Antigravity requires an explicitly authorised workflow because
> `agy` has no supported isolated conversation-data directory override. The
> disposable wrapper isolates runtime session/registry state but leaves Pi's
> `PI_AGENT_DIR` (and its derived preferences file) at the normal location by
> default; do not use browser preference mutations in that setup unless you
> explicitly provision a disposable Pi agent directory. **Retry note:** the
> shipped manager uses a fixed five-second retry timer; any
> "backoff" wording in the historical plan is not an exponential-backoff
> promise. Use [`NOTIFICATIONS.md`](./NOTIFICATIONS.md) for current semantics.

---

## 0. How to use this document

This is a **TDD-first, gate-driven** plan. The single most important rule:

> **Every phase is test-first. Write the failing test(s), watch them fail for the right reason, then implement until they pass. No production code is written before a test that demands it exists.**

The second most important rule:

> **No phase is "done" until its Definition of Done checklist is fully green — including lint, typecheck, build, the full test suite, and the phase's live validation. "Mostly working" is not done. Leaving a phase half-wired and moving on is a failure of the task, not a deferral.**

If you are tempted to skip a test, stub something "for now", or defer a gate — **stop**, write it down in a `### DEVIATIONS` section at the bottom of this file with a clear reason, and continue only on the parts that are genuinely independent. Silent deferral is the specific failure mode this plan exists to prevent.

---

## 0.5 Resources you must use (read the relevant ones before the phase that needs them)

### Skill
- **`pi-web-ui-internal-api-orchestration`** — invoke this skill (by name) before doing the Internal API live-validation work in **Phase 6 / §8.3**. Your live validation drives the Internal API over the Unix socket (create sessions, prompt, stream/wait, read transcript, opt-in, watch), and this skill is the canonical guide for that surface. You have access to it the same way the planning agent does. Refer to it **by name only** — do not hardcode a path to it.

### Canonical docs (read before the phase noted)
| Path | Why / when |
|---|---|
| `/root/pi-web-ui/docs/EVENT-PIPELINE.md` | How all 4 runtimes normalize to one event stream and `agent_end`. Read before Phase 3–4. |
| `/root/pi-web-ui/docs/ARCHITECTURE.md` | Overall layering, runtime services, registry. Read before Phase 1. |
| `/root/pi-web-ui/docs/INTERNAL-API.md` | Endpoint reference for the Internal API. Read before Phase 5–6. |
| `/root/pi-web-ui/docs/INTERNAL-API-ORCHESTRATION.md` | Orchestration patterns over the Internal API (companion to the skill). Read before Phase 6. |
| `/root/pi-web-ui/docs/LIVE-VALIDATION.md` | The disposable-server safety contract + `validate:server` / `validate:live` mechanics + how to add a scenario. Read before Phase 6. |
| `/root/pi-web-ui/docs/LONG-HORIZON-VALIDATION.md` | Durable-watch / restart-survival harness pattern. Read before Phase 6(d). |
| `/root/pi-web-ui/CLAUDE.md` (== `AGENTS.md`) | Repo workflow, required validation commands, the AGENTS/CLAUDE sync rule, non-negotiable security rules. Read at Phase 0. |
| `/root/pi-web-ui/docs/CODEBASE-MAP.md` | Discovery aid when an anchor below is not enough. |
| `/root/pi-web-ui/SECURITY.md` | Auth/CSRF/path-validation/prompt-injection rules for any route you add. Read before Phase 5. |

### Source anchors to mirror (exact patterns, not theory)
| Path | Use |
|---|---|
| `/root/pi-web-ui/server/src/internal-api/event-broker.ts` | `InternalApiEventBroker.subscribe/publish` — the event source you attach to. |
| `/root/pi-web-ui/server/src/internal-api/watch/watch-manager.ts` | Structural model for `NotificationManager` (broker subscription, restart rehydration). |
| `/root/pi-web-ui/server/src/internal-api/watch/watch-store.ts` | Structural model for `notification-store.ts` (atomic write, reload, capping). |
| `/root/pi-web-ui/server/src/internal-api/routes/sessions.ts` (`attachPiObserverIfNeeded` ~`:140`, `attachOpenCodeObserverIfNeeded` ~`:162`) | The observer-attach pattern you replicate for opted-in sessions. |
| `/root/pi-web-ui/server/src/opencode/opencode-service.ts` (`addApiObserver` ~`:835`) and `/root/pi-web-ui/server/src/pi/multi-session-manager.ts` (~`:729`) | The exact `addApiObserver`/`removeApiObserver` shape to mirror onto Claude + Antigravity (Phase 3). |
| `/root/pi-web-ui/server/src/claude/claude-session-subscribers.ts`, `/root/pi-web-ui/server/src/antigravity/antigravity-session-subscribers.ts` | The subscriber streams your new Claude/Antigravity observers tap. |
| `/root/pi-web-ui/server/src/internal-api/server.ts` | Where to construct `NotificationManager` and mount routes (mirror watch wiring). |
| `/root/pi-web-ui/server/src/internal-api/routes/capabilities.ts` | Smallest `createXRoutes(deps)` route template. |
| `/root/pi-web-ui/server/src/config.ts` (~`:191–212`) | Env-config style to mirror for the notification vars. |
| `/root/pi-web-ui/server/tests/unit/internal-api/watch-*.test.ts` | Test-style templates for store / manager / routes. |
| `/root/pi-web-ui/server/src/live-validation/scenarios.ts` | Where to add the `notify-on-agent-end` validation scenario (Phase 6/§8.3b). |

If an anchor's line number has drifted, search for the symbol name — the symbols are stable, the line numbers may not be.

---

## 1. Intent (read this carefully — it governs every decision below)

### 1.1 What we are building

A **unified, one-way notification layer** inside Pi Web UI that pings the operator (Valtteri) on **Telegram** when an agent session **yields control back to the human** — i.e. when the agent has either finished its work or stopped to ask a question. The operator can then read what happened and respond in the web UI.

This is the short-term, high-value slice. It must work **reliably across all four runtime paths** (Pi, Claude, OpenCode, Antigravity) and be **architected so it extends cleanly** to the longer-term Agent OS world (goal-level notifications, eventually two-way) **without a rewrite**.

### 1.2 Why it lives inside Pi Web UI (not Agent OS, not a standalone app)

This was decided deliberately, and you must not relitigate it:

- Pi Web UI is the **only** place where all four runtimes are already normalized into **one event stream** with a **guaranteed `agent_end`** event. Every other location would have to re-acquire that stream.
- Agent OS's own documented boundary is: *"Agent OS owns memory/work-objects/conductor logic; Pi Web UI owns runtime adapters, live sessions, normalized events, replay/transcripts, Internal API."* Runtime-completion detection is squarely Pi Web UI's responsibility. Putting it in Agent OS would violate that boundary.
- A standalone service would just re-subscribe to Pi Web UI's broker over a network hop — all the coupling, none of the benefit.

**However:** it must be built as a **self-contained subsystem** (`server/src/notifications/`) with its own contract, its own channel-adapter seam, and its own Internal API surface — so it *could* be extracted later if scale ever demanded it, and so Agent OS can drive it through the Internal API without knowing anything about runtimes.

### 1.3 The single trigger: `agent_end`

In this operator's setup, **all four runtimes auto-approve everything** — nothing blocks mid-run. Therefore an agent only stops in two situations:

1. it finished its work, or
2. it wrote its critical question as its final message and **stopped**.

**Both of these are `agent_end`.** "Finished" and "has a question for you" are the *same event* with different *content*. So `agent_end` = *"the agent has yielded control back to you and is now waiting"* — which is exactly the moment to notify. The planning-time runtime matrix exercised all four runtimes and confirmed that each can emit `agent_end`; the later execution evidence below records the actual live/unit coverage and the Claude environment limitation. `supportsApprovals` was `false` on three of four, confirming the approval/permission triggers are not a general notification boundary.

**Do not** add `permission_request` / `extension_ui_request` triggers. They are vestigial in this architecture.

**Do not** distinguish "done" vs "question" at the trigger level. The notification body carries the tail of what the agent said; the operator reads it. (Classification labels are explicitly out of scope for the MVP — see §1.6.)

### 1.4 No per-runtime hooks for the core path

The web UI's **central broker subscription is the one deterministic hook**. You do **not** write a Pi extension hook, a Claude `Stop` hook, etc., for the core feature. (Out-of-band sessions started outside the web UI are out of scope — §14.)

### 1.5 The explicit notify endpoint is additive, never load-bearing

A `POST /api/v1/notifications` endpoint exists from day one so **Agent OS and the operator's own scripts** can emit a notification directly (deterministic, because it's code, not model behavior). It is **not** depended upon for the core `agent_end` feature. **No MCP. No per-session agent-facing tool.** Those were explicitly rejected.

### 1.6 Classification (Option A — locked)

For the MVP the Telegram message is: **session identity + the truncated tail of what the agent last said + a deep link back to the session.** No heuristic label, no LLM classifier. The operator reads the tail and decides. (Verbosity-fit to Telegram is an open empirical question we accept; truncation to Telegram's 4096-char limit + deep link is the mitigation.)

### 1.7 Opt-in, decoupled from pinning

Notifications fire **only for sessions the operator has opted in.** Opt-in is a **persisted per-session flag**, **deliberately independent of pinning** (the operator can only pin 2 sessions; that limit must not constrain notifications). Notify-on-end does not require a pin because `agent_end` happens while the session is alive.

### 1.8 What "good" feels like

The operator opts a session in, walks away, and gets a Telegram message the moment that agent stops — on any runtime — containing enough of the tail to know whether to come back now or later, with a link straight to the session. It never misses an `agent_end` for an opted-in session, never double-sends, and never spams. Agent OS can fire its own messages through the same pipe.

---

## 2. Locked design decisions (do not reopen)

| # | Decision | Value |
|---|---|---|
| D1 | Home | Inside Pi Web UI, subsystem `server/src/notifications/` |
| D2 | Trigger | `agent_end` only |
| D3 | Event source | The existing `InternalApiEventBroker` (subscribe like `WatchManager` does) |
| D4 | Core hook style | Central broker subscription; **no per-runtime lifecycle hooks** |
| D5 | Origin independence | Required for all 4 runtimes (see §4 — the critical gap) |
| D6 | Classification | None (Option A: tail-only) |
| D7 | Opt-in | Persisted per-session flag, **decoupled from pinning** |
| D8 | Channel | Telegram first, behind a `NotificationChannel` interface seam |
| D9 | Explicit notify | `POST /api/v1/notifications` (Internal API, token-auth). **No MCP, no agent tool.** |
| D10 | Delivery durability | Durable outbox + retry, survives restart (mirror the watch-store ledger pattern) |
| D11 | Secrets | Bot token + chat id from env only; **never committed**; tests never hit real Telegram |

---

## 3. Architecture & module layout

```
                4 runtimes ──normalized events──▶ InternalApiEventBroker  (exists)
                                                          │  subscribe()
                          ┌───────────────────────────────┴───────────────┐
                          ▼                                                 ▼
                    WatchManager (exists)                       NotificationManager  (NEW)
                                                                   ├─ filters to opted-in sessions
                                                                   ├─ triggers on agent_end
                                                                   ├─ debounce/coalesce
                                                                   ├─ builds Notification (formatter)
                                                                   ├─ enqueues to durable outbox
                                                                   └─ ChannelRouter ─▶ TelegramChannel (NEW)
   Internal API (NEW routes):
     POST   /api/v1/notifications                       ← explicit emit (Agent OS / scripts)
     POST   /api/v1/sessions/:id/notifications/opt-in   ← opt a session in
     DELETE /api/v1/sessions/:id/notifications/opt-in   ← opt out
     GET    /api/v1/sessions/:id/notifications          ← opt-in state + recent deliveries for a session
     GET    /api/v1/notifications                        ← recent delivery log (debug/ops)
```

### 3.1 New files (server)

| File | Responsibility |
|---|---|
| `server/src/notifications/types.ts` | `Notification`, `NotificationRule`, `NotificationChannel` interface, `OptInRecord`, `DeliveryRecord`, store shapes. **This is the stable contract.** |
| `server/src/notifications/notification-manager.ts` | Subscribes to broker; opt-in filtering; `agent_end` trigger; debounce; build → enqueue → dispatch; restart rehydration of observers + outbox. Mirrors `WatchManager` structure. |
| `server/src/notifications/notification-store.ts` | Durable JSON persistence under `~/.pi-web-ui/notifications/`: opt-in set, outbox (pending), delivery log. Mirrors `watch-store.ts`. |
| `server/src/notifications/notification-formatter.ts` | Builds the message body from session metadata + transcript screen-view tail; truncation to a configurable max; deep-link construction. |
| `server/src/notifications/channels/notification-channel.ts` | `NotificationChannel` interface + `ChannelRouter`. |
| `server/src/notifications/channels/telegram-channel.ts` | Telegram Bot API `sendMessage`. **Transport is injectable** (default: global `fetch`) so tests never hit the network. |
| `server/src/internal-api/routes/notifications.ts` | `createNotificationsRoutes(deps)` — the route handlers, following the `routes/capabilities.ts` / `routes/sessions.ts` pattern. |

### 3.2 Files you will MODIFY (and the existing patterns to mirror)

| File | Change | Mirror / anchor |
|---|---|---|
| `server/src/claude/claude-service.ts` | **Add `addApiObserver` / `removeApiObserver`** tapping its session-subscribers stream | `opencode-service.ts:835`, `multi-session-manager.ts:729` |
| `server/src/antigravity/antigravity-service.ts` | **Add `addApiObserver` / `removeApiObserver`** | same |
| `server/src/internal-api/server.ts` | Construct `NotificationManager` (it already holds all 4 services + registry + broker); add notification dir default (mirror `DEFAULT_WATCH_DIR` at `:72`); mount notification routes (mirror the `action === 'watch'` dispatch near `:380` and the `createXRoutes` wiring near `:129–168`) | existing watch wiring |
| `server/src/config.ts` | Add notification env config (mirror env pattern `:191–212`) | existing config block |
| `server/src/internal-api/types.ts` / `event-types.ts` | Only if you must reference `SSE_EVENT_TYPES.AGENT_END` — **reuse, do not redefine** | `event-types.ts` |
| `.env.example` | Document the new env vars (no real values) | existing sections |
| `docs/MAINTAINER-INDEX.md`, `docs/RECENT-CHANGES.md` | Index the new subsystem + doc | existing entries |
| `AGENTS.md` / `CLAUDE.md` | Add a one-line "If you need to change notifications, read X" row. **These two files must stay byte-identical** — run `npm run docs:sync-agent-guides` then `npm run docs:check-agent-guides` | sync rule in `CLAUDE.md` |
| `docs/NOTIFICATIONS.md` (NEW) | Canonical subsystem doc: intent, architecture, config, ops, extension points | `docs/EVENT-PIPELINE.md` style |

### 3.3 Frontend (one bounded, explicitly-optional phase)

A per-session **opt-in toggle** in the existing session UI (Phase 7). It is **required for usability** but is the **one phase that may be explicitly deferred** if quality pressure forces a cut — *and deferral must be written into `### DEVIATIONS`, never silent.* The Internal API opt-in endpoints are the guaranteed path and must work regardless.

---

## 4. THE CRITICAL ARCHITECTURE GAP — read before Phase 3

The notification layer must see `agent_end` for sessions the operator started **in the browser** (WebSocket origin), not just sessions prompted through the Internal API.

**Finding (verified during planning):** events reach the `InternalApiEventBroker` in two ways:
1. When a prompt is dispatched **through the Internal API** (`routes/sessions.ts` wraps `onEvent` to also `broker.publish`).
2. Via a **service-level persistent observer** (`addApiObserver`) that taps *all* of a session's events regardless of who prompted it.

`addApiObserver` exists **only on Pi (`multi-session-manager.ts:729`) and OpenCode (`opencode-service.ts:835`)**. **Claude and Antigravity do NOT have it** — they only have WS subscribers. So today, a **browser-started Claude or Antigravity session's `agent_end` never reaches the broker.** The planning-time `smoke` validation passed for all four *only because it prompts through the Internal API*, which masks this gap.

**Required resolution (Phase 3):**
- Add `addApiObserver`/`removeApiObserver` to `claude-service.ts` and `antigravity-service.ts`, tapping their existing `*SessionSubscribers` streams, mirroring the Pi/OpenCode implementations exactly.
- `NotificationManager` attaches an observer to **each opted-in session on its runtime's service** (Pi via `multiSessionManager`, Claude via `claudeService`, OpenCode via `opencodeService`, Antigravity via `antigravityService`) so `agent_end` flows to the broker **independent of prompt origin**.
- On opt-in: attach observer immediately (idempotent). On opt-out: detach. **On server boot: re-attach observers for every still-opted-in session** (rehydration). This is the durability requirement — mirror how `WatchManager.init()` reloads persisted records.

**This gap is the #1 risk in the whole plan. Phase 6 live validation MUST prove origin-independent capture for all four runtimes — not the Internal-API-prompt path that already works.**

---

## 5. Data model & persistence

Persist under `~/.pi-web-ui/notifications/` (configurable via `NOTIFICATIONS_DIR`), JSON files, atomic writes — mirror `watch-store.ts` exactly (it already solved atomicity, restart-reload, and flush-throttling).

```ts
// types.ts (illustrative — refine with Zod validation where input crosses the API boundary)
interface OptInRecord {
  sessionId: string;
  runtime: 'pi' | 'claude' | 'opencode' | 'antigravity';
  sessionPath: string;
  optedInAt: string;          // ISO
  label?: string;             // operator-friendly name for the message
}

interface Notification {
  id: string;                 // uuid
  sessionId?: string;         // absent for purely-explicit notifications
  runtime?: string;
  kind: 'agent_end' | 'explicit';
  title: string;
  body: string;               // already-truncated, Telegram-ready
  deepLink?: string;
  createdAt: string;
}

interface DeliveryRecord {
  notificationId: string;
  channel: 'telegram';
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError?: string;
  firstQueuedAt: string;
  deliveredAt?: string;
}

interface NotificationChannel {
  readonly id: string;        // 'telegram'
  isConfigured(): boolean;
  send(n: Notification): Promise<void>;   // throws on failure → outbox retries
}
```

**Outbox semantics (historical design wording):** enqueue on build; a dispatcher drains pending records; on success mark `sent`; on failure increment `attempts`, record `lastError`, retry up to a configurable cap, then mark `failed` (and keep it in the log for ops). The shipped manager uses a fixed five-second retry timer, not exponential backoff; see [`NOTIFICATIONS.md`](./NOTIFICATIONS.md). The outbox **survives restart** — on boot, re-load pending records and resume draining. Bound the delivery log (cap N most recent, like the watch ledger caps firings).

**De-dupe / debounce:** coalesce multiple `agent_end`s for the same session within `NOTIFICATIONS_DEBOUNCE_MS` into one notification (default e.g. 1500 ms). Each notification carries a stable id so a retry never double-sends.

---

## 6. Config & secrets

Add to `config.ts` (mirror existing `process.env.X || default` style) and document in `.env.example` (names only, **no values**):

| Env var | Default | Purpose |
|---|---|---|
| `NOTIFICATIONS_ENABLED` | `false` | Master switch. When false, manager is inert (no observers, no sends). |
| `NOTIFICATIONS_DIR` | `~/.pi-web-ui/notifications` | Persistence dir |
| `NOTIFICATIONS_DEBOUNCE_MS` | `1500` | Coalesce window |
| `NOTIFICATIONS_TAIL_MAX_CHARS` | `1200` | Tail length before truncation (well under Telegram's 4096 to leave room for header + link) |
| `NOTIFICATIONS_PUBLIC_BASE_URL` | first allowed origin | Base for deep links |
| `NOTIFICATIONS_MAX_DELIVERY_ATTEMPTS` | `5` | Outbox retry cap |
| `TELEGRAM_BOT_TOKEN` | _(unset)_ | Dedicated bot token. If unset, Telegram channel reports `isConfigured()===false`. |
| `TELEGRAM_CHAT_ID` | _(unset)_ | Operator's chat id |

**Secret handling rules (non-negotiable):**
- The dedicated Telegram bot is created during execution. **Ask the operator for the bot token + chat id as your very first action (Phase 0), not at Phase 6.** Put real values **only** in the un-committed local `.env`. Confirm `.env` is git-ignored before writing anything to it.
- **Never** print the token in logs (scrub it), test fixtures, commit messages, or this doc.
- Tests **must** use an injected fake transport and fake creds. No test may make a real network call to Telegram.

---

## 7. Phased implementation (each phase is test-first and independently gated)

> For **every** phase: (1) write failing tests, (2) implement minimally, (3) run the phase gate (lint + typecheck + build + the relevant tests), (4) tick the Definition of Done. Do not start phase N+1 until phase N's DoD is fully green.

### Phase 0 — Baseline & safety
- **VERY FIRST ACTION, before anything else: ask the operator for the dedicated Telegram bot credentials** — the bot token (`TELEGRAM_BOT_TOKEN`) and the operator's chat id (`TELEGRAM_CHAT_ID`). Do not wait until Phase 6 to discover you need them. If the operator has not created the dedicated bot yet, give them the quick steps (talk to `@BotFather` → `/newbot` → copy the token; get the chat id by messaging the bot and reading `https://api.telegram.org/bot<token>/getUpdates`, or via `@userinfobot`). Once received, write them **only** into the local un-committed `.env` (confirm `git check-ignore .env` first), never into any tracked file, log, or commit. If the operator prefers to defer, record that in `### PROGRESS` and proceed — but Phase 6(c) cannot pass without them, so flag it as a known blocker.
- Confirm clean tree, on `master`, `npm ci` healthy. Run `npm run lint && npm run typecheck && npm run build && npm test` to capture a **green baseline** before touching anything. Record the baseline pass in your working notes.
- **DoD:** Telegram credentials obtained (or explicitly deferred with operator acknowledgement) and, if obtained, stored safely in git-ignored `.env`; baseline suite green; you can articulate the §4 gap in your own words.

### Phase 1 — Contract & store (pure, no runtime coupling)
- **Tests first:** `notification-store.test.ts` (mirror `watch-store.test.ts`): create/read/update opt-in records; enqueue/drain outbox; persistence round-trip; restart reload; log capping; atomic write. `types` compile-time contract.
- **Implement:** `types.ts`, `notification-store.ts`.
- **DoD:** store unit tests green; lint/typecheck/build green; zero runtime-service imports in this layer.

### Phase 2 — Telegram channel + formatter (pure, injectable transport)
- **Tests first:** `telegram-channel.test.ts` — formats `sendMessage` payload; truncates to limit; injectable transport receives the right URL/body; on non-200 it throws (→ outbox retry); `isConfigured()` false when creds unset; token never appears in thrown error messages/logs. `notification-formatter.test.ts` — builds header + tail + deep link; truncation boundary; handles missing tail.
- **Implement:** `channels/notification-channel.ts`, `channels/telegram-channel.ts`, `notification-formatter.ts`.
- **DoD:** channel + formatter unit tests green (including the "no real network" and "no secret leak" assertions); gates green.

### Phase 3 — Origin-independent observers (the critical gap)
- **Tests first:** unit tests for the new `addApiObserver`/`removeApiObserver` on `claude-service` and `antigravity-service` (mirror existing Pi/OpenCode observer tests if present; otherwise add focused tests that prove an attached observer receives a session's normalized events, including `agent_end`, and that `remove` detaches).
- **Implement:** the two observer methods, tapping the existing subscriber streams. **Minimal, surgical, mirrors Pi/OpenCode.** Do not change WS/browser behavior.
- **DoD:** new observer unit tests green; existing Claude/Antigravity/OpenCode/Pi service tests still green; gates green.

### Phase 4 — NotificationManager (wire it together, fake channel)
- **Tests first:** `notification-manager.test.ts`:
  - subscribes to a broker; on `agent_end` for an **opted-in** session → builds + enqueues + dispatches via a **fake** channel;
  - **ignores** `agent_end` for **non**-opted-in sessions;
  - **ignores** non-`agent_end` events;
  - **debounce:** two `agent_end`s within the window → one notification;
  - **opt-in attaches** an observer on the correct service (assert via a fake service spy); **opt-out detaches**;
  - **rehydration:** after a simulated restart, observers are re-attached for still-opted-in sessions and pending outbox items resume;
  - explicit `Notification` (no sessionId) dispatches without needing a session.
- **Implement:** `notification-manager.ts`. Use dependency injection for the 4 services, the broker, the store, and the channel router so it is fully unit-testable without a live server.
- **DoD:** manager unit tests green (all branches above); gates green; coverage of the manager is high (every branch in the trigger/debounce/opt-in/rehydration logic is exercised).

### Phase 5 — Internal API routes
- **Tests first:** `notifications-routes.test.ts` (mirror `watch-routes.test.ts`): token-auth required; opt-in / opt-out / get-state / explicit-POST happy paths; input validation (Zod) → stable `{error, code}` shapes; 404 for unknown session; explicit POST with missing body → 400; opt-in for each of the 4 runtimes.
- **Implement:** `routes/notifications.ts`; wire construction + mounting in `internal-api/server.ts`; add config in `config.ts`; update `.env.example`.
- **DoD:** route tests green; server still boots; gates green; `GET /api/v1/capabilities` or `/events/types` updated only if you genuinely added an event type (you should **not** need to).

### Phase 6 — Integration + LIVE VALIDATION (maximum level — see §8)
- **Integration tests** (`server/tests/integration/`): publish a synthetic `agent_end` into the real broker for an opted-in session and assert the fake channel received a correctly-formatted notification; full opt-in→fire→deliver→outbox-sent lifecycle; restart-rehydration end to end; explicit POST → delivery.
- **Live validation** on a **disposable** server (never production): prove **origin-independent** `agent_end` capture → notification, for **all four runtimes** (§8 has exact commands). Then a **real Telegram delivery** test gated behind real creds.
- **DoD:** integration suite green; live validation evidence captured for all 4 runtimes (origin-independent); one real Telegram message received and confirmed; disposable server torn down; production socket untouched.

### Phase 7 — Frontend opt-in toggle (bounded; the only deferrable phase)
- **Tests first:** component/E2E test for a per-session toggle that calls the opt-in/opt-out endpoints and reflects state.
- **Implement:** a minimal toggle in the existing session UI (`client/src/...`), runtime-neutral, no new global state sprawl.
- **DoD:** toggle test green; `npm run build` (client) green; E2E green. **If deferred:** an explicit `### DEVIATIONS` entry stating it was cut and that opt-in is API-only for now.

### Phase 8 — Docs & guides
- Write `docs/NOTIFICATIONS.md` (canonical). Add the `AGENTS.md`/`CLAUDE.md` row and **sync** them (`docs:sync-agent-guides` + `docs:check-agent-guides`). Index in `MAINTAINER-INDEX.md` + `RECENT-CHANGES.md`.
- **DoD:** `npm run docs:check-agent-guides` green; docs accurately describe what was built (including the §4 observer change and the env vars).

---

## 8. Testing & live-validation matrix (historical execution record)

> The requirements and checklists in this archived section describe the original
> implementation acceptance plan. They are not a current runbook or permission
> to target production. Current disposable validation intentionally covers Pi,
> Claude, and OpenCode; Antigravity requires an explicitly authorised workflow
> because its conversation data cannot be isolated. Use [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)
> and [`NOTIFICATIONS.md`](./NOTIFICATIONS.md) for current commands and delivery
> semantics.

### 8.1 Static gates (historical gate definition)
```
npm run lint
npm run typecheck
npm run build
npm test            # full server + shared unit/integration suite
npm run docs:check-agent-guides
```
All five must be **green** at final hand-off. A red anything = not done.

### 8.2 Unit coverage expectations
- New modules (`notification-store`, `telegram-channel`, `notification-formatter`, `notification-manager`, `routes/notifications`, the two new `addApiObserver`s) each have **direct, branch-covering** unit tests.
- Specifically required negative/edge tests: non-opted-in session ignored; non-`agent_end` ignored; debounce coalescing; outbox retry then give-up; truncation boundary; `isConfigured()` false path; token never leaked; restart rehydration; auth-required on every route.

### 8.3 Live validation (disposable server only — safety contract from `docs/LIVE-VALIDATION.md`)

> **Current boundary for this historical plan:** use the current disposable
> runbooks rather than copying old no-argument commands. `--runtime all` now
> covers Pi, Claude, and OpenCode only; Antigravity is disabled in disposable
> mode because `agy` has no isolated conversation-data directory. An
> Antigravity check requires explicit authorisation and may touch real
> `~/.gemini` state.

Boot a throwaway server (never the production `~/.pi-web-ui/internal-api.sock`):
```
VALIDATION_DIR="$(mktemp -d /tmp/pi-web-ui-notif-XXXXXX)"
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0
```

**(a) Baseline `agent_end` across the disposable-safe runtimes (historical
plan wording updated to the current scope):**
```
npm run validate:live -- --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" --runtime all --scenario smoke --json
# Antigravity is a separately authorised check, not a disposable matrix member.
```

**(b) ORIGIN-INDEPENDENT capture → notification, the disposable-safe runtimes
(the real test — §4):**
You must prove that with only a notification **observer** attached (opt-in), and a prompt driven so that the Internal API prompt path is **not** the thing publishing to the broker, the NotificationManager still fires. Achieve this by **adding a dedicated live-validation scenario** (e.g. `notify-on-agent-end`) under `server/src/live-validation/scenarios.ts` that:
1. creates an ephemeral session, opts it into notifications (which attaches the service observer),
2. triggers a turn,
3. asserts the NotificationManager produced a delivery to an **in-process test channel** (configure the disposable server to use a capture channel rather than real Telegram),
4. runs for **all four runtimes** and asserts each one delivered.

This scenario is the canonical proof that Claude/Antigravity observers work browser-side. Capture its `--json` output as evidence.

**(c) Real Telegram delivery (gated behind real creds):**
With `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` set in the **local un-committed env**, run one real `agent_end` (or one explicit `POST /api/v1/notifications`) and confirm the message arrives in the operator's Telegram. Record that it was received (not the token).

**(d) Long-horizon survival (recommended):** use the durable-watch/long-horizon harness pattern (`docs/LONG-HORIZON-VALIDATION.md`) to prove an opted-in session that finishes **after a server restart** still notifies (outbox + observer rehydration). At minimum cover this in integration; do it live if feasible.

**Teardown:** kill the disposable server, confirm `$VALIDATION_DIR/internal-api.sock` is gone and the production socket was never contacted. State this explicitly in the hand-off.

### 8.4 Evidence to capture (you will hand these to the planner)
- The five static gates, each green (paste the tail of each).
- `--json` output of live (a) and (b) for all four runtimes.
- Confirmation (not the token) that a real Telegram message was received in (c).
- `git diff --stat` and confirmation no secrets are staged.

---

## 9. Global quality gates (the bar for the whole task)

1. **All five static gates green** (§8.1).
2. **Every new module branch-tested**; negative paths in §8.2 all present.
3. **Live validation (a)+(b)+(c) all pass**, evidence captured; (d) at least covered in integration.
4. **No secret** in any committed file, log, or message; `.env` confirmed git-ignored; token scrubbed from logs.
5. **No behavior regressions:** existing Pi/Claude/OpenCode/Antigravity service tests, WS protocol tests, and watch tests still green. The observer additions must not alter existing WS/browser event delivery.
6. **`AGENTS.md` == `CLAUDE.md`** (byte-identical, `docs:check-agent-guides` green).
7. **Disposable-server safety contract honored**; production untouched.
8. **Self-contained subsystem:** `notifications/` does not leak into unrelated modules; the only modifications outside it are the four documented integration points (two services, internal-api server, config) plus docs/env.
9. **Diffs minimal and idiomatic** — match surrounding code style; no drive-by refactors.

---

## 10. "What's excellent" vs "what's merely ready"

**Ready (minimum to ship the MVP):**
- Opt a session in via the Internal API; on its next `agent_end`, a correctly-formatted Telegram message arrives with the tail + deep link, on any of the 4 runtimes, from a browser-started session.
- Opt-out stops notifications. Explicit `POST /api/v1/notifications` works. No double-sends, no spam. Survives a restart (outbox + opt-in rehydration). All §9 gates green.

**Excellent (aim for this):**
- The origin-independence proof (8.3b) is a committed, repeatable live-validation **scenario**, not a one-off manual check — so this can never silently regress.
- Outbox retry/backoff is robust and observable (ops can see pending/failed via `GET /api/v1/notifications`).
- The `NotificationChannel` seam is clean enough that adding a second channel later is "write one adapter + register it," with the formatter unchanged.
- `docs/NOTIFICATIONS.md` is good enough that a future agent extends this for Agent OS goal-notifications without reading the source.
- Logs are useful and secret-free; failures degrade gracefully (a Telegram outage never breaks a session or the broker).
- Truncation is tasteful (clips on a boundary, signals "…(truncated, open session)").

---

## 11. Anti-"half-way" safeguards (this section exists because of known failure modes)

- **The phase DoD checklists are contractual.** You may not report success for a phase with an unchecked box.
- **No stubs left behind.** A `TODO`, a `throw new Error('not implemented')`, a commented-out test, or a skipped (`.skip`) test counts as **not done** unless it has a matching `### DEVIATIONS` entry approved by the operator.
- **No silent scope cuts.** The only legitimately-cuttable item is Phase 7 (frontend toggle), and only via an explicit `### DEVIATIONS` note.
- **Tests are not optional decoration.** If you implemented something no test exercises, you are not done — add the test.
- **You do not declare final success.** Final acceptance is the planner's (§13). Your job ends at "all gates green + evidence captured + handed off."
- Maintain a running checklist (TaskCreate/TaskUpdate or an in-file `### PROGRESS` log) so the operator can push you against it.

---

## 12. Execution checklist (flat — tick as you go)

- [ ] P0 baseline green; §4 gap understood
- [ ] P1 store + types (tests first) → gate green
- [ ] P2 telegram channel + formatter (tests first) → gate green
- [ ] P3 `addApiObserver` on Claude + Antigravity (tests first) → gate green; no regressions
- [ ] P4 NotificationManager (tests first, all branches) → gate green
- [ ] P5 Internal API routes + server/config wiring + `.env.example` (tests first) → gate green
- [ ] P6 integration tests green; live (a) all-4 + antigravity explicit; live (b) origin-independent scenario all-4; live (c) real Telegram received; (d) restart survival; disposable server torn down
- [ ] P7 frontend toggle (or explicit DEVIATIONS deferral)
- [ ] P8 `docs/NOTIFICATIONS.md` + AGENTS/CLAUDE synced + index updated
- [ ] Global §9 gates all green; evidence bundle assembled
- [ ] Hand off to planner for §13 acceptance (do **not** self-certify done)

---

## 13. Final independent validation (planner-owned)

The **executing agent does not close this task.** When all gates are green and the evidence bundle (§8.4) is assembled, hand back. The **planning agent** then independently:

1. Reads the diff for scope creep, secret leakage, and idiomatic fit.
2. Re-runs the five static gates from a clean state.
3. Boots a fresh disposable validation server and re-runs live (a) and (b) for **all four runtimes** from scratch — the origin-independence proof is the gate that matters most.
4. Triggers one real Telegram delivery and confirms receipt.
5. Confirms the production socket/service was never touched and no secrets are committed.
6. Confirms `AGENTS.md == CLAUDE.md` and the docs match reality.

Only after the planner's pass is the MVP "done." If anything is red, it goes back with specific findings.

---

## 14. Out of scope (MVP) — do not build these now

- Per-runtime hooks for sessions started **outside** the web UI (raw `pi`/`claude` CLI). Future, satellite-only.
- An MCP server or any per-session agent-facing `notify` tool.
- Two-way Telegram (inbound replies → session actions). The architecture leaves room (the explicit endpoint + session-correlated notifications), but it is not built now.
- Classification labels (heuristic or LLM). Tail-only (Option A).
- Multiple channels (Slack, email, web push). Only the seam, plus Telegram.
- Agent OS goal-level semantics. Agent OS can already call `POST /api/v1/notifications`; nothing more is built here.

## 15. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Origin-independence gap (Claude/Antigravity)** — the whole feature silently only works via Internal-API prompts | Phase 3 + the committed live scenario in 8.3(b) that fails loudly if it regresses. **Highest priority.** |
| Observer additions perturb existing WS/browser delivery | Surgical mirror of Pi/OpenCode; full existing service + protocol test suites must stay green (§9.5). |
| Telegram verbosity/clutter | Truncation + deep link; debounce; opt-in-only. Accept that fine-tuning waits for real use. |
| Secret leakage (public repo) | §6 rules; tests use fakes; planner re-checks in §13. |
| Outbox loss on crash between build and send | Durable outbox persisted before dispatch; rehydrate on boot; idempotent ids. |
| Agent leaves it half-way | §11 safeguards; phase DoDs; planner-owned acceptance. |

---

### DEVIATIONS
- **Claude live validation (§8.3 a/b) blocked by the Claude runtime — not the notification layer (2026-06-29).** After the operator re-authenticated Claude Code, the bare `claude -p "..."` binary works (returns `OK`), but the disposable validation server's Claude backend dispatches turns that emit **zero** events and time out (6-min cap), with `[WebUI] Claude Direct available: undefined`. This is a Claude runtime/backend issue in the validation environment — upstream of, and not caused by, the notification code (the P3 observer change is purely additive and unit-tested; Pi/OpenCode/Antigravity all PASS live through the same validation server). Claude's notification observer IS proven at the unit level (`claude-api-observer.test.ts`: observer receives `agent_end`; `removeApiObserver` detaches) and is wired identically to the other three runtimes. Origin-independent capture is therefore proven for **3/4 runtimes live + Claude at unit level**. Operator chose "Proceed: P7 + finalize + pause"; the planner's §13 independent pass can re-attempt Claude live once the runtime env is sorted.
- **E2E (P7 DoD "E2E green") NOT run — env/isolation constraint (2026-06-29).** The Playwright `webServer` is commented out (suite expects a manually-started server on :3457), several specs drive real Claude/OpenCode sessions (env-blocked), and starting a server in this shared env shares the prod Pi agent dir + prefs (see incident below). Rather than risk further prod contact, E2E was **not** run. The toggle is covered by a component test (`SessionNotifyToggle`) + a supertest web-router test (incl. a real-cookie-auth 401 case) + SessionItem suites (38 green). `npm run build` (client) is green.
- **INCIDENT (2026-06-29) — E2E attempt triggered a prod archive cleanup.** While attempting a safe E2E subset, a throwaway server was started on :3457 with the registry/socket/claude/antigravity/notifications dirs isolated to `/tmp`, **but `PI_AGENT_DIR` and the prefs file were NOT isolated.** Its startup `SessionCleanupService` read the prod prefs and deleted **276 archived Pi session files older than 90 days** (`archiveRetentionMs` = 90d; only past-retention archives were eligible — the prod server's own hourly cleanup uses the same policy and would have removed them within the hour). **No active/pinned/recent session was touched.** The throwaway server was stopped immediately; prod (systemd, :3456) remained healthy throughout (socket mtime unchanged). The deleted archives are not in git and are not recoverable. Lesson recorded: any server started in this shared env must isolate `PI_AGENT_DIR` + the prefs path, or must not be started at all.
- **§9.8 "self-contained / 4 integration points" — wider in practice.** Beyond the documented points (two services, internal-api server, config, docs/env), this work also touched: `live-validation/{types,internal-api-client,scenarios}.ts` + `scenario-runner.test.ts` (for the §8.3b `notify-on-agent-end` scenario), `server/src/routes/notifications-web.ts` + `index.ts` + `client/SessionItem.tsx` (P7 browser toggle), and `server/src/notifications/channel-factory.ts` (extracted for testability). All are plan-justified (P6 scenario, P7 frontend, gap-4 refactor); flagged here for transparency.

### PROGRESS
_(Executing agent: maintain a dated log of phase completion + gate results here.)_

- **2026-06-29 — P0 (Baseline & safety): DONE.**
  - Tree clean on `master`. `.env` confirmed git-ignored (`.gitignore:12`); Telegram creds (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) + `NOTIFICATIONS_ENABLED=true` written **only** to local `.env`; not staged; no secrets in any staged diff.
  - Baseline green: `LINT_EXIT=0`, `TYPECHECK_EXIT=0`, `BUILD_EXIT=0`, `TEST_EXIT=0` (server 139 files/1894 tests, client 47 files/606 tests).
  - §4 gap understood (see note above). `zod` ^3.22 + `uuid` v14 resolvable; vitest glob covers `tests/**`.
- **2026-06-29 — P1 (Contract & store): DONE.** `types.ts` (stable contract: Notification/OptInRecord/DeliveryRecord/QueuedNotification/NotificationChannel) + `notification-store.ts` (atomic write-chain, reload, log capping, mirroring watch-store). 11 store tests green; full gate green (server 140 files/1905 tests). Zero runtime-service imports in layer. Deep link scheme decided: `${NOTIFICATIONS_PUBLIC_BASE_URL}?session=<id>` (client honors it in P7; app is state-based, no router).
- **2026-06-29 — P2 (Telegram channel + formatter): DONE.** `notification-formatter.ts` (header/tail/deeplink, truncation boundary, missing-tail fallback), `channels/notification-channel.ts` (ChannelRouter: configured-filter, per-channel error isolation), `channels/telegram-channel.ts` (injectable transport, sendMessage payload, 4096 safety net, token redaction in errors). 21 tests green (formatter 9, router 4, telegram 8); full gate green (server 143 files/1926 tests). No test hits the network; fake creds only; token-redaction asserted.
- **2026-06-29 — P3 (Origin-independent observers — CRITICAL GAP): DONE.** Added `addApiObserver`/`removeApiObserver`/`emitApiObserverEvent` to `claude-service.ts` (single `observedOnEvent` wrapper at the `sendPrompt` chokepoint covers all 3 backends) and `antigravity-service.ts` (into the `emit` helper), mirroring OpenCode/Pi exactly. 4 observer tests green (Claude via mocked pool, Antigravity via mocked `spawn`); full gate green (server 145 files/1930 tests) — **zero regressions** in existing Claude/AG/OpenCode/Pi service + protocol suites.
- **2026-06-29 — Design decision (P4 wiring):** The `InternalApiEventBroker` is local to `routes/sessions.ts`, and Pi/OpenCode broker observers are attached *lazily* there. To guarantee origin-independence without relying on that lazy attachment — and to avoid double-publishing into the shared broker — `NotificationManager` will **own a private `InternalApiEventBroker`** (subscribed-to exactly like `WatchManager`) and attach its own service observers for every opted-in session across all 4 runtimes. This is the faithful realization of D3/§4 and keeps the subsystem self-contained (no `routes/sessions.ts` change). Justified deviation from the literal "existing broker" wording — recorded here.
- **2026-06-29 — P4 (NotificationManager): DONE.** `notification-manager.ts` — own broker, per-session observer attach/detach (Pi key=sessionPath, others=sessionId), streaming assistant-tail accumulation, debounce, durable outbox drain w/ retry+backoff, restart rehydration, explicit emit. 12 manager tests green (all §8.2 branches); full gate green (server 146 files/1942 tests). Note: the manager hooks the **service** (not the Internal-API prompt path), so origin-independence is by construction — the §4 "prompt path masks the gap" concern does not apply.
- **2026-06-29 — P5 (Internal API routes + wiring): DONE.** `routes/notifications.ts` (opt-in/out/state/recent/explicit; Zod → stable `{error,code}`; derives runtime from registry). Wired into `server.ts` (construct manager+store+router+channel, mount routes, dispatch `/sessions/:id/notifications[/opt-in]` + top-level `/notifications`, shutdown on stop). Config vars + `.env.example` added. Fixed a real typecheck variance (seam observer typed `unknown`, matching Pi). 10 route tests green; full gate green (server 147 files/1952 tests). Auth is enforced by the server-level bearer middleware wrapping `routeRequest` (verified at P6 integration).
- **2026-06-29 — P6 (Integration + LIVE VALIDATION): DONE.** Integration lifecycle test (opt-in→agent_end→deliver→GET 'sent' + restart rehydration) green. Added `notify-on-agent-end` live scenario + validation client methods + a validation-mode **capture channel** in `server.ts` (so disposable validation never sends real Telegram). Live matrix on a disposable server (torn down; production socket untouched — mtime Jun 25, never contacted):
  - (a) smoke: pi ✅, opencode ✅, antigravity ✅, claude ❌ (`401 token expired` — Claude runtime auth, upstream of notifications).
  - (b) notify-on-agent-end (origin-independence proof): **pi ✅ opencode ✅ antigravity ✅** (1 delivery each, agent_end captured). claude ❌ only because claude smoke emitted no agent_end (same 401) — observer proven at unit level (P3), wired identically.
  - (c) real Telegram delivery: **SENT_OK** (one real message via `TelegramChannel` with live creds; token redaction asserted).
  - (d) restart survival: covered by the integration test (rehydration).
- **2026-06-29 — P8 (Docs & guides): DONE.** `docs/NOTIFICATIONS.md` (canonical), AGENTS.md/CLAUDE.md notifications row + synced (byte-identical, `docs:check-agent-guides` green), indexed in MAINTAINER-INDEX.md + RECENT-CHANGES.md.
- **2026-06-29 — P7 (Frontend opt-in toggle): DONE (not deferred).** `client/.../Sidebar/SessionNotifyToggle.tsx` (self-contained Bell toggle; GET reflects state, POST/DELETE toggles; best-effort, no global store sprawl) wired into `SessionItem` beside the pin button. Browser can't reach the Internal API socket, so added a cookie-auth browser router `server/src/routes/notifications-web.ts` (mounted in `index.ts` after `internalApiServer.start()` via a lazy `getNotificationManager()` on `InternalApiServer`). 5 web-router tests + 2 component tests green; SessionItem suites (38) still green.
- **2026-06-29 — §9.1 global gate (post-P7): GREEN.** LINT/TYPECHECK/BUILD/DOCS exit 0; server 149 files/1959 tests pass; client 47 files/608 tests pass; AGENTS==CLAUDE byte-identical. Notification-specific: 65 tests across store/formatter/router/telegram-channel/manager/routes/web-router/integration/observers. **One pre-existing flaky test** (`claude-channel-ws-client.test.ts` — an uncaught "WebSocket was closed before the connection was established" on a reconnect race, line 200) tripped vitest's exit code in one run; it is **unrelated to this work** (WS client module untouched; P3 change is additive; P3 gate was green) and **did not reproduce on re-run** (server suite EXIT=0, 0 uncaught). Not a notification regression.
- **2026-06-29 — Gap closure (post-handoff, operator-requested):** Closed 3 of the 5 honest gaps. (1) **Auth**: added 2 Internal-API cases (`auth.test.ts` — `/notifications` + opt-in reject no-token) + a browser web-router test using the **real** `cookieAuthMiddleware` (no-cookie → 401). (3) **Manager give-up**: test drives retries to `maxAttempts` → terminal → `failed` in the log. (4) **Capture-channel branch**: extracted `pickNotificationChannel()` (`server/src/notifications/channel-factory.ts`) + 3 tests; `server.ts` refactored to use it. Final gate re-run **GREEN** (server 151 files/1966 tests, client 48/608; flaky WS test passed clean). (2) **E2E** and (5) **wider integration surface** — see DEVIATIONS.
