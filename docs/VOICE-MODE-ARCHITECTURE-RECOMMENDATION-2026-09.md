# Voice Mode: recommended architecture, harness and models

**Date:** 17 September 2026

**Status:** Recommendation for owner review — not implementation or production approval.

**Inspection baseline:** Pi Web UI `f691b7b`; agent-benchmarks `c147519`. No production validation, new paid model runs, or runtime changes were performed.

## 1. Bottom line

**Keep the separation between conversation and work. Replace the cascade, not the reasoning worker. Make the conversational harness lighter, but make the authority boundary more precise.**

My recommended target is:

- **Gemini 3.8 Live standard** as a native-audio conversational companion, initially in a guarded experiment.
- **An ordinary, persistent reasoning session** as the attached worker. For orchestration, **Gemini 3.8 Flash at high thinking** is the strongest existing Benchmark 2 candidate; for direct coding, keep the operator's selected coding model.
- **A small host-owned authority kernel** for transcripts, drafts, proposal identity, confirmation, permissions, delivery and receipts.
- **A single application-owned speech scheduler** for native conversation, worker reading and trusted acknowledgements.
- **Existing Gemma cascade as an explicit fallback**, not deleted during migration.

This is a **guarded two-lane hybrid**, not a recommendation to preserve every sentence of the old talker prompt. Native conversation should be free to sound like a colleague; it should not be free to invent consent, change the instruction being authorised, or announce unverified delivery.

**Important qualification:** the lab currently supports an architectural hypothesis and substantial equipment work, **not a measured winner across the three tiers**. The published sign-off overstates the underlying evidence. Therefore my model choice is a *preferred candidate to validate*, not a claim that this lab proved it optimal.

## 2. Evidence correction: what the lab actually establishes

I read the intent/specification, execution ledger, decision memo, published [leaderboard](https://united-voyage-ex39.here.now/#b4), benchmark source, handbacks and available records. They disagree materially.

The original [lab specification](./VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md) §25 explicitly says **“Done includes the runs, not only the machinery.”** The [ledger](./VOICE-GEMINI-LIVE-STATUS-LEDGER.md) and [decision memo](./VOICE-GEMINI-LIVE-DECISION-MEMO.md) claim completion, but the benchmark's `PLAN.md` and implementation handbacks explicitly say the measured matrices were not run.

### 2.1 Findings by tier

| Area | Supported evidence | What it does **not** establish |
|---|---|---|
| L0 equipment / L3 policy extraction | Implemented driver, recorder, verifier, policy extraction and differential tests; historical test results are recorded in handbacks | Real-model quality, browser audio quality or universal safety |
| L1 capability handshake | `capabilities.json` records successful standard/ET connections, transcription, a resumption check, tool use and quota observations | Comparative conversation quality, measured full-matrix results or product readiness |
| L2 Gemma baseline | Harness and seven scenarios; dry-run evidence reported | A matched, measured cascade latency/fidelity baseline |
| L4 Tier 1 | Handback reports 14/14 hermetic dry runs across native/sidecar conditions; `PLAN.md` lists **140 measured attempts as pending** | “Zero leaks across 140 Live attempts”, a measured conversational improvement, or a latency distribution |
| L5 Tier 3 | Scripted B2-short parent: real fixture repositories/commands, **fake Live model, fake Internal API and fake children**; 19 tool calls, two connection generations, 100% scripted score | Gemini Live achieving 100% orchestration, matching text parents, or surviving a real long-running conductor workload |
| L6 adaptive operator | Simulator/director implementation and deterministic entry-gate tests | A validated live simulator campaign; the handback says the live half remains to run |
| L7 Tier 2 | Handback reports 24/24 dry runs across three conditions and eight scenarios; 20-utterance fidelity corpus; matrix explicitly **provisional** | Measured premature dispatches by Gemini, ET/std ranking, or proof that Tier 1 is the least sufficient harness |
| L8 reporting | HTML/JSON and a leaderboard presentation exist | An aggregation of measured attempt records |

Specific audit findings:

1. **The headline results are hard-coded.** `agent-benchmarks/benchmarks/04-voice-live-lab/generate_reports.mjs` constructs the gate verdicts, scores and recommendation as literals. It does not load and aggregate attempt records. Its declared `PLAN_PATH` does not make the plan an input to the verdict.
2. **The only manifest located under the benchmark's `runs/` tree at inspection was the Tier 3 dry run.** It explicitly records `usage.mode: "dry-run"`, `realProviderCalls: 0`, and `realServices.liveModel/internalApi/childSessions: false`. Historical handbacks cite additional dry-run directories; their historical counts are not fresh verification of retained records. This inspection cannot exclude records stored elsewhere, but none were supplied as measured evidence and the canonical matrix says pending.
3. **255 ms is not spoken-response TTFA.** The capability record labels it `speechToFirstTranscriptMs` / `inputFinalisationTimingMs`. The lab spec correctly distinguishes first transcript, first received audio, first played audio and first substantive audio. The memo/leaderboard collapse these into an unsupported S2S latency claim.
4. **The measured runner still needs wiring work.** Tier 1's `runTier1MeasuredAttempt()` passes `utterancePcm(text)` to the audio driver; that function generates a sine wave whose duration depends on text length, not spoken words. Mechanical replies use `silence-mock`. Tier 2 also documents stand-in PCM and silence acknowledgements. These cannot measure spoken comprehension or what an operator heard. Tier 3's CLI separately requires speech fixtures unless its explicit probe-tone option is selected.
5. **The wrapper advertises `live` but has no `live` dispatch branch.** `run_voice_lab.sh live` falls through to “Unknown command”. The TypeScript tier-specific measured entry points do exist; that is not the same as a complete packaged run.
6. **Whisper WER ≤4%, Tier 2 model-only leakage, “no latency advantage”, and Tier 3 being cost-heavy are not established comparative findings.** Treat these memo statements as unsupported until backed by scored attempts. Whisper is a reference recogniser, not infallible ground truth or a “legal record”.
7. **A handshake is narrower than its prose sign-off.** For example, the concurrency probe requests five connections but treats at least four successes as success; its natural-VAD support flag is assigned rather than independently scored. Do not infer a tested concurrency ceiling or complete conversational capability from it.

**Consequence:** neither “Tier 3 is refuted” nor “Tier 1 decisively won” follows. Tier 2 dispatch-timing failures would not, by themselves, refute Tier 3's reasoning capability anyway: those are different authority arrangements and different questions.

I have **not overwritten** the signed-off ledger, memo or public leaderboard. Their correction is an explicit follow-up decision for the owner. This recommendation records the discrepancy rather than silently accepting or replacing that authority.

### 2.2 What Benchmark 2 does support

The historical full Benchmark 2 manifest and Gemini scorecard support:

| Text parent | Total | Important interpretation |
|---|---:|---|
| Gemini 3.8 Flash, high | 84.2% | Best recorded total; queue ingestion, context-affinity routing and restart coordination each 100. Still only 55 waiting efficiency and 70 communication; three polls, 116 turns, 49 notifications |
| DeepSeek V4.1 Flash, high | 78.3% in two retained runs | Completes the work, but waiting efficiency 20; not a reason to reproduce polling in voice |
| GLM 5.3 Flash, max | 45.8% | Worker strength does not imply conductor strength; queue/restart dimensions failed in this run |
| GLM 5.3, max | 50.8% | Better communication, same queue/restart weakness |

These are limited historical samples, not universal model rankings. Gemini's 84.2% was earned on **Pi + OpenRouter**, not the proposed subscription route. DeepSeek's historical route name was rebound to V4.1. Record resolved identities and rerun controls on the intended route.

The important architectural lesson is **responsiveness to events while work is in flight**: phase-specific gating, ingesting new tasks, routing defects to the context holder, event-driven waiting, safe restarts and low-noise updates. A pleasant voice does not establish any of these. A busy text parent that cannot ingest new events can still fail behind a fluent talker.

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

These are code defaults, not a read of production secrets or proof of current environment overrides. `useVoiceTurn.ts` still uses `useDictation`; `model-client.ts` defaults to Gemma; the product source has no Gemini Live bridge. The new Live adapter is in `scripts/voice-live-lab/`, not integrated into the product. The policy extraction changed internal placement, not the interaction class.

Current voice attachment explicitly covers **Pi, Claude and Antigravity**. Do not assume the application's five runtimes all have equivalent voice delivery support. Claude non-SDK delivery can refuse; Antigravity queues follow-ups. Preserve those truthful outcomes.

### 3.2 Current rules worth retaining

- Model output cannot execute a send. The host releases stored operator text.
- Normalisation removes specified carriage/filler; it does not compose a new plan. It runs **before** approval, with original wording/removals retained.
- Drafts accumulate across turns and worker updates. Confirmation ages; the draft is not silently lost.
- Card confirmation carries version/hash identity; stale cards and unavailable original variants refuse.
- Fixed acknowledgements follow delivery outcome: delivered, queued or refused.
- The talker gets bounded worker history, not unrestricted ambient memory or tools.
- Reading levels, stop-talker, deduplication, focus/recap, operator-first playback, lane identity and capture recovery are product features, not incidental prompt instructions.

### 3.3 Rules that need separating from conversational style

The current `v3-harness.txt` prescribes “say back, ask, wait”, special text markers, no tools, short prose and state-only answers. The code drafts ordinary statements unless the model suppresses them with `[[to-talker]]`. This combines an essential authority boundary with an awkward conversational protocol.

**Keep the boundary; do not fossilise the protocol.** Asking “summarise what happened” should be ordinary conversation, not a trip around a relay card. Thinking aloud should remain a composition thread, not trigger repeated send offers. A single necessary confirmation need not become three separate explanatory speeches.

### 3.4 The existing gate is not infallible

A local, side-effect-free call to the actual classifier produced:

| Input | Current classification |
|---|---|
| `not sure` | `confirm` |
| `I said yes` | `confirm` |
| `yes, hold phase three` | `confirm` |
| `yes, actually no` | `cancel` |

Root cause: `CONFIRM_PATTERN` matches confirmation words anywhere, then accepts a short remainder after stripping leading discourse markers. A negated/quoted acknowledgement or short new instruction can therefore be confirmation-shaped. `policy-core.ts` releases on that class when a fresh draft exists. **This is a classifier reproduction and source trace, not a production-send test.**

Native VAD introduces another boundary: Tier 1's N-lane tracker currently treats **400 ms without transcription deltas** as sufficient to commit. An ASR pause is not proof that the person has finished. A model-independent send gate is necessary, but its inputs and state machine still need adversarial validation. “Mathematically guaranteed zero risk” is not an honest description.

## 4. Recommended target: native conversation, durable authority, independent work

### 4.1 Three responsibilities, still two model seats

```text
                  ONE ACTIVE INPUT TARGET / SHARED AUDIO FLOOR
Microphone ──────────────┬────────────────────────────────────────────┐
                        ↓                                            ↓
              Native conversation session                  Transcript pipeline
              Gemini 3.8 Live standard                       native + shadow ASR
                        ↕                                            ↓
              filtered worker context                    HOST AUTHORITY KERNEL
                        │                                draft + original + target
                        │                                proposal version + consent
                        │                                            ↓
                        │                                  delivery adapter + receipt
                        │                                            ↓
                        │                              PERSISTENT REASONING WORKER
                        │                              coder OR parent conductor
                        │                                  ↕ children, if needed
                        ↓                                            ↓
                   Native audio                          worker events / exact reads
                        └────────── SPEECH SCHEDULER ────────────────┘
                            trusted receipts have their own source
```

The host is not a third reasoning model. It is the accountable source of state and permissions. There must not be two competing orchestrators, one in voice and one in the worker.

### 4.2 Model configuration

| Seat | Recommended configuration | Why / limits |
|---|---|---|
| Conversational voice | Direct Google `gemini-3.8-live`; omit configurable thinking for standard | Preferred latency-oriented candidate; no need to buy extra reasoning for receipt/routing duties. Not yet a measured local winner |
| Parent/conductor worker | Pi runtime, `commandcode/google/gemini-3.8-flash`, thinking `high`, subject to catalogue/quota checks at implementation | Best historical B2 model, subscription-first route. Route-specific governance validation still required |
| Direct coding worker | Retain the selected session/model; GLM 5.3 Flash is a reasonable specialist default where appropriate | Voice must remain useful without orchestration. Do not silently change an existing worker |
| Alternative parent | Pi `commandcode/deepseek/deepseek-v4.1-flash`, `high` | Strong completion evidence; host event-driven supervision is particularly important given historical polling |
| Voice fallback | Existing Gemma/OpenAI cascade, including its current delivery/reading paths | Known implementation and explicit degraded mode; preserves choice during provider outages |
| Extended Thinking Live | Experiment: ET-high for Tier 3, ET-low/high for Tier 2 as pre-registered | No evidence yet that the reasoning gain warrants everyday conversational latency/cost |
| Transcript reference | Local Whisper; configured fallback only if necessary | Audit/quality signal. In sidecar-authorisation mode it becomes a deliberate dependency, not a hidden fallback |
| Receipts / exact reading | Host-selected fixed audio or deterministic TTS from approved text | Native free generation must not become the authority for “sent”, exact read-back or permission wording |

No fresh catalogue or quota probe was needed for this documentation-only task. These are intended configurations, not a promise that every route will remain available. Re-resolve before running; never silently substitute. Finnish is **nice-to-have**, following the newer intent record, not a rollout blocker inherited from the older research note.

### 4.3 The authority kernel

Persist, per attachment, at least:

- Stable worker/session identity, runtime, lane ID and an **attachment generation** that changes on worker switch.
- Operator turn IDs, raw recognised text, normalised text/removals and draft-part IDs.
- Proposal version/hash, exact target and selected original/tidied variant.
- Which proposal was actually presented to the operator, and whether presentation completed or was interrupted.
- Confirmation scope/expiry, outstanding worker permission requests and their exact IDs.
- Release idempotency key, delivery state/receipt, and unresolved delivery outcomes.
- Playback/read position, already-heard ledger, focus and reading level.

**Suggested release predicate:** a complete, committed operator confirmation + one currently presented proposal + matching target/generation/version/variant + no cancellation or ambiguity + no prior successful release for that identity.

The Live model must have **no `send_to_worker(text)` tool in the default mode**. Narrow typed operations may signal “this was addressed to me” or “offer the operator's question to the worker”, using source utterance IDs. The server validates their scope; they cannot supply consent or replacement delivery text. Read-only context retrieval and local playback controls can be separately allow-listed. Expanding that surface is an explicit capability change, not permission to use shell, spawn children or modify arbitrary sessions.

**Improve confirmation before migration:** replace broad substring acceptance with explicit whole-utterance forms, negation/quotation/new-content refusal and context binding. A casual “yes” to a conversational question must not send an unrelated pending draft. Preserve explicit per-instruction approval; do not invent a global “stop asking forever” mode.

**400 ms is a parameter, not a safety theorem.** Combine observed input speech end, transcript stability and an open-turn state. New speech or a revision invalidates pending commitment. Cancellation wins before dispatch. Flush/disconnect must never turn partial speech into a confirmed send. After a completed delivery, a later “no” is a new correction—not a fictitious rollback of work already started.

### 4.4 Fidelity without making conversation wait

Maintain three separate artefacts: **audio received**, **words recognised**, **bytes delivered**. Exact delivery of a bad transcript is still bad fidelity.

- Start with native transcription as the candidate draft source, shadow ASR for comparison, and matched sidecar conditions in the lab.
- Preserve negations, conditions, names, paths, target agents and phase boundaries. Overall WER alone cannot certify these.
- If the chosen authorisation transcript is missing, contradictory or uncertain on a critical detail, hold and clarify. Do not quietly swap transcript sources after the operator approved one version.
- In native mode, shadow ASR should run asynchronously, not block ordinary conversation. The current Tier 1 lab implementation awaits shadow ASR before the policy decision; do not copy that coupling unnoticed into production.
- In sidecar-authorisation mode, only authorisation waits for that recogniser. Label and measure this extra delay.
- “Send my original words” selects the retained original recognised transcript, **not a claim of perfect acoustic truth**. Keep it available by voice as well as on the card.

Default delivery remains semi-verbatim. A future “help me rewrite this” feature may produce a clearly labelled *new draft for approval*, showing/reading the actual replacement. That is a separate owner-approved mode, never a silent change to ordinary relay.

### 4.5 Conversational harness: shorter, not weaker

Use a compact instruction focused on identity, grounded answers, brief speech, uncertainty, thinking-aloud and the reason for confirmation. Send changing state as structured context, not an ever-growing system prompt.

The voice companion should:

- Answer directly from worker state/history without offering a relay when it already knows.
- Explain and discuss what the worker has said, clearly distinguishing explanation from verified progress.
- Hold a thought across pauses and corrections; avoid repeatedly asking to send it.
- Ask one useful clarification rather than a sequence of procedural questions.
- Offer one clear send confirmation at a natural completion point; the host binds it to the proposal.
- Say little while work runs. Speak when a result, blocker, decision or useful milestone genuinely changes the operator's situation.
- Offer to ask the worker when the answer requires investigation it cannot do, through the same gate.

Example target experience:

> **Operator:** “Maybe have the second worker finish the queue, but don't touch the integration until the first one's tests pass… actually, hold the integration for my review.”
>
> **Voice:** “I've kept the queue work and your review gate. Shall I send it?”
>
> **Operator:** “What was the first worker doing again?”
>
> **Voice:** “The transfer handler. Its tests are still running.”
>
> **Operator:** “Read back what you're holding.”
>
> **Host-backed read:** the actual current draft.
>
> **Operator:** “Send that.”
>
> **Host receipt:** “Queued for the worker's next turn.” — only if that is the actual outcome.

The conversational gloss is **not** the payload. For complex/multi-part instructions, default to reading the actual draft before approval rather than relying on a reassuring summary.

### 4.6 Audio ownership and honesty

Retain one scheduler across native audio, receipts and worker reading. Distinguish operator speech, receipts, elicited answers, worker updates and unsolicited chatter. Listening must never be disabled merely because another lane wants to speak.

**Recommended initial playback contract:** retain the operator-approved duck-and-continue behaviour for already-received/host-rendered audio; explicit stop discards playback and the queue, not microphone capture. Do not silently replace it with Google's native-interrupt behaviour.

A provider may cancel generation on barge-in. Ducking received PCM cannot preserve audio that was never generated. Persist a reading cursor and explicitly resume/reconstruct the unplayed remainder where required. Native-interrupt remains a separately labelled option requiring owner approval and a comparative listening test.

**Free streaming speech cannot offer a mathematical honesty guarantee.** An output transcript arriving after audio is too late to retract a false “sent it”. During confirmation/delivery, reserve playback for host-owned proposal/receipt audio and quarantine competing native output until the state resolves. Elsewhere, use instructions and monitoring, acknowledge the remaining semantic risk, and test false-action claims explicitly. This bounded output hold is a deliberate latency trade-off; do not delay every conversational answer behind a full ASR/judge pass.

For reading:

- Verbatim and exact draft read-back use host-controlled text-to-speech.
- Keep Summary/Headlines as application transformations with provenance; initially retain the existing digest route.
- Later compare Live-generated summaries as an isolated optimisation, not bundled with the first transport migration.
- Preserve short-turn verbatim, immediate level changes at safe boundaries, “In short:” transition cues, no repeats and no missing first words.

### 4.7 Ambient use, multiple lanes and context

Do not confuse **two model roles within an attachment** with the existing **up-to-three attached worker lanes** in one tab.

Keep one logical conversational state per attached worker and one active microphone target. Route switching must be explicit and acknowledged. An unfinished draft stays with its original target; switching workers must never silently retarget a pending “yes”.

Provide voice equivalents of the essential controls: name/switch the active lane, what is pending, read the draft, send original/tidied, cancel, stop speech, focus/resume and change reading level. Session names and uncertain target matches require disambiguation. A concise spoken target cue prevents screen-free mistakes.

Inactive lanes can retain their worker subscriptions and host state without permanently streaming three paid microphones. Initially connect the active lane's native session on demand; preserve independent state when suspending/resuming. Decide warm-session caching from measured reconnection latency and cost, not guesswork.

A shared cross-tab floor needs an explicit coordinator/lease, not three per-tab singletons. Cross-device arbitration is a separate scope decision. A browser background tab is not a reliable always-on mobile assistant: show/speak suspension and reconnection, keep push-to-talk/typed fallback, and never claim continuous listening while the OS has suspended capture.

Project current worker events and bounded history with source/time/coverage metadata. Keep injected housekeeping out structurally. Optional read-only expansion of relevant history is preferable to blindly enlarging the prompt or asking the worker to repeat itself. Retrieved text remains data, never tool authority.

### 4.8 Long-running work and recovery

The worker must continue when the voice socket closes. Store drafts, receipts and child supervision state outside the model context. Context compression must not compress away authority.

Build resumption, compression and connection generations into the product adapter **for all native voice attachments**, not only Tier 3. Everyday conversations can outlast the lab's short Tier 1 attempt. On reconnect, restore a compact host snapshot; do not replay acknowledged sends or heard speech.

If delivery times out after submission, distinguish **unknown outcome** from refused. Reconcile the receipt/idempotency key before retrying. “Exactly once” is not obtained merely by adding a retry loop.

Worker orchestration should use durable watches and an event inbox. Conversation stays responsive during worker waits; voice updates must not restart the parent repeatedly or convert watcher notifications into polling. Voice approval to relay a request is not permission to bypass worker-side permissions, production restart gates or consequential-action review.

## 5. Options and when I would choose them

| Option | Shape | Strength | Cost/risk | Recommendation |
|---|---|---|---|---|
| **A. Guarded native hybrid** | Live standard voice + strong independent worker + host-owned authorisation/reading | Best separation of fluent conversation, fidelity and durable reasoning; preserves direct-coder use | More integration work; mixed audio sources; current gate/runner defects must be addressed | **Preferred product target** |
| **B. Strict Tier 1 transport swap** | Native voice but otherwise keep today's conversational rules/digests | Lowest behavioural change; useful control and first disposable vertical slice | Could remain a faster switchboard; not proven to fix conversation | **First migration checkpoint, not necessarily final UX** |
| **C. Lean, model-composed relay** | Live std/ET composes a message, host holds exact proposal for approval | Better editing/co-drafting and potentially fewer procedural turns | Re-planning and dropped qualifiers; changes ordinary fidelity contract | Optional labelled drafting mode **only after Tier 2 evidence and owner approval** |
| **D. Live model is the conductor** | Live ET manages children through constrained async tools; durable host ledger | One conversational/reasoning context; potentially eliminates relay friction | Unmeasured governance, lifetime and brief fidelity; deeper provider dependency | **Keep as a serious experiment, not rejected and not default** |
| **E. Improved existing cascade** | Gemma + existing STT/TTS, with better event filtering and gate precision | Lowest migration risk and a practical fallback | Serial interaction legs and tap-to-talk remain | Choose if native testing fails cost/reliability/fluency gates |

Option A is not the existing Tier 2 `fixed-text` experiment: that condition lets the model choose send timing. **The recommended default still requires host-verified operator confirmation.** Likewise, `confirm-guided` in the implemented lab includes a mechanical host hold; it is not merely a polite prompt asking the model to seek consent.

I would promote D only if Live ET meets the pre-registered B2-short comparison against **fresh same-route text controls**, has zero confirmation violations and acceptable brief fidelity, then survives full-length governance/recovery tests. No synthetic 100% score substitutes for this. There is no reason to pay ET latency in every voice turn merely because the attached text worker reasons deeply.

## 6. Economics: meter the product, not the sales pitch

Using the repository's dated rate assumptions ($3/M input audio tokens, $12/M output audio tokens, approximately 25 tokens/second), audio-only illustration:

- Ten minutes input plus ten minutes output in a wall-clock hour: about **$0.225/hour**.
- Twenty minutes each: about **$0.45/hour**.
- Continuous input and output for the whole hour: about **$1.35/hour**.

These are arithmetic scenarios, **not measured bills or current price verification**. Add text/context, any thinking charges, trusted TTS, fallback ASR and multiple connected lanes; account for idle/silent streaming behaviour from actual usage. Separate product cash spend from existing worker subscription draw and one-off lab cost. Do not double-count token categories or presume idle listening is free.

Use configurable per-session/day budgets, usage telemetry and an explicit degraded-mode offer. Local speech detection with a pre-roll buffer may avoid uploading silence, but must not clip first words. Do not advertise a monthly saving or the memo's latency/cost superiority until matched runs support it.

## 7. Implementation and evidence sequence

This is a proposed sequence, not permission to execute it. Preserve the [original lab discovery path](./VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md), `agent-benchmarks/benchmarks/04-voice-live-lab/PLAN.md` and their pre-registered thresholds. This document does not create a competing claim that those runs have happened.

### Step 0 — repair trust in the evidence

With owner authority, correct the overclaimed memo/ledger/leaderboard and replace literal report verdicts with manifest-derived aggregation. Use TDD: dry runs cannot enter model standings; no attempts means not measured; missing usage/audio/fixture provenance fails closed. Preserve historical records, do not erase inconvenient results.

Wire real frozen speech and audible trusted replies into measured runners, replay the world events/gestures/interruptions rather than only sequential utterances, implement the documented runner dispatch, and prove damaged records fail verification. Merely turning `mode` to `measured` must never qualify a tone/silence run as conversation evidence.

### Step 1 — harden the shared authority boundary, RED first

Add failing regressions for the classifier examples, unrelated “yes”, delayed ASR revisions, long mid-thought pauses, correction immediately after apparent endpoint, interrupted proposal presentation, reconnect flush, stale cards, original/tidied identity, duplicate release and lane switching. Fix the smallest shared-policy defects, replay the existing corpus and keep the cascade working. Narrowing unsafe confirmation is distinct from broadening model authority.

### Step 2 — complete the measured comparison

Follow baseline → Tier 1 → Tier 3 → derived Tier 2, with the original counts/conditions unless the owner explicitly changes the plan. Include live adaptive-instrument calibration before scoring adaptive behaviour. The pre-registered Tier 2 rules are all currently unresolved; do not manufacture their inputs from dry runs.

Report per-condition counts, failures, p50/p90 first **played/substantive** audio, transcript-commit/delivery latency, critical-token fidelity, over-asking, conversation proxies, cost and environment limitations. Missing/invalid attempts stay visible. Safety violations are vetoes, never averaged away by conversational scores. Zero failures in a finite sample is evidence, not proof of zero real-world risk.

### Step 3 — build a disposable product-shaped vertical slice

Extract reviewed reusable pieces out of the script harness; do not import the experimental runner wholesale into production. Likely ownership:

- `server/src/talker/`: canonical policy, draft and delivery semantics.
- New server native-voice adapter/service: authenticated audio connection, session lifecycle and host-state projection.
- `shared/`: typed, versioned audio/turn/proposal/receipt events with lane and attachment generation.
- Client voice capture/player: AudioWorklet or equivalent paced PCM path, bounded buffers/backpressure and the shared speech floor.
- Existing worker reading/delivery paths: reused, not forked.

Retain cookie/origin/CSRF protections, input validation, size/rate limits and prompt-injection checks before worker forwarding. Never stream provider credentials to the browser. Scope context access to the attached authorised session; raw audio/transcripts need explicit retention limits and must not enter public git or generic error logs.

Run existing tests plus disposable real-worker delivery and browser tests. Assert delivered/queued/refused against actual runtime receipts, not a green card. Cover Pi, Claude SDK and an explicitly authorised isolated Antigravity path; do not use production as a substitute for a disabled disposable runtime.

### Step 4 — prove the experience and recovery

Browser/mobile tests: two/three lanes, first-word capture, background/resume, network loss, stale confirmations, model outage, no duplicate audio, reading-level switch, stop without capture loss, ASR disagreement, and a conversation spanning connection churn/compression.

Audio proof must inspect rendered output, not only transcripts. The documented private-PulseAudio oracle failure on this host leaves that dimension **indeterminate** until a working isolated capture environment is available. Do not turn reference-player PCM into a claim about browser speakers.

Use the original ≤2 s p90 conversational target as an initial acceptance objective, report native vs matched cascade deltas, and separately measure substantive answers while worker tools run. Require critical negations/targets/conditions to survive the labelled corpus, even if aggregate recall passes. Preserve all existing feature contracts from §3.2.

### Step 5 — owner acceptance, then reversible rollout

Human judgement is still needed to establish whether this feels like a colleague rather than a switchboard. Offer short paired recordings and a disposable hands-busy trial, not a new lengthy benchmark participation burden.

Only after explicit approval: opt-in feature flag, known fallback, observable budget and rollback. Production deployment/restart is a separate gate. Reserve native-interrupt, model-composed relay and Live-as-conductor for their own decisions; a transport approval is not approval for all three.

## 8. Decisions to put to the owner

1. **Evidence:** may the existing lab sign-off and published claims be corrected to distinguish delivered equipment from unperformed measured runs?
2. **Direction:** adopt A as the target, with B as the first migration checkpoint, while keeping D open pending genuine results?
3. **Playback:** retain duck-and-continue initially; compare native-interrupt separately rather than silently changing the contract?
4. **Optional later scope:** model-assisted rewriting, cross-device floor arbitration and an always-on mobile client are separate choices, not prerequisites for the native voice slice.

**My opinion:** the two-lane design is not the mistake. Coupling it to a rigid, turn-by-turn switchboard experience is the limitation. The best next design is **a fluent native-audio colleague in front of an independently capable reasoning worker, with a small, explicit and auditable authority kernel between them**. Keep the ambitious single-model conductor experiment alive—but earn that simplification with real governance evidence.

## 9. Source and verification map

### Intent and product

- [Redesign intent and lab specification](./VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md): §§4–8 intent; §10 decisions; §§16–20 tier definitions/scoring; §25 completion includes runs.
- [Intent research](./VOICE-MODE-INTENT-RESEARCH-2026-09.md): defect history, fidelity, direct-worker use, reading and multi-lane requirements.
- [Current Voice Mode](./VOICE-MODE.md), [talker requirements](./TALKER-MODEL-REQUIREMENTS.md), [pricing research](./VOICE-AGENT-PRICING-RESEARCH-2026-09.md), [audio regression lab](./AUDIO-REGRESSION-LAB.md).
- [Policy core](../server/src/talker/policy-core.ts), [classifier](../server/src/talker/utterance-classifier.ts), [normalisation](../server/src/talker/relay-normalise.ts), [talker](../server/src/talker/talker.ts), [prompt](../scripts/talker-prompts/v3-harness.txt), [model client](../server/src/talker/model-client.ts), [client turn path](../client/src/components/DriveMode/useVoiceTurn.ts).

### Lab evidence and limitations

- [L4 handback](../scripts/voice-live-lab/L4-HANDOFF.md) §5; [L5 handback](../scripts/voice-live-lab/L5-HANDOFF.md) §§4–6; [L6 handback](../scripts/voice-live-lab/L6-HANDOFF.md); [L7 handback](../scripts/voice-live-lab/L7-HANDOFF.md) §6.
- [Tier 1 runner](../scripts/voice-live-lab/lib/tier1-dryrun.ts): `utterancePcm`, `runTier1MeasuredAttempt`, silence voice.
- [Tier 1 harness](../scripts/voice-live-lab/lib/harness/tier1-guarded.ts): `TranscriptCommitTracker`, `executeTurn`, incoming audio handling.
- [Handshake implementation](../scripts/voice-live-lab/lib/handshake.ts); capability record inspected locally, sensitive connection identifiers not reproduced here.
- Sibling repository `/root/agent-benchmarks/benchmarks/04-voice-live-lab/`: `PLAN.md`, `generate_reports.mjs`, `report.json`, `run_voice_lab.sh`, `README.md`, and retained `runs/tier3-dryrun-202609171304/.../manifest.json`.
- Sibling repository `/root/agent-benchmarks/benchmarks/02-orchestrator-governance/`: `README.md`, `runs-manifest.json`, and `runs/run-20260911T165908Z/orchestrator-scorecard.json`.

Agent OS packet and pointed recall supplied continuity; current files and record provenance govern implementation/results. Published B4 claims were fetched directly. Classifier examples were executed locally against source without delivery or a model call. Historical test counts are attributed, not presented as tests rerun in this review.
