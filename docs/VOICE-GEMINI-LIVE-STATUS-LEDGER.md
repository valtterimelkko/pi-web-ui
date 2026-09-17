# Voice Mode on a Native Live Model — Orchestrator Status & Decision Ledger

> **Location:** `/root/pi-web-ui/docs/VOICE-GEMINI-LIVE-STATUS-LEDGER.md`  
> **Class:** Dynamic Execution Ledger, Decision Log & Orchestrator Checkpoint  
> **Master Intent & Lab Spec:** [`VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md`](./VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md)  
> **Orchestrator:** Antigravity (Quality Control Agent & Multi-Agent Orchestrator)  
> **Status:** `PLANNING / PRE-DISPATCH` (Awaiting user `/goal` activation)  
> **Last Updated:** 2026-09-17 09:20 UTC

---

## 1. Executive Summary & Orchestrator Role

This document serves as the **living status and decision ledger** for the end-to-end execution of the Voice Mode Gemini Live redesign and benchmark lab. 

As orchestrator, the Antigravity session operates under the following contract:
1. **Quality Control & Verification Authority:** The orchestrator owns the outcome, independently validates all child work, verifies test suites and offline verifiers, and executes or directly supervises scored benchmark runs.
2. **Zero-Token Waiting Discipline:** Follows `references/antigravity-orchestrator.md` and `long-horizon-waiting-strategies`. Strictly adheres to the **"Arm the Watcher, End the Turn"** invariant via `/root/.skills-global/skills-global/pi-web-ui-internal-api-orchestration/scripts/wait-watch.sh` and the native auto-cancelling `schedule` tool backstop. No in-turn polling loops.
3. **Model Routing & Quota Awareness:** Adheres to §10.1 and `references/routing.md`. Checks provider quotas dynamically with `agent-os provider-usage`. Observes the **GLM peak window (Mon–Fri 07:00–11:00 London)** by shifting GLM workloads to commandcode twins when peak is active.
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
| **L0 Equipment** | Scheduler, monotonic event log, fixture synthesis/verification (`supertonic-batch.py` + Whisper ASR WER $\le 0.08$), paced PCM driver, reference player (duck/stop), immutable record verifier, disposable server boot script (`systemd-run`). | **Child A** (`pi/zai` GLM 5.3 Flash @ `high` or CommandCode twin) | Unit tests with damaged traces must fail verifier; clean trace passes. Disposable server starts cleanly on isolated cgroup. |
| **L1 Handshake** | `cli.ts handshake` against real Gemini Live (`gemini-3.8-live` & ET variant), direct HTTP judge probe (`deepseek-v4.1-flash` on opencode-go gateway), and session cross-transport judge probe. Writes `capabilities.json`. | **Parent Orchestrator** (directly, to ensure safety & inspect raw capabilities) | All `probe` fields in §12 resolved; rate limits & concurrency measured; direct judge returns 200 with model echo; session judge verified free of injected context. |
| **L2 Baseline** | `baseline-cascade` provider (OpenAI STT + OpenRouter Gemma + OpenAI TTS), frozen scenarios `t1-s1`..`s7`, world fixtures, baseline scorer. 5 attempts $\times$ 7 scenarios in E lane. | **Child A** (build harness/fixtures) & **Parent** (run & score) | Report renders; numbers align with historical P27 matrix; verifier green. |
| **L3 Policy Core** | Extract `server/src/talker/policy-core.ts` from `TalkerSession.handleOperatorTurnBody`. Refactor session to delegate to pure core. | **Child B** (`pi/zai` GLM 5.3 Flash @ `max` for rigorous refactoring) | Differential replay of entire talker test corpus (`server/tests/unit/talker/*`); byte-identical results; all existing tests untouched and green. |
| **L4 Tier 1** | Gemini Live adapter + `tier1-guarded.ts` harness. Matrix: 5 attempts $\times$ 7 scenarios $\times$ {native, sidecar} $\times$ {E, N} (140 runs). | **Child A** (implements harness) & **Parent** (coordinates execution & scoring) | Gate matrix green; mechanical assertions hold; TTFA distributions recorded; offline verifier green on 100% of attempts. |
| **L5 Tier 3** | Tool surface (`create_child`, `wait_for`, `run_checked`, etc.), B2-short fixtures & supervisor, text controls (same-vendor & non-Google), live candidate runs. | **Child C** (builds fixtures & tool wrappers) & **Parent** (executes benchmark & verifies repo state) | Dry-run with fake child passes; text controls run 3x; candidate variants run; deterministic repo-state scoring via Benchmark 2 scorer. |
| **L6 Adaptive Operator** | Adaptive simulator (`zai/glm-5.3-flash` @ `high`) + director validation. Entry gate: run against frozen/branching beats with known answers. | **Child D** (builds simulator & director) & **Parent** (runs entry gate & tests) | Entry gate passes: agreement with known answers verified, director rejection rate $\le 20\%$. Discoveries tagged `provenance: synthetic`. |
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

### 4.1 Route Selections
- **Children (Build & Refactor):**
  - Preferred: `zai/glm-5.3-flash` on `pi` runtime at `high` thinking (and `max` for L3 policy extraction).
  - GLM Peak Window (Mon–Fri 07:00–11:00 Europe/London): Divert to `commandcode/z-ai/glm-5.3-flash` on `command-code` pool at `high` thinking.
- **Adaptive Simulator:** `zai/glm-5.3-flash` @ `high` (or commandcode twin during peak).
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

The orchestrator will pause and solicit operator review at five discrete gates:

| Gate | Timing | Evaluation Objective | Operator Input Needed |
|---|---|---|---|
| **Gate 0** | Pre-Execution (Now) | Review of master architecture, status ledger, risk assessment, and execution plan. | Confirmation to proceed (`/goal`). |
| **Gate 1** | Post-L1 Handshake | Review `capabilities.json`: measured rate-limit tier, actual concurrency cap, VAD behavior, and direct judge responsiveness. | Review empirical provider limits and approve execution of baseline/tier-1 runs. |
| **Gate 2** | Post-L4 (Tier 1) | Evaluate Tier 1 gate integrity, TTFA distributions, and conversational metrics against Baseline (L2). Review §18.1 Step 1 findings. | Review derived matrix for Tier 2 before code is generated. |
| **Gate 3** | Post-L5 (Tier 3) | Compare Live Model as Orchestrator against B2-short text controls. Evaluate Step 2 findings (T3-A through T3-F). | Decide whether Tier 2 is academic or critical-path. |
| **Gate 4** | Post-L6 (Adaptive) | Review entry gate results (simulator agreement on known lines and rejection rate $\le 20\%$). | Authorize adaptive exploration runs or proceed with frozen backbone. |
| **Gate 5** | Post-L8 (Final) | Review final comprehensive report, leaderboard updates, and Owner Decision Memo. | Production adoption decisions (e.g. native interrupt vs ducking, model replacement choice). |

---

## 7. Telegram Milestone Communications Protocol

Milestones will be posted via `/root/pi-web-ui/scripts/notify.sh`:
- `scripts/notify.sh milestone "<title>" "<body>"`:
  - L0 equipment suite verified green.
  - L1 capability handshake completed with live provider facts.
  - L2 baseline benchmark completed and scored.
  - L3 policy core refactor verified differential green.
  - L4 Tier 1 evaluation completed.
  - L5 Tier 3 orchestration benchmark completed.
  - L6 Adaptive operator entry gate passed.
  - L7 Tier 2 evaluation completed.
- `scripts/notify.sh question "<title>" "<body>"`: At designated evaluation gates or on unresolvable provider anomalies.
- `scripts/notify.sh blocked "<title>" "<body>"`: If an unresolvable environment defect occurs.
- `scripts/notify.sh done "<title>" "<body>"`: Complete lab finished, artifacts validated, and memory captured.

---

## 8. Living Ledger & Decision Log

*Entries will be appended chronologically as work progresses.*

| Timestamp (UTC) | Event / Decision | Details & Evidence | Next Action |
|---|---|---|---|
| 2026-09-17 09:16 | Session Initialized | Warm context packet & pointed memory recalled (`gemini live voice redesign pi-web-ui`). | Inspect system and intent docs. |
| 2026-09-17 09:17 | System Prereq Check | Whisper Docker container UP (healthy, 127.0.0.1:9000); `@google/genai` 1.52.0 installed; Supertonic script verified; vitest unit tests in `server/tests/unit/talker/` passing (25/25). | Verify provider usage & quota. |
| 2026-09-17 09:17 | Quota Discovery | Ran `agent-os provider-usage`. GLM peak window ACTIVE (07:00–11:00 London). zai-glm 5h left 99%; command-code 5h left 100%; opencode-go 5h left 96%; antigravity ample. | Note peak-window twin rules. |
| 2026-09-17 09:20 | Plan & Ledger Created | Authored status ledger `/root/pi-web-ui/docs/VOICE-GEMINI-LIVE-STATUS-LEDGER.md` and implementation plan. Awaiting `/goal`. | Ready for Gate 0 alignment. |
