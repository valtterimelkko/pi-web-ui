# Voice Mode: Implementation & Migration Execution Plan

> **Class:** Authoritative Execution Plan & Multi-Agent Concurrency Blueprint  
> **Status:** APPROVED & ACTIONABLE  
> **Date:** 17 September 2026  
> **Anchors:** [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) (Intent, N1–N9) & [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md) (Target architecture, owner decisions D1–D7)  
> **Inspection Baseline:** Pi Web UI `1212bec`; `@google/genai` `1.52.0`  

---

## 1. Executive Mandate & Non-Negotiable Invariants

This execution plan operationalises the approved target architecture for Pi Web UI Voice Mode:
1. **Retain the Two Lanes:** Lane 1 (the talker) holds conversation, maintains drafts, and relays instructions. Lane 2 (the worker) performs the reasoning and coding work. The talker never orchestrates, never spawns children, and never executes shell commands.
2. **Standard Live Model, Zero Speculative Machinery:** The conversational seat is `gemini-3.8-live` standard via direct Google `@google/genai`. In accordance with owner decision **D6**, there is no host-side analysis call, no second reasoning model, and no multi-rung escalation ladder.
3. **Four Objects in the Host Kernel:** The switchboard feel of the shipped cascade is eliminated by splitting the monolithic draft into four distinct lifecycle objects: **Thread**, **Parking Lot**, **Proposal**, and **Release** (**D3**).
4. **Out-of-Band Delivery Receipts:** Free-streaming speech models cannot be trusted to self-report delivery (*"sent it"*). Proposal dispatch and delivery outcomes are communicated strictly out-of-band via host-owned chimes/earcons and UI state (**D5**).
5. **Code-Enforced Authority:** Instructions to the worker remain semi-verbatim operator speech (N2). Model output cannot trigger a send path (N1). The talker prompt shrinks to ~15 lines; authority resides exclusively in pure TypeScript kernel code.
6. **Lean Deterministic Verification:** The unexecuted 210-attempt synthetic simulation treadmill is replaced by a fast, deterministic safety regression suite on the host kernel, paired with real-ear interactive dogfooding by the operator (**D4**).
7. **Client-Neutral Kernel:** Ambient operation is deferred to a native mobile application (**D7**). The server kernel interface must remain strictly free of browser-specific assumptions.

---

## 2. Anti-Early-Claim Principles & Cheating Defences

The audit in [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md) §2 documented severe reporting breakdowns in the previous lab attempt: hard-coded report literals, unexecuted matrices reported as complete, synthetic sine-wave audio drivers, and fake model fixtures claiming 100% success.

To ensure no execution agent can prematurely or falsely claim victory, every phase of this plan is governed by the following anti-cheat rules:

| Failure Mode Observed in Lab | Anti-Early-Claim Defence in this Plan |
|---|---|
| **Hard-coded report literals** (`generate_reports.mjs` writing object literals without reading data) | **Evidence Manifest Verification:** Every report or status update must be dynamically computed by aggregating raw, individual run manifests. Zero-run sets must output "0 runs measured". |
| **Synthetic audio bypass** (`utterancePcm` streaming 60 ms sine tones per word) | **Audio Integrity & Format Checks:** All audio fixtures and drivers must use genuine spoken audio (PCM 16 kHz mono) verified against acoustic checks or real-session capture. Sine waves or digital silence fail closed. |
| **Mock services masquerading as real runs** (fake Live model & fake Internal API claiming 100%) | **Strict Provider Separation:** Unit tests with mocks are quarantined in `tests/unit/`. Any verification pass marked "live" or "integrated" must connect to real endpoints and log genuine provider usage tokens. |
| **Unrun test matrices marked green** (140 measured attempts marked pending in PLAN but green in memo) | **Negative Gate Vetoes:** A test suite with 0 executed tests, skipped suites, or unrun matrices fails with non-zero exit codes. Progress requires committed proof records. |
| **Agent self-sign-off** (an agent declaring conversational fluency on its own) | **Mandatory Operator Acceptance:** Fluency, pacing, and colleague feel (Step 5) can **only** be approved by the human operator in an interactive session. No agent may self-certify Step 5. |

---

## 3. Concurrency Architecture & Worktree Isolation

To enable safe, high-velocity parallel work without file collisions or merge contention, the build sequence is partitioned into **four orthogonal workstreams (Tracks A, B, C, D)**.

### 3.1 Workstream Ownership Matrix

Each track operates in its own isolated Git worktree on an independent branch. No child agent may edit files outside its owned path set.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 ORCHESTRATOR / CONDUCTOR                               │
│                   (Task Briefing, Gate Verification, Master Integration)               │
└────────┬─────────────────────────┬─────────────────────────┬───────────────────────────┘
         │                         │                         │                         │
         ▼                         ▼                         ▼                         ▼
  [TRACK A: KERNEL]        [TRACK B: BRIDGE]         [TRACK C: CLIENT]       [TRACK D: REGRESSION]
  Worktree: wt-track-a     Worktree: wt-track-b      Worktree: wt-track-c    Worktree: wt-track-d
  Branch: feat/voice-kern  Branch: feat/voice-bridge Branch: feat/voice-ui   Branch: feat/voice-test
  ───────────────────────  ────────────────────────  ──────────────────────  ────────────────────
  OWNED PATHS:             OWNED PATHS:              OWNED PATHS:            OWNED PATHS:
  server/src/talker/*      server/src/voice/*        shared/src/*            docs/* (evidence)
  server/tests/unit/       server/tests/unit/voice/* client/src/components/  agent-benchmarks/*
    talker/*                                           DriveMode/*           server/tests/
                                                     client/src/lib/*          regression/*
  ───────────────────────  ────────────────────────  ──────────────────────  ────────────────────
  NO-TOUCH:                NO-TOUCH:                 NO-TOUCH:               NO-TOUCH:
  server/src/voice/*       server/src/talker/*       server/src/*            server/src/*
  client/*, shared/*       client/*, shared/*                                client/*
```

### 3.2 Git Worktree Setup Commands

```bash
# Set up isolated worktrees from the master branch
git worktree add -b feat/voice-kernel ../pi-web-ui-track-a master
git worktree add -b feat/voice-bridge ../pi-web-ui-track-b master
git worktree add -b feat/voice-client ../pi-web-ui-track-c master
git worktree add -b feat/voice-audit  ../pi-web-ui-track-d master
```

---

## 4. Master Phased Build Sequence & Victory Conditions

```
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │ PHASE 0: Evidence Correction & Trust Restoration (Step 0)                        │
  │ Distinguish delivered equipment from unperformed runs; annotate docs and reports.│
  └────────────────────────────────────────┬─────────────────────────────────────────┘
                                           │
  ┌────────────────────────────────────────┴─────────────────────────────────────────┐
  │ PHASE 1: Immediate Confirmation Gate TDD Repair (Step 1)                         │
  │ RED-first fix for substring false-confirmations ("not sure") on existing cascade.│
  └────────────────────────────────────────┬─────────────────────────────────────────┘
                                           │
                ┌──────────────────────────┴──────────────────────────┐
                ▼                                                     ▼
  ┌──────────────────────────────────────────┐         ┌─────────────────────────────┐
  │ PHASE 2: Host Authority Kernel (Track A) │         │ PHASE 3: Voice Bridge (Tr. B│
  │ 4 objects: Thread, Parking Lot, Proposal,│         │ Gemini Live S2S WebSocket,  │
  │ Release; read-only tools & provenance.   │         │ PCM transcode, context inj. │
  └────────────────────┬─────────────────────┘         └──────────────┬──────────────┘
                       │                                              │
                       └──────────────────────┬───────────────────────┘
                                              │
  ┌───────────────────────────────────────────┴──────────────────────────────────────┐
  │ PHASE 4: Shared Event Contracts & Client Surface (Track C)                       │
  │ AudioWorklet capture, speech arbiter ducking, UI cards, out-of-band chimes.      │
  └───────────────────────────────────────────┬──────────────────────────────────────┘
                                              │
  ┌───────────────────────────────────────────┴──────────────────────────────────────┐
  │ PHASE 5: Disposable Vertical Slice Integration (Step 2)                          │
  │ End-to-end integration: mic -> bridge -> Live -> kernel -> delivery -> chime.    │
  └───────────────────────────────────────────┬──────────────────────────────────────┘
                                              │
  ┌───────────────────────────────────────────┴──────────────────────────────────────┐
  │ PHASE 6: Lean Deterministic Safety Regression Suite (Step 4 & Track D)           │
  │ Automated veto gates, proposal SHA matching, idempotency, 20-utterance fidelity. │
  └───────────────────────────────────────────┬──────────────────────────────────────┘
                                              │
  ┌───────────────────────────────────────────┴──────────────────────────────────────┐
  │ PHASE 7: Real-Ear Interactive Dogfooding & Owner Acceptance (Step 5)             │
  │ Human-in-the-loop: Spoken TTFA <=2s, colleague feel, open-mic ducking.           │
  └───────────────────────────────────────────┬──────────────────────────────────────┘
                                              │
  ┌───────────────────────────────────────────┴──────────────────────────────────────┐
  │ PHASE 8: Reversible Rollout & Operational Guardrails (Step 6)                    │
  │ Opt-in flag, graceful cascade fallback, diagnostics, quota budget monitoring.    │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

---

### Phase 0: Evidence Correction & Trust Restoration (Step 0)

* **Objective:** Cleanse historical inaccuracies from lab reports. Ensure evidence files distinguish delivered tooling from unexecuted test runs.
* **Owned Paths (Track D):**
  - `/root/pi-web-ui/docs/VOICE-GEMINI-LIVE-STATUS-LEDGER.md`
  - `/root/pi-web-ui/docs/VOICE-GEMINI-LIVE-DECISION-MEMO.md`
  - `/root/agent-benchmarks/benchmarks/04-voice-live-lab/generate_reports.mjs`
  - `/root/agent-benchmarks/benchmarks/04-voice-live-lab/site/index.html`
* **Implementation Tasks:**
  1. Annotate `VOICE-GEMINI-LIVE-STATUS-LEDGER.md` and `VOICE-GEMINI-LIVE-DECISION-MEMO.md` with explicit provenance headers reflecting the audit findings of recommendation §2.
  2. Modify `generate_reports.mjs` so it parses real attempt manifests under `runs/` rather than emitting hard-coded object literals.
  3. Strip unsupported figures (e.g. "zero leaks across 140 attempts", "Tier 2 latency 270 ms") from `site/index.html`.
* **Anti-Early-Claim Guards:**
  - `generate_reports.mjs` must be tested against a temporary empty directory; it must report 0 runs and fail open-standing assertions rather than displaying hard-coded green badges.
* **Condition for Victory (Exit Gate 0):**
  ```bash
  node /root/agent-benchmarks/benchmarks/04-voice-live-lab/generate_reports.mjs --test-manifest-audit
  ```
  - Command exits with code 0.
  - Generated report JSON/HTML explicitly marks unrun matrices as `unmeasured`.
  - Git diff verifies no hard-coded benchmark scores remain in reporting scripts.

---

### Phase 1: Confirmation Gate Immediate TDD Repair (Step 1)

* **Objective:** Eliminate the live production defect where confirmation keywords anywhere in an utterance trigger the release of held drafts (e.g. *"not sure"*, *"sure, but wait"*). Fix this on the active cascade before touching transports.
* **Owned Paths (Track A):**
  - `server/src/talker/utterance-classifier.ts`
  - `server/src/talker/policy-core.ts`
  - `server/tests/unit/talker/utterance-classifier.test.ts`
  - `server/tests/unit/talker/talker-gate.test.ts`
* **Implementation Tasks:**
  1. **RED Phase:** Add failing unit tests covering false-confirmation edge cases:
     - Doubt/uncertainty: `"not sure"`, `"I am not sure"`, `"hard to say"`.
     - Conditions/delays: `"sure, but wait"`, `"yes, hold phase three"`, `"ok but check line 10 first"`.
     - Quotations/echoes: `"I said yes earlier"`, `"why did you say yes"`.
     - Disconnected confirmations: an affirmative utterance with no live proposal or bound to an expired card.
  2. **GREEN Phase:** Refactor `utterance-classifier.ts`:
     - Replace broad substring matching with whole-utterance regex anchors (`^\s*...[\s.!?]*$`).
     - Introduce explicit negation prefixes (`not`, `never`, `hardly`, `doubt`) that disqualify confirmations.
     - Require that utterances with substantial post-affirmation instructions be classified as `statement` rather than `confirm`.
  3. Verify that pure, unambiguous confirmations (`"yes"`, `"send it"`, `"confirmed"`) and pushback phrases (`"just do it, stop asking"`) continue to classify cleanly.
* **Anti-Early-Claim Guards:**
  - Every edge-case utterance in the test table must be tested individually.
  - No blanket wildcard regexes permitted.
* **Condition for Victory (Exit Gate 1):**
  ```bash
  npm --prefix /root/pi-web-ui/server test -- tests/unit/talker/utterance-classifier.test.ts tests/unit/talker/talker-gate.test.ts
  ```
  - Vitest reports 100% pass across all test cases (at least 25 distinct classifier tests).
  - All existing 36 talker unit test suites remain passing:
    ```bash
    npm --prefix /root/pi-web-ui/server test -- tests/unit/talker/
    ```
  - Exit code 0, 0 failures.

---

### Phase 2: Host Authority Kernel & Four Objects (Track A)

* **Objective:** Implement the four distinct lifecycle objects (**Thread**, **Parking Lot**, **Proposal**, **Release**) in pure TypeScript, enforce read-only tool allow-lists, and track provenance metadata.
* **Owned Paths (Track A):**
  - `server/src/talker/types.ts`
  - `server/src/talker/thread-store.ts` (NEW)
  - `server/src/talker/parking-lot.ts` (NEW)
  - `server/src/talker/proposal-store.ts` (Refactoring/replacing `pending-proposal.ts`)
  - `server/src/talker/release-store.ts` (NEW)
  - `server/src/talker/policy-core.ts`
  - `server/tests/unit/talker/four-objects.test.ts` (NEW)
* **Implementation Tasks:**
  1. **Thread:** In-memory conversational turn history. Structurally unsendable: no code path exists to release a thread turn directly to the worker.
  2. **Parking Lot:** Lean array of flagged items (`{ id, text, createdAt, sourceUtteranceId }`). Supports adding, listing, and explicit single-item promotion. Batch sending is denied in code.
  3. **Proposal:** Single live proposal slot per lane holding `{ id, version, sha256, original, tidied, presentedVariant, status }`. Created **only** via:
     - Direct address to worker (*"Ask it..."*),
     - Acceptance of a validated talker offer,
     - Promotion of a parked item.
  4. **Release:** Append-only log recording `{ proposalId, sha256, idempotencyKey, targetLane, deliveryOutcome, receiptTimestamp }`. Unknown outcome is a first-class state requiring reconciliation.
  5. **Read-Only Tools:** Declare typed tools callable by the talker:
     - `retrieve_session_history({ turnsBack: number })`
     - `retrieve_file_context({ relativePath: string })`
     - `park_item({ text: string })`
     - `read_parking_lot()`
     - `offer_ask_worker({ question: string, reason: string })`
* **Anti-Early-Claim Guards:**
  - Negative test: Attempting to call release on a Thread turn without promotion must throw a type or runtime assertion error.
  - Negative test: Submitting two identical confirmations with the same proposal ID must return `duplicate_refusal` on the second attempt, never delivering twice.
  - Negative test: Modified proposal text must cause a SHA-256 mismatch and refuse delivery.
* **Condition for Victory (Exit Gate 2):**
  ```bash
  npm --prefix /root/pi-web-ui/server test -- tests/unit/talker/four-objects.test.ts
  ```
  - Test suite passes with $\ge 15$ assertions verifying object isolation, SHA matching, idempotency, and read-only constraints.
  - Exit code 0.

---

### Phase 3: Server Native Voice Service & WebSocket Bridge (Track B)

* **Objective:** Extract and productise the Gemini Live bidirectional streaming client into `server/src/voice/`. Manage WebSocket lifecycle, session resumption, audio transcoding, and worker status injection.
* **Owned Paths (Track B):**
  - `server/src/voice/gemini-live-bridge.ts` (NEW)
  - `server/src/voice/audio-transcoder.ts` (NEW)
  - `server/src/voice/voice-session.ts` (NEW)
  - `server/src/voice/types.ts` (NEW)
  - `server/tests/unit/voice/gemini-live-bridge.test.ts` (NEW)
  - `server/tests/unit/voice/audio-transcoder.test.ts` (NEW)
* **Implementation Tasks:**
  1. Productise the `@google/genai` 1.52.0 `ai.live.connect` adapter from `scripts/voice-live-lab/lib/providers/gemini-live.ts`.
  2. **Security:** `GEMINI_API_KEY` stays strictly on the server. The client connects over authenticated cookie/session WebSocket.
  3. **Audio Transcoder:** Convert client 16 kHz PCM mono input to provider 24 kHz PCM output, and downsample provider 24 kHz audio to client format.
  4. **Resumption & Disconnect Lifecycle:** Capture `sessionResumptionUpdate.newHandle`, maintain token in memory, and seamlessly reconnect on `goAway` or network drop without dropping the conversation state.
  5. **Context Injection:** Inject crisp worker status using `sendClientContent({ turnComplete: false })` on worker lifecycle changes. Coalesce updates $\ge 2$ s apart; suppress injection during active operator speech.
  6. **Client-Neutrality:** Keep all WebSocket handling decoupled from browser DOM or window objects (fulfilling **D7**).
* **Anti-Early-Claim Guards:**
  - Unit tests must mock the WebSocket server to simulate unexpected disconnects, corrupted audio chunks, and latency spikes.
  - Code inspection test: Verify `GEMINI_API_KEY` is not present in any client bundle or sent across the browser WebSocket.
* **Condition for Victory (Exit Gate 3):**
  ```bash
  npm --prefix /root/pi-web-ui/server test -- tests/unit/voice/
  ```
  - All unit tests pass with exit code 0.
  - Isolated live connection probe succeeds using local credentials:
    ```bash
    npm --prefix /root/pi-web-ui/server run test:voice-handshake
    ```
  - Live probe connects, receives `setupComplete`, sends 1s of audio, and receives valid transcription delta.

---

### Phase 4: Shared Contracts & Client Voice Surface (Track C)

* **Objective:** Implement typed client-server communication, low-latency AudioWorklet capture/playback, priority speech scheduling with ducking, and out-of-band delivery UI/chimes.
* **Owned Paths (Track C):**
  - `shared/src/types/voice-messages.ts` (NEW)
  - `client/src/lib/voiceWorklet/` (NEW)
  - `client/src/lib/speechArbiter.ts` (Update priority & ducking rules)
  - `client/src/lib/soundEffects.ts` (NEW - host chime playback)
  - `client/src/components/DriveMode/DriveModeVoiceLive.tsx` (NEW)
  - `client/src/components/DriveMode/ProposalCard.tsx` (NEW)
  - `client/src/components/DriveMode/ParkingLotDrawer.tsx` (NEW)
* **Implementation Tasks:**
  1. Define versioned wire messages in `shared/`:
     - Client $\to$ Server: `voice_audio_chunk`, `voice_activity_state`, `proposal_confirm`, `proposal_cancel`, `parking_promote`.
     - Server $\to$ Client: `voice_audio_chunk`, `transcript_delta`, `proposal_created`, `proposal_resolved`, `receipt_event`, `parking_updated`.
  2. **AudioWorklet:** Implement high-performance, glitch-free 16 kHz PCM capture and playback buffer management with overflow protection.
  3. **Speech Arbiter & Ducking:** Retain the duck-and-continue contract (N5). When operator speaks, background playback drops to 15% volume rather than cutting off mid-word.
  4. **Out-of-Band Delivery Chimes:** Play a distinct, trusted chime audio asset locally upon receipt of `proposal_resolved { outcome: "delivered" }`. The model never generates the confirmation sound.
  5. **UI Components:** Render Proposal Cards displaying `original` and `tidied` variants, clear hash IDs, and Parking Lot items with one-tap promotion buttons.
* **Anti-Early-Claim Guards:**
  - Playwright browser test must verify that audio ducking occurs when microphone activity begins.
  - Visual verification: Proposal cards must visibly show when proposal text has been presented versus when it is stale.
* **Condition for Victory (Exit Gate 4):**
  ```bash
  npm run build --workspace=shared && npm run build --workspace=client
  ```
  - TypeScript typecheck and build pass with 0 errors across `shared` and `client`.
  - Client unit tests pass:
    ```bash
    npm --prefix /root/pi-web-ui/client test -- src/lib/speechArbiter.test.ts
    ```

---

### Phase 5: Disposable Vertical Slice Integration (Step 2)

* **Objective:** Connect Tracks A, B, and C into an end-to-end working system in an isolated, disposable environment. Prove the full conversational and delivery loop against a real worker session.
* **Owned Paths:** Integrated harness (`scripts/voice-live-lab/boot-disposable-server.sh`, `server/src/index.ts`).
* **Implementation Tasks:**
  1. Boot a disposable Pi Web UI server on an ephemeral port using an isolated cgroup.
  2. Attach Voice Mode to a disposable Pi worker session.
  3. Execute three end-to-end integration scenarios:
     - **Scenario 1 (Thinking Together):** Converse about a code problem across 4 turns without generating an offer or interrupting the worker.
     - **Scenario 2 (Directed Steer):** Say *"Tell the worker to check the tests"*; verify proposal card appears, confirm with *"Yes, send that"*; verify worker receives exact bytes; verify out-of-band delivery chime triggers.
     - **Scenario 3 (Parking & Surface):** Flag two items while the worker is busy; verify items park; promote one item after worker turn completes; verify second item remains safely parked.
* **Anti-Early-Claim Guards:**
  - Assertions must inspect real server logs, database entries, and worker session receipts. Testing against mock client stubs is strictly forbidden.
  - Zero gate leaks: Any instruction reaching the worker without a logged proposal ID and matching SHA fails the gate.
* **Condition for Victory (Exit Gate 5):**
  ```bash
  npx tsx scripts/voice-live-lab/cli.ts test-vertical-slice
  ```
  - All 3 scenarios complete with exit code 0.
  - Log inspection proves 100% byte fidelity between confirmed proposals and received worker prompts.

---

### Phase 6: Lean Deterministic Safety Regression Suite (Step 4 & Track D)

* **Objective:** Establish the permanent, fast automated regression harness in CI/local development that enforces all safety veto gates and verifies the 20-utterance fidelity corpus.
* **Owned Paths (Track D):**
  - `server/tests/regression/safety-veto.test.ts` (NEW)
  - `server/tests/regression/fidelity-corpus.test.ts` (NEW)
  - `server/tests/fixtures/fidelity-corpus.json` (Migrated from lab)
* **Implementation Tasks:**
  1. **Safety Veto Suite:** Fast, hermetic unit tests verifying that all unsafe states fail closed:
     - Rejection of doubt (`"not sure"` $\to$ `cancel` / `statement`).
     - Rejection of conditional agreements (`"yes, but wait"` $\to$ `statement`).
     - Rejection of stale/tampered proposals (SHA mismatch $\to$ `refuse`).
     - Exactly-once delivery (replay token $\to$ `duplicate_refusal`).
     - Disconnect safety (mid-speech disconnect never triggers dispatch).
     - Lane isolation (pending draft for Worker 1 does not release on Worker 2).
  2. **Fidelity Corpus Runner:** Score the frozen 20-utterance fidelity corpus:
     - Recognition WER, required-word recall, preservation of critical negations (*"not"*, *"never"*), file paths, and conditionals.
     - Semi-verbatim byte equality from recognised text to delivered instruction.
* **Anti-Early-Claim Guards:**
  - Every veto gate is an absolute blocker: a single failure fails the entire suite immediately. No threshold averaging.
* **Condition for Victory (Exit Gate 6):**
  ```bash
  npm --prefix /root/pi-web-ui/server test -- tests/regression/
  ```
  - All regression tests run in $<20$ seconds and exit with code 0.
  - 100% of veto gate assertions hold.
  - Fidelity corpus achieves 100% critical word retention on negations and conditionals.

---

### Phase 7: Real-Ear Interactive Dogfooding & Owner Acceptance (Step 5)

* **Objective:** Verify conversational quality, natural turn-taking, colleague feel, and spoken latency in real human interactive use.
* **Authority:** **Human Operator Only.** Execution agents are strictly barred from self-signing off this phase.
* **Protocol:**
  1. Deploy the disposable vertical slice to the operator's local development environment.
  2. The operator conducts a 15-minute hands-busy pairing session on an actual codebase task using open-mic Voice Mode.
  3. The operator validates:
     - **Spoken TTFA:** Natural conversational pacing without awkward pauses (target $\le 2.0$ s p90).
     - **Colleague Feel:** Free discussion, thinking aloud, and speculative reasoning without annoying switchboard interruptions.
     - **Audio Ducking:** Smooth volume reduction while the operator speaks, recovering promptly without eaten words or audible glitching.
     - **Honest Delivery:** Audibility of the trusted delivery chime and crisp receipt cards.
* **Anti-Early-Claim Guards:**
  - Automated scripts cannot sign off on this gate. A written confirmation from the operator in the session log is mandatory.
* **Condition for Victory (Exit Gate 7):**
  - Explicit written sign-off from the operator confirming acceptable conversational fluency, safety, and colleague feel.

---

### Phase 8: Reversible Rollout & Operational Guardrails (Step 6)

* **Objective:** Enable production usage behind a safe, reversible feature flag with automatic fallback to the Gemma cascade and real-time quota telemetry.
* **Owned Paths:**
  - `server/src/config.ts`
  - `server/src/talker/session-registry.ts`
  - `server/src/diagnostics/`
* **Implementation Tasks:**
  1. Add environment flag `VOICE_MODE_ENGINE=gemini-live|cascade` (default: `cascade` until operator enables).
  2. Implement seamless fallback: if Gemini Live connection fails or exhausts quota, the session registry falls back to the existing Gemma cascade without dropping active drafts.
  3. Expose operational metrics in `GET /api/v1/diagnostics`:
     - Audio minutes streamed (input/output).
     - Live connection drops and resumption success rates.
     - Proposals created, released, refused, and reconciled.
* **Anti-Early-Claim Guards:**
  - Test the fallback path: kill the Live bridge connection mid-session and verify that the UI seamlessly degrades to push-to-talk cascade with an audible announcement.
* **Condition for Victory (Exit Gate 8):**
  ```bash
  npm run typecheck && npm run test
  ```
  - Full project test suite and typecheck pass 100%.
  - Production readiness checklist approved by operator.

---

## 5. Summary Verification Checklist for Lead Conductor

Before declaring the migration complete, the Lead Conductor must verify the following matrix:

| Gate | Requirement | Exact Command / Proof | Required Outcome |
|---|---|---|---|
| **Gate 0** | Evidence audit cleansed | `node benchmarks/04-voice-live-lab/generate_reports.mjs --test-manifest-audit` | Exit 0; unmeasured matrices marked unmeasured |
| **Gate 1** | Classifier defect repaired | `npm --prefix server test -- tests/unit/talker/utterance-classifier.test.ts` | Exit 0; all false-confirm edge cases pass |
| **Gate 2** | Four objects enforced | `npm --prefix server test -- tests/unit/talker/four-objects.test.ts` | Exit 0; Thread unsendable; Release idempotent |
| **Gate 3** | Live S2S bridge active | `npm --prefix server test -- tests/unit/voice/` | Exit 0; resumption & transcode unit tests green |
| **Gate 4** | Client UI & types built | `npm run build --workspace=shared && npm run build --workspace=client` | Exit 0; zero TypeScript compilation errors |
| **Gate 5** | Vertical slice integrated | `npx tsx scripts/voice-live-lab/cli.ts test-vertical-slice` | Exit 0; 3/3 real scenarios delivered with receipts |
| **Gate 6** | Safety veto regression | `npm --prefix server test -- tests/regression/` | Exit 0 in <20s; 100% veto assertions hold |
| **Gate 7** | Operator real-ear trial | Human evaluation in real pairing session | Explicit written approval from operator |
| **Gate 8** | Reversible rollout | `npm run test && npm run typecheck` | Exit 0; dual-engine fallback verified |
