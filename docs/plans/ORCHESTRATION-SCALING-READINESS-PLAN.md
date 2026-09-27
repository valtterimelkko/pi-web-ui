# Orchestration Scaling Readiness Plan

> **Status:** R1 held 2026-09-27 (§8). A1 soak finished early with a proven leak, and two retainers are named. Stage B is cleared: B0 (harness fixes) and B1 (fix the retainers) come first, then the confirmation soak. B3/B4 and A2 may run in parallel.
> **Created:** 2026-09-26 from the Pi Web UI / Internal API deep review (owner-requested).
> **Owner review session:** the Claude Code session `fc35fbf1-7f12-4962-9243-da710409fb56` ("Internal API Review"). **Review moments** are held with the owner, in that session or, if its context is exhausted, by a fresh Opus agent that first follows §7 (handoff).
> **Evidence:** [`docs/reviews/2026-09-26-INTERNAL-API-DEEP-REVIEW.md`](../reviews/2026-09-26-INTERNAL-API-DEEP-REVIEW.md).
> **Primary repository:** `/root/pi-web-ui`. Companion when a step says so: `/root/agent-os` (contract mirror), `/root/.skills-global/skills-global` (orchestration skill).
> **Production service:** `pi-web-ui.service` (port 3456). Restarts are owner-gated, one approval per restart or batch.

## 0. How to use this file

- This is the **plan of record** for making Pi Web UI ready for substantially more Internal API orchestration. It resumes the direction of the paused Phases 8–9 of [`PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md`](./PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md), but only through Stage D below and only after the owner authorises it at a review moment. Until then that plan's pause stands.
- The capacity work of [`INTERNAL-API-CAPACITY-SCALING-AND-ORCHESTRATION-ROBUSTNESS-PLAN.md`](./INTERNAL-API-CAPACITY-SCALING-AND-ORCHESTRATION-ROBUSTNESS-PLAN.md) is executed and live (Tier 2: 16 active / 14 API turns). It is the baseline here, not open work.
- Work runs in **stages**, and each stage ends at a **review moment** with the owner. An execution agent must not start the next stage before its review moment has happened and been recorded in §8.
- **No time estimates.** Steps are ordered by dependency and priority. The only durations stated are real parameters of the work (a soak window, a sampling interval, a timeout).
- Keep this file current. When a step starts, ships, is changed at a review moment, or is dropped, edit §9 (and §8 for review moments) in the same change.

## 1. Intent and rationale

The owner intends to scale Internal API orchestration up soon. The 2026-09-26 review found that **capacity is not the constraint and stability has improved**, but three things make heavier orchestration unsafe or expensive:

1. **One process does everything.** Browser sockets, the Internal API and every in-process Pi agent share one Node event loop and one 4 GiB V8 heap. One runaway session can starve the whole service (the 2026-09-12 stall: a 131k-token generation plus quadratic tool-argument parsing), and every restart kills in-process children.
2. **Heap grows with uptime, and admission cannot see it.** Admission budgets the 18 GiB cgroup, PIDs and host pressure. It ignores the 4 GiB heap cap and event-loop lag. Heap climbed to 1.5–1.9 GB with 0–2 sessions resident; about three restarts per day hide the growth. *(R1, 2026-09-27: proven by the A1 soak. Every Pi session the server disposes stays in memory, held by two named retainers; see [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md).)*
3. **Orchestration costs parents too much.** Parents spend heavy effort on plumbing (hand-written curl, sleep loops, guessing request shapes) and had to correct child results in about four sessions in ten. 43% of children hit workspace problems.

The goal is **more completed, verified child work per unit of parent effort, with bounded failure domains**. The goal is not the largest possible session count.

### 1.1 The owner's intent, in full

- **Why now.** The owner wants to use Internal API orchestration much more (parents dispatching children across runtimes and models), in the near future. The earlier resource-scaling plan paused its capacity phases because that load was not arriving. The premise has now changed from the owner's side.
- **What "ready" means to the owner:**
  - robust (children are not lost, stalled silently or killed by deploys);
  - properly resourced (limits that actually bind are the ones that are watched);
  - architecturally sound (one session cannot take down the rest);
  - cheap to supervise (parents spend their effort on the task, not on plumbing).
- **Evidence over assertion.** Decisions rest on measured production data and real session history, re-measured with the same instruments afterwards (§4, measurement discipline). A plausible story is not a finding until it is measured; the heap growth is treated as unproven until the soak.
- **How the owner wants to work:**
  - Execution agents, which the owner dispatches, do the building between review moments.
  - The owner reviews at each review moment together with an Opus review agent. This is ideally the original review session; if its context is exhausted, a fresh Opus agent. §8 exists so a fresh agent loses nothing.
  - The review agent's own effort goes to analysis, verification and plan-keeping, not to writing code. Code is delegated and then verified by reading diffs and re-running gates.
- **Constraints the owner set:**
  - no time estimates;
  - production restarts owner-gated;
  - OpenRouter only with explicit permission (granted for the soak only);
  - never paid Command Code routes;
  - GLM peak window respected;
  - no synthetic sessions in Agent OS's board, worklog or vault.
- **Not the intent:**
  - adding capacity for its own sake;
  - a big-bang rewrite;
  - un-pausing the resource-scaling plan's Phase 8 without the owner's decision at R3.

### 1.2 Where the evidence lives

The full review, with method, numbers, audits, corrections and reproduction commands, is [`docs/reviews/2026-09-26-INTERNAL-API-DEEP-REVIEW.md`](../reviews/2026-09-26-INTERNAL-API-DEEP-REVIEW.md). §2 below is its summary. Where they differ, the review file is the source of truth for evidence, and this plan is the source of truth for what to do.

## 2. Evidence baseline (2026-09-26)

| Fact | Value | Source |
|---|---|---|
| Service limits | MemoryMax 18 GiB, MemoryHigh 14 GiB, TasksMax 8192, `--max-old-space-size=4096`, `PI_MAX_SESSIONS=20`, admission 16 active / 14 API turns, 512 MiB reserved per turn | `systemctl show`, `GET /api/v1/capacity` |
| Live usage | 0.43 GB service memory; OOM/high/max events 0; memory PSI 0 | cgroup `memory.events`, `/capacity` |
| Heap vs uptime | e.g. 391→1,918 MB in 7.8 h (24 Sep); median 1,505 MB at 0 resident sessions vs ~300 MB at 6–9 | journal `[MultiSessionManager] Memory:` lines, 12–25 Sep (11,586 samples) |
| Stability | 0 crashes since 15 Sep; 13 watchdog kills and ~45 failure exits July–14 Sep; 34 clean stops 15–25 Sep | `~/.pi-web-ui/stop-audit.log`, `journalctl _PID=1 UNIT=pi-web-ui.service` |
| Orchestration outcome | 70 real orchestration sessions: delivered ~60%, partial 18%, unclear 17%; supervision overhead 1.46 on 0–2; parent corrected child work in ~43% | Jev spec `piwebui-orch-parent` |
| Parent friction | waiting 21%, API misuse 13%, child quality 12%, refusals 11%, child stall 9%, service down 8%, provider 6%; 81% of socket calls hand-written curl; 42 of 70 parents used sleep loops; MCP adapter inactive | same + code census |
| Children | 322 registry children (September); 92% end cleanly; ~1% ended at a service stop; 43% hit workspace/tooling problems; only 149 of 322 record `parentSessionId` | Jev spec `piwebui-orch-children`, registry |
| Operator reports | 206 malfunction reports: orchestration 27%, voice 16%, stuck sessions 13%, performance 12%; 74% described as recurring; about a third fixed in-session | Jev spec `piwebui-operator-reports` |
| Restarts | 63% deploys; about half checked for active children first | Jev spec `piwebui-restarts` |
| Heap soak (A1, added at R1) | post-GC heap 146 → 4,044 MB in 5 h 03 min (≈514 MB/h), then V8 heap OOM; ≈4.4 MB retained per Pi child created; lag p95 1 ms; retainers `PiService.sessions` (dispose/unload paths skip `releaseSessionRefs`) and the `subagent` extension's per-session `process.once("exit")` | [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md) |
| Known defects | follow-up to a busy session can become `TURN_STALLED` after the 900 s window and never be delivered (22 never-executed runs in the journal); contract 1.15→1.47 in about eight weeks | journal, git log |

Jev specs live in `/root/jev-session-eval/specs/piwebui-*.toml` (commit `38e8277`). Runs are in `/root/jev-session-eval/runs/piwebui-*-v2` and `…-operator-reports-v3` (gitignored). Jev judgements are group-calibrated; the numbers above were audited against raw sessions, and two misleading measures (child "cut off", "polling") were replaced by code counts.

## 3. Owner decisions recorded 2026-09-26

- Scale-up of Internal API orchestration is intended in the near future.
- A 24-hour heap soak runs first. Load uses the Pi runtime with `zai/glm-5.3-flash` (off-peak) as the backbone, plus best-effort OpenRouter free models (owner permission granted **for the soak only**) and Command Code free models via the Pi runtime (only in the soak's isolated config; never paid Command Code routes). Free models can be congested (very slow or erroring), so neither the run nor its results may depend on them. The owner uses zai for other work during the soak, so the GLM lane obeys a 5-hour quota guard (read-only `agent-os provider-usage`): it throttles, then pauses, as remaining quota falls and during the GLM peak window, and resumes with hysteresis.
- The soak must be robust: gated rehearsals before the long run, self-healing, reattach without restarting the server, early checkpoints, and a usable partial result.
- Code for the soak harness is written by a delegated child and reviewed by the owner's review session.
- No time estimates in chat or plans.
- The owner returns to the review session at each review moment; between them the owner dispatches execution agents.

**Owner decisions recorded 2026-09-27 (R1):**
- A soak that fails partway is used as it stands, not repeated for its own sake. A1's early OOM is accepted as the result.
- There is a leak, and B1 fixes both named retainers. One is in this repo; the other is in the `pi-enhancement` extension store.
- The heap cap stays at 4 GiB for now. Raising it would only delay the OOM (at A1's rate, 8 GiB buys about 8 more hours). The cap is decided at R2 from the confirmation soak's numbers.
- Stage B proceeds, amended:
  - a new B0 fixes the soak harness first;
  - B2 must keep session disposal available at critical memory.
- The B1 confirmation soak also serves as A1's rerun.

## 4. Execution contract (applies to every step)

**Anti-premature-victory rules.** A step is done only when **every** item in its *Definition of victory* is met **and** the evidence bundle below exists. "Tests pass" alone is never victory for a step with live behaviour. Mocked fetch, fixtures standing in for real runtimes, or serial runs standing in for concurrent ones do not count unless the step says so. A reviewer (the owner's review session or an independent reviewer) re-runs at least the live validation before a step is marked shipped. Self-reported PASS without a re-run is `claimed`, not `shipped`.

**Evidence bundle per step** (under `docs/plans/execution-reports/orchestration-scaling/<step-id>.md`): commits; exact commands with exit codes for tests, lint, typecheck, build; live-validation commands, run directories, and key numbers; a positive control (the new test or check fails on the old code, or a planted fault is caught); what was not done and why; residual risks.

**Engineering rules.**
- Strict TDD for behaviour changes: failing test first, then the fix.
- Live-validate on a **disposable** validation server (`npm run validate:server`; see [`docs/LIVE-VALIDATION.md`](../LIVE-VALIDATION.md)), never against production, unless the step's production gate says otherwise and the owner approves.
- Any wire-visible change bumps the Internal API contract, updates `docs/INTERNAL-API.md` / `docs/INTERNAL-API-CONTRACT.md`, and keeps the Agent OS contract mirror in step (see [`PI-WEB-UI-MASTER-PLAN-2026-09-15.md`](./PI-WEB-UI-MASTER-PLAN-2026-09-15.md) W-E).
- Production restarts use `npm run production:lock -- …` and need owner approval each time. Once B4 ships, they use drain-then-restart.
- Isolation traps on this host: never hand-roll a server on production dirs; the Pi SDK reads `PI_CODING_AGENT_DIR`; never set `SESSION_DIR`; `NOTIFICATIONS_DIR` is not isolated by `validate:server`; workspaces go under `/root`.
- Run the repository gates from `AGENTS.md` (docs checks, lint, typecheck, build, relevant tests) before handing in.
- Concurrent writers use isolated worktrees with explicit owned and no-touch paths.

**Measurement discipline.** Re-measurements at review moments reuse the same instruments: the heap-soak harness (`scripts/heap-soak/`), the Jev specs (pinned `jev-1.13.0`), and the journal/stop-audit counts in §2. That keeps before and after comparable.

## 5. Sequence overview

```
Stage A  Measure            A1 heap soak (24 h)  ‖  A2 production heap/lag telemetry + alerts
            │
         ── Review moment R1 (held 2026-09-27): leak proven, two retainers named; heap cap deferred to R2 ──
            │
Stage B  Contain            B0 soak-harness fixes (before the confirmation soak)
                            B1 fix both retainers → confirmation soak (also A1's rerun)
                            B2 heap- and lag-aware admission, disposal kept available; heap cap set at R2
                            B3 per-run budgets (runaway generation cannot starve the loop)
                            B4 drain-then-restart deploys
            │
         ── Review moment R2: confirm soak on the Stage B build; go/no-go for Stage C ──
            │
Stage C  Parent ergonomics  C1 thin parent client   C2 busy follow-up + never-started runs
         and child quality  C3 child completion receipt + verify   C4 dispatch preflight
                            C5 lineage always recorded   C6 contract stability window
            │
         ── Review moment R3: Jev re-measure of parents/children; decide on Stage D ──
            │
Stage D  Structural         D1 contained child execution (Phase 7 shadow → routing; Phase 8 resumed if authorised)
                            D2 decompose the sessions route module along D1's seams
            │
         ── Review moment R4: failure-domain proof; production rollout decision ──
            │
Stage E  Prove and keep     E1 recurring-defect ledger (runs alongside from Stage B on)
                            E2 final re-measure (second 24 h soak + Jev re-run)
            │
         ── Review moment R5: programme close or next plan ──
```

Within a stage, steps without a dependency may run in parallel with separate owners. Stated dependencies:
- B1's confirmation soak needs B0 and both B1 fixes merged;
- B2's heap-cap choice needs the confirmation soak (R2), but its admission logic can be built alongside B1;
- A2 is independent and is worth landing early: it gives the production before-and-after for B1;
- B3 and B4 are independent of B0–B2;
- B0 and B1 touch disjoint paths (`scripts/heap-soak/` against `server/src/pi/` plus `pi-enhancement`), so they can run in parallel worktrees;
- C1 depends on C2, C4 and C5 landing in the same contract bump or before it;
- C3 builds on C1's dispatch template;
- D1 needs R3 authorisation.

## 6. Steps

### Stage A — Measure

#### A1 — 24-hour heap soak on a disposable server

**Intent.** Prove or refute memory growth with uptime under production-like load, and name what retains memory if it grows.
**Approach.** Harness in `scripts/heap-soak/` (see its README): an isolated disposable server under its own transient systemd unit, with the production heap cap and a local inspector. A sampler forces a full garbage collection before every reading and takes heap snapshots at start, middle and end. The load driver runs cycles of tool-using Pi children across three model lanes with circuit breakers, watches, parent-style polling, a browser-like socket client and orphan sweeps. A supervisor reattaches without restarting the server. Telegram pings go out at start, at checkpoints, on anomalies and at the end. Rehearsals come first: Gate 0 (preflight) and Gate 1 (compressed micro-soak with forced faults).
**Definition of victory.**
- [ ] Gate 0 and Gate 1 evidence re-run by the review session, both passing, including: supervisor killed and reattached to the same server PID with no CSV reset; a failing lane's circuit opens while load continues; the orphan sweep removes a planted child; production files checksummed unchanged.
- [ ] The 24 h run completes with post-GC samples covering at least 95% of sampling intervals, and no gap longer than three intervals except for declared snapshots.
- [ ] Load really happened: children created, prompted with at least one tool call each, and deleted in every cycle (counts in the report), meeting the per-cycle target. The GLM 5.3 Flash lane is the backbone and tops up any shortfall. The free OpenRouter and Command Code lanes are best-effort (often congested): their failures, timeouts and slowness are reported per lane, and neither the run's completion nor the verdict depends on them.
- [ ] `report.md` states the post-GC heap slope overall and per phase, idle-return behaviour, peak heap, lag statistics and a verdict against the rule written in the report **before** the run started.
- [ ] Snapshot comparison lists the top growing constructors, or explains precisely why it could not and leaves DevTools instructions.
- [ ] No production state changed (checksums before and after); all soak units stopped; the run directory is preserved.
- [ ] No synthetic data reached Agent OS: the production-write audit shows no soak-attributable writes under the Agent OS board store or memory vault, `~/.pi/agent`, or `~/.pi-web-ui` outside the run area, and `agent-os board who` lists no soak children during the run. The `agent-os-inject` extension stays loaded for realism, but its `agent-os` calls go to a local stub.
**Not victory if:** the verdict is inferred from `heapUsed` without forced GC; the server was restarted mid-run; only one lane worked and it was never exercised with tool calls; the run ended early and the report does not say so.
**Outcome (R1, 2026-09-27): complete with deviations, verdict accepted.**
- **The run:** the server hit V8 heap OOM after 5 h 03 min. Sample coverage was 20.8%.
- **The harness:** it did not detect the death, its report omits it, and its snapshot diff failed on the empty 12 h snapshot.
- **The analysis:** the leak and both retainers were established by hand from the start and threshold snapshots.
- The item-by-item check is in [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md) §5, and the harness defects feed B0.

#### A2 — Production heap and lag telemetry with alerts

**Intent.** See heap and event-loop health continuously in production instead of reconstructing it from the journal, and be warned before trouble.
**Scope.** The server's memory/health observation path (`server/src/pi/multi-session-manager.ts` memory check, `server/src/internal-api/event-loop-shed.ts`, `server/src/observability/*`), notifications for alerts, config knobs.
**Approach.** Append a compact time series (heapUsed, heapTotal, heap limit, rss, external, event-loop lag p50/p99/max, active turns by class, resident sessions, registry entries) to a size-bounded, rotating file under `~/.pi-web-ui/metrics/`. Log the memory line on significant change plus a low-frequency heartbeat, instead of at today's frequency. Add a Telegram alert with hysteresis when heap exceeds a configurable fraction of the heap limit, or lag p99 exceeds a configurable threshold.
**Definition of victory.**
- [ ] Unit tests: rotation bound, hysteresis (no alert flapping), threshold maths against the real `heap_size_limit`.
- [ ] Disposable live proof: lowered thresholds make exactly one alert fire and then one recovery message; the metrics file grows at the configured cadence and rotates at its bound.
- [ ] After an owner-approved production restart, the production metrics file is present and growing, and `journalctl` volume for the memory line has measurably dropped (lines per hour before and after).
- [ ] `docs/OBSERVABILITY.md` documents the file, fields, knobs and alert semantics.
**Not victory if:** the alert is proven only with mocks; the file is unbounded.

#### Review moment R1 (owner + review session)

Inputs: A1 report and snapshot comparison, A2 status, current `/capacity`.
Decide and record in §8: (a) whether there is a leak and its retainer, which sets B1's scope, or B1 is dropped; (b) the heap-cap choice for B2: raise `--max-old-space-size` towards the cgroup budget, lower `PI_MAX_SESSIONS`, or both, grounded in soak numbers; (c) whether Stage B proceeds as written.
**Held 2026-09-27** (§8):
- (a) yes, two retainers;
- (b) deferred to R2;
- (c) proceeds, with B0 added and B1/B2 amended.

### Stage B — Contain the blast radius

#### B0 — Soak-harness fixes (added at R1)

**Intent.** The confirmation soak must be a trustworthy instrument. A1 showed the harness can report "complete" for a run whose server died.
**Scope.** `scripts/heap-soak/*`, `server/src/live-validation/heap-soak/*`, the harness README. Nothing in the production server.
**Approach.** Fix the five defects in [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md) §6:
1. **Server death:** detect it (unit state, main PID, socket), end the run as `server_died` with the time, and say so in `report.md` and in the Telegram message.
2. **Snapshot fallback:** compare against the latest non-empty snapshot, and add a retainer-path and cut summary. Port the logic of the run directory's `analysis/retainers.mjs` and `cut2.mjs`; it runs in the existing large-heap worker.
3. **Sampler columns:** make the resident-session and registry columns distinct, and explain the 1,702 sessions listed at t=0.
4. **Soak memory limit:** choose it so that cgroup admission does not throttle the load profile before the heap cap binds; record the chosen value and why.
5. **Production-write audit:** detect writes made by soak processes, not mentions of the run ID.
**Definition of victory.**
- [ ] Tests for each fix (TDD).
- [ ] Positive control in a disposable micro-soak: kill the soak server mid-run. The run ends as `server_died` within a few sampling intervals, and the report and the Telegram message both say so.
- [ ] Positive control for fix 2: a planted empty snapshot still yields a comparison from the latest valid one, with retainer paths.
- [ ] The audit gives no false positive when an operator session mentions the run ID.
**Not victory if:** death detection relies on the sampler's own failures alone, or the retainer summary exists only as a separate manual script.

#### B1 — Fix what retains memory (retainers named at R1)

**Intent.** Remove the growth, rather than only admitting around it.
**Retainers (named at R1 with snapshot evidence, [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md) §3).** Each one alone keeps every deleted Pi child alive; together they hold about 80% of the heap.
1. **`PiService.sessions` (this repo).**
   - `MultiSessionManager.disposeSession` and `unloadSession` never call `piService.releaseSessionRefs`; only `stopSession` does.
   - Internal API DELETE (`disposeLoadedSession`) and idle browser cleanup (`unloadSession`) both leak.
   - Commit `91effe69` claimed this fix for all three paths but wired one.
2. **The `subagent` extension's module-level `process.once("exit")` (`pi-enhancement` store; deployed at `~/.pi/agent/extensions/subagent/index.ts`).**
   - Extensions are evaluated per session, so every session adds a process listener that closes over its session context.
   - Fix it in the store repo, never in the deployed copy.
**Approach.**
- (1) Route every dispose/unload path through one release helper, with a failing test per path first.
- (2) Register the exit hook once per process (a `globalThis` guard) or remove it on `session_shutdown`.
- Add a host-side regression test in this repo: repeated Pi session create/dispose cycles leave `process.listenerCount('exit')` (and the other signals) unchanged and `PiService` holding no session. It guards against any extension repeating the pattern.
- Then run the confirmation soak.
**Definition of victory.**
- [ ] Both retainers are fixed. Regression tests fail on the old code and pass on the new: one per dispose path, the listener-count test, and the extension's own test in `pi-enhancement`.
- [ ] Disposable proof before the soak: a short create/delete loop, with heap snapshots before and after, shows `AgentSession` count back to the live count.
- [ ] **Confirmation soak** (also A1's rerun) on the B0 harness, same load profile, **24 h window** (proposed at R1; the owner may change it at dispatch):
  - the run completes with the server alive;
  - post-GC slope under the A1 verdict threshold (10 MB/h);
  - idle stretches return to baseline;
  - the retainer summary shows no deleted child retained. If growth remains, name the third retainer.
- [ ] The extension fix is deployed to `~/.pi/agent/extensions` through the store's normal path. A production restart to pick up both fixes is owner-gated.
**Not victory if:** growth is "fixed" by raising limits or adding periodic restarts; only one retainer is fixed; the soak ran on a build missing either fix.

#### B2 — Heap- and lag-aware admission, heap cap aligned

**Intent.** Admission refuses new API work before the process is in danger, using the limits that actually bind.
**Scope.** `server/src/internal-api/admission-controller.ts`, capacity route and types, config, systemd unit or `.env.production` for the chosen cap, docs, contract.
**Approach.** Add refusal reasons `heap_pressure` (projected heap against a configurable fraction of `heap_size_limit`) and `event_loop_lag` (sustained lag above threshold). Expose both on `GET /api/v1/capacity`. Keep the P0/P1 control reserve working under pressure. Apply the heap-cap decision from R2 (deferred there at R1).
**R1 evidence for this step.**
- In A1, admission refused only on cgroup pressure, because the soak unit had a 6 GiB `MemoryMax`. With production's 18 GiB it would have admitted everything until the 4 GiB heap OOM.
- At the critical floor, `wrapControl` returned `503 CONTROL_CRITICAL` to DELETE: it refused the one operation that frees memory.
- **Session disposal (DELETE, cleanup, batch delete) must therefore stay available at every pressure level.** It is exempt from the control emergency floor, or has its own reserve.
- Refusing prompts alone does not stop create-time growth. Heap pressure must gate creates as well.
**Definition of victory.**
- [ ] Unit tests for both refusal reasons, including boundaries, hysteresis and that control-class work still passes.
- [ ] Unit tests: session disposal succeeds at the critical floor, while creates and prompts are refused under `heap_pressure`.
- [ ] Disposable live proof: with lowered thresholds, a P2 create/prompt gets `503 ADMISSION_CAPACITY_EXHAUSTED` with the new reason and `Retry-After`; admission recovers when pressure clears; a P0/P1 control call succeeds while P2 is refused; a DELETE succeeds at the critical floor.
- [ ] Contract bump and docs; Agent OS mirror updated.
- [ ] After an owner-approved restart, production `/capacity` shows the new fields with sane values, and the heap cap matches the R2 decision.
**Not victory if:** only the capacity output changed and admission does not act on it.

#### B3 — Per-run budgets against runaway generations

**Intent.** No single turn can monopolise the event loop or heap.
**Approach.** Configurable per-turn caps on output tokens or streamed bytes, and on streamed tool-argument size. On breach, abort that turn with a new terminal error code (for example `RUN_BUDGET_EXCEEDED`) recorded in its run receipt and visible to the parent. Check that tool-argument parsing stays linear.
**Definition of victory.**
- [ ] Tests: breach detection per cap; the receipt carries the terminal code; parsing cost is linear in input size (a benchmark-style test with growing inputs).
- [ ] Disposable live proof with a fixture that reproduces the 2026-09-12 pattern (very long generation with streamed tool arguments): the turn is aborted at the cap; during the run, a second session keeps streaming and measured event-loop lag stays under the B2 threshold.
- [ ] The parent sees the terminal state through its watch or receipt without polling.
**Not victory if:** the cap exists but the 12 Sep-style fixture still pushes lag over threshold.

#### B4 — Drain-then-restart deploys

**Intent.** Deploys stop killing in-flight children silently.
**Approach.** A `production:drain-restart` path: admission enters `draining` (new P2/P3 work refused with a distinct code and `Retry-After`); wait for active turns and nonterminal receipts to settle up to a configurable timeout; notify affected parents; then restart. After boot, report every run that was cut off, with a terminal status such as `interrupted_by_restart`. Make it the default in deploy scripts; restarting without a drain requires `--force` plus a recorded reason in the stop audit.
**Definition of victory.**
- [ ] Tests for the draining state machine, the timeout path and post-boot reconciliation.
- [ ] Disposable live proof: three children mid-turn; drain-restart lets those that finish within the timeout finish; any cut off get `interrupted_by_restart`; their parents' watches fire; the stop audit records the drain result.
- [ ] Deploy documentation (`DEPLOYMENT.md`) and the production-lock wrapper use drain by default.
**Not victory if:** drain waits only for turns and ignores nonterminal receipts, or parents learn about interruptions only by polling.

#### Review moment R2

Inputs: B0–B4 evidence bundles; the B1 confirmation soak (24 h, per R1); A2 production telemetry, ideally spanning the production restart that picked up B1.
Decide:
- go/no-go for Stage C;
- the heap-cap choice deferred from R1 (raise `--max-old-space-size`, lower `PI_MAX_SESSIONS`, or neither), from the confirmation soak's per-session heap and peak;
- any threshold changes;
- whether B1 needs another round (a third retainer).

### Stage C — Parent ergonomics and child quality

C1–C5 should ship in one contract bump where practical, so that C6's stability window starts from a coherent surface.

#### C1 — Thin parent client

**Intent.** Parents stop hand-writing curl, guessing shapes and sleeping in loops.
**Approach.** A small CLI plus importable module (in this repo or a sibling repo, decided by the executor with rationale) with verbs: `spawn`, `prompt`, `wait` (watch-based, idle until woken, with a deadline), `result` (receipt final text plus evidence pointer), `verify` (C3), `cleanup`, `status`. It always sends `X-Parent-Session` from the caller's session identity, honours `Retry-After`, and uses meaningful exit codes. Request and response types derive from the server's schemas so drift fails a test. Update the orchestration skill (canonical source only: `/root/.skills-global/skills-global/pi-web-ui-internal-api-orchestration`, using the skill-creator skill) to prefer the client.
**Definition of victory.**
- [ ] Contract/drift test: changing a server route schema without updating the client fails CI.
- [ ] Every orchestration pattern in the skill's `references/patterns.md` runs through the client in a disposable live test.
- [ ] Disposable live proof: a real parent agent (GLM 5.3 Flash via Pi) orchestrates at least five children end-to-end with **zero** raw socket curl calls and **zero** sleep calls in its transcript (counted in code).
- [ ] The skill is updated and the old curl recipes are marked as fallback.
**Not victory if:** the client wraps curl in a shell script with the same failure modes, or `wait` polls.

#### C2 — Busy follow-ups and never-started runs

**Intent.** No prompt is ever silently lost, and a run that never starts is known quickly.
**Approach.** Reproduce first: a follow-up to a Pi session that stays busy beyond the inactivity window becomes `TURN_STALLED` and never reaches the session. Then fix it so the follow-up is either delivered after the running turn ends or refused explicitly (`409 SESSION_BUSY` with a hint), never accepted-then-dropped. Add start detection: an accepted run with no runtime activity within a configurable start window is marked with a distinct terminal state and the parent is notified.
**Definition of victory.**
- [ ] A reproduction test fails on the old code; the fix passes it.
- [ ] Disposable live proof over repeated real-model trials: every follow-up to a busy session is either delivered or explicitly refused; zero accepted-then-lost prompts; never-started runs surface within the configured window.
- [ ] The journal on the validation server shows no "never executed" stalls during the trials.

#### C3 — Child completion receipt and parent verification

**Intent.** Cut the roughly four-in-ten rate at which parents must correct child results.
**Approach.** Define a structured completion block that children emit at the end of their task (commands with exit codes, tests and results, commits, files changed, open issues), requested by the client's dispatch template and captured into the run receipt. `verify` re-checks cheap facts: commits exist, files changed, optionally re-runs a named test command.
**Definition of victory.**
- [ ] Schema and parser tests, including malformed blocks.
- [ ] Disposable live proof: at least 90% of N real GLM 5.3 Flash children produce a parseable block (N set by the executor and stated in advance).
- [ ] Positive control: a planted false claim (a non-existent commit, or a test claimed to pass that fails) is caught by `verify`.

#### C4 — Dispatch preflight

**Intent.** Children stop failing on missing paths and tools (43% hit workspace problems).
**Approach.** At spawn, check that the working directory exists and is writable, referenced paths exist, and declared tools are on `PATH`. Fail fast with `PREFLIGHT_FAILED` listing what is missing, before any model token is spent.
**Definition of victory.**
- [ ] Tests for each check.
- [ ] Disposable live proof: a dispatch with a missing path is refused before a runtime turn starts (no provider call in the receipt).

#### C5 — Lineage always recorded

**Intent.** Every child is traceable to its parent (today 149 of 322).
**Approach.** Record the parent from `X-Parent-Session` or, when absent, from the caller's session identity if the server can resolve it. Add a list filter by parent.
**Definition of victory.**
- [ ] Tests for both sources and the filter.
- [ ] Disposable live proof: 100% of children created in C1's live test have `parentSessionId` in the registry.

#### C6 — Contract stability window

**Intent.** Let parents and skills catch up with a stable surface (the contract moved 1.15→1.47 in about eight weeks).
**Approach.** After C1–C5 ship, declare a stability window in `docs/INTERNAL-API-CONTRACT.md`: bug fixes only, no new wire features, unless the owner grants an exception. The owner sets the window's length at R3.
**Definition of victory.**
- [ ] Declared in the contract doc and in the orchestration skill; the drift test from C1 guards it.

#### Review moment R3

Inputs: C-stage evidence; re-run of the Jev specs `piwebui-orch-parent` and `piwebui-orch-children` over sessions after C shipped, compared with the §2 baseline (supervision overhead, API-misuse share, correction rate, workspace-problem rate, lineage coverage); A2 telemetry.
Decide: whether Stage D proceeds; authorise resuming Phase 8 of the resource-scaling plan if so; the C6 window length.

### Stage D — Structural isolation

#### D1 — Contained child execution

**Intent.** A child's runaway, crash or heap blow-up cannot take down the control plane or other children.
**Approach.** Take the Phase 7 shadow implementation ([resource-scaling plan, Phase 7](./PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md)) to contained routing for Internal API children: children run in per-session workers with their own heap and event loop and per-worker cgroup limits (Phase 6 pilot). Refresh the design against Stage B's findings before building. Decide explicitly whether workers survive a main-process restart.
**Definition of victory.**
- [ ] Design note updated in `docs/PROCESS-ISOLATION-DESIGN.md`, reviewed at R3/R4.
- [ ] Disposable adversarial proof: a child forced past its heap limit, or into an event-loop hang, kills only its worker; the main process lag stays under the B2 threshold; other children keep streaming; the parent receives a terminal state.
- [ ] The A1 soak harness run against the contained build shows main-process heap flat under the same load.
- [ ] Production rollout only after R4, owner-gated.

#### D2 — Decompose the sessions route module

**Intent.** `server/src/internal-api/routes/sessions.ts` (7,762 lines) and `server/src/websocket/connection.ts` (4,623) are where most fixes land. Split them along the seams D1 creates.
**Definition of victory.**
- [ ] No behaviour change: the full test suite passes with only import-path edits; route and contract snapshots are identical before and after.
- [ ] No resulting module above an agreed size, or a documented reason for each exception.

#### Review moment R4

Inputs: D1 adversarial proof and contained soak; D2 evidence.
Decide: production rollout of contained routing, and its observation gate.

### Stage E — Prove and keep

#### E1 — Recurring-defect ledger (runs alongside from Stage B onward)

**Intent.** Stop the 74% of operator-reported problems that recur (stuck after compaction, performance, orchestration).
**Approach.** A short ledger in `docs/` of recurring defect classes, each with a pointer to a regression test once fixed. When a class recurs, its test is added before the fix.
**Definition of victory.**
- [ ] The ledger exists with the classes from the 2026-09-26 operator-reports run, plus "a fix claims every path but wires one". Found at R1: `91effe69` fixed one of three dispose paths. The B1 per-path tests are its regression tests.
- [ ] Each fixed class links a regression test that fails on the pre-fix code.

#### E2 — Final re-measure

**Approach.** A second 24 h soak with the A1 harness on the final build, plus a re-run of all five Jev specs over the period since Stage C shipped.
**Definition of victory.**
- [ ] Soak verdict: no growth beyond the A1 threshold, or growth explained and bounded.
- [ ] Jev comparison table against §2, with the same model pin and specs, and deltas stated with n.

#### Review moment R5

Decide: close the programme, or open the next plan.

### Small items (any stage, low risk)

- Remove orphaned `session-registry.json.*.tmp` files at boot (after confirming no writer holds them). Victory: test plus disposable boot proof.
- Command Code admits one active turn. Revisit only if children are routed there. Victory: decision recorded at a review moment.

## 7. Handoff for the agent holding a review moment

This section exists so a fresh Opus agent can hold any review moment with the same understanding as the original review session.

**Read, in this order:**
1. This plan: §1 intent, §3 decisions, §4 contract, §9 status ledger.
2. [`docs/reviews/2026-09-26-INTERNAL-API-DEEP-REVIEW.md`](../reviews/2026-09-26-INTERNAL-API-DEEP-REVIEW.md): evidence, audits, what was corrected and why.
3. The evidence bundles of the steps finished since the last review moment, in `docs/plans/execution-reports/orchestration-scaling/`.
4. For R2: [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md) first (the R1 analysis, retainers, harness defects), then the B0/B1 bundles and the confirmation soak's run directory.
   - Verify the soak server stayed alive throughout (unit journal), rather than trusting the report.
   - Re-run the retainer summary on its snapshots.
   Historical (R1): `scripts/heap-soak/README.md` and the soak run directory `/root/.pi-web-ui/validation/heap-soak/full-1790411484255-ec8b813c/` (`report.md`, `samples.csv`, `events.jsonl`, `snapshots/`, `run-state.json`). Check status with `npx tsx scripts/heap-soak/cli.ts status --run-id full-1790411484255-ec8b813c`. If `report.md` is missing after the window, run `… cli.ts report --run-id full-1790411484255-ec8b813c`; it works on partial data. If the server died mid-run, that is a result: read `events.jsonl` and the threshold snapshots. Compare snapshots by constructor (the report's snapshot section), and read `A1-harness.md` §11 for the early Gate 1 signal.
5. `agent-os recall "orchestration scaling readiness"` for anything captured since.

**Durable locations:**

| What | Where |
| --- | --- |
| Jev specs (same instruments for re-measurement) | `/root/jev-session-eval/specs/piwebui-*.toml` |
| Baseline Jev runs | `/root/jev-session-eval/runs/piwebui-*-v2`, `…-operator-reports-v3` (gitignored, on disk) |
| Analysis scripts | `/root/jev-session-eval/analyses/2026-09-26-piwebui-review/` (README lists usage) |
| Baseline data snapshots | `/root/jev-session-eval/runs/piwebui-review-2026-09-26-data/` |
| Soak harness | `scripts/heap-soak/` (CLI: `npx tsx scripts/heap-soak/cli.ts preflight|micro|start|status|stop|report`) |
| A1 soak run and R1 retainer analysis | `/root/.pi-web-ui/validation/heap-soak/full-1790411484255-ec8b813c/` (`analysis/retainers.mjs`, `analysis/cut2.mjs`: run with `node --max-old-space-size=14000 <script> <snapshot> …`); write-up [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md) |
| R1 Agent OS captures (session `38c5e91e-…`) | pending `cand-vdfe26jqoo` (soak result), `cand-wciwwujtl7` (retainer 1), `cand-x9sdyy1bj2` (retainer 2, `project-pi-enhancement`), `cand-2jzse2quu8` (harness defects), `cand-13vcqtm014` (B2 findings), `cand-3hjd6rdqtl` (horizon), `cand-4ebrxoznhs` (snapshot method) |
| Production facts | `~/.pi-web-ui/stop-audit.log`; `journalctl _PID=1 UNIT=pi-web-ui.service`; `GET /api/v1/capacity` |
| Owner's Agent OS captures from the review | pending candidates `cand-0gnuybo3bq`, `cand-0gny36rl3t`, `cand-2pogxjh7gk`, `cand-4ljzs8qfin`, `cand-53hz776nzx`, `cand-5kfhn7c512`, `cand-60yt4fipab`, `cand-6husy6w66n`, `cand-6z5m0ozg7p`, `cand-36j5xixlub` (corrected by `cand-yppzzcsbrp`); session-end set: `cand-vdw7vxafvz` (no time estimates), `cand-vtuzs529p5` (delegate code, verify), `cand-way3izcdwy` (horizon: soak running, next steps), `cand-wscddwcy01` (soak harness), `cand-xa3ftv25k0` (early heap signal), `cand-xrm28o1wt8` (review record and plan), `cand-y8kizkr1h6` (Agent OS isolation for validation children) |

**How to hold a review moment:**
1. Verify, don't trust. Re-run each finished step's live validation, or at least its cheapest decisive check. Read diffs, not reports: an `agent-os oracle` query shows which files an execution agent actually touched. Mark anything not re-run as `claimed`.
2. Re-measure with the named instruments and compare against §2 using the same definitions. State n and any change of population.
3. Put each decision listed under that review moment to the owner, with a recommendation and its trade-offs. Record the decisions in §8 and, where they change intent, in §3.
4. If the evidence changes the plan, rewrite the affected steps in place (no competing plan files), and note what changed and why in §8.
5. Capture durable outcomes to Agent OS (the capture skill), then tell the owner which steps are cleared for execution agents.

**Rules a fresh agent must not relearn the hard way:**
- **Isolation traps:** a hand-rolled server on production dirs once deleted 276 production sessions. The Pi SDK reads `PI_CODING_AGENT_DIR`. Never set `SESSION_DIR`. `NOTIFICATIONS_DIR` is not isolated by `validate:server`. Keep workspaces under `/root`.
- **Validation children pollute Agent OS unless isolated:** set `AGENT_OS_BIN`, put a PATH stub first, and set `BOARD_STORE_DIR`, `AGENT_OS_VAULT_ROOT` and a fake `HOME` (the soak harness shows how).
- **Dependency installs:** this host runs `NODE_ENV=production`, so `npm install` prunes devDependencies; use `NODE_ENV=development npm install …`.
- **Journal searches:** grepping the 3.8 GB journal over long windows times out; use the stop audit and PID-1 unit messages.
- **Completion messages are not proof of life.** A1's harness sent "complete" 19 h after its server died. Check the subject's unit journal before believing a long run's result.
- **"All paths" claims need a per-path check.** `91effe69` said every dispose path was fixed and wired one. Grep the sibling call sites a fix claims to cover.
- **Constructor diffs do not name a leak; retainer paths and cut tests do.** When cutting one suspected retainer frees nothing, look for a second.

## 8. Review moment log

Record each review moment here: date, who held it (session id), inputs checked, decisions, plan changes.

| Review moment | Date | Held by | Decisions and plan changes |
| --- | --- | --- | --- |
| (plan creation) | 2026-09-26 | `fc35fbf1-7f12-4962-9243-da710409fb56` | Plan created from the deep review. Soak design amended three times by the owner: free lanes are best-effort, the zai quota guard, and no synthetic data in Agent OS. |
| (soak launch) | 2026-09-26 | `fc35fbf1-7f12-4962-9243-da710409fb56` | Harness verified and merged; 24 h soak launched on owner go. Owner-approved cleanup: 97 synthetic `memory-vault/derived/inject/sessions/*.json` files from pre-fix rehearsals deleted (list in `/root/jev-session-eval/runs/piwebui-review-2026-09-26-data/vault-soak-files-removed.txt`); 6 usage-ledger recall lines left in place (append-only history). Owner's next steps: a fresh Opus session to re-check this plan's comprehensiveness, then a fresh Opus session for R1 once the soak window ends. |
| R1 | 2026-09-27 | `38c5e91e-6849-4f04-8b6b-301eb79468ab` (fresh Opus; "Int api program") | **Inputs checked:** `report.md`, `run-state.json`, `events.jsonl`, the soak unit's journal (V8 OOM at 13:34:40 UTC), the start and 1 GiB/2 GiB threshold snapshots (constructor diff, retainer paths, cut test), the code of the dispose paths, and commit `91effe69`. Not checked: A2 (not started) and production checksums. **Decisions (owner accepted the recommendations):** (a) leak proven, two retainers, B1 fixes both; (b) heap cap unchanged, decided at R2 from the confirmation soak; (c) Stage B proceeds. A1 is accepted as complete with deviations and is not repeated; the B1 confirmation soak (24 h) is its rerun. **Plan changes:** §1 item 2 and §2 updated with the soak result; §3 records the R1 decisions; new B0 (harness fixes); B1 rewritten around the named retainers, a cross-repo fix in `pi-enhancement`, and a host-side listener-count test; B2 amended (disposal available at critical memory, creates gated by heap, cap from R2); R2 inputs and decisions updated; E1 seeded with the "claims every path, wires one" class; §7 read-order and rules updated. Evidence: [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md). |

## 9. Status ledger

| Step | Status | Evidence | Notes |
|---|---|---|---|
| A1 | **complete with deviations; verdict accepted at R1**. Run `full-1790411484255-ec8b813c`: server V8 heap OOM after 5 h 03 min (146 → 4,044 MB post-GC); coverage 20.8%; harness missed the death | [`A1-harness.md`](./execution-reports/orchestration-scaling/A1-harness.md), [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md); run dir `/root/.pi-web-ui/validation/heap-soak/full-1790411484255-ec8b813c/` | Not repeated; the B1 confirmation soak is its rerun |
| A2 | not started | — | Independent; land early to give B1 a production before-and-after |
| R1 | **held 2026-09-27** | §8 | Leak proven, two retainers named; heap cap deferred to R2; Stage B cleared |
| B0 | not started, **cleared** | — | Harness fixes; before the confirmation soak |
| B1 | not started, **cleared** | — | Two retainers (this repo + `pi-enhancement`); then the 24 h confirmation soak |
| B2 | not started, **cleared** | — | Admission logic can be built alongside B1; heap cap waits for R2 |
| B3–B4 | not started, **cleared** | — | Independent of B0–B2 |
| C1–C6 | not started | — | |
| D1–D2 | not started | — | Needs R3 authorisation |
| E1–E2 | not started | — | |
