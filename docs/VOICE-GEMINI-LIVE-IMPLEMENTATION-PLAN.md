# Voice Mode on Native Gemini Live — Master Implementation Plan & Operative Policies

> **Location:** `/root/pi-web-ui/docs/VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md`  
> **Class:** Authoritative Implementation Plan & Operative Policies  
> **Master Intent & Lab Spec:** [`VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md`](./VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md)  
> **Status & Decision Ledger:** [`VOICE-GEMINI-LIVE-STATUS-LEDGER.md`](./VOICE-GEMINI-LIVE-STATUS-LEDGER.md)  
> **Author:** Antigravity (Quality Control Agent & Multi-Agent Orchestrator)  
> **Status:** `LOCKED / READY FOR GOAL EXECUTION`  
> **Date:** 2026-09-17

---

## 1. Executive Summary & Operator Authorizations

This document contains the complete operative policies, architecture, build sequence, child delegation rules, and quality control gates for executing the Voice Mode Gemini Live redesign and evaluation lab.

### Operator Authorizations & Decisions (2026-09-17)

1. **Child Runtime Policy:**
   - **All children must run on the `pi` runtime**, never on the standalone `commandcode` runtime. Command Code catalogue models are accessed via the `pi` runtime's `commandcode/*` providers.
2. **GLM Peak Window Diversion Policy:**
   - During the London peak window (**Mon–Fri 07:00–11:00 London**):
     - **Divert to:** Runtime `pi`, Provider `commandcode`, Selector `commandcode/deepseek/deepseek-v4.1-flash` at thinking level **`high`**.
     - **Rationale:** While `zai` quota is ample off-peak, during peak hours z.ai charges $3\times$. On the `command-code` pool, DeepSeek V4.1 Flash is faster, more intelligent, and consumes less quota than GLM twins.
   - Outside the peak window (**Off-peak**):
     - **Return to:** Runtime `pi`, Provider `zai`, Selector `zai/glm-5.3-flash`.
3. **Child Thinking Level & Goal Invariant Policy (Open Question 2 Approved):**
   - General building & fixture tasks (Phases L0, L2, L4 harness, L5 fixtures): `high` thinking.
   - Policy Core extraction & hard TDD refactoring (Phase L3): `max` thinking.
   - All children dispatched with durable goals (`POST /api/v1/sessions/:id/goal` or create-time `goal`).
4. **Rate Limit & 429 Response Policy (Open Question 1 Approved):**
   - If Phase L1 capability handshake detects lower quotas or 429 errors from Gemini Live, execution immediately pauses at **Gate 1** to review `capabilities.json` and adjust batching before any scored runs.
5. **Proposed Changes & Recommendations:**
   - Approved in full (decoupled streams, direct HTTP judge, in-process PCM player, parent self-execution for benchmarks).

---

## 2. Design Agent Readiness Verification & Operational Heads-Up

A pre-execution sweep by the design agent verified external dependencies and established clear operational boundaries:

### Verified Dependencies

| Dependency | Verified State | Actionable Notes |
|---|---|---|
| `@google/genai` | `1.52.0` present | Matches package.json pin; ready for L1 |
| Supertonic batch tool | Present (`scripts/audio-lab/tools/supertonic-batch.py`) | Native CPU-based operator speech synthesis |
| Audio-lab library | All present (`fixtures`, `capsule`, `manifest`, `verify-record`, `proc`) | Direct code reuse without reinvention |
| Whisper container | **UP** (healthy, `127.0.0.1:9000`) | Offline independent ASR for fixture & shadow verification |
| Talker mechanical core & helpers | All present (`utterance-classifier`, `pending-proposal`, `ack`, `state-view`, `relay-normalise`, `notify.sh`, `talker-harness.ts`) | Reused in L0, L2, L3 |
| Benchmarks 02 and 03 | Present (`agent-benchmarks/benchmarks/02*` and `03*`) | Task material & scenarios for B2-short and Tier 1 |
| Judge endpoint & auth | Verified live end-to-end (`https://opencode.ai/zen/go/v1/chat/completions`) | Key lives outside repo (`~/.pi/agent/auth.json`); nothing to provision |
| Disposable server boot recipe | Proven `systemd-run --scope --collect` boot script | Isolates validation server outside production cgroup |
| Runner, tests, `policy-core.ts`, Benchmark 04 | Absent | **As designed**; deliverables of L0, L3, and Benchmark 04 |

### Immediate Zero-Dependency Dispatch

- **Phase L0 (Equipment):** Runs entirely on a fake provider emitting scripted `serverContent`. Requires no API keys, no external servers, and no models. De-risks all measuring equipment first.
- **Phase L3 (Policy Core Extraction):** Pure TDD refactor of existing talker code against existing test suites (`server/tests/unit/talker/*`). Requires no external provider.
- *L0 and L3 are completely decoupled and will be dispatched in parallel to two non-overlapping children immediately upon `/goal` activation.*

### Gated by Design (Answered in L1)

The plan has never been executed; "ready to start" means ready to find out. L1 resolves:
1. Input-transcription finalisation timing.
2. WebSocket resumption across `goAway` (10-minute socket lifetime).
3. Async tool results survival across resumption.
4. `interaction_status` semantics (ET idle signal).
5. Empirical Gemini Live rate limits, concurrency limits, and 429 behaviour.

### Critical Operational Guard: Session Text Guard

> [!WARNING]
> **Avoid Text Guard Triggers in Commands, Heredocs, and Git Commits**  
> The session guard on this host refuses commands containing literal path forms of the validation server (e.g. `npm run validate:server` or `scripts/validation-server.ts`), while the bare module name and `scripts/validation-server-stop.mjs` pass.  
> **Crucially, the guard scans the entire command string**, including `git commit -m` messages and heredocs!  
> **Rule:** Never quote the forbidden path literals in commit messages or bash scripts. Always launch disposable servers via the documented boot-script recipe (`systemd-run --scope --collect`).

---

## 3. Workstream Decoupling & Parallel Child Architecture

Execution is split into two independent, non-overlapping streams to maximize throughput while guaranteeing clean git hygiene:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STREAM A: Lab Infrastructure & Runner (Child A)                             │
│ Owned Paths:                                                                │
│ - scripts/voice-live-lab/**                                                 │
│ - server/tests/voice-live-lab/**                                            │
│ - /root/agent-benchmarks/benchmarks/04-voice-live-lab/**                    │
│ Phases: L0 (Equipment) ──▶ L2 (Baseline) ──▶ L4 (Tier 1 Harness)             │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       │ [Parallel Execution]
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ STREAM B: Talker Policy Core Extraction (Child B)                           │
│ Owned Paths:                                                                │
│ - server/src/talker/policy-core.ts                                          │
│ - server/src/talker/talker.ts                                               │
│ - server/tests/unit/talker/**                                               │
│ Phase: L3 (Extract policy-core.ts, differential replay green)               │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼ [Reconciliation Gate]
┌─────────────────────────────────────────────────────────────────────────────┐
│ PARENT ORCHESTRATOR INTEGRATION                                             │
│ - Runs test suites, lint, typecheck, build                                  │
│ - Signs off on L0, L2, L3                                                   │
│ - Executes Phase L1 Handshake directly                                      │
│ - Integrates Stream B policy-core into Stream A for Phase L4 execution       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Complete Phase-by-Phase Build & Verification Plan

### Phase L0: Equipment & Infrastructure
- **Deliverables:**
  - `scripts/voice-live-lab/lib/scheduler.ts`: Monotonic clock (`hrtime.bigint`), event loop, append-only JSONL log.
  - `scripts/voice-live-lab/lib/fixtures.ts`: Supertonic offline synthesis (`supertonic-batch.py`), Whisper ASR check (WER $\le 0.08$), fixture freezing.
  - `scripts/voice-live-lab/lib/speech-driver.ts`: Paced 16 kHz s16le PCM streaming (20 ms frames) with E and N endpointing lanes.
  - `scripts/voice-live-lab/lib/playback.ts`: Reference PCM player with ducking (gain 0.15) and native interrupt support.
  - `scripts/voice-live-lab/lib/record.ts`: Immutable attempt records and `cli.ts verify` logic.
  - Disposable server boot script verified in situ.
- **Verification Gate:** Unit tests with deliberately damaged event logs (missing usage, dropped frames, leaked golden text) must fail the verifier. Clean control trace passes.

### Phase L1: Capability Handshake & Quota Probe
- **Deliverables:**
  - `scripts/voice-live-lab/cli.ts handshake`: Opens real Live session (`gemini-3.8-live` and ET variant), tests VAD, transcript deltas, `goAway`/resume, and writes `capabilities.json`.
  - Direct HTTP judge probe: Throwaway call to `https://opencode.ai/zen/go/v1/chat/completions` asserting `200`, model echo `deepseek-v4.1-flash`, browser User-Agent, and `x-opencode-session`.
  - Session judge cross-transport probe on disposable server, asserting zero injected `agent-os` context.
- **Verification Gate (Gate 1):** All §12 `probe`s resolved. If rate limits or 429s occur, pause for operator review.

### Phase L2: Baseline Lane (Gemma Cascade)
- **Deliverables:**
  - `scripts/voice-live-lab/lib/providers/baseline-cascade.ts`: Port `/api/dictation` STT + OpenRouter Gemma talker + OpenAI TTS in-process.
  - Frozen scenarios `t1-s1` through `t1-s7` (five from Benchmark 3 + worker permission and reading levels) with world fixtures.
  - Mechanical and latency scorer (`score_voice.py`).
- **Verification Gate:** 5 attempts $\times$ 7 scenarios in E lane. Baseline TTFA and conversational metrics recorded. Offline verifier 100% green.

### Phase L3: Talker Policy Core Extraction
- **Deliverables:**
  - `server/src/talker/policy-core.ts`: Pure functional extraction of `decideOperatorTurn`. Free of model calls and I/O.
  - `server/src/talker/talker.ts`: Refactored to delegate mechanical gating to `policy-core.ts`.
  - Differential test suite: `server/tests/unit/talker/talker-policy-core.differential.test.ts`.
- **Verification Gate:** Differential replay of entire talker test corpus (`server/tests/unit/talker/*`) produces byte-identical decisions and delivery calls. All 25 existing tests untouched and green.

### Phase L4: Tier 1 Guarded Live Harness
- **Deliverables:**
  - `scripts/voice-live-lab/lib/providers/gemini-live.ts`: WebSocket adapter wrapping `@google/genai` (1.52.0).
  - `scripts/voice-live-lab/lib/harness/tier1-guarded.ts`: Guarded harness embedding `policy-core.ts`.
  - Native vs sidecar transcript conditions; E and N endpointing lanes; duck playback profile.
- **Verification Gate (Gate 2):** 5 attempts $\times$ 7 scenarios $\times$ {native, sidecar} $\times$ {E, N} (140 attempts). Latency-critical runs serialised. Mechanical gate matrix all green. Review §18.1 Step 1 findings with operator.

### Phase L5: Tier 3 Live Model as Orchestrator
- **Deliverables:**
  - Internal API tool surface: `create_child`, `prompt_child`, `child_status`, `read_child`, `wait_for`, `run_checked`, `notify_owner`, `confirmRequest`.
  - B2-short fixtures (`repo-core`, `repo-tools`, mock service, supervisor). Sized for $\approx 12$ minutes.
  - Lifetime handling: Context window compression trigger at 100k tokens, WebSocket `goAway` reconnection and state restoration.
- **Verification Gate (Gate 3):** Dry-run with fake child passes. Text controls run 3x (`commandcode/google/gemini-3.8-flash` and `commandcode/deepseek/deepseek-v4.1-flash` @ `high`). Live candidates run (std $\times 3$, ET-high $\times 3$, ET-low $\times 2$). Deterministic repo-state scoring. Review Step 2 findings with operator.

### Phase L6: Adaptive Operator Instrument
- **Deliverables:**
  - `scripts/voice-live-lab/lib/operator-sim.ts`: Adaptive simulator driven by `zai/glm-5.3-flash` @ `high` (or commandcode DeepSeek twin during peak).
  - `scripts/voice-live-lab/lib/director.ts`: Mechanical director validation (permissions, length, leakage, turns).
  - Freeze command (`cli.ts freeze`) tagging discoveries with `provenance: synthetic`.
- **Verification Gate (Gate 4):** Instrument entry gate: drive simulator against frozen/branching beats with known answers. Agreement verified and director rejection rate $\le 20\%$. (If $>20\%$, report `insufficient-evidence` and do not score candidate on adaptive beats).

### Phase L7: Tier 2 Lean Harness
- **Deliverables:**
  - `scripts/voice-live-lab/lib/harness/tier2-lean.ts`: Lean instructed harness (`free`, `confirm-guided`, and `fixed-text` if derived).
  - Condition matrix dynamically derived from §18.1 rules using L4 and L5 empirical findings and locked in `PLAN.md`.
  - 20-utterance fidelity corpus scored for required-word recall, dropped qualifiers, and re-planning.
- **Verification Gate:** 5 attempts across derived matrix. Fidelity, honesty, and TTFA recorded.

### Phase L8: Final Lab Delivery & Decision Memo
- **Deliverables:**
  - End-to-end `run_voice_lab.sh` packaging under `agent-benchmarks/benchmarks/04-voice-live-lab/`.
  - Benchmark 2 leaderboard updated with "Voice Parent" section; Benchmark 4 leaderboard page generated.
  - Comprehensive `report.html` and `report.json`.
  - Owner Decision Memo synthesizing answers to §5 questions in §9 vocabulary.
- **Verification Gate (Gate 5):** Offline verifier green on every attempt; limitations documented; Telegram `done` posted; Agent OS capture executed.

---

## 5. Token Efficiency & Zero-Token Waiting Protocol

The Antigravity parent orchestrator operates under strict token-efficiency invariants to ensure the session context window is preserved across the entire multi-day programme:

1. **Anti-Polling Invariant:** In-turn polling loops (`sleep`, `tmux capture-pane`, or status queries in loops) are strictly forbidden.
2. **Canonical Zero-Token Waiting Sequence:**
   - **Step 1:** Register pure-observer watch on child (`POST /api/v1/sessions/:id/watch`).
   - **Step 2:** Launch persistent watcher in background via `run_command`:
     ```bash
     /root/.skills-global/skills-global/pi-web-ui-internal-api-orchestration/scripts/wait-watch.sh <watchId>
     ```
     with `WaitMsBeforeAsync: 1000`. Returns task ID `<taskId>`.
   - **Step 3:** Arm native auto-cancelling schedule timer:
     ```json
     {
       "DurationSeconds": 1800,
       "Prompt": "Backstop: reconcile child session <childId>",
       "TimerCondition": "<taskId>"
     }
     ```
   - **Step 4:** **End turn immediately.** No further tool calls.
3. **Re-anchoring on Wakeup:** Whenever woken by the background task or backstop, re-anchor context by reading [`VOICE-GEMINI-LIVE-STATUS-LEDGER.md`](./VOICE-GEMINI-LIVE-STATUS-LEDGER.md) before taking action.
4. **Milestone Communications:** Telegram updates sent via `/root/pi-web-ui/scripts/notify.sh milestone|question|blocked|done` only at discrete phase transitions.

---

## 6. Living Ledger Integration

All phase starts, child dispatch parameters, verification proofs, gate outcomes, and empirical metrics will be appended to [`VOICE-GEMINI-LIVE-STATUS-LEDGER.md`](./VOICE-GEMINI-LIVE-STATUS-LEDGER.md) in real time.
