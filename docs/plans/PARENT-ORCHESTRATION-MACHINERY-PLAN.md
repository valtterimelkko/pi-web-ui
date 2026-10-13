# Parent orchestration machinery — silent wake failures, missing verbs, capacity honesty, lighter skills, a lane-runner pilot (plan)

Status: READY — written 2026-10-13 by the planning parent; owner decisions in §3. Not yet executing.

Planning parent: Claude Code RC session `claude:fcb7ddb1` (Opus) — open it with
`npm --prefix /root/agent-os run -s agent-os -- worklog handoff claude:fcb7ddb1`.
Canonical discovery: this file → §12 status ledger → the executing parent's ops STATE file (to be created under
`/root/orch-ops/parent-machinery-<date>/STATE.md`) → each lane's evidence README.
Repositories in scope: `/root/pi-web-ui` (server, contract, docs), `/root/pi-orch` (client CLI, **public**),
`/root/claude-enhancement/mods/watch-wake` (Claude watch-wake mod), `/root/pi-enhancement/watch-wake` (Pi
extension), and the skills in `/root/.skills-global/skills-global` (`pi-web-ui-internal-api-orchestration`,
`long-horizon-waiting-strategies`, `agent-os-child`). Read each repo's `AGENTS.md` before working in it.

Sibling plans written in the same sitting:
- Agent OS: `/root/agent-os/docs/plans/MEMORY-THAT-REACHES-AGENTS-PLAN.md` (its lane W1-d injects this plan's parent
  card after compaction).
- Measurement: `/root/jev-session-eval/docs/plans/CONTINUITY-AND-ORCHESTRATION-MEASUREMENT-PLAN.md` (the rerunnable
  parent-machinery audit that reads every KPI below).

---

## 0. Read this first (for the executing agent)

1. Executed by other agents. Every item carries its **why** and its evidence. The evidence base is
   `/root/orch-ops/parent-machinery-analysis-20261013/REPORT.md` (cited below as **PMR**, with its F/M/S/B ids) and
   its `findings/` and `evidence/extracts/` (transcript citations like `0798cc10[2821]` resolve there, ±3 items; the
   extracts are mode 600 and must never leave this host). Open the evidence before designing.
2. Guardrails: `pi-orch` is **public** — TDD, `npm test`, and gitleaks before every push. `pi-web-ui` production
   restarts need the owner's authority (§10) and go through `npm run production:drain-restart`. Any Internal API
   contract bump updates the Agent OS mirror in the same wave (pi-web-ui `docs/INTERNAL-API-CONTRACT.md` →
   "Downstream mirrors"; memory rule `contract-mirror-rule`). Run the CI gate list, including
   `npm run lint:ratchet -- --base <lane base>`, before merging.
3. One mechanism per lane; each lane names the KPI it moves. No new instruments or gates (the measurement plan owns
   measurement). Owner rule: no over-engineering; cut anything whose answer cannot change a decision.
4. Skills change only through the skill-creator skill in `/root/.skills-global/skills-global`.

## 1. Intent

**The outcome:** a parent agent on any harness can dispatch, wait for and verify Internal API children **without the
owner stepping in about orchestration**, without silent multi-minute stalls, without hand-written curl, and without
re-reading 60–80k tokens of skills after every compaction.

**Why now — what the 2026-10-13 analysis of ~175 children from 10 parents found (PMR §2–§3):**

| Finding | Evidence |
|---|---|
| Waiting itself is largely solved: idle waits with watch-wake + model-free backstops are habitual; backstops caught every silent failure | PMR §3 "What works" |
| **Silent wake failures**, 26–46 min each: dead watch conditions written from memory after compaction — the mod answered "Watching" to `{"type":"goal_end"}` (F1; verified by the planning parent at `59206036[2821]` and `[2997]`); `pi-orch` sends `dataMatch:{objective:"*"}` when `--objective` is omitted, which strict equality never matches (F2; `/root/pi-orch/src/cli.ts:780-781`, `src/builders.ts:195-201`, server `condition-evaluator.ts:170-173`; verified); a goal reads `running` while its session is idle (F3) | PMR F1–F3 |
| **Missing `pi-orch` verbs → 30–95 raw curl calls per long parent** (goal pause/resume/show, reroute, lease, `status --json` empty) — the skill itself sanctions curl for goal pause/resume | PMR F6, F19; `SKILL.md:140-141` |
| **Capacity surprises**: the Claude Sonnet profile is capped at 2 concurrent sessions, unadvertised; a third spawn is accepted then fails instantly with `RUNTIME_ERROR` (F8; `server/src/claude/claude-profiles.ts:74`, `claude-sdk-service.ts:284-289`; verified). All 11 profiles in `~/.pi-web-ui/claude-profiles.json` sit at the default 2 (checked 2026-10-13); the cap dates from the June profiles feature (`c03bffc2`) with no recorded reason. Quarantined admission debt refused spawns while memory was free (F9) | PMR F8, F9 |
| **Compaction is the main degrader of Claude parents**: parents over 24 h with 4–6 compactions needed 8–10 owner interventions about orchestration each, many "re-read the two skills"; parents under 8 h needed 0–2. Mandatory reading is ≈ 61k tokens before a single-wave dispatch, ≈ 77k for a programme | PMR F14, §2.3; skill sizes re-measured 2026-10-13 (`pi-web-ui-internal-api-orchestration/SKILL.md` 8,667 words; waiting skill 6,027; `agent-os-child` 3,520) |
| **Briefs are strong but heavy**: 40–60 % repeated skill text, up to three hand-back markers per lane; the goal verify command checks the hand-back's format, not the gates | PMR B1–B2, F10 |
| **Spurious and misleading wakes** (receipt-driven `goal_end`, old goal clears, wake caps refreshed by hand) cost ~12 wasted wake turns in one programme | PMR F4 |
| **Hand-repeated lane loops**: spawn → watch → goal → wait → gates → reviewer → correction was run by hand about 75 times across five parents | PMR M17 evidence row; §6 |

**Owner direction recorded 2026-10-13** (planning session): Internal API orchestration is the **default** for every
harness (now in the canonical global `AGENTS.md`), because it keeps model routing and quota policy under control;
Agent-tool children only when the Internal API is unavailable or the owner says so. This retires PMR D4 and S2's
"Agent tool as default" option, M15 (cloud-child watch) and M16 (Agent-tool lineage).

## 2. KPIs (read from the rerunnable parent-machinery audit, measurement plan M2, plus `pi-orch`'s audit log)

| Id | KPI | Baseline | Target |
|---|---|---|---|
| P1 | Silent dead watches registered (a registration that can never fire, accepted) | ≥ 3 incidents in two weeks (F1, F2) | 0: refused at registration by mod, `pi-orch` and server |
| P2 | Missed-wake minutes per programme caught only by backstops | 26–46 min per incident (F1–F3) | 0 from F1/F2 classes; F3 stalls surfaced within 15 min |
| P3 | Raw curl calls to the Internal API per long parent session | 30–95 (F6) | ≤ 5 |
| P4 | Owner interventions about orchestration per long (> 24 h) parent | 8–10 (PMR §3 table) | ≤ 3 |
| P5 | "Re-read the skills" owner prompts per long parent | up to 5 (`0798cc10`) | 0 |
| P6 | Mandatory reading before a Claude parent's first dispatch | ≈ 61k tokens (single wave), ≈ 77k (programme) | ≤ 20k (parent card + routing) |
| P7 | Spawns accepted then failed by a capacity cap | 3 sessions + a failed trial (F8) | 0: refused before creation with a reason, or served by the overflow route |
| P8 | Lane-runner pilot: parent turns per lane, owner interventions per lane, wall-clock per lane | measured from the hand-run lanes in `/root/orch-ops/phone-steward/p9/` and `orchestration-scaling/k/` (measurement plan M2 computes them) | runner ≤ 50 % of hand-run parent turns with no rise in owner interventions; keep/kill decided ≤ 7 days after first use (§6 W4) |

## 3. Owner decisions recorded

| Id | Decision | When |
|---|---|---|
| O1 | Raise the Claude profile concurrency cap clearly; the planning parent recommended ~8 (a fuse against one parent emptying the subscription) rather than removal; owner agreed raising | 2026-10-13 |
| O2 | When more Claude Sonnet is needed than the cap allows, or another agent holds the slots, the parent **asks the owner** to authorise the `pi` · `anthropic` · `anthropic/claude-sonnet-5-5` route (PAYG Anthropic API credit; $74.10 ample on 2026-10-13, $64.03 promotional expiring 2026-10-28). Never automatic | 2026-10-13 |
| O3 | Lane runner: pilot it, attached to clear KPIs (P8) with a fast keep/kill decision, not after weeks | 2026-10-13 |
| O4 | Internal API is the default child path; Agent-tool children only when unavailable or owner-requested (global `AGENTS.md` line 58) | 2026-10-13 |
| O5 | Claude Code dynamic workflows are not adopted for orchestration: their agents are Claude subagents on the session's subscription, they cannot hold goals or take mid-run input, and they bypass the Internal API's routing, admission and quota control. Third-party Pi workflow extensions (`pi-subagent-workflow`, `@tintinweb/pi-subagents`, `@anishthite/pi-better-workflows`) run Pi processes directly and bypass the Internal API in the same way. The transferable idea — a script holds the loop and a journal, and the parent is woken only for judgement — is built on `pi-orch` instead (W4) | 2026-10-13 (planning parent's recommendation, owner agreed) |

## 4. What not to do

- Do not rebuild the retired conductor (`/root/agent-os/docs/reviews/2026-10-01-CONDUCTOR-RETIRED.md`): no contracts,
  sign-off machinery or gate stacks in the lane runner. It is a loop, a journal and an exit.
- Do not add review rounds: one review + one closure, then a parent-verified correction (PMR F16; memory
  `review-proportionality`).
- Do not install third-party Pi workflow packages on this host for this plan.

## 5. Must not regress

- `d52701a8` (server rejects unknown watch condition types with 400) and the 1.57–1.60 contract behaviours (NEVER_STARTED,
  restart auto-continue, quarantined-lease reconciliation `L1`).
- `pi-orch` J2 behaviours: strict unknown-flag rejection, fail-closed generation-safe watch deletion, the test suite never
  writes the real ledger (`91ae919`), route cap exit 25.
- watch-wake mod 0.2.0 outbox (held wakes coalesce; RC sessions allowed, `1e744f0`); `CLAUDE_WATCH_WAKE_ARMED` defers the
  Agent OS capture prompt.
- The R6 backlog items stay as recorded (`ORCHESTRATION-SCALING-READINESS-PLAN.md` §9 R6 row); fix one only if a lane
  here touches its code.

## 6. Waves

### W0 — Small fixes with direct incidents (parallel)

| Lane | Repo | Change | Why | Acceptance |
|---|---|---|---|---|
| W0-a | pi-orch | No objective → omit `objective` from `dataMatch` (never `"*"`); with M3 (W2-a) later, key on goal id | F2 (verified); incident `antigravity-61f40f85[745]–[751]` (46 min) | RED: `watch register --conditions goal_end` without `--objective` fires on a disposable server's `goal_end`; objective-filtered tests stay green |
| W0-b | claude-enhancement watch-wake mod, pi-enhancement watch-wake | Validate conditions locally before registering: known `type`s, `eventType` required for `event_type`, `dataMatch` values primitive and top-level (dotted keys refused — shallow match, memory `internal-api-children-lessons`); refuse with the correct shape in the message | F1 (`59206036[2821]`, `[2997]`); P1 | RED unit test in `hooks/core.ts`: `{"type":"goal_end"}` refused naming `{"type":"event_type","eventType":"goal_end"}` |
| W0-c | pi-web-ui + config | Raise `maxConcurrent` for the Claude SDK profiles in `~/.pi-web-ui/claude-profiles.json` to 8 (profiles hot-reload, `claude-profiles.ts:170`); raise the schema default from 2 to 8; advertise per-profile `maxConcurrent` and current use in `/capacity` (and `/models` profile entries) | F8 (verified); O1; P7 | A third and fourth concurrent Sonnet child run; the ninth is refused **before** creation with a reason naming the profile cap (contract bump → Agent OS mirror) |
| W0-d | pi-orch | Route limits default to the advertised profile caps; exit 25 names the cap and, for Claude profiles, prints the O2 overflow hint ("ask the owner to authorise pi·anthropic/claude-sonnet-5-5") | F8; O2 | RED test with a mocked `/capacity` |
| W0-e | skills | `routing.md` + `claude-code-orchestrator.md`: the cap, how to read it, and the O2 rule (ask the owner, quote the `anthropic-api` balance from `agent-os provider-usage`, never automatic). `references/pi-orch.md` + waiting skill: never hand-write watch JSON (copy the canonical block per child kind), always pass `--objective` until W0-a ships, the on-wake triage list (receipt-driven `goal_end`, early `agent_end` from background shells, self-paused goals, dropped idle steer). `pi-orch.md`: `cleanup --owner` works without `--lease`; `--id-only` drops the lease; cancel watches before cleanup | PMR S3, S4, S5; F4, F7, F19 | Text present; one dry dispatch by a fresh parent follows it without curl |
| W0-f | skills (`agent-os-child`) | Move the host traps in so common briefs stop copying them: symlinked `node_modules` + never `npm ci` in a lane worktree; no repository-wide git housekeeping (reflog expire, gc, prune, stash clear); move gitignored evidence out before `git worktree remove`; never resolve conflicts in a live checkout | PMR S7, F18; memories `worktree-npm-symlink-hazard`, `shared-repo-housekeeping-ban`, `worktree-remove-deletes-ignored`, `live-checkout-merge-rule` | A COMMON brief template shrinks by that block |

### W1 — The parent card (P5, P6) and lighter briefs

| Lane | Change | Why | Acceptance |
|---|---|---|---|
| S-1 **Parent card** | One page per skill pair (≤ ~1,500 words): the rules that bit (F1–F19 in one line each), the per-harness copy-paste sequences (Claude Code, Pi, Antigravity) for spawn → watch → backstop → dispatch → idle → on-wake → verify → cleanup, the on-wake triage list, the routing summary and the O2 overflow rule. Card = Tier 1; the rest becomes reference read only when the card points there. Store at `pi-web-ui-internal-api-orchestration/references/parent-card.md` and point both skills' Tier 1 at it | PMR S1, F14, P6; principle "procedure travels best as files" (PMR §2.3) | ≤ 1,500 words; a fresh Sonnet parent completes a one-child dispatch from the card alone on a disposable task; the Agent OS plan's W1-d injects this file after compaction |
| S-2 **Child path** | Replace any "Agent tool vs Internal API" choice text with the O4 rule (Internal API first; Agent tool only when unavailable or owner-requested), and fold the four memory notes in | O4; PMR F12 | present |
| S-3 **Review proportionality** | SKILL §3c + `multi-phase.md`: findings must be able to change the decision; Claude-family reviewer for safety-critical code; a quick "ACCEPT, no findings" from a cheap reviewer is a weak signal; time-box reviews | PMR S6, F16, F17 | present; round cap unchanged |
| S-4 **Programme kit as files** | Ship the P9 kit (`/root/orch-ops/phone-steward/p9/`: COMMON.md, P9-A.md, objectives.sh, REVIEW-, CORR-, handback/) and the SI non-code kit (`/root/si/workshop-04-2026/case-studies/_brief/`) as template files; one STATE template with a single RESUME HERE block; brief template: objective ≤ ~60 words, protocol left to `agent-os-child`, **one** hand-back marker, a machine-readable `GATES:` block at the end, stop conditions as time and tool-call caps | PMR S8, B1–B3; STATE files reached 560 and 739 lines | a new programme copies files, not prose |
| S-5 **Antigravity parent rules** | `antigravity-orchestrator.md`: `--objective` on every goal watch; goal after create; single-line objectives; release gates enforced; no live-checkout conflict resolution | PMR S9, F15 | present |

### W2 — `pi-orch` verbs and server goal semantics (P2, P3)

| Lane | Repo | Change | Why | Acceptance |
|---|---|---|---|---|
| W2-a | pi-web-ui + pi-orch | Stamp `goalId` on `goal_end` / `goal_state`; builders match on it; suppress `goal_end` from a receipt that never started | PMR M3, F4 | a new goal on a reused child is not woken by the old goal's clear; a NEVER_STARTED steer fires no `goal_end` |
| W2-b | pi-web-ui | Emit `goal_state` `stalled` when a goal reads `running` and its session has been idle N minutes (default 10) | PMR M11, F3 (`66a28c2c[737]–[780]`) | a watch on `stalled` fires for a reproduced P10-A-style stall on a disposable server |
| W2-c | pi-orch | `goal <sid> pause\|resume\|show`; `reroute <sid> --model SEL [--thinking L]` (pause goal → abort → set_model → resume with the same objective) | PMR M5, M6, F6 (`66a28c2c[1099]–[1168]`, 45 min) | the skill's raw-request exception for goal pause/resume (`SKILL.md:140-141`) is deleted; live reroute of a busy goal child in < 2 min with the goal intact |
| W2-d | pi-orch | `prompt --mode deliver` (steer if busy, otherwise follow-up, atomic) and report queue depth; `status --json` filled (busy, status, lastRun); `result --final`; `leaseId` stored in the ledger; `cleanup --owner` in bulk, cancelling watches first | PMR M7, M8, F7, F19 (`f04d1539[457]`) | `status --json` non-null for a live child; bulk cleanup leaves no lease or watch orphans |
| W2-e | pi-orch | Append-only spawn ledger (prune the view, never the data) and an audit log `~/.pi-orch/audit.jsonl` (verb, owner, caller session, exit code, duration) | PMR X2, X3; needed for P3 and P8 without regex counting | the measurement plan's scorecard reads curl-vs-verb counts from it |
| W2-f | pi-web-ui | Name quarantined admission debt as its own refusal reason; `pi-orch spawn --wait-admission S` | PMR M10, F9 | refusal body names quarantine; `--wait-admission` spawns when it clears |
| W2-g | pi-orch + pi-web-ui | Completion template: stop delivering it as a queued follow-up (it rode into the L1 admission leak and produced `TEMPLATE_NOT_DELIVERED`); put the pointer in the objective and the full text in the brief template (S-4). `verify` runs the brief's `GATES:` block (commands + expected exits) and fails on a red gate | PMR M12, M13, F10, B2 | no `Report instructions…` follow-up in a goal child's transcript; `verify` re-runs a lane's gates |

Contract bumps in W2 ship together where possible (one minor version), with the Agent OS mirror updated in the same
wave. Production restart authority for W0-c (server part) and W2 is requested in §10.

### W3 — (reserved; nothing planned)

Kept empty on purpose: if R2 finds a defect, a bounded correction goes here. No other wave is added.

### W4 — Lane-runner pilot (O3; P8)

**What it is, in plain words:** a small TypeScript program over the existing `pi-orch` module (`/root/pi-orch/src/index.ts`
exports the client), started by the parent as an ordinary background process (Claude `run_in_background`, Pi `bg_run`,
Antigravity `run_command`). For one lane it does what parents now do by hand: spawn the implementer (with the routing
policy's route and an `agent-os provider-usage` check) → register the watch → start the goal → wait → run the brief's
`GATES:` block → spawn a cross-family reviewer → on REJECT send one bounded correction to the **same** implementer →
review closure → done. It keeps a journal (`<lane>/runner-journal.jsonl`) so a restarted run resumes, writes one STATE
row per step, and **exits** — which wakes the parent on every harness — only at judgement events: a child question, a
reviewer verdict to adjudicate, gates red after the correction cap, a capacity refusal needing the O2 owner question, or
done. Process exit was the one wake that worked on every harness in the evidence (PMR §6).

**Why:** ~75 hand-run loops (PMR M17 evidence: `f04d1539` 5×17 steps, `59206036` ~24, `66a28c2c` ~10, `6e459c42` ~12,
`218ce4d5` ~15) and compaction amnesia (F14) — the procedure lives in code instead of in the parent's context.

| Step | What | Done when |
|---|---|---|
| W4-a | Build `pi-orch lane run <brief-dir>` (TDD; mocked client; journal resume test; exit codes per judgement event) | suite green; gitleaks clean |
| W4-b | Live trial on a disposable server with two toy lanes (one passes, one needs a correction) | both reach the right exit; journal resumes after a kill |
| W4-c | **Pilot on one real lane** of the next real programme (any repo), side by side with that programme's hand-run lanes | P8 numbers for the pilot lane vs the hand-run lanes, read by the measurement plan's M2 scorecard |
| W4-d | **Keep/kill within 7 days of W4-c**: keep if parent turns per lane ≤ 50 % of hand-run with no rise in owner interventions and no missed wake; otherwise archive it and record the measured negative | owner sees the numbers and the recommendation |

## 7. Gates for every code lane

pi-web-ui: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, `npm run lint:ratchet -- --base <lane
base>`, live proof on a disposable server (`pi-web-ui-live-validation` skill), never production. pi-orch: `npm test`
(hermetic), gitleaks, contract snapshot refreshed when the server contract changes. Mods: `node --test` on the pure
core, `claude plugin test`, `scripts/deploy.sh` (never redeploy under a waiting parent). Reviewer child of a different
family per lane; one review + one closure.

## 8. Context budget

| Item | Today | After |
|---|---|---|
| Mandatory parent reading before first dispatch | ≈ 61k–77k tokens | ≤ 20k (card + routing table) |
| Parent card injected after compaction (Agent OS plan W1-d) | none; owner re-prompts | ≈ 2k tokens, parents with live children only |
| Child brief (COMMON + lane) | ≈ 2,600–3,300 words, 40–60 % repeated | lane brief ≤ ~800 words; protocol in `agent-os-child` |

## 9. Execution shape and routing

Internal API first (O4). Suggested routes after `agent-os provider-usage`: W0 lanes Class 1 (DeepSeek v4.1 Flash or
GLM 5.3 Flash); server lanes (W0-c, W2-a/b/f/g) Class 2 (Claude Sonnet 5.5 or GLM 5.3) with a cross-family reviewer;
skill lanes (S-1…S-5) Claude Sonnet 5.5 (writing-quality work). The skills and mod lanes are independent of the server
lanes and can run in parallel. Concurrent writers each get an isolated worktree; never `npm ci` in a lane worktree.

Review points: **R1** after W0 + W1 (P1, P5, P6, P7); **R2** after W2 (P2, P3); **R3** after W4-d (P4, P8) — close.

## 10. Waiting on the owner

| Item | Since | Ref |
|---|---|---|
| Production restart authority for the W0-c server change and the W2 server lanes (drain-restart, one per wave) | 2026-10-13 | §6 W0-c, W2 |

## 11. Amendments

| When (UTC) | Change | Why |
|---|---|---|
| 2026-10-13 | Plan written; PMR M15, M16, D4 and the Agent-tool half of S2 dropped | owner direction O4 |
| 2026-10-13 | Global `AGENTS.md` de-conflicted at the owner's request (canonical `/root/.codex/AGENTS.md` commit `1137142`, mirrored to every harness): Internal API first for all child sizes; own-harness subagents only when it is unavailable or the operator asks. Waiting row removed | owner request in `claude:fcb7ddb1` |

## 12. Status ledger

| When (UTC) | Milestone |
|---|---|
| 2026-10-13 | R0: plan written; owner decisions O1–O5 recorded; execution not started |
| 2026-10-13 | Global AGENTS.md conflict resolved (codex `1137142`); only restart authority still waits |
