# Orchestration Scaling Readiness Plan

> **Status:** Stage A in progress (A1 soak harness being built). Nothing else started.
> **Created:** 2026-09-26 from the Pi Web UI / Internal API deep review (owner-requested).
> **Owner review session:** the Claude Code session `fc35fbf1-7f12-4962-9243-da710409fb56` ("Internal API Review"). Every **Review moment** below is held there, with the owner.
> **Primary repository:** `/root/pi-web-ui`. Companion when a step says so: `/root/agent-os` (contract mirror), `/root/.skills-global/skills-global` (orchestration skill).
> **Production service:** `pi-web-ui.service` (port 3456). Restarts are owner-gated, one approval per restart or batch.

## 0. How to use this file

- This is the **plan of record** for making Pi Web UI ready for substantially more Internal API orchestration. It resumes the direction of the paused Phases 8–9 of [`PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md`](./PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md), but only through Stage D below and only after the owner authorises it at a review moment. Until then that plan's pause stands.
- The capacity work of [`INTERNAL-API-CAPACITY-SCALING-AND-ORCHESTRATION-ROBUSTNESS-PLAN.md`](./INTERNAL-API-CAPACITY-SCALING-AND-ORCHESTRATION-ROBUSTNESS-PLAN.md) is executed and live (Tier 2: 16 active / 14 API turns). It is the baseline here, not open work.
- Work runs in **stages**, and each stage ends at a **review moment** with the owner. An execution agent must not start the next stage before its review moment has happened and been recorded in §7.
- **No time estimates.** Steps are ordered by dependency and priority. The only durations stated are real parameters of the work (a soak window, a sampling interval, a timeout).
- Keep this file current. When a step starts, ships, is changed at a review moment, or is dropped, edit §7 in the same change.

## 1. Intent and rationale

The owner intends to scale Internal API orchestration up soon. The 2026-09-26 review found that **capacity is not the constraint and stability has improved**, but three things make heavier orchestration unsafe or expensive:

1. **One process does everything.** Browser sockets, the Internal API and every in-process Pi agent share one Node event loop and one 4 GiB V8 heap. One runaway session can starve the whole service (the 2026-09-12 stall: a 131k-token generation plus quadratic tool-argument parsing), and every restart kills in-process children.
2. **Heap grows with uptime, and admission cannot see it.** Admission budgets the 18 GiB cgroup, PIDs and host pressure. It ignores the 4 GiB heap cap and event-loop lag. Heap climbed to 1.5–1.9 GB with 0–2 sessions resident; about three restarts per day hide the growth.
3. **Orchestration costs parents too much.** Parents spend heavy effort on plumbing (hand-written curl, sleep loops, guessing request shapes) and had to correct child results in about four sessions in ten. 43% of children hit workspace problems.

The goal is **more completed, verified child work per unit of parent effort, with bounded failure domains**. The goal is not the largest possible session count.

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
| Known defects | follow-up to a busy session can become `TURN_STALLED` after the 900 s window and never be delivered (22 never-executed runs in the journal); contract 1.15→1.47 in about eight weeks | journal, git log |

Jev specs live in `/root/jev-session-eval/specs/piwebui-*.toml` (commit `38e8277`). Runs are in `/root/jev-session-eval/runs/piwebui-*-v2` and `…-operator-reports-v3` (gitignored). Jev judgements are group-calibrated; the numbers above were audited against raw sessions, and two misleading measures (child "cut off", "polling") were replaced by code counts.

## 3. Owner decisions recorded 2026-09-26

- Scale-up of Internal API orchestration is intended in the near future.
- A 24-hour heap soak runs first. Load uses the Pi runtime with `zai/glm-5.3-flash` (off-peak) as the backbone, plus best-effort OpenRouter free models (owner permission granted **for the soak only**) and Command Code free models via the Pi runtime (only in the soak's isolated config; never paid Command Code routes). Free models can be congested (very slow or erroring), so neither the run nor its results may depend on them. The owner uses zai for other work during the soak, so the GLM lane obeys a 5-hour quota guard (read-only `agent-os provider-usage`): it throttles, then pauses, as remaining quota falls and during the GLM peak window, and resumes with hysteresis.
- The soak must be robust: gated rehearsals before the long run, self-healing, reattach without restarting the server, early checkpoints, and a usable partial result.
- Code for the soak harness is written by a delegated child and reviewed by the owner's review session.
- No time estimates in chat or plans.
- The owner returns to the review session at each review moment; between them the owner dispatches execution agents.

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
         ── Review moment R1: soak verdict; decide B1 scope and the heap-cap choice ──
            │
Stage B  Contain            B1 fix what retains memory (if R1 finds it)
                            B2 heap- and lag-aware admission, heap cap aligned
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

Within a stage, steps without a dependency may run in parallel with separate owners. Stated dependencies: B2 needs A1's data; B3 and B4 are independent of B1/B2; C1 depends on C2, C4 and C5 landing in the same contract bump or before it; C3 builds on C1's dispatch template; D1 needs R3 authorisation.

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
**Not victory if:** the verdict is inferred from `heapUsed` without forced GC; the server was restarted mid-run; only one lane worked and it was never exercised with tool calls; the run ended early and the report does not say so.

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
Decide and record in §7: (a) whether there is a leak and its retainer, which sets B1's scope, or B1 is dropped; (b) the heap-cap choice for B2: raise `--max-old-space-size` towards the cgroup budget, lower `PI_MAX_SESSIONS`, or both, grounded in soak numbers; (c) whether Stage B proceeds as written.

### Stage B — Contain the blast radius

#### B1 — Fix what retains memory (conditional on R1)

**Intent.** Remove the growth, rather than only admitting around it.
**Approach.** From the snapshot comparison, identify the retaining structure (candidates to check, not conclusions: per-session maps that outlive sessions, unpruned tombstone sets in `server/src/internal-api/session-disposal.ts`, run-receipt and watch stores, diagnostics buffers, registry caches). Write a failing test that shows unbounded growth over repeated create/prompt/delete cycles, then fix it.
**Definition of victory.**
- [ ] The retainer is named with snapshot evidence (constructor, retaining path).
- [ ] A regression test fails on the old code and passes on the new.
- [ ] A confirmation soak with the A1 harness, the same load profile, and a window the owner sets at R1 shows a post-GC slope under the A1 verdict threshold.
**Not victory if:** growth is "fixed" by raising limits or adding periodic restarts.

#### B2 — Heap- and lag-aware admission, heap cap aligned

**Intent.** Admission refuses new API work before the process is in danger, using the limits that actually bind.
**Scope.** `server/src/internal-api/admission-controller.ts`, capacity route and types, config, systemd unit or `.env.production` for the chosen cap, docs, contract.
**Approach.** Add refusal reasons `heap_pressure` (projected heap against a configurable fraction of `heap_size_limit`) and `event_loop_lag` (sustained lag above threshold). Expose both on `GET /api/v1/capacity`. Keep the P0/P1 control reserve working under pressure. Apply the heap-cap decision from R1.
**Definition of victory.**
- [ ] Unit tests for both refusal reasons, including boundaries, hysteresis and that control-class work still passes.
- [ ] Disposable live proof: with lowered thresholds, a P2 create/prompt gets `503 ADMISSION_CAPACITY_EXHAUSTED` with the new reason and `Retry-After`; admission recovers when pressure clears; a P0/P1 control call succeeds while P2 is refused.
- [ ] Contract bump and docs; Agent OS mirror updated.
- [ ] After an owner-approved restart, production `/capacity` shows the new fields with sane values, and the heap cap matches the R1 decision.
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

Inputs: B1–B4 evidence bundles; a confirmation soak on the Stage B build (window set at R1); A2 production telemetry since B2 shipped.
Decide: go/no-go for Stage C; any threshold changes; whether B1 needs another round.

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
- [ ] The ledger exists with the classes from the 2026-09-26 operator-reports run.
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

## 7. Status ledger

| Step | Status | Evidence | Notes |
|---|---|---|---|
| A1 | in progress — harness being built by a delegated child; 24 h run not started | — | Rehearsal Gates 0/1 required before launch |
| A2 | not started | — | |
| R1 | pending | — | Held in the owner review session |
| B1–B4 | not started | — | |
| C1–C6 | not started | — | |
| D1–D2 | not started | — | Needs R3 authorisation |
| E1–E2 | not started | — | |
