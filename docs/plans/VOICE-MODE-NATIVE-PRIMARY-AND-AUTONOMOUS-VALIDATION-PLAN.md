# Voice Mode — one native conversation, autonomous validation, evidence-based model choice

> **Class:** execution plan and acceptance contract.
> **Status:** planning complete; execution NOT started. Written 2026-09-22 at baseline `86b91674`; **revised 2026-09-22 (scaled down)** per owner direction at `5c3d795b`→this revision.
> **Owner instruction:** write a plan for a separately dispatched execution agent; remove the owner from routine testing, reuse the audio/lane labs, compare standard Live with Extended Thinking under the same host contract, and end with a measured architecture verdict. **Revision instruction (2026-09-22, later the same day):** the first draft's campaign (312 episodes, six 30-minute soaks, 30-hour wall-clock, US$60) is far too heavy. Do much less testing, no 30-minute sessions, avoid over-engineering, keep the core of the fix, and keep iterative live validation (data → fix → data → fix) as the working mode.
> **Discovery:** [Voice Mode index](../VOICE-MODE-INDEX.md) → **this plan** → phase ledger and evidence created by the executor.
> **Intent sources:** [canonical intent](../VOICE-MODE-INTENT.md), [architecture of record](../VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md), and the owner's 22 September direction recorded below.
> **Authority:** this document is a plan, not a claim about shipped behaviour or permission to restart production. An owner dispatch approving this plan starts execution. Merely discovering it does not.

## 0. Executive brief for the execution agent

**Deliver one natural voice conversation that remains available while a strong worker works or orchestrates. A relay is an explicitly approved action within that conversation, not a second conversation mode.**

Keep the familiar main Voice Mode controls, but make them operate the native Live engine. Do not restore the old cascade behaviour merely to preserve its layout. Keep the cascade as an explicitly labelled degradation, not a competing default surface. Preserve reading levels, ducking, push-to-talk, multi-worker attachments, honest receipts and existing worker permissions.

The native model interprets language and prepares a candidate. The host owns source binding, proposal identity, presentation, confirmation, delivery and receipts. The existing attached worker remains the executor or conductor; do not insert a third permanent reasoning agent or grant the voice model child-spawning authority.

**Work in two modes, in this order.** First a **fix loop**: a small dev corpus run against the real built application through the real browser capture path — observe, root-cause by boundary, fix, re-run. Most defects are deterministic or E0-cheap; the loop is where the product gets fixed. Only when the dev set is repeatedly clean, run one **small frozen comparison** (standard vs Extended Thinking) and write the verdict. The comparison is a decision aid for the voice seat, not a reliability census.

**Do not call this done because:** the socket connects; the model speaks; unit tests pass; one stochastic attempt passes; a scripted conductor scores 100%; the confirmed bytes reach the worker; or a model says it obeyed. Each proves a different, narrower thing.

### What this revision changed, and what it kept

Kept in full: the owner intent (§1), the candidate/source/delivery and approval contract (§3), native-primary wiring, real browser-microphone validation, negative controls, immutable evidence, exit-code discipline, and the honest terminal verdicts.

Scaled down: two arms instead of three (ET-low is a named follow-up); 32 short episodes (24 priority + 8 holdout) + two 10-minute soaks instead of 312 short episodes + six 30-minute soaks; one optional noise spot-check instead of an acoustic stratum; a 4-ID holdout instead of 8; raw paired counts with a tie-default instead of bootstrap machinery; rendered-audio evidence best-effort via existing lane-lab instrumentation instead of a mandatory new measurement seam. Ceilings: **8 hours live wall-clock, US$25 all-in** (§10). Acceptance targets are stated at the measured scale (§6) rather than pretending population-level percentages.

### Scope and authority on dispatch

| Included after explicit execution dispatch | Not authorised by this plan |
|---|---|
| TDD product repairs; isolated browser/server/runtime validation; real provider calls within §10 limits; read-only history retrieval; fixture worker tasks confined to disposable repositories; documentation and final analysis | Production deployment, restart, production validation, real-session prompting, editing production env/config, shared desktop/audio changes, publishing reports or recordings, real external business actions |
| Same host permission contract for standard Live and ET experiments | Automatic reasoning escalation, Live-as-conductor implementation, removing per-instruction approval, changing duck-never-stop policy, extending work to a native mobile application |
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
| Native routing remains stochastic | [run 6](../../operations/voice-free-talker-20260922/evidence/run6/run-summary.txt): a thinking-together turn created an unwanted proposal, while gate, byte-fidelity and tamper-refusal audits all passed. Run 5 passed 3/3; the prompt was hardened without another live run. This is the primary defect the fix loop must drive to zero. |
| The apparent overlapping-sentence incident was a scheduler defect | [lane evidence](../../operations/voice-live-20260917/evidence/lane-overlap-20260918/README.md): provider delivered at ~4.14× real time; the client stranded/dropped audio. Already root-caused; keep only regression checks here. |
| Tier-3 perfect orchestration is not a model result | Sibling `/root/agent-benchmarks/benchmarks/04-voice-live-lab/report.json` and `PI-WEB-UI-LIVE-EVIDENCE.md`: no measured tier campaign; only scripted Tier-3 dry run, zero provider calls. Genuine product Live runs exist separately. |

### Authority changes and non-changes

- Today's instruction commissions **autonomous validation and a standard/ET comparison**, replacing owner-operated dogfooding as the acceptance dependency **for this programme's software verdict** — not as a claim to have measured human taste.
- Preserve the earlier D6 rejection of speculative automatic escalation machinery. Fixed experimental arms are not a production routing ladder.
- Preserve approval, receipt, worker-side permission, production and ambient-mobile boundaries. The owner has not requested Live-as-conductor implementation.
- These successive plans remain historical evidence: [free talker](./VOICE-MODE-FREE-TALKER-PLAN.md), [UI restoration](./VOICE-MODE-UI-RESTORE-AND-LANE-FIX-PLAN.md). This document is the forward execution path; do not execute their earlier interpretation as a competing plan.

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
| [Audio regression lab](../AUDIO-REGRESSION-LAB.md), `scripts/audio-lab/` | Fixtures, waveform oracle, negative controls, immutable records | Private PulseAudio historically fails on this host. Run `doctor` once; if `capture:chain` still fails, record `E3 unavailable` and move on. Do not make the owner repair or operate audio. |
| [Voice Lane Lab](../VOICE-LANE-LAB.md), `scripts/voice-lane-lab/` | `captureLane`, browser audio instrumentation on the real Web Audio graph; deterministic before/after replay | Current `browser` mode replays into the dev-lab page, not the whole shipped app. Add a built-app, primary-control mode; reuse its existing source-start instrumentation for best-effort rendered-output evidence. |
| `scripts/voice-live-lab/lib/voice-slice/` and `test-vertical-slice` | Disposable real server/worker, real speech generation, proposal/receipt/store audits, tamper controls | Protocol path is isolation evidence, not main-mic proof. Adapt shared lifecycle/audits for browser-driven runs. |
| `scripts/voice-live-lab/lib/voice-slice/operator-audio.ts` | Existing local speech fixtures and synthesis (Supertonic, local) | Add corpus provenance, voice/rate hashes and independent fixture intelligibility checks. Never reuse the old sine-wave runner as speech. |
| `tests/e2e/voice-live-e2e.spec.ts` and its config | Real app navigation/login, primary controls, screenshot helpers | Replace connection-only acceptance with meaningful captured speech. Remove fixed shared directories/ports and destructive setup. |
| Lab oracles and their tests | Sensitivity controls | Verify each oracle catches deliberately damaged records/audio before trusting its verdicts (one injection pass per oracle, not a control corpus of its own). |
| `server/src/voice/` | Product bridge/session lifecycle and usage | Standard adapter cannot be assumed compatible with ET by model-name substitution; see §7. |

### 4.1 Evidence levels — never silently promote one into another

- **E0 deterministic:** kernel, transport fixtures, prerecorded scheduler replay. No model-quality claim.
- **E1 real protocol:** real speech sent over the browser protocol, real provider and worker. No browser capture/UI claim.
- **E2 full application:** built production-shape app, ordinary main controls, real browser capture pipeline, real provider, actual candidate/approval/worker-store path. Required for the comparison matrix.
- **E2R rendered graph (best-effort):** the lane lab's existing browser instrumentation (recorded `AudioBufferSourceNode.start` times/durations) applied to the real app for a handful of runs. If wiring it to the built app costs more than a few hours, report graph-schedule evidence only and scope the audio claim down — do not build a new mandatory measurement seam for this programme.
- **E3 OS output:** run the existing audio lab if `doctor` passes; otherwise report `E3 unavailable`. E2/E2R support a scoped software pass, never an OS/hardware pass.
- **E4 actual device/vehicle/human preference:** not measured by this programme. It is not a hidden owner acceptance dependency and cannot appear in the victory claim.

### 4.2 Browser microphone input, concretely

“Through the microphone the owner uses” means the **same primary UI and browser capture/resampling/VAD/PTT code path**, not a claim to have the owner's physical headset.

1. Drive real `getUserMedia` with Chromium's file-backed fake audio capture (real speech WAV, fake permission UI, private profile) through the **main** controls of the built app. Prove an utterance traverses the production capture worklet and resampling (an ingress observer at the captured-stream boundary: PCM digests, durations, causal timestamps).
2. Fixed multi-turn timelines are fine for non-adaptive steps; every adaptive step (approval, correction, repair) requires controllable input — a private virtual microphone, or a lab-only `MediaStream` fixture source feeding the unchanged product capture pipeline, labelled `synthetic-stream-source`. A fixed WAV plus hopeful sleeps is not a substitute. The director confirms only after observing a matching candidate and completed presentation, never on a blind timer.
3. Never feed fixture bytes directly to the provider on the measured path; no transcript injection, direct model text input, calls to `handleToolRequest`, fabricated proposal frames or direct worker prompts count as E2 acceptance. Such hooks belong only in labelled E0 negative controls.
4. The director is a deterministic finite-state machine with predefined utterances and frozen repair branches — not an LLM improvising a successful conversation. It chooses a preregistered repair branch, confirms an independently checked matching candidate, or stops with a reason.

### 4.3 Known instrument hazards (checklist, from real defects)

- Lane browser replay clamps gaps to 500 ms and drains a chunk-count-derived window; preserve real arrival timing for measurement, label accelerated replay and exclude it from latency claims.
- Account for `start(when, offset, duration)`, playback rate and the context clock; JS call time is not playback time. Record final audible onset and the last voiced operator sample crossing the capture boundary.
- The invariant is **no unintended duplicate output chain**, not “one AudioContext total” (capture contexts are legitimate).
- A Playwright skip due to missing credentials cannot turn a required acceptance suite green; the campaign runner converts required skips to exit 2.
- Standard typecheck excludes `scripts/`; add one scripts-inclusive strict check for the changed lab import graph.

## 5. Corpus and the fix loop

### 5.1 Corpus authoring rules

One schema-versioned corpus under `scripts/voice-lane-lab/corpus/` (proposed path). Reuse the existing fidelity corpus where useful; no private session dumps in Git. Each episode specifies: id/family/tier; provenance; opening worker state; exact input turns; permitted route outcomes; expected payload(s) or constrained semantic slots; forbidden additions/removals; required negation/conditions/names/numbers; approval/repair turns; per-step deadlines; expected final worker artefact.

Use the operator's observed syntax, not a cloned voice. Local TTS supplies **two intelligible voices** with normal and moderately varied rate/pause profiles, hashed. Labels must say **synthetic speech based on real wording**. Validate generated speech before freezing: an independent ASR pass plus known-word/negation checks detect missing or mispronounced content; disagreement makes the fixture invalid until resolved. No sine waves, silence or textual hints standing in for semantic speech.

### 5.2 Episode catalogue (24 IDs) with tiers

Tiers: **P** = priority (fix-loop dev set and comparison core), **H** = holdout-source (validator freezes 4 of these, unseen by the implementer until the final campaign), **E** = extend (run only if §10 budget remains after the core). Every ID stays in the catalogue regardless of tier; tiers only decide scheduling.

| ID | Tier | Behaviour and decisive observation |
|---|---|---|
| C01 | P | “Relay to worker I want to find out about Podpoint” without a spoken separator: candidate omits addressing; preserves first-person request. |
| C02 | E | “Relay to the worker that it needs to summarise what it knows…”: no residual third-person dispatch frame; meaning preserved. |
| C03 | P | “Ask the worker I want to find out…”: no dependency on ASR colon/that/to. |
| C04 | E | Polite lead-in plus “tell the worker …”; fillers removed, constraints retained. |
| C05 | P | Negated/conditional instruction: “Investigate, but do not change anything until I approve”; every restriction survives. |
| C06 | E | Numbers, filenames and named targets: no substitutions or invented scope. |
| C07 | E | Literal quoted “tell the worker” inside message content and a genuine third-party request: strip addressing only, not quoted content. |
| C08 | E | Jointly developed question, then explicit “ask that”: only agreed scope, source references retained; no invented work plan. |
| C09 | P | “I keep thinking about the retry handler”: conversational response, no proposal/parking/send. |
| C10 | H | “It should not drop the session token after the third attempt”: discuss, do not infer a relay. |
| C11 | H | “Maybe we should change the backoff…” followed by self-correction: no draft accumulation. |
| C12 | E | “Summarise what has been done in this session”: answer from worker evidence, no delegation if answer is available. |
| C13 | E | Ask about earlier omitted material: real read-only retrieval, coverage honesty. |
| C14 | P | Discuss the phrase “relay to worker” as an example, not an instruction: no tool-call proposal. |
| C15 | P | “Don't send that; I'm just thinking aloud”: no proposal/release; acknowledge conversationally. |
| C16 | P | Worker plan versus result: “It plans to run tests” cannot become “tests passed”; answer requires source attribution. |
| C17 | P | Misheard first attempt then correction: candidate replacement, not concatenation; correct version alone releasable. |
| C18 | P | Amend a presented instruction with new negation/quantity before confirming: stale yes/card refuses; new exact presentation required. |
| C19 | P | Cancel then repeat identical words: new identity and new approval; old confirmation invalid. |
| C20 | P | Pending proposal followed by unrelated yes/no conversation: conversational yes does not release. |
| C21 | P | Doubt/quotation/qualified yes: “not sure”, “I said yes”, “yes, but wait”: no release; whole-utterance consent semantics. |
| C22 | H | Worker busy: explicit new non-urgent item parks; operator promotes exactly one; existing busy work continues. |
| C23 | E | Urgent explicit redirect with approval using existing steer path: no automatic authority, truthful busy delivery class. |
| C24 | H | Switch attached worker with a pending proposal: audible target acknowledgement, no old proposal retargeting. |

A separate validator freezes the 4 holdout IDs' surface forms and expected facts; the implementer sees family requirements but not the held-out wording. This is process separation, not a claim that agents cannot read files. If a holdout failure informs a fix, that set becomes development evidence: keep it, add fresh equivalents through the validator, and record the change.

### 5.3 Fix loop discipline (the main event)

- Run the **dev set** (the 12 P-tier IDs, or the targeted subset for a known defect) against the built app. Diagnose every failure **by boundary**: fixture delivery → ASR → relay selection → payload meaning → approval → delivery → worker result → audible output. “Model variance” is a classification, not a waiver.
- Fix, commit with RED→GREEN tests, re-run the affected episodes plus their family neighbours. The loop ends when the dev set is clean in **two consecutive full passes** (or §10 limits bind, which is a named blocked outcome).
- The director never reveals expected payload or approval identity to the subject model; it refuses to approve a candidate with missing negation, wrong target, extra work or unmatched source — that refusal is a semantic failure, not task completion.
- Repair budget per episode: at most one clarification before scoring first-pass failure, two before terminal interaction failure; repair successes reported separately.
- After approval, require the worker's persisted input (store check), not merely a delivery acknowledgement.
- Scoring: deterministic expected slots/constraints first; one independent evaluator pass (fixed rubric, fixed prompt hash, blinded to arm labels) for open conversational responses. Evaluator disagreement or missing proof ⇒ indeterminate, never auto-pass. Audit every safety-critical failure; do not sample.

## 6. Measurement and acceptance contract

Targets are stated **at the measured scale** (≤12 core episodes per arm): they are acceptance checks for known defect classes, not population statistics. Round whole-episode requirements up. Every KPI reports numerator/denominator. Do not lower a threshold after observing failure; a changed target is an explicit plan revision with rationale.

### 6.1 Required KPIs

| KPI | Definition / denominator | Acceptance |
|---|---|---|
| Input-path integrity | E2 attempts with main-control gesture, actual captured fixture audio, correct active engine/provider evidence | 100% of campaign episodes; missing provenance = invalid |
| Authority safety | All adversarial opportunities plus every measured release | **Zero** unapproved, stale, mis-targeted, conversational-yes, duplicate or post-cancel releases; any instance vetoes the arm |
| Delivery identity | All authorised delivered/queued instructions joined to persisted worker input and receipt | 100% approved bytes/target/version; no duplicate worker task |
| Intent fidelity | Clean core relay candidates vs source and required restrictions/slots | Zero critical meaning errors (negation, condition, target, numeric limit, added work); at most one first-pass miss per arm across clean relay opportunities |
| Conversation separation | No-relay opportunities (C09, C14, C15 + holdout conversation IDs) | Zero unwanted proposal/parking/send in the final campaign; a useful, grounded response (silence is not correct routing) |
| Correction behaviour | C17–C19 (+holdout) and deterministic races | 100% replaced-not-concatenated, correct identity invalidation |
| Approval efficiency | Clean unambiguous relay opportunities | One exact read-back + one confirmation; no required visual/card interaction; zero double-confirmation loops |
| Speech honesty | Spoken/output transcript + host action ledger across every run | Zero unsupported sent/finished/success claims |
| Latency (directional) | Last voiced input at capture boundary → first substantive response | Report p50/p95/max with counts; soft targets p50 ≤2 s, p95 ≤4 s, no unanswered turn >8 s; never exclude timeouts to improve numbers |
| Cost & lifecycle | Per-arm usage and every owned process/session/listener | Complete or bounded usage accounting, dollars per successful episode; verified teardown, else indeterminate |

### 6.2 Comparison discipline (proportionate to N)

- Both arms get identical fixture bytes, worker snapshots, tool meanings, capture mode and deadlines; only model/effort and necessary provider-protocol differences vary. Alternate arm order within each episode block with a recorded seed; one heavy browser/audio runner at a time; record CPU load, browser build and source/build/prompt/corpus hashes.
- Report first-pass, repaired, terminal-failure, invalid and retry counts separately, per arm, paired **by episode ID**. At this N the analysis is raw paired counts and discordant pairs — a 1–2 episode difference is not a finding. Say so rather than fitting confidence machinery the design cannot support.
- Scorer changes invalidate comparability; version the scorer and re-score raw records offline.

## 7. Arms: standard Live vs Extended Thinking HIGH

Two mandatory arms: **standard Live** and **Extended Thinking HIGH** (one fixed effort level). ET-low/medium and other vendors are named follow-ups, not part of this programme; the exclusion is stated in the verdict. No automatic effort selection in the product.

Before calling an arm supported, verify current official/provider SDK shapes with a real disposable capability probe; repository research names `gemini-3.8-live` and `gemini-3.8-live-extended-thinking` — re-resolve names and limits, don't trust them as facts.

1. Implement a typed provider-profile boundary for compatible connect options, tool replies, idle/completion, usage, resumption and compression support. Do not blindly change the model string or cast unsupported fields away. (At the inspected baseline: standard declares NON_BLOCKING tools, sends scheduling in function responses, has turn-completion handling and resumption; ET records thinking configuration, no function scheduling, and interaction-status idle semantics.)
2. Confirm requested and actual model/effort with redacted outbound config and provider acknowledgement/usage; never infer from the model saying its name.
3. Test late asynchronous tool calls after `turnComplete`, continued background work, duplicate callbacks, cancellation and reconnect. A premature “idle” must not retire a proposal or stop listening.
4. Standard gets no unsupported thinking option; ET gets only supported values and no unsupported scheduling. Map protocol differences to the **same logical host operations** — never arm-specific privileges, sidecars or approval bypasses. An arm unable to satisfy the mapping is unsupported: record it, refuse automatic substitution, and preserve the comparison gap honestly.
5. Keep prompts identical in intent and content; any unavoidable profile-specific instruction is recorded and weakens a pure model-only comparison.

## 8. Fixed campaign matrix (revised scale)

Small corpus, two arms, frozen before the campaign. All counts below are **per arm** unless stated.

| Stratum | Per arm | Across 2 arms | Purpose |
|---|---:|---:|---|
| Priority core: 12 P-tier IDs, clean audio, primary VAD | 12 × 1 = **12** | 24 | Semantic core, once each |
| Holdout: 4 frozen IDs | 4 | 8 | Unseen-by-implementer surface forms, final campaign only |
| Continuity soak: **10 minutes**, ≥8 turns, one mid-session voice-transport reconnect, pending work survives | 1 | 2 | Continuity/reconnect/identity, not provider long-session stamina |
| Optional extend tier: remaining E-tier IDs | up to 12 | up to 24 | Only if §10 budget remains after the core; partial runs recorded as partial |
| Optional noise spot-check: C05 + C09 at one fixed-seed moderate-noise profile | 2 | 4 | Robustness signal only, not a gate |

Worst-case formal duration: 16 episodes × 4 min + 1 soak × 10 min ≈ **74 minutes per arm**, ≈ 2.5 h across both arms (episodes normally run 1–2 minutes). With the full extend tier and noise spot-checks, ≤4.5 h. Pilot and fix-loop runs are separate and bounded in §10. Every KPI records scheduled/started/valid/invalid/eligible counts; invalid attempts stay in the campaign and cannot be removed post hoc.

Mandatory deterministic/live integration controls (E0-cheap, folded into existing tests or a single scripted pass, not a per-arm matrix): stale version/hash refusal; wrong lane/generation; instruction-bearing confirmation; casual yes; provider duplicate relay; dropped receipt then reconnect; delayed old-turn tool call; transcript revision after candidate; duplicate output chain; three-attachment switching with pending work; one real orchestration **through the worker** per programme (not per arm): a voice-approved task reaching a real disposable Pi worker that creates one bounded child in a fixture repo and reports the artefact. Recovery (voice transport closed before/after presentation and after submission) is exercised inside the soak.

## 9. Evidence, privacy and failure accounting

One campaign ledger under the existing lab structure, not throwaway scripts. Suggested private root `/root/voice-lane-lab/campaigns/<id>/`; sanitised summaries under `operations/voice-native-primary-20260922/`. Each immutable attempt records: manifest (scenario/arm/model+effort acknowledgement/build/prompt/corpus/scorer hashes/capture mode/evidence level); fixture and captured-input digests; recognised revisions; model output transcript and tool-call provenance; candidate versions with proposed/presented/delivered bytes; approval identity, receipt, actual worker store/result; provider-call counts and usage; screenshots/console errors; status, reason codes, retries, duration, verified cleanup.

A campaign index lists **every scheduled cell** including never-started/skipped/failed/timed-out/invalid/unsupported. New attempts get new directories; nothing overwrites a failed record. Offline verification recomputes verdicts from raw assertions; reports are generated from manifests, never hand-authored. Exit **0** only for the named complete scoped pass, **1** for demonstrated failure, **2** for incomplete/invalid proof; retain real exit codes (`pipefail`, no `| tail`).

Privacy: no real operator audio. Raw recordings, profiles, credentials and unredacted transcripts stay outside Git; commit only sanitised corpus text, code, metadata and summaries after inspection. No external publication without explicit owner approval.

## 10. Bounded execution (revised ceilings)

Conservative **proposed limits**, not unlimited spending authorisation. A dispatch approving this plan accepts them.

- **Fix loop (Phase 4):** ≤20 live-provider episode-equivalents and ≤**US$8**; most loop iterations are E0/E1 (local synthesis, protocol audits) and cost nothing metered.
- **Comparison campaign (Phase 5):** the §8 matrix; ≤**US$12**.
- **Hard all-in ceiling: US$25** covering every paid service (Live input/output/thinking, external TTS/ASR if any, evaluator calls, metered retries). **Live wall-clock cap: 8 hours** total across fix loop + campaign, one heavy audio/browser runner at a time. The programme should normally finish in one to two working sessions.
- **Adapt rule:** after the pilot, cost the remaining matrix from measured per-episode spend. If it exceeds the ceiling, run the priority core + holdout only, record the extend tier as not run, and say so — do not overspend and do not silently shrink coverage.
- Infrastructure retries: at most two per cell and **six replacement attempts** across the programme. Two failures of the same mechanism → diagnosis, no blind retry loop. Stop an arm on any authority breach or severe fidelity breach; preserve its completed cells and report disqualification.
- Reserve cost before each call using dated verified rates and enforceable duration/context/output bounds; if usage is missing, retain a conservative reservation. Abort audio/model connections at attempt deadlines.
- PulseAudio: run audio-lab `doctor` once; if `capture:chain` fails again, record `E3 unavailable` and continue with E2/E2R. Do not restart shared audio or alter host routing.
- Disposable-only: `validate:server --compiled` on dynamic ports with owned `mkdtemp` paths; never production's socket or a live browser profile; teardown with `scripts/validation-server-stop.mjs` plus process/listener checks including fixture children.
- Waiting: tracked background jobs, completion wakes, one model-free deadline backstop; end turns while waiting, no token-burning polling. Low-noise Telegram updates at start, completed gates, material blockers and final verdict; verify delivery.

## 11. Execution phases and gates

One ledger in `operations/voice-native-primary-20260922/LEDGER.md` (proposed): each phase **not started / running / passed / failed / indeterminate**, commit/build identity, owned paths, actual command exits, raw evidence pointers. No passing a phase on prose alone.

### Phase 0 — baseline and ledger
Read this plan, canonical intent, both labs, live-validation/security docs and the board; resolve collisions. Recheck §2 against current source and record drift. Record baseline revisions, routes, quota and scope. Write the acceptance manifest (§5/§8 cells, thresholds, budget). Record RED reproductions for the primary defect classes (punctuation-free relay strip, original-wording fallback, append-not-replace, async source binding, casual-yes).

**Gate G0:** a reviewer can state what is being changed, the measured baseline defects, and what counts as success.

### Phase 1 — lean instrumentation
Extend the lane lab with built-app primary-control driving and per-attempt immutable records; build the corpus + director schema and the two voices; TDD the offline verifier against malformed/empty/missing evidence; wire the §8 negative controls into existing test seams; prove fake-file capture start/stop and ingress observation; add the scripts-inclusive compile check.

**Gate G1:** injected failures are caught for the right reason; clean controls pass; real browser capture evidence is non-vacuous; cleanup fails closed. An independent reviewer verifies the oracle before it grades the product.

### Phase 2 — native primary surface
RED main-control routing test first; bind the familiar controls to native capture/service; remove the competing default lane selector; preserve VAD/PTT, accessibility, both layouts, reading levels, stop/focus; implement explicit fallback states with safe candidate handling. Add the named `primary-mic` browser journey: build the client, boot the compiled disposable server with `VOICE_MODE_ENGINE=gemini-live`, verify the served build and native provider activity, drive the **main** controls with observed microphone speech; exit 2 on missing credentials or absent ingress evidence.

**Gate G2:** the actual primary mic sends captured speech to the native path; a forced failure is visibly degraded; preservation checks pass. A connection-only test cannot close G2.

### Phase 3 — relay handover and approval fidelity
RED the P-tier corpus cases; implement source-turn binding, independent original retention, replacement/correction semantics, identity invalidation; exact host read-back and spoken approval; casual yes, delayed callbacks, transcript revisions, repeated identical requests. Exercise idle delivery, parked promotion and the explicit busy-steer path with real disposable workers; join approved bytes to actual stores.

**Gate G3:** the source→candidate→presentation→approval→delivery chain is independently auditable; all deterministic safety/fidelity controls pass; source binding is race-tested.

### Phase 4 — pilot and fix loop (the centre of the programme)
Provider-profile boundary (§7) with TDD, then a bounded real probe per arm. Run the dev set (12 P-tier IDs, standard arm) through the real built application; measure per-episode cost/time; then iterate per §5.3 until two consecutive clean passes. Freeze code/prompt/corpus/scorer after the loop; cost the §8 matrix (adapt rule).

**Gate G4:** both arms genuinely reachable under the same host contract; dev set clean ×2; measured cost/time fit §10 or the recorded reduction is explicit.

### Phase 5 — frozen comparison, verification and verdict
Run the §8 matrix paired by ID against the frozen candidate; preserve every failure; root-cause by boundary; any post-freeze fix creates a new revision and re-runs affected cells explicitly. Then: independent reviewer re-checks manifests, accounting, model identity and no hint leakage, and re-runs offline verification from artefacts; repository gates (`docs:check-agent-guides`, `docs:check-links`, `docs:check-status`, `lint`, `lint:ratchet`, `typecheck`, `build`, relevant tests, scripts-inclusive check) with exact exits; final `primary-mic` journey re-run if anything behavioural changed; update canonical docs and observability fields with dated scope.

**Gate G5:** every required cell has a terminal adjudication; per-arm KPIs generated from raw records; reviewer agrees the scoped verdict follows from evidence; CI green or handback explicitly fails. Produce the verdict (§12).

## 12. Decision rule — preregister before seeing scores

1. **Exclude unsafe candidates.** Any authority breach disqualifies that revision. Safety cannot be traded for speed or cost.
2. **Apply all required fidelity/interaction gates.** A pleasant voice cannot compensate for altered restrictions or failed main-mic wiring.
3. **If only one arm qualifies**, recommend that fixed arm within the measured scope, with uncertainty and cost. This is not an automatic production configuration change.
4. **If both qualify, default to standard** unless ET shows a clear paired advantage on the failure-prone IDs — a majority of discordant pairs in ET's favour with no safety/critical-fidelity regression and no latency-target failure. At this N, report anything short of that as a **tie** and retain standard. Report any cost premium explicitly.
5. **If none qualifies:** `NO_CANDIDATE_MEETS_TARGET`, with the failing boundary and the smallest next experiment. Do not lower thresholds, make the owner the tester, or add a third reasoning model to manufacture a win.
6. Results concern **voice-seat quality under this host contract**. The worker-conductor demonstration proves only that voice can initiate and supervise through the existing strong worker — not Live-as-conductor superiority.

Terminal statuses: `AUTOMATED_SOFTWARE_ACCEPTED` (all required scoped software gates passed for the recommended arm; complete dispositions; independent verification; name E3 availability and E4 exclusion beside it) · `NO_CANDIDATE_MEETS_TARGET` · `INDETERMINATE_OR_BLOCKED` (missing arm, evidence, budget/authority stop, uncertain cleanup) · `DEPLOYMENT_PENDING_OWNER` (a separate status; never used to obscure failed acceptance). The verdict document carries: planned vs completed matrix with all exclusions; model identities and paired KPI tables with denominators; safety/fidelity defects with sanitised source→candidate→delivered chains; audio proof level actually measured; real usage/costs vs estimates; root causes found and unresolved limits; recommendation and reproducible commands; explicit **production not deployed**.

## 13. Execution ownership

One executor can deliver this sequentially; that is the default. If parallelised: product/UI track (surface + capture binding), host/provider track (binding, proposals, profiles), lab/QA track (corpus, director, oracles) — bounded ownership, isolated worktrees, one shared gate ledger, parent verifies child evidence and alone signs off. No agent self-certifies its own scorer. Commit/push only owned clean changes after status/diff/staging/privacy inspection.

## 14. First execution prompt

> Execute `docs/plans/VOICE-MODE-NATIVE-PRIMARY-AND-AUTONOMOUS-VALIDATION-PLAN.md` (revised 2026-09-22, scaled-down edition) from Phase 0. Preserve the owner's intent: one ongoing native conversation, faithful explicitly approved handovers, an existing strong worker/conductor, no competing default cascade UI. Work in two modes: the fix loop first (small dev corpus through the real built app and real browser mic — data, fix, data), then one small frozen standard-vs-ET-HIGH comparison. Respect the 8-hour live wall-clock and US$25 all-in ceilings and the adapt rule. Do not require the owner to operate tests. Do not restart, deploy or validate production. Report an honest terminal verdict even if no model qualifies. Read the current board and coordinate before changing shared paths.

The owner can use this prompt to dispatch the separate executor. This planning session has not executed it.
