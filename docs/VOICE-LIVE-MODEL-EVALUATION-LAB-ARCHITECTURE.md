# An unattended lab for native live voice models

> **Status:** proposed architecture and design principles, not an implementation plan, a benchmark specification, or approval to replace Voice Mode.
> **Written:** 2026-09-16. **Code grounding:** `edfa28f84883aae477e2deb6717891fecfe4711a`.
> **Question:** Can agents evaluate a native speech-to-speech candidate such as Gemini 3.8 Live inside a representative Pi Web UI voice environment, without the operator speaking, listening, or supervising each run?
> **Answer:** yes. Supply timed synthetic speech, simulate the worker independently, preserve the application's authority boundary, and record both decisions and audio. Some small integration work is unavoidable; a production migration is not.

## 1. What this would let us decide

The useful question is not simply **“is Gemini a good voice model?”** It is:

> Does this candidate, with the context and safeguards our product needs, sustain a more responsive conversation than today's cascade, without losing intent fidelity, honest reporting, playback control, or acceptable cost?

The operator's concern is the conversation itself: the existing surface works as an update reader and prompt relay but does not feel sufficiently dynamic. A lab must therefore support **multi-turn, overlapping, reactive conversation while worker activity continues**, not just score isolated spoken questions or successful tool calls.

An unattended run could produce:

- a paired comparison against the current stack on the same input material;
- timing and turn-taking evidence, including repairs and interruptions;
- exact evidence of what was held, confirmed, delivered and heard;
- separately attributed model, integration, policy and environment failures;
- measured usage and a cost projection for the operator's usage pattern;
- replayable examples and an explicit list of what remains unproven.

It cannot prove that the operator will enjoy the voice, that it recognises his particular accent, or that a Bluetooth headset works. **Human-free execution and scoring are possible; human preference is not thereby measured.** A later listening decision can be optional and informed by retained clips, rather than required to discover every defect.

This document specifies the lab's shape, boundaries and evidence contracts. It deliberately does **not** select a scenario catalogue, benchmark weights, numerical acceptance thresholds, run budget, provider account or migration schedule.

### Relationship to the existing documents

- [Voice Mode](./VOICE-MODE.md): the feature's normative contract; current code resolves implementation details.
- [Intent research](./VOICE-MODE-INTENT-RESEARCH-2026-09.md): why conversation, faithful relay and recovery matter.
- [Original feasibility record](./VOICE-ORCHESTRATOR-FEASIBILITY.md): historical intent, including the relay/worker-role distinction; not current placement advice.
- [Pricing research](./VOICE-AGENT-PRICING-RESEARCH-2026-09.md): candidate economics and launch evidence; not proof of performance inside our product.
- [Audio regression lab](./AUDIO-REGRESSION-LAB.md): existing rendered-audio measurement capability to reuse, not replace.

## 2. What exists, and where the new seam really is

### 2.1 The current path

```text
Browser microphone
  → useDictation: MediaRecorder chunks; finish recording
  → /api/dictation: speculative/final transcription
  → useVoiceTurn / useTalkerTurn / talkerBus
  → WebSocket talker_turn
  → TalkerSessionRegistry: input checks + canonical worker identity
  → TalkerSession: classification, draft, confirmation, conversation
       ↘ OpenRouter text completion for conversational turns
       ↘ WorkerDelivery ONLY through the confirmed release branch
  → talker_turn_result
  → speechArbiter → useReadAloud → /api/tts → browser audio

Worker output → whole-turn reading/digest path → same playback floor
```

This is turn-based dictation feeding a text harness, not continuous speech-to-speech streaming. In particular, the current talker model interface is `completeTurn(messages) → { text, ttftMs, totalMs }`. Returning Gemini's transcription through that interface would test a text-shaped wrapper, **not** its native conversational dynamics.

### 2.2 Concrete reuse map

| Existing seam | Reuse in the lab | What it does not provide |
|---|---|---|
| `server/src/talker/types.ts`: `TalkerModelClient`, `WorkerDelivery`, `WorkerStateSnapshot` | Baseline model injection, recording worker sink, controlled state fixtures | No bidirectional audio session interface |
| `server/src/talker/talker.ts`: `TalkerSession.handleOperatorTurn` | Baseline turn behaviour and reference authority semantics | No standalone exported gate that can simply be plugged into a live stream; conversation and draft decisions are intertwined |
| `pending-proposal.ts`, `relay-normalise.ts`, `utterance-classifier.ts`, `ack.ts` in that directory | Draft identity, removal-only tidying, confirmation/cancel/selection rules and outcome wording | No acoustic truth, speaker authentication or continuous-speech segmentation guarantee |
| `server/src/talker/session-registry.ts` | Existing pre-input checks, per-runtime identity, bounded session lifecycle and state projection | It expects text turns; supported talker runtimes are Pi, Claude and Antigravity, not all five UI runtimes |
| `server/src/talker/state-view.ts`, `digest.ts` | Bounded context, truncation disclosure and reading semantics | No automatically fresh context in a persistent native-audio connection |
| `client/src/components/DriveMode/useVoiceTurn.ts`, `client/src/lib/talkerBus.ts` | Proposal/outcome surface and request/worker correlation | No native PCM streaming transport |
| `client/src/components/DriveMode/voiceLanes.ts`, `voiceFloor.ts` | One in-page floor, capture handoff, floor display | No cross-tab arbitration; several lanes do not imply one shared model context |
| `client/src/lib/speechArbiter.ts` | Priority, ducking, explicit stop and scheduling semantics | Its `ArbiterPlayer.playChunk` consumes **text**, not live PCM; packet boundaries are not sentence boundaries |
| `client/src/hooks/useReadAloud.ts`, `client/src/lib/spokenLedger.ts` | Current player baseline and duplicate-speech policy | No guarantee that received native audio was played, or that generated text equals heard speech |
| `scripts/audio-lab/` and `server/tests/audio-lab/` | Isolation, fixtures, output recording, immutable records and deterministic audio checks | Not a native model conversation benchmark |

Some older prose names `client/src/lib/voiceFloor.ts`; the actual floor derivation is in `client/src/components/DriveMode/voiceFloor.ts`. The current relay supports tidied/original variants and proposal identity; do not regress to the older “every release is byte-for-byte original” description.

**Important baseline limitation:** current “verbatim” input is the returned STT text, not independently established literal speech. A byte-perfect relay can still faithfully deliver a mistranscription. The new lab must measure these two fidelities separately for **both** stacks.

### 2.3 Minimum integration, not a replacement project

The first useful lab needs a provider connection adapter, a speech driver, a worker fixture, an event recorder and a reference playback sink. No new production route, runtime, model picker, deployment or worker implementation is needed.

A later product-compatibility lane needs a narrow bridge to the real gate and browser policies. If that requires extracting a model-independent policy core from `TalkerSession`, that is a **future TDD-gated refactor**, with old/new differential tests, not an existing capability assumed here. Do not copy its release logic into an unchecked lab implementation and call the result “the production gate”.

## 3. Overall architecture

```text
                         PRIVATE EVALUATION CONTROL PLANE
  Scenario manifest ─→ director + event scheduler + independent assertions
         │                   │                         ↑
         │ hidden truth      │ timed actions           │ append-only evidence
         ▼                   ▼                         │
  Synthetic operator → speech assets → paced input driver
                                         │
                      ┌──────────────────┴──────────────────┐
                      │                                     │
                 CURRENT STACK                         CANDIDATE STACK
               STT → text talker                     native live session
                    → TTS                            audio in / audio out
                      │                                     │
                      └──── policy / proposal boundary ─────┘
                                      │
                          recorded, guarded WorkerDelivery
                                      │
                           deterministic worker environment
                                      │
                       bounded worker-state/context updates

  Model/source audio → playback policy → player → isolated output recording
         │                   │                              │
         └───────────────────┴──────────────→ evidence ─────┘
                                                  │
                       offline checks + independent semantic/audio assessment
                                                  │
                              comparison report + evidence clips + limitations
```

These are logical components, not a requirement for many services. A Node/TypeScript runner fits the existing repo; audio preparation and analysis may invoke the lab's existing tools. Start with one runner and adapters, not a distributed platform.

Run the two stacks in **separate fresh sessions**. “Same test” means matched inputs, context, environment policy and declared timing—not that the models must utter the same sentences. A matched pair need not run concurrently; sequential execution often gives cleaner latency and audio measurements.

## 4. Giving it a voice without the operator

### 4.1 Default: synthesise utterances once, then replay real audio

1. Author artificial operator utterances and a separate record of their intended meaning.
2. Generate speech with a non-candidate TTS engine. The existing lab's local Supertonic path is an available starting point, subject to the required language/voice support.
3. Freeze the generated bytes, voice/model configuration, duration and hashes. Verify that the speech actually says the intended words; intended text is not acoustic ground truth by assertion.
4. Keep a lossless master. Derive provider/browser formats explicitly, logging resampling and encoding.
5. Feed the candidate **audio only** for the operator channel. The source text and expected answer remain on the evaluator side.

No voice cloning or operator recording is necessary. Use multiple available voices and, eventually, pronunciation, pacing and language variants. Non-native English and Finnish can be represented by appropriate synthetic fixtures, but success on those voices is not personal-accent validation.

TTS that silently drops a negation or mangles an identifier makes a bad fixture, not a model failure. Fixture checking can use independent ASR, forced alignment and targeted consistency checks; unresolved ambiguity is `indeterminate`. Forced alignment localises an expected script; it does not independently prove that script was spoken.

### 4.2 Timing is part of the input

The driver sends audio at wall-clock speed, with a recorded chunk cadence—for example, configurable 20–40 ms frames, **not a benchmark threshold**. Dumping a whole recording into a socket immediately would remove the listening/interrupting problem we want to measure.

Preserve and control:

- speech onset and offset, pauses inside a thought, hesitation and trailing silence;
- overlapping operator/model speech, backchannels and corrections;
- gaps during worker activity and unsolicited model speech during those gaps;
- controlled noise, echo, bandwidth or jitter treatments as separate conditions.

There are two endpointing modes, and they must remain separately labelled:

- **Explicit-boundary diagnostic:** the driver supplies activity start/end or recording gestures. Useful to isolate reasoning from endpoint detection, but gives an ideal boundary.
- **Natural endpointing:** the stream includes real pauses/silence and the configured production-candidate VAD decides. No hidden script boundary is leaked to the model.

In the existing baseline the driver must operate the current recording start/stop interaction. Comparing it with an always-listening candidate is a valid **system comparison**, but is not an isolated model swap; report that difference. An additional explicit-boundary comparison can separate model effects from interaction-policy effects.

### 4.3 Three operator-driver modes

| Mode | How the next utterance is chosen | Why it exists |
|---|---|---|
| Frozen replay | Fixed recordings and event-relative triggers | Repeatability, regression and matched A/B comparisons |
| Bounded branching | A pre-authored state machine selects a frozen reply from observable outputs | Repairs, clarification and contingent confirmation without another generative model |
| Adaptive simulated operator | A separate model proposes a reply from the dialogue it could actually hear; an independent director validates it, then TTS speaks it | Open-ended exploration and finding failures the script did not anticipate |

Use frozen/branching runs as the comparison backbone; adaptive runs are a supplement, not the sole judge.

The adaptive operator sees its goal, its own history and **audible** assistant output—not hidden worker truth, reference answers, candidate internals or an unheard transcript. A transcript of the full generated response would let it react to words that were muted, queued or interrupted. For reactive branches, incremental independent ASR over played audio is a practical interface; a separate audio-capable simulator can be an explicitly labelled alternative.

The director owns which synthetic permissions may occur. An operator simulator cannot decide to authorise work merely because the candidate pressures it, and the candidate cannot invoke a “user said yes” tool. Invalid simulator actions are recorded as simulator failures, not candidate successes. Bound turns, silence, generated speech length and spend; freeze useful discoveries into replay fixtures for later comparison.

**Do not use the candidate as its own operator, transcriber and judge.** Shared failure modes would create a convincing but circular evaluation.

## 5. Two independently driven timelines

A useful lab is not `say → await final answer → say`. It has concurrent event streams:

1. **Operator:** audio frames, recording gestures, language changes and surface controls.
2. **Worker:** activity, partial/final answers, questions, delayed or refused deliveries.
3. **Candidate:** audio, transcripts, tool requests, activity/idle transitions and errors.
4. **Playback:** starts, gain changes, consumed samples, holds, drops and cancellation.

A single monotonic scheduler records their causal order. Browser and server clocks need measured offsets and uncertainty; media sample indices provide a separate audio timeline. Keep intended trigger time **and actual execution time**. If scheduling drift invalidates an overlap condition, report a missed condition rather than score a fictitious interruption.

Triggers may be relative to actual output—for example, a configured interval after the first **played** speech sample—rather than fixed sleeps after a request. Semantic triggers use observable dialogue and have their own detection latency. Neither kind gives the candidate a secret cue that the operator is about to interrupt.

The receiver, input pump and worker driver must continue independently. A slow tool or completed generation cannot stop microphone input or prevent processing later events. This is especially important for native asynchronous tools.

## 6. The worker environment: realistic context, no real-world effects

### 6.1 Start with deterministic workers

Use an implementation of `WorkerDelivery` that records the actual target, bytes, hash, time and returned `DeliveryOutcome`, but does no external work. An independently scheduled worker fixture exposes `WorkerStateSnapshot` and worker-output events.

It can represent busy, idle, queued, refused, unavailable and recovery states without paying a reasoning worker to improvise them. State transitions can depend on **actual observed delivery**, rather than blindly reporting a success the candidate never caused. Unsolicited activity continues while the voice model talks.

Keep three records distinct:

- **World truth:** what happened in the fixture, including facts not yet visible to the talker.
- **Exposed context:** the bounded state/history actually supplied to each system, with timestamps, revisions and truncation disclosure.
- **Candidate claims:** what the assistant said about that world.

Truth withheld from the context cannot be required knowledge. Conversely, a cheerful answer is not delivery evidence; only the delivery sink or real worker receipt establishes that.

### 6.2 Context updates are not operator speech

For the baseline, use the real state-view projection. For the candidate, adapt equivalent content into explicit, bounded context updates. Preserve worker/session identity, earlier history, draft/outcome state, reading level and focus/hold state. Record what was filtered, stale or unavailable. Routine bookkeeping and tool-result text remain data, never user confirmation or spoken material by default.

Do not give Gemini the entire worker history while starving the baseline with its current compact view, then attribute the improvement solely to the model. A richer-context experiment is useful, but belongs in a separately named condition.

A persistent provider connection does not refresh itself when the worker changes. The bridge owns event coalescing, context versions, update timing and backlog limits. State that must survive model context compression—draft identity, permission, delivery receipt and playback position—lives outside model memory.

### 6.3 Real runtime lane comes later

When model/fixture and compatibility evidence justify it, a separately authorised lane can use real **disposable** workers and the existing delivery adapters, with harmless tasks and isolated working directories. This checks wiring, canonical identity, busy delivery, queuing and recovery—not the whole quality benchmark again.

Follow [live validation](./LIVE-VALIDATION.md). Do not infer support for every runtime from one Pi pass. There is no reason to target the operator's active sessions or enable production validation for this lab.

## 7. Preserve the authority boundary while replacing conversation

### 7.1 The architectural split

A native model may replace the **conversational** STT → talker → TTS path. It must not replace the application's ownership of drafts, confirmation, byte selection or delivery outcomes.

```text
Operator audio ─────────────→ native conversation model ─→ candidate speech
       │                              │
       │                              └→ narrowly validated proposals/reads
       ▼                                          (never permission)
Independent input transcript / explicit UI gesture
       → mechanical policy + stored draft → guarded recording worker sink
                                              │
                               authoritative outcome → fixed receipt audio
```

The model has no raw worker send function, shell, session-creation tool, child dispatcher or production credentials. A model request can refer to a host-recorded utterance ID or ask for context; it cannot supply alternative relay text, mint an utterance, select another worker, or declare the operator confirmed.

Existing exceptions must be preserved precisely: `[[to-talker]]` can suppress drafting a statement; `[[ask-worker]]` can offer the operator's own eligible question. These are constrained draft decisions, not dispatch permission. A native adapter must implement equivalent bounded semantics if testing feature parity, rather than silently discarding those capabilities.

### 7.2 There is still a transcript problem

Native conversation does not remove the need to know **which words may be sent to the worker**. Keep separate:

1. fixture script and acoustic reference, visible only to evaluation;
2. candidate/provider input transcription, observed but not authorisation;
3. independent input STT used by the guard;
4. stored original/tidied proposal and selected release bytes.

For the first guarded native candidate, retaining the current independent STT path as an **authorisation side channel** is the conservative choice. It need not delay ordinary native conversation, but draft/confirmation processing must wait for its completed input. Include its latency and cost. “Native model plus safety sidecar” is an honest condition name; “entire cascade removed” is not.

Using the same live model's self-reported understanding of “yes” to authorise its own proposed action would make the gate depend on that model. Do not call this equivalent to the existing design. Provider transcripts can be evaluated in shadow, without becoming a release source.

Independent STT is also fallible. Score loss of negation, conditionals, targets and technical strings separately from byte-equality after transcription. The text classifier's current vocabulary is English-centric: Finnish conversation capability does not automatically imply Finnish confirmation support. Unknown or ambiguous forms must not be upgraded into authorisation by translation from the candidate.

No stream of partial transcripts may release a draft: “yes … actually no” and revisions are precisely why finality matters. Record transcript revisions, audio spans and committed utterance IDs; process each committed input at most once and in order. Provider “turn complete”, VAD silence and operator permission are three different facts. The continuous-stream policy for committing an utterance requires explicit design and validation; a golden fixture boundary is not a production solution.

### 7.3 Faithful approval, receipts and safety speech

Carry proposal version/hash and tidied/original selection through any automated card gesture. Preserve today's distinction: card confirmation echoes an identity; a bare spoken confirmation does not currently carry that echo. A synthetic spoken “yes” must exercise that actual path, not be secretly converted into a stronger card-confirmation path.

Permission in this lab is permission from a **simulated actor inside a sandbox**, never authorisation from the real operator for consequential work.

Fixed acknowledgements are chosen **after** the worker outcome. They can be pre-synthesised trusted audio or use the existing TTS path. Asking the live model to paraphrase a receipt is not mechanically honest acknowledgement.

There is a further limit: even without a send tool, a live model may falsely *say* it sent something. Preserve both its raw audio and the played result. Prompting it not to make that claim is a behavioural mitigation, not a mechanical guarantee. A compatibility lane may need to reserve receipt/proposal-readback playback for trusted audio and hold candidate output during safety-critical transitions. Streaming speech already heard cannot be retroactively corrected by an output transcript.

The lab should expose the quality/latency cost of those interventions and any remaining false claims. Do not hide them by scoring only actual deliveries or replacing every inconvenient model response after the fact.

## 8. Audio, interruption and reading compatibility

### 8.1 A provider audio packet is not a speech intent

The native bridge needs at least:

- lane/session and connection-generation identity;
- response/segment identity and ordering;
- PCM format, sample count and media offsets;
- speech category from host context: receipt, elicited answer, worker read or unsolicited chatter;
- bounded buffer, underrun/overrun handling, gain, stop and consumed-position reporting.

Classification of permission-critical speech cannot be left to the model's self-labelled priority. Unknown unsolicited output should not gain receipt priority.

The current arbiter accepts sentence-sized **text** chunks; do not insert arbitrary 20 ms PCM fragments into it as if each were a sentence. A future bridge must preserve the policy with a stream-aware player, semantic boundaries where available, and honest fallback when alignment is unknown. This is one of the small but real integration tasks the lab should measure.

### 8.2 Ducking and native interruption are different policies

Today's product ducks in-flight speech to `0.15` while the operator holds the floor; it does not hard-stop on barge-in. Explicit “Stop talker” is a separate discard action. Google's Live VAD documentation describes cancellation of generation on interruption and tells clients to stop playback and clear queued audio.

**These are not interchangeable.** Keep two explicitly separate profiles:

- **Current-contract compatibility:** retain unconditional capture, the shared floor, ducking, explicit stop and non-repetition. Explore provider activity handling and buffering without changing the declared policy. If the provider cannot preserve it, report incompatibility.
- **Native-policy exploration:** measure the provider's cancel-and-reply behaviour with no claim of current-policy parity. The sandbox may investigate this alternative; adopting it in Voice Mode needs an operator decision.

Question for that later decision: **should spontaneous conversational interruptions cancel an answer, or must they retain the existing duck-and-continue contract?** This note does not resolve it in favour of the provider.

Record generation cancelled, bytes received, audio discarded, audio played and transcript retained independently. “Provider sent it” does not mean “operator heard it”. Do not replay a cancelled tail automatically, and do not claim the model remembers precisely the played prefix if the API offers no such synchronisation guarantee.

### 8.3 Reading levels are not automatically replaced by native speech

Verbatim, Summary and Headlines are application promises, not merely voice styles. A model asked to read verbatim can omit or paraphrase; a request to be brief does not enforce the existing Headlines extraction. Retain a controlled TTS/verbatim path where exact reading is required unless a native alternative is independently shown to satisfy it.

For a mid-answer level change, the bridge must know the **consumed** prefix, not just generated text, and avoid repeating it. Output transcription may arrive late or lack reliable word/sample alignment. If precise remainder selection is unavailable, record the missing capability rather than pretending the existing chunk-boundary semantics transfer unchanged.

Focus/hold, stop, replay suppression and per-lane scoping remain outside the model. A lane change must not migrate pending speech, drafts or a late tool response to the newly selected worker. Start with one lane; additional lanes should be isolated conversation contexts sharing one playback floor, not a single omniscient model given unrestricted context from every session.

## 9. A provider-neutral adapter, with Gemini as the first candidate

A **conceptual**, not implemented, adapter contract:

```text
open(configuration) → capabilities + ready event
pushAudio(frame, format, inputSequence)
commitInputBoundary(boundary)              # only in explicit-boundary mode
updateContext(versionedProjection)
returnReadOnlyToolResult(callId, result)
close(reason)

observe:
  inputTranscriptDelta / transcriptRevision / inputCommitted
  outputAudio / outputTranscriptDelta
  toolRequest / toolCancelled
  generationComplete / interactionState / interrupted
  usage / reconnectNotice / error / closed
```

Some providers cannot supply every event. Capability flags must say so; adapters must not invent final transcripts, word timing, idempotency or idle signals. Application utterance commits are host policy, not automatically a renamed provider event. Preserve original provider events alongside normalised events for diagnosis, with credentials scrubbed.

Process **all** parts of a message: audio, transcript and tool events can coexist. Keep a continuous receiver rather than exiting after the first completed turn. Reject unrecognised tool names/arguments, correlate results, handle cancellation and late results, and never convert a tool timeout into success.

### Gemini-specific starting assumptions

Official model, WebSocket, capabilities and session-management pages were read on 2026-09-16 (sources in §15). These are implementation discovery pointers, not the result of a live API probe:

- Use the exact `gemini-3.8-live` candidate, separate from Extended Thinking; standard does not accept a thinking-level configuration.
- Request audio output; enable input/output transcription as observation channels. Do not assume simultaneous free-standing text output is supported merely because a model table says “text and audio”.
- The documented wire audio is little-endian signed 16-bit PCM; use mono 16 kHz input, with correctly declared rate, and handle 24 kHz output. Do not send a WAV header as raw PCM or relabel compressed MediaRecorder data as PCM.
- Proactive audio cannot be disabled in setup. The application's floor must therefore remain effective against unsolicited provider output.
- Do not send video frames for an audio-only experiment. Record the effective turn-coverage configuration and unexpected modalities.
- `send_client_content` is supported throughout the session; `turn_complete=true` interrupts active generation. A routine worker-context update must not accidentally behave like a user interruption.
- Async tool execution is available. It is a way to return bounded context/results while conversation continues, not a reason to give the talker worker authority.
- Extended Thinking, if tested later, has different configuration/tool constraints and requires its documented `interaction_status` semantics; `turnComplete` alone is not an idle signal.
- Session resumption, context compression and connection lifetime are separate concerns. Record actual provider notices and reconnection behaviour instead of hard-coding “an hour is one uninterrupted connection”.

Pin SDK/API versions and accepted setup, and run a bounded capability handshake before a future paid suite. Provider configuration errors are `unsupported` or infrastructure failures, never a zero-quality conversation score. Price parity per token is not spend parity; model verbosity, context, reasoning, silence and retries still matter.

## 10. Evidence levels: do not claim more than was exercised

| Level | What runs | Valid conclusion |
|---|---|---|
| **0. Harness self-test** | Frozen audio, fake provider events, recording worker; no provider calls | The driver, event normaliser and assertions catch known defects |
| **1. Native conversation** | Real candidate audio I/O, scripted worker context, reference player; no worker authority | Candidate conversation/timing potential under the declared context and policy |
| **2. Guarded compatibility** | Candidate plus actual/extracted-and-differentially-verified policy core, independent input channel, recording worker and real browser policy bridge | Whether the proposed integration preserves the tested product contracts |
| **3. Disposable product/runtime** | Isolated server and browser, real transport/auth and selected disposable workers | The tested end-to-end wiring works on that environment |

The baseline is a parallel adapter at the relevant levels, not a remembered latency number from an earlier benchmark. A baseline run that skips real STT/TTS must be labelled accordingly.

All levels can run without a person speaking. Level 1 is enough to reject a poor candidate or justify the next integration experiment. It is **not** enough to recommend production replacement. Level 2 need not include every UI feature on day one, but missing coverage must stay visible.

### Browser input and output

For direct model screening, stream PCM without a browser. For a browser lane:

- A fixed microphone WAV via Chromium's fake-audio-capture facility can drive deterministic recordings through real capture code.
- Reactive input needs a scheduled virtual microphone or an explicitly instrumented `MediaStream` source; a single preloaded file cannot adapt to variable response timing.
- An instrumented stream bypasses physical device acquisition. Label that boundary; preserve a separate real-capture-machinery lane where needed.
- Use private browser profiles, local test authentication and disposable servers. Never attach to the operator's microphone or shared desktop.
- Keep synthetic microphone input and assistant output on distinct routes. Do not create an accidental audio feedback loop. Deliberate acoustic-echo simulation is a separate, labelled treatment.

## 11. Measurement: four independent sources of truth

| Evidence | What it answers | What it cannot prove alone |
|---|---|---|
| Input assets + actual ingress recording/timestamps | What speech reached the system, with what timing and impairment? | That a source script was recognised correctly |
| Model wire output + transcripts + usage | What did the provider generate/report? | What the browser played or whether a tool actually acted |
| Application/gate/worker events | Which draft existed; what confirmation occurred; which exact bytes went where? | What a listener heard |
| Rendered output capture | Which sounds were actually emitted by the tested playback chain? | Whether the response was truthful or personally preferred |

Capture source audio **from this run**, not a second generation of the same text. Native speech is nondeterministic. Compare received PCM with rendered PCM to locate player omissions; compare rendered speech with world/context evidence to evaluate its meaning. Do not require waveform equality between the baseline and candidate's different voices.

Reuse the audio lab's independent OS-output recording and source-aware oracle where applicable. Native-stream support will need source segmentation and accounting for intentional stops/gain changes; existing MP3/text-chunk assumptions cannot simply be asserted for PCM streams. Demonstrate sensitivity with negative controls before relying on a new oracle.

The existing intent report records a host `capture:chain` failure involving the private PulseAudio daemon. This task did not re-run that check. Future runners must run `doctor`: if OS capture is unavailable, report application/network measurements under their narrower labels and mark OS-rendered proof `indeterminate`. A Web Audio tap is useful diagnosis, not a replacement for an independent OS recorder.

### 11.1 Separate measurement families

No composite weights or exact thresholds are chosen here. The architecture must retain enough evidence for later evaluation of:

- **Responsiveness:** speech-end to first received audio, first played audio, and first substantive answer. An early “let me check” is not the substantive answer. Include STT finalisation, context wait, safety hold and playback queueing; do not compare text TTFT with audible TTFA.
- **Turn-taking:** premature response during a continuing thought, overlap, interruption reaction, repair latency, silence handling and unwanted monologues. Distinguish intentional ducked overlap from a violation.
- **Conversation:** context-relevant answers, appropriate follow-up, self-service answers instead of needless worker relay, repair/revision, continuity and language switching.
- **Intent fidelity:** source speech versus recognised text; recognised text versus stored proposal; approved bytes versus actual delivery. Negations and constraints matter more than aggregate word error alone.
- **Authority/honesty:** release without eligible confirmation, stale/wrong-lane releases, duplicate delivery, false success claims and hidden refusals. A blocked attempted bypass and a successful unauthorised release are separate findings.
- **Playback:** head/tail loss, duplicated/omitted segments, join gaps, stop/hold/dedup correctness and level-change behaviour.
- **Continuity:** draft and context behaviour across interleaved worker updates, reconnects, compression, lane changes and explicit stop.
- **Economics:** total voice-system spend, successful-useful-exchange cost, connected-hour cost and resource use, with failed attempts included.

Report distributions and paired differences with sample counts, not a single best latency. Declare cold/warm starts, network conditions, concurrency and repeated runs. Seeds make fixture generation reproducible; they do not make a hosted live model deterministic.

### 11.2 Mechanical assertions before model judges

Use code for byte equality, hashes, causality, release eligibility, target identity, duplicate detection, time intervals, source/render alignment and usage accounting. An LLM judge must not decide whether the gate was obeyed when the event trace can establish it.

Use independent semantic/audio assessment only for qualities requiring interpretation. Supply the permitted context, audible dialogue and rubric; blind model identity where feasible, randomise presentation order, retain judge/version/prompt and cited evidence spans. Report uncertainty or disagreement. Keep an untouched evaluation set separate from prompt-tuning material.

Acoustic assessments can add intelligibility, prosody or naturalness proxies. They cannot turn synthetic/model preference into the operator's preference or a human Mean Opinion Score. No judge score may compensate for a demonstrated authority violation.

## 12. Run records, lifecycle and unattended operation

### 12.1 One immutable record per attempt

Suggested layout, **new/proposed**, outside the repository:

```text
<private-lab-root>/<run-id>/<condition>/<attempt-id>/
  manifest.json                 # code/config/fixture/prompt hashes; capabilities
  scenario.json                 # hidden truth + trigger policy; never sent wholesale
  input/                        # source, transformed audio, actual input timeline
  provider/                     # scrubbed setup, wire events, generated audio, usage
  application/                  # gate, proposal, context, delivery, playback events
  capture/                      # recorded output and capture-health evidence
  evaluation/                   # mechanical checks, independent ASR/judges, uncertainty
  report.json + report.html      # results, clips, costs, missing proof, teardown result
```

Include run, condition, attempt, lane, worker, utterance, proposal, tool-call and connection-generation identities. Link existing `voiceTurnId` and request IDs when they exist; do not overload a production turn ID to represent many simultaneous native audio events.

Each event carries source, sequence, monotonic timestamp, relevant media offsets and causation IDs. Golden script text must never leak through tool results, context, fixtures served to the candidate or recogniser hints. Credentials, auth URLs, cookies and provider resumption handles must not appear in logs/reports; keep any required resumption state in a restricted secret sidecar.

Finalise records once. Retrying creates a new attempt and does not erase failures. An offline verifier checks hashes and re-derives deterministic results. A missing capture, missing outcome or incomplete usage record cannot become a clean pass because the runner exited normally.

### 12.2 Bounded execution without a watching agent

The runner owns state transitions such as `preflight → ready → running → draining → finalised`, with explicit `failed`, `unsupported`, `indeterminate` and `budget-stopped` outcomes.

Preflight checks fixtures, formats, disk, clocks, provider configuration, available quota and output-capture health. Configure maximum wall time, speech duration, turns, tool calls, queued bytes, reconnections and total spend. Use conservative projected cost to stop before a budget is exhausted; usage events may arrive late.

At completion, drain only within a bound: wait for the configured interaction-idle condition, settled tool calls and finished/discarded playback, not merely a transcript's last token. On error or budget stop, record partial evidence and close provider connections, audio inputs, recorders, browsers and owned server processes. Verify teardown by process identity, as the existing audio lab does.

For orchestration, use a background job with completion notification and an independent model-free deadline/backstop. A supervising agent should not keep generating turns to ask whether the conversation finished. Provider event handling stays in ordinary code.

On reconnect, persist guard state independently and mark the connection generation. Do not blindly replay a confirmation or resend a worker delivery whose acknowledgement was lost. If delivery receipt is unknown, expose `unknown` and reconcile the receipt; claim exactly-once delivery only where tested deduplication/receipt semantics support it. Restoring provider conversation context is not evidence that application permission state was restored.

### 12.3 Cost and privacy are part of validity

Account separately for candidate input/output/text/reasoning, background context updates, independent safety STT, trusted TTS receipts/verbatim reading, operator TTS, evaluators, worker runs and retries. Separate recurring product cost from one-off lab cost. Frozen local operator speech makes the latter much cheaper.

Report measured billable usage when available and labelled estimates otherwise, using a dated rate card. Include silence/connected-time assumptions and multiple open lanes. Project onto the pricing research's usage profile only after those quantities are measured. Equal rates to 3.1 Flash Live do **not** establish equal total cost or parity with the current stack.

Synthetic data is the default. No real session transcripts, private files, credentials or operator voice should leave the host as benchmark material without explicit approval. Even free-tier API use needs review of data-handling terms. A future live run requires approved provider access and spend scope; this architecture note authorises neither.

## 13. Fair comparison and honest conclusions

The unit of comparison is a **fully declared condition**, not just a model name:

```text
model + API/version + prompt + supplied context + endpointing policy
+ guard/transcript strategy + playback policy + voice + transport environment
```

Two complementary experiments are needed:

1. **Controlled replacement:** equivalent semantic context, common safeguards and matched audio inputs. Answers whether the native conversational component helps under comparable constraints.
2. **Best realistic system:** current shipped interaction versus an explicitly described native integration, including sidecars and its actual policy costs. Answers whether the overall proposed experience is better.

A provider-default demo may reveal potential, but must not be ranked as a drop-in replacement for the guarded product. Conversely, forcing native audio through the old complete-text-turn bottleneck can conceal the very benefit being evaluated.

For adaptive dialogue, pair goals/worlds/driver policy rather than pretend divergent conversations received identical utterances. Retain the divergence and use repeated trials; convert discovered failures to frozen tests where appropriate.

The report should be able to say, independently:

- “Conversational improvement observed under these conditions.”
- “Relay/reading/floor compatibility passed, failed or remains untested.”
- “This is a provider limit / application policy cost / integration defect / invalid fixture / environment failure.”
- “Cost is within the declared envelope / exceeds it / is not yet known.”
- “Worth a guarded product experiment”, “not worth proceeding”, or “insufficient evidence”.

It must not conclude “better for the operator in real life” solely from synthetic voices and model judges.

## 14. Principles for a later implementation brief

This is a dependency order, not the full implementation plan:

1. **Prove the measuring equipment first.** TDD the scheduler, transcript commits, event normalisation, fixture checks and offline verifier with deliberately damaged traces/audio and clean controls.
2. **Establish the current baseline.** Reuse the actual turn harness and recording delivery seam; label each real versus stubbed component.
3. **Add one real native-audio candidate.** A minimal persistent connection and paced speech driver reveal conversational potential without changing production.
4. **Prove the compatibility boundary.** If extracting gate/player seams, preserve existing tests and differential behaviour before benchmarking the new bridge. Keep explicit policy alternatives out of parity claims.
5. **Add browser and disposable runtime proof.** Use real local capture/transport/playback where applicable, with independent recording and retained evidence; no production validation.
6. **Only then broaden the conversation corpus and investigate migration.** Product selection, thresholds and any changed approval/interrupt policy remain owner decisions.

The essential deliverable is **not two bots chatting until one declares success**. It is a repeatable audio experiment with an independent operator driver, an independently controlled worker world, a mechanically guarded action boundary and separate evidence of what was said, sent and heard.

## 15. Source and discovery map

### Repository authority

The four documents linked in §1 were read in full. Current implementation was inspected in the talker, dictation, voice surface, floor and playback files named in §2; future agents should re-ground against their checkout rather than assume the recorded revision is still current.

For concrete reuse and further discovery:

- `scripts/audio-lab/lib/fixtures.ts`, `capsule.ts`, `pulse.ts`, `product-lane.ts`, `oracle.ts`, `manifest.ts`, `verify-record.ts`: existing fixture, isolation, render and evidence mechanisms.
- `scripts/audio-lab/browser/lab-main.tsx`: the real product-player test surface; its synthetic microphone open/close check is not a full conversational input lane.
- `scripts/talker-harness.ts`, `scripts/p27-talker-matrix-live.ts`: existing text-model/recording-delivery and deterministic-versus-real-model patterns. Their TTFT measurements are not native-audio latency measurements.
- `scripts/talker-live-validate.ts`, `scripts/voice-mode-browser-e2e.mjs`: disposable worker-receipt checks and real Chromium fake-microphone/STT/confirmation wiring. These do not independently score the rendered reply audio; do not mistake them for the complete proposed lab.
- `server/tests/audio-lab/oracle.test.ts`: sensitivity and negative-control pattern.
- `server/src/talker/types.ts`, `talker.ts`, `pending-proposal.ts`: baseline injection seams and authority semantics.
- `server/src/websocket/connection.ts`: actual `talker_turn` / `talker_digest` wiring, identity validation and result shaping.
- [Observability](./OBSERVABILITY.md), [live validation](./LIVE-VALIDATION.md), [security](../SECURITY.md): correlation, disposable environments and data boundaries.

### Provider documentation read for this note

Retrieved 2026-09-16; no authenticated model session or paid benchmark was run:

- [Gemini 3.8 Live model and migration notes](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live).
- [Raw WebSocket setup and audio input](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket?hl=en).
- [Live capabilities: audio formats, transcriptions and VAD interruption](https://ai.google.dev/gemini-api/docs/live-api/capabilities?hl=en).
- [Session management: compression, resumption and connection notices](https://ai.google.dev/gemini-api/docs/live-api/session-management?hl=en).

Exact configuration, cancellation semantics, usage fields and SDK event names require a fresh capability check during implementation. None of the documentation claims above is a claim that Gemini has already passed this proposed lab.
