# Child-Orchestration Surfacing Plan — background subagents, Internal-API children, and watch events in the session view

> **Status: PLANNED — NOT EXECUTED. No code has been changed. Owner go required before execution.**
> Contract allocation: **1.34.0** (repo and production both serve 1.33.0 as of 2026-09-04; verified via prod `/api/v1/capabilities`).
> Origin: operator session `01a06cdc-d589-7af2-a87c-1c14bff5cfcc` (cwd `/root/79tower`, 2026-09-04) + operator follow-up asking for card design and steering-safety. Analysis only; no execution.

---

## 1. What actually happened in the origin session (evidence)

The 79tower session dispatched **three Pi harness background subagents** — not Internal-API children:

- `subagent` tool, `run_in_background: true`, agent `web-researcher` × 3 (ETF pack / HL costs / performance pack). Tool results: `Background subagent launched (detached). task_id: bg_mtn2x6ag…, run_id: sa_mtn2x6ag…` (~14:58:47).
- Waiting strategy: a raw `sleep 240 && echo "checked in"` bash call + turn end — **no watch-wake, no dead-man backstop, no Internal API**. Completions arrived as injected follow-up user messages (`Background task update:\n\n[background task bg_mtn2x6ba_tqms1a (web-researcher, bounded) completed]…`, ~15:04:39).
- The operator's guess ("children via the Internal API") was wrong for this session, but the underlying surfacing gap is real and general — it applies to background subagents, Internal-API children, and watches alike.

### What the operator saw, mechanically

1. **At initiation**: three `SubagentToolCard`s rendered live (the `subagent` tool call is a normal tool card), but each flips to a green ✓ **within ~1 second** because the launcher tool returns immediately. The summary path yields `agents: []` (empty `details.results`), so the card carries **no model, no tokens, no "still running" state** — it reads as a finished trivial tool call. Effectively invisible as "children were dispatched".
2. **While running**: nothing. No status line, no counter, no card anywhere says "3 children running".
3. **At completion**: the `Background task update:` message renders as an ordinary **user bubble**. Its delivery rail (`sendUserMessage({deliverAs: 'followUp', triggerTurn: true})` — subagent extension `background.ts`) is indeed the same follow-up mechanism steering uses; the operator's "it's maybe a steering event" hunch is right about the rail, wrong about the surface (it is not a steering chip, just a user message).
4. **Via the Internal API "what I see" endpoint** (`GET /sessions/:id/transcript?view=screen`): **zero tool items at all** for Pi sessions — see §3 defect.

---

## 2. Surfaces inventory (verified against the code)

| Surface | Today | Where |
|---|---|---|
| Foreground subagent card (model/tokens) | ✅ works | `SubagentToolCard` + `resultSummary` enrichment (`server/src/pi/event-forwarder.ts` `enrichSubagentEvent`, `shared/src/subagent-summary.ts`), replay parity via `parsePiSessionHistory` |
| Background subagent **launch** | ⚠️ instant-✓ card, no model, no running state | same card; `details.background = {taskId, runId, kind}` present but unused by client |
| Background subagent **running state** | ❌ nothing | `background-tasks` custom entries are **file-only** (`appendEntry`); the Pi core `AgentEvent` union has no custom-entry event, so neither websocket nor broker ever sees them |
| Background subagent **completion** | ⚠️ plain user bubble | follow-up `sendUserMessage`; no card, no model/usage, no link to the launch card |
| Internal-API-dispatched children in parent view | ❌ nothing | children appear as unrelated sidebar sessions; `RegistryEntry` has `origin` but **no `parentSessionId`**; no correlation path exists |
| Child runtime/model/provider on dispatch | ❌ (known server-side at create, never linked to parent) | `CreateSessionRequest.model` + `modelBinding` in create response |
| Watch registration / firing in parent view | ❌ nothing | wake text arrives as plain user message; broker has no `watch_*` events; steer-wake work (commit `0592f8e`) added delivery kinds, not surfacing |
| Dead-man backstop subagent | = background subagent gap | it is a plain subagent; must **not** be special-cased (owner instruction) |
| Screen view tool parity for Pi | ❌ defect | `piSessionToReplayEvents` drops toolCall/toolResult → `view=screen` shows zero tool cards (verified on two sessions incl. a 285-message one) |
| `/events` snapshot for browser-origin Pi sessions | ⚠️ empty until first Internal-API touch attaches the broker observer | `attachPiObserverIfNeeded` |

---

## 3. Root causes

1. **No live channel for background-task state.** The subagent extension persists `background-tasks` custom entries and injects follow-up messages; both bypass the event stream. The browser and broker cannot see launches/settlements as events.
2. **Launch card lacks identity/state.** `details.background` carries `taskId`/`runId`/`kind` but no model, and the client renders it as a completed generic call.
3. **No parent↔child linkage for Internal-API dispatches.** A Pi parent calls the API over the Unix socket via bash `curl`; the server cannot tell which session made the call — **except it can**: Pi bash tool subprocesses expose `PI_SESSION_ID` / `PI_SESSION_FILE` / `PI_PROVIDER` / `PI_MODEL` env vars by default (`exposeSessionEnvironment` defaults **true** in the SDK's `createShellToolDefinition`). The connecting process inherits them, so `SO_PEERCRED` → `/proc/<pid>/environ` gives the parent session deterministically, with an explicit header as fallback.
4. **Watches are invisible.** Registration and firing live in the watch ledger (`watch-manager.ts`) and run receipts; no broker/browser event is published.
5. **Screen-view adapter gap.** `server/src/session-transfer/pi-source-adapter.ts` `piSessionToReplayEvents` maps only `message` text/thinking parts; Pi stores tool calls as assistant `toolCall` blocks and results as `toolResult` messages, so tools vanish from `view=screen` (and the same adapter feeds session transfer).

---

## 4. Design decisions (answers to the operator's questions)

**One card or two?** One **card identity** per child, two **surfaces** — mirroring the goal panel pattern:
- **Transcript card at the dispatch point** (durable, contextual): starts as `dispatched → running`, flips to `completed/failed` when the child settles, and then shows model + usage. Not two cards — the completion *updates* the same card (identity: background = `taskId`/`runId`; Internal API = child `sessionId`).
- **Live status strip while children run** (ephemeral): an extension-widget-style "Children: 2 running · 1 done (web-researcher ×2, codescout)" line above the input, exactly where the goal status lives. Appears on first dispatch, clears when all children settle.

**Steering safety (operator constraint).** Nothing in this plan touches steer/follow-up delivery, the delivery-mode strip, queued chips, or the follow-up user messages themselves. All additions are *new read-only event types* and *new render surfaces*. The existing `Background task update` bubbles keep arriving unchanged (they remain the model-facing wake channel; the cards are human-facing sugar).

**Dead-man backstop.** It is a plain (usually background) subagent. It surfaces exactly like any other background subagent card — **no special-casing**; a regression test pins that.

**Model/provider/runtime on the card.**
- Background harness children: the subagent extension resolves the agent's model at launch — include it in `details.background` (extension-side addition; the resolved model string, e.g. `openai-codex/gpt-5.6-luna` from the agent frontmatter). Usage/model truth at completion already exists in the persisted run record (`task_output`/`subagent_run`) — completion enrichment reuses the `SubagentToolSummary` shape.
- Internal-API children: runtime + requested selector + resolved binding are known at create; they go on the card verbatim.

**Parent linkage for Internal-API children.** Automatic first, explicit second:
- Automatic: Internal API reads the Unix-socket peer pid (`SO_PEERCRED`) → `/proc/<pid>/environ` → `PI_SESSION_ID`. Zero cooperation needed from the calling agent or skills. No ancestor in a Pi session (e.g. agent-os conductor, cron) → no linkage, which is correct.
- Explicit fallback: optional `X-Parent-Session` header (and `CreateSessionRequest.parentSessionId?`) for wrappers that scrub env. Local-only, same-user socket; spoofed linkage is display-only, acceptable.
- Linkage is stored on the child's registry entry (`parentSessionId?`, additive) and drives the events below.

**Where the events flow.** Reuse the two proven rails:
- **Browser rail**: `onBrowserMessage` → `wsManager.broadcast` (goal contract-1.27.0 precedent) synthesising `extension_status` / `widget_content` / `widget_cleared`-grammar messages — the client already stores and replays these per session; MVP rendering needs **zero client protocol change** (generic `otherExtensionWidgets`), with a dedicated `ChildrenPanel`/card component as polish.
- **Internal-API rail**: `broker.publish` onto the **parent** session key (Pi = session path) so `/events`, `/events?mode=snapshot`, and durable watches can observe child/watch lifecycle the same way they observe `goal_state`.

---

## 5. Fixed sequence (phases, TDD, each independently shippable)

### Phase 0 — Groundwork + contract 1.34.0
- Bump `INTERNAL_API_CONTRACT_VERSION` to 1.34.0; capabilities advertise the new event types and `parentSessionId` support (additive only).
- Shared types: `ChildDispatchCard` projection (identity, kind: `background_subagent | internal_api_child`, runtime, model, selector, status, timestamps), watch card projection (`watch_registered` / `watch_fired`).
- RED tests: capabilities fixture asserts new event types + `children` expansion presence.

### Phase 1 — Pi screen-view tool parity (standalone defect fix, smallest, immediately useful)
- `piSessionToReplayEvents`: emit `tool_execution_start` from assistant `toolCall` blocks and `tool_execution_end` from `toolResult` messages (with `summarizeSubagentDetails` parity for subagent tools so `view=screen` matches the browser card data).
- RED: unit test feeds the real 79tower JSONL fixture (3 background launches) and asserts 3 `subagent` tool items; conformance vs `screen-view.test.ts` expectations.
- Note: also benefits session transfer. Out of scope here: `/events` observer auto-attach for browser-origin sessions (separate follow-up; recorded in §8).

### Phase 2 — Background-subagent surfacing (the 79tower gap)
- **Extension side** (`~/.pi/agent/extensions/subagent`): on launch/settle push `ctx.ui.setStatus('background-tasks', "🤖 2 running · 1 done")` + widget lines (per-child: agent, model, age); include resolved model in `details.background`; keep `appendEntry` persistence as truth + reconcile on `session_start` (already exists).
- **Server side**: nothing new required for live status (extension_status channel already flows + replays via `replayExtensionUiSnapshot`). Bridge background state to the broker for Internal-API observers by tapping the extension-UI observer (goal-bridge precedent, `createPiGoalEventBridge` pattern → `background_child_state` events).
- **Client**: `SubagentToolCard` detects `details.background` → renders as **child card** (dispatched state, `taskId`, agent, model; no instant ✓). Completion link: `background_child_state`/widget payload flips card to completed with usage. `parsePiSessionHistory` replays `background-tasks` custom entries so a page reload reconstructs running/completed child states.
- RED tests: sessionStore handles `background_child_state`; card renders dispatched-not-completed; replay reconstructs a running child from a fixture JSONL.

### Phase 3 — Internal-API child linkage + `child_dispatched`/`child_completed`
- Server: `SO_PEERCRED` + `/proc/<pid>/environ` correlation helper (unit-tested with a fake peer pid table), `X-Parent-Session` header fallback, `RegistryEntry.parentSessionId?`, `POST /sessions` records linkage, create response carries it (additive).
- Events: on create → `child_dispatched {childSessionId, runtime, model, modelBinding, parentSessionId}` published to the **parent's broker key** + browser-bridge widget card; on child terminal (`agent_end`/disposal) → `child_completed`. Long-horizon watch wakes remain the wake channel; the card is presentation.
- `GET /sessions/:id` gains additive `children` expansion (ids + status + model) so the frontend/sidebar can badge children and the parent view can re-hydrate cards after reload.
- RED: watch-routes/integration tests assert publish-to-parent-key; correlation helper tests; contract mirror doc updated.

### Phase 4 — Watch surfacing
- `watch-manager`: on register → `watch_registered {watchId, sourceSessionId/runtime/model, conditions, mode}`; on fire → `watch_fired {watchId, condition, firedAt, deliveryKind}` — broker (parent key) + browser bridge. Cards: "⏳ watch armed: `agent_end` on <child>" → "🔔 fired → wake delivered (steer|prompt|followUp)".
- `/watches/wait` long-poll untouched (additive events only).
- RED: extend `watch-manager.test.ts` / `watch-wake-integration.test.ts` with publish assertions.

### Phase 5 — Dead-man parity pin
- Regression test: a background dead-man-style subagent renders identically to any background subagent (no special case, no extra badge). Documentation notes it is "just a subagent" by design.

### Phase 6 — Docs + skills (canonical only)
- `docs/INTERNAL-API.md` / `INTERNAL-API-CONTRACT.md` (1.34.0 additions), `docs/EVENT-PIPELINE.md` (child/watch event flow), `RECENT-CHANGES.md`.
- Skills (`/root/.skills-global/skills-global`): `pi-web-ui-internal-api-orchestration` (parent linkage header note + what the cards show), `long-horizon-waiting-strategies` (cards are presentation; wake rails unchanged).

### Phase 7 — Live validation (disposable server; `pi-web-ui-live-validation` flow)
- Scenario A: real Pi parent dispatches 3 background subagents (mirror the 79tower shape) → assert widget + dispatched cards live, completion flips cards, `view=screen` shows tool items (Phase 1 proof), broker carries `background_child_state`.
- Scenario B: Pi parent curls the Internal API to create a child → assert automatic `parentSessionId` correlation (peer env), `child_dispatched` on parent key, browser-bridge widget, `children` expansion.
- Scenario C: watch register → fire (agent_end) → `watch_fired` + card; steer-mode wake unaffected.
- Browser check via `webapp-testing` for the actual card rendering (no production touch).

### Phase 8 — Owner-gated deploy
- Production restart (operator permission, standard pre-checks) + **agent-os contract-mirror resync chore** (constant + observability pin + mirror doc; Command Code fails-closed until resync — established coupling).

---

## 6. Sizing & ownership

| Phase | Effort | Repo |
|---|---|---|
| 0 groundwork | ~2h | pi-web-ui |
| 1 screen-view parity | ~½ day | pi-web-ui |
| 2 background children | ~1 day | pi-web-ui + `~/.pi/agent/extensions/subagent` |
| 3 Internal-API linkage | ~1 day | pi-web-ui |
| 4 watches | ~½ day | pi-web-ui |
| 5–7 parity/docs/validation | ~½ day | pi-web-ui + skills-global |
| 8 deploy | gated | — |

Total ≈ 3–4 focused days. Phases 1 and 2 deliver the operator-felt value first and are independent of 3–4.

## 7. Risks & edge cases

- **`/proc/<pid>/environ` race**: the peer is alive for the whole request (socket owned by it), so the read is safe; short-lived wrappers → header fallback. `agent-os`/conductor callers carry no `PI_SESSION_ID` → correctly unlinked.
- **Trust**: linkage is display-only metadata; local same-user socket, spoofing costs at most a wrong card.
- **Widget channel load**: status pushes only on state transitions (launch/settle), matching the goal widget's rate; broker payload bounds already enforced (flood-hardening work).
- **Replay correctness**: `background-tasks` entries are the truth channel; card state at switch derives from them, not from ephemeral widget cache.
- **Steering regression risk**: none by construction (no steer/followUp code paths touched; new event types only). Guarded by existing steer tests staying green.

## 8. Recorded follow-ups (out of scope here)

- `/events` observer auto-attach for browser-origin Pi sessions (snapshot currently empty until an Internal-API touch) — separate small fix, arguably Phase 1.5.
- Sidebar "child of …" badges / children filter (cheap once `children` expansion exists).
- Non-Pi runtimes: Claude/OpenCode/Command Code background-task analogues — deferred; Pi is the operator's orchestration surface.

## 9. Explicit non-goals

- No changes to wake/steer/follow-up delivery semantics (steer-wake feature stays as shipped).
- No special dead-man surfacing (it is just a subagent).
- No production restart or agent-os resync without owner permission.
