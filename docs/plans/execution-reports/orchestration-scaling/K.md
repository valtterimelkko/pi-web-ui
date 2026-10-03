# Wave K execution report — K1+K2+K3 (lane K)

**Outcome: MET.** A Pi goal child cut off by a server restart or a drain timeout now continues **once**, without any parent action, with a continue note that names the cut-off tool call; every stop that does not continue is visible at once as `goal_state` `paused`/`interrupted`; a second transient stop does not continue. Proven live on a disposable server with real GLM children: kill arm 4/4 recovered-and-achieved, drain arm 4/4, second-fault arm visible-interrupted-without-second-continue.

> **Correction 02 (2026-10-03, after the Luna r1 REJECT):** all 2 blockers + 5 majors fixed (commits `1a0e94c1`, `fe8926cc`, `6b0a54a7`, `57eb915a` on `orch/k-durable`); the live re-run on the final build re-proved every arm (kill n=4 + an explicitly-paused negative child, drain n=4 with `drainVerdict: "timed_out"` recorded, second fault n=1 PASS) and the evidence set was rebuilt with a marker manifest accounting for all 17 marker files. Details in **§ Correction 02** below; § First round records the r1 state as reviewed.

## Correction 02

**F1 — exactly-once is atomic.** `continue-marker.ts` replaced reserve/rollback with an exclusive `claim()` (`fs.open … 'wx'`), `commit()` (ambiguous delivery = consumed) and `release()` (definite refusal only; a committed once is never undone). A stale count-0 claim older than 15 min is taken over atomically (`rename`). The sweep holds an in-process single-flight per session; the loopback prompt carries an `idempotency-key` header derived from sessionId + fingerprint. RED→GREEN: `continue-marker-claim.test.ts` (6), reworked `continue-marker.test.ts` (6, incl. release-after-commit no-op), sweep rows: overlapping sweeps dispatch once; crash-after-acceptance (fresh claim) blocks; unknown outcome consumes + visible interruption.

**F2 — explicit intent.** `classifyCandidate` now continues ONLY an orphan (`running`/`wrapping_up`), a restore pause, or (live path) a typed fresh provider stop. The sweep never reads stale `lastErrorMessage`; announced explicitly-paused/question/governor/budget/turn-limit children are skipped with no events and no marker — **live-proven**: the kill arm's `kill-paused` child stayed `paused`, zero markers, sweep log `goal state 'paused' is not a continueable stop (explicit intent or terminal — nothing silent)`.

**F3 — live path gated.** Observers attach only to Internal API children (and Pi); `handleLiveStop` takes an explicit scope and refuses the rest. Tests: browser-origin provider stop not continued; non-Pi observer attachment excluded (wiring test).

**F4 — provider aborts reach the handler.** `goal-events.ts` invokes the interception hook BEFORE emitting `goal_end`; an interception (dispatched + verified) suppresses that stop's `goal_end`; otherwise events are exactly as today. Tests use the real projected shape (`lastErrorMessage` → status `failed`).

**F5 — non-Pi consistency.** Non-Pi candidates read the runtime's real projection via the loopback goal endpoint; a silently active goal gets the visible interruption with the runtime's own `supported` flag; terminal or explicitly paused goals get nothing (tests: active/terminal/paused).

**F6 — suppression keyed to this continue.** The R5 probe resolves the session's CURRENT goal fingerprint and requires a continue CONFIRMED in this boot; other-goal markers are pruned; the sweep's second-transient detection reads only the current goal's marker. Tests: older-goal marker pruned + fresh once; reserved marker no suppression; pre-boot continue no suppression (wiring test); goal-A-continue/goal-B-end delivered (watch test).

**F7 — truthful events.** The auto-continue `goal_state` is published only with a VERIFIED post-dispatch projection (`status: "running"`, poll bounded by `verifyMs`); accepted-but-unverified dispatches are consumed and surface as `continue_failed` (never a claimed auto-continue). Live note: the overlay record self-clears when the engine writes, so the durable `autoContinued` trace is the marker + sweep journal + the child transcript note; result rows carry the verified working-moment projection (`projectionStatus: "running"`) and the window-end/collection payloads.

**Evidence corrections.** `summariseWatchLedger` now derives `sawInterruptedByRestart` from the ledger's evidence text — the re-run rows carry it `true` for every work child. The drain verdict is recorded in the results (`drainVerdict: "timed_out"`). The empty r1 note file was replaced by transcript extracts that hold the actual continue note (kill arm + second fault). Every marker file in the evidence set is explained by `marker-manifest.json` (4 kill + 4 drain + 1 second-fault + 8 from two aborted arm attempts whose sessions were deleted during cleanup — markers survive session deletion by design). Rows carry `goalStatePayload` (window-end/collection) and `workingMomentPayload` (verified post-dispatch projection).

**Correction live re-run (run k-r2, final build 57eb915a):** kill arm n=4 + negative child — 4/4 continued once (single dispatch each), achieved, 0 parent actions, 0 silent stalls, 0 duplicate commits, negative child stayed paused with no marker; drain arm n=4 — `drainVerdict: "timed_out"`, 4/4 continued once, achieved, 0/0/0; second fault n=1 — `SECOND-FAULT PASS: workedAgain=false status=paused pausedReason=interrupted cause=second_transient continueCount=1`. Peak concurrency 4 busy children; same disposable topology (k-K-arm units, placement asserted, `Available providers (with auth): zai`).

## Correction 03 (FINAL) — 2026-10-03, after the Luna r2 REJECT

**Scope cut (parent decision):** the live provider-abort path is REMOVED. Continueable states are exactly an orphan `running` goal and a `restored_on_session_start` pause. `wrapping-up` is never continued. Provider aborts end as before wave K (the bridge emits their `goal_end`, unchanged); `provider_abort` remains a documented, non-continued K1 cause.

**File:line per item (final state, commit 52226916Head — see git log for the exact tip):**
- **Scope cut:** `scripts` none; `server/src/internal-api/goal/interruption-sweep.ts` — `handleLiveStop` deleted (file ends at the returned `{run}` object); `interruption-wiring.ts:69-108` — no observers/`attachLiveObservers`/`startObserving`; deps lost `addExtensionUiObserver`/`removeExtensionUiObserver`/`readGoalProjectionViaApi`; `server.ts` lost the observer wiring; `goal-events.ts:37-44, 60-71` — the `onPausedOrFailed` hook is gone, terminal goals emit `goal_end` exactly as before.
- **C1 exactly-once delivery:** `server.ts` `dispatchGoalContinuePrompt` (~line 1322) — JSON body `{message, mode:'prompt', verbosity:'answers', detach:true, idempotencyKey}` (no header); 200/202 accepted; 400/404/409 and 429/503-with-Retry-After refused; anything else unknown→consumed. `continue-marker.ts` — claim exclusive (`wx`), no takeover (a found count-0/corrupt marker is consumed, `count:1`), `confirm()` state, `release()` never undoes consumed/confirmed. `interruption-sweep.ts` `continueOnceUncancelled` — consumed-found → visible `continue_failed` (no dispatch); single-flight per session; key `goal-continue:<sessionId>:<fp12>` ≤ 200 chars (route validation verified: `session-validation.ts:38`, `run-receipt-manager.ts:934-947`).
- **C2 intent:** `interruption-sweep.ts` `classifyCandidate` — continueable = `running` (orphan) or `paused`+`restored_on_session_start`; `wrapping_up` explicitly excluded with a comment; terminal/explicit pauses skip with no events, no marker.
- **C3 non-Pi:** `interruption-sweep.ts` `handleCandidate` non-Pi branch — `NON_PI_TERMINAL` (canonical terminal set) excluded, `opts.boot` gates visibility to the boot sweep only, real projection + real `supported` flag.
- **C4 confirmed suppression:** `continue-marker.ts` `confirm()`/`hasConfirmedContinue()` + `state: 'delivered'|'confirmed'`; `interruption-wiring.ts` `hasGoalContinueMarker` (probe) requires `state==='confirmed'` + current fingerprint + `continuedAt ≥ bootTimeMs`, prunes mismatched markers.
- **C5 fingerprint-tied verification:** `interruption-sweep.ts` `continueOnceUncancelled` — pre-dispatch re-read (same fingerprint + still continueable, else claim released and nothing written); post-accept poll: same-fp `running` verifies, same-fp terminal verifies as a completed continue (no overlay), different fingerprint stops with no overlay/no event. `interruption-overlay.ts` `applyInterruptionOverlay` — fingerprint binding (a provided `currentFingerprint` that differs from the marker's disables the overlay); `pi-goal.ts` `readProjectPiGoalState` passes the current fingerprint.
- **C6 watchable:** `interruption-sweep.ts` verified publish sets top-level `autoContinued: true` (+ nested object); `types.ts` `SessionGoalProjection.autoContinued`; `watch/condition-evaluator.ts` `matchOne` event_type evidence now carries the goal_state payload (`autoContinued`/`cause`/`continueCount`) into the ledger. Docs: `docs/INTERNAL-API.md` Wave K section rewritten (scope cut + `dataMatch {"autoContinued": true}`), contract 1.59.0 entry updated.

**Correction 03 tests (RED→GREEN):** `continue-marker-c03.test.ts` (RED 5 failed → GREEN 5), claim tests reworked to C1 semantics (never-replayed, no takeover), sweep tests rewritten (RED 4+ → GREEN 23) incl. body/detach, unknown-500, count-0/corrupt consumed-visible, wrapping-up negative, boot-only non-Pi, replaced-before/after-dispatch, same-fp-terminal, top-level autoContinued; wiring tests (C4 delivered-unconfirmed no-suppress, pre-boot no-suppress); C6 real-evaluator rows in `watch-manager.test.ts` (32 passed); overlay fingerprint-binding rows (12 passed). Goal+reconciliation+watch+contract suites: 348 passed.

**Correction 03 live re-run (run k-r3, final build, same disposable topology):**
- Kill arm n=4 (+ negative children): 4/4 continued once, achieved, 0 parent actions, 0 silent stalls, 0 duplicate commits, `sawInterruptedByRestart` true ×4. Negative children: `/goal pause` could NOT produce a persistent paused/wrapping-up state — the engine's queued continuations re-activated the goal within the verification window (3 attempts; `stuck:false` each time); both negatives were then continued like any other orphan. **Stated limitation** per the correction's escape hatch: the C2 intent rule is covered by the unit rows (announced explicitly-paused → no continue/no change; wrapping-up → no continue — all pass), and the two negative children's markers are preserved and labelled `NEGATIVE-CHILD-CONTINUED-LIMITATION` in `marker-manifest.json`. This is itself evidence for the intent principle: the engine's continuation machinery treats the goal as active, and the sweep followed the goal file.
- Drain arm n=2: `drainVerdict: "timed_out"`, 2/2 continued once, achieved, 0 parent actions, 0 stalls, 0 dups.
- Second fault n=1: `SECOND-FAULT PASS: workedAgain=false status=paused pausedReason=interrupted cause=second_transient continueCount=1`.
- Evidence: `/root/orch-ops/orchestration-scaling/k/K/evidence-c03/` (results, tables, arm states, marker manifest, transcripts, sweep journal).

**Gates (final):** full server suite 7539 passed (3 documented load flakes + `session-watcher-retention` flake pass alone, 83/83); snapshot regenerated for the top-level `autoContinued` field (drift test green); lint/ratchet/tsc/build/docs checks all 0.

## First round (r1 state, as reviewed)
 A Pi goal child cut off by a server restart or a drain timeout now continues **once**, without any parent action, with a continue note that names the cut-off tool call; every stop that does not continue is visible at once as `goal_state` `paused`/`interrupted`; a second transient stop does not continue. Proven live on a disposable server with real GLM children: kill arm 4/4 recovered-and-achieved, drain arm 4/4, second-fault arm visible-interrupted-without-second-continue.

## The mechanism (confirmed, with the two corrections)

1. After a restart a Pi session is rehydrated lazily; pi-enhancement's goal engine only force-pauses an active goal inside `session_start` (`goal-engine/index.ts:192-231`), so the goal file on disk keeps saying `running` while the session is idle — the E2 8/8 silent stall.
2. Correction 1: the B4/B4.1 reconciliation (`watch/watch-manager.ts:499-609`) covers only **watched** sessions and only receipt-backed or drain-announced runs; a SIGKILLed receipt-less goal child was invisible even when watched.
3. Correction 2: the restore pause persisted no distinguishing reason — disk-indistinguishable from a user pause (fixed: `restored_on_session_start`).

## What shipped (branches: `orch/k-durable` @ 77fcb841; `orch/k-goal-resume` @ 2c34aac; contract 1.59.0)

- **K1** `goal/transient-cause.ts`: closed transient list (restart interruption incl. receipt reason `server_restart`, rehydrate pause, provider abort on **positive** provider evidence only); table test 21 rows.
- **K2** `goal/interruption-sweep.ts` + `goal/interruption-wiring.ts` + `server.ts` boot/drain wiring: R1 scope (registry origin `internal-api`/`parentSource`, previous-lifetime bound 6 h or announced, Pi, not busy); concurrency 2, Retry-After honoured inside a 10-minute window; continue dispatched as `/goal resume "<note>"` through the **loopback prompt path** (full admission/receipt/injection pipeline; refused ⇒ marker rolled back, visible interruption). Server-owned durable markers under `<run-receipts dir>/goal-continue/markers/` (R3) keyed by sessionId + goal fingerprint; reserve→commit→rollback = at-most-once. Non-continued stops surface via the **R4 overlay** (`goal/interruption-overlay.ts`): projection reads `paused`/`interrupted` + additive `interruption` object — no new canonical status; overlay clears on any engine write; `POST /goal resume` works across it. **R5**: `watch-manager` suppresses the synthetic `goal_end` when a continue marker exists (module probe, awaited ⇒ boot ordering is deterministic). **R6**: the live path classifies `goal_state` paused/failed events (per-session observers wired in `server.ts` via the owned `goal-events.ts` hook) and continues once on provider abort.
- **K3** `goal/continue-note.ts`: the note names the cause, the intact worktree, and the in-flight tool call (last unmatched `toolCall` in the raw session JSONL) with the check-effects rule.
- **pi-enhancement** (`orch/k-goal-resume`): restore persists `pauseReason: "restored_on_session_start"` (R7); `/goal resume [note]` and the `goal-resume` alias carry a continue note; no-note default byte-identical.
- **Contract 1.59.0** (additive): `SessionGoalProjection.interruption` + `GoalInterruptionInfo`/`GoalInterruptionCause`; docs in `INTERNAL-API.md` § Goal; C6 window's R5 exception row recorded; client snapshot regenerated.

## Live proof (disposable server `k-K-arm-server.service`, transient units; real `zai/glm-5.3-flash` children; asserted served model + `Available providers (with auth): zai`)

| Arm | n | Result | Key numbers |
| --- | --- | --- | --- |
| Kill (SIGKILL + systemd auto-restart) | 4 | **PASS** | sweep: `4 candidates, 4 continued, 0 skipped`; 4/4 `workedWithoutParentAction`, 0 parent actions, 0 silent stalls, 0 duplicate commits, 4× goal `achieved`; s-to-working 0–5 s |
| Drain timeout + restart | 4 | **PASS** | sweep: `4 continued`; 4/4 no-parent, achieved; 0 silent stalls; 0 duplicates; 0 orphans |
| Second fault (same goal interrupted twice) | 1 | **PASS** | first fault auto-continued (working again ≤ 10 min); after the second restart: `workedAgain=false`, projection `paused`/`interrupted`, `cause: "second_transient"`, `continueCount: 1` |

- Peak concurrency: 4 concurrent busy children (driver samples every 10–15 s; admission `maxActiveTurns` 6 on the disposable server). Topology: 1 disposable validation server (own socket/token/dirs, placement ON at the run's own anchor `k-K-arm-tools-anchor`, placement root asserted isolated) + the harness driver as the pi-orch parent. Build revisions: kill + drain arms ran the working-tree build with the live-proof fixes applied (committed as 77ab96a6); the second-fault arm ran build 77fcb841.
- Watch ledgers: exactly one `goal_state` + one `agent_end` (`interrupted by restart: run …, server_restart`) + exactly one `goal_end` per child — the single real end (R5 held).
- Markers: 4 files `count: 1, cause: restart_interruption` (kill arm) + 4 (drain arm); K3 note verified verbatim in child transcripts (evidence: `kill-c1-continue-note` extract and `second-fault-continue-note-in-transcript.txt`).

## Live-proof findings (each fixed with a RED test, all in 77ab96a6)

1. Run receipts record the restart reason as lowercase `server_restart` — the brief's `SERVER_RESTART` spelling never matches. Classifier accepts both.
2. Stale receipts re-announce goals that since reached a terminal state → false `interrupted` events; announced candidates with terminal disk goals now skip.
3. The overlay inferred `autoContinued` from `continueCount ≥ 1`, so a second-transient overlay projected `running`; it now carries an explicit flag.

## Runtime support matrix

- **Pi: continue-once supported** (the only runtime required for victory).
- **Claude / Antigravity / Command Code: unsupported this wave** — they emit the visible `interrupted` `goal_state` (`cause: "unsupported_runtime"`) instead of continuing. Antigravity already retries provider strikes server-side (1.58.3); a K2 continue there remains future work.

## Gates

- `npm run lint` → 0; `npm run lint:ratchet -- --base 87435e92` → 0 violations; `tsc --noEmit` → 0; `npm run build` → 0; `docs:check-links` → 1369 links OK; `docs:check-agent-guides` → identical.
- Targeted suites: goal (245), restart-reconciliation (23), contract+capabilities+drift (42) — all pass.
- Full server unit suite (`k-K-suite` scope, 6G cap): 7523 passed, 3 failed — the documented load-flake files (`voice-live-lab/tier1-guarded`, `pi/session-shutdown-emission`, `talker/delivery`); re-run alone → 73/73 pass.
- pi-enhancement: `goal-engine-*` + `orch-goal-*` suites 20/20 files pass (incl. the new wave K suite: R7 + resume note + byte-identical default).

## Provider-abort arm — stated limitation

Not run live: a stub provider in the isolated agent dir would fail the continue itself (the recovery could not be demonstrated), and no traffic-shaping injection exists in the harness. Covered instead by unit rows: classifier positives (overload/429/5xx/ECONNRESET/exhausted retries), negatives (user abort, bare abort, browser-stop-equivalent, verification failure, real tool error), and the sweep's provider-abort continue-once test. R6's live wiring is exercised by the same code path the kill arm proved (marker → dispatch → overlay → events).

## Blind spots

- `totals.goalAchieved` in the inherited harness tables reads 0 despite per-child rows `achieved` (pre-existing totals bug in the E2a harness; rows are the evidence).
- Sessions not in the session registry (never created through the API) are invisible to the sweep — by design (R1).
- A provider abort that also kills the server within the same window classifies as restart interruption (the restart is what the sweep sees).
- The R6 live observers attach on a 30 s registry poll; a provider-abort pause on a never-observed session is picked up within that interval.
- Production impact requires the batched deploy (owner-gated restart); nothing in production changed.
