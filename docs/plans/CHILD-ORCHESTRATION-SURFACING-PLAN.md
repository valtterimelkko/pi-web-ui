# Child-Orchestration Surfacing Plan — harness subagents, Internal-API children, and watch events in the session view

> **Status: PLANNED — NOT EXECUTED. No code has been changed. Owner will issue the execution goal.**
> Contract allocation: **1.34.0** (repo and production both serve 1.33.0 as of 2026-09-04; verified via prod `/api/v1/capabilities`).
> Revision 2 (2026-09-04): both tracks — (A) harness subagent gaps and (B) Internal-API orchestration — grounded in real session logs and made equally concrete. Supersedes revision 1 in full.

---

## 0. Grounding: the two real reference sessions

Both gaps are grounded in real 30-day session logs (`/root/.pi/agent/sessions/**`, registry `/root/.pi-web-ui/session-registry.json`, watch ledger `/root/.pi-web-ui/watches/*.json`, run receipts `/root/.pi-web-ui/run-receipts/` — 264 receipts):

### Track A reference — `01a06cdc` (cwd `/root/79tower`, 2026-09-04, glm-5.3-flash)
- Dispatched **3 pi background subagents** (`subagent` tool, `run_in_background:true`, agent `web-researcher`; `bg_*`/`sa_*` ids) at 14:58:47.
- Waited via raw `sleep 240` + turn end; completions arrived as `Background task update:` follow-up user messages (~15:04:39).
- **No** Internal API, no watches, no dead-man. Operator saw: instant-✓ launch cards with no model; nothing while running; plain user bubbles at completion.

### Track B reference — `01a0688d` (cwd `/root`, 2026-09-03, the MuseSpark benchmark orchestrator)
This session used the **full Internal-API orchestration stack**, making it the canonical grounding for Track B:
- **Child creation via bash curl** with an `api()` shell wrapper (62 uses): `api -X POST http://localhost/api/v1/sessions -d '{"runtime":"pi","model":"commandcode/meta/muse-spark-1.3-contributor","thinkingLevel":"xhigh","cwd":"$RUN/fxa-coursekit","retention":{…}}'` → response to `/tmp/create-fxa.json` with `sessionId, sessionPath, model, modelSelector, resolvedModel, thinkingLevel, executionInstanceId, retention`. ~20 creates, plus `POST …/sessions/:id/prompt` and `/control` dispatches, `POST /sessions/usage`.
- **Watches via the watch-wake extension tools** (not curl): `watch_wake_register` ×26 (`{session_id: <child>, conditions:[{type:'event_type',eventType:'agent_end',once:true}], label:'msb13-fxa-agent_end', message:'Benchmark child fxa ({{sessionId}}) turn ended — reconcile ALL wave-1 children… (runbook §4.5)'}`), `watch_wake_cancel` ×4, `watch_wake_list` ×2. Registrations persist as `watch-wake-registrations` custom entries in the parent file; wakes arrive as interpolated **plain user messages**; deliveries also log `watch-wake-delivery` entries.
- **Dead-man backstop**: one background subagent (`bg_mtlwoatt`) — surfaced only as `DEAD-MAN TIMER FIRED after ~50 minutes` user messages (×2).
- **Goal engine** on the parent (`goal` tool ×16) — goal status already surfaces (1.27.0 work).
- Same shape recurs across the 30-day corpus: 93 of 196 recent session files mention `internal-api.sock`; benchmark children themselves (cwd `musespark-benchmark-runs/…`) are Internal-API-created sessions with `origin:'internal-api'` registry entries.

**Track B summary of what the operator saw in the frontend**: the parent session shows only bash tool cards (curl commands) and plain user wake messages. No child identity, no runtime/model/provider anywhere, no linkage to the child sessions sitting unlabeled in the sidebar, no watch visibility.

### Cross-cutting facts established against the code
| Fact | Evidence |
|---|---|
| `background-tasks` / `watch-wake-registrations` state is **file-only**; the pi core `AgentEvent` union has no custom-entry event → neither websocket nor broker sees launches/registrations live | `pi-agent-core/dist/types.d.ts` AgentEvent union; `subagent/background.ts` `appendEntry`; `watch-wake/index.ts` |
| Wake/completion texts arrive via `sendUserMessage({deliverAs:'followUp'})` — same rail steering uses; renders as ordinary user bubble | `subagent/background.ts` `flushNotifications`; operator confirmed seeing "some kind of card" |
| Launch card flips ✓ instantly with `agents:[]` summary → no model, no running state | `summarizeSubagentDetails` over `details.results=[]`; `SubagentToolCard` |
| **`transcript?view=screen` shows ZERO tool cards for pi sessions** (defect) | `pi-source-adapter.ts` `piSessionToReplayEvents` maps only text/thinking; verified on 2 live sessions |
| Internal-API child create carries runtime+model+selector+binding; **no parent linkage exists anywhere** | `CreateSessionRequest`/create response in `types.ts`; `RegistryEntry` has `origin` only |
| Watch truth lives server-side per child: `/root/.pi-web-ui/watches/<childSessionId>.json` (conditions, firings, snapshot) | read a real ledger file |
| Run receipts carry `sessionId, runtime, model, servedModel, status, liveness, terminalAt` — child completion detection source | read real receipts |
| **Node v24 exposes no SO_PEERCRED** (`getPeerCredentials` absent) — peer-pid correlation via socket API is NOT available | live check on this host |
| Pi bash tool subprocesses DO expose `PI_SESSION_ID`/`PI_SESSION_FILE`/`PI_PROVIDER`/`PI_MODEL` env (SDK default `exposeSessionEnvironment:true`) — usable by header convention and by the agent's own curl calls | `pi-coding-agent/dist/core/tools/bash.js` |
| The watch-wake extension calls the API **from inside the pi process** (`http.request` in `index.ts`) — for web-UI-hosted sessions the peer IS the server process; peer-env correlation cannot work there, but the extension knows its exact session (`ctx.sessionManager.getSessionId()`) | `watch-wake/index.ts` `callApi` |
| The server already receives `tool_execution_start/end` (with full command text) for every pi session — in-flight bash correlation is possible without /proc | `multi-session-manager.handleAgentEvent` |

---

## 1. Design (both tracks, one card model)

**One card identity per child, two surfaces** (goal-panel pattern):
1. **Transcript card at the dispatch point** (durable): `dispatched → running → completed/failed`; completion *updates* the same card with model + usage. Identity: background subagent = `taskId`/`runId`; Internal-API child = child `sessionId`; watch = `watchId`/registration id.
2. **Live status strip** while anything runs (ephemeral): "Children: 2 running · 1 done (msb13-fxa, g-fxb)" + "⏳ 3 watches armed" — extension-widget grammar above the input, clears when idle.

**Track A cards** (harness subagents): model from the resolved agent config at launch (`details.background.model`, extension adds it); completion usage from the persisted run record via the existing `SubagentToolSummary` shape.

**Track B cards** (Internal-API children + watches): runtime + requested selector + resolved binding from the create response; state from run receipts / watch ledger; watch cards from registrations and firings.

**Dead-man**: a plain background subagent → surfaces exactly like any Track A card, no special case (owner instruction; regression-pinned).

**Steering safety** (owner constraint): nothing touches steer/follow-up delivery, the delivery-mode strip, queued chips, or the follow-up wake messages themselves. All additions are new read-only event types + new render surfaces. The wake text remains the model-facing channel; cards are human-facing presentation.

**Parent↔child linkage (Track B) — header-first, correlation fallback, file reconstruction for replay:**
- **Primary (deterministic): explicit identity.** Optional `X-Parent-Session` header (and `CreateSessionRequest.parentSessionId?`) on Internal API requests. Sources of the header, per real call pattern: (a) the **watch-wake extension** adds it automatically — it knows `ctx.sessionManager.getSessionId()`; (b) the **orchestration skill** instructs bash-curl users to add `-H "X-Parent-Session: $PI_SESSION_ID"` (env var verified present in bash tools); (c) `agent-os` conductor may pass its lease `parentSessionId` where meaningful.
- **Fallback (automatic, no cooperation): in-flight bash-tool correlation.** Server maintains `sessionKey → active bash tool calls {toolCallId, command, startedAt}` from the event stream it already receives. On an Internal API request without the header, pick the session whose in-flight bash command references `internal-api.sock` (unique in practice; ties → newest start; none → unlinked, which is correct for conductor/cron callers).
- **Replay parity: file reconstruction.** The parent JSONL already contains everything needed — bash `toolCall` blocks with create bodies (`-d '{"runtime","model","cwd"}'`) and toolResults with `sessionId`, `watch-wake-registrations` entries, wake messages. The replay projection (session switch / `view=screen`) reconstructs Track B cards from the file without server state.
- Linkage is display-only metadata; local same-user socket, spoofing costs at most a wrong card.

**Event rails (both tracks):** browser rail via `onBrowserMessage → wsManager.broadcast` synthesising `extension_status`/`widget_content`/`widget_cleared` grammar (client already stores + replays these — MVP rendering needs zero client protocol change); Internal-API rail via `broker.publish` on the **parent's** key (pi = session path) so `/events`, snapshot mode, and durable watches observe child/watch lifecycle exactly like `goal_state`.

---

## 2. Fixed sequence (TDD per phase; each phase independently shippable; Track A phases first)

### Phase 0 — Groundwork + contract 1.34.0 (~2h)
- Bump `INTERNAL_API_CONTRACT_VERSION` → 1.34.0 (additive): new event types (`child_dispatched`, `child_turn_ended`, `watch_registered`, `watch_fired`, `background_child_state`), `parentSessionId` on create/list responses, `children` expansion, `X-Parent-Session` header.
- Shared projections: `ChildCardProjection` (identity, kind: `background_subagent|internal_api_child`, runtime, model, selector, binding, status, timestamps), `WatchCardProjection`.
- RED: capabilities fixture asserts the new types/fields.

### Phase 1 — Pi screen-view tool parity (standalone defect; smallest) (~½ day)
- `piSessionToReplayEvents`: emit `tool_execution_start` from assistant `toolCall` blocks; `tool_execution_end` from `toolResult` messages; subagent summary parity (`summarizeSubagentDetails`).
- RED: feed the real 79tower JSONL fixture → assert 3 `subagent` tool items; second fixture from `01a0688d` (Track B parent) → assert bash tool items + create-command visibility.
- Also fixes session transfer input parity. Follow-up recorded separately (§6): `/events` observer auto-attach for browser-origin sessions.

### Phase 2 — Track A: background-subagent surfacing (~1 day)
- **Extension** (`~/.pi/agent/extensions/subagent`): on launch/settle push `ctx.ui.setStatus('background-tasks', …)` + widget lines (per-child: agent, model, age); include resolved model in `details.background`; `appendEntry` stays the truth channel (reconcile already exists on `session_start`).
- **Server**: bridge background state to broker `background_child_state` by tapping the extension-UI observer (`createPiGoalEventBridge` precedent).
- **Client**: `SubagentToolCard` detects `details.background` → child-card states (dispatched/running/completed with model+usage); completion flips via widget/bridge payload; `parsePiSessionHistory` replays `background-tasks` entries to reconstruct child states at switch.
- RED: store test for `background_child_state`; card renders dispatched-not-completed; replay reconstructs a running child from fixture JSONL.

### Phase 3 — Track B, part 1: linkage + `child_dispatched`/`child_turn_ended` (~1 day)
- Server: `X-Parent-Session` header parsing (validated against registry), `CreateSessionRequest.parentSessionId?`, `RegistryEntry.parentSessionId?`, create response + list responses carry it (additive).
- In-flight bash correlation fallback: small correlator fed by `handleAgentEvent` (map sessionKey → active bash calls), consulted on requests lacking the header; unit-tested with synthetic event streams (incl. the real `api -X POST …/sessions -d …` command shape).
- **Watch-wake extension**: add the header to its `callApi` (its registrations also become `watch_registered` events — feeds Phase 4).
- Events on the **parent's broker key** + browser bridge: `child_dispatched {childSessionId, runtime, model, selector, binding, cwd}` at create; `child_turn_ended {childSessionId, runId, status, servedModel}` on child terminal (source: run receipts / agent_end observer). `GET /sessions/:id` gains additive `children` expansion (ids, status, model) for reload re-hydration and sidebar badges.
- Replay: reconstruct Track B cards from the parent file (create toolCalls/toolResults) — shares the Phase 1 adapter work.
- RED: correlation tests; publish-to-parent-key assertions; `children` expansion contract test.

### Phase 4 — Track B, part 2: watch surfacing (~½ day)
- `watch-manager`: on register → `watch_registered {watchId, sourceSessionId (parent), targetSessionId (child), conditions, label}`; on fire → `watch_fired {watchId, conditionId, firedAt, deliveryKind}` — broker (parent key) + browser bridge. Server watch ledger remains truth.
- Cards: "⏳ watch `msb13-fxa-agent_end` armed: agent_end on `01a068b0…`" → "🔔 fired → wake delivered (steer|prompt|followUp)". Replay from `watch-wake-registrations` entries + wake messages.
- `/watches/wait` long-poll and steer-wake dispatch semantics untouched (additive events only).
- RED: extend `watch-manager.test.ts` / `watch-wake-integration.test.ts` with publish assertions.

### Phase 5 — Dead-man parity pin (~1h)
- Regression test: a background dead-man-style subagent renders identically to any background subagent card (no special case, no badge). Docs note: "just a subagent" by design.

### Phase 6 — Docs + skills (canonical only) (~½ day)
- `docs/INTERNAL-API.md`, `INTERNAL-API-CONTRACT.md` (1.34.0 additions), `docs/EVENT-PIPELINE.md` (child/watch event flow), `RECENT-CHANGES.md`.
- Skills (`/root/.skills-global/skills-global`): `pi-web-ui-internal-api-orchestration` (always send `X-Parent-Session: $PI_SESSION_ID`; what the cards show), `long-horizon-waiting-strategies` (cards are presentation; wake rails unchanged; dead-man = ordinary background subagent card).

### Phase 7 — Live validation (disposable server; `pi-web-ui-live-validation` flow) (~½ day)
- **Scenario A (Track A)**: real Pi parent dispatches 3 background subagents mirroring 79tower → widget + dispatched cards live; completion flips cards with model+usage; `view=screen` shows tool items; broker carries `background_child_state`.
- **Scenario B (Track B)**: real Pi parent curls child create (muse/gemini selector like the benchmark) → header correlation via `$PI_SESSION_ID`, in-flight correlation fallback when header omitted; `child_dispatched` on parent key; browser-bridge widget; `children` expansion; child `agent_end` → `child_turn_ended`.
- **Scenario C (watches)**: `watch_wake_register` on the child → `watch_registered`; child completes → `watch_fired` + card; steer-mode wake unaffected (existing tests stay green).
- Browser render check via `webapp-testing` (children strip, card states, watch card; reload/replay parity). No production touch.

### Phase 8 — Owner-gated deploy
- Production restart (operator permission, standard pre-checks) + **agent-os contract-mirror resync chore** (constant + observability pin + mirror doc; Command Code fails closed until resync — established coupling).

**Ordering rationale**: Phase 1 unlocks honest agent-side verification of every later phase; Phases 2–4 are the two tracks in operator-felt priority; each leaves production-mergeable state.

---

## 3. Sizing & ownership

| Phase | Effort | Surfaces |
|---|---|---|
| 0 groundwork | ~2h | pi-web-ui |
| 1 screen-view parity | ~½ day | pi-web-ui |
| 2 Track A children | ~1 day | pi-web-ui + `~/.pi/agent/extensions/subagent` |
| 3 Track B linkage | ~1 day | pi-web-ui + `~/.pi/agent/extensions/watch-wake` |
| 4 watches | ~½ day | pi-web-ui |
| 5–7 parity/docs/validation | ~1 day | pi-web-ui + skills-global |
| 8 deploy | gated | — |

Total ≈ 4–5 focused days.

## 4. Risks & edge cases
- **Header trust**: display-only metadata; local same-user socket; worst case a wrong card. Correlation fallback never overrides an explicit header.
- **In-flight correlation races**: simultaneous header-less callers → newest-start wins or unlinked (safe default); header adoption via skill + extension makes the fallback rarely load-bearing.
- **Widget/status rate**: pushes only on state transitions (goal-widget precedent); broker payload bounds already enforced (flood hardening).
- **Replay truth**: `background-tasks` and `watch-wake-registrations` entries are the reconstruction sources; ephemeral widget cache never overrides them.
- **Steering regression risk**: none by construction (no steer/followUp paths touched); existing steer tests must stay green as a gate.
- **Model-drift era caveat**: the benchmark parent discovered serving-model drift (fixed by the 1.33.0 binding-durability work). `child_turn_ended` carries `servedModel` from receipts so cards stay honest.

## 5. Explicit non-goals
- No changes to wake/steer/follow-up delivery semantics (steer-wake feature as shipped).
- No special dead-man surfacing.
- No auto-attach of `/events` observers for browser-origin sessions in this plan (recorded below).
- No production restart or agent-os resync without owner permission.

## 6. Recorded follow-ups (out of scope)
- `/events` observer auto-attach for browser-origin Pi sessions (snapshot currently empty until an Internal-API touch).
- Sidebar "child of …" badges / children filter once `children` expansion exists.
- Non-Pi runtimes for Track A analogues (deferred; Pi is the orchestration surface).
