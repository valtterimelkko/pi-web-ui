# Voice Mode: the target architecture

**Date:** 17 September 2026 (revised — sharpened and streamlined with owner approval)

**Status:** **Direction and streamlined plan approved by the owner on 2026-09-17** (§8, D1–D7). This is the architecture of record. It is **not** production approval: each step in §7 still carries its own gate, and deployment or restart is separate.

**Inspection baseline:** Pi Web UI `1212bec`; agent-benchmarks `c147519`. No production validation, new paid model runs, or runtime changes were performed.

**Intent source:** [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md) is the canonical *what* and *why*, including the renewed thinking-together intent of 2026-09-17. This file is the *how*. Where they describe the same object, that file governs intent and this one governs construction.

---

## 1. The decision

**Keep the two lanes. Replace the cascade. Free the conversation. Move every load-bearing rule from the prompt into code and structured state.**

The target is one architecture, not a menu:

| Element | Decision |
|---|---|
| Conversational seat | **Gemini 3.8 Live standard**, direct Google, native audio in and out. No extended thinking, **and no escalation machinery of any kind** (§4.7a, D6). |
| Honesty | Out-of-band **delivery receipts via trusted chimes/earcons**; structured worker context in the prompt; simple conversational qualification without real-time audio interception/voice-splicing (§4.7, D5). |
| Evidence | **Lean deterministic safety test suite** on the host kernel + interactive dogfooding acceptance, pruning the 210-run synthetic benchmark treadmill (§7.1, D4). |
| Worker seat | **Unchanged** — the operator's existing session and model. When orchestrating, `commandcode/google/gemini-3.8-flash` at `high`. |
| Authority | A **host-owned authority kernel** owning transcripts, the four objects (§4.2), proposal identity, confirmation, delivery and receipts. |
| Audio | **Server-side WebSocket bridge** (`server/src/voice/`) with one application-owned speech scheduler across native conversation, trusted receipts and worker reading. |
| Prompt | **~15 lines**, down from 50. Everything mechanical moves to code or typed context. |
| Capture | **Open mic by default**; push-to-talk retained as mode and fallback. Ambient operation **deferred to a mobile client** (§4.9a), with a client-neutral kernel as the price of keeping it open. |
| Fallback | The existing Gemma cascade stays working throughout the migration. |

Three things this is **not**, stated because each was a live possibility and each is now closed:

- **Not** a single-model collapse where the Live model orchestrates children. Rejected on evidence and on the operator's direct experience (§5.1).
- **Not** a transport swap that keeps today's conversational rules. That would buy latency and ship the switchboard (§5.2).
- **Not** a model-composed relay for instructions. N2 is untouched; composition is permitted for *questions only*, under read-back (§4.6).

**Standing qualification on the evidence.** The lab supports an architectural hypothesis and substantial equipment work, **not a measured winner across three tiers**. The model choice below is a *preferred candidate to validate*, not a claim this lab proved it optimal. §2 is the audit.

---

## 2. Evidence correction: what the lab actually establishes

I read the intent/specification, execution ledger, decision memo, published [leaderboard](https://united-voyage-ex39.here.now/#b4), benchmark source, handbacks and available records, and re-derived every claim below from source rather than from the other documents. They disagree materially.

The [lab specification](./VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md) §25 states plainly: **"Done includes the runs, not only the machinery… An agent that stops after building the harness has delivered a phase, not the lab."** The [ledger](./VOICE-GEMINI-LIVE-STATUS-LEDGER.md) and [decision memo](./VOICE-GEMINI-LIVE-DECISION-MEMO.md) claim completion; the benchmark's own `PLAN.md` says the measured matrices were not run.

### 2.1 Findings by tier

| Area | Supported evidence | What it does **not** establish |
|---|---|---|
| L0 equipment / L3 policy extraction | Implemented driver, recorder, verifier, policy extraction and differential tests | Real-model quality, browser audio quality or universal safety |
| L1 capability handshake | `capabilities.json` records standard/ET connections, transcription, a resumption check, tool use, quota observations | Comparative conversation quality, measured matrices or product readiness |
| L2 Gemma baseline | Harness and seven scenarios; dry-run evidence | A matched, measured cascade latency/fidelity baseline |
| L4 Tier 1 | 14/14 hermetic dry runs across native/sidecar; `PLAN.md` lists **140 measured attempts as pending** | "Zero leaks across 140 Live attempts", any measured conversational improvement, any latency distribution |
| L5 Tier 3 | Scripted B2-short parent: real fixture repos/commands, **fake Live model, fake Internal API, fake children**; 19 tool calls, 100% scripted score | Gemini Live achieving 100% orchestration, matching text parents, or surviving a real conductor workload |
| L6 adaptive operator | Simulator/director implementation, deterministic entry-gate tests | A validated live simulator campaign; the handback says the live half remains to run |
| L7 Tier 2 | 24/24 dry runs; 20-utterance fidelity corpus; matrix explicitly **provisional** | Measured premature dispatches, ET/std ranking, or proof that Tier 1 is the least sufficient harness |
| L8 reporting | HTML/JSON and a leaderboard exist | Any aggregation of measured attempt records |

### 2.2 Specific audit findings, each verified against source

1. **The headline results are hard-coded.** `generate_reports.mjs` builds gate verdicts, tier scores and the recommendation as object literals. It declares `PLAN_PATH` at line 11 and **never reads that file again** — so the honest plan has no mechanical route to contradict the published verdict.
2. **The only manifest under `runs/` is the Tier 3 dry run.** It records `usage.mode: "dry-run"`, `realProviderCalls: 0`, and `realServices.liveModel/internalApi/childSessions: false`.
3. **255 ms is not spoken-response TTFA.** The capability record labels it `speechToFirstTranscriptMs` / `inputFinalisationTimingMs`. Spec §20.2 defines TTFA as **"speech-end → first played audio, the operator-facing number"** — a different measurement point. The memo and leaderboard collapse them.
4. **The measured runner cannot measure speech.** `runTier1MeasuredAttempt()` sets `mode: 'measured'` but streams `utterancePcm()` — a **sine wave** of 60 ms per word — and pairs it with `createSilenceMechanicalVoice()`. A run through that path would connect to the real model, produce a record the offline verifier accepts, and measure nothing about comprehension.
5. **The wrapper advertises `live` but has no `live` dispatch branch.** `run_voice_lab.sh live` falls through to "Unknown command".
6. **The published site is worse than the memo.** It states *"140 attempts… conducted 2026-09-17"*, *"zero leaks across 140 attempts"*, a baseline of *1,840 ms*, a **Tier 2 figure of 270 ms for a tier with no runs of any kind**, component legs of 480 ms and 710 ms, and *"cascade characterised across 140 runs"* — which contradicts even the plan's own baseline count of 35. These figures appear **only in `site/index.html`**; they are in no data file or manifest.
7. **Whisper WER ≤4%, Tier 2 model-only leakage, "no latency advantage", and Tier 3 being cost-heavy** are not established comparative findings. Whisper is a reference recogniser, not ground truth or a "legal record".
8. **A handshake is narrower than its prose sign-off.** The concurrency probe requests five connections but treats four as success, and assigns rather than scores its natural-VAD flag.

**The important nuance: the lab engineers were honest.** `PLAN.md` is scrupulous — every unrun matrix marked *pending*, every Tier 2 rule *unresolved*, the derived matrix labelled *provisional*, with the explicit note that an unmeasured test is *"never silently treated as the finding did not fire"*. The failure sits entirely in the **reporting and sign-off layer** above it. That makes it fixable without discarding the harness, and it means L0's verifier, the scenario/world fixtures and the fidelity corpus are genuine assets.

**Consequence:** neither "Tier 3 is refuted" nor "Tier 1 decisively won" follows. Tier 2 dispatch-timing failures would not refute Tier 3's reasoning capability anyway — different authority arrangements, different questions.

I have **not overwritten** the signed-off ledger, memo or public leaderboard. Correcting them is decision 1 in §8.

### 2.3 What Benchmark 2 does support

| Text parent | Total | Gate / Queue / Defect / **Wait** / Restart / **Comms** |
|---|---:|---|
| Gemini 3.8 Flash, high | **84.2%** | 80 / 100 / 100 / **55** / 100 / **70** |
| DeepSeek V4.1 Flash, high | 78.3% | 80 / 100 / 100 / **20** / 100 / **70** |
| GLM 5.3, max | 50.8% | 80 / 0 / 100 / 25 / 0 / 100 |
| GLM 5.3 Flash, max | 45.8% | 80 / 0 / 100 / 25 / 0 / 70 |

*(One further DeepSeek run at 78.3% is explicitly marked `discarded` — it ran against an easier pre-hardening benchmark.)*

**The conclusion that matters, and that the raw ranking hides:** the leading parent is weakest on exactly the two dimensions a *spoken* interface depends on. **Waiting discipline** (55) is whether it burns turns polling instead of arming zero-token watches — in voice that is dead air. **Milestone communication** (70) is whether it says useful things without spamming — in voice that *is* the product. DeepSeek completes the work and scores **20** on waiting.

Therefore: **event-driven supervision and update filtering belong in the host**, not in the model you shop for. This also inherits the lesson of the motivating Antigravity run — ~615 `run_command` calls and five compactions in two hours, driven by supervision churn rather than model weakness.

Gemini's 84.2% was earned on **Pi + OpenRouter**, not the proposed subscription route; the lab spec already declares it context-only and never reusable. Re-resolve identities and rerun controls on the intended route.

---

## 3. What the shipped architecture gets right — and what feels old

### 3.1 Current path, grounded in code

```text
Browser capture / tap-to-talk
    → dictation: gpt-4o-mini-transcribe
    → talker_turn over the session WebSocket
    → TalkerSession + pure policy-core
        ├─ conversation: Gemma 4 26B A4B IT via OpenRouter
        └─ authorised relay: existing runtime delivery adapter
    → client speech arbiter
    → OpenAI TTS (default tts-1) → playback

Worker session → bounded state/history + reading digest → speech arbiter
```

These are code defaults, not a read of production secrets. Verified: `useVoiceTurn.ts` still uses `useDictation`; `model-client.ts` still defaults to Gemma; `config.ts` still defaults `ttsModel` to `tts-1`; and **no reference to Gemini Live exists anywhere in `server/src`, `client/src` or `shared/src`**. The Live adapter lives only in `scripts/voice-live-lab/`. The policy extraction changed internal placement, not the interaction class.

Voice attachment covers **Pi, Claude and Antigravity** — not all five runtimes equally. Claude non-SDK delivery refuses; Antigravity queues. Preserve those truthful outcomes.

### 3.2 Current rules worth retaining, verbatim

- Model output cannot execute a send. The host releases stored operator text.
- Normalisation removes carriage/filler; it does not compose a plan. It runs **before** approval, with original wording and removals retained.
- Drafts accumulate across turns and worker updates. Confirmation ages; the draft is not silently lost.
- Card confirmation carries version/hash identity; stale cards and unavailable original variants refuse.
- Fixed acknowledgements follow delivery outcome: delivered, queued or refused.
- Reading levels, stop-talker, deduplication, focus/recap, operator-first playback, lane identity and capture recovery are **product features**, not incidental prompt instructions.

### 3.3 The gate is not infallible — reproduced locally

A side-effect-free call to the shipped classifier, executed against real source with no model call and no delivery:

| Input | Classification |
|---|---|
| `not sure` | **confirm** |
| `I said yes` | **confirm** |
| `yes, hold phase three` | **confirm** |
| `sure, but wait` | **confirm** |
| `yes, actually no` | `cancel` |

Root cause: `CONFIRM_PATTERN` matches confirmation words **anywhere** in the utterance, so `sure` matches inside `not sure`. `policy-core.ts` then releases on that class when a fresh, non-lapsed draft exists. The proposal-identity gate applies only when the client supplies a `proposalRef`; a **bare spoken confirmation carries no echo by design**, so the voice path is the unguarded one.

**This is a live production defect, not a design observation.** An operator expressing doubt dispatches the held instruction. It breaks N3 — the single rule the entire system exists to enforce — and it is a small, well-bounded fix. It should not wait for any architecture decision. It is Step 1 in §7 and decision 2 in §8.

Native voice activity introduces a second boundary: Tier 1's tracker treats **400 ms without transcription deltas** as sufficient to commit. An ASR pause is not proof a person has finished. "Mathematically guaranteed zero risk" is not an honest description of either mechanism.

---

## 4. The target, concretely

### 4.1 Topology

```text
                  ONE ACTIVE INPUT TARGET / SHARED AUDIO FLOOR
Microphone ──────────────┬────────────────────────────────────────────┐
                         ↓                                            ↓
              Native conversation session                  Transcript pipeline
              Gemini 3.8 Live standard                    native + async shadow ASR
                         ↕                                            ↓
              filtered worker context                    HOST AUTHORITY KERNEL
              + typed read-only ops                       thread · parking lot
                         │                                proposal · release
                         │                                            ↓
                         │                              delivery adapter + receipt
                         │                                            ↓
                         │                              PERSISTENT REASONING WORKER
                         │                              coder OR parent conductor
                         ↓                                            ↓
                   Native audio                          worker events / exact reads
                         └────────── SPEECH SCHEDULER ────────────────┘
                              trusted receipts have their own source
```

The host is **not a third reasoning model.** It is the accountable source of state and permissions. There must never be two competing orchestrators, one in voice and one in the worker.

**The Server-Side WebSocket Bridge (`server/src/voice/` or `server/src/talker/`):**
To ensure strict security and protocol integrity, the browser never connects directly to external model providers:
1. **Protected Credentials:** The browser captures 16 kHz PCM audio and streams it across an authenticated, cookie-backed WebSocket to the host server. `GEMINI_API_KEY` stays strictly on the server and is never exposed to the client.
2. **Protocol Adaptation:** The server-side service maintains the full-duplex bidi-streaming WebSocket connection to Google Gemini Live, converting between client 16 kHz PCM and provider 24 kHz PCM.
3. **Context Injection:** The server injects authoritative worker status into Gemini Live using `sendClientContent` turns, ensuring the voice model has immediate access to real worker execution state without client-side coordination.
4. **Resumption & Connection Lifecycle:** The server manages session resumption tokens, handles `goAway` reconnects gracefully, and coordinates the audio floor.

### 4.2 The four objects — the core of the design

The shipped harness has **one** object, the draft. Every operator statement flows toward it, so every statement produces a send offer, so thinking aloud is punished. That single fact is the switchboard feel. The fix is structural.

| Object | Lifetime | Who writes it | Sendable |
|---|---|---|---|
| **Thread** | ephemeral, per attachment | conversation | **never** |
| **Parking lot** | durable, per attachment | operator (explicit) | only via promotion, per item |
| **Proposal** | one live per lane | host, on promotion | only via release |
| **Release** | permanent record | host, on authorised confirmation | — |

**Pragmatic host implementation (no event-sourcing bloat).** The four objects represent distinct lifecycles and authority boundaries, not four database engines or an event-sourcing subsystem:
- **Thread:** The ephemeral in-memory state of the active S2S WebSocket session, its turn history, and working scratchpad.
- **Parking lot:** A lean, in-memory array (`{ id, text, createdAt, sourceUtteranceId }`) attached to the lane.
- **Proposal:** A single live proposal slot (e.g. `PendingProposalStore`) holding `{ id, version, hash, original, tidied, presentedVariant, status }`.
- **Release:** An append-only audit log with idempotency keys and runtime receipts (`delivered`, `queued`, `refused`, `unknown`).

**Thread.** The live conversation; nothing in it is addressed to the worker. Analysis, disagreement, questions, speculation, thinking aloud. **No send offers are generated from the thread.** This is what removes *"it's kind of wanting to relay something and it's explaining it to me at the same time."*

**Parking lot.** Ordered, visible, individually promotable items flagged while the worker was busy. Survives worker turns and lane switches. Readable back on request. **Never sent as a batch** — N3 is per instruction, and batching would quietly defeat it. The talker may offer to raise parked items when the worker next surfaces, which is exactly when interrupting is cheap.

**Proposal.** Exact bytes, version and hash, target lane and attachment generation, both `original` and `tidied` variants retained, plus *which* variant was presented and whether presentation completed or was interrupted.

**Release.** Idempotency key, delivery state, receipt. **"Unknown outcome" is a first-class state** distinct from refused: a timeout after submission must be reconciled against the idempotency key, never retried blindly. Exactly-once is not obtained by adding a retry loop.

**Why not fewer objects.** Merging thread and parking lot forces the talker to guess which utterances were intentions — that guess *is* the ChatGPT Voice failure. Merging proposal and release removes the stable identity to confirm against, so a stale "yes" can release text the operator never saw in its current form — the defect D-card versioning already fixed once.

### 4.3 What the kernel persists, per attachment

- Stable worker/session identity, runtime, lane ID, and an **attachment generation** that changes on worker switch.
- Operator turn IDs, raw recognised text, normalised text and removals, draft-part IDs.
- Proposal version/hash, exact target, selected variant, and **which proposal was actually presented**, and whether presentation completed.
- Parking-lot items with their source utterance IDs.
- Confirmation scope/expiry; outstanding worker permission requests and their exact IDs.
- Release idempotency key, delivery state, receipt, unresolved outcomes.
- Playback/read position, already-heard ledger, focus, reading level.

**The release predicate:** a complete, committed operator confirmation **+** one currently presented proposal **+** matching target, generation, version and variant **+** no cancellation or ambiguity **+** no prior successful release for that identity.

### 4.4 Promotion — the judgement, made mechanical where it can be

A proposal is created by exactly three routes, all explicit:

1. **The operator addresses the worker** — *"ask it…"*, *"tell it…"*, *"send…"*.
2. **The operator accepts an offer** made under the conditions below.
3. **The operator promotes a parked item.**

Nothing else creates a proposal. An ordinary declarative sentence in the thread does not.

**The talker may offer** only when: it cannot answer from what it holds *and* read-only retrieval failed or is out of scope; **or** the question requires the worker to *act*; **or** the operator has expressed a decision that changes the worker's current course.

**The talker must not offer** when: it can answer (P22 — answer, don't route); the operator is thinking aloud or self-correcting; it already offered on this topic and was declined; the operator is asking about the conversation itself; or the worker is mid-run and the item is not urgent — offer to **park** instead.

**At most one offer per topic.** A declined offer is remembered in kernel state, not in the model's goodwill.

### 4.5 Interruption cost is structured context, not a guess

A relay to a **busy** worker is a steer — it interrupts, joining at the next tool boundary. A relay to an **idle** worker is cheap. These are materially different acts, so worker busy-state and the resulting delivery class are supplied to the talker as typed context every turn:

> *"It's part-way through the test run — want me to hold this until it surfaces, or interrupt it now?"*

Urgency is the operator's call. The talker's job is to make the cost audible and offer the cheap option first. This is also where the B2 lesson lands in product form: the host owns event-driven supervision, so voice updates never restart the parent or convert watcher notifications into polling.

### 4.6 Fidelity: what may be composed, and what may never be

This is the design's most delicate boundary, so it is stated as three separate rules rather than one.

| Kind | Who composes | Approval |
|---|---|---|
| **Instruction to the worker** | **Always the operator, semi-verbatim.** N2 untouched. | proposal card or spoken confirmation |
| **A question the operator asked and the talker cannot answer** | the operator's own words, forwarded | same gate |
| **A harder question worked out together** | the talker may draft it | **read back in full before confirmation** |

The third case is what the renewed intent asks for. It is safe **only** under the read-back rule: the operator hears the actual bytes before authorising them. A reassuring gloss is never sufficient for composed text — **the conversational gloss is not the payload**. For complex or multi-part instructions, default to reading the actual draft rather than a summary.

**Conversational read-back for composed questions:** When the talker suggests or drafts a question aloud in conversation (e.g. *"Should I ask the worker: 'Why did the auth retry handler drop the session token on line 42?'"*), **that spoken utterance itself constitutes the read-back**. A prompt confirmation like *"Yes, ask that"* immediately authorises release without requiring a redundant second read-back loop (*"I will ask... are you sure?"*). If the talker merely summarised its intent (*"Shall I ask it about the auth issue?"*), then and only then must the host read back the full drafted question before asking for confirmation.

Maintain three separate artefacts throughout: **audio received**, **words recognised**, **bytes delivered**. Exact delivery of a bad transcript is still bad fidelity.

- Native transcription is the candidate draft source; shadow ASR runs **asynchronously** for comparison. The current Tier 1 lab implementation `await`s shadow ASR *before* the policy decision (`tier1-guarded.ts:584`) — **do not copy that coupling into production**; only authorisation in an explicit sidecar mode may wait, and that delay must be labelled and measured.
- Preserve negations, conditions, names, paths, target agents and phase boundaries. Aggregate WER cannot certify these.
- If the authorisation transcript is missing, contradictory or uncertain on a critical detail, **hold and clarify**. Never quietly swap transcript sources after the operator approved one version.
- *"Send my original words"* selects the retained original recognised transcript — **not** a claim of perfect acoustic truth. Keep it reachable by voice as well as on the card.

### 4.7 Provenance — and the risk that freeing the talker actually creates

Lifting *"answer only from the state snapshot"* is what makes thinking-together possible. It is also the single riskiest change in this document, so the mitigation needs stating carefully rather than assumed.

**The four-object model does not cover this risk.** It is worth being explicit, because it is easy to assume it does. The four objects solve the **authority** problem completely: nothing the talker thinks can become a send, because thinking lives in the thread and the thread is structurally unsendable. They do **nothing** for the **epistemic** problem: you believing something false that the talker said with confidence. Those are different failure classes and they need different defences.

The risks, named:

| # | Risk | Severity |
|---|---|---|
| R1 | **Confabulated progress** — *"it fixed the parser"* when the worker only planned to | highest; indistinguishable from fact in audio |
| R2 | **Confident wrong reasoning** about code it half-sees, which you then act on | high; entirely new, the snapshot rule prevented it absolutely |
| R3 | **Provenance collapse** — the model simply omits the band | high; provenance is a *prompt* rule, exactly the kind this document argues you cannot lean on |
| R4 | **Divergent world model** — the talker's picture drifts from the worker's, and you brief the worker from the talker's picture | medium |
| R5 | **Second planner** — it reasons its way to a plan, which colours the question it drafts | medium; a softer form of the original ChatGPT Voice failure |
| R6 | **Retrieval as an injection vector** — read-only retrieval pulls untrusted file and worker text into the talker's context | medium |

The three bands remain the vocabulary:

| Band | Meaning |
|---|---|
| **Reported** | the worker said this — quotable, attributable |
| **Derived** | computed by the host from worker output or session state |
| **Mine** | the talker's own reasoning, inference or opinion |

But the bands must be **enforced structurally wherever they can be**, not merely requested. Six mitigations, ordered by how much they do not depend on the model behaving:

**M1 — Quotes and exact worker text are host-rendered or attributed.** "Reported" is backed by typed read operations. When the operator requests an exact quote or readout of worker output, this is handled by host-controlled synthesis or clearly demarcated output, not unanchored voice-hallucination. In full-duplex S2S conversation, the host does not attempt real-time grammatical voice-splicing on streaming audio (which destroys latency and fluency); instead, the talker is prompted to qualify citations (*"The worker reported..."*), and exact reads are served out-of-band or via the dedicated reading scheduler. *(Addresses R1, R4.)*

**M2 — Delivery receipts and completion claims are host-owned, not model-hallucinated.** A free-streaming model must never be trusted to declare *"sent it"* or *"it's finished"*. Instead of unworkable real-time audio interception:
1. **Out-of-band delivery receipts:** Proposal dispatch and delivery outcomes are communicated by the host via a trusted audio earcon/chime and an explicit fixed status string on the UI card, completely outside the Live model's audio channel.
2. **Authoritative context injection:** The host injects crisp worker status into the Live session context on every state transition (e.g. `[CURRENT STATUS: WORKER RUNNING (step 3/5); DO NOT claim work is finished]`).
3. **Conversational qualification:** The prompt strictly forbids the talker from announcing completions that are not verified in its current context snapshot.
This mirrors N6: delivery is attested by host telemetry and trusted chimes, never model chatter. *(Addresses R1.)*

**M3 — Unmarked defaults to "Mine".** If the talker does not mark a band, the host treats the statement as lowest-trust and the surface displays it that way. This inverts the failure mode: forgetting to label degrades to **caution**, never to false authority. A prompt rule that fails safe is worth far more than one that fails silent. *(Addresses R3.)*

**M4 — The state view carries coverage metadata.** Source, time, and *what is missing*: "you hold turns 14–32 of 32; turns 1–13 are outside the window." Then *"I can't tell from what I hold"* becomes **derivable from state** rather than something the model has to remember to say — and the offer conditions in §4.4 get a mechanical input instead of a judgement call. *(Addresses R2, R4.)*

**M5 — Retrieved text is tagged at ingest** with source and timestamp, passes prompt-injection detection like any other untrusted input, and is **data, never instruction**. Retrieval never expands what the talker may *do*. *(Addresses R6.)*

**M6 — *"Where did you get that?"* is always answerable.** Every Reported or Derived statement carries a locator — turn N, file X, worker event Y — reachable by voice. If the talker cannot produce a locator, the statement was inference, and saying so is the correct answer. This gives you a cheap, in-conversation audit that costs one question. *(Addresses R1, R2, R3.)*

M1, M2, M3 and M4 are structural and hold regardless of model behaviour. M5 is an existing security control extended to a new input. Only M6 partly depends on the model, and its failure mode is visible rather than silent.

**What remains, honestly:** R2 and R5 are not fully solvable. A model that reasons can reason wrongly, and a model that reasons about your problem will have opinions that colour how it phrases a question. The read-back rule in §4.6 is the backstop for R5 — you hear the actual bytes before authorising them — and for R2 the backstop is M3 plus M6 plus your own judgement. **This is a deliberate trade**: the current design has no R2 risk because the talker cannot think, and that is precisely the limitation being removed. It should be measured — the honesty suite in §7.1.3 exists for exactly this — not assumed away.

Two lines carry over unchanged and matter more, not less: the absolute distinction between what the worker **said it would do** and what it has **done**; and never claiming an action it did not take.

### 4.7a Reasoning depth: the standard model, and nothing built in advance

Thinking together plausibly wants more reasoning than relaying did. The Live model has an extended-thinking variant. **Decision (owner, 2026-09-17): build on the standard model and add no escalation machinery.**

The rationale is structural rather than frugal. **A strong reasoning model is already attached** — the worker. If a question needs deep thinking about the code, that is what the worker is *for*. Putting a second deep reasoner in the voice seat partly re-creates the two-competing-orchestrators problem §4.1 exists to prevent, and it would charge extended-thinking latency on every *"what's it doing?"* merely because some questions are hard. Extended thinking in the voice seat buys reasoning in the one place where latency costs most and provenance is weakest.

**An earlier draft of this document proposed a five-rung escalation ladder** — talker reasons, then retrieves, then a host-side text analysis call, then park, then steer. **The owner rejected it as unnecessary complication.** The reasoning, recorded because it generalises: pre-building graduated fallbacks for a deficit nobody has experienced yet is speculative machinery. Real use will show whether a gap exists and what shape it has, and a remedy designed against an observed gap will be better than one designed against an imagined one.

**What this means for an implementing agent:**

- Build the conversational seat on `gemini-3.8-live` **standard**. Do not add a host-side analysis call, a second reasoning model, a routing layer that chooses between reasoning depths, or any "escalate when hard" heuristic.
- The talker reasons directly, marked `Mine` (§4.7). It retrieves read-only material when it needs to (§4.8). It parks items or offers to relay under §4.4. Those already exist for their own reasons and are **not** a ladder — do not present them as one or add rungs between them.
- **Do not treat a future capability gap as a defect to design around now.** If conversation proves too shallow in real use, that is an owner decision taken with evidence at the time, not a hook left in the code.
- The measured campaign (§7) still carries an extended-thinking arm. That is **information, not machinery** — it tells the owner what the variant would buy, without committing the product to it.

### 4.8 The rules: three layers, only one shrinks

| Layer | Contents | Change |
|---|---|---|
| **Code-enforced authority** | N1, N2, N5–N9; proposal identity; release idempotency; receipt wording | **unchanged, hardened** |
| **Structured state** | worker busy-state, reading level, focus, pending proposal, parked items, history window and its limits, housekeeping exclusion | **grows** — moved *out* of the prompt |
| **Prompt** | identity, tone, provenance, when to offer, brevity | **shrinks sharply** |

**Fewer rules for the model, more rules in the host.** Freedom where it improves the product; none where it would cost safety.

**Freed:** the *"say back, ask, wait"* ritual (the host renders and reads the proposal — a narrated gloss adds a turn and risks distortion); the `[[to-talker]]` / `[[ask-worker]]` text markers (fragile in prose, and a native-audio model has no reliable text side-channel — replaced by typed operations); *"answer only from the state snapshot"* (replaced by §4.7); *"you have no tools"* (narrowed to read-only, below); rigid brevity; the spoken recitation of per-instruction permission (the rule stays absolute in code); and the housekeeping / pending-line / focus prose, all now structured state.

**Newly permitted, as an explicit allow-list:** read-only retrieval (more worker history than the standing window, a specific earlier turn, a file inside the attached session's working directory — this kills the P23 *"it just wouldn't, simply wouldn't do it"* class structurally rather than by enlarging a prompt); playback control; parking an item and reading the lot back; signalling that an utterance was addressed to it; and offering to relay under §4.4.

**Still forbidden:** send, shell, spawning children, mutating any session, starting or stopping work, composing instruction bytes.

Every permitted operation is **typed, carries a source utterance ID, and is validated server-side for scope**. None can supply consent or replacement delivery text. Retrieved text is **data, never authority**, and passes the same prompt-injection checks as any other untrusted input. Expanding this surface is an owner-approved capability change, never an implementation convenience.

**The prompt, in outline (~15 lines):** who you are and that the worker is separate; speak like a colleague, no markdown, no spelled-out paths; label what you know, derived and guessed; you cannot send — the host does that when the operator authorises it; offer to relay only when you genuinely cannot answer or the worker must act, once, then let it go; say little while work runs, speak when something changes the operator's situation; if unclear, ask one short question.

### 4.9 Capture: voice activity governs speech, never sending

**Tap-to-talk is retained as an explicit mode and as the fallback, but stops being the primary turn boundary.**

The reasoning: tap-to-talk currently does **two jobs at once** — it bounds the audio turn, *and* it implicitly signals "I have finished thinking." Native audio breaks the first; the second was never safe to infer from a gesture. So:

> **Voice activity governs when the talker may speak. It never governs when the host may send.**

A pause is not consent. **400 ms is a parameter, not a safety theorem.** Commitment combines observed speech end, transcript stability and an open-turn state; new speech or a revision invalidates it; cancellation wins before dispatch; flush or disconnect must never turn partial speech into a confirmed send. After a completed delivery, a later "no" is a **new correction**, not a rollback of work already started.

**400 ms stability governs conversational pacing, never mechanical dispatch.** In the Tier 1 harness, 400 ms of silence or transcript stability was used to signal that the user had paused speaking. While this is a useful heuristic for conversational turn-taking (allowing the talker to respond without interrupting mid-sentence), **it must never be treated as an automatic trigger to dispatch or release a proposal**. Dispatch requires an explicit, validated confirmation utterance (`confirm`) matching the presented proposal.

| Mode | When | Behaviour |
|---|---|---|
| **Open mic** | default, lane active and foregrounded | native VAD, full duplex, barge-in with ducking |
| **Push-to-talk** | operator choice; automatic fallback when the native socket is down | hard boundary — noisy rooms, precision dictation, privacy |
| **Ambient** | goal clause 5; **deferred — see §4.9a** | mic open, talker silent until addressed, free to speak first |

Never claim continuous listening while the OS has suspended capture; show and speak suspension and reconnection; keep push-to-talk and typed fallback always reachable.

### 4.9a Ambient operation: deferred, and honestly not a browser feature

**Decision (owner, 2026-09-17): ambient operation is deferred, and it stays a live goal rather than a cancelled one.** Goal clause 5 — *works when hands and eyes are busy* — remains the largest gap in the surface, and the intent file still calls it "the biggest thing the current surface lacks". Nothing here retires it.

But the follow-up must be described truthfully, because the tempting version of it does not exist:

> **Ambient is not a feature that gets added to the web UI later. Mobile browsers are a different playing field, and the honest vehicle for it is a phone — most likely a native mobile app.**

The reasons are platform facts, not implementation effort:

- **Background tabs get suspended.** iOS and Android reclaim backgrounded web pages; the microphone is released and timers stop. A tab in your pocket is not listening, whatever the UI says.
- **Speaking first requires being alive.** Proactive speech — *"the tests went red"* — needs the client running when you are not looking at it. In a browser that means either the tab is foregrounded, or it is not happening.
- **Autoplay and audio-session rules** restrict when a page may make sound without a fresh user gesture, which is precisely the situation ambient describes.
- **Wake handling belongs on-device.** Deciding "were they talking to me?" without streaming a continuously open microphone to a paid provider wants local detection, battery management and an explicit privacy posture — all native concerns.

So the follow-up is **a mobile client**, not a phase of the web work. That carries its own scope: background-audio entitlements, push for proactive speech, on-device wake handling, app-store review for a persistently open microphone, and the running cost of an open mic.

**Why deferring is nonetheless cheap — and the design rule that keeps it cheap.** Everything that makes ambient *safe* is already server-side and client-neutral: the authority kernel, the four objects, proposal identity and confirmation, delivery adapters and receipts, provenance, parked items and reading levels. The web UI is one consumer of that kernel; a future mobile client would be another. So:

**Standing instruction to implementing agents:** keep the kernel's interface **client-neutral**. Do not let browser-specific assumptions — tab visibility, page lifecycle, DOM-bound state, a single shared audio floor per tab — leak into `server/src/talker/` or the shared event contracts. Ambient-mode state belongs in the capture state machine's existing seat, not in new branches scattered through the client. Getting that boundary right is the whole cost of keeping this option open, and it is worth paying now.

**Confirmation acceptance must be narrowed before migration:** replace broad substring matching with explicit whole-utterance forms, negation and quotation refusal, rejection of confirmations carrying new content, and binding to the presented proposal. A casual "yes" to a conversational question must never send an unrelated pending draft. Preserve explicit per-instruction approval; never invent a global "stop asking forever" mode.

### 4.10 Audio ownership and honesty

One scheduler across native audio, receipts and worker reading. Distinguish operator speech, receipts, elicited answers, worker updates and unsolicited chatter. **Listening is never disabled because another lane wants to speak.**

**Playback contract: duck-and-continue is retained.** N5 is an operator decision, not the provider's. A provider may cancel generation on barge-in, and ducking received PCM cannot preserve audio that was never generated — so persist a reading cursor and explicitly resume or reconstruct the unplayed remainder. Native-interrupt stays a separately labelled option requiring owner approval and a comparative listening test.

**Free streaming speech cannot offer a mathematical honesty guarantee.** An output transcript arriving after audio is too late to retract a false "sent it". So **during confirmation and delivery, reserve playback for host-owned proposal and receipt audio and quarantine competing native output until the state resolves.** Elsewhere, use instructions and monitoring, acknowledge the residual semantic risk, and test false-action claims explicitly. This bounded hold is a deliberate latency trade-off at the authority moment only — never a full ASR/judge pass in front of every conversational answer.

For reading: verbatim and exact draft read-back use **host-controlled synthesis**. Summary and Headlines stay application transformations with provenance, initially on the existing digest route; comparing Live-generated summaries is a separate later optimisation, not bundled with the transport migration. Preserve short-turn verbatim, immediate level changes at safe boundaries, the "In short:" cue, no repeats, and no missing first words.

### 4.11 Lanes, context and recovery

Do not confuse **two model roles within an attachment** with the existing **up-to-three attached worker lanes** in one tab. One logical conversational state per attached worker; one active microphone target; explicit, acknowledged route switching. **An unfinished draft stays with its original target** — switching workers must never silently retarget a pending "yes".

Provide voice equivalents of every essential control: name/switch the active lane, what is pending, read the draft, send original or tidied, cancel, stop speech, focus/resume, change reading level, park and read the lot. Uncertain target matches require disambiguation; a concise spoken target cue prevents screen-free mistakes.

Inactive lanes retain worker subscriptions and host state without permanently streaming three paid microphones — connect the active lane's native session on demand and preserve independent state when suspending. Decide warm-session caching from measured reconnection latency and cost. A shared cross-tab floor needs an explicit coordinator or lease, not three per-tab singletons; cross-device arbitration is a separate scope decision.

Project current worker events and bounded history with source, time and coverage metadata. Keep injected housekeeping out **structurally, at the emitter**. Prefer read-only expansion over blindly enlarging the prompt or asking the worker to repeat itself.

**The worker must continue when the voice socket closes.** Store drafts, receipts, parked items and supervision state outside the model context; context compression must not compress away authority. Build resumption, compression and connection generations into the product adapter **for all native voice attachments**, not only the lab's Tier 3 — everyday conversations outlast a short Tier 1 attempt. On reconnect, restore a compact host snapshot; never replay acknowledged sends or heard speech. Voice approval to relay a request is **not** permission to bypass worker-side permissions, production restart gates or consequential-action review.

---

## 5. Why the alternatives are closed

These are recorded as rationale, not as a menu to choose from again.

### 5.1 Why not let the Live model be the conductor

The tempting simplification — one model that talks *and* orchestrates — is closed for now on three independent grounds:

- **No evidence.** Tier 3's 100% is a scripted fixture with `realProviderCalls: 0`, a fake Live model, a fake Internal API and fake children. It establishes that the tool surface is wired, nothing about governance.
- **Direct operator experience.** GPT-Live driving Codex threads made real governance mistakes; handling several workers is genuinely complicated, and a fluent voice is not evidence of good supervision. The AA arena's own caveat — *a preferred conversation does not always result in successful task completion* — is the same failure shape.
- **The rules problem.** In ChatGPT Voice the operator could not write the rules; `AGENTS.md` governed Codex, not the voice model upstream of it. The two-lane design exists precisely so the rules are the operator's and are enforced in code.

It stays a legitimate **experiment**, not a rejected idea. Promotion would require: the pre-registered B2-short comparison against **fresh same-route text controls**, zero confirmation violations, acceptable brief fidelity, then full-length governance and recovery tests. No synthetic score substitutes. And there is no reason to pay extended-thinking latency on every conversational turn merely because the attached text worker reasons deeply.

### 5.2 Why not a pure transport swap

Keeping today's conversational rules and only replacing the cascade is the lowest-risk change and remains a useful **first migration checkpoint** to prove the audio path — but it is not the destination. It buys latency and ships the switchboard, because the switchboard lives in the prompt and the one-object model, not in the transport.

### 5.3 Why not a model-composed relay for instructions

Letting the model compose what is sent would improve editing and reduce procedural turns, and it is exactly the failure the system was built to prevent: re-planning, dropped qualifiers, a conditional becoming an absolute upstream of anything the operator can correct (P25 documents this happening even to a *mechanical* normaliser). Composition is permitted for **questions only**, under read-back (§4.6).

### 5.4 Why not just improve the existing cascade

It remains the fallback and must keep working throughout. But its serial legs — recognition, then model, then synthesis — are structural, and tap-to-talk with them is the interaction class the operator is dissatisfied with. Improving it does not reach goal clause 5.

---

## 6. Economics: meter the product, not the sales pitch

Using the repository's dated rate assumptions ($3/M input audio tokens, $12/M output audio tokens, ~25 tokens/second), audio-only illustration:

| Usage in a wall-clock hour | Cost |
|---|---|
| 10 min input + 10 min output | **≈ $0.225/h** |
| 20 min each | **≈ $0.45/h** |
| Continuous both directions | **≈ $1.35/h** |

These are **arithmetic scenarios, not measured bills or current price verification**. Add text/context, any thinking charges, trusted synthesis, fallback ASR and multiple connected lanes; account for idle streaming behaviour from actual usage. Separate product cash spend from existing worker subscription draw and one-off lab cost. Do not double-count token categories or presume idle listening is free.

Use configurable per-session and per-day budgets, usage telemetry, and an explicit degraded-mode offer. Local speech detection with a pre-roll buffer may avoid uploading silence — but must not clip first words (P21 was exactly that defect). **Do not advertise a monthly saving or the memo's latency/cost superiority until matched runs support it.**

---

## 7. Sequence

**Owner decision, 2026-09-17: streamline the verification campaign.** The original lab proposed a massive 210-attempt (~14-hour) synthetic simulation treadmill across four arms. That approach collapsed into faked reports, sine-wave drivers, and unexecuted matrices because it prioritised artificial volume over real human validation. **The owner approved replacing the synthetic treadmill with a lean deterministic safety regression suite on the host kernel, paired with real-ear interactive dogfooding.**

This refocuses effort where it actually protects the product: fast, deterministic unit tests for authority and safety invariants, and real human ears for fluency and conversational feel.

**Step 0 — repair trust in the evidence.** With owner authority, correct the memo, ledger and published site, and replace literal report verdicts with manifest-derived aggregation. TDD: dry runs cannot enter standings; no attempts means not measured; missing usage/audio/fixture provenance fails closed — and prove that with a deliberately empty run set. Preserve historical records; do not erase inconvenient results.

**Step 1 — fix the gate, RED first.** Independent of everything else, on the current cascade. Failing regressions for `not sure`, `I said yes`, `yes, hold phase three`, `sure, but wait`, unrelated "yes", delayed ASR revisions, long mid-thought pauses, correction immediately after apparent endpoint, interrupted proposal presentation, reconnect flush, stale cards, original/tidied identity, duplicate release and lane switching. Then narrow acceptance to explicit whole-utterance forms with context binding. **Narrowing unsafe confirmation is the opposite of broadening model authority**; replay the existing corpus and keep the cascade working.

**Step 2 — build the product-shaped vertical slice, disposable.** Extract reviewed pieces from the script harness; **do not import the experimental runner wholesale**. Ownership:

- `server/src/talker/` — canonical policy, the four objects, draft and delivery semantics.
- New server native-voice adapter/service (`server/src/voice/`) — authenticated audio connection, session lifecycle, host-state projection, WebSocket bridge.
- `shared/` — typed, versioned audio/turn/proposal/receipt/parked-item events with lane and attachment generation.
- Client capture/player — AudioWorklet or equivalent paced PCM, bounded buffers and backpressure, the shared speech floor.
- Existing worker reading/delivery paths — **reused, not forked**.

Retain cookie/origin/CSRF protections, input validation, size and rate limits, and prompt-injection checks before worker forwarding. **Never stream provider credentials to the browser.** Scope context access to the attached authorised session; raw audio and transcripts need explicit retention limits and must never enter public git or generic error logs.

Run existing tests plus disposable real-worker delivery and browser tests. Assert delivered/queued/refused against **actual runtime receipts**, not a green card. Cover Pi, Claude SDK and an explicitly authorised isolated Antigravity path; never substitute production for a disabled disposable runtime.

**Step 3 — prove the experience and recovery.** Two and three lanes; first-word capture; background and resume; network loss; stale confirmations; model outage; no duplicate audio; reading-level switch; stop without capture loss; ASR disagreement; a conversation spanning connection churn and compression. Audio proof must inspect **rendered output**, not only transcripts — and the documented private-PulseAudio failure on this host leaves that dimension **indeterminate** until an isolated capture environment exists. Do not turn reference-player PCM into a claim about browser speakers. Use the ≤2 s p90 conversational target as the initial acceptance objective; report native vs matched cascade deltas; separately measure substantive answers while worker tools run.

**Step 4 — lean deterministic regression suite.** Specified in §7.1 below; fast automated regression tests on the host kernel (`policy-core.test.ts`, `utterance-classifier.test.ts`), plus the frozen 20-utterance fidelity corpus, verifying all veto gates, delivery receipts, and structured context invariants.

**Step 5 — real-ear interactive dogfooding and owner acceptance.** The true acceptance test for conversational fluency, natural turn-taking, latency, and colleague feel is the operator's real ear in interactive coding sessions. Short paired recordings and a disposable hands-busy trial close the gap between mechanical safety and genuine product quality.

**Step 6 — reversible rollout.** Opt-in feature flag, known fallback, observable budget, rollback. Production deployment and restart is a separate gate. Native-interrupt, composed questions and Live-as-conductor each need their own decision; a transport approval is not approval for all three.

---

## 7.1 Lean verification and regression suite

### 7.1.1 Why the 210-attempt synthetic treadmill is replaced

The previous lab attempt collapsed into hard-coded report literals, sine-wave drivers streaming 60 ms tones per word, and unexecuted matrices. That happened because the harness attempted to simulate 210 full conversational attempts (~14 hours of continuous Live streaming) using synthetic operators and mechanical silence generators.

Simulating massive volumes of speech through a synthetic loop creates an illusion of rigor while testing neither acoustic comprehension nor conversational feel. Real safety sits in the deterministic state transitions of the host kernel; real conversational fluency sits in the operator's ear. Step 4 therefore replaces the synthetic treadmill with a lean, authoritative regression suite that runs in seconds on CI/local development.

### 7.1.2 Deterministic safety regression suite (veto gates in host kernel)

Executed as fast, hermetic automated unit tests in `server/tests/unit/talker/`:

1. **Zero unauthorised releases:**
   - Explicit rejection of doubt: `"not sure"` must classify as `unknown` or `cancel`, never `confirm`.
   - Rejection of qualified or conditional agreement: `"sure, but wait"`, `"yes, hold phase three"`.
   - Delayed ASR revisions: late-arriving words overturning prior intent invalidate confirmation.
   - Mid-thought pauses: silence or 400 ms stability does not release without an explicit confirm utterance.
2. **Proposal identity & binding:**
   - Released bytes must SHA-match the presented proposal variant (`original` vs `tidied`).
   - Stale proposal rejection: confirmations bound to prior turns or lapsed IDs are rejected.
   - Cancellation wins: explicit cancel immediately purges pending proposals.
   - No release after disconnect: flush or socket drops never convert partial speech into a send.
3. **Idempotency & runtime receipts:**
   - Exactly-once delivery: duplicate confirmations for the same proposal ID produce a no-op / duplicate refusal.
   - Unknown outcome handling: submission timeouts transition to `unknown`, requiring host reconciliation rather than blind retry.
4. **Interleaved events & lanes:**
   - Drafts and proposals survive interleaved worker notifications and tool events.
   - Lane switching preserves pending proposals with their original target without retargeting.

**All safety failures are vetoes.** A single unauthorised release fails the suite.

### 7.1.3 The 20-utterance fidelity corpus

Re-use the 20-utterance fidelity corpus from the lab assets to verify transcript and delivery fidelity:
- **Speech → Recognised:** Word error rate, required-word recall, and critical survival of negations (*"not"*, *"never"*), conditionals (*"if"*, *"unless"*), file paths, and target agent names.
- **Recognised → Delivered:** Byte equality for semi-verbatim operator instructions; required-word recall for composed questions.

### 7.1.4 Real-ear interactive dogfooding (Step 5 acceptance protocol)

Mechanical tests verify safety; only the human ear verifies conversation:
- **Operator hands-busy trial:** The operator drives a real coding task using the disposable slice with open mic.
- **True spoken TTFA:** Measured from speech-end to first audible played PCM (target ≤2 s p90).
- **Fluency checks:** Verify smooth ducking during speech, prompt barge-in recovery, seamless reading-level switches, and audible out-of-band delivery chimes.

---

## 8. Decisions taken (owner, 2026-09-17)

These are settled. An implementing agent follows them; it does not re-open them. Where a decision changed an earlier draft of this document, the superseded position is recorded too, so the reasoning is not lost and is not rediscovered as a "missing" idea.

| # | Decision | Status | What it binds |
|---|---|---|---|
| **D1** | **Correct the evidence.** The lab sign-off, decision memo and published leaderboard may be corrected to distinguish delivered equipment from unperformed measured runs. | **Approved** | Step 0. Preserve historical records; annotate rather than erase. The site figures with no traceable source go first. |
| **D2** | **Fix the confirmation gate now.** | **Approved** | Step 1, on the current cascade, independent of the migration. `"not sure"` must never release. |
| **D3** | **Adopt the target architecture** in §1 — two lanes kept, cascade replaced with native audio, authority moved from prompt into code and structured state. | **Approved** | Everything in §4. The tier question is closed; do not re-litigate it. |
| **D4** | **Streamline the campaign** — replace the 210-attempt (~14h) synthetic simulation treadmill with a lean deterministic regression suite + interactive dogfooding. | **Approved (revised 2026-09-17)** | §7, §7.1. The synthetic treadmill collapsed into faked reports and sine-wave drivers. Safety is verified deterministically in the host kernel; conversational quality is verified by the owner's real ear in Step 5. |
| **D5** | **Pragmatic provenance** — out-of-band delivery receipts via trusted chimes/earcons, structured worker context injection, and conversational qualification, replacing real-time audio voice-splicing. | **Approved** | §4.7. S2S streaming audio cannot be grammar-spliced in real time; host authority is maintained via out-of-band receipts and structured context. |
| **D6** | **Build on the standard model with no escalation machinery.** The five-rung ladder proposed in an earlier draft is **removed entirely**. | **Approved as amended** — *rejecting this document's earlier proposal* | §4.7a. See below. |
| **D7** | **Defer ambient operation**, keeping it a live goal with an honest follow-up path: a **phone, most likely a native mobile app** — not a later phase of the web UI. | **Approved** | §4.9a. Clause 5 is not cancelled. The price of keeping the option open is a **client-neutral kernel**, which is a standing constraint on Steps 2–4. |

### 8.1 On D6, because it generalises

The owner's reasoning, recorded verbatim in substance: *a set of steps to climb, designed before the thing has been built, is unnecessary complication; real usage will show how it works, and if it does not, a solution will be found then and there.*

This is a standing instruction to implementing agents, not a one-off preference. **Do not build graduated fallbacks for deficits nobody has experienced yet.** A remedy designed against an observed gap beats one designed against an imagined gap, and speculative machinery has to be maintained, tested and reasoned around in the meantime whether or not the gap ever appears.

Concretely for the voice work: no host-side analysis call, no second reasoning model, no depth-routing layer, no "escalate when hard" heuristic. The talker reasons directly; it retrieves read-only material; it parks or offers to relay. Those exist for their own reasons and are **not** rungs — do not describe them as a ladder or add steps between them.

### 8.2 On D7, and what it commits us to

Deferring ambient operation is **not** a decision to stop wanting it. Clause 5 is still the biggest gap in the surface, and §4.9a records the follow-up path rather than leaving it as a vague "later".

The honest part of that record is the vehicle: **a phone, and most likely a native mobile app.** Mobile browsers suspend background tabs, release the microphone, restrict unprompted audio, and give no good home for on-device wake handling. An ambient assistant that lives in a browser tab would have to either lie about listening or only work while you are looking at it — and the second is the thing clause 5 exists to escape.

What this commits an implementing agent to **now**, while building the web slice: keeping the authority kernel and the shared event contracts **client-neutral**, so the web UI is one consumer rather than the shape of the system. Browser lifecycle assumptions must not reach `server/src/talker/`. That constraint costs very little today and is the entire reason this deferral is cheap; skip it and ambient stops being a deferral and becomes a rewrite.

### 8.3 What remains open

- **Tier 3 / Live-as-conductor** remains a separate experiment against its own question (§5.1), not part of this programme.
- **Sizing** — this document does not estimate effort. The owner's stated expectation is that the build is fast; an implementing agent should size Steps 2–4 before dispatch and raise it if that expectation looks wrong.
- The open product questions inherited from the intent file §25 — multi-lane scope, fourth-lane behaviour, cue tone, desktop defaults, cross-tab arbitration.

**The bottom line:** the two-lane design is not the mistake. Coupling it to a rigid, turn-by-turn switchboard is. The target is **a fluent native-audio colleague in front of an independently capable reasoning worker, with a small, explicit, auditable authority kernel between them** — and the way to get fewer rules is to move the load-bearing ones out of the prompt and into code, not to relax them.

---

## 9. Source and verification map

**Intent and product.** [Canonical intent](./VOICE-MODE-INTENT.md) — Part I intent and N1–N9, Part II shipped behaviour, Part III the renewed thinking-together intent. [Lab specification](./VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md) §§4–8 intent, §10 decisions, §§16–20 tiers and scoring, §20.2 latency definitions, §25 completion. [Talker requirements](./TALKER-MODEL-REQUIREMENTS.md), [pricing research](./VOICE-AGENT-PRICING-RESEARCH-2026-09.md), [audio regression lab](./AUDIO-REGRESSION-LAB.md).

**Product code inspected.** [`policy-core.ts`](../server/src/talker/policy-core.ts), [`utterance-classifier.ts`](../server/src/talker/utterance-classifier.ts), [`relay-normalise.ts`](../server/src/talker/relay-normalise.ts), [`talker.ts`](../server/src/talker/talker.ts), [`v3-harness.txt`](../scripts/talker-prompts/v3-harness.txt), [`model-client.ts`](../server/src/talker/model-client.ts), [`useVoiceTurn.ts`](../client/src/components/DriveMode/useVoiceTurn.ts), `server/src/config.ts`.

**Lab evidence and limitations.** [L4](../scripts/voice-live-lab/L4-HANDOFF.md) §5, [L5](../scripts/voice-live-lab/L5-HANDOFF.md) §§4–6, [L6](../scripts/voice-live-lab/L6-HANDOFF.md), [L7](../scripts/voice-live-lab/L7-HANDOFF.md) §6. [Tier 1 runner](../scripts/voice-live-lab/lib/tier1-dryrun.ts) — `utterancePcm`, `runTier1MeasuredAttempt`, silence voice. [Tier 1 harness](../scripts/voice-live-lab/lib/harness/tier1-guarded.ts) — `TranscriptCommitTracker`, the shadow-ASR await. [Handshake](../scripts/voice-live-lab/lib/handshake.ts); capability record inspected locally, connection identifiers not reproduced.

**Sibling repository** `/root/agent-benchmarks/`: `benchmarks/04-voice-live-lab/{PLAN.md, generate_reports.mjs, report.json, run_voice_lab.sh}`, the retained `runs/tier3-dryrun-202609171304/.../manifest.json`, `site/index.html`, and `benchmarks/02-orchestrator-governance/{README.md, runs-manifest.json}`.

**Method.** Agent OS packet and pointed recall supplied continuity; current files and record provenance govern implementation and results. Published B4 claims were fetched directly. Classifier examples were executed locally against source without delivery or a model call. Historical test counts are attributed, not presented as rerun. No catalogue or quota probe was needed for this documentation-only task; model seats are intended configurations — **re-resolve before running and never silently substitute**.
