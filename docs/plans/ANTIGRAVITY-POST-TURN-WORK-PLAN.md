# Antigravity post-turn work and error storms — plan

**Status:** complete (2026-11-22, 04:05 UTC). Deployed to production at contract 1.70.0 (master `df150997`). **Owner:** Valtteri. **Parent:** Claude Code session `cd78fe71`.
**Operations folder (state, briefs, hand-backs):** `/root/orch-ops/agy-post-turn-20261122/` (`STATE.md` is the live state).

## Intent

Antigravity (`agy`) children often give their "final" answer while a background command or a self-set timer is still
pending, then wake themselves and keep working. Our stream-mode runtime can then tell the parent the child is finished
while agy is still working, and may shut agy down (idle timeout) under that work. Separately, provider errors arrive in
storms (quota exhausted, Google 500/503) and are retried without telling apart "stop" from "wait and retry".

Goal: a parent is told "finished" only when the agy child really is, idle shutdown never kills pending work, and the two
error classes are handled differently. Fix only what live tests on today's agy (1.5.14) show is wrong.

## Evidence (read-only analysis, 22 Nov 2026, session `claude:6d0291e5`)

Across 2,542 archived agy conversations and 146 Pi Web UI turn records (June–Nov 2026):

- Final answer while a background command still ran: ~505 times in 141 conversations; self-wake afterwards: 332 times
  in 121 (Internal API sessions: 85 / 55 in 4–5 conversations). Median wake 23 s, 1 in 10 over 2 min, max 30 min.
- agy's `schedule` timer: 138 calls, all fired (45 in Internal API sessions). Restart notices with open work: 19.
- Quota (`RESOURCE_EXHAUSTED`, 429): 321 conversations failed within an hour on 19 Nov. Google 500/503: 27 failed turns
  in 12 min on 1 Oct, retried instantly.
- Subagents (3 calls), mid-turn 404, thinking-signature breakage, `/compact` need: none or negligible.

Code reading (hypotheses until the probes run): background tasks are surfaced only to the browser
(`server/src/antigravity/antigravity-service.ts`, used by `websocket/connection.ts`); the idle timer in
`agy-stream-process.ts` starts at turn end and is not reset by post-turn activity; `schedule` is not tracked; goals
already pause after three consecutive provider errors (`internal-api/goal/antigravity-goal.ts`).

This supersedes the 2026-09-10 note in `ANTIGRAVITY-BACKGROUND-TASKS-AND-ARCHIVE-ROBUSTNESS-PLAN.md` §1.1 that
headless stream-json agy never re-prompts itself (to be corrected at P5 after the probes confirm it).

## Rule for building anything

Build a fix only when all three hold: (1) it happens in our own sessions; (2) a live test on current agy shows a wrong
outcome; (3) the fix is a small trigger or hard limit on signals we already receive (no reading agy's private SQLite).

## Out of scope (decided)

Subagent tracking, mid-turn 404 auto-continue, thinking-signature recovery, `/compact`, mid-turn steering, moving to
agy ACP, pinning agy's version / disabling its self-update (re-run the probes after a version jump instead).

## Phases

| Phase | What | Who | Gate / evidence |
|---|---|---|---|
| P0 | Plan, state, briefs; Telegram start | parent | files exist; board declared |
| P1a | Live probes on production Internal API with `gemini-3.8-flash-medium` agy sessions: **T1** background finish (90 s background command, immediate answer, marker at end), **T2** timer wake (agy `schedule` 60 s), **T3** idle shutdown (background command past the 30-min idle timeout). Timeline per probe: run receipt end, `busy`, marker time, post-turn messages saved or lost, agy process alive. | DeepSeek v4.1 Flash child | `probe/results.md` + raw timelines; parent re-reads raw JSON |
| P1b | Lane C — error classes: pure classifier (quota / transient / other) with real error texts as fixtures; goal sweeper pauses at once on quota (reason names the reset time when given) and backs off before retrying a transient error; classification surfaced additively to the parent. TDD. | DeepSeek v4.1 Flash child (lane runner) + Sonnet reviewer | lane gates green; review ACCEPT |
| P1c | Critical-advisor critique of this plan | GPT-6.1 Terra (read-only) | `advisor/advice.md` |
| **R1** | Parent review: probe results + advisor advice → decide lanes A/B design (or drop them), amend this plan | parent | plan amended, decisions logged |
| P2 | Lane A — "not finished while work is pending" (only if T1/T2 fail). Lane B — idle shutdown never kills pending work (only if T3 fails). Likely one lane (same files). TDD. | DeepSeek v4.1 Flash child + Sonnet reviewer (turn lifecycle is critical) | gates green; review ACCEPT |
| **R2** | Parent review of all lanes: gates re-run by parent, diffs read, findings adjudicated; plan amended | parent | — |
| P3 | Merge in a scratch worktree, full gate on the merged tree, contract bump + Agent OS mirror if a wire field changed, push, CI green, `production:drain-restart` | parent | merged-tree gates green; CI green; MainPID changed; `/capabilities` ok |
| P4 | Re-run T1–T3 (and an error-class check) against the restarted production | DeepSeek v4.1 Flash child | results show correct outcomes |
| **R3** | Final parent review; docs corrected (§1.1 note, `docs/ANTIGRAVITY-INTEGRATION.md`); Agent OS capture; Telegram done | parent | — |

Owner review points: none planned. The parent asks the owner (Telegram `question`) only if R1 shows a needed fix
outside the rule above, a contract change with downstream impact beyond the Agent OS mirror, or a restart while
another parent's children are busy and drain cannot settle.

## Quality gates

Lane gates (each lane brief): targeted vitest for touched modules, `npm run typecheck`, changed-file lint ratchet against
the lane base. Merge gate (parent): full `npm test`, `npm run typecheck`, `npm run lint:ratchet -- --base <previous
master>`, `npm run build`, `npm run docs:check-links`. Live: P4 probe re-run.

## Authority (owner, 2026-11-22, verbatim)

"You have my permission to touch on my antigravity login and use real models inside it (3.8 flash is a cheaper model
for that). You have my permission to restart it as well."

## Waiting on the owner

| Item | Since | Ref |
|---|---|---|

## R1 findings (2026-11-22 01:30 UTC, parent-verified from agy's own transcripts and the server journal)

- **T1 (90 s native background task) and T2 (60 s `schedule` timer): no wrong outcome.** agy 1.5.14 answers early
  inside the turn ("STARTED") but does not emit its stream `result` until the pending task or timer has finished and it
  has replied ("DONE"); the run receipt ends after the work and the follow-up work is stored. The "parent told finished
  early" failure seen in the archive does not reproduce on current agy. **Lane A is dropped** (rule criterion 2 fails).
- **T3 (33-min native background task): wrong outcome.** agy held the turn silently; after 15 minutes without events the
  Internal API run watchdog declared `TURN_STALLED` and aborted the turn, killing agy and the background command
  (journal 01:23:15). The stream process's own 30-min tool-stall timer would have killed it next. **Lane B (rewritten):**
  a known, running agy background task keeps its turn alive against both idle rules; the hard ceilings stay.
- **The between-turns idle timer and the session eviction path are not changed**: no live failure, because agy keeps
  the turn open while work is pending (advisor point 3 recorded, not built).
- A model-chosen `nohup … &` daemon (T1B) never wrote its marker: agy-side behaviour, out of scope.
- The queued-prompt race probe (T4) is dropped: agy emits one `result` per turn even across a self-wake, so the FIFO
  head is not consumed early on current agy.

## P4 finding and correction (2026-11-22 02:40 UTC)

- The P4 re-run of T3 on the restarted production (lane B live) was again ended `TURN_STALLED` at 15 min. Root cause
  from agy 1.5.14's raw stream: it no longer prints "Tool is running as a background task …" on the stream; a demoted
  command is one `run_command` step that stays `ACTIVE` until the command ends. Lane B keyed on that banner, so it
  never fired. **Lane B2** makes the watchdog also defer while the live stream has a tool step in flight (already
  tracked as `activeToolSteps`). Lane B's banner path stays for agy versions that print it.
- Bound kept on purpose: a silent tool is still cut by the stream's 30-min tool-stall timer
  (`ANTIGRAVITY_TOOL_STALL_TIMEOUT_MS`) and the 60-min hard turn timer. The post-B2 live check therefore uses a
  20-minute command (between the 15-min watchdog and the 30-min tool stall).
- Unscheduled follow-ups (not built): on agy 1.5.14 the browser's background-task strip no longer shows demoted
  commands (same banner change); raising the tool-stall cap above 30 min if longer silent commands turn out to matter.

## Outcome (R3, 2026-11-22 04:05 UTC)

| Item | Result | Evidence |
|---|---|---|
| Lane C — provider error classes | Live since 02:11 UTC: quota pauses a goal at once; 500/503 back off 30 s / 90 s (`retryNotBefore`, survives restart); run receipts carry `PROVIDER_QUOTA_EXHAUSTED` / `PROVIDER_TRANSIENT`; failed-turn `agent_end` carries `errorClass`/`resetAt`. Contract 1.70.0, Agent OS mirror in step. | unit tests; Sonnet review ACCEPT WITH FIXES (fixes = contract bump, done); no live error injection (cannot force a real quota error cheaply) |
| Lanes B + B2 — known pending work keeps an agy turn alive | Live since 03:37 UTC. P4c: a 20-minute background command ran to completion; receipt `completed`, `finalText` "STARTED\nDONE", marker written; journal shows the watchdog's idle rule deferred instead of `TURN_STALLED`. Before the fix (T3, P4) the same shape was killed at 15 min. | probe/P4C-T3S timeline; journal 03:42–03:58 |
| Lane A — "told finished early" | Dropped: does not reproduce on agy 1.5.14 (T1, T2, P4-T1). | probe results |

Limits kept on purpose: a silent agy tool is still cut by the stream tool-stall (30 min) and the hard turn timer
(60 min); the receipt `turnMaxMs` (6 h) is unchanged.

Unscheduled follow-ups (recorded, not built):
- The deferral info log fires every 10 s while a run is deferred (the watchdog ticks every second; "every 10th"
  deferral); make it time-based (e.g. once a minute) and say "tool in flight" when that is the reason.
- On agy 1.5.14 the browser's background-task strip no longer shows demoted commands (banner gone from the stream).
- Raise the 30-min silent-tool cap only if longer silent commands turn out to matter.
- Re-run T1, T3S and the raw-wire capture after an agy version jump (agy updates itself).

## Decision log
- 2026-11-22 R3: P4c passed; programme closed; September §1.1 note marked superseded.
- 2026-11-22 P4: lane B did not fix the live failure (banner absent on agy 1.5.14); lane B2 dispatched.
- 2026-11-22 R1: lane A dropped; lane B rewritten as "known background work keeps the turn alive"; lane C accepted
  with fixes (contract 1.70.0 bump + Agent OS mirror delegated to a contract lane); P4 re-runs T3 after the restart.

- 2026-11-22 P1c: critical advisor (GPT-6.1 Terra) — accepted: classify only failed-turn envelopes, persist backoff (`retryNotBefore`) against overlapping sweeps, add a queued-prompt race probe (T4) and a no-work control, verify probes against agy's own transcript; lifecycle option (a) only if settle signals prove reliable, else surface pending state and gate goals/watchers on it; idle guard covers the service eviction path too.
- 2026-11-22 P0: plan written from `claude:6d0291e5` items 33 and 53; probes and lane C start in parallel.
