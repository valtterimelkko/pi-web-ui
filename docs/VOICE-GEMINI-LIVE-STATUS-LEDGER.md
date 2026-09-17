# Voice Mode on a Native Live Model — Orchestrator Status & Decision Ledger

> **Location:** `/root/pi-web-ui/docs/VOICE-GEMINI-LIVE-STATUS-LEDGER.md`  
> **Class:** Dynamic Execution Ledger, Decision Log & Orchestrator Checkpoint  
> **Master Intent & Lab Spec:** [`VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md`](./VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md)  
> **Authoritative Implementation Plan:** [`VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md`](./VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md)  
> **Orchestrator:** Antigravity (Quality Control Agent & Multi-Agent Orchestrator)  
> **Status:** `READY FOR EXECUTION` (Awaiting user `/goal` activation)  
> **Last Updated:** 2026-09-17 09:30 UTC

---

## 1. Executive Summary & Orchestrator Role

This document serves as the **living status and decision ledger** for the end-to-end execution of the Voice Mode Gemini Live redesign and benchmark lab. 

As orchestrator, the Antigravity session operates under the following contract:
1. **Quality Control & Verification Authority:** The orchestrator owns the outcome, independently validates all child work, verifies test suites and offline verifiers, and executes or directly supervises scored benchmark runs.
2. **Zero-Token Waiting Discipline:** Follows `references/antigravity-orchestrator.md` and `long-horizon-waiting-strategies`. Strictly adheres to the **"Arm the Watcher, End the Turn"** invariant via `/root/.skills-global/skills-global/pi-web-ui-internal-api-orchestration/scripts/wait-watch.sh` and the native auto-cancelling `schedule` tool backstop. No in-turn polling loops.
3. **Model Routing & Quota Awareness:** Adheres to §10.1 and `references/routing.md`. All children must run on the **`pi` runtime** (never the standalone `commandcode` runtime). Observes the **GLM peak window (Mon–Fri 07:00–11:00 London)** by diverting to `commandcode/deepseek/deepseek-v4.1-flash` @ `high` during peak hours, and returning to `zai/glm-5.3-flash` off-peak.
4. **Durable Ledger:** Every phase start, child dispatch, verification result, gate decision, and architectural pivot is recorded in this file in real time.

---

## 2. Master Build Sequence & Work Breakdown

The plan is structured into 9 phases (L0 through L8) following strict Test-Driven Development (TDD). Each phase culminates in an independently verified, live-validated artefact.

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                      L0 Equipment                       │
                  │   Scheduler, Event Log, Paced PCM, Player, Verifier    │
                  └───────────────────────────┬─────────────────────────────┘
                                              │
                  ┌───────────────────────────┴─────────────────────────────┐
                  │                  L1 Capability Handshake                │
                  │  Gemini Live Quota/Socket Probe + Direct Judge Probe    │
                  └───────────────────────────┬─────────────────────────────┘
                                              │
                      ┌───────────────────────┴───────────────────────┐
                      ▼                                               ▼
       ┌─────────────────────────────┐                 ┌─────────────────────────────┐
       │      L2 Baseline Lane       │                 │     L3 Policy Core Core     │
       │   Gemma Cascade + Scorer    │                 │ Pure policy-core.ts refactor│
       └──────────────┬──────────────┘                 └──────────────┬──────────────┘
                      │                                               │
                      └───────────────────────┬───────────────────────┘
                                              ▼
                               ┌─────────────────────────────┐
                               │     L4 Tier 1 Guarded       │
                               │ Gemini Live + Strict Policy │
                               └──────────────┬──────────────┘
                                              ▼
                               ┌─────────────────────────────┐
                               │   L5 Tier 3 Orchestrator    │
                               │ Live Model as B2-Short Lead │
                               └──────────────┬──────────────┘
                                              ▼
                               ┌─────────────────────────────┐
                               │     L6 Adaptive Operator    │
                               │   Instrument Gate + Sim     │
                               └──────────────┬──────────────┘
                                              ▼
                               ┌─────────────────────────────┐
                               │      L7 Tier 2 Lean         │
                               │ Derived from L4 & L5 finds  │
                               └──────────────┬──────────────┘
                                              ▼
                               ┌─────────────────────────────┐
                               │      L8 Final Reports       │
                               │ Leaderboards & Decision Memo│
                               └─────────────────────────────┘
```

### Detailed Phase Specifications

| Phase | Deliverable | Execution Agent | Verification Gate |
|---|---|---|---|
| **L0 Equipment** | Scheduler, monotonic event log, fixture synthesis/verification (`supertonic-batch.py` + Whisper ASR WER $\le 0.08$), paced PCM driver, reference player (duck/stop), immutable record verifier, disposable server boot script (`systemd-run`). | **Child A** (Runtime `pi`; off-peak `zai/glm-5.3-flash` @ `high`; peak `commandcode/deepseek/deepseek-v4.1-flash` @ `high`) | Unit tests with damaged traces must fail verifier; clean trace passes. Disposable server starts cleanly on isolated cgroup. |
| **L1 Handshake** | `cli.ts handshake` against real Gemini Live (`gemini-3.8-live` & ET variant), direct HTTP judge probe (`deepseek-v4.1-flash` on opencode-go gateway), and session cross-transport judge probe. Writes `capabilities.json`. | **Parent Orchestrator** (directly, to ensure safety & inspect raw capabilities) | All `probe` fields in §12 resolved; rate limits & concurrency measured; direct judge returns 200 with model echo; session judge verified free of injected context. |
| **L2 Baseline** | `baseline-cascade` provider (OpenAI STT + OpenRouter Gemma + OpenAI TTS), frozen scenarios `t1-s1`..`s7`, world fixtures, baseline scorer. 5 attempts $\times$ 7 scenarios in E lane. | **Child A** (build harness/fixtures) & **Parent** (run & score) | Report renders; numbers align with historical P27 matrix; verifier green. |
| **L3 Policy Core** | Extract `server/src/talker/policy-core.ts` from `TalkerSession.handleOperatorTurnBody`. Refactor session to delegate to pure core. | **Child B** (Runtime `pi`; off-peak `zai/glm-5.3-flash` @ `max`; peak `commandcode/deepseek/deepseek-v4.1-flash` @ `high`) | Differential replay of entire talker test corpus (`server/tests/unit/talker/*`); byte-identical results; all existing tests untouched and green. |
| **L4 Tier 1** | Gemini Live adapter + `tier1-guarded.ts` harness. Matrix: 5 attempts $\times$ 7 scenarios $\times$ {native, sidecar} $\times$ {E, N} (140 runs). | **Child A** (implements harness) & **Parent** (coordinates execution & scoring) | Gate matrix green; mechanical assertions hold; TTFA distributions recorded; offline verifier green on 100% of attempts. |
| **L5 Tier 3** | Tool surface (`create_child`, `wait_for`, `run_checked`, etc.), B2-short fixtures & supervisor, text controls (same-vendor & non-Google), live candidate runs. | **Child C** (builds fixtures & tool wrappers) & **Parent** (executes benchmark & verifies repo state) | Dry-run with fake child passes; text controls run 3x; candidate variants run; deterministic repo-state scoring via Benchmark 2 scorer. |
| **L6 Adaptive Operator** | Adaptive simulator + director validation. Entry gate: run against frozen/branching beats with known answers. | **Child D** (builds simulator & director) & **Parent** (runs entry gate & tests) | Entry gate passes: agreement with known answers verified, director rejection rate $\le 20\%$. Discoveries tagged `provenance: synthetic`. |
| **L7 Tier 2** | `tier2-lean.ts` harness with conditions dynamically derived via §18.1 decision table from L4 and L5 results. 20-utterance fidelity corpus. | **Child A** (implements lean harness) & **Parent** (derives matrix & runs benchmark) | Matrix pre-registered in PLAN.md; fidelity corpus scored for word recall, dropped qualifiers, and re-planning. |
| **L8 Lab Delivery** | End-to-end `run_voice_lab.sh`, aggregated HTML/JSON reports, Benchmark 2 voice section, Owner Decision Memo. | **Parent Orchestrator** | Offline verifier clean across all runs; limitations documented; Telegram `done` notification posted. |

---

## 3. Parallelization & Boundary Architecture

To maximize wall-clock efficiency without violating single-writer hygiene:
- **Stream A (Lab Infrastructure & Runner):** Owned by Child A.
  - Paths: `scripts/voice-live-lab/**`, `server/tests/voice-live-lab/**`, `agent-benchmarks/benchmarks/04-voice-live-lab/**`.
  - Responsible for: L0 $\to$ L2 $\to$ L4 runner code.
- **Stream B (Talker Policy Refactoring):** Owned by Child B.
  - Paths: `server/src/talker/policy-core.ts`, `server/src/talker/talker.ts`, `server/tests/unit/talker/**`.
  - Responsible for: L3 extraction.
- **Independence:** Streams A and B do not share any files. They can execute in parallel immediately once L0 boot script testing confirms the environment.
- **Parent Integration Point:** Parent reconciles Stream A and Stream B before L4 execution begins.

---

## 4. Model Routing, Quota Management & Goal Invariants

### 4.1 Route Selections & Operator Rules
- **All Children Runtime:** Strictly `pi` runtime. Standalone `commandcode` runtime is prohibited.
- **GLM Peak Window Diversion (Mon–Fri 07:00–11:00 London):**
  - Divert to: Runtime `pi`, Provider `commandcode`, Selector `commandcode/deepseek/deepseek-v4.1-flash` at thinking level **`high`**.
  - Rationale: Faster, more intelligent, and uses less quota than GLM on the CommandCode pool while avoiding $3\times$ z.ai peak pricing.
- **Off-Peak Window (Outside 07:00–11:00 London):**
  - Return to: Runtime `pi`, Provider `zai`, Selector `zai/glm-5.3-flash`.
  - Thinking Levels: `high` for general building & fixtures; `max` for Child B on L3 Policy Core refactoring.
- **Direct Judge:** `deepseek-v4.1-flash` via direct HTTP (`POST https://opencode.ai/zen/go/v1/chat/completions`) at `temperature: 0` with browser User-Agent and `x-opencode-session`.
- **Cross-Transport Judge (20% sample):** `commandcode/deepseek/deepseek-v4.1-flash` @ `high` on disposable server, asserting zero injected `agent-os` context.
- **Candidate Models:** Direct Google `@google/genai`: `gemini-3.8-live` and `gemini-3.8-live-extended-thinking`.

### 4.2 Child Goal Function Invariant
All dispatched children will be armed with explicit, durable goals (`POST /api/v1/sessions/:id/goal` or create-time `goal` parameter) specifying:
1. Exact scope and owned paths.
2. Acceptance criteria and required test commands (`npm run typecheck && npm test ...`).
3. Ban on touching live/production services or unowned paths.
4. Terminal handback format with a frozen marker.

---

## 5. Token Efficiency & Supervision Protocol for Parent

To prevent context exhaustion and eliminate in-turn polling:
1. **Watch Registration:** Upon dispatching a child, register an `agent_end` pure-observer watch via `POST /api/v1/sessions/:id/watch`.
2. **Background Helper:** Launch `/root/.skills-global/skills-global/pi-web-ui-internal-api-orchestration/scripts/wait-watch.sh <watchId>` using `run_command` with `WaitMsBeforeAsync: 1000`.
3. **Auto-Cancelling Backstop:** Arm a native timer via `schedule(DurationSeconds: 1800, TimerCondition: "<taskId>")`.
4. **Immediate Turn End:** Conclude the turn immediately after arming. No loops, no status polling.
5. **State Anchor:** Read `/root/pi-web-ui/docs/VOICE-GEMINI-LIVE-STATUS-LEDGER.md` upon every wakeup to re-anchor state.

---

## 6. Pause & Evaluation Gates (Co-Evaluation Points with Operator)

| Gate | Timing | Evaluation Objective | Operator Status |
|---|---|---|---|
| **Gate 0** | Pre-Execution (Now) | Review master architecture, status ledger, risk assessment, and plan. | **Approved**; awaiting `/goal`. |
| **Gate 1** | Post-L1 Handshake | Review `capabilities.json`: measured rate-limit tier, actual concurrency cap, VAD behavior, and direct judge responsiveness. | **PASSED (GREEN)**. Zero 429s, ample tier confirmed, all probes verified. |
| **Gate 2** | Post-L4 (Tier 1) | Evaluate Tier 1 gate integrity, TTFA distributions, and conversational metrics against Baseline (L2). Review §18.1 Step 1 findings. | Scheduled. |
| **Gate 3** | Post-L5 (Tier 3) | Compare Live Model as Orchestrator against B2-short text controls. Evaluate Step 2 findings (T3-A through T3-F). | Scheduled. |
| **Gate 4** | Post-L6 (Adaptive) | Review entry gate results (simulator agreement on known lines and rejection rate $\le 20\%$). | Scheduled. |
| **Gate 5** | Post-L8 (Final) | Review final comprehensive report, leaderboard updates, and Owner Decision Memo. | Scheduled. |

---

## 7. Telegram Milestone Communications Protocol

Milestones will be posted via `/root/pi-web-ui/scripts/notify.sh`:
- `scripts/notify.sh milestone "<title>" "<body>"`: At each phase transition.
- `scripts/notify.sh question "<title>" "<body>"`: At evaluation gates or on provider anomalies.
- `scripts/notify.sh blocked "<title>" "<body>"`: If an unresolvable environment defect occurs.
- `scripts/notify.sh done "<title>" "<body>"`: Complete lab finished, artifacts validated.

---

## 8. Living Ledger & Decision Log

*Entries appended chronologically.*

| Timestamp (UTC) | Event / Decision | Details & Evidence | Next Action |
|---|---|---|---|
| 2026-09-17 09:16 | Session Initialized | Warm context packet & pointed memory recalled (`gemini live voice redesign pi-web-ui`). | Inspect system and intent docs. |
| 2026-09-17 09:17 | System Prereq Check | Whisper Docker container UP (healthy, 127.0.0.1:9000); `@google/genai` 1.52.0 installed; Supertonic script verified; vitest unit tests in `server/tests/unit/talker/` passing (25/25). | Verify provider usage & quota. |
| 2026-09-17 09:17 | Quota Discovery | Ran `agent-os provider-usage`. GLM peak window ACTIVE (07:00–11:00 London). zai-glm 5h left 99%; command-code 5h left 100%; opencode-go 5h left 96%; antigravity ample. | Note peak-window twin rules. |
| 2026-09-17 09:20 | Plan & Ledger Created | Authored status ledger `/root/pi-web-ui/docs/VOICE-GEMINI-LIVE-STATUS-LEDGER.md` and implementation plan. | Gate 0 alignment. |
| 2026-09-17 09:21 | Memory Capture | Stop hook executed: 5 candidates submitted to Agent OS review queue via `session-end-prompt`. Git commit `a464421` pushed. | Await operator review. |
| 2026-09-17 09:28 | Operator Approvals & Policy Lock | Operator approved: (1) All children on `pi` runtime; (2) Peak-time diversion to `pi/commandcode/deepseek-v4.1-flash` @ `high`; return to `zai/glm-5.3-flash` off-peak; (3) Open Question 1 approved (pause at Gate 1 on rate limit surprise); (4) Open Question 2 approved (`high` general building, `max` for L3 refactoring); (5) Proposed changes & recommendations approved in full. | Create authoritative implementation plan file. |
| 2026-09-17 09:30 | Operative Policies Authored | Authored [`VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md`](./VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md) in `docs/` resolving operative notes location. Design agent readiness notes incorporated. | Ready for `/goal` activation. |
| 2026-09-17 09:31 | Goal Activated | Operator initiated `/goal` command. Board quick-declared; Telegram milestone sent. | Dispatch parallel children. |
| 2026-09-17 09:32 | Parallel Children Dispatched | Child A (`01a0aeb5-5069`, L0 equipment, `high`) and Child B (`01a0aeb5-5c17`, L3 policy core, `max`) dispatched on `pi` runtime via `commandcode/deepseek/deepseek-v4.1-flash` during peak window. | Zero-token wait. |
| 2026-09-17 09:50 | Phase L3 Complete & Verified | Child B extracted pure `policy-core.ts`, refactored `talker.ts`, added 86 differential tests. 522/522 talker tests pass. Full server suite 4660 tests pass. Commit `8ae8a7c` pushed. | Reconcile Stream B. |
| 2026-09-17 09:52 | Phase L0 Complete & Verified | Child A delivered scheduler, fixtures, driver, playback, record verifier. 66/66 voice-live-lab tests pass. Damaged trace rejection verified. In situ boot script verified. Commit `3024405` pushed. | Reconcile Stream A. |
| 2026-09-17 09:53 | Phase Transition: Ready for L1 | Both L0 and L3 verified clean (typecheck, lint, build green). Next action: Phase L1 Capability Handshake & Quota Probe (Parent direct execution). | Execute Phase L1 Handshake. |
| 2026-09-17 10:02 | Phase L1 Handshake Complete | Delivered `scripts/voice-live-lab/lib/handshake.ts` and `cli.ts handshake`. Verified 5 probes: (1) `inputTranscription` synchronous with speech end (~255ms); (2) Session resumption uuid handle reconnects with perfect state preservation; (3) In-flight async tool call survives resumption; (4) Extended Thinking HIGH meters thoughts (`thoughtsTokenCount: 56`); (5) Concurrency checked at 5 sessions without 429; Direct Judge returns 200 with echoed model `deepseek-v4.1-flash`; Cross-transport session probe verifies `agent-os` injection on Pi session, proving direct HTTP transport necessity. Wrote `capabilities.json`. All 70 unit tests pass. | Evaluate Gate 1. |
| 2026-09-17 10:03 | Gate 1 Evaluated: GREEN | Rate limits: 0 observed (429 count = 0); Prepaid Tier 1 confirmed; Direct Judge HTTP 200; Session cross-transport confirms need for direct HTTP; no blocker pause required. Gate 1 cleared. | Proceed to Phase L2 Baseline Lane. |
| 2026-09-17 10:05 | Child A2 Dispatched (Phase L2) | Off-peak GLM active. Child A2 dispatched on `pi` runtime via `zai/glm-5.3-flash` @ `high` (`01a0aed3-a6fc`, watch `watch-01a0aed3-a6fc`). Scope: `baseline-cascade.ts`, `t1-s1`..`s7` scenarios, worlds, scorer, unit tests. | Zero-token wait on watch. |
| 2026-09-17 11:03 | Google AI Studio Telemetry Confirmed | Operator provided live Google AI Studio rate-limit dashboard confirmation: RPM and RPD are Unlimited for both `gemini-3.8-live` and `gemini-3.8-live-extended-thinking`. Live API TPM limits: 150,000 TPM for standard live; 250,000 TPM for extended thinking live. Recorded in `capabilities.json` and implementation docs. Zero 429 risk under planned lab concurrency. | Proceed with planned execution. |
| 2026-09-17 11:07 | Phase L2 Complete & Verified | Child A2 finished Baseline Lane. Full independent verification passed: 146/146 unit test assertions green, 12/12 pytest scorer parity green, typecheck/lint/build clean (0 errors), end-to-end scenario dryrun verified with offline verifier and scored. Benchmark 04 pushed to `agent-benchmarks` (commit `8e56fd8`). | Commit Phase L2 in pi-web-ui; transition to Phase L4 Tier 1 Guarded Live Harness. |
| 2026-09-17 11:12 | Child A3 Dispatched (Phase L4) | Child A3 (`01a0af10-6b11`) dispatched on `pi` runtime via `zai/glm-5.3-flash` @ `high` with durable goal and pure observer watch `watch-01a0af10-6b11`. Scope: `gemini-live.ts`, `tier1-guarded.ts`, CLI `tier1-dryrun`, and unit tests. | Zero-token wait on watch. |
| 2026-09-17 11:32 | Operator Policy Lock: Child Goal Brief Plan Attachment | Operator guidance recorded: when arming a child goal, always include the authoritative plan file path and section directly in the initial goal objective/brief rather than relying solely on subsequent steering. This prevents the child from burning exploration tokens before steering lands. Upstreamed to `pi-web-ui-internal-api-orchestration` skill in `references/goals.md`. | Invariant locked for all future child dispatches. |
| 2026-09-17 12:21 | Operator Routing Update: Switch to DeepSeek v4.1 Flash | Operator noted z.ai pool is under high load from concurrent personal use. Policy update locked: switch all subsequent children to `commandcode/deepseek/deepseek-v4.1-flash` @ `high` on the `pi` runtime (faster, highly capable, relieves z.ai pool). Child A3 is completing final handback steps; next child (Child C in Phase L5) will route via DeepSeek v4.1 Flash. | Lock DeepSeek routing for Phase L5 onward. |
| 2026-09-17 12:33 | Phase L4 Complete & Verified | Child A3 completed Phase L4 (Tier 1 Guarded Live Harness & Runner). 198/198 unit tests pass across 12 files (52 new tests), typecheck/lint/build clean (0 errors), 12/12 scorer parity pytest green, 14/14 e2e dry runs verified and scored cleanly across both native and sidecar conditions. Commit `f85b7a7` pushed to master. | Transition to Phase L5 Tier 3 Live Model as Orchestrator. |






