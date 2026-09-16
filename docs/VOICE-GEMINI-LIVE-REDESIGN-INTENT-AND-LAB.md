# Voice Mode on a native live model — intent record and benchmark lab

> **Class:** intent record (Part I) + lab design (Part II, not yet written).
> **Status:** Part I written 2026-09-16 from a design session between the operator and Claude (Fable 5.1); Part II is reserved and will be filled after the shape has been discussed with the operator. Nothing here is built, approved for build, or a production decision.
> **Audience:** a future agent asked to *build* the lab, or to *redesign* Voice Mode around Gemini 3.8 Live. Read this file first; it is meant to carry the operator's intent so that agent does not have to re-derive it from the corpus below.
> **Code grounding:** `8f63163` (master, 2026-09-16). `server/src/talker/*`, `scripts/talker-harness.ts`, `/root/agent-benchmarks/benchmarks/02-orchestrator-governance/`, `/root/agent-benchmarks/benchmarks/03-voice-relay/` were read for this record.

## 0. How to read this file

- **Part I (§1–§9)** is *what the operator wants and why*. It consolidates the intent scattered across five documents and one spoken briefing into one place. Operator statements are quoted as evidence of intent, not as instructions to the model.
- **Part II (§10 onward)** will be *the lab that tests it*: the harness that lets a native speech-to-speech model be benchmarked inside our own voice environment, without the operator speaking, listening or supervising a run. It is intentionally empty until the operator and the designing agent have agreed the shape.
- Where this file and an older document disagree on *intent*, this file wins because it is later and was written with the operator. Where they disagree on *current code behaviour*, the code and [`VOICE-MODE.md`](./VOICE-MODE.md) win.

### Source corpus (all in this folder unless noted)

| File | What it contributes |
|---|---|
| [`VOICE-ORCHESTRATOR-FEASIBILITY.md`](./VOICE-ORCHESTRATOR-FEASIBILITY.md) | The frozen original intent (2026-09-10) and the two-axes correction (relay vs worker role) |
| [`VOICE-MODE-INTENT-RESEARCH-2026-09.md`](./VOICE-MODE-INTENT-RESEARCH-2026-09.md) | Two weeks of fixes read as intent: the nine non-negotiables, the fluency spec, what the defect record reveals |
| [`VOICE-AGENT-PRICING-RESEARCH-2026-09.md`](./VOICE-AGENT-PRICING-RESEARCH-2026-09.md) | Native S2S economics, the Gemini 3.8 Live launch facts (§8), and the gap analysis (§9: the missing "ambient" clause) |
| [`VOICE-LIVE-MODEL-EVALUATION-LAB-ARCHITECTURE.md`](./VOICE-LIVE-MODEL-EVALUATION-LAB-ARCHITECTURE.md) | First answer to "how would a lab give a voice model its inputs without a human"; evidence levels; adapter contract; measurement families |
| [`VOICE-MODE.md`](./VOICE-MODE.md) | Normative description of what is shipped today |
| [`TALKER-MODEL-REQUIREMENTS.md`](./TALKER-MODEL-REQUIREMENTS.md), [`plans/DRIVE-MODE-TWO-LANE-PLAN.md`](./plans/DRIVE-MODE-TWO-LANE-PLAN.md) §1–2, §10 | The talker seat's requirements; the intent table I1–I18; the mechanical/instructed layering (§10.9) and the small-model finding (§10.8) |
| `/root/agent-benchmarks/benchmarks/02-orchestrator-governance/` | **Benchmark 2** — the orchestration benchmark whose tasks the operator wants reused |
| `/root/agent-benchmarks/benchmarks/03-voice-relay/` | **Benchmark 3** — the text-model talker benchmark that selected Gemma; its scripted-worker shape and hard-fail gate |

---

# Part I — Intent

## 1. What exists, in one paragraph

Voice Mode is a **two-lane** surface. The **worker** is an ordinary Pi / Claude / Antigravity session (which may itself orchestrate children over the Internal API, or just code). The **talker** is a separate, server-side, rule-bound harness (`server/src/talker/`) driving a small fast text model (Gemma 4 26B A4B via OpenRouter) through a cascade: OpenAI STT → talker → OpenAI TTS. The talker converses, answers from a bounded state view, holds the operator's words as a draft, and relays them to the worker only after a **mechanical** confirmation gate — the model has no send path, the relay text is always the operator's own words by id, and every ack is a fixed string produced after the delivery outcome is known. One talker serves one worker; up to three lanes in one tab; reading levels (Verbatim / Summary / Headlines); an audio regression lab measures rendered output. It was built in roughly two weeks (2026-09-02 → 16) by many agents and it **works**.

## 2. The operator's dissatisfaction, in their own terms

Recorded 2026-09-16:

> "It does work, but it is not very dynamic in terms of the responses and it's not very much like having a real conversation. It's more like having a voice agent telling me updates every now and then — not very dynamically, and it's not much of a conversation. It's of course a multi-turn process anyway — being able to relay prompts via that talker agent to the worker."

Two distinct complaints are folded into that:

1. **Interaction class.** Tap-to-talk, STT round-trip, text model, TTS round-trip. No VAD, no endpointing, no true barge-in, no proactivity. The gap analysis (pricing research §9.3 A, F, G, K) already names this: the surface *answers when addressed*; a 2026 voice agent *notices, interrupts, and works without a screen*. The cascade cannot structurally reach sub-second turn-taking.
2. **Conversational register.** The talker is deliberately a "switchboard with manners": strict rules, restate-and-ask, fixed acks. That was the right answer for a weak-reasoning, fast model whose job was to *not* paraphrase. It reads as a relay, not a colleague.

The operator values what was built (§3) and does not want to lose it; the question is whether a materially stronger native voice model lets the *same intent* be met with a *less rigid* harness and a *more conversational* surface.

## 3. Why the current design looks the way it does (the history that must not be lost)

The rule-bound design is not a preference; it is a **workaround for two beliefs the operator held when it was designed**, both now in question:

**Belief 1 — native voice models were too expensive.** True for most of the market (pricing research §5: GPT-Live-1 ≈14×, Grok / ElevenLabs ≈22× the current ~$13/month stack). The operator does not want that. Gemini 3.1 Flash Live was the exception at ≈1.7–2.5×, and **Gemini 3.8 Live (launched 2026-09-15) has identical rates** ($3/1M audio in, $12/1M audio out; free tier on both variants), so the Gemini route is now cost-competitive with the cascade.

**Belief 2 — native voice models could not reason well enough to orchestrate.** Empirical: the operator drove Codex threads by voice through ChatGPT Voice (GPT-Live). Speaking to it was very fluent, but as an orchestrator it:

- **made mistakes orchestrating** — "not enough reasoning for that job";
- **wrote long prompts to children that left details out** — it expanded and re-planned rather than transmitted;
- **did not follow the small rules** that mattered ("the rules that I have just said, these small things, but that actually mattered quite a lot");
- **acted on unfinished thoughts** and paraphrased before forwarding (feasibility record §1, §4).

The two-lane design is the direct response: put the reasoning in a worker that *can* orchestrate; make the voice layer a **fidelity-preserving relay** with a mechanical gate so the model cannot twist words or act early; pick the voice model for **latency** (Gemma won a 600-point deterministic benchmark; GLM 5.3 Flash was rejected at ~5 s TTFT). The operator's summary: *"It was our way around the trouble with voice agents, and the price with voice agents, and the trouble with their reasoning capabilities."*

**What has changed:** Gemini 3.8 Live debuts with a standard variant (Arena Elo 1,083 #2, TSR 93.2% #2, TTFA 1.18 s, conversational dynamics 96.1%, τ-Voice 30.1%) and an **Extended Thinking** variant (S2S Index #1 at 82.6, τ-Voice 68.6% #1, Big Bench Audio 97.7%, Elo 990, TTFA 1.35 s), both Gemini 3 Pro lineage, both with async function calling, both at the 3.1 Flash Live price. The operator's reaction: the standard model *"would probably be a bit overkill for the current harness"*, and the ET variant *"brought new thoughts about the possibilities"* — specifically, whether a live model has reached the reasoning level at which it could **be** the orchestrator.

## 4. The standing intent that any redesign must still satisfy

These are carried forward unchanged. A native-model design that drops any of them has changed the product, not improved it.

### 4.1 The four goal clauses (canonical, 2026-09-10) plus the fifth (2026-09-16)

1. **Talk fluently while tools run.** A reasoning worker takes minutes; the conversation must never block on it.
2. **Very high intent fidelity.** The worker receives the operator's intent, not a re-planned version.
3. **Never act on an unfinished thought.**
4. **Use quota the operator already has** — and, restated today: *no order-of-magnitude cost increase*. Gemini-class pricing is acceptable; Grok / ElevenLabs / GPT-Live class is not.
5. **It must work when hands and eyes are busy** (gap analysis §9.2) — ambient, proactive, screen-free. This clause was never written into the original intent and is the biggest thing the current surface lacks.

### 4.2 The non-negotiables (intent research §3, N1–N9) — reinterpreted for a native model

| # | Rule | Holds under a native model? |
|---|---|---|
| N1 | Relay gated by **code**, not the model | **Yes, unchanged for tiers 1–2.** The live model may propose; it may not send. For tier 3 (§6.3) the gate moves: the model *is* the actor, and the gate becomes "what may it do without asking" — an allow-list of tool calls plus a confirmation protocol, still enforced by the host, never by the model's own report of consent. |
| N2 | Relay text is the operator's **own words**, semi-verbatim | **Yes, but it has a cost:** a native S2S session has no text of what the operator said. An input-transcription lane must be kept purely for the draft/evidence path — STT is *demoted from the interaction path to the evidence path*, not deleted (pricing research §9.4). For tier 2 the operator is explicitly willing to relax word-for-word relay (§6.2); N2 then becomes a *measured* quality (fidelity score), not a mechanical guarantee. |
| N3 | Never act on an unfinished thought | Yes. Native VAD/endpointing makes this *harder*, not easier: "yes … actually no" must never release on a partial transcript. |
| N4 | Conversation first; questions answered from state, nothing dispatched | Yes. |
| N5 | Operator speaking is never interrupted; audio **ducks**, never hard-stops; capture unconditional | **Open.** Google's Live VAD cancels generation on interruption and expects the client to flush playback. The lab must keep two explicitly separate profiles (lab architecture §8.2) and the operator decides which contract survives. |
| N6 | Honest delivery: fixed acks after the outcome; never claim the worker finished | Yes. Receipts stay trusted audio (pre-synthesised or TTS), never the live model's paraphrase. |
| N7 | Allow-list, not model judgement; classifier mechanical | Yes for tiers 1–2. Tier 3 replaces the utterance classifier with a tool allow-list. |
| N8 | Never widen the gate's reachability | Yes — and tier 2/3 are *deliberate, labelled* widenings for measurement, not a production change. |
| N9 | Failures visible, never silent | Yes; the `voiceTurnId` vocabulary extends to native audio events rather than being overloaded. |

### 4.3 The fluency and recovery behaviours the operator has paid for (intent research §5–§6)

Reading levels with mid-answer flips ("In short:"), short-turn verbatim, never-say-twice, stop-talker as playback-only, drafts that survive interleaving, the talker seeing earlier worker turns, a request *to the talker* answered rather than relayed, "green means delivered", the original wording always sendable, bookkeeping never spoken. A native model does not get these for free — Verbatim/Summary/Headlines are *application promises*, not voice styles (lab architecture §8.3).

### 4.4 The anti-goals (what the design exists to prevent)

Paraphrase before forwarding · acting on unfinished thoughts · confabulated action ("I've sent that") · over-asking · long-winded re-planned child prompts · rule-following that decays under conversational pressure ("just do it, stop asking") · silent failure. The Artificial Analysis caveat is the operator's own observation restated: *a preferred conversation does not always result in successful task completion.*

## 5. The new intent: what the operator wants to find out

> "I would like to do a thorough testing and benchmarking of that model … for me it's worth it to also test what kind of level of harness would be optimal for this model if we were to adopt it and if it's as capable as it is said."

Three questions, in order of ambition:

1. **Drop-in:** if the cascade is replaced by Gemini 3.8 Live *inside the existing contract*, does the conversation become materially more dynamic without losing fidelity, honesty, or the gate?
2. **Relaxation:** how much of the rule scaffolding was a workaround for a weak talker, and how much is genuinely load-bearing? What is the *least* harness that still meets §4?
3. **Collapse:** is a live model now capable of being the orchestrator itself — the voice layer and the reasoning layer being the same model — on the operator's real orchestration tasks?

And the meta-question that makes this a lab rather than a rebuild:

> "Without implementing it fully as a replacement I find it hard to test. Is there a possibility for us to create a test harness … that would allow us to test a voice model inside our harness without human in the loop?"

**Constraint: minimum, ideally zero, human in the loop during runs.** The operator's voice, ears and attention are not part of the measurement. Human involvement is allowed at design time (scenario authorship, rubric) and *optionally* afterwards (listening to retained clips). Human preference is not thereby measured and must not be claimed (lab architecture §1).

## 6. The three benchmark tiers the operator specified

All three reuse **Benchmark 2's task material** (§7) as far as each tier's shape allows, because those tasks are *"very realistic to what the tasks from my line of work would actually be"*. The tiers are a ladder of decreasing harness and increasing model authority. They are experiments, not product proposals.

### 6.1 Tier 1 — "the current harness, minimum stack replaced"

- **Replace:** OpenAI STT (interaction path), the Gemma talker model, OpenAI TTS, the digest model calls → **Gemini 3.8 Live, standard variant** (not ET: *"we wouldn't need a stronger reasoning model at all; latency would be more important, and the natural way of talking"*).
- **Keep everything else:** one talker ↔ one worker; the mechanical gate; the utterance classifier; the draft store; semi-verbatim relay by id; fixed acks; reading levels; the speech ladder; *"the maximum amount of rules we've created still attached"*.
- **Kept out of necessity (§4.2 N2):** an input-transcription lane as the authorisation/evidence side-channel. Whether that is Gemini's own input transcription (shadow only, never authorisation) or the independent STT is a Part II decision; the conservative first run keeps the independent STT.
- **What it measures:** conversational dynamics gain (TTFA, turn-taking, barge-in, repair) against the Gemma cascade on matched inputs; whether the gate, fidelity and honesty survive a model that is *proactive by default* (proactive audio cannot be disabled on 3.8 Live); reading-level compatibility; cost.
- **Expected shape of the answer:** "overkill or not" is the wrong frame; the point is whether a stronger model *inside* the strict contract already feels like a conversation. If it does, tiers 2–3 are about authority, not fluency.

### 6.2 Tier 2 — "one worker, rules stripped"

- **Same attachment:** still one worker at a time, switchable by the operator (as lanes are today).
- **Strip most or all rules:** no word-by-word relay requirement; the model may reason about what the operator means, decide *when* to relay, compose or condense; it may be *guided* to ask for confirmation before sending, but the harness does not force restate-and-wait on every instruction.
- **Test both variants:** standard and Extended Thinking (low / medium / high), to see whether reasoning changes fidelity and rule-holding, and what it costs in latency and likeability (AA: ET gives up ~93 Elo of preference for +38 points of τ-Voice).
- **What it measures:** the fidelity cost of letting the model own the relay text (the GPT-Live failure, re-tested on a better model); whether "asks when it should, doesn't when it shouldn't" can be *instructed* rather than *mechanised*; whether the operator's small rules survive pressure without a mechanical backstop.
- **Design note for Part II:** this tier needs a new, deliberately lean harness variant, not a stripped copy of `TalkerSession`. Its release path must still be *recorded* and *guarded* (a sandbox delivery sink), so that an unauthorised send is a measured finding, not a real-world effect.

### 6.3 Tier 3 — "above them all: the model is the orchestrator"

- **No single-worker attachment.** The operator (simulated) talks to the model; the model creates or adopts sessions over the Internal API, briefs children, gates phases, waits reactively, routes defects, restarts the mock service, and reports — the Benchmark 2 parent role, held by the live model itself, living in its own session as the parent.
- **Test both variants**, expecting ET to be the serious candidate (*"maybe the extended thinking would be enough to actually skilfully orchestrate"*), standard as the control.
- **What it measures:** Benchmark 2's six dimensions verbatim (gating precision, queue management, defect routing, zero-token waiting, restart coordination, milestone communication) plus the voice dimensions (fidelity of child briefs vs the owner's words, rule-following, honesty, latency of spoken responses while tools run, cost, session-lifetime survival).
- **Why it matters:** this is the "orchestrator and voice mode are the same" hypothesis. If it holds at acceptable cost, the two-lane design's *reason to exist* changes; if it fails the way GPT-Live failed, that is decisive evidence the two-lane design is correct and tier 2 is the ceiling.

### 6.4 What the tiers isolate

| | Voice model | Harness | Worker(s) | Model authority |
|---|---|---|---|---|
| **Baseline** | Gemma cascade | current | one | none (proposes only) |
| **Tier 1** | 3.8 Live std | current | one | none |
| **Tier 2** | 3.8 Live std / ET | lean, instructed | one | composes and times the relay; host still records and guards the send |
| **Tier 3** | 3.8 Live std / ET | tool allow-list | many, real (disposable) | orchestrates through Internal API tools |

Tier 2 is bracketed by tiers 1 and 3. Part II should consider running 1 and 3 first: if 3 succeeds, 2 is of academic interest; if 3 fails, 2's design should be informed by *how* it failed.

## 7. Benchmark 2 as the task substrate (what to reuse, what changes)

**Benchmark 2** (`/root/agent-benchmarks/benchmarks/02-orchestrator-governance/`) is the operator's orchestration benchmark — not Benchmark 3, which is the text-talker selection benchmark that chose Gemma. Its shape:

- `setup_fixtures.sh` creates an isolated run dir with `repo-core/`, `repo-tools/`, a controllable `mock-service/`, and a manifest.
- `run_orchestrator_benchmark.sh` creates the parent session over the Internal API, sends the **initial brief** (two children, phase-gated, child invariant `zai/glm-5.3-flash` at high/max thinking, mandatory skills, zero-token waiting), then hands off to `simulator/supervisor.py`.
- The supervisor watches repo state and injects three **owner events** as text prompts: a raw incident alert (defect → route to the context holder), a new queue task (feasibility report), and a service-restart request (verify idle → restart → health).
- `score_orchestrator.py` is deterministic: repo commits, test suites, `state.json` restart count, and transcript regexes → six dimensions, 600 points, EXCELLENT/GOOD/NEEDS_IMPROVEMENT.

**Reuse:** fixtures, events, scorer, run manifest, child invariant, quota rules. **What changes per tier:**

- **Tier 3:** the four owner text prompts become *spoken* owner utterances (synthesised, paced). The candidate's tool surface is the Internal API. The scorer runs unchanged on repo state; a voice-side scorer is added.
- **Tiers 1–2:** the *worker* holds the Benchmark 2 parent role (a strong text model, as today), and the voice model relays. The owner's spoken turns are the same four events plus **conversation around them** — status questions, thinking aloud, a mid-thought correction, pushback on the gate, a request to the talker rather than the worker, a permission question from the worker — because tiers 1–2 exist to measure conversation, not orchestration. Benchmark 3's five scenarios (`s1`…`s5`) are the vocabulary for those turns.

Open for Part II: whether tiers 1–2 use a **real** disposable worker running Benchmark 2 (realistic, slow, expensive, non-deterministic) or a **scripted** worker fixture (hermetic, cheap, comparable — Benchmark 3's approach and the lab architecture's §6 recommendation). The operator's stated intent leans real; the measurement discipline leans scripted first, real as a later lane.

## 8. Operator preferences and constraints that bound the lab

- **Cost envelope:** Gemini-class per-token pricing is acceptable; both 3.8 Live variants are on the free tier today. A run costs cents to low dollars; children on existing GLM quota. Respect the GLM peak window (Mon–Fri 07:00–11:00 London) and the 07:00–11:00 UK expensive-window rule for autonomous work.
- **Isolation:** disposable validation server (`npm run validate:server`), isolated `PI_CODING_AGENT_DIR` and prefs, never the operator's live sessions, never production validation. No real transcripts, private files or the operator's voice leave the host as benchmark material.
- **Finnish:** nice-to-have, not a requirement (operator decision 2026-09-16). Record it as a condition, do not gate on it.
- **Evidence discipline:** mechanical assertions (gate, byte fidelity, delivery receipts, repo-state scoring) before any model judge; the candidate is never its own operator, transcriber and judge; immutable per-attempt records; separate model / integration / policy / environment failures; no composite score that can hide an authority violation.
- **Ways of working:** TDD; prove the measuring equipment on damaged traces before trusting a green; background execution with result files, not polling loops; Telegram milestones; commit and push on master.
- **What is on the host already:** `GEMINI_API_KEY` in `~/.bashrc`; `@google/genai` in `node_modules`; Google auth in `~/.pi/agent/auth.json`; local Supertonic TTS (`scripts/audio-lab/tools/supertonic-batch.py`) for synthesising the operator's speech offline; the audio lab's isolation/recording/verification tooling; `createNullDelivery()` and the `TalkerModelClient` / `WorkerDelivery` seams; Benchmark 2 and 3 assets.

## 9. What a successful lab lets the operator say

Independently, per tier and per variant:

- "Conversational dynamics improved by *this much* under *these* conditions" (paired, with sample counts).
- "The gate / fidelity / honesty / reading contracts passed, failed, or were not exercised."
- "The least harness that still met §4 was tier *N* with rules *X, Y, Z* retained."
- "As an orchestrator on Benchmark 2 the live model scored *S* at cost *C* with *these* failure modes" — directly comparable with the text-model leaderboard.
- "This failure was the provider's / our policy's / an integration defect / a bad fixture / the environment."
- "Worth a guarded product experiment" / "not worth proceeding" / "insufficient evidence" — and never "better for the operator in real life" from synthetic voices and model judges alone.

---

# Part II — The lab

> **Reserved.** To be written after the shape is agreed with the operator. It will cover: giving the voice model its inputs without a human (synthetic operator, three driver modes, timing as input); the two-timeline scheduler; the worker world per tier; the authority boundary per tier; the Gemini Live adapter; the Benchmark 2 integration per tier; the voice-side scorer; run records, budgets and unattended operation; evidence levels and what each may claim; a TDD-ordered build plan with quality gates and live validation. The [lab architecture note](./VOICE-LIVE-MODEL-EVALUATION-LAB-ARCHITECTURE.md) is the starting material and is not repeated here.
