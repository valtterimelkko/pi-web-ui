# WS-Path Memory Robustness — 2026-09-05

> **Status:** EXECUTING (owner-approved in-conversation 2026-09-05: "Execute the recommended fix sequence end-to-end, use TDD and live validation… You have my permission to restart the production at the end").
> **Incident input:** `/root/pi-web-ui-oom-robustness-review-2026-09-05.md` (deep review, same day) — session `01a072e7` main-process V8 heap OOM at 19:35:25 during ONE ordinary browser turn.
> **Scope:** the minimal-complete fix sequence agreed with the owner after the review: break the causal chain (streaming amplification + unbounded transport retention + dead pre-OOM valve), one ownership-leak fix, one interruption-notice UX item, verify, ship. **Worker isolation and browser admission/receipt unification are explicitly deferred** with triggers recorded in the review.

## 0. Owner decisions already made (do not re-ask)

| # | Decision |
|---|---|
| D1 | Execute the recommended (minimal, non-over-engineered) sequence now, autonomously. |
| D2 | TDD mandatory per behaviour (RED → GREEN), full gates before ship. |
| D3 | Standard Telegram practice: milestones + one final `done`. |
| D4 | **Production restart at the end is pre-approved** (after pre-checks: activeTurns 0, zero nonterminal run receipts). Restart only `pi-web-ui.service`. |
| D5 | No Internal API contract version bump — the wire changes below are tightening within the documented contract 1.31.0 invariant ("broker is a notification bus, not a content bus; full content lives in `message_end` and `/transcript`"). agent-os mirror stays untouched. |
| D6 | No new npm dependencies. No frontend rewrite. No memory-limit changes. No archive/retention policy changes. |

## 1. Root cause recap (what this fixes)

One ordinary turn amplified into heap exhaustion through three gaps:

1. **Quadratic streaming amplification on the browser path** — `MultiSessionManager.handleAgentEvent` forwards SDK `message_update` events that carry the full accumulated message plus a nested mutable `partial` (alias of the provider's growing output). Measured: a 40 KB thinking message → 162 MB cumulative serialised traffic (~238×). The sibling `EventForwarder` path slims `message`; even it passes `assistantMessageEvent.partial` through.
2. **Unbounded transport retention** — `sendMessage` does `ws.send(JSON.stringify(...))` with no `bufferedAmount` check, no coalescing, no slow-consumer policy; global `broadcast()` likewise; direct SSE ignores `res.write()` backpressure. Bounded events × unbounded queue = unbounded heap.
3. **Dead pre-OOM valve** — `logMemoryUsage` triggers aggressive cleanup at hardcoded 2,500 MB heap, above the production `--max-old-space-size=2048` V8 limit (~2,091 MB observed). It can never fire before the OOM.
4. *(Hygiene, same ship)* **PiService ownership leak** — `unloadSession`/`disposeSession` remove the manager entry but leave strong references in `PiService.sessions` / `clientSessionMap` / `clientWebUIContexts` (probe: 30 unloads → 30 retained refs). Count-based bounds (`maxSessions=4`) understate true residency.
5. *(UX, same ship)* After a crash-restart, a session whose registry status is stuck `running` shows a silently dead turn for up to 15 minutes (stale-stream threshold) with no operator-visible explanation.

## 2. Design decisions

| # | Decision |
|---|---|
| DD1 | **One projection helper, applied at the source.** `server/src/pi/stream-transport.ts` exports `projectStreamingEventForTransport(event)`: for `message_update`, `message` → `{id?, role?, stopReason?}` and `assistantMessageEvent` → shallow copy **minus `partial`**; for `message_start`, shallow-detach `message.content` (copy array + blocks). Everything else (incl. `message_end`, `tool_*`, `agent_*`, goal/extension events) passes unchanged. Verified against the client: the background-session reducer keys on `assistantMessageEvent.type/delta` with an explicit no-id fallback for this path (`sessionStore.ts` ~L2654), and `message_start` content seeds/skill placeholders are preserved. |
| DD2 | **Three seams, one policy.** The helper is applied in (a) `handleAgentEvent` before the browser envelope wrap, (b) `normalizeEventForApi` (broker + SSE + notification observers), and (c) the `event-payload-budget` over-budget fallback (never carry `partial`). This also fixes the broker replay mutable-alias drift found in the review (cached byte counts became stale after SDK mutation). |
| DD3 | **Lossless bounded send.** New `OutboundGovernor` (`server/src/websocket/outbound-governor.ts`): per-client FIFO queue engages only while `ws.bufferedAmount > softCap` (default 4 MiB); non-coalescable messages (control/terminal/tool) always send; queued bytes cap (8 MiB) or `bufferedAmount > hardCap` (16 MiB) → close that one client with 1013 (browser auto-reconnects and re-syncs from history). Queue drains FIFO when `bufferedAmount ≤ lowWater` (256 KiB), checked opportunistically on next send and on the existing status-broadcast sweep. **Deltas are never dropped** (client recovers state only via reconnect/history, so silent gaps are worse than a clean close). |
| DD4 | **Heap-truth valve.** `EventLoopShedMonitor` gains a memory-pressure input (`observeMemoryPressure(bool)`); `isShedding` becomes lag-OR-memory. `logMemoryUsage` derives the threshold from real `v8.getHeapStatistics().heap_size_limit` (arm at 80%, disarm at 70%), replaces the dead 2,500 MB constant, arms shedding, and keeps `aggressiveCleanup()`. While shedding, browser `message_update` sends degrade to ids-only (mirrors broker DD7); terminal events unaffected. |
| DD5 | **Canonical release path.** Pure `releaseSessionRefsFrom(maps, handlerKey, sessionId)` + `PiService.releaseSessionRefs()` delegate; called from `unloadSession` and `disposeSession` (supersedes the bare `removeEventHandler` call there). |
| DD6 | **Interrupted-turn notice.** In `handleSwitchSession`/`handleSubscribeSession` (Pi path), after `subscribeClient` returns an idle status, if the registry entry still says `running`, send that client one `stale_stream_reset`-style `session_event` ("interrupted by a server restart") and update the registry status to idle. |
| DD7 | **Env knobs** (`.env.example` + `config.ts`): `WS_SEND_SOFT_CAP_BYTES` (4194304), `WS_SEND_HARD_CAP_BYTES` (16777216), `WS_SEND_PENDING_MAX_BYTES` (8388608), `WS_SEND_LOW_WATER_BYTES` (262144). |
| DD8 | **Metrics** (operational snapshot, `pipeline.*`): `wsUpdatesQueuedTotal`, `wsSlowClientsClosedTotal`, `memoryShedActive`. No new metrics framework. |

## 3. File allowlist (production code)

- NEW `server/src/pi/stream-transport.ts`
- `server/src/pi/multi-session-manager.ts` (projection seam, memory valve, release wiring)
- `server/src/pi/pi-service.ts` (releaseSessionRefs)
- NEW `server/src/websocket/outbound-governor.ts`
- `server/src/websocket/connection.ts` (governor wiring, shed path, stale-notice, broadcast guard, drain sweep)
- `server/src/internal-api/event-loop-shed.ts` (memory input)
- `server/src/internal-api/event-payload-budget.ts` (partial strip in fallback)
- `server/src/config.ts`, `.env.example` (4 knobs)
- `server/src/observability/operational-metrics.ts` (3 fields)
- Docs: `docs/EVENT-PIPELINE.md`, `docs/OBSERVABILITY.md`, `docs/INTERNAL-API.md`, `docs/TROUBLESHOOTING.md`, `DEPLOYMENT.md` (env + fix stale 6G/5G example line)

Test files: `server/tests/unit/pi/stream-transport.test.ts` (new), `server/tests/unit/websocket/outbound-governor.test.ts` (new), `server/tests/unit/pi/pi-service-release.test.ts` (new), `server/tests/integration/ws-flood.wedge.test.ts` (new), plus focused extensions to `multi-session-manager.test.ts` and `event-payload-budget.test.ts`.

Anything outside this list = stop-and-note in the final report rather than silent scope growth.

## 4. Execution order (TDD)

1. **F1 projection** — RED: stream-transport unit + manager browser-wire + `normalizeEventForApi` assertions → GREEN.
2. **F7 flood gate (RED on slow-consumer assertions)** — `ws-flood.wedge.test.ts`: real `MultiSessionManager` + governor-wrapped fake clients (one fast, one pinned-slow), growing thinking stream; assert fast client byte-total ≈ linear (< 2 MB for the incident shape), slow client closed after caps, terminal events delivered, RSS growth < 50 MB, health endpoint responsive throughout. (Byte assertions already pass after F1; the slow-client/queue assertions stay RED until F2.)
3. **F2 governor** — RED unit (queue/flush/close semantics) → GREEN; wire `sendMessage`/`broadcast` + drain sweep.
4. **F3 heap valve** — RED (shed arming via injected stats; threshold derived from limit) → GREEN.
5. **F4 release** — RED (maps cleared; manager calls release) → GREEN.
6. **F5 stale notice** — RED → GREEN.
7. **F6 metrics** — RED (snapshot fields) → GREEN.
8. Full gates: `npm run lint && npm run typecheck && npm run build && npm test` (+ client/shared workspaces).
9. Docs + `.env.example`.
10. **Disposable live validation** vs real Pi runtime (`zai/glm-5.3`, long-thinking turn): `/events` stream shows slim `message_update` (no `partial`, bounded size), `message_end` full fidelity, transcript complete, health responsive; existing smoke scenarios still pass.
11. Telegram milestone → **production restart** (D4): pre-checks (`/capacity` activeTurns 0, zero nonterminal receipts), `systemctl restart pi-web-ui.service`, verify `/capabilities` (contract unchanged 1.34.0), `/health`, memory log line with heap limit, clean journal; observe.
12. Agent OS captures (pending only), board leave, final Telegram `done`.

## 5. Preservation matrix (regression gates)

| Workload | Must remain true |
|---|---|
| Ordinary streaming turn | Live text/thinking deltas arrive in order; `message_end` carries the complete message; transcript/history unchanged; skill-loaded placeholder still renders (message_start content preserved). |
| Slow/hidden tab | Queue drains FIFO on recovery; a truly stuck socket is closed once, client reconnects and re-syncs from history; **the agent turn never aborts due to observer state**. |
| Multiple clients | Fast client unaffected by slow sibling; per-client isolation. |
| Shed mode (lag or heap) | Updates degrade to ids-only; terminal/tool/goal events unaffected; auto-recover with logs. |
| Session churn | ALL owning maps (manager + PiService) return to baseline after unload/dispose. |
| Post-crash reload | Stale `running` registry status surfaced as one immediate notice, then corrected. |
| Broker/SSE consumers | Watch sentinels (delta-based), notification tails, screen view, agent-os reads — all delta-based; over-budget fallback never carries `partial`. |
| Other runtimes | Claude/OpenCode/Antigravity/Command Code paths untouched. |

Rollback: revert the commit(s); no data migrations, no contract changes, no config removals (knobs default on).
