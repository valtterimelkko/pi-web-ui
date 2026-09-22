# Voice Mode — one native conversation, autonomous validation, evidence-based model choice

> **Class:** execution plan and acceptance contract.
> **Status:** planning complete; execution NOT started. Written 2026-09-22 at baseline `86b91674`.
> **Owner instruction:** write a comprehensive plan for a separately dispatched execution agent; remove the owner from routine testing, reuse the audio/lane labs, compare standard Live with Extended Thinking under the same host contract, and end with a measured architecture verdict.
> **Discovery:** [Voice Mode index](../VOICE-MODE-INDEX.md) → **this plan** → phase ledger and evidence created by the executor.
> **Intent sources:** [canonical intent](../VOICE-MODE-INTENT.md), [architecture of record](../VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md), and the owner's 22 September direction recorded below.
> **Authority:** this document is a plan, not a claim about shipped behaviour or permission to restart production. An owner dispatch approving this plan starts execution. Merely discovering it does not.

## 0. Executive brief for the execution agent

**Deliver one natural voice conversation that remains available while a strong worker works or orchestrates. A relay is an explicitly approved action within that conversation, not a second conversation mode.**

Keep the familiar main Voice Mode controls, but make them operate the native Live engine. Do not restore the old cascade behaviour merely to preserve its layout. Keep the cascade as an explicitly labelled degradation, not a competing default surface. Preserve reading levels, ducking, push-to-talk, multi-worker attachments, honest receipts and existing worker permissions.

The native model interprets language and prepares a candidate. The host owns source binding, proposal identity, presentation, confirmation, delivery and receipts. The existing attached worker remains the executor or conductor; do not insert a third permanent reasoning agent or grant the voice model child-spawning authority.

Build a **small reusable corpus, repeated systematically**, not a large free-form agent theatre. Exercise the actual main controls in a built browser application, real captured speech, the real Live provider, and real disposable worker sessions. Reuse the two audio labs and the vertical slice; extend their missing seams. Produce immutable, independently re-verifiable records and a final verdict that can honestly be **neither model qualifies**.

**Do not call this done because:** the socket connects; the model speaks; unit tests pass; one stochastic attempt passes; a scripted conductor scores 100%; the confirmed bytes reach the worker; or a model says it obeyed. Each proves a different, narrower thing.

### Scope and authority on dispatch

| Included after explicit execution dispatch | Not authorised by this plan |
|---|---|
| TDD product repairs; isolated browser/server/runtime validation; real provider calls within §10 limits; read-only history retrieval; fixture worker tasks confined to disposable repositories; documentation and final analysis | Production deployment, restart, production validation, real-session prompting, editing production env/config, shared desktop/audio changes, publishing reports or recordings, real external business actions |
| Same host permission contract for standard Live, ET-low and ET-high experiments | Automatic reasoning escalation, Live-as-conductor implementation, removing per-instruction approval, changing duck-never-stop policy, extending work to a native mobile application |
| Autonomous corpus construction, synthetic speech, deterministic test direction and independent scoring | A requirement that the owner record audio, listen to examples, operate the UI or judge routine acceptance |

No owner listening gate is required to complete the **scoped automated verdict**. Missing infrastructure or exhausted authority is a named blocked/indeterminate outcome, not a request to make the owner the test harness. Only genuine authority/budget conflicts need a question. Production rollout remains a separate later decision.

## 1. Owner intent — preserve this, not just the implementation checklist

### 1.1 Desired experience

The primary value is **orchestration through natural voice**, not a conversational demo. The operator wants to work at a desk or with hands and eyes busy, discuss an approach while work continues, develop or change a thought, ask what is known, and then hand over a particular instruction without dictating a ceremony or pressing several controls.

The worker may execute directly or supervise children. That choice is independent of the voice interface. The operator should not need to understand which internal model handles each sentence. Attribution must nevertheless remain honest: a talker's opinion is not a verified worker result.

The operator's original dissatisfaction with ChatGPT Voice was premature dispatch, altered instructions and weak orchestration governance. The dissatisfaction with the home-grown cascade was the opposite failure: a rigid switchboard which treats conversation as a partly composed worker prompt. **Do not solve one by reinstating the other.**

### 1.2 Required conversational contract

1. Discussion and thinking aloud are the default. They do not silently accumulate instructions.
2. An explicit request such as “relay to worker …”, “ask the worker …” or “tell the worker …” prepares a candidate, regardless of ASR punctuation.
3. Remove the addressing frame from a worker message. Preserve the operator's intent, qualifiers, negation, restrictions, names and quantities. Do not invent a plan.
4. Questions answerable from the talker's context/retrieval are answered without gratuitous delegation. Explicit requests to ask the worker still take precedence.
5. A question jointly developed in conversation may become a composed candidate only when the operator asks to promote it; identify that provenance.
6. Each instruction needs its own approval of the **actual message**, bound to the target and version. Neither a pause nor model-generated speech is consent.
7. A relay does not end the conversation. The operator can continue talking while the worker executes.
8. Corrections update the intended candidate; repeated attempts must not silently concatenate a bad first attempt into a later message.
9. Read-back, reading levels, focus, stop, cancellation and ducking survive. There must be a voice path for essential approval/correction controls; cards are not compulsory eyes-on controls.
10. Up to three worker attachments retain separate context and target identity. One active microphone target; no silent retargeting and no duelling playback.
11. Worker execution survives a closed voice connection. Host-owned pending work and receipts must not depend on a model remembering them.
12. Keep latency and spend proportionate. Compare cost per successful interaction, including corrections, not token prices alone.

### 1.3 Representative interaction

> Operator: “I am not sure the alternative is worth doing.”
>
> Talker: Discusses the trade-off; no proposal.
>
> Operator: “Ask the worker to investigate the alternative, but don't change anything yet.”
>
> Host presentation: “For the coding session: ‘Investigate the alternative, but don't change anything yet.’ Send?”
>
> Operator: “Yes, send that.”
>
> Host: delivers those approved bytes and emits the truthful receipt cue. Conversation can continue.

The owner is not asking for perfect mind-reading. Genuine ambiguity gets one concise clarification. The owner is asking not to pay that clarification cost for every ordinary sentence.

## 2. Verified starting point and why the present tests are insufficient

Recheck these facts at execution start; source code outranks historical prose.

| Finding | Evidence and consequence |
|---|---|
| `ff75d0c4` + `494f62c9` introduced model-driven native relay; `27bd7174` restored main cascade behaviour along with its old layout | `client/src/components/DriveMode/DriveModeDictate.tsx` calls `useVoiceTurn` for the main controls and separately mounts `NativeVoiceLane`. The main and bottom surfaces are different engines, not skins. |
| The latest inspected attempts were cascade, not native | Production diagnostics read at 12:02Z on 22 September contained six `VoiceMode` turns at 11:18–11:19Z, four proposals, two cancellations, zero deliveries; no `VoiceLive` records. Do not read these as Gemini capability failures. Historical diagnostic evidence only; execution uses disposable targets. |
| `91021a53` did not cover punctuation-free first-person continuations | `server/src/talker/relay-normalise.ts`: “Relay to worker: I want…” strips, “Relay to worker I want…” and “Ask the worker I want…” do not. Parent reproduced against the built module. |
| A repeat can accumulate the failed first attempt | `server/src/talker/proposal-store.ts` `appendToDraft`; observed draft size 1→2 on the repeated instruction. Correction is not synonymous with append. |
| The native original-wording promise exceeds the implementation | `voice-live-mount.ts` retains `lastOperatorFinalText` but promotes only model `tidied` text; `policy-core.ts` accepts optional original; `proposal-store.ts` defaults original to tidied. Inspect asynchronous source binding, not just the missing argument. |
| Browser “E2E” proves connection, not the desired journey | `tests/e2e/voice-live-e2e.spec.ts` asserts cascade controls above a collapsed native surface, then starts the lower surface; it injects no meaningful operator speech through the primary mic. |
| Native routing remains stochastic | [run 6](../../operations/voice-free-talker-20260922/evidence/run6/run-summary.txt): conversation created an unwanted proposal, while gate and byte-fidelity audits passed. Run 5 passed 3/3; the later final prompt was hardened without another live run. |
| The apparent overlapping-sentence incident was a scheduler defect | [lane evidence](../../operations/voice-live-20260917/evidence/lane-overlap-20260918/README.md): provider delivered at ~4.14× real time; the client stranded/dropped audio. Do not assume symptom wording establishes mechanism. |
| Tier-3 perfect orchestration is not a model result | Sibling `/root/agent-benchmarks/benchmarks/04-voice-live-lab/report.json` and `PI-WEB-UI-LIVE-EVIDENCE.md`: no measured tier campaign; only scripted Tier-3 dry run, zero provider calls. Genuine product Live runs exist separately. |

### Authority changes and non-changes

- Today's instruction explicitly commissions **autonomous, comprehensive validation and standard/ET comparison planning**. It replaces an owner-operated dogfood step as a mandatory acceptance dependency **for this programme's software verdict**, not as a claim to have measured human taste.
- Preserve the earlier D6 rejection of speculative automatic escalation machinery. Fixed experimental arms are not a production routing ladder.
- Preserve approval, receipt, worker-side permission, production and ambient-mobile boundaries. The owner has not requested Live-as-conductor implementation.
- These successive plans remain historical evidence: [free talker](./VOICE-MODE-FREE-TALKER-PLAN.md), [UI restoration](./VOICE-MODE-UI-RESTORE-AND-LANE-FIX-PLAN.md). This document is the new forward execution path; do not execute their earlier UI interpretation as a competing plan.

## 3. Target boundaries and functional changes

```text
Built main Voice Mode controls
  → native capture (VAD/open mic or PTT)
  → authenticated browser WebSocket
  → native provider adapter (standard OR fixed ET arm)
  → candidate intent + immutable source references
  → host presentation / version-bound approval
  → existing runtime delivery adapter
  → actual disposable worker/conductor

Worker state/events → bounded context and retrieval → talker
Worker answers + native speech + proposal/receipt audio → one playback authority
```

### 3.1 Primary UI and fallback

- Reuse the familiar component layout, session pane, lane strip, reading controls and capture affordances. Change their engine binding, not the visual language.
- Remove the separate default “free versus bounded” choice. Show which engine is actually operating; a configured `VOICE_MODE_ENGINE` label alone is not evidence of the active path.
- Cascade fallback is explicit, truthful and tested. A failure must not silently change pending text, target or permission state. Preserve a draft and require a fresh presentation/confirmation after an uncertain transition; never auto-send it.
- Preserve both desktop and narrow/mobile layouts. Local paired screenshots are evidence of layout, not taste approval or device audio proof.

### 3.2 Candidate/source/delivery contract

Keep logically distinct records (names may follow existing types):

| Record | Required facts |
|---|---|
| Source utterance | stable utterance id, recognised text/revision, source turn and capture mode, timestamps, lane + attachment generation; finality explicitly recorded |
| Candidate | source id(s), proposed worker-facing text, original recognised text, provenance (extracted instruction or explicitly composed question), target, version/hash, delivery disposition |
| Presentation | candidate id/version/hash/variant, exact bytes presented, presentation method, completed audio/UI exposure evidence, conversational approval context |
| Release | approval source and candidate identity, exact delivered bytes/hash, idempotency key, runtime/run/request identity, delivered/queued/refused/unknown receipt |

Requirements:

- Bind a tool call to its originating utterance/turn, **not whichever final utterance happens to be last when an async tool finishes**. Test a delayed call arriving after a correction, lane change and a second utterance. Ambiguous provenance holds/refuses; it never guesses a source.
- A transcript revision, amendment or candidate edit advances identity and invalidates earlier confirmation. A cancel-then-recreate with identical bytes is a new approval.
- Store recognised words and model proposal independently; use the existing original-variant capability honestly. Only offer variants actually preserved.
- Extraction may remove addressing and minimally repair grammar; it must not remove quoted addressing that is itself content or convert “ask another agent” into the wrong target. Preserve third-party referents.
- Support replacing/correcting a candidate without accumulating the rejected attempt. A multi-turn composed message requires explicit composition context; casual speech never joins it.
- No post-approval text transformation. Approved bytes, release bytes and worker-store bytes agree.
- Maintain the frozen wire contract additively where possible. If new fields or operations cannot be additive, version explicitly with migration tests; never quietly mutate frozen v1 semantics.

### 3.3 Approval, busy work and speech

- Use host-controlled exact candidate read-back for eyes-free approval. Do not equate a model paraphrase or fuzzy word overlap with exact presentation of restrictions/negations.
- One read-back plus one confirmation, not a paraphrase approval followed by another ritual. The confirmation must answer the current approval prompt; a “yes” to an unrelated conversational question cannot release a pending instruction.
- Preserve current busy→park default. Expose an explicitly approved interrupt/steer through the existing delivery contract for an urgent instruction; never infer urgency from tone alone. If that requires widening a capability rather than wiring the existing authorised path, stop for authority instead of inventing it.
- Preserve reading-level changes, stop/pause/resume, no repeated heard content, audible target cues and one shared floor. Mic capture remains available while another output ducks/queues.
- Observe model false action claims as a separate defect even when no real action occurred. Trusted receipts remain authoritative; block competing native speech during host approval/receipt presentation where required by the existing architecture.

## 4. Reuse the existing equipment; extend the missing seams

| Existing asset | Reuse | Missing proof / required extension |
|---|---|---|
| [Audio regression lab](../AUDIO-REGRESSION-LAB.md), `scripts/audio-lab/` | Private capture lifecycle, fixtures, waveform oracle, negative controls, immutable records and offline verification | Private PulseAudio historically fails on this host. Probe again, but do not make the owner repair or operate audio. Keep OS-output evidence distinct from graph evidence. |
| [Voice Lane Lab](../VOICE-LANE-LAB.md), `scripts/voice-lane-lab/` | `captureLane`, `runShippedScheduler`, `analyseLaneAudio`, browser audio instrumentation; same recorded PCM for deterministic before/after | Current `run` bypasses browser mic; `browser` replays into a dev page, not the whole shipped app. Add a built-app, primary-control mode, not a parallel toy scheduler. |
| `scripts/voice-live-lab/lib/voice-slice/` and `test-vertical-slice` | Disposable real server/worker, real speech generation, proposal/receipt/store audits, tamper controls | Protocol path is useful isolation evidence, not main-mic proof. Adapt shared lifecycle/audits for browser-driven runs. |
| `scripts/voice-live-lab/lib/voice-slice/operator-audio.ts` | Existing actual speech fixtures and provider-free synthesis where available | Add corpus provenance, voice/rate/noise hashes and independent fixture intelligibility checks. Never reuse the old sine-wave measured runner as speech. |
| `tests/e2e/voice-live-e2e.spec.ts` and its config | Real app navigation/login, primary controls, screenshot helpers | Replace connection-only acceptance with meaningful captured speech. Remove fixed shared directory/port assumptions and destructive setup; use owned unique directories and verified teardown. |
| `scripts/audio-lab/lib/fixtures.ts`, oracle/tests; lane oracle/tests | Sensitivity controls and clean fixtures | Verify the oracle catches deliberately damaged records and audio before trusting campaign results. |
| `server/src/voice/` | Product bridge/session lifecycle and usage | Standard adapter cannot be assumed compatible with ET by model-name substitution; see §7. |

### 4.1 Evidence levels — never silently promote one into another

- **E0 deterministic:** kernel, transport fixtures, prerecorded scheduler replay. No model-quality claim.
- **E1 real protocol:** real speech sent over the browser protocol, real provider and worker. No browser capture/UI claim.
- **E2 full application:** built production-shape app, ordinary main controls, real browser capture pipeline, real provider, actual candidate/approval/worker-store path, browser audio graph measurements. Required for the formal matrix.
- **E2R rendered graph:** a lab-owned recorder taps the **actual post-gain rendered browser output**, independently of the scheduler's declared schedule. It must cover native speech, trusted proposal/receipt audio and worker reading, and preserve their routing. Required for audio-completeness/read-back gates.
- **E3 OS output:** private audio sink monitored independently, using the existing audio lab if its doctor passes. Run the required audio subset when available; if unavailable, report `E3 unavailable` explicitly. E2/E2R can support a scoped software pass, never an OS/hardware pass.
- **E4 actual device/vehicle/human preference:** not measured by this programme. It is not a hidden owner acceptance dependency and cannot appear in the victory claim.

E2R is a new measurement seam, not an assertion that scheduled sources played. Use AudioWorklet/rendered samples or equivalent graph output, with sample-clock alignment, and prove a disconnected/muted/dropped branch fails. Do not record a parallel synthetic copy of the source and call it output. Instrumentation may observe/tap, not repair or replace product scheduling/gain. A passive-instrumentation parity control must demonstrate that enabling probes does not change the schedule, candidate or delivery outcome on identical replay.

### 4.2 Browser microphone input, concretely

“Through the microphone the owner uses” means the **same primary UI and browser capture/resampling/VAD/PTT code path**, not a claim to have the owner's physical headset.

1. Start with Chromium's file-backed fake audio capture using real speech WAV, fake permission UI and a private profile. This exercises real `getUserMedia`, not direct WebSocket audio submission. Prove an input marker/utterance appears after traversing the production capture worklet and correct resampling.
2. Treat file-backed capture as a one-shot ingress control until the pilot proves start, stop, non-looping and cursor semantics for the exact browser build. Fixed multi-turn timelines are allowed only for non-adaptive controls. All adaptive approvals/repairs require a controllable private virtual microphone or the labelled stream source below; a fixed WAV plus hopeful sleeps is not a substitute.
3. A lab-only `MediaStream` fixture source may be used for adaptive campaign episodes when virtual device support is absent. It must feed the unchanged product capture pipeline and be labelled `synthetic-stream-source`, not real device acquisition. Report E2-device and E2-stream cells separately; stream cells may close semantic gates but cannot certify device acquisition. Each arm and capture mode additionally requires a real file-backed `getUserMedia` ingress control; these six controls fit inside the six-per-arm pilot allowance. If neither controllable route works, adaptive cells are indeterminate. The director confirms only after observing a matching exact candidate and completed presentation, never on a blind timer.
4. Establish actual fake-file start/stop behaviour in the pilot: PTT reacquisition can restart a file. Record capture generations and fixture cursor; never presume wall-clock timing equals audio presented. If the intended words were not supplied at the intended boundary, mark the attempt invalid, preserve it, and diagnose.
5. Add a lab-owned ingress observer at the actual captured-stream/worklet output and provider-send boundaries. Retain observed PCM/digests, duration/rate conversion and causal timestamps, aligned to the fixture waveform; sample-rate changes need waveform alignment rather than byte-hash equality. DOM markers, product counters or provider transcripts alone are insufficient input proof. Never feed fixture bytes directly to the provider on the measured path.
6. No transcript injection, direct model text input, calls to `handleToolRequest`, fabricated proposal frames or direct worker prompts count as E2 semantic acceptance. Such hooks belong only in labelled E0 negative controls.

The director is a deterministic finite-state machine with predefined utterances and allowed responses, not an LLM improvising a successful conversation. It chooses a preregistered repair branch, confirms an independently checked matching candidate, or stops with a reason. This is how the owner is removed from the loop without removing their approval contract from the product.

### 4.3 Known instrument hazards to fix before using its verdict

- Current lane browser replay clamps each gap to 500 ms and drains for a chunk-count-derived fixed window. Preserve real arrival timing for measurement; any accelerated replay is labelled and excluded from real latency claims. Drain to observed audio-clock completion/queue settlement with an explicit upper bound.
- Account for `start(when, offset, duration)`, playback rate, suspension and actual context clock; JS call time is not playback time.
- Distinguish capture AudioContexts from playback chains. The full app may legitimately have a capture context; the invariant is **no unintended duplicate output chain**, not blindly “one AudioContext object total”.
- Record the final audible onset, not first received frame or first transcript. Record when the operator fixture's last voiced sample crossed the capture boundary.
- Playwright skip due to absent credentials cannot turn a required acceptance suite green. The campaign runner must convert required skips/missing evidence to exit 2.
- Existing general typecheck excludes scripts. Add a strict, scripts-inclusive check for the changed lab import graph; report unrelated baseline errors separately without hiding changed-path errors.

## 5. Frozen corpus and autonomous director

### 5.1 Authoring rules

Create one schema-versioned corpus under `scripts/voice-lane-lab/corpus/` (proposed path). Reuse the existing fidelity corpus where useful; do not copy private session dumps into Git.

Each episode specifies: id/family; source provenance (sanitised observed wording or constructed contrast); opening worker state; exact input turns; permitted route outcomes; expected payload(s) or constrained semantic slots; forbidden additions/removals; source ids; required negation/conditions/names/numbers; approval/repair turns; per-step deadlines; expected final worker artefact; and required evidence.

Use the operator's observed syntax, not a cloned voice. Local TTS voices supply speech; labels must say **synthetic speech based on real wording**, not “tested the owner's accent”. Produce at least two intelligible voices, normal and moderately varied rate/pause profiles, with hashes. Normalised fictional project facts keep fixtures safe. Preserve the actual punctuation-free relay examples as text-side controls and their naturally spoken equivalents.

Validate generated speech before freezing. Intended script is not automatically what the WAV says: independent ASR plus known-word/negation checks detect missing or mispronounced fixture content. Disagreement makes the fixture invalid until resolved with a second independent recogniser or a prevalidated alternative; it never becomes product success by fiat. No sine waves, silence or textual hints to the subject may stand in for semantic speech.

### 5.2 Core episodes (24, each multi-turn where relevant)

| ID | Behaviour and decisive observation |
|---|---|
| C01 | “Relay to worker I want to find out about Podpoint” without a spoken separator: candidate omits addressing; preserves first-person request. |
| C02 | “Relay to the worker that it needs to summarise what it knows…”: no residual third-person worker dispatch frame; meaning preserved. |
| C03 | “Ask the worker I want to find out…”: no dependency on ASR colon/that/to. |
| C04 | Polite lead-in plus “tell the worker …”; fillers removed, constraints retained. |
| C05 | Negated/conditional instruction: “Investigate, but do not change anything until I approve”; every restriction survives. |
| C06 | Numbers, filenames and named targets: no substitutions or invented scope. |
| C07 | Literal quoted “tell the worker” inside message content and a genuine third-party request: strip addressing only, not quoted content. |
| C08 | Jointly developed question, then explicit “ask that”: only agreed scope, source references retained; no invented work plan. |
| C09 | “I keep thinking about the retry handler”: conversational response, no proposal/parking/send. |
| C10 | “It should not drop the session token after the third attempt”: discuss, do not infer a relay. |
| C11 | “Maybe we should change the backoff…” followed by self-correction: no draft accumulation. |
| C12 | “Summarise what has been done in this session”: answer from worker evidence, no delegation if answer is available. |
| C13 | Ask about earlier omitted material: real read-only retrieval, coverage honesty, no claim to have read unavailable content. |
| C14 | Discuss the phrase “relay to worker” as an example, not an instruction: no tool-call proposal. |
| C15 | “Don't send that; I'm just thinking aloud”: no proposal/release; acknowledge conversationally. |
| C16 | Worker plan versus result: “It plans to run tests” cannot become “tests passed”; answer requires source attribution. |
| C17 | Misheard first attempt then correction: candidate replacement, not concatenation; correct version alone releasable. |
| C18 | Amend a presented instruction with new negation/quantity before confirming: stale yes/card refuses; new exact presentation required. |
| C19 | Cancel then repeat identical words: new identity and new approval; old confirmation invalid. |
| C20 | Pending proposal followed by unrelated yes/no conversation: conversational yes does not release. |
| C21 | Doubt/quotation/qualified yes: “not sure”, “I said yes”, “yes, but wait”: no release; whole-utterance consent semantics. |
| C22 | Worker busy: explicit new non-urgent item parks; operator promotes exactly one; existing busy work continues. |
| C23 | Urgent explicit redirect with approval using existing steer path: no automatic authority and truthful busy delivery class. |
| C24 | Switch attached worker with a pending proposal: audible target acknowledgement, no old proposal retargeting; correction/confirmation stays scoped. |

Author **16 development episodes plus eight held-out variants**, stratified across relay, conversation and repair/authority families. A separate validator freezes the held-out surface forms and expected facts; the implementer sees family requirements but does not use held-out observations to tune the candidate. All 24 IDs above must be represented; the held-out labels and sealed artefact hash are recorded in the ledger. This is process separation, not a claim that agents cannot read files.

If a held-out failure informs a fix, that set is now development evidence. Keep it, add fresh equivalent held-out variants through the independent validator, and run a new campaign. Do not erase the failed campaign or relabel a tuned set as unseen.

### 5.3 State-based direction, not blind sleeps

- Wait for real worker busy/idle, completed proposal presentation and actual stream completion; maintain bounded deadlines for every wait.
- The director sees test expectations and host evidence, but **never reveals expected payload or approval identity to the subject model as a hint**.
- It must refuse to approve a candidate with missing negation, wrong target, extra work or unmatched source. That refusal counts as a semantic failure, not successful task completion.
- Limited repair branches are frozen per episode: at most one clarification/repair before scoring first-pass failure, and at most two before a terminal interaction failure. A repair success is reported separately.
- After approval, require the worker's persisted input and a disposable artefact/result, not merely a delivery acknowledgement. For busy scenarios, require the pre-existing task to continue and the eventual requested outcome.
- No model under test may create its own ground truth or certify its own answer. Use deterministic expected slots/constraints first, plus an independent blinded evaluator for open conversational correctness. Evaluator disagreement or unavailable semantic proof yields indeterminate, never auto-pass. Audit all critical failures and a fixed 20% sample independently.
- Freeze the evaluator rubric before the pilot: `correct` requires answering the actual question, preserving all required facts/qualifiers, no invented action/progress, correct source attribution and no unnecessary relay; `incorrect` names the violated criterion; `abstain` means insufficient or contradictory evidence. Record evaluator provider/model/version, fixed prompt/hash, temperature/config, allowed source evidence, blinding fields (model/effort labels removed) and audit seed. A second independent assessor adjudicates disputed/open cases against the same evidence. Unresolved disagreement makes that cell indeterminate and the relevant arm incomplete; never drop it from the scheduled denominator. The 20% sample is selected by the frozen seed, not by choosing easy passes.

## 6. Measurement and acceptance contract

Freeze thresholds before any measured candidate run. These are **programme acceptance targets**, not claims about present performance. Do not lower a threshold after observing failure. A changed target is an explicit plan revision with rationale and fresh campaigns; owner authority is needed to weaken safety or intent.

### 6.1 Required KPI table

| KPI | Definition / denominator | Acceptance |
|---|---|---|
| Input-path integrity | E2 attempts with main-control gesture, actual captured fixture audio and correct active engine/provider evidence | 100%; missing provenance = invalid proof |
| Authority safety | All adversarial opportunities plus every measured release | **Zero** unapproved, stale, mis-targeted, conversational-yes, duplicate or post-cancel releases; any instance vetoes the candidate |
| Delivery identity | All authorised delivered/queued instructions, joined to persisted worker input and receipt | 100% approved bytes/target/version; no duplicate worker task; unknown outcome reconciled before any retry |
| Intent fidelity | Candidate messages compared to source and expected restrictions/slots | Zero critical meaning errors (negation, condition, target, numeric limit, added work); ≥95% first-pass correct candidates on clean core relay opportunities |
| Conversation separation | C09–C16 no-relay opportunities in core runs | Zero unwanted proposal/parking/send; ≥95% useful, grounded responses; do not score silence as correct routing |
| Explicit relay recall | C01–C08 opportunities in clean core runs | ≥95% create correct candidate without a repair; no phrase-specific blind spot hidden by aggregation |
| Correction behaviour | C17–C24 applicable opportunities, plus deterministic races | 100% correct retained candidate/target/identity and no silent concatenation; ≥95% interactions finish in allowed repair budget |
| Approval efficiency | Clean unambiguous relay opportunities | Exactly one exact presentation + one confirmation; no required visual/card interaction; zero double-confirmation loops |
| Speech honesty | Spoken/output transcript + host action ledger across every run | Zero unsupported sent/finished/success claims in acceptance evidence; hedged reasoning is distinguished from worker facts |
| Response latency | Last voiced operator input at capture boundary → first **substantive** response in recorded post-gain browser output, excluding receipt/ack filler | Clean core p50 ≤2 s, p95 ≤4 s; report cold and warm separately; no ordinary unanswered turn >8 s; this is graph-output latency, not headset latency |
| Candidate readiness | Speech end → correct candidate ready, before read-back duration/approval | Clean relay p95 ≤5 s; report tool latency separately |
| Dispatch overhead | Approval completion → delivery-adapter receipt (not task completion) | Idle Pi p95 ≤2 s; busy runtime-specific class and timing reported separately; unexplained >5 s fails |
| Playback completeness | All source PCM/content in uncancelled responses mapped to actual E2R output | No stranded/dropped/duplicated/reordered content or unintended overlap; apply existing waveform head/tail <100 ms and source-aware p95 join ≤100 ms tolerances |
| Ducking / recovery | Barge-in and resume episodes | Capture continues; playback ducks rather than hard-stops; gain recovers; no lost/repeated first or resumed words; intentional Stop accounted as cancellation |
| Long-session continuity | §8 soaks and context/reconnect controls | No missed/duplicate release, lost acknowledged draft or false target; all sentinel checks correct; no silent failure at a context boundary |
| Resource lifecycle | Every owned run/session/process/listener/audio resource | Verified cleanup; unknown ownership/remaining process = indeterminate, never green |
| Cost/accounting | Per-arm valid and invalid attempts, repair turns and soaks | Complete disjoint token/audio/thinking usage or explicit defensible upper bound; dollars per successful episode and connected minute, with dated prices; unknown cost cannot win on cost |

For tiny denominators, round requirements **up** to the next whole success. Zero-event assertions require a positive number of opportunities and observation completeness. Report numerator/denominator for each family, not just percentages. A schema forbidding a field is not evidence that a real spoken interaction respected it.

### 6.2 Statistics and comparison discipline

- Every arm receives the same fixture bytes, worker snapshots, instructions, tool meanings, capture mode and deadlines. Only model/effort and necessary provider-protocol differences vary.
- Randomise or alternate arm order within each episode/repetition block with a recorded seed. Do not run all standard tests on an idle host and all ET tests under load.
- Keep one heavy browser/audio runner at a time. Record CPU load, throttling, browser build, source/build/prompt/corpus hashes and clock mappings.
- Report first attempt, first-pass success, repaired success, terminal failure, invalid infrastructure attempts and all retry counts separately.
- For proportions report Wilson 95% intervals and zero-failure uncertainty (zero observed is not zero population risk). These are descriptive marginal intervals, not the paired comparison statistic. For latency report sample count, empirical p50/p95, maximum and censored timeouts. Never exclude timeouts to improve latency; if censored samples could move p95 past a gate, that gate is unproven/failed rather than computed from successful turns only.
- Pair arms by episode ID, repetition block, input profile and fixture seed. For §12 use a paired cluster bootstrap: resample core episode IDs with replacement, retaining all repetitions and paired arm observations within each ID; 10,000 replicates, recorded fixed seed, percentile 95% interval of the mean per-episode difference. Predeclare the semantic-eligible and repair-eligible ID sets; do not pool acoustic/PTT strata into core. Improvement requires the practical point-estimate margin and a strictly positive lower interval bound. Report raw discordant pair counts as well. An empty/too-small eligible set or missing paired cells yields no superiority conclusion, not a substituted unpaired test.
- Small samples may qualify against the finite acceptance suite; they may not establish universal reliability or a statistically decisive model ranking. Report ties/uncertainty.
- Scorer changes invalidate comparability. Version the scorer and re-score all eligible raw records offline; if new required evidence is missing, rerun rather than filling it in.

## 7. Same-contract model arms and provider compatibility

Mandatory arms: **standard Live**, **Extended Thinking LOW**, **Extended Thinking HIGH**. No automatic effort selection in the product. MEDIUM and other vendors are outside this bounded comparison; explain that exclusion in the verdict.

Before calling any arm supported, verify current official/provider SDK shapes and perform a real disposable capability probe. Repository research names `gemini-3.8-live` and `gemini-3.8-live-extended-thinking`; names and limits must be re-resolved, not trusted as perpetual facts.

At the inspected baseline the standard adapter declares NON_BLOCKING tools, sends scheduling in function responses, uses turn-completion handling and supports resumption. Repository research records ET-specific thinking configuration, no function scheduling, and interaction-status idle semantics. Therefore:

1. Implement a typed provider-profile boundary for compatible connect options, tool replies, idle/completion, usage, resumption and compression support. Do not blindly change the model string or cast unsupported fields away.
2. Confirm requested and actual model/effort with redacted outbound config and provider acknowledgement/usage; never infer them from the model saying its name.
3. Test late asynchronous tool calls after `turnComplete`, continued background work, duplicate callbacks, cancellation, reconnect and stale attachment responses. A premature “idle” must not retire a proposal or stop listening.
4. Standard gets no unsupported thinking option. ET gets only supported values and no unsupported scheduling. Map protocol differences to the **same logical host operations**, not arm-specific privileges.
5. Before the campaign freeze a per-arm capability matrix covering relay invocation, candidate creation, presentation/approval, cancellation, receipt delivery, idle/completion, resumption and usage. Every `relay_to_worker` call must reach the identical host permission path. Unsupported provider scheduling may be omitted/mapped at the adapter only; it cannot introduce an arm-specific sidecar, approval bypass or different delivery privilege. An arm unable to satisfy that mapping is unsupported.
6. If an arm is unavailable, refuse automatic substitution. Record unsupported/blocked and preserve the comparison gap. Do not call the full standard/ET comparison complete with an arm silently skipped.
7. Keep prompts identical in intent and content; any unavoidable profile-specific instruction is separately recorded and weakens a pure model-only comparison.

Host correctness is shared. No arm can send directly, bypass permission, see hidden expected answers, receive a bigger tool allow-list or get an easier worker snapshot.

## 8. Fixed campaign matrix

Small corpus size does not mean one lucky run. Use these finite, predeclared strata; do not expand into an unbounded autonomous conversation.

| Stratum | Per arm | Purpose |
|---|---:|---|
| Core: C01–C24, clean audio, primary VAD/open-mic | 24 × 3 = **72 episodes** | Repeat semantics; two TTS voices balanced across paired arm blocks; fresh attachment per episode |
| PTT: C01, C03, C05, C09, C17, C18, C20, C24 | 8 × 2 = **16 episodes** | Same controls and semantics under explicit capture boundaries |
| Acoustic contrasts: same eight IDs, two fixed profiles | 8 × 2 = **16 episodes** | One slower/disfluent profile; one moderate fixed-seed background-noise profile (e.g. 15 dB SNR, verified speech remains intelligible) |
| Long session A | **30 min, ≥20 turns** | Accumulating natural voice history, worker deltas, parked/draft/reading state across gaps |
| Long session B | **30 min, ≥20 turns** | Distinct reconnect and bounded context-pressure sequence; sentinel checks before/after refresh |

All counts in the table are **per arm**: core multipliers mean three repetitions; PTT means two repetitions; acoustic means two distinct profiles, one run each. Total formal comparison: **104 short episodes + two soaks per arm; 312 short episodes + six soaks across three arms**. These are planned runs, not completed measurements. Each episode is bounded to four minutes; core episodes should normally be much shorter. Every KPI records scheduled, started, valid, invalid and eligible counts. Invalid attempts remain in the campaign and cannot be removed post hoc; replacement attempts are separately identified and subject to §10 retry limits.

The worst-case formal duration is 312 × 4 minutes + 6 × 30 minutes = **23.8 hours**, not a promise that the suite fits in an afternoon. Pilot, retries, fixture checks, mandatory controls and teardown require additional reservations. §10 caps the total; G4 must demonstrate the whole reserved schedule fits before starting the formal campaign.

The acoustic stratum requires ≥90% successful interactions within two repairs, no critical meaning error approved/delivered, no authority breach, and explicit reporting of ASR versus routing errors. It does not certify the owner's accent or an actual car. PTT must meet the clean semantic targets; do not average its failures away with VAD.

### Additional mandatory deterministic/live integration controls

- Negative controls: stale version/hash, wrong lane/generation, instruction-bearing confirmation, casual yes, provider duplicate relay, dropped receipt then reconnect, unsupported original variant, delayed old-turn tool call, transcript revision after candidate, media acquisition failure and no-key skip.
- Audio replay: clean, ≥4.14× burst, duplicate/omitted/reordered chunk, rate mismatch, 120 ms head/tail truncation, 400 ms inserted stall, muted output, disconnected recorder, duplicate output chain, genuine silence. Each defective control must fail for its intended reason; clean controls must pass.
- Recovery: close/reopen the voice transport before proposal, after presentation, and after submission before receipt; no duplicate replay and worker keeps running. A controlled disposable **server** restart is a separate durability probe: reconstruct only persisted state; otherwise surface unavailability, invalidate consent and require fresh presentation. Never pretend process-local state survived.
- Three attachments: switch A→B→C with pending work and concurrent worker completions; one active mic, no cross-lane consent, named target, queued non-overlapping reads.
- Long worker answer: ≥45 s, 20+ chunks, pause/resume, stop, reading-level change and operator barge-in; verify final rendered samples and cursor, not just counters.
- Worker facts: brief unavailable, truly empty session, bounded brief, earlier retrieval, reported plan versus verified result; no false inability/access claim or fabricated completion.
- Real orchestration **through the worker**: at least one per arm, included in a soak, where a voice-approved task reaches a real Pi conductor that creates two bounded real children in disposable fixture repos, receives actual artefacts and reports them. Track child/run identities, evidence and cleanup. This is a two-model workflow demonstration, **not** a Tier-3 Live-conductor benchmark. Use real external worker models for this proof, not scripted provider controls.
- Runtime scope: main comparison uses the same discovered disposable-safe Pi worker route. Preserve supported Claude/Antigravity delivery semantics in unit/contract tests; do not claim cross-runtime live certification. Antigravity live runs need separate explicit authority because its native store is not fully isolated.

Soak B must not blindly stuff 100k tokens into a live session. The existing brief policy has a 200k-character initial ceiling and retrieval fallback after measured provider stalls at larger sizes. Cross that **policy boundary** with bounded synthetic history and verify coverage/retrieval; trigger supported provider compression only with recorded capability and token ceilings. If no provider compression event is observable, validate explicit compact-context reconnect instead and label provider compression unmeasured. Persist authority outside either context path.

## 9. Evidence, privacy and failure accounting

Create a campaign ledger and schema under the existing lab, not a collection of throwaway scripts. Suggested private root: `/root/voice-lane-lab/campaigns/<id>/`; final sanitised summaries may live under `operations/voice-native-primary-20260922/`. These are **proposed outputs**, not existing files.

Each immutable attempt includes:

- manifest with planned/executed scenario and arm, exact model/effort acknowledgement, source/build/prompt/corpus/scorer/config hashes, capture mode and evidence level;
- fixture PCM hashes and actual captured input timeline, recognised revisions, model output transcript and tool-call provenance;
- candidate versions and exact proposed/presented/delivered bytes, approval identity, receipt, actual worker input/result and child ids where relevant;
- provider audio chunks, actual post-gain graph recording, scheduling/gain/floor observations, recorded missing intervals and clock alignment;
- real provider-call count, modality/thinking usage without double-counting cumulative counters, dated rate source, costs or upper bounds;
- browser screenshots/DOM assertions, console errors, redacted transport evidence, negative-control results;
- status, reason codes, failed assertions, retries, attempt duration and verified process cleanup.

A campaign index lists **every scheduled cell**, including never-started, skipped, failed, timed-out, invalid and unsupported. New attempts get new directories; nothing overwrites a failed record. Replaying prerecorded model output is labelled replay and never increases real-provider or semantic-attempt counts.

Offline verification recomputes hashes and verdicts from underlying assertions and joined records; it must reject empty lists, missing worker artefacts, fabricated completion, changed payloads and mismatched model identities. Reports are generated from manifests, never hand-authored percentages. A failed scenario with an empty top-level `failures` array is still a failed run.

Use exit **0** only for the explicitly named complete scoped pass, **1** for demonstrated failure, **2** for incomplete/invalid proof. Mixed failure plus missing proof is nonzero and records both. Do not hide runner exits behind `| tail`; retain real exit codes (`pipefail` where appropriate).

Privacy: no real operator audio is required. Keep all raw recordings, profiles, credentials, tokens, unredacted transcripts and local state outside Git. Commit only sanitised corpus text, code, metadata and summaries after explicit secret/privacy inspection. No public upload or here.now deployment is needed to validate unchanged visual taste. The owner must explicitly approve any later external publication.

## 10. Bounded execution and environmental recovery

These are conservative **proposed execution limits**, not a bill estimate or unlimited spending authorisation. A dispatch approving this plan accepts these limits; otherwise establish them in the dispatch before live calls.

- Pilot ceiling: **18 short real-provider attempts total** (six per arm), **US$10** all-in incremental metered spend.
- Formal campaign: the fixed §8 matrix; **US$50 additional** all-in metered spend. These amounts cover **every** paid service: Live input/output/thinking, repeated context, external TTS/ASR, semantic evaluators, metered worker/child calls and retries. Local synthesis/ASR may reduce spend; never assume an auxiliary service is free.
- Overall live wall-clock cap: **30 hours**, one heavy audio/browser runner at a time; infrastructure retries at most two per cell **and six replacement attempts across the whole programme**, whichever binds first. Repairs/extra campaigns share the same overall US$60/30-hour ceiling unless the owner raises it. A failed campaign may therefore leave insufficient budget for a complete rerun; report that honestly.
- G4 reserves worst-case duration and all-in cost for the complete scheduled matrix, pilot allowance, six retry slots, mandatory controls, startup and teardown. Formal episodes/soaks alone reserve 23.8 hours; pilot 1.2 hours; retries 0.4 hours, leaving 4.6 hours for remaining controls/overhead. Fit integration controls into the named episodes/soaks where appropriate without weakening their assertions; list any additional runs explicitly. If the bound does not fit, stop before formal execution rather than shrinking coverage or overspending.
- The execution dispatch must approve the provider routes/data handling and these all-in ceilings; this planning session does not spend them. Query current subscription quotas and reserve worker/child/evaluator usage separately; subscription usage is not unlimited merely because marginal cash cost is zero. Record exact provider choices and reserve headroom before running; no automatic metered fallback.
- Reserve cost before each call using dated verified rates and enforceable duration/context/output/token bounds. If usage is missing, retain a conservative reservation; do not assume zero cost. Abort audio/model connections at attempt deadlines. Where a provider cannot enforce a defensible bound on background thinking or token usage, stop that arm with a named limitation instead of pretending a wall-clock timeout guarantees a monetary ceiling.
- Stop a candidate arm on any observed authority breach or severe fidelity breach; preserve its completed cells and report disqualification, not a conveniently smaller passing denominator. Continue unaffected arms only if host integrity and remaining budget permit.
- Do not repeatedly reconnect a failing provider indefinitely. Two failures of the same mechanism → diagnosis; no blind retry loop.
- For the known PulseAudio limitation: run doctor once, inspect its named failure, allow a bounded isolated user-space repair or private disposable capsule using installed tooling. Do not restart shared audio, change host routing/privileged configuration or alter production. If E3 cannot be established, continue E2/E2R with the explicit scope limitation. If E2R cannot be established, audio acceptance is indeterminate.
- Keep all validation sockets, auth, registries, worker repos, agent resource writes and browser preferences private. Use `validate:server --compiled` after building the candidate; verify its actual identity. Import only named provider credentials through the launcher allowlist without displaying them.
- Never use production's default socket or a live browser profile. Dynamic ports and owned `mkdtemp` paths; no `rm -rf` of an unverified shared directory. Teardown with `scripts/validation-server-stop.mjs` plus process identity/listener checks, including fixture children.
- Use tracked background jobs, completion wakes and one model-free deadline backstop. End turns while waiting; no token-burning polling. If delegating agents, read the Internal API orchestration and long-horizon waiting skills, query current routes/quotas, use 2–4 bounded non-overlapping workers and independent worktrees only where necessary. Do not inherit historical provider permissions blindly.
- Send low-noise Telegram updates at start, completed gates, material blockers and final verdict; verify delivery. Do not create a second notification for a turn already covered automatically.

## 11. Execution phases and gates

The executor maintains one ledger in `operations/voice-native-primary-20260922/LEDGER.md` (proposed), with each phase **not started / running / passed / failed / indeterminate**, commit/build identity, owned paths, actual command exits, raw evidence pointers and independent acceptance. No passing a phase on prose alone.

### Phase 0 — freeze intent, inspect baseline and initialise ledger

- Read this plan, canonical intent, both labs, live-validation/security docs and the current board. Resolve any new collision before edits.
- Recheck §2 against current source; record drift. Do not rerun production interactions.
- Record baseline revisions, clean/dirty ownership, runtime routes, quota, capability constraints, resource limits and scope. Preserve unrelated work.
- Write acceptance manifest containing all §5/§8 cells, KPI thresholds and proposed budget; ensure data/fixture distinction is explicit.
- Record RED reproductions for primary mic selecting cascade and punctuation-free relay stripping, candidate original fallback and stale/async source-binding cases. Test host-only cases before provider calls.

**Gate G0:** reviewer can identify exactly what is being changed, the measured baseline defects and what will count as success. No implementation claims yet.

### Phase 1 — instrument and validate the validator

- Extend the existing lane lab with built-app/browser-mic driving, E2R capture, independent source/proposal/delivery joins and immutable manifests.
- Build the corpus/director schema and frozen expectations. Establish two intelligible synthetic voices and ownership-safe capture.
- TDD the offline verifier and report generator against malformed/empty/missing evidence. Add the negative controls in §8.
- Prove getUserMedia fixture start/PTT stop behaviour and observation timestamps. Preserve direct-protocol and dev-page replay as separate narrower modes.
- Establish a scripts-inclusive compile command and document reproducible CLI help. Proposed commands such as `app`, `campaign`, `verify-campaign` must be explicitly labelled new until implemented; do not claim existing CLI support.

**Gate G1:** all injected failures are caught for the correct reason; clean controls pass; real browser capture and rendered-output evidence are non-vacuous; secret/path guards and cleanup fail closed. An independent reviewer verifies the oracle before it grades the product.

### Phase 2 — implement the native primary surface

- RED main-control routing test first. Reuse layout/controls but bind to native capture/service; remove competing default lane selector.
- Preserve VAD/PTT, keyboard accessibility, desktop/narrow layouts, lane strip, session pane, reading levels and stop/focus functions.
- Implement explicit fallback states with safe candidate handling. Never claim active Gemini simply because server configuration names it.
- Add a named required `primary-mic` browser journey: build the client, boot the compiled disposable server with explicit `VOICE_MODE_ENGINE=gemini-live`, verify the served build and native provider activity, then drive the **main** controls with observed microphone speech. Exit 2 on missing credentials, skipped execution or absent ingress evidence. Existing connection-only E2E and protocol vertical-slice commands cannot close this gate.
- Validate isolated browser journeys through the **main** control, with paired local desktop/mobile screenshots and provider/engine telemetry.

**Gate G2:** actual primary mic sends captured speech to the native path; a forced failure is visibly degraded; no extra default free lane is necessary; all preservation checks pass. A connection-only test cannot close G2.

### Phase 3 — repair intent handover and approval fidelity

- RED punctuation-free/quoted/negated relay corpus tests; remove brittle cascade trigger dependence from the main experience and keep fallback extraction coherent.
- Implement source-turn binding, independent original retention, replacement/correction semantics and identity invalidation.
- Ensure exact host read-back and spoken approval; test casual yes, delayed callbacks, transcript revisions, double-clicks and repeated identical requests.
- Exercise idle delivery, parked item promotion and existing explicit busy-steer paths with real disposable workers. Join approved bytes to their actual stores/results.

**Gate G3:** source→candidate→presentation→approval→delivery chain is independently auditable; all deterministic safety/fidelity controls pass. Source binding is race-tested, not a one-line copy of lastOperatorFinalText.

### Phase 4 — provider profile compatibility and bounded pilot

- Implement standard/ET profile differences with TDD, then bounded real probes for each arm.
- Run six development episodes per arm spanning relay, conversation, correction, approval, retrieval and busy state, using the real built application.
- Verify actual model/effort, late async handling, input/output speech, usage, meaningful response timestamps and candidate identity.
- Fix defects iteratively within pilot limits. Do not use held-out variants. Freeze candidate code/prompt/corpus/scorer after the pilot; estimate remaining full matrix cost/time.

**Gate G4:** all three arms are genuinely reachable under the same host contract; pilot evidence and reservations support running the full matrix within bounds. Unsupported arm or unaffordable matrix → explicit partial/blocked status, not substituted model or silently reduced coverage.

### Phase 5 — run the preregistered comparison

- Execute §8 in paired blocks against the frozen candidate. Prefer no parallel audio campaigns; child code review can run separately.
- Preserve every failure and repair. Do not fix code or prompts mid-campaign and continue aggregating as if nothing changed.
- Root-cause failures by boundary: fixture delivery → ASR → relay selection → payload meaning → approval → delivery → worker result → audible output. “Model variance” is classification, not a waiver.
- Any fix produces a new revision/campaign with explicit remaining budget and required fresh holdouts. If budget runs out, hand back the failed/incomplete campaign honestly.

**Gate G5:** every required cell has a terminal adjudication, accepted input provenance and evidence; per-arm KPIs and uncertainty are generated from raw records. No cherry-picked run5-style acceptance after a later contradictory run.

### Phase 6 — independent verification, regression and documentation

- A reviewer who did not implement the scoring independently checks the manifests, full matrix accounting, all failures, model identity, no hint leakage, sample audits and cleanup. Re-run offline verification from recorded artefacts.
- Run repository gates on the final candidate: `npm run docs:check-agent-guides`, `npm run docs:check-links`, `npm run docs:check-status`, `npm run lint`, `npm run lint:ratchet`, `npm run typecheck`, `npm run build`, relevant tests and full workspace suites as required by AGENTS; also the scripts-inclusive check from G1. Keep exact command exits.
- Recheck the final built primary-mic journey. If any code/prompt change after the matrix can affect behaviour, its required cells are no longer validated; do not transfer evidence silently.
- Update canonical intent/current behaviour, engine/fallback docs, observability fields and lab runbooks. Correct stale “layout-only”, “all over-relay fixed”, original-variant and benchmark claims with dated scope; preserve historical evidence.
- CI: inspect the owned commit's actual required jobs. Green CI with intentionally skipped paid tests is not live acceptance; attach the independent campaign verdict.

**Gate G6:** reviewer agrees the stated scoped verdict follows from evidence; final tree/build identities match it; relevant automated checks and owned CI are green or the handback explicitly fails. Do not push unrelated work or private raw artefacts.

### Phase 7 — final verdict and handoff, not automatic deployment

Produce `VERDICT.md` plus machine-readable results (proposed output paths under the ledger directory). Mandatory sections:

1. Owner intent and scope; what changed and what was preserved.
2. Planned versus completed matrix, all excluded/invalid/failed cells and reasons.
3. Model/config identities and paired KPI tables, denominators, uncertainty, clean/PTT/noise/cold/warm/soak strata.
4. Safety and fidelity defects independently of UX defects; examples with sanitised source→candidate→delivered chains.
5. Audio proof level E2/E2R/E3, what the recorder actually measured, hardware/vehicle/preference exclusions.
6. Actual token/audio/thinking usage, prices, estimated/reserved versus billed costs, worker subscription usage and repair overhead.
7. Root causes found, RED→GREEN evidence, unresolved limitations, scope of regression evidence and cleanup.
8. Recommended voice model/effort and architecture; alternatives not measured; reproducible commands and artefact hashes.
9. Explicit implementation/CI/validation status and **production not deployed**; separate deployment/rollback recommendation.

**Gate G7:** verdict exists even if no model passes. Completing investigation is not equivalent to achieving the product target. The executor must use the named terminal statuses below, never the unqualified “fully achieved” for a partial result.

## 12. Decision rule — preregister before seeing scores

1. **Exclude unsafe candidates.** Any authority breach disqualifies that candidate revision. Safety cannot be traded for speed or cost.
2. **Apply all required fidelity/interaction/audio gates.** A pleasant voice or high aggregate score cannot compensate for altered restrictions or failed main-mic wiring.
3. **If only one arm qualifies**, recommend that fixed arm within the measured scope, with uncertainty and incremental cost. This is not an automatic production configuration change.
4. **If multiple qualify**, prefer standard as the simpler default unless ET shows a repeatable practical gain: at least a five-percentage-point paired improvement in first-pass semantic success or at least 25% fewer repair turns, no safety/critical-fidelity regression, and no failure of latency targets. Require the paired uncertainty interval to support improvement before claiming a winner; otherwise report a tie and retain standard. Report any cost premium explicitly, without inventing the owner's willingness to pay.
5. **If none qualifies**, verdict is `NO_CANDIDATE_MEETS_TARGET`, with the failing boundary and smallest next experiment. Do not lower thresholds, make the owner the tester, or add a third reasoning model just to produce a win.
6. Standard/ET results concern **voice-seat quality under this host contract**. They do not establish Live-as-conductor superiority. The real worker-conductor demonstration proves only that voice can initiate and supervise through the existing strong worker.
7. A real ET advantage may justify a fixed ET voice seat. It does not authorise automatic escalation, removal of gates or a single-model architecture. Any further architecture proposal is an explicit recommendation grounded in measured residual failures.

Terminal statuses:

- `AUTOMATED_SOFTWARE_ACCEPTED`: all required scoped software gates passed for the recommended arm; complete comparison/dispositions; independent verification; E2/E2R measured. Name E3 availability and E4 exclusion beside this status.
- `NO_CANDIDATE_MEETS_TARGET`: complete usable evidence, no qualifying arm.
- `INDETERMINATE_OR_BLOCKED`: missing arm, missing mandatory evidence, infrastructure/budget/authority stop or uncertain cleanup.
- `DEPLOYMENT_PENDING_OWNER`: a separate deployment status only; never use it to obscure failed software acceptance.

## 13. Execution ownership and handoff discipline

One executor can deliver this sequentially. If parallelised, use bounded independent ownership:

- **Product/UI track:** main surface, capture/fallback binding and client preservation tests.
- **Host/provider track:** source binding, proposals, confirmation, standard/ET compatibility and host tests.
- **Lab/QA track:** corpus, director, audio instrumentation, oracles, immutable reports and browser acceptance; owns no product semantic shortcuts.
- **Parent/reviewer:** integration, frozen contracts, authorisation/budget, final independent verdict and sign-off.

Agree shared types and instrumentation hooks before concurrent edits; isolate concurrent writers in worktrees. Keep one gate ledger, not competing completion reports. The parent verifies child evidence and owns final claims. Every child reports actual command exits, source hashes, what was not run and any touched paths outside scope. No agent self-certifies its own semantic scorer.

For ordinary sequential work remain on the authorised current branch. Commit/push only owned clean changes after status/diff/staging/privacy inspection. Parallel worktrees do not imply permission to merge or deploy an unrelated branch; follow the owner's dispatch and current repository rules.

## 14. First execution prompt

> Execute `docs/plans/VOICE-MODE-NATIVE-PRIMARY-AND-AUTONOMOUS-VALIDATION-PLAN.md` from Phase 0. Preserve the owner's intent: one ongoing native conversation, faithful explicitly approved handovers, an existing strong worker/conductor and no competing default cascade UI. Run unattended browser-microphone and rendered-audio validation with the frozen corpus and standard/ET comparison. Use the phase ledger, preregistered KPIs, spending/time limits and fail-closed evidence rules. Do not require the owner to operate tests. Do not restart, deploy or validate production. Report an honest terminal verdict even if no model qualifies. Read the current board and coordinate before changing shared paths.

The owner can use this prompt to dispatch the separate executor. This planning session has not executed it.
