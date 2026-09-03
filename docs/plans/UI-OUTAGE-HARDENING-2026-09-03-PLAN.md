# Plan: 2026-09-03 UI Outage — Event-Broker Flood Hardening (pi-web-ui) + CSRF Lifecycle Fix (tmux-web-ui)

> **Status:** PLANNED — not started. Awaiting explicit owner go before execution ("I will later ask you to execute it", 2026-09-03).
> **Incident analysis (input):** `/root/slow-ui-root-causes-2026-09-03.md` (on-the-day forensics) + the deep re-analysis of 2026-09-03 (this session; two corrections to the on-the-day doc are recorded in §1.3 and are load-bearing).
> **Repos touched:** `pi-web-ui` (primary, this repo), `tmux-web-ui` (`/root/tmux`, Phase 6), `agent-os` (mirror resync only, Phase 7, owner-gated).
> **Contract:** Internal API `1.30.0` → **`1.31.0`** (allocated to this plan; see D2).
> **Created:** 2026-09-03 · **Size:** ~1–1.5 working days for Phases 0–6; Phase 7 is owner-gated ops.

---

## 0. Owner decisions already made (do not re-ask)

| # | Decision |
|---|---|
| D1 | **No execution before owner go.** This plan is committed for future execution; a later explicit "execute it" from the owner starts Phase 0. |
| D2 | **Contract 1.31.0 is allocated to this plan.** Repo is at `1.30.0` (`server/src/internal-api/types.ts:75`); `1.31.0` is the next free version (steer-wake holds no reservation; goal function took 1.27.0, discovery took 1.30.0). |
| D3 | **Scope** = pi-web-ui broker/server hardening (Phases 0–5), tmux-web-ui CSRF + UX (Phase 6), owner-gated ops incl. agent-os mirror resync and production restarts (Phase 7). Agent-OS child-loop policy (Phase 8) is **optional and separately decided**. |
| D4 | **Owner-gated actions** (pause and ask, never do silently): production restart of `pi-web-ui` or `tmux-web-ui`; agent-os mirror resync; any systemd unit edit (`/etc/systemd/system/*.service`, timers); writing `CSRF_SECRET` into `/root/tmux/.env.production`. **Never** touch the Caddyfile or Authelia config — report-only per SYSTEM_MAP §0. |
| D5 | **TDD mandatory** (RED → GREEN per behaviour), plus the integration flood gate (§6) must pass before any deploy step. Live validation per repo convention (`docs/LIVE-VALIDATION.md`). |
| D6 | The **websocket event-forwarder path is NOT modified** — it already slims `message_update` correctly (`server/src/pi/event-forwarder.ts:295-302`). This plan aligns the Internal API broker path with that existing policy. |

---

## 1. Incident summary and evidence (self-contained)

### 1.1 Timeline (2026-09-02 → 2026-09-03, UTC)

1. **11:13** — `tmux-web-ui.service` restarts (routine). In-memory CSRF store wipes; every browser tab now holds a valid 30-day JWT cookie + a dead CSRF token.
2. **23:13** — supervisor session `01a06232` (cwd `/root/pi-web-ui`) dispatches the Agent OS usage-study phase-2 child `01a06465` via the Internal API on `zai/glm-5.3-flash`, with passive watches + dead-man timers.
3. **23:13–23:19** — child turn 1 goes degenerate: the model emits **one assistant message with 9,310 content blocks** (nearly all tiny `toolCall` edit blocks). Session file line 101 = **1,048,877 bytes**, `stopReason: "length"` (output-token cap). During streaming, every `message_update` event carries the full accumulated partial message (`normalizeEventForApi` copies `data.message` wholesale), so each broker event grows toward **~2.9 MB**.
4. Every publish `JSON.stringify`s the full event for replay-buffer byte accounting (`event-broker.ts:126`), re-stringifies **every evicted buffer entry** (lines 127–128; buffer 100 events / 8 MB — `routes/sessions.ts:491`), and the live subscriber (the supervisor's own watch on the child, `watch-manager.ts:289`) stringifies again via SSE (`sse-stream.ts:62`).
5. Main thread pegged at 100% in `publish` (94.5% of 16,287 profiler samples); no HTTP served on `:3456`; Recv-Q backlog grows. Public URL stays fast because **Authelia's forward-auth 302 answers before the wedged backend** — the failure is invisible to all public monitoring.
6. The mega-message ends at the output-token cap; from **~00:21** zai starts returning 500s, the child stops emitting events, and **the wedge clears itself**. The child then sits ~4 h in a provider-500 retry loop (~20 consecutive errors, no circuit breaker); at **04:23** the operator manually freezes the supervision loop.

### 1.2 Verified mechanics (code + logs, checked 2026-09-03)

| Fact | Evidence |
|---|---|
| Broker stringify hotspot | `server/src/internal-api/event-broker.ts:126-128` — one full `JSON.stringify(event)` per publish for accounting **plus** one per evicted entry during both trims |
| Replay buffer config | `server/src/internal-api/routes/sessions.ts:491` (`replayBufferSize: 100`), default max bytes 8 MB (`event-broker.ts:39`) |
| Full snapshot on the broker path | `server/src/pi/multi-session-manager.ts:898-933` `normalizeEventForApi` copies `data.message` + `assistantMessageEvent` wholesale |
| Websocket path already slim | `server/src/pi/event-forwarder.ts:295-302` — `message_update` forwarded as `{message:{id}}` + delta only. **Two divergent policies; the unbounded one is the one that wedged.** |
| SSE re-stringify per subscriber | `server/src/internal-api/sse-stream.ts:59-63` |
| The single subscriber was the supervisor's watch | `server/src/internal-api/watch/watch-manager.ts:289` (class `'watch'`) — the control plane was subscribed to the thing that killed it |
| Degenerate mega-message | phase-2 session line 101: 9,310 blocks, `stopReason:"length"`; provider `zai/glm-5.3-flash` |
| Provider 500 loop | session tail: ~20 consecutive `500 {"code":"1234"...}` messages, 00:21→04:31 |
| tmux CSRF lifecycle split-brain | `/root/tmux/server/src/security/csrf.ts:9-11` (module-level in-memory `Map`, 1 h TTL) vs `routes/auth.ts:31` (JWT cookie 30 d); client self-heal exists (fix `123549d`, `MAX_CSRF_RETRIES=3` via `/api/auth/me`) but gives up silently → endless "connecting" |

### 1.3 Corrections to the on-the-day analysis (load-bearing)

1. **pi-web-ui was never restarted.** Service up continuously since 2026-09-02 11:27 UTC (verified `systemctl status` on 2026-09-03 04:59, 17 h uptime, `/health` 200 in 17 ms). The wedge ended when the flood source died — **recovery was luck, not remediation**. The prescribed `systemctl restart` never happened.
2. **The megabytes were the assistant's own streaming message** accumulating 9,310 tool-call blocks — a model-behaviour pathology — **not tool output** (the largest tool result in the session was 37 KB). This locates the fix: bound the *streaming snapshot*, which is inherently redundant (deltas + `message_end` + `/transcript` already carry the content).

### 1.4 Shared meta-root-causes

- **Unbounded work and unbounded in-memory state on a single-threaded main loop, with no backpressure anywhere** (broker will stringify arbitrarily large events at arbitrary rates; CSRF store lives and dies with the process).
- **Nothing observes these services from outside** (Authelia 302 masks a dead backend; no localhost health probe; no watchdog for up-but-dead).

---

## 2. Design decisions (canonical for this plan)

| # | Decision |
|---|---|
| DD1 | **The broker is a notification bus, not a content bus.** Broker events are bounded; full content lives in `message_end` events and `/transcript`. This becomes a documented invariant in `docs/INTERNAL-API.md`. |
| DD2 | **Payload budget enforced at a single choke point: `InternalApiEventBroker.publish`.** Not in per-runtime normalisation — this covers every publisher (Pi, Claude, OpenCode, Command Code, synthetic) and future ones. |
| DD3 | **Budget default 256 KiB**, env `INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES` (`0` disables; parsed in `server/src/config.ts` alongside the other `INTERNAL_API_*` vars). Applies to the *serialised* event. |
| DD4 | **Slimming shape for `message_update`** (mirrors the websocket policy): `data.message` reduced to `{ id, stopReason?, role? }`; `data.assistantMessageEvent` delta retained if the event still fits the budget (else the delta's largest text field is cut with an inline `…[truncated]` marker); `data.payloadTruncated = { originalBytes, budgetBytes }` added when trimming occurred. All other oversized events: deep-truncate the largest string fields (`result`, `args`, text blocks) with the same `payloadTruncated` marker. Nothing is silently dropped. |
| DD5 | **One `JSON.stringify` per publish, ever.** The single serialisation (needed once for size measurement) is cached with the buffer entry; evictions subtract cached numbers — no re-stringify on trim, ever. |
| DD6 | **Per-session rate guard + `message_update` coalescing.** Token bucket default 200 events/s (burst 400), env `INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC`. When exceeded, intermediate `message_update` snapshots are dropped (last-writer-wins is safe — they are snapshots of the same growing message) and the next delivered update carries `data.coalescedDeltas: <count>`. **Never** drop `message_start` / `message_end` / `tool_*` / `agent_start` / `agent_end` / `error` / goal events. |
| DD7 | **Event-loop-lag shed mode.** A cheap drift probe (`setInterval(500 ms)` measuring scheduling lag) arms SHED when lag > 1 s: while shedding, `message_update` events are delivered ids-only (no delta) regardless of size; disarms after lag < 250 ms sustained 10 s. WARN log + metric on both transitions. This converts "wedge" into "degraded streaming with a live control plane". |
| DD8 | **Contract 1.31.0 + capability flag** `supportsEventPayloadBudget: true` on `/api/v1/capabilities` (alongside `supportsGoal`, `routes/capabilities.ts`), changelog entry in `docs/INTERNAL-API-CONTRACT.md`. |
| DD9 | **tmux-web-ui CSRF goes stateless**: `csrfToken = base64url(HMAC-SHA256(jwtString, CSRF_SECRET))`, validated by recomputation (timing-safe) — no store, restart-proof, token lifetime == JWT lifetime. Transition release accepts derived **or** legacy store token; store removed the release after. |
| DD10 | **Watchdog, not restart-by-default.** pi-web-ui systemd unit gains `Type=notify` + `WatchdogSec=45` + an sd-notify pinger (a starved loop stops pinging → systemd restarts; `Restart=always` already exists for crashes). A localhost health-probe timer **alerts only** by default; auto-restart on repeated probe failure is a separate owner decision, default OFF. |

---

## 3. Goals / non-goals

**Goals**
1. No single session — however pathological its event stream — can starve the pi-web-ui main thread or degrade the Internal API control plane.
2. The replay-buffer byte cap costs O(1) serialisation per event.
3. A wedged-but-alive process self-recovers (watchdog) and is detected externally (probe).
4. tmux-web-ui survives restarts without CSRF split-brain, and surfaces auth failures instead of an endless spinner.
5. A deterministic regression gate (flood test) locks all of this in.

**Non-goals / deliberately deferred**
- Worker-thread isolation of event fan-out (the `server/src/workers/event-normalizer.ts` precedent exists; deferred — DD2–DD7 remove the starvation pressure that makes it urgent).
- Any change to the browser websocket event path (D6), to the Pi SDK itself, or to Caddy/Authelia (D4, report-only).
- Model-side caps in Agent OS policy (Phase 8, optional, separate decision).

---

## 4. Execution plan

> Conventions: every phase lists **RED tests first** (names + file), then the implementation, then its **gate**. Run `npm run lint && npm run typecheck && npm test` per phase; commit per phase on the current branch; no new branches.

### Phase 0 — Groundwork & contract (½ h)

**Intent:** config + contract surface before behaviour.

- RED: `server/tests/unit/internal-api/event-payload-config.test.ts`
  - `INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES` parses, clamps to ≥ 0, defaults 262144; `INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC` default 200.
- Change `INTERNAL_API_CONTRACT_VERSION` → `'1.31.0'` (`server/src/internal-api/types.ts:75`).
- Add `supportsEventPayloadBudget: true` to capabilities (`routes/capabilities.ts`).
- RED→GREEN: capabilities test asserting the flag and version string.
- **Gate:** suites green; contract bump visible on a disposable server's `/capabilities`.

### Phase 1 — Broker payload budget (the primary fix) (2 h)

**Intent:** DD2–DD4 at the choke point.

- **First, run the consumer audit** (§5): confirm no in-repo broker subscriber depends on full `message_update` snapshots. If one does, route it to `message_end`/`/transcript` in the same phase.
- New module `server/src/internal-api/event-payload-budget.ts`: `measureAndSlim(event, budget)` → `{ event, bytes, truncated, originalBytes }`.
- RED tests (`server/tests/unit/internal-api/event-payload-budget.test.ts`):
  - a 2.9 MB `message_update` yields an event ≤ budget with `data.message = {id, stopReason}` + `payloadTruncated.originalBytes ≈ 2.9M`; delta preserved when small.
  - oversized `tool_execution_end.result` deep-truncated with marker; small events pass through byte-identical; `budget: 0` disables.
- Wire into `InternalApiEventBroker.publish` (single serialisation, shared with Phase 2).
- RED→GREEN in `server/tests/unit/internal-api/event-broker.test.ts`: subscribers receive the slimmed event; buffer stores slimmed form; `payloadTruncated` observable on replay.
- WARN log once per session for the first over-budget event (type + bytes).
- **Gate:** unit + integration suites green; flood integration test (Phase 5 RED) now passes for health latency; live disposable check: `/events` stream from a real oversized turn shows the marker and stays responsive.

### Phase 2 — Cached replay-buffer sizes (1 h)

**Intent:** DD5 — the byte cap's enforcement must never be the weapon.

- RED (`event-broker.test.ts`): after N oversized publishes, `replayBufferBytes` equals the sum of cached entry sizes (accounting exact), buffer holds only ≤ cap bytes, and — perf guard — 200 publishes of 100 KB events complete in < 2 s (assert wall time; fails on the old re-stringify implementation).
- Refactor: buffer entries become `{ event, bytes }` (or a parallel sizes array); eviction subtracts cached numbers; `getRecentEvents` unwraps. No `JSON.stringify` inside any trim loop (assert via code review + perf guard).
- **Gate:** perf guard green on old code would fail (verify RED first by running the new test against the pre-phase broker), then green.

### Phase 3 — Rate guard + `message_update` coalescing (1 h)

**Intent:** DD6 — bound publish rate per session regardless of payload size.

- RED (`event-broker.test.ts`):
  - 1,000 `message_update` events in one tick → subscribers see ≤ rate-limit count, the last snapshot delivered, `coalescedDeltas` = dropped count, **all** non-`message_update` events still delivered (never dropped).
  - bucket refills over time.
- Implementation: per-session token bucket in the broker; only `message_update` is coalescible; counters into metrics.
- **Gate:** unit green; no behavioural change for ordinary sessions (existing suites untouched).

### Phase 4 — Event-loop-lag shed + metrics (1 h)

**Intent:** DD7 + observability.

- RED: `server/tests/unit/internal-api/event-loop-shed.test.ts` — lag probe arms/disarms shed; while shedding, `message_update` delivered ids-only; other events unaffected; WARN logged once per transition.
- Metrics (`server/src/observability/operational-metrics.ts`): counters `brokerPublishBytesTotal`, `brokerEventsTruncatedTotal`, `brokerEventsCoalescedTotal`; gauge `eventLoopLagMs`; surfaced in `/diagnostics` payload per existing observability conventions.
- **Gate:** unit green; `/diagnostics` on a disposable server shows the new fields.

### Phase 5 — Flood regression gate + docs (2 h)

**Intent:** the deterministic proof that the incident class is closed, and the canonical docs.

- RED first, then GREEN with Phases 1–4: `server/tests/integration/broker-flood.wedge.test.ts`
  - in-process server; drive `broker.publish` with 200 × ~2.9 MB `message_update` events (synthetic, shaped like the incident) plus a normal-sized interleaved control event stream;
  - assert **throughout**: `/api/v1/health` responds < 500 ms; session list < 1 s; RSS growth < 100 MB; replay buffer bytes ≤ cap; delivered events ≤ budget with markers; control events (message_end, agent_end) never dropped.
  - This test must be demonstrated RED against pre-Phase-1 code (timing assertion fails / server unresponsive) — record that evidence in the commit message.
- Live validation (`docs/LIVE-VALIDATION.md` conventions): disposable server + real Pi session producing an oversized turn (long output); assert `/events` stays live, truncation marker observed, `message_end` still carries full content, `/transcript` unaffected.
- Docs (canonical-only rule):
  - `docs/INTERNAL-API.md`: the DD1 invariant + `payloadTruncated`/`coalescedDeltas` semantics + budget/rate env vars.
  - `docs/INTERNAL-API-CONTRACT.md`: 1.31.0 changelog.
  - `docs/EVENT-PIPELINE.md` + `docs/OBSERVABILITY.md`: new counters/gauge, shed mode.
  - `docs/TROUBLESHOOTING.md`: "UI unresponsive / backend wedged" runbook entry (check `eventLoopLagMs`, truncation counters, journal watchdog reboots).
  - Skills (canonical source only, `/root/.skills-global/skills-global`): note the bounded-broker invariant in `pi-web-ui-internal-api-orchestration` **only if** its current text contradicts it (check first; link, don't duplicate).
- **Gate:** all suites + flood test green; live validation pass logged.

### Phase 6 — tmux-web-ui: stateless CSRF + surfaced auth state (2–3 h, separate repo `/root/tmux`)

> Follow `/root/tmux/AGENTS.md` non-negotiables (server managed only via `scripts/`, `process.title='tmux-web-ui-server'`, never touch pi-web-ui's process).

- RED (`server/src/__tests__/csrf.test.ts` rewrite):
  - derived token validates for a valid JWT and the same token; wrong token fails; expired JWT ⇒ derived token invalid; **legacy store token still accepted** (transition); restart-simulation (new module state) does not invalidate derived tokens.
- Implementation: `csrf.ts` → `deriveCsrfToken(jwt, secret)`, `validateCsrfToken(jwt, provided)`; `CSRF_SECRET` env (read via existing config path); login + `/api/auth/me` return the derived token; keep timing-safe compare.
- Client: render the attach `error` state distinctly — "Session token expired — Reconnect" action that calls `/api/auth/me` and retries once (`client/src/hooks/useAttach.ts` error path + the terminal-area component that currently shows an ambiguous spinner).
- E2E (playwright): mid-suite `server:restart` → attach self-heals without re-login; forced-stale-token attach → banner appears, reconnect works.
- Docs: `/root/tmux/CHANGELOG.md`, `docs/RUNBOOK.md` ("restarts no longer invalidate CSRF"), `SECURITY.md` note on the HMAC double-submit scheme.
- **Gate:** tmux suites + e2e green; manual restart test via scripts.

### Phase 7 — Owner-gated ops (pause and ask before each)

1. **systemd watchdog (pi-web-ui):** add `Type=notify` + `WatchdogSec=45` to the unit (edit live unit + `deploy/` source-of-truth copy if present); sd-notify pinger in server startup (unref'd 10 s interval). Requires owner approval for the unit edit; verify with `systemdctl show -p WatchdogUSec` and a deliberate block test on a disposable instance.
2. **Health-probe timer:** `scripts/health-probe.sh` (curl `127.0.0.1:3456/api/v1/health`, works unauthenticated from localhost — verified 200/17 ms during analysis) + systemd timer every minute, alert-only (journal WARN + optional Telegram via the existing notifications path). Auto-restart on repeated failure: separate owner decision, default OFF.
3. **Production restart pi-web-ui** (contract 1.31.0 live): owner permission + pre-checks (activeTurns 0, zero nonterminal run receipts) per established practice.
4. **agent-os mirror resync to 1.31.0**: `client.ts` constant + observability pin + `PI-WEB-UI-INTERNAL-API-CONTRACT.md` mirror — owner-gated; Command Code creation fails closed until done (known coupling).
5. **tmux-web-ui production deploy:** write `CSRF_SECRET` to `/root/tmux/.env.production` (generate), `systemctl restart tmux-web-ui`, verify attach self-heals on a live tab.
6. Optional: same watchdog pattern for `tmux-web-ui.service`.

### Phase 8 — Optional, separate owner decision: Agent OS child-loop robustness

Not part of this plan's execution without an explicit go. Recorded so it is not lost:
- provider-500 circuit breaker: N consecutive provider errors ⇒ auto-park + owner notification (the 4 h zai outage was handled manually with dead-man timers);
- per-turn tool-call/output-shape guidance for dispatched children (the 9,310-block mega-turn and the "batch all 7 repos in one turn" prompt shape both encouraged single mega-outputs).
Executed in the agent-os repo under its own policies; nothing in pi-web-ui blocks on it.

---

## 5. Consumer-compatibility audit (Phase 1, first task)

Verify each in-repo broker subscriber is snapshot-independent; fix any that are not, in Phase 1:

| Consumer | Location | Expected dependency | Action |
|---|---|---|---|
| SSE `/events` | `routes/sessions.ts:4700` | external consumers | document DD1; check agent-os watch consumers |
| WatchManager handler | `watch/watch-manager.ts:289` | type/`agent_end` + text sentinels over **deltas** | confirm sentinels read `assistantMessageEvent` text, not `data.message.content` |
| NotificationManager | `notifications/notification-manager.ts:500` | `agent_end` only | confirm |
| Goal bridge | `routes/sessions.ts` (extension-UI observer) | separate observer path, not the broker | none |
| Client screen view | `shared/src/screen-view.ts` | builds from deltas | none |

External consumers (agent-os) read transcripts and the watch ledger, not raw broker payloads — confirmed during analysis; re-verify at execution time.

---

## 6. Validation plan (summary gate)

- **Per phase:** `npm run lint && npm run typecheck && npm test` (pi-web-ui); tmux equivalents in `/root/tmux`.
- **Flood gate** (must-pass before any Phase 7 step): `server/tests/integration/broker-flood.wedge.test.ts` per Phase 5, demonstrated RED on pre-fix code.
- **Live validation:** disposable server, real Pi runtime, oversized turn: `/events` responsive throughout, marker observed, `message_end`/`/transcript` full-fidelity.
- **tmux e2e:** restart-mid-attach self-heal; stale-token banner.
- **Production post-checks (Phase 7):** `/capabilities` shows 1.31.0 + flag; `/diagnostics` shows new counters; watchdog `WatchdogUSec` set; probe timer journal clean.

## 7. Risks and honest limits

- **Subscriber breakage:** any undiscovered consumer of full `message_update` snapshots breaks loudly (marker present, content absent) — the audit (§5) plus the marker make this discoverable, and `/transcript` is the fallback. Wire-visible ⇒ contract bump + mirror resync, both handled.
- **Budget vs UX:** ids-only shedding during lag degrades streaming UX briefly by design; recovery is automatic and logged.
- **Perf-guard flakiness:** the Phase 2 wall-time assertion needs a generous CI margin (assert order-of-magnitude, not exact).
- **CSRF transition:** one release window accepts both token kinds; the store removal must land before the legacy path is deleted.
- **Watchdog:** `Type=notify` changes unit semantics; test on a disposable unit first; a buggy pinger causes restart loops — pinger must be trivial and unref'd.
- **Honest limit:** this plan makes one bad session unable to wedge the server; it does not isolate a genuinely CPU-hungry runtime (deferred worker-thread work), and it cannot fix Authelia's public 302 masking by itself — the probe timer (Phase 7.2) is the detection half.

## 8. Completion checklist

- [ ] Phase 0–5 committed & pushed (pi-web-ui), contract 1.31.0, flood gate RED evidence recorded
- [ ] Phase 6 committed & pushed (tmux-web-ui), e2e green
- [ ] Docs updated (INTERNAL-API, CONTRACT, EVENT-PIPELINE, OBSERVABILITY, TROUBLESHOOTING; tmux RUNBOOK/SECURITY/CHANGELOG)
- [ ] Phase 7 each item owner-approved, executed, verified; production at 1.31.0; agent-os mirror resynced; probe + watchdog live
- [ ] Agent OS capture of outcomes filed; this plan's status header updated to EXECUTED with commit range

## 9. Evidence index

- On-the-day forensics: `/root/slow-ui-root-causes-2026-09-03.md`
- Deep re-analysis session (corrections, verification): pi-web-ui session `01a06232` (2026-09-02/03), this plan's §1.3
- Runaway child session: `--root-agentos-usage-study-phase2-research--/2026-09-02T23-13-17-516Z_01a06465-f0cc-723c-8afb-8e2766b51647.jsonl` (line 101 = the 1 MB mega-message; tail = zai 500 loop)
- pi-web-ui service uptime proof at analysis time: active since 2026-09-02 11:27:57 UTC (never restarted through the incident)
- Code anchors: `event-broker.ts:107-128` · `routes/sessions.ts:491` · `multi-session-manager.ts:898-933` · `event-forwarder.ts:295-302` · `sse-stream.ts:59-63` · `watch-manager.ts:289` · `/root/tmux/server/src/security/csrf.ts` · `/root/tmux/server/src/routes/auth.ts:31`
