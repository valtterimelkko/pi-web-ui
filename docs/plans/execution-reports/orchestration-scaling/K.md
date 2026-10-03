# Wave K execution report — K1+K2+K3 (lane K)

**Outcome: MET.** A Pi goal child cut off by a server restart or a drain timeout now continues **once**, without any parent action, with a continue note that names the cut-off tool call; every stop that does not continue is visible at once as `goal_state` `paused`/`interrupted`; a second transient stop does not continue. Proven live on a disposable server with real GLM children: kill arm 4/4 recovered-and-achieved, drain arm 4/4, second-fault arm visible-interrupted-without-second-continue.

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
