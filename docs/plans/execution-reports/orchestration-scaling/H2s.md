# H2s — Server: busy goal-start answers promptly; budget pause reason visible; chain-depth race closed

Step H2 of the R4 follow-up wave (orchestration-scaling plan; H2 *Root causes* items 6–7 and the I2 residual). Lane branch `orch/h2s`, worktree `/root/.worktrees/orch-scaling/h2s-pi-web-ui`, from baseline `aeef536f`. Executed by two children: the lane's first child (Gemini route, criteria 3 + 2 investigation) and its continuation (GLM route, criteria 1 + 2 commit + gates + live proof).

## What changed

1. **Busy goal start no longer holds the HTTP response** (`server/src/internal-api/routes/sessions.ts`, `handleSessionGoalControl`). Previously the route awaited the composed `/goal …` command through the whole prompt pipeline; on a busy session the command rides the running turn as an attached slash pass-through and the engine's start handler awaits `waitForIdle()` before its first goal run — so the POST held for the entire busy turn (wave 3 observed ~38 min). Now, for `action: "start"` on a busy Pi session, the route dispatches the same composed command through the same attached pipeline **fire-and-forget** (`.catch` + error log) and answers at once with the historical accepted shape: `accepted: true`, `receipt: null` (the inner run belongs to the detached-from-response dispatch; the shape already allowed null), `goal` = projection read at response time. The engine persists the goal file at the command boundary, so the goal still starts when the session settles; callers poll `GET /sessions/:id/goal` or watch `goal_state`/`goal_end`. A **compacting** session is still refused synchronously with 409 `SESSION_BUSY` (a `piBusyRefusal` pre-check mirrors the blocking path's forwarded refusal) — a start is never accepted-then-lost. Pause/resume/clear keep the pre-1.58.2 blocking behaviour (pause's mid-run usability depends on executing at the command boundary and returning).

2. **Budget pause reason pass-through pinned** (`server/tests/unit/internal-api/goal/goal-projection.test.ts`). The projection (`canonicalPiStatus`) already passes any non-empty engine-recorded `gs.pauseReason` through as `pausedReason` — no projection change. The engine change (set `gs.pauseReason = "budget"` in `recordGoalSpend`) lives in lane H2g (`/root/pi-enhancement` `cbd8782`, merged `8d25a72`; asked for by this lane's `01-question.md`, ordered into H2g by the parent's correction). The committed test pins the pass-through only; two earlier draft tests that derived `"budget"` from spend figures were **deliberately dropped** (a second source of truth would mask an engine that failed to record its reason).

3. **I2 residual: `queuedPiChainDepth` race closed** (lane's first child, commit `7c523faa`). The reviewer's code-derived edge: the depth counter was deleted when a correlation queue emptied while an old chain could still owe events, so a follow-up accepted in that lag window under-counted depth. Now the depth is preserved while chained events are pending. Test K proves it (RED → GREEN receipt below, re-verified GREEN by the continuation).

**Contract 1.58.2** (patch, inside the C6 stability window): response timing and receipt nullability only — no new route, field, error code, event or default. The client snapshot changes by exactly one line (`contractVersion`); the stability-window fingerprint is unchanged (guard test green). Pins that track the version moved with it (`capabilities.test.ts`, `command-code-contract.test.ts`).

## TDD (strict)

| Behaviour | Test | RED | GREEN |
|---|---|---|---|
| Busy goal start answers promptly | `goal-routes.test.ts` "contract 1.58.2: a goal start on a BUSY session answers promptly…" | `npx vitest run tests/unit/internal-api/goal/goal-routes.test.ts -t "BUSY session"` → exit 1 — `vi.waitFor` timed out: `res.body` stayed `undefined` (the response was never written while the busy turn ran — the defect itself) | same file, full run → exit 0, `Tests 39 passed (39)` |
| Compaction refusal stays synchronous | `goal-routes.test.ts` "a compacting session refuses a busy goal start synchronously…" | passed **before** the fix (pins the blocking path's forwarded refusal; guards the new early path) | included in the 39 |
| Budget pauseReason pass-through | `goal-projection.test.ts` "paused: pauseReason recorded by engine (e.g. \"budget\") is preserved" | n/a by design — pin of existing pass-through (engine RED/GREEN is H2g's `cbd8782`) | `npx vitest run tests/unit/internal-api/goal/goal-projection.test.ts` → exit 0, `Tests 19 passed (19)` |
| queuedPiChainDepth preserved (I2 residual) | `session-routes-follow-up-coalescing.test.ts` "K. queuedPiChainDepth is not wiped on queue empty while an old chain owes events" | RED recorded by the lane's first child (test K failed at `7c523faa`^) | re-run by the continuation: `-t "K\."` → exit 0, `Tests 1 passed \| 10 skipped (11)` |

Vitest environment for every suite run: `env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test`, inside a `systemd-run --scope` memory cap.

## Gates (from the worktree, at `44a4b14d`)

| Command | Exit | Evidence |
|---|---|---|
| `npm run lint` | 0 | `304 problems (0 errors, 304 warnings)` (pre-existing warnings) |
| `npm run lint:ratchet` | 0 | `warnings: 319, ceiling: 326, violations: []` |
| `npm run typecheck` | 0 | clean |
| `npm run build` | 0 | client + server build clean (freshness: no `server/src` file newer than `server/dist/index.js`) |
| full server unit suite, 1st run | 1 | `2 failed \| 6171 passed` — both failures were the contract-version pins (below) |
| `capabilities.test.ts` + `command-code-contract.test.ts` after pin update | 0 | `Tests 14 passed (14)` |
| **full server unit suite, re-run** | **0** | **`Test Files 508 passed (508)`, `Tests 6173 passed \| 3 skipped (6176)`** |
| `npm run docs:check-links` | 0 | `OK: 1336 internal link(s) resolve across 347 Markdown files` |
| `npm run docs:check-agent-guides` | 0 | `AGENTS.md and CLAUDE.md are byte-identical` |
| contract guards | 0 | `contract-stability-window.test.ts` 18 + `client-snapshot-drift.test.ts` 7 — snapshot matches generation at 1.58.2, fingerprint unchanged |

## Live validation (disposable server, GLM 5.3 Flash, approved route only)

Server: `npm run validate:server -- --dir /tmp/h2s-live-20261001T1940Z/val --compiled` under `systemd-run --scope` (`h2s-live-srv.scope`, `MemoryMax=12G MemorySwapMax=1G CPUQuota=400%`). Build commit `44a4b14d`, compiled mode, `/health` reported `contractVersion: "1.58.2"`, pi available. Isolation: `PI_AGENT_DIR`=`PI_CODING_AGENT_DIR` = run-private agent dir holding the **real extension set as byte-identical dereferenced copies**, with the goal engine overlaid byte-identical to `/root/pi-enhancement` `8d25a72` (H2g merge; `sha256(auto-continue.ts)` = `af6f7701…` on both sides); `auth.json` filtered to the `zai` entry only, `models.json` filtered to the `zai` provider only; fake `HOME`; `agent-os` PATH stub + `AGENT_OS_BIN` stub (stub log confirms every call intercepted; outcomes `empty`/`pointer`, no real vault or board writes; `BOARD_STORE_DIR` empty after the run); `AGENT_OS_VAULT_ROOT`, `PI_WEB_UI_GOAL_HOME`, `PI_BG_TASKS_DIR`, `PI_COMPACTION_LOG`, watch-wake socket/token all pointed inside the run dir; `NOTIFICATIONS_DIR` isolated by the validation wrapper. Driver: `driver.sh` (curl over the validation unix socket), receipts in `val/run-receipts/`, transcripts in `val/pi-sessions/`.

Load claims: build revision `44a4b14d`; peak **1** concurrent active turn at every sampled state (14 samples across the run, staggered sessions); 3 live children total.

| # | Session | Pattern | Measurement (UTC) |
|---|---|---|---|
| P | `01a0f905` plain | plain prompt turn | Created 19:51:00, `modelBinding.resolved: "zai/glm-5.3-flash"`, `fallbackApplied: false`. Busy turn (`sleep 90`) ran **99.82 s** (receipt `d313e1d4`, `terminal_signal` 19:52:40.445). **Timed goal start mid-turn at 19:51:12: HTTP 200 in 0.0076 s**, body `{"action":"start","accepted":true,"receipt":null,"goal":{"supported":true,"status":"idle"}}`. Goal ran after the turn settled: poll 1 at 19:52:51 (11 s after turn end) = **`achieved`, runs 1**, spend `inputTokens: 6007`. |
| R | `01a0f906` realistic | goal-armed at create, `budgetTokens: 3000`, fresh cwd, real extension set | Created 19:53:00, resolved `zai/glm-5.3-flash`. Polls: running → **paused at 19:53:12 with `pausedReason: "budget"`, `lastReason: "budget"`, spend `inputTokens: 5876` ≥ budget `3000`** — the 2026-10-01 null-reason defect, now visible end-to-end (engine `cbd8782` records it; this lane's projection pass-through surfaces it). |
| Q | `01a0f907` realistic | goal-armed at create (`sleep 45` objective), busy-start | Created 19:53:23, resolved `zai/glm-5.3-flash`; busy (`running`) at 19:53:35. **Timed goal start (no `--replace`) mid-run: HTTP 200 in 0.0061 s**, accepted shape. Original goal then ran undisturbed to **`achieved`, runs 1** (19:54:14). Inner receipt `4bf2815a` terminal `completed` / `documented_handler_return`. |

Receipt ledger after the run: all 5 receipts terminal (`4 × documented_handler_return`, `1 × terminal_signal`) — no leaked or stuck receipts from the fire-and-forget dispatches.

**Interactive non-regression:** the browser WebSocket path and the interactive TUI `/goal` command do not go through this route; the change only moves *when the Internal API HTTP caller's response is written*. The composed command, the attached busy pass-through and the engine-side handler are byte-identical to before.

## Not done and why

- **Production engine deploy**: production `~/.pi/agent/extensions/goal-engine` still runs the I3 copy; the budget-pause reason reaches production `GET /goal` only after the parent deploys the H2g merge (`8d25a72`). Server-side, nothing further is needed (the pass-through already ships here).
- **Start-on-active-goal without `--replace` (Q observation)**: the queued start did not visibly arm a new goal nor raise a `pendingQuestion` — the engine's start handler returned at the command boundary with no state change. Pre-existing engine semantics (identical handler execution before and after this lane's change — only the response timing moved); H2g's domain. Recorded as an observation, not probed further.
- **Admission-pressure refusals of the fire-and-forget inner dispatch** cannot be forwarded to a caller that already received `accepted: true` (the response is gone). They are receipted (`rejectBeforeDispatch`) and logged; the caller discovers via `GET /goal`. The deterministic refusal (compaction) *is* forwarded synchronously via the pre-check.

## Residual risks

- A caller that treats the prompt `200` as "goal armed" without polling `GET /goal` could miss a rare fire-and-forget dispatch failure (see above). The contracted shape always said to poll or watch; docs state it for the busy case explicitly (`docs/INTERNAL-API.md`, contract 1.58.2 entry).
- Two near-simultaneous busy-session starts queue in dispatch order; the second hits the engine's active-goal semantics (Q observation). Pre-existing.

## Correction 03 (review REJECT → C1–C3, 2026-10-01T20:30Z; commits `660d1cee`, `18ec83c8`)

**C1 (major — one acceptance boundary).** The review (h2s-luna-review) correctly found that the route's `piBusyRefusal` preflight and the fire-and-forget inner dispatch were not one acceptance boundary: a refusal arising inside the pipeline after the preflight but before dispatch (compaction starting, `ADMISSION_CAPACITY_EXHAUSTED`, draining, receipt failure) was written to the discarded capture response while the route had already answered `200 {accepted:true}` — accepted-then-lost.

Fix (`660d1cee`): `handleSendPrompt` gains an internal-caller-only fourth parameter (`internal?: { onDispatchAccepted?: () => void }`; the HTTP server calls with three arguments, so the handshake is unreachable from HTTP). The callback fires at the pipeline's **last pre-dispatch refusal point** — right after `markStarted` succeeds; every refusal (busy, admission, reservation, receipt) is answered before it. The route awaits `Promise.race([accepted, captureEnded])`: on refusal it forwards the inner status, `Retry-After` (`createCaptureResponse` now records `setHeader` values instead of dropping them) and body verbatim, exactly as the blocking path would; on acceptance it answers the historical 200 accepted shape (`receipt: null`). Neither outcome waits for the busy turn or the goal.

TDD: RED — new test "a refusal arising between the route preflight and the inner dispatch check is forwarded instead of accepted-then-lost" (liveness reads 1–2 = streaming, ≥3 = compacting) failed at `expect(res.statusCode).toBe(409)` while the route answered 200; GREEN — 40/40 goal-routes tests; full server unit suite → **6174 passed | 3 skipped, exit 0**. Gates re-run: lint 0 errors, `lint:ratchet -- --base aeef536f` 11 changed files / violations [], typecheck 0, build 0, docs links 0 (1336 links), agent-guides 0. Contract 1.58.2 changelog + `INTERNAL-API.md` rewritten to describe the real guarantee.

**C2 (minor).** Stray blank line at EOF in `session-routes-follow-up-coalescing.test.ts` removed (`18ec83c8`); `git diff --check aeef536f...HEAD` → exit 0.

**C3 (live, corrected build `18ec83c8`, run dir `/tmp/h2s-live2-20261001T2040Z`).** Same disposable-server recipe (scope `h2s-live2-srv`, `MemoryMax=12G`, health `1.58.2`, engine overlay sha256 `af6f7701…` = `pi-enhancement@8d25a72`, zai-only credentials, stub isolation; peak 1 concurrent active turn, 2 live children).

- **P re-run** (`01a0f934`): busy turn 96.75 s; timed goal start **HTTP 200 in 0.0402 s** through the full acceptance handshake (reservation → admission → markStarted); goal `achieved`, runs 1, poll 1 landed 8 s after the turn ended.
- **Abort case** (`01a0f936`): busy turn (`sleep 120`); goal start mid-turn **HTTP 200 in 0.0117 s** (accepted); `POST /abort` at 20:45:22 → `{success:true}`; the busy turn's curl finished at 15.09 s (aborted). The armed goal file survived the abort: once the aborted turn settled, the engine ran the goal — **`achieved`, runs 1**, session `idle`. Receipt ledger after the run: 4 receipts, **all terminal** — `087eb365` completed/terminal_signal (P busy turn), `a89eff85` completed/documented_handler_return (P goal-start dispatch), `2f9522d6` cancelled/terminal_signal (A busy turn, at abort), `19c996ba` cancelled/terminal_signal (A goal-start dispatch, at abort). **No receipt left `queued` or `running`** — no stranded receipt, so no parent question. Facts worth noting: the abort cancelled the goal-start receipt (it rode the aborted turn) while the goal itself — persisted at the command boundary — ran to completion afterwards; receipt and goal state tell coherent stories.
- Cleanup: both sessions DELETE → 200; scope stopped, socket gone, zero validation processes; credential copies deleted; no heap snapshots.

## Cannot see (blind spots for adjudication)

1. Concurrent multiple goal starts on ONE busy session are unit-covered only (single-start proven live).
2. `resume`/`clear` on a busy session still block until the turn settles (unchanged, out of the frozen criterion); if the parent wants them prompt too, that is a follow-up with its own live proof.
3. The live proof ran 1–2 concurrent sessions, not the §1.1 load profile; the change is response-timing only and the unit suite covers the route matrix.
4. Q's start-on-active-goal outcome is observed, not explained (engine internals, H2g's lane).
