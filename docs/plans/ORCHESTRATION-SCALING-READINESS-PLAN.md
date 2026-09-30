# Orchestration Scaling Readiness Plan

> **Status:** R1 held 2026-09-27; interim review held 2026-09-28 (§8). Wave 1 (A2, B0, B1) and the **interim wave (B0.1, B1.1, B1.2 with B1.3)** are shipped and in production since the owner-approved restart on 2026-09-29 00:05 UTC. **2026-09-29 follow-up (owner rule: no local patches to upstream packages):** both local patches are removed. B1.2b replaces the pi-core extension-factory patch with the public SDK API; B3a (the tool-argument part of B3) replaces the pi-ai toolstream patch with a pi-web-ui-side budget; `subagent` shipped with owner option B (B1.3). All were deployed at the 2026-09-29 10:10 UTC restart. **B1.2 production telemetry:** 0 spike minutes in the first 4 h of the patch-free build (baseline 0.77/h; §9). **Wave 2 (B2, B3b, B4) is merged** (`d017f145`, contract 1.51.0; every lane Luna-reviewed and parent-verified) and **in production since the owner-approved restart on 2026-09-29 14:44 UTC** (build `1103ef11`; restarted with `production:drain-restart`, which used its legacy pre-flight because the old server had no drain endpoint). **R2 decisions held 2026-09-29 (§8):** the owner accepted the review session's recommendations, and an **R2 follow-up wave** is added (§6, after Review moment R2). **R2 follow-up wave shipped 2026-09-29** (V2; B4.1, B5, B3c; B2.1 dropped) together with **C4, C5**, the weekly-refresh budget and the E1 ledger (wave 3, contract 1.56.0; in production since the drain-restart on 2026-09-29 20:59 UTC, §8). **C2, C1 and C3a merged 2026-09-30 and in production since the drain-restart at 03:33 UTC** (contract 1.58.0, build `6544b886`; the orchestration skill now prefers the `pi-orch` client). **C6 stability window declared 2026-09-30** (opens at 1.58.0; the owner sets its length at R3). **C3b (client half of C3) shipped 2026-09-30** (`/root/pi-orch` `559aef5`: completion template, `result`, `verify`; Luna REJECT → correction 01 → closure ACCEPT). **Stage C is complete. R3 opened 2026-09-30 (§8):** the review verified Stage C and read the CPU evidence. It found that agents' tool commands share the service's cgroup, that one session slowed production at two active turns, and that the zai route stops working above about 5–8 concurrent children. An **R3 follow-up wave (G1–G5)** is added. **R3 decisions held 2026-09-30 (§3):** Stage D starts with **D0** (move agents' tool processes out of the control plane's cgroup); D1 and Phase 8 are decided at R4; the admission cap stays at 15; the C6 window runs to programme close without blocking planned work; the Jev re-measure moves into E2; and E2's 24 h soak becomes a bounded run. **Next: the R3 follow-up wave and D0, orchestrated by the R3 session.** Side work after Stage C (owner requests 2026-09-30, outside this plan): publishing `pi-orch` and a public skill pack; GitHub CI portability fix (`45831561`); the Agent OS contract-mirror guard. Server-side fixes reach production only at an owner-approved restart.
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
| Confirmation soak (B1 build, added 2026-09-28) | 24 h alive; post-GC heap 143 → ~195 MB warm-up in the first four hours, then flat at ~200 MB (trailing slope 0.31 MB/h); 8,092 children; peak 242 MB; lag max 130 ms. Residual: file-watcher state for deleted session files grows ~0.16 MB/h | [`B1-confirmation-soak.md`](./execution-reports/orchestration-scaling/B1-confirmation-soak.md) |
| Production health telemetry (A2, added 2026-09-28) | First 22 h after the 2026-09-27 17:39 restart: heap healthy (sampled 88–515 MB). Event-loop lag p99 ≥ 300 ms in 17 distinct minutes (maximum 919 ms), all with 0–3 active API turns and most while resident sessions jumped (for example 3 → 20). The soak's API-only load never reproduced this | `~/.pi-web-ui/metrics/health-metrics.jsonl` |
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

**Owner decisions recorded 2026-09-28 (interim review, after the confirmation soak):**
- B1 is shipped. The subagent extension's single last-context slot (`backgroundStatusCtx`, one `AgentSession`) is accepted as bounded.
- **Heap cap: unchanged.** Keep `--max-old-space-size=4096` and `PI_MAX_SESSIONS=20`. The fixed build's floor is ~200 MB post-GC with a 242 MB peak, far below the cap. This settles the heap-cap question deferred from R1, so R2 no longer decides it.
- **An interim wave runs before wave 2**, as three bounded steps. None needs a 24 h soak.
  - B0.1: harness fixes.
  - B1.1: the residual file-watcher growth, proven with synthetic churn.
  - B1.2: attribute and remove production event-loop lag spikes. This comes first because B2's lag gate would otherwise refuse API work because of browser activity.
- **Long soaks are expensive; keep them to a minimum.** E2's final soak is the only 24 h soak left in the plan. D1's contained-build check uses a bounded run. Other validation uses synthetic, fast checks wherever they can decide the question.

**Owner decisions recorded 2026-09-29 (during the interim wave):**
- **No local changes to upstream packages** (`@earendil-works/*`): no patches, no `dist` edits, no `postinstall` patching, no deep imports of private files. Upstream updates must not be able to break our processes. Where a patch served a real purpose, replace it robustly from our side: degrade gracefully at runtime (fallback plus a warning), and alarm loudly in CI (version pins). Both existing patches were removed (B1.2b, B3a).
- **`subagent`: option B.** One process-wide background registry keyed by session, with delivery routed to the owning session (B1.3).
- Production restarts are authorised for these fixes, still with activeTurns 0, a board check and `production:lock`.

**Owner decisions recorded 2026-09-29 (R2; the owner accepted the review session's recommendations):**
- **Heap gate:** 0.75 of `heap_size_limit` stays. Production heap has never exceeded 515 MiB (about 11% of the limit).
- **Lag gate:** 300 ms stays, unless the V2 fan-out probe shows an ordinary parent fan-out tripping it. If it does, B2.1 moves the gate to a genuinely sustained statistic and keeps p99 for A2 alerts.
- **Production lag and watcher growth: closed, provisionally.** Lag: 0 spike minutes in 4.5 h before the wave-2 restart and none since it (baseline 0.77/h). Heap since the restart: 93–185 MiB. Watcher: B1.1. Load has been light (mean activeTurns ≤ 0.41), so E2 re-checks both under orchestration load.
- **F1 is fixed as step B5.** Pi Web UI emits the extension shutdown event on dispose through the SDK's public API.
- **Wave-2 residuals:**
  - B3a's unpaced tool-argument stall is accepted; D1 is its structural fix. The review session drafts an upstream issue about quadratic partial-JSON parsing, and the owner submits it.
  - The ~250–670 ms finalisation stall at 16–18 MB messages goes to B3c, which re-sizes the 16 MiB byte cap.
  - The 17.8 MB dispatch whose response never arrived goes to the E1 ledger and into C2's scope.
  - The weekly refresh's 60 s job timeout becomes a small item.
- **Stage C: go, with a condition.** B4.1 and B5 (and B2.1 if V2 triggers it) ship before the owner scales orchestration up, because they are robustness gaps inside Stage B's own intent. C4 and C5 may run alongside the follow-up wave: they touch other code.
- **Two new process rules** are added to §4: an intent check of every step's blind spots, and live proofs that use the owner's real child pattern.

**Owner decisions recorded 2026-09-30 (R3; the owner accepted the review session's recommendations):**
- **Why the CPU test was run (owner).** The concern is host-wide contention, not the Internal API's own CPU: another agent's benchmark starved the event loop on 2026-09-30. The R3 finding that agents' tool commands run inside the service's own cgroup turns that into an isolation question, so no further CPU-capacity work is planned.
- **Stage D starts with D0:** agents' tool processes move out of the control plane's cgroup into a sibling group with lower CPU priority and memory limits of their own. The design must stay robust for about **12 concurrent children** doing real work (test suites, builds) without routine OOM kills; memory is sized from measurement, and the control plane keeps a protected budget of its own. **D1 (per-session workers) and Phase 8 of the resource-scaling plan are not authorised now;** they are decided at R4 on G2, G5 and D0's evidence.
- **Admission cap stays at 15** API turns. Raising it is a configuration change, made when G5 or real use shows parents hitting it.
- **C6 stability window: open until programme close (R5), and it never blocks planned work.** A plan step that needs a wire change gets its exception recorded at a review moment (or by the orchestrating parent under the owner's programme authority, then reported). Unplanned wire features stay out.
- **The Jev re-measure moves into E2**, which already re-runs all five specs. R3 does not wait for sessions to accrue.
- **E2's 24 h soak is replaced by a bounded run** (hours, B0.1's window option) plus the production-telemetry comparison. **The owner wants minimal waiting**: no long soaks or waiting windows unless a decision truly needs one.
- **Routing for the R3 follow-up wave:** children on GLM 5.3 Flash (`pi` · `zai`) while it is neither very slow nor error-prone; DeepSeek v4.1 Flash (`pi` · `opencode-go`, or `commandcode`) as the fallback. The parent may switch autonomously when zai is slow or failing, and records why. The owner wants autonomous work, with a report back at the next review moment.
- **DeepSeek v4.1 Flash** stays approved as a child route (the fallback, and the second route for mixed-provider fan-outs), within quota.
- **Smaller items:** the opencode-go DeepSeek `400 (no body)` errors go on the E1 ledger's watch list, with no fix unless they recur and a live reproduction exists. The public skill pack gets a manual comparison with the canonical skills whenever a canonical skill it mirrors changes (no CI). The kept worktrees `p2` and `r2-verify` are removed; `integration3` is removed at R3 close.

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

**Intent check of blind spots (added at R2).** Every evidence bundle's "not done", "residual risks" and "cannot see" items are adjudicated against §1.1's definition of ready before the step is marked shipped. For each item, the reviewer or parent records one of three outcomes: accepted, with the reason; moved to a named step; or blocking. Found at R2: B4.md stated that the drain cannot see goal-engine or browser turns, but nobody weighed that against "children are not killed by deploys". That became B4.1.

**Realistic child pattern in live proofs (added at R2).** A step that touches lifecycle, admission, deploys or budgets proves itself on at least one child in the owner's current real pattern, besides plain prompted children:
- goal-armed;
- the real extension set loaded, as byte-identical copies in an isolated agent directory (B1.3-live.md shows how);
- a fresh worktree as its working directory;
- a background shell or a watch where the step could affect them.

**Wave closure includes the independent live re-run.** The parent schedules a reviewer's live re-run (not the executor's) before a wave is reported as shipped, rather than leaving it to the next review moment.

**Measurement discipline.** Re-measurements at review moments reuse the same instruments: the heap-soak harness (`scripts/heap-soak/`), the Jev specs (pinned `jev-1.13.0`), and the journal/stop-audit counts in §2. That keeps before and after comparable.

## 5. Sequence overview

```
Stage A  Measure            A1 heap soak (24 h)  ‖  A2 production heap/lag telemetry + alerts
            │
         ── Review moment R1 (held 2026-09-27): leak proven, two retainers named; heap cap deferred to R2 ──
            │
Stage B  Contain            Wave 1 (shipped): B0 soak-harness fixes; B1 fix both retainers → confirmation soak (passed)
                            ── interim review (held 2026-09-28): heap cap unchanged; interim wave added ──
                            Interim wave: B0.1 harness follow-ups; B1.1 watcher cleanup (synthetic proof);
                                          B1.2 attribute and remove production lag spikes
                            Wave 2: B2 heap- and lag-aware admission, disposal kept available (lag gate after B1.2)
                                    B3 per-run budgets (runaway generation cannot starve the loop)
                                    B4 drain-then-restart deploys
            │
         ── Review moment R2 (decisions held 2026-09-29): thresholds, residuals, conditional go for Stage C ──
            │
         R2 follow-up wave: V2 independent live re-runs of B2/B3b/B4 (+ fan-out, byte-cap, drain-gap and F1 probes)
                            B4.1 drain sees every busy session   B5 dispose runs extension shutdown (F1)
                            B2.1 lag-gate statistic (only if V2's fan-out probe trips the gate)   B3c byte-cap default
                            ── gate before scaling orchestration up: V2, B4.1, B5 (and B2.1) shipped ──
            │
Stage C  Parent ergonomics  C1 thin parent client   C2 busy follow-up + never-started runs
         and child quality  C3 child completion receipt + verify   C4 dispatch preflight
                            C5 lineage always recorded   C6 contract stability window
            │
         ── Review moment R3 (held 2026-09-30): Stage D starts with D0; Jev re-measure moved to E2 ──
                            (opened 2026-09-30; R3 follow-up wave G1–G5 added: per-route concurrency, lag
                             diagnostics, watch-before-first-turn triage, session-create cost, real scale-up trial)
            │
Stage D  Structural         D0 agents' tool processes out of the control plane's cgroup (authorised at R3)
                            D1 contained child execution (Phase 7 shadow → routing; Phase 8 resumed if authorised)
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
- B2's heap-cap choice was settled at the 2026-09-28 interim review (unchanged). Its `heap_pressure` gate can be built at any time. Its `event_loop_lag` threshold waits for B1.2's attribution, so that browser-side stalls do not trigger API refusals;
- B0.1, B1.1 and B1.2 touch disjoint paths (`scripts/heap-soak/`; `server/src/pi/session-watcher.ts`; the lag source B1.2 names), so they can run in parallel worktrees. B3 and B4 may start alongside the interim wave;
- A2 is independent and is worth landing early: it gives the production before-and-after for B1;
- B3 and B4 are independent of B0–B2;
- B0 and B1 touch disjoint paths (`scripts/heap-soak/` against `server/src/pi/` plus `pi-enhancement`), so they can run in parallel worktrees;
- R2 follow-up wave: V2 comes first, because its probes decide B2.1 and B3c and confirm the gaps B4.1 and B5 fix. B4.1 (drain controller, restart reconciliation, Pi busy state) and B5 (Pi dispose paths in `server/src/pi/`) touch disjoint paths and may run in parallel worktrees. B2.1 touches admission and A2 only. C4 and C5 may start alongside the follow-up wave. C2 waits for B4.1, because both touch the prompt and receipt path;
- C1 depends on C2, C4 and C5 landing in the same contract bump or before it;
- C3 builds on C1's dispatch template;
- R3 follow-up wave: G1 (`pi-orch` and skill), G2 (attribution and the Pi streaming path), G3 (watch path) and G4 (Pi session create) touch disjoint paths and may run in parallel worktrees. G5 runs after G1 and G3, so it measures the fixed client and watch behaviour;
- D0 may run alongside G1–G4: it touches process spawning and the unit and cgroup layout, not their paths. Its adversarial proof (c) can share G5's realistic load. D1 needs R4 authorisation.

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

#### B0.1 — Harness follow-ups (added after wave 1; widened at the 2026-09-28 interim review)

**Intent.** The harness is used at least twice more: D1's bounded run and E2's final 24 h soak. Those runs must not need hand repairs.
**Scope.** `scripts/heap-soak/*`, `server/src/live-validation/heap-soak/*`, the harness README. Nothing in the production server.
**Defects to fix** (found in the confirmation soak, [`B1-confirmation-soak.md`](./execution-reports/orchestration-scaling/B1-confirmation-soak.md) §5):
1. **Stale `dist`:** the launcher runs `server/dist` without checking that it matches HEAD. Refuse a stale build or rebuild it, and record the build commit in `run-state.json` and `report.md`.
2. **End snapshot never fires:** the last snapshot offset equals the run length, but the sampler loop exits first. Take the end snapshot after the window closes and before teardown, and compare start against end in the report.
3. **Completed run leaves the server up:** after a `complete` run, stop the server unit, or keep it up only behind an explicit flag and say so in the Telegram message.
4. **Orphan-sweep race:** the sweep deletes children the driver is still tracking, and the harness counts its own deletion as a child failure (all 167 `SESSION_NOT_FOUND` failures). Count swept children separately, or sweep only children no longer tracked.
5. **Bounded run length:** a `full` run takes a window length (for example `--hours <n>`), so D1 can run a bounded soak with the same instrument.
**Definition of victory.**
- [ ] A failing test first for each defect.
- [ ] A disposable `micro` run shows: the build commit recorded; an end snapshot taken and compared; the server unit gone after completion; zero `SESSION_NOT_FOUND` failures caused by the sweep; a planted stale `dist` refused.
**Not victory if:** the end snapshot is still a manual step, or the stale-build check only warns.
**Outcome (2026-09-29): shipped** (merged `ddccf8bf`; harness-only, no production code).
- All five defects were fixed.
- Independent review added more, all fixed with failing-test-first proofs:
  - end-snapshot drain and pending-create tracking;
  - DELETE only terminalised on confirmed not-found;
  - the known slot subtracted only when the snapshot proves it;
  - the verdict only on the true end snapshot;
  - unknown git state refuses; missing artefacts refuse;
  - teardown retries and anomaly reporting;
  - server-side untracked-orphan reconciliation (a Gate 1 supervisor kill had left an orphan that read as a "retained child");
  - fail-closed list failures and unknown session ages.
- Report figures: live on the server, verified known slot, retained deleted.
- Final micro `micro-1790637070894-92ed5848`: 29/29 steps, `Retained deleted children: 0`.
- Evidence: [`B0.1.md`](./execution-reports/orchestration-scaling/B0.1.md); reviews `…/reviews/b0-1-luna-review*.md`.

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
**Outcome (2026-09-28): shipped.**
- Confirmation soak `full-1790523945117-ea387201`: 24 h with the server alive; post-GC heap flat at ~200 MB after a four-hour warm-up; 8,092 children.
- The end snapshot holds no deleted child except one bounded extension slot (accepted).
- A third, small retainer remains (file-watcher state, ~0.16 MB/h). It becomes B1.1.
- Evidence: [`B1-confirmation-soak.md`](./execution-reports/orchestration-scaling/B1-confirmation-soak.md).

#### B1.1 — Session-watcher cleanup for deleted files (added at the 2026-09-28 interim review)

**Intent.** Remove the last measured unbounded growth before wave 2, without another long soak.
**Finding.** The confirmation soak's 12 h and end snapshots show `Timeout`, `Date`, `Stats` and `FSWatcher` counts growing with child churn. The retainer paths run through `SessionWatcher.debounceTimers` and chokidar's `awaitWriteFinish` pending-writes map.
- In `server/src/pi/session-watcher.ts`, the `unlink` branch clears a pending debounce timer but never deletes its map entry. Every session file created and deleted inside the debounce window leaves a dead entry for good. This was found by reading the code and is not yet test-proven.
- Chokidar (`^3.5.3`) appears to keep pending-write state for files deleted before they stabilise.
- Growth is small (~0.16 MB/h at soak churn) but linear in children created. It is the E1 class "a fix claims every path but wires one".
**Approach.**
- A failing test first: add then unlink inside the debounce window leaves `debounceTimers` (and the per-path state) empty.
- Fix the unlink path.
- Then test chokidar's retention for files deleted before they stabilise. If it retains, remove the dependency on `awaitWriteFinish` (the watcher already debounces and reads the header itself), or upgrade chokidar if that version is proven clean. Record which.
**Validation: synthetic, no model tokens.** On a disposable validation server, a churn script writes and deletes session JSONL files in the watched sessions directory. It uses thousands of files: some deleted inside the debounce window, some after, some before they stabilise. It takes a forced-GC heap snapshot before and after, and uses the harness's retainer summary.
**Definition of victory.**
- [ ] Unit tests fail on the old code and pass on the new, one per retention path fixed.
- [ ] Synthetic churn on the old build shows retained watcher state growing with the file count (positive control). On the new build, the same churn leaves watcher-held `Timeout`/`Stats`/`Date` counts and the watcher maps back at their pre-churn values.
- [ ] A harness `micro` run with real Pi children on the new build shows the same counts flat between its start and end snapshots.
- [ ] Watcher behaviour unchanged: add, change and unlink events still reach the registry (existing watcher tests pass, plus one live add/unlink check).
**Not victory if:** only the debounce map is fixed while chokidar state still grows, or the proof needs a 24 h soak.
**Outcome (2026-09-29): shipped** (merged `a48ad8f1`; in production since the 2026-09-29 00:05 UTC restart).
- **Retention:** two retention paths fixed: the unlink branch now deletes its debounce entry, and chokidar `awaitWriteFinish` was removed (its `_remove()` early return leaked per-file watchers).
  - Old build: 3,000 synthetic files left `Timeout` +756 and `FSWatcher` +507.
  - New build: 0 by direct map cardinality.
- **Read coalescing** replaces `awaitWriteFinish` for live sessions. For an 80 MB file appended every 50 ms:
  - pre-coalescing: 114 complete reads, p99 226 ms;
  - fixed: 1 read, p99 about 21 ms, which matches the old build.
- **Also fixed:**
  - stale metadata after a long in-flight read;
  - unlink identity: the strict Pi filename parser, with `pi-service` keeping its lenient check;
  - client removal and broker publication by path for unlinks without an id;
  - symlink-safe churn guard.
- **Follow-up:** the SDK's own per-session `fs.watch` handles grew slightly in a micro run (outside this step).
- Evidence: [`B1.1.md`](./execution-reports/orchestration-scaling/B1.1.md); reviews `…/reviews/b1-1-luna-review*.md`.

#### B1.2 — Attribute and remove production event-loop lag spikes (added at the 2026-09-28 interim review)

**Intent.** Find what stalls the production event loop for 300–900 ms, fix it, and give B2's lag gate a threshold that reflects API risk, not browser activity.
**Finding (A2 telemetry, first 22 h after the 2026-09-27 restart).**
- Lag p99 was ≥ 300 ms in 17 distinct minutes, with a maximum of 919 ms.
- Every one of those minutes had 0–3 active API turns.
- Most coincided with resident sessions jumping, for example 3 → 20 within minutes at 23:16 UTC.
- The API-only soak never exceeded 130 ms.
- The earlier session-load performance finding points the same way: opening a Pi session bypassed the cached registry and scanned the whole session store. This is a correlation and a hypothesis, not attribution.
**Approach.**
1. **Attribute.**
   - Correlate the spike minutes with the journal and diagnostics (session opens, replays, registry scans, compaction).
   - Add bounded instrumentation: named spans around the suspected synchronous paths, and a record of any span over a threshold, with its name, to the diagnostics or metrics file.
   - Reproduce on a disposable server with a synthetic, production-sized session corpus and a browser-like client opening many sessions at once.
   - If the disposable reproduction does not reproduce the spikes, ship the instrumentation alone at an owner-approved restart and attribute from real traffic.
2. **Fix** the dominant cause, test first: move it off the loop (worker or streaming), make it incremental, or add yields. Re-run the same reproduction.
3. **Set** the proposed `event_loop_lag` threshold for B2 from the measured post-fix distribution.
**Definition of victory.**
- [ ] Attribution names the operation behind most spike minutes, with span evidence, not timing correlation alone.
- [ ] The disposable reproduction shows p99 ≥ 300 ms on the old build (positive control) and under the proposed B2 threshold on the new build, with the same corpus and client.
- [ ] Instrumentation is bounded, tested, and documented in `docs/OBSERVABILITY.md`.
- [ ] After an owner-approved restart, production telemetry over a stated observation window shows fewer spike minutes than the 2026-09-27/28 baseline (17 in 22 h), with the comparison written into the evidence bundle.
**Not victory if:** the threshold is raised instead of the stall removed; the fix is shown only with mocks; the attribution rests on timing overlap.
**Outcome (2026-09-29): merged and in production; the production telemetry item is open.**
- **Attribution:** every Pi session open re-imported all 16 global extensions, because the SDK clears its single-slot extension module cache whenever the cwd changes, blocking the loop for about 0.3–1.6 s. Proven with span containment (`pi.session.resource_loader`).
- **Fix:** a process-level extension-factory cache.
  - An additive guarded SDK patch (`scripts/patch-pi-coding-agent-extension-factory.mjs`, in `postinstall`) exposes the factory import and seed.
  - Seed-to-load and every reload run in one process-wide critical section.
  - Only audited share-safe extensions are cached (15/16; `subagent` excluded, see B1.3).
- **Reproduction** (same synthetic corpus and client), A2 p99 under load:

  | Build | A2 p99 | Spike minutes |
  |---|---|---|
  | Pre-fix | 388–533 ms | 6 |
  | Final (`fe925403`) | 98–201 ms | 0 |

  The fixture has `activeTurns=0`.
- **Proposed B2 lag gate:** 300 ms sustained (two readings), recovering at 150 ms. B2 must validate it under active API load.
- **Production smoke after the restart:** the cold first open stalled 718 ms (one-off import). The first new-cwd open stalled 413 ms (the uncached `subagent`). Later opens stayed under the 100 ms stall log.
- **Open:** the production spike-minute comparison over an observation window against the 17-in-22-h baseline.
- Evidence: [`B1.2.md`](./execution-reports/orchestration-scaling/B1.2.md); reviews `…/reviews/b1-2-luna-review*.md` (REJECT ×3, all findings closed; the final correction was verified by the parent).

**B1.2b — the SDK patch replaced by the public API (2026-09-29, owner rule; merged `683ffa56`, in production since the 10:10 UTC restart).**
- **How factories are delivered now.** Cached factories reach each session's `DefaultResourceLoader` through its public options: `extensionFactories` + `noExtensions` + `additionalExtensionPaths` + `extensionsOverride`, which restores real paths, order and errors. Factories are imported with `jiti` 2.7.0, using an alias map that replicates the SDK's aliasing through public resolution only (`server/src/pi/sdk-extension-importer.ts`).
- **Per-loader snapshots.** Each loader holds its own factory snapshot, owned for as long as the session is. `/reload` updates only that session's snapshot and only with successful imports. A failed re-import surfaces as the SDK's own load error.
- **Degradation.** An exact SDK version guard (`0.87.1`) and any failure in the pipeline degrade that session to the plain uncached loader, with a rate-limited warning and `getExtensionLoaderTelemetry()`. A CI test pins the SDK version.
- **Cost.** One extra settings reload and package resolve per open. Reproduction steady-state p99 is 117–192 ms, about 20% above the patch build, with one non-sustained warm-up reading per run.
- **Production smoke after the restart.** 16/16 extensions load at their real paths, with 0 fallback warnings and 0 `<inline:` labels. The cold first open stalled 730 ms (the one-off import). New-cwd opens took 496–558 ms in the loader, with 359–395 ms stalls on 3 of 5; the others were under the 50 ms log. The 12:07 UTC telemetry comparison quantifies the effect.
- Evidence: [`B1.2b.md`](./execution-reports/orchestration-scaling/B1.2b.md); reviews `…/reviews/b1-2b-luna-review*.md` (REJECT ×2, all closed; correction 03 verified by the parent).

#### B1.3 — Extension module state safe to share (added 2026-09-28 during B1.2)

**Intent.** Caching extension modules is only safe when their module-scope state is safe to share between sessions. The SDK **already** shares an evaluated module between sessions in the **same cwd** in production today, so per-session module state is a latent correctness bug regardless of caching.
**Done** (`pi-enhancement` `8a4b768`, `9ad45d2`, `7c11e1d`; deployed to `~/.pi/agent/extensions` 2026-09-29 00:04 UTC, backup in `/root/orch-ops/orchestration-scaling/deploy-backup-b13-20260929T000419/`):
- `memory`, `goal-engine` (auto-continue maps) and `enhanced-plan-mode` moved to per-session scope, each with a two-session isolation test (including a goal-engine shutdown-isolation regression).
- `web-tools` (request-keyed cache) and `parallel-orchestrator` (globally keyed registries) audited as process-wide safe.
**`subagent` — owner chose option B (2026-09-29); shipped (`pi-enhancement` `b046a8a`, deployed 2026-09-29 10:09 UTC; cached from pi-web-ui `6442ce23`, 16/16).**
- There is one process-wide background registry keyed by session.
  - Delivery goes to the owning session while it is live.
  - It is handed over only on an explicit session switch; a vanished owner stays authoritative.
  - Owners that have ended are held in a bounded set (64), and running children are aborted on eviction.
  - Pending notifications per owner are bounded by count and bytes; dead `WeakRef` slots are swept.
  - The exit hook is re-registered on every launch. The persisted `background-tasks` shape is unchanged.
- Luna rejected round 1 (5 majors) and accepted round 2. **Residual:** no live background-task check was run after the final correction (unit and runtime tests plus Luna probes only).

**Finding F1 (for R2).** Pi Web UI never emits `session_shutdown` when it disposes a Pi session; only CLI new/resume/fork/quit/reload do. Extensions' shutdown cleanup therefore never runs in Web UI sessions. B1.3s works around this with `WeakRef` sweeps. A dispose-time `session_shutdown` (or equivalent) is a lifecycle fix to decide at R2. **Decided at R2: fixed as step B5.**
**Known gap for the store owner:** `pi-enhancement` has no working typecheck (`memory/tsconfig.json` `ignoreDeprecations` rejected; no root script).

#### B2 — Heap- and lag-aware admission, heap cap aligned

**Intent.** Admission refuses new API work before the process is in danger, using the limits that actually bind.
**Scope.** `server/src/internal-api/admission-controller.ts`, capacity route and types, config, systemd unit or `.env.production` for the chosen cap, docs, contract.
**Approach.** Add refusal reasons `heap_pressure` (projected heap against a configurable fraction of `heap_size_limit`) and `event_loop_lag` (sustained lag above threshold). Expose both on `GET /api/v1/capacity`. Keep the P0/P1 control reserve working under pressure. The heap cap stays at 4 GiB with `PI_MAX_SESSIONS=20` (2026-09-28 interim review), so `heap_pressure` works against the current `heap_size_limit`. The `event_loop_lag` threshold comes from B1.2's post-fix measurements. The mechanism may be built earlier, but its threshold is not set from pre-B1.2 data.
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
- [ ] After an owner-approved restart, production `/capacity` shows the new fields with sane values, and the heap cap is unchanged (4 GiB).
**Not victory if:** only the capacity output changed and admission does not act on it.

#### B3 — Per-run budgets against runaway generations

**Intent.** No single turn can monopolise the event loop or heap.
**Approach.** Configurable per-turn caps on output tokens or streamed bytes, and on streamed tool-argument size. On breach, abort that turn with a new terminal error code (for example `RUN_BUDGET_EXCEEDED`) recorded in its run receipt and visible to the parent. Check that tool-argument parsing stays linear.
**Definition of victory.**
- [ ] Tests: breach detection per cap; the receipt carries the terminal code; parsing cost is linear in input size (a benchmark-style test with growing inputs).
- [ ] Disposable live proof with a fixture that reproduces the 2026-09-12 pattern (very long generation with streamed tool arguments): the turn is aborted at the cap; during the run, a second session keeps streaming and measured event-loop lag stays under the B2 threshold.
- [ ] The parent sees the terminal state through its watch or receipt without polling.
**Not victory if:** the cap exists but the 12 Sep-style fixture still pushes lag over threshold.
**B3a outcome — the streamed tool-argument cap (2026-09-29; merged `3da55e78`, contract 1.48.0, in production since the 10:10 UTC restart).** This replaces the removed pi-ai toolstream patch (owner rule).
- **Guard.** `ToolArgsBudgetGuard` sits at the single `PiService` subscribe funnel. It counts public `toolcall_delta` characters per call and per run.
- **On breach:** it emits `tool_args_budget_exceeded`, then calls the public `session.abort()`, with bounded retries per run. The receipt terminates `RUN_BUDGET_EXCEEDED` and stores only the code.
- **Defaults: 65,536 per call and 262,144 per run** (env `PI_TOOL_ARGS_MAX_CALL_CHARS` / `PI_TOOL_ARGS_MAX_TURN_CHARS`; invalid values warn and fall back; `0` disables). They were chosen by **paced** live measurement on pristine pi-ai:
  - about 90 deltas/s: p99 max 4 ms;
  - about 300 deltas/s: p99 max 10 ms;
  - no reading ≥300 ms in either run.
- **Residuals.**
  - **Unpaced worst case:** the 64 KB unpaced run reached a p99 of 10.6 s from two starved samples, bounded by the abort. The cap-off positive control reached a p99 of 23.6 s and never aborted.
  - **16 KB alternative:** a 16 KB cap passes even unpaced, but would fail about 1 in 600 real tool calls (large writes).
  - **Parsing:** it stays quadratic upstream; the cap bounds the quadratic parse rather than making it linear.
- **Still open in B3:** the output-token and streamed-byte caps.
- Evidence: [`B3a.md`](./execution-reports/orchestration-scaling/B3a.md); raw runs in `/root/orch-ops/orchestration-scaling/b3a/measure/`; reviews `…/reviews/b3a-luna-review*.md` (REJECT, then ACCEPT-WITH-MINORS; corrections 04–05 verified by the parent).

#### B4 — Drain-then-restart deploys

**Intent.** Deploys stop killing in-flight children silently.
**Approach.** A `production:drain-restart` path: admission enters `draining` (new P2/P3 work refused with a distinct code and `Retry-After`); wait for active turns and nonterminal receipts to settle up to a configurable timeout; notify affected parents; then restart. After boot, report every run that was cut off, with a terminal status such as `interrupted_by_restart`. Make it the default in deploy scripts; restarting without a drain requires `--force` plus a recorded reason in the stop audit.
**Definition of victory.**
- [ ] Tests for the draining state machine, the timeout path and post-boot reconciliation.
- [ ] Disposable live proof: three children mid-turn; drain-restart lets those that finish within the timeout finish; any cut off get `interrupted_by_restart`; their parents' watches fire; the stop audit records the drain result.
- [ ] Deploy documentation (`DEPLOYMENT.md`) and the production-lock wrapper use drain by default.
**Not victory if:** drain waits only for turns and ignores nonterminal receipts, or parents learn about interruptions only by polling.

#### Review moment R2

Inputs: B0.1, B1.1, B1.2 and B2–B4 evidence bundles; the B1 confirmation soak (already evaluated, [`B1-confirmation-soak.md`](./execution-reports/orchestration-scaling/B1-confirmation-soak.md)); A2 production telemetry spanning the restarts that picked up the interim wave and wave 2.
Decide:
- go/no-go for Stage C;
- B2's heap and lag thresholds, checked against production telemetry;
- whether production lag and watcher growth are closed or need another round.
- the Pi dispose lifecycle (finding F1 in B1.3: no `session_shutdown` on Web UI dispose).
- wave-2 residuals: B3a's unpaced tool-argument stall (bounded by the abort); a ~250–670 ms upstream finalisation stall on 16–18 MB messages (guard-independent, B3b.md); one observed 17.8 MB dispatch whose receipt terminalised but whose synchronous HTTP response never arrived (not reproduced; B3b.md, evidence in `/root/orch-ops/orchestration-scaling/b3b/measure/r2-input/`); the weekly refresh's 60 s job timeout can still interrupt a slow `systemctl restart` after a 30 s drain decision (B4.md).
(The heap-cap choice and the third-retainer question were settled at the 2026-09-28 interim review.)

**Held 2026-09-29 (decisions; §3 and §8).** The thresholds stay, with the lag gate conditional on V2. Production lag and watcher growth are provisionally closed. F1 → B5. Residuals routed. Conditional go for Stage C. **Found at R2 by code reading** (V2 confirms each live):
- **The drain misses every turn it does not meter.** It waits for admission-metered Internal API turns and nonterminal run receipts only (`drain-controller.ts`). Pi goal-engine continuation turns, other extension-driven Pi turns and browser (P0) turns hold neither. A deploy can therefore kill a goal-armed child mid-turn, and restart reconciliation, which works from nonterminal receipts, fires no watch. Claude and Antigravity goal continuations go through the detached receipt pipeline and are counted. → B4.1.
- **The lag gate is not "sustained".** The A2 window holds 120 samples at 500 ms, and its nearest-rank p99 is the second-largest sample. Two loop stalls of 300 ms or more inside about 60 s therefore give two consecutive high readings 30 s apart, which latches `event_loop_lag`. New-cwd Pi opens stall 359–558 ms (B1.2b), so a parent fanning out into fresh worktrees may trip the gate against itself. → V2 probe, then B2.1 if confirmed.
- **F1 has concrete costs.** 9 of the 16 deployed extensions clean up only on `session_shutdown`, which a Web UI dispose never emits:
  - `background-shell`: its processes are torn down only on quit/reload;
  - `goal-engine` and `watch-wake`: their timers stay armed;
  - `memory`: it does not save;
  - `auto-compact-75`: its heartbeats keep running;
  - also `subagent` and `commandcode-provider`.

  The SDK's public `AgentSession.extensionRunner` can emit the event, so no upstream patch is needed. → B5.
- **The 16 MiB byte cap sits exactly where the upstream finalisation stall appears** (~250–670 ms at 16–18 MB), while the largest real run is 1.05 MB. → B3c.
- **Wave 2 is not yet "shipped" under §4.** Luna re-ran targeted tests and probes, and re-ran B4's pre-correction proof (23/23). Nobody independent has re-run B2's or B3b's live proof, or B4's corrected 27/27. → V2.

### R2 follow-up wave (added at R2, 2026-09-29)

**Intent.** Close the robustness gaps R2 found inside Stage B's own intent before the owner scales orchestration up, and complete wave 2's independent verification. Every step here follows §4, including the two rules added at R2.

#### V2 — Independent live re-runs and R2 probes

**Intent.** Mark B2, B3b and B4 shipped on a reviewer's re-run, and settle the questions B2.1, B3c, B4.1 and B5 depend on, with evidence rather than code reading.
**Approach.** Build master in a detached verification worktree (node_modules symlinked; never rebuild the production checkout). Copy the wave's proof scripts, changing only their worktree and output paths:
- `/root/orch-ops/orchestration-scaling/b2/live/`;
- `…/b4/proof/drain-proof.mts`;
- the repo's `server/tests/unit/pi-ai/run-budget-live-proof.mts`.

Common rules for the workers: `/root/orch-ops/orchestration-scaling/r2/COMMON-BRIEF-r2.md`. No product code changes.
**Definition of victory.**
- [ ] Re-runs on the master build match the bundles: B2 pressure 20/20 and critical 5/5; B3b `bytes`, `bytes-realistic` and `tokens` abort with `RUN_BUDGET_EXCEEDED` while B streams, and cap-off completes; B4 27/27. Production is untouched (MainPID, start time and stop-audit hash before and after).
- [ ] **Fan-out probe** at production-default admission and A2 settings, with the real extension set:
  - trials: 4 creates in fresh directories as a burst and 10 s apart, plus a same-directory control, each run twice;
  - reported per trial: stall durations, p99 per reading, whether and for how long the gate latched, and any `503 event_loop_lag`.
- [ ] **Byte-cap data:** the `bytes` scenario 3× each at 16, 8 and 4 MiB, with the end-of-run stall measured.
- [ ] **Drain-gap probe:**
  - a goal-armed Pi child in an extension-driven continuation turn: the drain verdict, whether the child is killed, whether any watch fires after boot;
  - control: a plain long prompt, which should be counted and reconciled as B4 designed.
- [ ] **F1 probe:** a Pi child starts a background-shell task; after `DELETE`, report whether the process survives and who its parent is.
**Not victory if:** a re-run happens on a stale build, or a probe is reported without its raw numbers.

#### B4.1 — The drain sees every busy session (added at R2)

**Intent.** Deploys stop killing in-flight work silently, whatever started the turn (owner's "ready": children are not killed by deploys). Goal-armed Pi children are the owner's standard orchestration pattern.
**Scope.** `server/src/internal-api/drain-controller.ts`, restart reconciliation (`run-receipts`, `watch/watch-manager.ts`), the Pi busy-state source (`server/src/pi/`), `/api/v1/drain` status, docs, contract.
**Approach.**
- The settle wait also counts every resident session that is busy, whether a run, an extension (goal-engine, watch-wake deadlines, subagent) or the browser started the turn. Busy Pi sessions come from the SDK's public streaming state; other runtimes come from their existing busy flags.
- The verdict record lists the busy sessions still in flight at a timeout.
- At boot, reconciliation fires the ordinary interruption path for them as well: one synthetic `agent_end`, plus `goal_end` when pending, with `interruptedByRestart` and a reason. Where no receipt exists, a synthetic interruption reference identifies the turn.
- Browser-started turns are counted and reported. Whether they block the drain or only extend it up to the timeout is decided in the step, with its rationale recorded.
**Definition of victory.**
- [ ] Failing tests first: a goal-engine continuation turn and a browser turn each keep the drain open; an extension-driven turn cut off at a timeout is listed and fires its parent's watch at boot; a session idle at the drain is not counted.
- [ ] Disposable live proof on the §4 realistic pattern: a goal-armed GLM 5.3 Flash child in a continuation turn delays the drain. On a forced timeout, its parent's watch fires after boot with `interruptedByRestart`, and the wake is dispatched. The plain-prompt control is unchanged, and the B4 27-check proof still passes.
- [ ] Contract bump and docs; Agent OS mirror updated.
**Not victory if:** only Internal-API-started turns are counted, or the parent learns about an extension-driven interruption only by polling.

#### B5 — Dispose runs extension shutdown (finding F1)

**Intent.** Extensions' cleanup runs when Pi Web UI disposes a Pi session, so background processes, timers and unsaved state do not outlive the session. At orchestration scale these are leaks of processes and work, not only of memory.
**Scope.** The Pi dispose and unload paths (`server/src/pi/multi-session-manager.ts`, `pi-service.ts`), the shared release helper B1 introduced, tests, docs. **No upstream changes** (owner rule): use the public `AgentSession.extensionRunner` with `hasHandlers`/`emit`.
**Approach.**
- Emit `session_shutdown` once per disposed session before the SDK object is released, bounded by a timeout (background-shell's own teardown uses 5 s), with errors caught and logged.
- Map each path to a reason: `DELETE` and final disposal use `quit`. For idle unload of a session the user may reopen, decide whether its background tasks should survive, and record the rationale.
- Route every dispose path through the one helper, with a per-path test (E1 class "a fix claims every path but wires one").
- Audit that no shutdown handler writes to Agent OS or other production state from a validation child.
**Definition of victory.**
- [ ] Failing test per dispose path first: the shutdown event is emitted exactly once, with the mapped reason; a hanging handler is bounded by the timeout; a throwing handler does not block disposal.
- [ ] Disposable live proof with the real extension set: a background-shell process started by a GLM 5.3 Flash child is gone after `DELETE` (a survivor on the old build is the positive control), and goal-engine and watch-wake timers do not fire after dispose.
- [ ] The B1 listener-count regression test and a `micro` harness run stay clean (no new retention).
**Not victory if:** only the `DELETE` path emits it, or the fix edits an extension to compensate.

#### B2.1 — Lag-gate statistic (only if V2's fan-out probe trips the gate)

**Intent.** The `event_loop_lag` gate refuses API work when the loop is really in danger, not after two isolated stalls.
**Approach.** Gate on a statistic that means sustained lag: for example p95 of the 120-sample window (at least 6 stalled samples in 60 s), or p99 over more readings. Keep p99 for A2 alerts. Alternatively, or as well, remove the remaining new-cwd open stall (the uncached `subagent` load). Choose from V2's data and record why.
**Definition of victory.**
- [ ] Tests at the boundary: two isolated stalls do not latch; genuinely sustained lag still does.
- [ ] V2's fan-out trial re-run: no refusal. The 12 Sep-style runaway fixture (B3) still latches the gate.

#### B3c — Byte-cap default re-sized from measurement

**Intent.** The streamed-byte cap bounds a runaway before the upstream end-of-message stall exceeds the B2 lag threshold.
**Approach.** Take the default from V2's 4/8/16 MiB data: the largest value whose end-of-run stall stays under 300 ms, and never below 2× the real maximum (1,050,331 bytes). Config and docs only, unless the data says otherwise.
**Definition of victory.**
- [ ] Config test for the new default; B3b's live `bytes` scenario at the new default shows no end-of-run reading ≥ 300 ms; docs and contract changelog updated.

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
**Input added 2026-09-29 (interim wave).** A Pi session reports `busy:false` during an auto-compaction. The Internal API then accepts a prompt with `202`, and the detached run fails with "Cannot submit a prompt while compaction is in progress" (receipt `failed RUNTIME_ERROR`). The parent sees an accepted dispatch that never runs. It was observed while supervising reviewer sessions. Separately, `auto-compact-75` aborts an in-flight turn when it compacts mid-run (the turn ends with no text) and resumes by itself. Parents must not re-prompt into that window. C2 should expose compaction as busy, or queue.
**Input added at R2.** In a B3b live-proof run, a synchronous dispatch whose 17.8 MB assistant message terminalised its receipt never got its HTTP response, on an otherwise healthy server. It was not reproduced; evidence is in `/root/orch-ops/orchestration-scaling/b3b/measure/r2-input/` and B3b.md, residual 6. This is the same class as "accepted then lost". C2's reproduction work checks whether a synchronous response can hang after a terminal receipt.

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
**CPU input for R3 (added 2026-09-30, after the Stage C incident).** This plan has not measured CPU. The soaks (A1, B1) recorded heap and lag only, with at most ~7 concurrent children (production admits 14 API turns). The A2 telemetry has no CPU series.
- On 2026-09-30 06:55–07:16 UTC another agent's benchmark (image builds without a CPU cap, model loads) saturated the host (~15 of 16 cores). The event loop stalled for 1–12 s, and admission correctly refused work (`ADMISSION_CAPACITY_EXHAUSTED`, `event_loop_lag`). The owner is setting `CPUWeight=1000` on the service for host contention.
- The structural ceiling is different: every in-process Pi child's streamed events, extension loads on create/rehydrate (B1.2) and large tool outputs run on **one main thread, i.e. one core**. That main thread is the likely next scaling limit.
- **Measured 2026-09-30 (T1, [`T1-CPU-LOAD.md`](./execution-reports/orchestration-scaling/T1-CPU-LOAD.md); L1 put CPU in the A2 telemetry).**
  - Stepped 5/10/20/30 streaming children on a disposable server, with a calibrated mock provider; a real zai step at 5 shows the mock runs ~2.1× hot.
  - At today's 15-turn admission cap the main thread sits at ~28% of one core (real-corrected; mock ~58%), lag p99 ≤ 185 ms, heap < 0.8 GiB. Admission refuses before CPU binds.
  - Extrapolated saturation of one core: ~54 concurrent turns (real-corrected; mock ~26). **Stage D is justified only if R3 raises admission materially above ~25–50 concurrent streaming children.**
  - The largest attributed main-thread cost is session create / extension loading (~0.5 core-seconds per create), worth attacking independently.
  - Side finding for triage: a watch registered before a child's first turn appeared to fire immediately and loop wakes (harness observation).
- **R3 review reading (2026-09-30, session `a7de099d`).**
  - *T1's figures are a range.* The top step rose 43 → 61% for +1.0 average turn, because 282 refused dispatches and the wake-loop artefact (865 of 1,120 runs cancelled) add work that is not streaming. The calibration was measured at five children only, with the host 63% busy, in one run. Production L1 telemetry (09:55–13:18 UTC, 407 samples) puts one active turn at ~1.8% of a core above idle, which agrees with T1's real-corrected slope on average. The conclusion stands: the main thread does not bind at 15 turns.
  - *Agents' tool commands run inside the service's cgroup.* Every command a Pi child runs (tests, builds, benchmarks) is a subprocess of the server and inherits `pi-web-ui.service`'s cgroup. The run from 03:33 to 09:54 UTC consumed 10 h 42 min of CPU in 6 h 21 min, with a 12.9 GB memory peak. The run ending 2026-09-27 17:39 peaked at 14.0 GB against `MemoryHigh` 14 GiB. The server process itself uses ~0.2–0.8 GB and a few percent of a core. So `CPUWeight=1000` protects the service from work outside it (Docker containers, other slices), but not from heavy commands run by the Pi children it hosts, and it raises those commands' priority host-wide. The 06:55 incident's largest process (`build_corpus.py`, ~1,100% CPU) came from a programme whose workers were Pi children, so it very likely ran inside this cgroup. This is inferred from session lineage; that process's cgroup was not recorded. Its Docker container (~400%) ran outside.
  - *One session slowed production.* 11:43–11:48 UTC 2026-09-30: with two active turns, main-thread CPU rose linearly from 7% to 53%. Lag p99 reached 274–433 ms for ~2.5 min, which is enough to latch B2's lag gate. It fell within seconds of one child's five-minute turn ending `aborted`. The root cause is unknown; a cost growing with the partial message is a hypothesis only. The stall logs could not attribute it: all 158 `LoopAttribution` lines since the 09:55 restart carry that child's session and run ids, including 24 after it finished, and 148 name no span.
  - *Provider concurrency is the first ceiling for any single route.* zai GLM 5.3 Flash returned empty completions above ~5–8 concurrent children (48 of 144 produced a tool call at target 10; 13 of 13 at 5). opencode-go DeepSeek worked at 8 (44 of 44) but its quota is constrained. A parent can still spread children across providers, so aggregate concurrency can exceed any one route's limit.
  - *Stage D answers an isolation question, not a capacity one* (§1 item 1; D1's intent). Whether it proceeds depends on whether a child can still degrade the control plane, not only on the admission cap.

Decide: whether Stage D proceeds; authorise resuming Phase 8 of the resource-scaling plan if so; the C6 window length.

**Opened 2026-09-30 (session `a7de099d`, fresh Opus, from `R3-HANDOFF.md`).** Checked: the Stage C bundles and Luna reviews, T1 raw data, production telemetry and unit journal since the 09:55 restart, CI on all three public repositories, and production build `631c88b3` with `CPUWeight=1000`. The reviewer re-ran the C6 guard and client drift tests (25/25), `pi-orch` tests (197/197) and the Agent OS mirror version (1.58.0). No live proofs were re-run. Findings are in the *R3 review reading* above. Additional finding: §4's independent live re-run at wave closure happened for C2 only; C1's real-parent proof and C3's live proofs were run by their executors and checked by the parent, so they stay `claimed` until G5 re-runs them. **The Jev re-measure cannot run yet:** since C1 shipped (03:33 UTC), the only sessions using `pi-orch` are this programme's own lanes. The owner accepted the plan changes (the R3 follow-up wave below).

**Held 2026-09-30 (decisions in §3).** Stage D starts with D0; D1 and Phase 8 are decided at R4; the admission cap stays at 15; the C6 window runs to R5 without blocking planned steps; the Jev re-measure moves into E2; E2's soak becomes a bounded run. **R4 now also reviews the R3 follow-up wave and D0**, and is the owner's next review moment.

### R3 follow-up wave (added at R3, 2026-09-30)

**Intent.** Remove the unknowns R3 found before the owner scales orchestration up: what slowed production at two turns, whether parents can trust a freshly registered watch, whether single routes are overloaded, and what real mixed-provider orchestration costs the host. These steps change no wire contract, so they fit the C6 stability window. Every step follows §4.

#### G1 — Per-route child concurrency in the parent client

**Intent.** A parent never sends a single route more children than it can serve, while it can still spread work across providers.
**Approach.** In `pi-orch`, keep a per-route limit on concurrent children (configurable; defaults from measurement: zai GLM 5.3 Flash 5; other routes explicit or unlimited), counted from the caller's live children. `spawn` over the limit refuses with a distinct exit code and a hint, or waits when the parent asks. Update the orchestration skill (canonical source only, via the skill-creator skill) to spread children across routes. No server change.
**Definition of victory.**
- [ ] Tests: the limit per route, counting only live children, a mixed-route fan-out, and the refusal exit code.
- [ ] Disposable live proof: a parent asking for 8 zai children gets 5 running plus a clear refusal or wait for the rest; a mixed-route fan-out beyond 5 total runs.

#### G2 — Lag diagnostics: correct attribution, then root-cause the 11:43 episode

**Intent.** The next production slowdown can be attributed to the session and code path that caused it, and the one seen on 2026-09-30 is explained.
**Approach.**
1. Reproduce and fix the sticky `LoopAttribution` context (a finished run's ids stay attached to later stalls). A failing test comes first.
2. Reproduce the episode on a disposable server: a long-context Pi child in a long streaming turn, with main-thread CPU and lag sampled. Find the cost that grows over the turn.
3. Fix only a validated cause (owner rule: no unvalidated fixes). Otherwise record the reproduction and route the finding (E1 or Stage D).
**Definition of victory.**
- [ ] Attribution: a test fails on the old code and passes after the fix; stalls after a run ends carry no run ids.
- [ ] Episode: reproduced with numbers and a named cause, or reported as not reproduced with what was tried; no speculative fix merged.

#### G3 — A watch registered before the first turn

**Intent.** Parents can register a watch right after prompting without false or repeated wakes (the owner's spawn → prompt → wait pattern).
**Approach.** Reproduce T1's observation on a disposable server, with and without a real parent session identity, through `pi-orch` and raw API calls. If it is a defect, write a failing test first, then fix it (server or client).
**Definition of victory.**
- [ ] A reproduction that either shows the defect (then a failing test, fix, live re-run) or shows it is a harness artefact, with the reason.

#### G4 — Session-create cost

**Intent.** Cut the largest attributed per-child main-thread cost (~0.5 s of main-thread time per Pi session create, mostly the extension resource loader), which also causes the cold-open stalls seen since B1.2.
**Approach.** Profile a create with the real extension set on a disposable server. Remove repeat work without sharing unsafe module state (B1.2 rejected a per-cwd loader cache; B1.3 made extension state safe to share). No upstream changes (owner rule).
**Definition of victory.**
- [ ] Measured before and after with the same instrument (T1's sampler and `LoopAttribution`); a regression test for any cache; the B1.3 isolation tests stay green.

#### G5 — Bounded real scale-up trial

**Intent.** Measure what real mixed-provider orchestration costs the host and the control plane, as input to the Stage D decision. This also gives the Stage C live proofs their independent re-run.
**Approach.** One real parent uses `pi-orch` on a disposable server with the real extension set and the §4 realistic child pattern. It runs 8–10 children across at least two approved routes on a real task, including children that run heavy commands (a test suite or build). Sample main-thread and process CPU, lag, service-cgroup CPU and memory, provider failures and refusals. Re-run C1's zero-curl/zero-sleep count, C3's completion block and `verify` checks, and C5 lineage on this run.
**Definition of victory.**
- [ ] A report of at most 60 lines with the numbers above, each route's success rate, and C1/C3/C5 re-checked by the trial's reviewer, not its executor.

### Stage D — Structural isolation

#### D0 — Agents' tool processes out of the control plane's cgroup (added at R3)

**Intent.** Heavy work that a child runs (a test suite, a build, a benchmark, a model load) can neither starve the control plane's event loop nor push the service into memory throttling or an OOM kill that would take every child down. Evidence (R3 review reading): every Pi child's commands are subprocesses of the server and share `pi-web-ui.service`'s cgroup. That cgroup consumed 10 h 42 min of CPU in 6 h 21 min and peaked at 12.9–14.0 GB against `MemoryHigh` 14 GiB and `MemoryMax` 18 GiB, while the server process itself used under 1 GB. `CPUWeight=1000` therefore also prioritises the children's heavy work over the rest of the host.
**Design targets (owner, 2026-09-30).**
- **Two budgets, not one.** The control plane (the Node process, with its in-process agents inside the 4 GiB heap cap) keeps a protected budget of its own. Agents' tool processes get a sibling budget with lower CPU weight. Neither can starve the other of memory.
- **Robust at about 12 concurrent children** doing real work. The default response to pressure is throttling (a soft `MemoryHigh`, CPU weight), not killing. A hard limit applies **per child**, so a runaway command is killed inside its own child's group only: the agent sees the command fail and carries on, while other children and the server are untouched. Limits are sized from measured per-child tool usage (the service's history, and G5), with headroom, so ordinary work never meets them.
- **Starting proposal, to be re-sized from measurement:** control plane `MemoryMax` ≈ 8 GiB with `MemoryLow` protection; tools slice `MemoryHigh` ≈ 12 GiB and `MemoryMax` ≈ 16 GiB, CPU weight well below the control plane's; per-child `MemoryMax` ≈ 6 GiB. That totals under the host's 30 GB, leaving room for Docker, other agents and the desktop.
- **Covers every command path:** the Pi bash tool, background shells (`bg_run`), subagent processes, and the subprocess runtimes that Pi Web UI spawns (Claude, OpenCode, Antigravity, Command Code) where they run heavy work. The design note records which paths move now and why any stays behind.
- **No upstream changes (owner rule).** Place processes from Pi Web UI's side. Options, chosen by a design spike with measured cost per command:
  - a public SDK hook or setting for the bash tool's spawn or shell;
  - a shell wrapper that enters a per-child cgroup before `exec`;
  - a delegated cgroup subtree managed by the server (`Delegate=yes`);
  - transient `systemd-run --scope` units.
- **Fails safe:** if placement fails, the command still runs in the old place, with a warning and a health signal (degrade gracefully, alarm loudly). Admission's memory budget and A2's telemetry read the right cgroups after the split.
**Definition of victory.**
- [ ] Design note in `docs/PROCESS-ISOLATION-DESIGN.md`: mechanism choice with its per-command overhead measured, budgets with their measurement, and the command paths covered.
- [ ] Failing tests first: placement per command path; the fallback on placement failure; limit arithmetic; admission and telemetry reading the new cgroups.
- [ ] Disposable adversarial proof, on a disposable unit mirroring production's cgroup layout:
  - (a) a child runs a CPU burner on every core: server lag p99 stays under 300 ms and other children keep streaming;
  - (b) a child allocates past its per-child cap: only that command is killed, reported to the agent as a failed command, while the server and other children are untouched and there is no service OOM;
  - (c) about 12 concurrent realistic children running test-suite-sized commands: zero OOM kills and no lag latch;
  - positive control: (a) and (b) on the old layout show the lag rise and the shared-cgroup memory growth.
- [ ] Production rollout under an owner-authorised drain-restart. After it, production telemetry shows the server cgroup's memory near the server's own use, and the children's work in the tools slice.
**Not victory if:** a single aggregate hard limit can kill unrelated children's commands in ordinary work, placement silently fails open without a signal, or the proof uses only synthetic commands with no real child.

#### D1 — Contained child execution

**Intent.** A child's runaway, crash or heap blow-up cannot take down the control plane or other children.
**Approach.** Take the Phase 7 shadow implementation ([resource-scaling plan, Phase 7](./PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md)) to contained routing for Internal API children: children run in per-session workers with their own heap and event loop and per-worker cgroup limits (Phase 6 pilot). Refresh the design against Stage B's findings before building. Decide explicitly whether workers survive a main-process restart.
**Definition of victory.**
- [ ] Design note updated in `docs/PROCESS-ISOLATION-DESIGN.md`, reviewed at R3/R4.
- [ ] Disposable adversarial proof: a child forced past its heap limit, or into an event-loop hang, kills only its worker; the main process lag stays under the B2 threshold; other children keep streaming; the parent receives a terminal state.
- [ ] A bounded run of the soak harness (B0.1's window-length option, not a 24 h window) against the contained build shows main-process heap flat under the same load. The A1 build reached 1 GiB in about 20 minutes, so hours, not a day, are enough to see a regression.
- [ ] Production rollout only after R4, owner-gated.

**R3 (2026-09-30):** not authorised yet. It is decided at R4 on G2's root cause of the 11:43 episode, G5's real-trial numbers and D0's result.

#### D2 — Decompose the sessions route module

**Intent.** `server/src/internal-api/routes/sessions.ts` (7,762 lines) and `server/src/websocket/connection.ts` (4,623) are where most fixes land. Split them along the seams D1 creates.
**Definition of victory.**
- [ ] No behaviour change: the full test suite passes with only import-path edits; route and contract snapshots are identical before and after.
- [ ] No resulting module above an agreed size, or a documented reason for each exception.

#### Review moment R4

Inputs: the R3 follow-up wave (G1–G5) and D0 evidence bundles; production telemetry after D0's rollout; D1 adversarial proof and contained soak and D2 evidence, if authorised.
Decide: whether D1 (per-session workers) and Phase 8 proceed; production rollout of contained routing, and its observation gate; whether to raise the admission cap.

### Stage E — Prove and keep

#### E1 — Recurring-defect ledger (runs alongside from Stage B onward)

**Intent.** Stop the 74% of operator-reported problems that recur (stuck after compaction, performance, orchestration).
**Approach.** A short ledger in `docs/` of recurring defect classes, each with a pointer to a regression test once fixed. When a class recurs, its test is added before the fix.
**Definition of victory.**
- [ ] The ledger exists with the classes from the 2026-09-26 operator-reports run, plus "a fix claims every path but wires one". Found at R1: `91effe69` fixed one of three dispose paths. The B1 per-path tests are its regression tests. The session watcher's unlink path is the second instance (2026-09-28), and B1.1's tests are its regression tests. Added at R2:
  - **"A mechanism sees only what it meters."** B4's drain counts admission turns and receipts, so extension-driven and browser turns escape it. B4.1's tests are the regression tests.
  - **"A response is lost after the receipt is terminal"** (the 17.8 MB dispatch, not yet reproduced; C2).
- [ ] Each fixed class links a regression test that fails on the pre-fix code.

#### E2 — Final re-measure

**Approach.**
- One final **bounded** soak (hours, using B0.1's window option) with the A1 harness on the final build (R3: the 24 h soak is dropped; production telemetry supplies the long-duration evidence).
- Its load adds B1.2's browser-like session-open reproduction alongside the API children, so lag regressions show up, not only heap.
- Plus a re-run of all five Jev specs over the period since Stage C shipped. This includes R3's parent and child re-measure (moved here at R3): supervision overhead, API-misuse share, correction rate, workspace-problem rate and lineage coverage against §2, with the programme's own lanes reported separately.
- Plus a production-telemetry comparison against the §2 A2 baseline.
**Definition of victory.**
- [ ] Soak verdict: no growth beyond the A1 threshold, or growth explained and bounded; lag under B2's threshold throughout.
- [ ] Production telemetry: spike-minute count and heap floor compared with the §2 baseline over a stated window.
- [ ] Jev comparison table against §2, with the same model pin and specs, and deltas stated with n.

#### Review moment R5

Decide: close the programme, or open the next plan.

### Small items (any stage, low risk)

- Remove orphaned `session-registry.json.*.tmp` files at boot (after confirming no writer holds them). Victory: test plus disposable boot proof.
- Command Code admits one active turn. Revisit only if children are routed there. Victory: decision recorded at a review moment.
- **Weekly refresh restart budget (added at R2; B4 residual).** `restart-pi-web-ui.sh` spends up to 30 s draining inside the weekly job's 60 s timeout, so a slow `systemctl restart` can outlive the job. Raise the job timeout above the drain budget plus the unit's stop timeout, or wait for readiness after a non-blocking restart. Victory: a test for the budget arithmetic and one disposable run.
- **Public skill-pack sync (added at R3).** When a canonical skill mirrored in the public pack (`valtterimelkko/agent-workflow-skills`) changes, compare the two and port the change with the pack's sanitisation rules. Manual; no CI. Victory: the comparison is recorded with each sync.
- **Upstream issue draft (added at R2; B3a residual).** Draft an issue for the pi-ai streaming tool-argument parse being quadratic, with B3a's measurements, for the owner to submit. Victory: the draft is in the B3a evidence folder and the owner has decided on it.

## 7. Handoff for the agent holding a review moment

This section exists so a fresh Opus agent can hold any review moment with the same understanding as the original review session.

**Read, in this order:**
1. This plan: §1 intent, §3 decisions, §4 contract, §9 status ledger.
2. [`docs/reviews/2026-09-26-INTERNAL-API-DEEP-REVIEW.md`](../reviews/2026-09-26-INTERNAL-API-DEEP-REVIEW.md): evidence, audits, what was corrected and why.
3. The evidence bundles of the steps finished since the last review moment, in `docs/plans/execution-reports/orchestration-scaling/`.
4. For R2: [`B1-confirmation-soak.md`](./execution-reports/orchestration-scaling/B1-confirmation-soak.md) first (the confirmation soak, residual growth, harness defects, production lag evidence), then the B0.1/B1.1/B1.2 and B2–B4 bundles, then production telemetry (`~/.pi-web-ui/metrics/health-metrics.jsonl`) compared with the §2 A2 baseline. [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md) holds the R1 analysis and retainers.
   - For any soak: verify the soak server stayed alive throughout (unit journal), rather than trusting the report.
   - Re-run the retainer summary on its snapshots. Until B0.1 ships, the harness does not take the end snapshot. Take it through the inspector before `cli.ts stop` (method in `B1-confirmation-soak.md` §5).
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
| Confirmation soak run | `/root/.pi-web-ui/validation/heap-soak/full-1790523945117-ea387201/` (`report.md`, `samples.csv`, `events.jsonl`, `snapshots/` including `snapshot-end-manual.heapsnapshot`); write-up [`B1-confirmation-soak.md`](./execution-reports/orchestration-scaling/B1-confirmation-soak.md) |
| Interim-review Agent OS captures (session `d5db9012-…`) | pending `cand-klet82zrol` (soak passed), `cand-lopvoxnts7` (watcher retainer), `cand-m6gpkqo80p` (harness defects), `cand-mog9fizhe9` (production lag), `cand-n6627w4caj` (horizon) |
| Production facts | `~/.pi-web-ui/stop-audit.log`; `journalctl _PID=1 UNIT=pi-web-ui.service`; `GET /api/v1/capacity`; A2 telemetry `~/.pi-web-ui/metrics/health-metrics.jsonl` (one line per 30 s, lag over a 60 s window) |
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
- **The soak's load is API-only.** It proves heap behaviour, not production lag. Production lag came from outside the API path (§2, B1.2).
- **Read a threshold as events, not as a statistic's name.** p99 over the 120-sample A2 window is the second-largest sample, so "two readings with p99 ≥ 300 ms" means "two stalls in about 60 s", not "a minute of lag" (R2).
- **Ask what a mechanism cannot see.** B4's drain was correct for everything it metered, and its bundle listed what it did not meter. The gap mattered only when weighed against the owner's actual child pattern (goal-armed children) (R2).
- **Keep long soaks rare.** The owner will not support many 24 h runs. Prefer synthetic proofs (file churn, bounded create/delete loops, `micro` runs) whenever they decide the question.

## 8. Review moment log

Record each review moment here: date, who held it (session id), inputs checked, decisions, plan changes.

| Review moment | Date | Held by | Decisions and plan changes |
| --- | --- | --- | --- |
| (plan creation) | 2026-09-26 | `fc35fbf1-7f12-4962-9243-da710409fb56` | Plan created from the deep review. Soak design amended three times by the owner: free lanes are best-effort, the zai quota guard, and no synthetic data in Agent OS. |
| (soak launch) | 2026-09-26 | `fc35fbf1-7f12-4962-9243-da710409fb56` | Harness verified and merged; 24 h soak launched on owner go. Owner-approved cleanup: 97 synthetic `memory-vault/derived/inject/sessions/*.json` files from pre-fix rehearsals deleted (list in `/root/jev-session-eval/runs/piwebui-review-2026-09-26-data/vault-soak-files-removed.txt`); 6 usage-ledger recall lines left in place (append-only history). Owner's next steps: a fresh Opus session to re-check this plan's comprehensiveness, then a fresh Opus session for R1 once the soak window ends. |
| R1 | 2026-09-27 | `38c5e91e-6849-4f04-8b6b-301eb79468ab` (fresh Opus; "Int api program") | **Inputs checked:** `report.md`, `run-state.json`, `events.jsonl`, the soak unit's journal (V8 OOM at 13:34:40 UTC), the start and 1 GiB/2 GiB threshold snapshots (constructor diff, retainer paths, cut test), the code of the dispose paths, and commit `91effe69`. Not checked: A2 (not started) and production checksums. **Decisions (owner accepted the recommendations):** (a) leak proven, two retainers, B1 fixes both; (b) heap cap unchanged, decided at R2 from the confirmation soak; (c) Stage B proceeds. A1 is accepted as complete with deviations and is not repeated; the B1 confirmation soak (24 h) is its rerun. **Plan changes:** §1 item 2 and §2 updated with the soak result; §3 records the R1 decisions; new B0 (harness fixes); B1 rewritten around the named retainers, a cross-repo fix in `pi-enhancement`, and a host-side listener-count test; B2 amended (disposal available at critical memory, creates gated by heap, cap from R2); R2 inputs and decisions updated; E1 seeded with the "claims every path, wires one" class; §7 read-order and rules updated. Evidence: [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md). |
| Wave 1 execution | 2026-09-27 | `38c5e91e-…` (orchestrating) | Children on `clinepass/cline-pass/deepseek-v4.1-flash` (owner-authorised to use the remaining Cline Pass quota). An independent reviewer, GPT-6 Luna via `openai-codex` (owner-authorised), ran per lane, and the parent verified every lane. B0, B1 and A2 are merged; the extension fix is deployed. Owner instructions: no production restart until the owner picks a moment (another agent uses the Internal API); review stop after the 24 h confirmation soak. Plan change: B0.1 (stale-`dist` guard) added as an open follow-up. |
| Interim review (after the confirmation soak) | 2026-09-28 | `d5db9012-5cb3-44af-99b9-06a3f8dd43ca` (Opus; "Int API Program 2", continuing `38c5e91e` after it crashed) | **Inputs checked:** the confirmation soak's `report.md`, `run-state.json`, `events.jsonl` and unit journal (one start, no OOM); start, 12 h and a manually taken end snapshot (constructor counts, `AgentSession` retainer, watcher retainer paths); `session-watcher.ts`; production `server/dist` build time against the restart (B1 present in production); A2 production telemetry (journal `Memory:` lines 120/h → 1/h; lag spike minutes). **Decisions (owner):** B1 shipped; heap cap unchanged; an interim wave before wave 2; long soaks kept to a minimum. **Plan changes:** status line; §2 rows for the confirmation soak and production telemetry; §3 decisions; §5 sequence and dependencies; new B0.1 (widened), B1.1 and B1.2; B1 outcome; B2 cap and lag-threshold source; R2 inputs and decisions; D1 bounded soak; E2 as the only remaining 24 h soak, with a browser-like load and a telemetry comparison; E1 second instance; §7 read-order, locations and rules. Evidence: [`B1-confirmation-soak.md`](./execution-reports/orchestration-scaling/B1-confirmation-soak.md). |
| Interim wave execution | 2026-09-28/29 | `d5db9012-…` (orchestrating) | **Routing:** children on `clinepass/cline-pass/deepseek-v4.1-flash` (owner-authorised), independent reviewer GPT-6 Luna via `openai-codex` (owner-authorised). **Quality loop:** the parent verified every hand-back (diffs, own re-runs, own probes) before Luna. Parent corrections caught: a pre-drain end snapshot; the `awaitWriteFinish` live-session regression (measured 114 reads vs 1); an id-less unlink breaking removal; the untracked-orphan misread as retention. Luna rejected each lane at least twice; every finding was closed, and the final rounds were verified by the parent. **Scope changes (parent, within the owner's autonomy grant):** B1.2's per-cwd loader cache was rejected (shared runtime); a guarded additive SDK patch was approved; **new step B1.3**; `subagent` left uncached, with the A/B decision put to the owner. **Production:** extensions deployed with a backup, then a restart at 00:05 UTC under `production:lock` (activeTurns 0). **Gates on master `ddccf8bf`:** lint, typecheck, build, docs 0; full `npm test` 6,428 passed, with 1 load-sensitive Claude SDK test failing in the full run and passing alone (untouched by this wave). **Plan changes:** status line; B0.1/B1.1/B1.2 outcomes; new B1.3; C2 input; §9 rows. |
| Patch removal and `subagent` B (owner follow-up) | 2026-09-29 | `d5db9012-…` (orchestrating) | **Owner rules:** no local changes to upstream packages, with robust replacements; `subagent` option B; restarts authorised. **Lanes:** b1-2b and b1-3s on Claude Opus (SDK), b3a on the Pi runtime; reviewer Luna. **Parent catches:** the 16 KB cap default would fail about 1 in 600 real writes, so it was re-decided with paced measurements; b3a's evidence was overwritten (Luna) and re-run and preserved; an abort-callback race on the run boundary; b3a's deploy restore procedure would have deleted pi-ai's nested `node_modules`, so only the single patched file was restored; b1-2b's snapshot ownership (a sibling client). **Production:** 2026-09-29 10:10 UTC restart under `production:lock` (activeTurns 0). pi-coding-agent and both pi-ai copies are verified identical to npm 0.87.1, and the root `postinstall` is gone. **Gates on master `3da55e78`:** lint, typecheck, build and docs 0; server suite 6,487 passed, with 2 failures in the known load-sensitive `claude-process-pool-resilience` test (passes alone, untouched). **Agent OS** contract mirror 1.48.0 (`2636f48`). **Plan changes:** status line; §3 decisions for 2026-09-29; B1.2b; B1.3 `subagent` outcome and finding F1; B3a outcome; R2 input; §9 rows. |
| Wave 2 execution | 2026-09-29 | `23ff1e3e-…` (Claude Code Remote Control; took over `d5db9012`) | **Owner decisions:** routing Opus (B2, B4), GLM 5.3 Flash (B3b, B1.3 live check; owner: Flash, not GLM 5.3), GPT-6 Luna reviewer per lane; goal-armed children and reviewers; reviews capped at one full round plus one closure round; keep the 64 KiB tool-argument cap; F1 and the unpaced residual to R2; one wave-2 restart, final telemetry read before it instead of a 22 h check. **Seam:** B2 and B4 built in parallel against a fixed, verbatim admission `setDraining` seam. **Quality loop:** Luna REJECT on B2 (validation override under `NODE_ENV=production`; stale lag latch) and B4 (try-restart on an inactive unit; fail-open on unknown API state; the job-path refresh bypassing the drain; interruption hidden from default wake text), ACCEPT WITH FIXES on B3b (defaults measured per user message, not per run); all closed; B3b's closure REJECT was on measurement evidence only and the parent adjudicated it after re-running the corrected script. **Integration:** `orch/wave2-integration` (conflicts in admission, sessions route refusal helper, contract changelog; B2's `sendAdmissionRefusal` now uses B4's `SERVER_DRAINING` mapping), full gates green; master fast-forwarded to `1103ef11`. Agent OS mirror 1.51.0. **Production:** owner 'go'; restart 2026-09-29 14:44 UTC under the production lock (pre-flight activeTurns 0; legacy pre-flight inside `production:drain-restart`), MainPID 2374181 → 2957930; contract 1.51.0, build `1103ef11`, new `/capacity` fields and `/drain` live, extensions loaded without cache degradation, smoke session ok. |
| R2 | 2026-09-29 | `19aabd3f-46a1-5cca-b07a-a36c164acfe0` (Claude Code Remote Control, Opus; continuing `23ff1e3e`) | **Inputs checked:**<br>• the B2, B3b, B4 and B1.3-live bundles and all six Luna reviews;<br>• `STATE-wave2.md`;<br>• code of `drain-controller.ts`, the admission lag and heap gates, `event-loop-shed.ts` (window arithmetic), the PiService budget-guard wiring (per-session closure, no retention) and the SDK's public `session_shutdown` API;<br>• the deployed extensions' shutdown handlers;<br>• production `/capacity` (new fields sane, heap cap 4 GiB unchanged) and A2 telemetry: baseline 17 consecutive-high pairs in 22 h; patch-free build 10:10–14:44 0; since the 14:44 restart 0 apart from the boot reading; heap 93–185 MiB.<br>**Not re-run:** live proofs. The staged verification agents could not launch, because the Claude Code auto-mode safety check returned no verdict; this becomes V2. **Decisions (owner accepted the recommendations):** §3 R2 block. **Plan changes:**<br>• status line;<br>• §3 R2 decisions;<br>• §4 intent check of blind spots, realistic child pattern, and live re-run at wave closure;<br>• §5 sequence and dependencies;<br>• R2 findings;<br>• new R2 follow-up wave (V2, B4.1, B5, B2.1, B3c);<br>• B1.3 F1 → B5;<br>• C2 input;<br>• E1 classes;<br>• two small items;<br>• §7 rules;<br>• §9 rows.<br>Verification worktree `/root/.worktrees/orch-scaling/r2-verify-pi-web-ui` (detached `93e20a5f`, built). |
| Wave 3 execution (R2 follow-up + first Stage C lanes) | 2026-09-29 | `19aabd3f-…` (orchestrating; owner authority: autonomous through Stage C to R3, no Claude models, restarts authorised) | **Routing:**<br>• implementers and verifiers on GLM 5.3 Flash (`pi` · `zai`; `max` for B4.1, B5, C2), all goal-armed;<br>• independent reviewer GPT-6 Luna (`pi` · `openai-codex` · `max`), one full round plus one closure round;<br>• the parent adjudicated after the cap and verified directly.<br>**Lanes:**<br>• V2a/V2b: evidence;<br>• B4.1: REJECT ×2, correction 02 parent-verified, including the parent's own live WebSocket re-run 10/10;<br>• B5: REJECT, closure REJECT on `submitSteer` only, correction 02;<br>• C4: ACCEPT WITH FIXES;<br>• C5: REJECT ×2, correction 02;<br>• B3c: ACCEPT WITH FIXES, fixes applied by the parent;<br>• S1: parent-verified.<br>**Parent catches:**<br>• the self-drain case;<br>• B3c's cumulative metrics files, re-windowed per run;<br>• C5's `/proc` scan cost (~0.5 s, headerless creates only) and a real-`/proc` check for spurious EACCES;<br>• two merge defects: C5's batch-entry type field dropped by hunk resolution, and C5 test fixtures broken by C4's default-on cwd check. Both were caught by typecheck, the line-survival check and the suite, then fixed;<br>• the integration suite broken by B5's async cleanup, fixed.<br>**Goal-engine anomalies** (for the skill review): a Pi goal was marked `failed` ("run ended in under 15000ms") while the child kept working; a goal start on a busy session held its HTTP response ~38 min. **Gates on master `f43165a8`:** lint, typecheck, build and docs 0; server unit 5,913 passed; integration 130; client 1,657. Agent OS mirror 1.56.0 (`15bda8d`). **Production:** C2's goal paused first (the old drain cannot see goal turns); `production:drain-restart` settled in 54 ms; restart 2026-09-29 20:59 UTC, MainPID 2957930 → 3803413; contract 1.56.0; smoke OK (missing-cwd create 400 `PREFLIGHT_FAILED`; create, prompt, `DELETE`). C2's goal resumed. |
| Stage C completion + side work | 2026-09-30 | `19aabd3f-…` (orchestrating; owner authority as wave 3, plus the requests below) | **Stage C:** C2, C1, C3a/C3b and C6 shipped (Luna-reviewed or parent-verified; see §9 and the C*.md bundles); production drain-restarts 03:33 and 09:55 UTC, contract 1.58.0 and stability window open. **Owner side requests:** `pi-orch` published as a public repo; public Pi Web UI orchestration skill pack; Agent OS contract-mirror guard (M1); gitleaks + secret scanning, no paid CI. **Incidents:** an external benchmark starved the event loop (owner set `CPUWeight=1000`; L1 groups lag alerts per incident and adds CPU telemetry); GitHub CI red since wave 3 fixed by F1; a voided C1 live run on an unapproved route (credential rule tightened). **R3 inputs:** T1 CPU load test ([`T1-CPU-LOAD.md`](./execution-reports/orchestration-scaling/T1-CPU-LOAD.md); summary in the *CPU input for R3* note in §6). **Reviewer entry point:** `/root/orch-ops/orchestration-scaling/R3-HANDOFF.md` (lanes, owner decisions, incidents, open items); detailed log `STATE-wave3.md`. |
| R3 (opened) | 2026-09-30 | `a7de099d-34d5-562a-a8ae-9faf8f1e7fbb` (fresh Opus; Claude Code Remote Control, from `R3-HANDOFF.md`) | **Inputs checked:** Stage C bundles and Luna reviews; T1 report, driver and raw data; production A2/L1 telemetry and the unit journal since the 09:55 restart (per-turn CPU, the 11:43 episode, `LoopAttribution` tags, the service cgroup's consumed CPU and memory peaks); CI on pi-web-ui, pi-orch and agent-workflow-skills; production build and `CPUWeight`. Re-ran: C6 guard + client drift tests 25/25, `pi-orch` 197/197, Agent OS mirror 1.58.0. Not re-run: live proofs. **Findings:** *R3 review reading* in §6; Stage C met §4's independent live re-run for C2 only. **Owner input:** the CPU test was motivated by host-wide contention (another agent's benchmark), not the Internal API's own CPU; a parent can spread children across providers; minimise waiting (no more long soaks or waiting windows). **Plan changes (owner accepted):** status line; *R3 review reading*; R3 opened paragraph; new R3 follow-up wave G1–G5; §5 sequence and dependencies; §9 rows (R3, G1–G5, the stale C1 publishing note). **Decisions (owner accepted the recommendations; §3 R3 block):** D0 authorised, D1 and Phase 8 to R4; cap 15; C6 window to R5 without blocking planned steps; Jev re-measure into E2; E2 soak bounded; GLM children with DeepSeek fallback; DeepSeek route kept; opencode-go 400s on the E1 watch list; pack sync as a small item; worktree clean-up. **Further plan changes:** status line; §3 R3 block; R3 held; new D0; D1 note; R4 inputs; E2; small item; §5; §9. **Next review moment: R4**, after the R3 follow-up wave and D0. |

## 9. Status ledger

| Step | Status | Evidence | Notes |
|---|---|---|---|
| A1 | **complete with deviations; verdict accepted at R1**. Run `full-1790411484255-ec8b813c`: server V8 heap OOM after 5 h 03 min (146 → 4,044 MB post-GC); coverage 20.8%; harness missed the death | [`A1-harness.md`](./execution-reports/orchestration-scaling/A1-harness.md), [`A1-soak.md`](./execution-reports/orchestration-scaling/A1-soak.md); run dir `/root/.pi-web-ui/validation/heap-soak/full-1790411484255-ec8b813c/` | Not repeated; the B1 confirmation soak is its rerun |
| A2 | **shipped** (`2471b964`; in production since the 2026-09-27 17:39 UTC restart; production gate checked 2026-09-28: metrics file present and growing, journal `Memory:` lines 120/h → 1/h) | [`A2.md`](./execution-reports/orchestration-scaling/A2.md); reviews `/root/orch-ops/orchestration-scaling/reviews/a2-luna-review.md` | Disposable proof: one alert then one recovery, bounded rotation, `Memory:` lines 120/h → 0/h. Independent review found validation-mode escapes (production metrics path, notification override, validation root inside production metrics); all fixed and re-verified by the parent |
| R1 | **held 2026-09-27** | §8 | Leak proven, two retainers named; heap cap deferred to R2; Stage B cleared |
| B0 | **shipped** (`054c9d99`) | [`B0.md`](./execution-reports/orchestration-scaling/B0.md); reviews `…/reviews/b0-luna-review.md` | Positive controls re-checked by the parent (server death, restart after death, empty snapshot, audit, overlay). **New defect found after merge:** the launcher runs `server/dist` from its own checkout without checking that the build matches HEAD. A pre-fix `dist` made the first post-merge micro-soak and soak look leaky. Open follow-up B0.1: refuse or rebuild a stale `dist` (record the build commit). |
| B0.1 | **shipped** (`ddccf8bf`) | [`B0.1.md`](./execution-reports/orchestration-scaling/B0.1.md); reviews `…/reviews/b0-1-luna-review*.md` | Harness ready for D1 (bounded `--hours`) and E2 (24 h); final micro 29/29, retained deleted children 0 |
| B1 | **shipped** (`5bbc95a6`; `pi-enhancement` `97a7106`, deployed to `~/.pi/agent/extensions` 2026-09-27 16:21 UTC; in production since the 2026-09-27 17:39 UTC restart) | [`B1.md`](./execution-reports/orchestration-scaling/B1.md); [`B1-confirmation-soak.md`](./execution-reports/orchestration-scaling/B1-confirmation-soak.md); reviews `…/reviews/b1-luna-review.md` | Confirmation soak `full-1790523945117-ea387201` passed: 24 h alive, post-GC ~200 MB flat, 8,092 children, trailing slope 0.31 MB/h. Accepted residuals: `SessionPool` shutdown cleanup (at review); one bounded extension slot. Third small retainer → B1.1 |
| B1.1 | **shipped** (`a48ad8f1`; in production 2026-09-29 00:05 UTC) | [`B1.1.md`](./execution-reports/orchestration-scaling/B1.1.md); reviews `…/reviews/b1-1-luna-review*.md` | Watcher retention 0 at 3,000 files; live-session reads coalesced (1 read vs 114) |
| B1.2 | **merged, in production** (`b55ca2e8`; restart 2026-09-29 00:05 UTC); **patch replaced by the public API in B1.2b** (`683ffa56`, restart 2026-09-29 10:10 UTC); **production telemetry: 0 spike minutes (lag p99 ≥ 300 ms) in 4.5 h on the patch-free build (10:10–14:43 UTC, final read before the wave-2 restart; max p99 223 ms at boot, mean activeTurns 0.47) against 17 in 22 h (0.77/h) at baseline and 3 in 10 h on the patch build (2 of them its own restart)**; the only ≥ 300 ms stalls are single `pi.multi.create_session` opens in new directories (8), never a sustained minute | [`B1.2.md`](./execution-reports/orchestration-scaling/B1.2.md); reviews `…/reviews/b1-2-luna-review*.md` | Reproduction p99 388–533 → 98–201 ms, spike minutes 6 → 0; proposed B2 gate 300 ms sustained / 150 ms recovery |
| B1.3 | **shipped 6/6; live-checked 2026-09-29 on the production build (4/4 + positive control, [`B1.3-live.md`](./execution-reports/orchestration-scaling/B1.3-live.md))** (`pi-enhancement` `7c11e1d`, deployed 2026-09-29 00:04 UTC; `subagent` option B `b046a8a`, deployed 2026-09-29 10:09 UTC; cached 16/16) | B1.2.md (B1.3 sections); `/root/orch-ops/orchestration-scaling/b1-3s/B1.3s.md` | Finding F1 (no `session_shutdown` on Web UI dispose) goes to R2 |
| B2 | **shipped** (`d017f145`, contract 1.49.0; in production since 2026-09-29 14:44 UTC; independent live re-run V2 20/20 + 5/5) | [`B2.md`](./execution-reports/orchestration-scaling/B2.md); reviews `…/reviews/b2-luna-review*.md` | `heap_pressure` (0.75 of `heap_size_limit`, hysteresis) and `event_loop_lag` (300 ms sustained / 150 ms recovery, confirmed by B1.2 telemetry; stale telemetry resets the latch); creates gated; non-slot refusals 503; DELETE never refused (own disposal lane); validation-only pressure override bound to the validation child identity. Luna REJECT (2 majors) → correction 01 → ACCEPT. Live 20/20 + 5/5 |
| B3 | **tool-argument cap shipped as B3a** (`3da55e78`, contract 1.48.0, in production 2026-09-29 10:10 UTC); **output-token and streamed-byte caps shipped as B3b** (`d017f145`, contract 1.50.0; in production since 2026-09-29 14:44 UTC; independent live re-run V2 as designed; byte default re-sized in B3c) | [`B3a.md`](./execution-reports/orchestration-scaling/B3a.md), [`B3b.md`](./execution-reports/orchestration-scaling/B3b.md); reviews `…/reviews/b3a-luna-review*.md`, `…/b3b-luna-review*.md` | B3a replaces the removed pi-ai patch (64 KiB/256 KiB, kept by the owner 2026-09-29; unpaced residual → R2). B3b: 1,000,000 output tokens (message end) and 16 MiB streamed bytes per run, `run_budget_exceeded`; defaults from 2,382 merged real runs (max 270,689 tokens / 1,050,331 bytes, 0 over). Luna ACCEPT WITH FIXES → correction 01 → closure REJECT on evidence only → parent-adjudicated evidence correction 02 (parent re-ran the measurement). Live: paced and realistic-rate aborts at the cap, second session streaming throughout, lag p99 ≤ 245 ms |
| B4 | **shipped** (`d017f145`, contract 1.51.0; in production since 2026-09-29 14:44 UTC; independent live re-run V2 27/27) | [`B4.md`](./execution-reports/orchestration-scaling/B4.md); reviews `…/reviews/b4-luna-review*.md` | `/api/v1/drain`, `SERVER_DRAINING`, settle over turns and nonterminal receipts, `interrupted_by_restart` classification with watch firings (fixed wake-text suffix, one wake per session); deploy scripts drain by default, fail closed on unknown API state, keep verb semantics, self-lock, forced restarts need a durably recorded reason. Luna REJECT (4 majors) → correction 01 → ACCEPT. Live 27/27 on a disposable unit. The wave-2 restart ran through `production:drain-restart`'s legacy pre-flight (the old server had no `/drain`); every later restart drains |
| R2 | **decisions held 2026-09-29** | §8, §3 | Thresholds kept (lag conditional on V2); production lag and watcher growth provisionally closed; F1 → B5; conditional go for Stage C. B2, B3b and B4 stay "merged" until V2's re-runs |
| V2 | **done 2026-09-29** (lanes v2a, v2b; GLM 5.3 Flash; parent-verified against raw evidence) | `/root/orch-ops/orchestration-scaling/v2a/REPORT.md`, `…/v2b/REPORT.md` | Re-runs on master `93e20a5f`: B2 20/20 + 5/5; B3b all four scenarios as designed; B4 27/27. **Drain gap confirmed live**: a goal continuation turn left the drain settled in 3 ms with no receipt, the restart killed the child, and no watch fired; the plain-prompt control was reconciled. **F1 confirmed live**: a background-shell process survived `DELETE`. **Fan-out probe**: 6 trials at production defaults with the real extension set; max p99 143 ms, one 600 ms cold-open stall, no latch, 0 refusals. Byte-cap end-of-run stall scales with the cap (reported 16 MiB 180–651 ms, 8 MiB ≤ 181, 4 MiB ≤ 119; per-run files not preserved, so B3c re-measures) |
| B4.1 | **shipped** (wave 3, contract 1.52.0; Luna REJECT ×2 → parent-verified correction 02; parent re-ran the live WebSocket fence check 10/10) | [`B4.1.md`](./execution-reports/orchestration-scaling/B4.1.md) | Gate before scaling up. The drain must count extension-driven and browser turns and reconcile them at boot |
| B5 | **shipped** (wave 3, no wire change; Luna REJECT → correction 01 → closure REJECT on `submitSteer` only → parent-verified correction 02) | [`B5.md`](./execution-reports/orchestration-scaling/B5.md) | Gate before scaling up. Dispose emits `session_shutdown` (F1) |
| B2.1 | **dropped** (V2: the fan-out probe never tripped the gate) | V2 | The 300 ms / 2-reading gate stays |
| B3c | **shipped** (wave 3, contract 1.56.0; Luna ACCEPT WITH FIXES, fixes applied by the parent) | [`B3c.md`](./execution-reports/orchestration-scaling/B3c.md) | Default 4 MiB. Worst end-of-run stall: 8 MiB 209 ms (fails the 200 ms rule); 4 MiB 132 ms; the new default 156 ms, with no reading ≥ 300 ms |
| C4 | **shipped** (wave 3, contract 1.53.0; Luna ACCEPT WITH FIXES → correction 01, parent-verified) | [`C4.md`](./execution-reports/orchestration-scaling/C4.md) | `PREFLIGHT_FAILED`; optional `preflight`; default-on create cwd check; tools resolved on the runtime child PATH |
| C5 | **shipped** (wave 3, contract 1.54.0; Luna REJECT ×2 → parent-verified correction 02) | [`C5.md`](./execution-reports/orchestration-scaling/C5.md) | `parentSource`; peer-credential parent resolution, fail-closed; `?parent=`. Residual: a create without the header costs a ~0.5 s async `/proc` scan (C1's client always sends the header) |
| Weekly refresh budget (small item) + E1 ledger | **shipped** (wave 3, lane s1, parent-verified) | [`S1-E1.md`](./execution-reports/orchestration-scaling/S1-E1.md); [`RECURRING-DEFECT-LEDGER.md`](../RECURRING-DEFECT-LEDGER.md) | Job budget 150 s = 20 s drain + 10 s slack + 30 s TimeoutStopSec + 90 s start, pinned by tests |
| C2 | **shipped** (`36c2649f`, contract 1.57.0; Luna REJECT → correction 01 → closure ACCEPT; parent re-ran the focused tests and the integrated gates; in production since 2026-09-30 03:33 UTC with C1 and C3a) | [`C2.md`](./execution-reports/orchestration-scaling/C2.md); reviews `…/reviews/c2-luna-review*.md` | Auto-compaction is busy (`409 SESSION_BUSY`); `follow_up` needs a live turn; one Pi liveness predicate (manager busy/streaming, `sdkStreaming`, compaction) for every busy decision; `NEVER_STARTED` start watchdog (default 120 s; live-proven with a disclosed test-only trigger); `RUN_TRANSPORT_LOST` post-terminal fence. **Accepted boundary (parent decision):** turns started by an extension or the browser (goal continuations, watch-wake deadlines, browser prompts) have no Internal API receipt, so `NEVER_STARTED` does not cover them. The goal engine owns their failures (its error and short-run rules end the goal, which fires the parent's `goal_end` watch), B4.1 covers them at restarts, and parents keep `goal_end` watches plus a parent-side backstop |
| C1 | **shipped** (`a31b19b9`, in production since 2026-09-30 03:33 UTC incl. snapshot regen; client repo `/root/pi-orch`, public since 2026-09-30 at `github.com/valtterimelkko/pi-orch`; Luna REJECT ×2 → parent-verified correction 05) | [`C1.md`](./execution-reports/orchestration-scaling/C1.md); reviews `…/reviews/c1-luna-review*.md` | Verbs spawn/prompt/wait/result/verify(stub)/cleanup/status; `wait` is watch-based (long poll), fails fast on unknown or mismatched runs, waits on several children in one call, classifies `goal_end` from the goal projection; no implicit retry of non-idempotent creates (`CREATE_UNKNOWN`). Live: 5 patterns 18/18; real GLM parent 5 children with 0 curl and 0 sleep (recounted by the parent from the preserved transcript), lineage 100%, route `zai/glm-5.3-flash` 100%. Incident recorded: the first real-parent attempt ran 5 children on Claude Haiku and 6 on an unapproved route (voided; credentials now restricted to the approved route) |
| C3 | **server half shipped as C3a** (`6786b251`, contract 1.58.0, in production since 2026-09-30 03:33 UTC; Luna REJECT → correction 01 → closure ACCEPT, independent recount 16/16); **client half shipped as C3b** (`/root/pi-orch` `559aef5`; evidence `df313dbe`; live 10/10 blocks, truthful 6/6 verified, planted false claims 2/2 caught) | [`C3a.md`](./execution-reports/orchestration-scaling/C3a.md) | `pi-completion/v1` block in a `completion` fence (a `json` fence counts only with the exact schema tag; the delimiter is recorded), receipt `completion`/`completionError`, `latestCompletion` per session for receipt-less goal turns. C3b: dispatch template (goal children get a pointer plus the verbatim paragraph as a follow-up), `result` from receipt or `latestCompletion`, read-only `verify` (commits exist in the claimed repo, `filesChanged` needs change evidence, `--rerun` only when the parent names the command); [`C3b.md`](./execution-reports/orchestration-scaling/C3b.md) |
| C6 | **declared** 2026-09-30 (`ebce3050`; parent-verified: a simulated 1.59.0 bump and a planted snapshot type both fail the guard) | [`C6.md`](./execution-reports/orchestration-scaling/C6.md); `docs/INTERNAL-API-CONTRACT.md` *Stability window* | Window opens at 1.58.0: patch bumps and docs only; anything client-observable needs an owner exception row. Guard: `contract-stability-window.test.ts` (version major.minor + snapshot shape fingerprint). **Length (R3, owner): open until programme close (R5); planned steps get recorded exceptions.** Also declared in the orchestration skill |
| R3 | **held 2026-09-30** (session `a7de099d`); decisions in §3 | §6 *R3 review reading*, §8 | Jev re-measure not yet possible (no real post-C `pi-orch` sessions). C1/C3 live proofs `claimed` until G5's independent re-run |
| G1 | not started | — | Per-route child concurrency in `pi-orch` |
| G2 | not started | — | Attribution fix; 11:43 episode root cause |
| G3 | not started | — | Watch registered before the first turn |
| G4 | not started | — | Session-create cost |
| G5 | not started | — | Real scale-up trial; independent re-run of the C1/C3/C5 live checks |
| D0 | not started (authorised at R3) | — | Tool processes out of the control plane's cgroup |
| D1–D2 | not started | — | Decided at R4 |
| E1–E2 | not started | — | |
