# Hb5 — Antigravity goal manager stops on repeated provider errors

Wave H-b lane Hb5 (orchestration-scaling plan H-wave finding 3: "the antigravity
goal manager keeps continuing into repeated provider errors (27 of 40 turns
burned)"). Lane branch `orch/hb5`, worktree
`/root/.worktrees/orch-scaling/hb5-pi-web-ui`, from master `6a70238d`.
Contract **1.58.3** (patch, C6 window).

## What changed

1. **The turn reader surfaces error truth** (`server/src/antigravity/antigravity-service.ts`, the reader used by the sweeper: `AntigravityService.getLastCompletedTurn`, now delegating to the exported pure `summarizeLastCompletedTurn`). The summary gains `status: 'done' | 'error'` (a legacy line with no status field stays `done`) and the recorded `error` text. Turn ordering / derived-completion semantics are byte-identical to before.

2. **A finalized provider-error turn is an error strike, not an unmet turn** (`server/src/internal-api/goal/antigravity-goal.ts`). When the reader reports `status: 'error'` (agy's own terminal verdict — `INTERNAL (code 500)`, `UNAVAILABLE (code 503)`, `timeout`; no assistant answer), the sweeper no longer verifies or consumes a `runs` budget. It counts a strike, records ``provider error (strike N/3): <error>`` in `lastReason`, and **dispatches one retry continuation** (strikes 1–2), mirroring the Pi goal engine's three-strike rule (`/root/pi-enhancement/goal-engine`, `MAX_CONSECUTIVE_ERRORS = 3`: retry, pause on the third consecutive real error). The **third consecutive strike pauses** with `status: "paused"`, `pausedReason: "error"` and a `lastReason` naming the error; nothing is dispatched on the pausing strike. Any successful (non-error) turn resets the counter to 0 and clears a stale strike note. The counter is 0 on the paused record (the pause ends the cycle), so `resume` re-arms a fresh three-strike window without touching the resume route; the count that caused the pause is stated in `lastReason`.

3. **A refused retry self-heals instead of stalling the goal.** The live proof exposed a race the unit tests could not: the route's admission lease can outlive the turn's finalisation, so a continuation dispatched in the first ~250 ms after the turn is refused `409 SESSION_BUSY` (diagnostic run `live-20261002T020556Z`: `strike retry dispatch failed: goal continuation dispatch failed (409)`). With the original order (record the strike, then dispatch) the refusal was swallowed by the sweeper's per-session isolation and `lastVerifiedTurnAt` was already advanced — the goal stalled at strike 1 forever. Now the continuation is dispatched **first** and the strike recorded only after it is accepted: a refusal consumes nothing, the next sweep re-processes the same turn and retries, and the strike is counted exactly once.

Per-runtime change detection is unchanged: the paused projection reaches `deps.publish` → broker + browser bridge → watchers (asserted in unit and live).

**Contract 1.58.3** (patch, bug fix inside the C6 stability window): antigravity goals can now report `pausedReason: "error"` (a value Pi goals already use). No new route, field, error code, event or default; `SessionGoalProjection.pausedReason` was already a runtime-string. The client snapshot changes by exactly one line (`contractVersion`); the stability-window fingerprint is unchanged. Pins that track the version moved (`capabilities.test.ts`, `command-code-contract.test.ts`). Changelog entry in `docs/INTERNAL-API-CONTRACT.md`; `docs/INTERNAL-API.md` goal table documents the strikes.

## TDD (strict)

Vitest environment for every run: `env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test`, in a `systemd-run --scope` memory cap.

| Behaviour | Test | RED | GREEN |
|---|---|---|---|
| Provider-error turn = strike, no run consumed, retry dispatched | `antigravity-goal.test.ts` "counts a provider-error turn as a strike instead of consuming a run, and retries" | `npx vitest run …goal.test.ts …goal-turn-reader.test.ts` → **exit 1, 11 failed \| 26 passed** (all new behaviour tests failed; existing 26 green) | same files → exit 0, **37/37** |
| Three consecutive strikes pause (`paused`, `pausedReason: error`, `lastReason` names the error), nothing dispatched on the pause | "pauses after three consecutive strikes…" + `goal_state` assertion | included in the 11 | included in the 37 |
| Successful turn resets the count / clears the stale note | "a successful turn resets the strike count and clears the stale error note" | included in the 11 | included in the 37 |
| `resume` re-arms a fresh window | "resume re-arms: a resumed goal starts a fresh strike cycle" | included in the 11 | included in the 37 |
| Classification from reader truth, not text scan; legacy turns stay ordinary | "classifies by the reader truth…", "treats legacy turns (no status field)…" | included in the 11 | included in the 37 |
| Turn reader surfaces the real H2s shapes (500 / 503 / timeout / done / legacy / running-skipped / null) | `antigravity-goal-turn-reader.test.ts` (6 tests, fixtures mirror `cefdf34a-abf7-441f-b075-5af3d980c1b1`) | included in the 11 | included in the 37 |
| Refused retry is not consumed (self-healing) | "a refused retry does not consume the strike: the next sweep retries the same turn exactly once" | `npx vitest run …antigravity-goal.test.ts -t "refused retry"` → **exit 1, 1 failed \| 31 skipped** | both files → exit 0, **38/38** |

Fixture provenance: the H2s Gemini session `cefdf34a-abf7-441f-b075-5af3d980c1b1`
(`~/.pi-web-ui/antigravity-sessions`, read-only) whose 27 finalized turns are all
`status: "error"` with `INTERNAL (code 500): Internal error encountered.`,
`…(UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server)`
and `timeout`; the same strings are used in the live stub.

## Gates (worktree, at `d51b0ad0`)

| Command | Exit | Evidence |
|---|---|---|
| `npm run lint` | 0 | `305 problems (0 errors, 305 warnings)` (pre-existing warnings) |
| `npm run lint:ratchet -- --base 6a70238d` | 0 | `warnings: 320, ceiling: 326, checkedChangedFiles: 10, violations: []` |
| `npm run typecheck` | 0 | clean (all workspaces) |
| `npm run build` | 0 | client + server + MCP clean |
| goal test files | 0 | `Tests 38 passed (38)` |
| contract guards (`contract-version-drift`, `client-snapshot-drift`, `contract-stability-window`, `capabilities`, `command-code-contract`, whole `goal/` dir) | 0 | `Test Files 16 passed (16)`, `Tests 206 passed (206)` |
| full server unit suite (`cd server && npx vitest run tests/unit`) | 0 | `Test Files 512 passed (512)`, `Tests 6224 passed \| 3 skipped (6227)` — no load-sensitive failures |
| `npm run docs:check-links` | 0 | `OK: 1338 internal link(s) resolve across 350 Markdown files` |
| `npm run docs:check-agent-guides` | 0 | `AGENTS.md and CLAUDE.md are byte-identical` |

## Live validation (disposable server, mock agy — zero real model calls)

`npm run validate:server -- --dir <run>/val --compiled` inside a transient
systemd unit (`--unit=hb5-live-…`, `MemoryMax=12G MemorySwapMax=1G CPUQuota=400%`),
driven over the isolated unix socket. `AGY_BINARY` pointed at a run-local mock
(`agy-hb5-stub.mjs`, wire-identical NDJSON `init`/`result` per turn) — the
validation wrapper's stub opt-in flips antigravity on with no credentials, so
**the owner's Gemini quota was untouched and no production socket was used**.
`/api/v1/health` reported `contractVersion: "1.58.3"`,
`runtimes.antigravity: "available"`. Server stopped via the sanctioned stopper;
`ss`/`pgrep` show no socket and no stub processes remain.

**Final run** `/root/orch-ops/orchestration-scaling/hb5/live-20261002T021946Z`
(build `d51b0ad0`, `AGY_GOAL_SWEEP_MS=400`): all assertions passed.

| Arm | Pattern | Result |
|---|---|---|
| A (provider errors) | antigravity goal, `verifyCommand` that never passes, mock agy ends every turn in an error; watch registered for `event_type goal_state` with `dataMatch {status: paused, pausedReason: error}` before the start | 3 turns (`error` × 3: 500, 503, timeout; strictly sequential), then `GET /goal` = `status: paused, pausedReason: "error", runs: 0, lastReason: "goal paused after 3 consecutive provider errors; last error: timeout"`. A fourth turn never appears (settle re-read 3 s later identical). Watch `firingCount: 1`, condition `paused-error`, `eventType goal_state`. |
| B (positive control) | same stub, goal with no verify command, objective matching the stub's healthy path | turn 1 `done` (unmet) → continuation; turn 2 `done` with `GOAL_STATUS: ACHIEVED` → `status: "achieved", runs: 2, verification.status: "self_reported"`. |
| C (resume re-arms) | after arm A's error pause, `POST /goal {action:"resume"}` | response `accepted: true` with `goal.status: "running"`; the transcript grows to 4 turns (the re-armed continuation is dispatched); `clear` → `status: "cleared"`. |

Two earlier runs of the same script with `AGY_GOAL_SWEEP_MS=2000`
(`live-20261002T020852Z`) and 400 ms (`live-20261002T020925Z`) produced the
same arm A/B result; the final three-arm run supersedes the two-arm run
`live-20261002T021050Z` (identical arm A/B numbers). The pre-fix build is the
negative control at transcript level: the H2s session fixture (27 error turns,
all continued) is the defect; the diagnostic run
`live-20261002T020556Z` shows the same code stalling at strike 1 on the 409
race before the retry-first fix.

Load claims: build revision `d51b0ad0` (contains the change under test); peak
concurrent active turns **1** in every arm (each arm's transcript is strictly
sequential; e.g. arm A's three turns complete in 57/1/1 ms with no overlap);
sample count: 3 turns arm A + 2 turns arm B enumerated item-by-item from the
isolated session JSONL (not aggregate counts). The unit cgroup
(`/system.slice/hb5-live-…`) is a transient service, not nested, capped at
12G/1G swap.

## Not done and why

- **No real Gemini/provider error was produced** (criterion 4's condition): a real error needs the owner's quota and a failing provider; the mock produces the identical finalized-turn shape that the reader consumes, and the error strings are the real H2s ones. The mechanism is a property of the server's turn store, not of the network.
- **No changes to `sessions.ts`'s `resume` handler**: the pause records the counter as 0, so `resume` re-arms a fresh window with no route change (brief-owned paths).
- **The other goal managers** (`pi-goal`, `claude-goal`, `commandcode-goal`) are untouched; the Pi engine has its own three-strike rule.

## Cannot see / blind spots (for §1.1 adjudication)

- **A user-aborted antigravity turn is finalized `status: "error"`** (the service's error path is used for `reason: "aborted"` too), so it counts as a strike; three consecutive aborts pause with `pausedReason: "error"` and `lastReason` naming `aborted`. Not excluded because the brief defines the strike by "no assistant answer; the error the turn reader can see", and text-matching "aborted" would be brittle. The user's explicit pause/clear are unaffected.
- **Strikes never consume `maxRuns`.** A provider that fails forever pauses at 3 (by design); a goal cannot fail by budget while erroring.
- **A permanently refused retry retries forever** (each sweep) and neither advances nor pauses the goal; there is no cap on retries. Observed only under the artificial 400 ms race; considered preferable to a silent stall.
- **In-process change detection**: `lastPublished`/`lastTerminal` are per-process; a server restart re-publishes the current projection on the first sweep (pre-existing).
- **Browser bridge**: asserted through the sweeper's `publish` in unit tests and through the broker watch live; the UI's own goal surface was not driven in a browser for this lane.
- **Host hazard found during the proof (not this lane's fix):** starting a disposable validation server runs `sweepAllGroups` (`server/src/placement/cleanup.ts`), which removes **every** managed `pi-*/rt-*/own-*` child cgroup under the tools root — including *live* tool cgroups of other sessions on the host. It SIGKILLed this lane's driver shell and stopper twice (`pi-01a0fa41…` cgroup) until the proof ran inside a transient systemd unit in `/system.slice`. Any concurrent agent running a disposable server will kill other sessions' live bash commands. Reported to the parent; likely belongs to the placement/restart-guard lane (Hb4) or the ledger.

## Residual risks

- `resume` re-arm semantics rely on the pause recording `consecutiveErrors: 0`; if a future route change starts persisting a non-zero counter across pauses, the window would shrink silently. Pinned by the "resume re-arms" unit test.
- The strike classification is keyed on `status === 'error'`; a future antigravity turn kind that finalizes as `error` without being a provider failure (e.g. a new abort class) will count as a strike. The blind-spot entry above names the known case.

## Parent closure (after the Luna review, ACCEPT WITH FIXES)

The review's two majors were fixed by the parent, test-first:
- **Owed resume continuation.** A resume whose continuation was refused with `409 SESSION_BUSY` while the session settled left the goal `running` with nothing dispatched; the sweeper skipped the already-verified turn and nothing woke it. The record now carries `pendingContinuation`; the sweeper dispatches the owed continuation once the session settles (a refused dispatch is retried on the next sweep) and a newer completed turn supersedes it. RED: two sweeper tests and one route test failed; GREEN after the fix.
- **Fresh strike window.** `resume` and both `start` paths reset `consecutiveErrors` (a strike, then user pause, then resume no longer pauses after two errors). Covered by the same route test.
- Minor: the 1.58.3 changelog now says error turns are not treated as ordinary unmet turns (strikes 1–2 do retry); the link-check count is 350 files.
- Gates after the fix: goal and antigravity suites 381/381, typecheck 0, `lint:ratchet --base master` no violations.
