# Antigravity post-turn work and error storms — plan

**Status:** in execution (started 2026-11-22). **Owner:** Valtteri. **Parent:** Claude Code session `cd78fe71`.
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

## Decision log

- 2026-11-22 P1c: critical advisor (GPT-6.1 Terra) — accepted: classify only failed-turn envelopes, persist backoff (`retryNotBefore`) against overlapping sweeps, add a queued-prompt race probe (T4) and a no-work control, verify probes against agy's own transcript; lifecycle option (a) only if settle signals prove reliable, else surface pending state and gate goals/watchers on it; idle guard covers the service eviction path too.
- 2026-11-22 P0: plan written from `claude:6d0291e5` items 33 and 53; probes and lane C start in parallel.
