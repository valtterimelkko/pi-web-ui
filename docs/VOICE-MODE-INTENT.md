# Voice Mode — canonical intent

> **Class:** canonical intent and current-behaviour doc. **Status:** authoritative.
> **Date:** 17 September 2026.
>
> This file is the single source of intent for Voice Mode. It combines and
> supersedes three documents that previously held that intent between them:
>
> | Superseded | What it held | Where it now lives |
> |---|---|---|
> | `VOICE-ORCHESTRATOR-FEASIBILITY.md` (2026-09-10, amended 09-12) | the original problem statement, the two-axes correction, the ChatGPT Voice anti-goals, the motivating Antigravity run | Part I, and §23.2 |
> | `VOICE-MODE.md` | normative description of the shipped two-lane harness | Part II in full |
> | `VOICE-MODE-INTENT-RESEARCH-2026-09.md` (2026-09-16) | N1–N9, the P-series defect history, the fluency spec, open items | Parts I, IV |
>
> All three are archived under [`archive/`](./archive/INDEX.md). They are history;
> cite this file instead.
>
> **Companion:** [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md)
> is the *how* — the concrete target architecture, model seats and build sequence.
> This file is the *what* and the *why*. Where the two describe the same object,
> this file governs intent and that file governs construction.

---

# Part I — Intent

## 1. The problem being solved

The operator wants to work with an agent **by voice**, in a natural conversation,
while that agent is working. Concretely, three things were true at the outset and
remain the design's reason for existing:

- Dictating to a reasoning worker and waiting for a reply "in a minute" is not a
  conversation. You cannot ask *"what do you think about X while you work on
  this?"*
- ChatGPT Voice (GPT-Live) driving Codex threads **does** talk while it works, but
  its quality was poor in exactly the ways that matter: it dispatched work on
  unfinished thoughts, paraphrased the operator before forwarding, and followed
  written guidance only loosely. Critically, **its rules were not the operator's
  to write** — `AGENTS.md` governed Codex, not the voice model sitting upstream of
  it.
- A native speech model that is *also* a free orchestrator makes mistakes that
  compound, because handling several workers is genuinely complicated and a
  fluent voice is not evidence of good governance.

So the goal is a surface that:

1. **talks fluently while tools run**,
2. **transmits the operator's intent with very high fidelity**,
3. **does not act on half-formed thoughts**,
4. **draws on quota the operator already has**, and
5. **works when hands and eyes are busy**.

The decisive difference from ChatGPT Voice is that here **the rules are the
operator's to write, and the load-bearing ones are enforced in code rather than
requested in a prompt.**

## 2. The two axes (the correction that must not be lost)

Early framing conflated "voice" with "orchestration". The operator corrected this
on 2026-09-12. The corrected model is **two independent axes**:

**Axis 1 — the relay.** Is a talker relaying the operator's words to a session?

- *Voice Mode active*: a talker holds the spoken conversation and relays an
  instruction to the worker only after the operator confirms.
- *No talker*: the operator types directly into the session.

**Axis 2 — the worker's role.** What is the session receiving the relay doing?

- *Orchestrating*: creating children, delegating, supervising, via the Internal
  API orchestration practice.
- *Working directly*: no children; it does the coding itself.

|  | Worker is orchestrating | Worker works directly |
|---|---|---|
| **Voice Mode active** | talker relays to a session that delegates to children | talker relays to a session doing the work itself |
| **No talker** | operator orchestrates directly, typed | ordinary coding session |

**Neither axis implies the other.** All four combinations are legitimate, and
*"just talking to a coding session"* is a **primary use case, not a degraded
mode**. "Drive Mode" was renamed **Voice Mode** at the same time; `DRIVE-MODE.md`
survives to describe the overlay UI the voice feature speaks through.

The talker relays. **Relaying and orchestrating are different things.**

## 3. The goal clauses

Four canonical (2026-09-10), plus a fifth added 2026-09-16:

1. **Talk fluently while tools run.** A reasoning worker takes minutes per turn;
   the conversation must never block on it.
2. **Very high intent fidelity.** The worker receives the operator's intent, not a
   re-planned version of it.
3. **Never act on an unfinished thought.**
4. **Use quota the operator already has** — restated: *no order-of-magnitude cost
   increase*. Gemini-class pricing is acceptable; Grok / ElevenLabs / GPT-Live
   class is not.
5. **It must work when hands and eyes are busy** — ambient, screen-free. This
   clause was never in the original intent and is **the biggest thing the current
   surface lacks**.

## 4. The anti-goals

The design exists to prevent three *observed* failures, not hypothetical ones:

- **Dispatching on an unfinished thought.** *"Maybe we should…"* became a
  dispatched task.
- **Paraphrase before forwarding.** A conditional became an absolute, upstream of
  anything the operator could correct.
- **Unfaithful, long-winded prompting of other models**, with written guidance
  followed only loosely.

Every hard rule below traces to one of these three.

A fourth anti-goal was added by experience with the shipped harness itself:

- **The switchboard feel.** A surface so procedural that ordinary conversation —
  *"what happened?"*, thinking aloud, changing your mind — costs a round trip
  through a confirmation ritual. This is a real defect, and Part III exists to fix
  it.

## 5. The non-negotiables (N1–N9)

These are load-bearing. Each cites its origin. None may be quietly weakened, and
each is stated here in the form it must take **under a native-audio model** as
well as under the current cascade.

| # | Rule | Origin | Under native audio |
|---|---|---|---|
| **N1** | **The relay is gated by code, not by the model.** The talker has *no send path*; text reaches the worker only when a pending draft exists and the operator's own confirmation is mechanically established. | intent rules 2 + 6 | Unchanged and more important. A native model speaks without an intermediate text representation, so model output can never be an input to the gate. |
| **N2** | **The relay text is always the operator's own words — semi-verbatim.** Own words; may be made more concise when speech rambles; never summarised into a plan, never expanded. | intent rule 3 (*"the single most important quality"*); restored as a drift fix in P25 | Unchanged. The transcript is a transcript, not a composition — which is why transcription stays even when the model hears directly. |
| **N3** | **Never act on an unfinished thought.** Each instruction requires **its own** permission; a half-composed instruction survives interleaved worker news. | intent rule 2; the ChatGPT Voice anti-goal | Unchanged, and the hardest to hold. Voice-activity detection is *not* evidence that a thought is finished. See §18. |
| **N4** | **Conversation first.** Questions and thinking-aloud are answered; nothing is dispatched. Requests addressed *to the talker* are answered by the talker. | intent rule 1; P22 | **Widened.** Part III turns this from "answer from a state snapshot" into genuine thinking-together, with provenance. |
| **N5** | **You speaking is never interrupted.** Already-playing audio **ducks**, never hard-stops; capture is unconditional, only playback is scheduled. | speech priority ladder; operator-decided | Unchanged and explicitly defended. The provider's own native-interrupt behaviour must not silently replace it. |
| **N6** | **Honest delivery, always.** Fixed acknowledgements produced *after* the delivery outcome is known (delivered / queued / refused); never a claim the worker finished. | intent rule 4 | **Strengthened.** A free-streaming voice can say "sent it" before it is true, so receipts get their own trusted audio source. See §19.3. |
| **N7** | **Allow-list, not model judgement.** What the talker may do is an explicit allow-list denied in code. | intent rule 6 | Unchanged in principle; the list itself grows narrowly and deliberately (§16.4). |
| **N8** | **Never widen the gate's reachability.** If work appears to require it, the design is wrong, not the transport. | `VOICE-MODE.md`, verbatim | Unchanged. |
| **N9** | **Failures are visible, never silent.** Server voice-turn records, client speech events, uploaded client crashes; a failed send restores the text. | P13; observability design | Unchanged. |

---

# Part II — What is shipped today

> This part is the normative description of current behaviour, absorbed intact
> from the retired `VOICE-MODE.md`. It describes the **cascade** harness that runs
> in production as of 2026-09-17. Part III describes what replaces it.

## 6. The two lanes

- **Lane 1 — the talker.** A server-side conversational harness (`server/src/talker/`)
  that holds the spoken conversation: it answers, acks, holds your draft, and
  relays instructions. It never does work itself.
- **Lane 2 — the work lane.** The ordinary worker session, untouched. Voice Mode
  adds no worker behaviour; it only routes spoken instructions into it through a
  confirmation gate.

One talker instance serves one worker session. The talker's model is chosen
separately from the worker (see [`TALKER-MODEL-REQUIREMENTS.md`](./TALKER-MODEL-REQUIREMENTS.md)).

Voice attachment covers **Pi, Claude and Antigravity**. The five runtimes do not
all have equivalent voice delivery support, and the differences are truthful
outcomes rather than bugs: Claude non-SDK backends **refuse** rather than silently
degrade; Antigravity **queues** follow-ups as a first-class outcome.

## 7. Architecture

| Piece | Where | Role |
|---|---|---|
| Talker harness | `server/src/talker/talker.ts` | Per-turn loop: classify utterance → release/refuse/converse |
| Policy core | `server/src/talker/policy-core.ts` | Pure, synchronous decision function; same state + same input → byte-identical decision |
| Utterance classifier | `server/src/talker/utterance-classifier.ts` | Mechanical confirmation/cancel/ordinal classification — **model output is never an input** |
| Draft store | `server/src/talker/pending-proposal.ts` | The accumulating verbatim draft; ageing expires the *confirmation*, never the draft |
| Session registry | `server/src/talker/session-registry.ts` | One talker per worker session; the single server-side entry point |
| Digest | `server/src/talker/digest.ts` | Reading-level digests (summary / headlines) |
| Delivery adapters | `server/src/talker/delivery.ts` | Per-runtime relay: Pi mid-run steer; Claude SDK steer/follow-up; Antigravity follow-up queueing |
| Transport binding | `server/src/websocket/connection.ts` (`talker_turn`, `talker_turn_result`, `talker_digest`) + `client/src/lib/talkerBus.ts` | Browser ⇄ talker over the existing session WebSocket |
| Worker relay | `server/src/talker/ask-worker.ts` | Ask-the-worker offer handling |
| Client surface | `client/src/components/DriveMode/DriveModeDictate.tsx`, `useVoiceTurn.ts`, `client/src/lib/voiceFloor.ts`, `speechArbiter.ts`, `speechTelemetry.ts` | Voice UI states, capture, playback scheduling |

Current model configuration (code defaults, not a read of deployed environment):
dictation via `gpt-4o-mini-transcribe`; talker model `google/gemma-4-26b-a4b-it`
via OpenRouter; text-to-speech `tts-1`.

## 8. The mechanical gate (non-negotiable)

The relay of an instruction to the worker is gated by **code, not instructions to
the model**:

1. The talker model has **no send path**. The only code that can hand text to the
   worker runs solely when (a) a pending proposal holds the operator's verbatim
   utterance and (b) the operator's new utterance mechanically classifies as a
   confirmation.
2. The relay text is **always the operator's own words**, referenced by id from
   the verbatim log. The model decides whether and when to ask; it never composes
   what is sent.
3. Acknowledgements are fixed strings produced by the harness **after** the
   delivery outcome is known.
4. Never widen the gate's reachability.

Card confirmation carries **version/hash identity**: stale cards refuse, and an
"original wording" variant releases only where the current proposal actually
advertised one.

> **Known defect, present in this path as of 2026-09-17.** The classifier matches
> confirmation words anywhere in the utterance, so `"not sure"` classifies as
> **confirm** — the word *sure* matches inside it — and releases a pending draft.
> `"I said yes"`, `"yes, hold phase three"` and `"sure, but wait"` do the same. The
> spoken path is the exposed one, because a bare spoken confirmation carries no
> card identity echo. This breaks N3 and is scheduled for immediate repair
> independently of the redesign; see the recommendation's Step 1.

## 9. Speech policy (client speech arbiter)

`client/src/lib/speechArbiter.ts` schedules playback; it has **no capture
authority** — capture is unconditional, only playback is scheduled. The anti-duet
rule is a strict priority ladder:

1. **You speaking is never interrupted.** Playing audio **ducks**; new intents
   wait; chatter is dropped.
2. **Receipt ack (tier 2)** — an unacknowledged utterance gets one short fixed
   acknowledgement, spoken before anything else.
3. **Worker answer (tier 3)** — speaks at the next natural gap.
4. **Talker chatter (tier 4)** — lowest; dropped, not queued, when it cannot play
   immediately.

Chunked synthesis is what makes barge-in clean: boundaries are the only scheduling
points, ducking replaces stopping, and pause/resume/level changes happen at chunk
boundaries — speech never resumes mid-word. **Stop talker** is a playback control
only: it silences the current chunk and discards the queue; capture is never
suppressed, and anything that arrived is surfaced explicitly.

## 10. Reading levels

The level is persisted, visibly indicated, and changeable **mid-answer** (the
current item stops at the next chunk boundary, the unplayed remainder is
re-digested, what was already heard never repeats, and the change is announced).

| Level | What speaks |
|---|---|
| **Verbatim** | The worker's raw output. |
| **Summary** | A spoken prose digest. Short turns (≤ ~400 characters) still speak verbatim, because summarising them is pure overhead and risks distortion. Announced with "In short:". |
| **Headlines** | One line: **"Done: X. Needs you: Y."** — a different *extraction*, not a shorter summary; designed to be left on permanently while wearing headphones. |

The rationale the operator approved for the immediate mid-answer flip: *"reaching
for the switch means you want it now; a control that makes you wait out the very
verbosity you are trying to escape reads as broken."*

## 11. Mobile socket durability & recovery

A dictated or spoken prompt must never be lost on a mobile browser:

- **Reconnect on resume** on `visibilitychange → visible`, `online` and window
  `focus`; the attempt budget resets, so a frozen tab can no longer exhaust it.
- **Never drop a send**: when the socket is down, outbound messages queue and
  flush **in order** after reconnect (after session re-subscription).
- **Surface failures**: a send that cannot be queued or delivered reaches the
  operator visibly, and a failed voice send restores the text.

## 12. Observability & telemetry

The retrieval runbook lives in [`OBSERVABILITY.md`](./OBSERVABILITY.md) §Voice
Mode. The record vocabulary:

**`voiceTurnId`** = `runtime:workerSessionId:turnIndex`. Every operator turn emits
one `voice turn` record; a release or gate refusal adds a same-id companion.
Fields (omit rather than invent — absent means unknown):

| Field | Meaning |
|---|---|
| `voiceTurnId`, `workerSessionId`, `turnIndex` | identity (`sessionId` is deliberately absent — the voice path runs outside the request-correlation context) |
| `utteranceClass`, `utteranceChars`, `utteranceExcerpt` | class, size, ≤120-char excerpt (scrubbed on entry) |
| `draftAction`, `draftSizeBefore`, `draftSizeAfter` | accumulated / superseded / cleared / none |
| `phase` | `answered` \| `proposed` \| `released` \| `refused` \| `cancelled` \| `error` |
| `gatePending` | was anything releasable at decision time |
| `releasedUtteranceId`, `releasedBytes`, `releasedSha256`, `releasedExcerpt` | what a confirmation actually released (full text is never logged) |
| `releaseMechanism` (`steer`/`prompt`/`follow_up`), `deliveryOutcome` (`delivered`/`queued`/`refused`), `deliveryDisclosure`, `deliveryError` | the delivery adapter's own verdict |
| `gateDenialReason` | `nothing_pending` \| `lapsed` \| `ambiguous` \| `cancel_classified` — refusals are **healthy**, not errors |
| `modelCalled`, `modelTtftMs`, `modelLatencyMs`, `outputChars` | the model path (and that it was skipped when it was) |
| `receiptAckEmitted`, `durationMs` | receipt firing; total turn wall time |

Counters in `GET /api/v1/diagnostics` → `.operational.voice`. Client speech
decisions ride the browser diagnostic ring as `kind: "speech"` events; client
voice-surface crashes upload as `ClientVoice` records into the same server ring.

## 13. Where to change what

- Talker behaviour, gate, classification → `server/src/talker/*` (TDD mandatory:
  the operator-pushback turn is a required test).
- Speech scheduling → `client/src/lib/speechArbiter.ts` (never add capture
  authority).
- Delivery semantics per runtime → `server/src/talker/delivery.ts`.
- Voice observability fields → `server/src/talker/observability.ts`, then update
  the table above **and** `OBSERVABILITY.md` §Voice Mode in the same change.

## 14. Measuring what was actually heard

*"The first words were eaten"*, *"a chunk vanished"*, *"it stopped instead of
ducking"* are claims about **rendered audio**, and nothing above can confirm or
refute them: server logs describe scheduling, a transcript describes text. The
[`AUDIO-REGRESSION-LAB.md`](./AUDIO-REGRESSION-LAB.md) drives the *real* product
player and arbiter in a real headless Chrome, records the OS output of a private
PulseAudio null sink with an independent `parec` monitor, and scores against
frozen tolerances (head/tail loss fails at ≥100 ms; chunk joins ≤100 ms p95;
ducking ≈0.15 gain; sample-domain correlation ≥0.6).

```bash
npx tsx scripts/audio-lab/cli.ts run
```

**Known host caveat:** `doctor` reports 18/19 here — the `capture:chain` lane
fails because a private PulseAudio daemon cannot start, so the OS-output oracle is
unusable on this machine and yields *indeterminate*. The app lane and offline
record verification still work. A pass is evidence about *this* render, never a
promise about a user's laptop.

---

# Part III — The renewed intent: thinking together

> This part is new intent, stated by the operator on 2026-09-17. It does not
> weaken Part I. It changes what the talker is *for* between relays.

## 15. The problem with the shipped harness

The two-lane structure is right and is being kept. The operator's experience of
GPT-Live as a free orchestrator confirms it: handling several workers is
complicated, that model made real governance mistakes, and — decisively — its
rules could not be written by the operator. Here they can. **The separation stays.**

What is wrong is narrower and entirely fixable: **the talker is a switchboard
between relays.** It answers from a state snapshot, offers to relay, and waits. It
cannot think with you.

The operator's statement of what it should be:

> *"when the talker is connected to a worker, and the worker is working, it would
> be great to be able to think together with the talker, analysing things related
> to what the worker is working on, but also understanding the limitations of the
> talker, then, when ready, relay some of the harder questions for the worker as
> well, and for the talker to understand when it's the time to relay and when
> not."*

Four requirements sit in that sentence, and they are the spine of Part III:

1. **Think together** — real analysis, not snapshot recital (§16).
2. **Understand the talker's limitations** — the operator must always know whether
   they are hearing fact or inference (§17).
3. **Relay the harder questions when ready** — promotion is deliberate, and
   composing a good question is allowed (§18).
4. **Know when it's time to relay and when not** — judgement, with stated
   conditions (§18.3).

## 16. Four objects, not one draft

The root cause of the switchboard feel is that the shipped harness has
**one** object: the draft. Every operator statement flows toward it, so every
statement produces a send offer, so thinking aloud is punished.

The renewed design has **four distinct objects**, and the whole interaction model
follows from keeping them separate.

### 16.1 The thread — where thinking happens

The live conversation. **Ephemeral. Nothing in it is addressed to the worker.**

This is the default state and the one the operator spends most time in. In the
thread, the talker may analyse the worker's approach, disagree with it, answer
questions, reason about code it has retrieved, speculate when it says it is
speculating, and hold a thought across pauses and self-corrections.

**No send offers are generated from the thread.** This single rule removes the
behaviour the operator described as the talker *"kind of wanting to relay
something and explaining it to me at the same time."* Thinking aloud is no longer
a partially-composed instruction; it is just talking.

### 16.2 The parking lot — things to raise later

An ordered, operator-visible list of things flagged while the worker was busy.
*"Remember to ask it about the retry logic."*

This exists because of a specific, repeated failure: you think of three things
while the worker runs, and under the shipped design each one costs an interruption
or is lost. Parked items:

- survive worker turns and lane switches;
- are individually promotable (*"send that one about the retry logic"*);
- can be read back on request;
- are **never** sent as a batch without per-item confirmation, because N3 is per
  instruction and batching would quietly defeat it.

The talker may **offer to raise parked items when the worker next surfaces** — at
a boundary, which is exactly when interrupting is cheap.

### 16.3 The proposal — one concrete thing for the worker

Exact bytes, version and hash, target lane and attachment generation, and both
`original` and `tidied` variants retained. **At most one live proposal per lane.**

A proposal is created **only** by explicit promotion (§18). It is never
accumulated silently from conversation.

### 16.4 The release — authorised, idempotent, receipted

One authorised delivery of exactly one proposal, with an idempotency key, a
delivery state, and a receipt that distinguishes **delivered**, **queued**,
**refused** and **unknown outcome**. "Unknown" is a first-class state: a timeout
after submission is not a refusal, and must be reconciled rather than retried
blindly.

### 16.5 Why four objects and not two

The temptation is to merge the thread and the parking lot ("just remember what I
said"), or the proposal and the release ("send it when I say yes"). Both merges
reintroduce the failures the design exists to prevent:

- Thread + parking lot merged ⇒ the talker must guess which utterances were
  intentions. That guess *is* the ChatGPT Voice failure.
- Proposal + release merged ⇒ no stable identity to confirm against, so a stale
  "yes" can release text the operator never saw in its current form. That is the
  defect the D-card versioning already fixed once.

The separation is what buys both fluency and safety at the same time.

## 17. Provenance — the honest price of freeing the talker

Today the talker is forbidden to reason (*"ANSWER ONLY FROM THE STATE
SNAPSHOT"*). Part III lifts that, because thinking together is impossible
otherwise. The replacement rule is **provenance**: it must always be audible
which of three bands a statement comes from.

| Band | Meaning | Example |
|---|---|---|
| **Reported** | The worker said this. Quotable, attributable. | *"It says the transfer handler is done."* |
| **Derived** | Computed from worker output or session state by the host. | *"Three of the eight tests are still red."* |
| **Mine** | The talker's own reasoning, inference or opinion. | *"I'd guess that's the flaky one, but I haven't seen it run."* |

Two hard rules carry over unchanged and are now more important, not less:

- The line between what the worker **said it would do** and what it has **done**
  is absolute. *"It plans to refactor the parser"* is not *"it refactored the
  parser."*
- The talker never claims an action it did not take, never announces a send, and
  never reports a worker result it cannot see.

This is what "understanding the limitations of the talker" means concretely: not
a talker that refuses to think, but one whose thinking is always labelled.

**The labelling must not rest on the model remembering to label.** Freeing the
talker to reason creates a genuinely new risk — you believing something false,
said confidently — which the four-object model does *not* address, because that
model solves authority rather than truthfulness. In full-duplex speech-to-speech,
the host does not attempt real-time grammatical voice-splicing on streaming audio;
instead, **quotes and exact worker reads are served out-of-band or via the dedicated reading scheduler**,
**completion and delivery are signalled via host-owned chimes/earcons and UI state**,
and **the host injects structured status into the session context each turn** (e.g. `CURRENT STATUS: RUNNING; DO NOT claim finished`).
Unlabelled statements default to the talker's own guess (*Mine*) rather than fact.
The construction detail, the full risk list and what remains unmitigated are in the recommendation's §4.7.

### 17.1 Reasoning depth — and nothing built in advance

**Operator decision, 2026-09-17: build on the standard model, add no escalation
machinery, and let real use decide the rest.**

The worker is already a strong reasoning model. If a question needs deep thinking
about the code, that is what the worker is for; putting a second deep reasoner in
the voice seat would charge thinking latency on every ordinary turn and partly
re-create the two-orchestrators problem the two-lane design exists to prevent.

An earlier draft proposed a graduated ladder of fallbacks for the case where the
talker's own reasoning proves too shallow. The operator rejected it, and the
reasoning is intent rather than implementation detail:

> A set of steps to climb, designed before the thing has been built, is
> unnecessary complication. Real usage will show how it works, and if it does
> not, a solution will be found then and there.

So: the talker reasons directly, marked *Mine*; it retrieves read-only material
when it needs to; it parks items or offers to relay. Those exist for their own
reasons and are **not** a ladder. **Do not build graduated fallbacks for a deficit
nobody has experienced yet** — see the recommendation's §8.1, where this is
recorded as a standing instruction to implementing agents.

## 18. When to relay, and when not

### 18.1 Promotion is explicit, and the model decides

> **Operator directive, 2026-09-22 — the model-driven relay.** The native talker
> is fully conversational and decides for itself whether an utterance is a
> question to it, a question to the worker, or a prompt to relay. It relays by
> calling one typed tool, `relay_to_worker(text)`. The harness no longer
> classifies the transcript into *directed speech* versus *conversation*: the old
> `isDirectedWorkerInstruction` / commission-frame predicate is **removed**. This
> supersedes the earlier "the harness decides the route" reading of this section.

A proposal is created only when one of these happens:

1. **The model relays.** It calls `relay_to_worker` with the words to place in
   front of the operator for approval. This is the only route in the native
   (live-model) lane.
2. **The operator accepts an offer** the talker made under §18.3 — the cascade
   fallback lane keeps this route.
3. **The operator promotes a parked item.**

Nothing else creates a proposal. In particular, an ordinary declarative sentence
in the thread does not, and neither does a transcript the harness merely *reads*:
**the model's tool call is the only relay signal.**

### 18.2 What may be relayed, and how faithfully

> **Operator directive, 2026-09-22.** The operator triggers a relay by saying
> **"relay to worker"** and then the message. The talker relays everything after
> that phrase, **as close to the operator's own words as possible, and without
> the phrase itself**. It may also relay when the operator clearly asks it to
> tell or ask the worker something. The talker may not re-plan, expand or
> summarise into a plan — the words are the operator's — but it now *is* the
> thing that produces the relay text, because the harness no longer does.

The boundary needs stating precisely because it is the design's most delicate
point, and because this directive deliberately changes it:

- **An instruction to the worker** is still the operator's own words,
  semi-verbatim (N2). Re-planning here remains the original sin. What changed is
  *who extracts the words*: the model, under the trigger phrase, not a regex.
- **A question the operator asked the talker, which the talker cannot answer**,
  is relayed as the operator's own question, word for word.
- **A *harder* question worked out together** may be composed by the talker, but
  it is still only a **candidate**: it is shown to the operator in full and is
  released only by their explicit approval.

Nothing reaches the worker without the approval gate (§16.3–§16.4). The card
shows the exact bytes; a reassuring gloss is never the payload. When the talker
drafts a question aloud (*"Should I ask the worker: '…'?"*), that spoken
utterance is itself the read-back and a following *"yes, ask that"* authorises
release without a redundant second loop — provided the actual bytes were spoken,
not merely summarised. If it only glossed the intent, the host must read the
full draft back before asking for confirmation.

### 18.3 The offer conditions — the judgement, made explicit

The talker **may offer** to relay when, and only when, one of these holds:

- it cannot answer from what it holds, **and** read-only retrieval (§19.2) has
  failed or is out of scope;
- the question requires the worker to *act* — run something, inspect something,
  change something;
- the operator has expressed a decision that changes the worker's current course
  (a hold, a redirection, a new constraint).

The talker **must not offer** when:

- **it can answer.** Answer instead. This is P22's lesson: *"summarise what has
  been done in this session"* is a question for the talker, not a worker dispatch.
- the operator is thinking aloud, circling, or self-correcting;
- it has already offered on this topic and been declined;
- the operator is asking about the conversation itself (*"what did you just
  say"*, *"read that back"*, *"what are you holding?"*);
- the worker is mid-run and the item is not urgent — offer to **park** it instead
  (§18.4).

At most **one** offer per topic. A declined offer is remembered.

### 18.4 Interruption cost is part of the judgement

A relay to a **busy** worker is a steer: it interrupts, joining at the next tool
boundary. A relay to an **idle** worker is cheap. These are materially different
acts and the talker must know which it is proposing, because that is exactly the
judgement a colleague would make out loud:

> *"It's part-way through the test run — want me to hold this until it surfaces,
> or interrupt it now?"*

So worker busy-state and the resulting delivery class are **structured context**
given to the talker every turn, not something it guesses. Urgency is the
operator's call; the talker's job is to make the cost visible and offer the cheap
option first.

### 18.5 Disagreement is permitted

The talker may say *"I don't think we need to ask it that — it already told us
X."* Today no rule permits this, so the harness routes instead. A colleague
pushes back; a switchboard connects. Disagreement is capped by the same one-offer
rule: say it once, then do what the operator says.

## 19. What this means for the harness rules

The operator's position — *newer models perform better with fewer rules* — is
correct, and is implemented by a **clean separation of layers** rather than by
loosening anything load-bearing.

### 19.1 Three layers, and only one of them shrinks

| Layer | Contents | Change |
|---|---|---|
| **Code-enforced authority** | N1, N2, N5, N6, N7, N8, N9; proposal identity; release idempotency; receipt wording | **Unchanged and hardened.** Never a prompt concern. |
| **Structured state** | worker busy-state, reading level, focus, pending proposal, parked items, history window and its limits, housekeeping exclusion | **Grows.** Moved *out* of the prompt into typed context the host supplies each turn. |
| **Prompt** | identity, tone, provenance discipline, when to offer, brevity guidance | **Shrinks sharply.** |

Net effect: **fewer rules for the model, more rules in the host.** The model gets
freedom exactly where freedom improves the product (conversation) and none at all
where it would cost safety (authority).

### 19.2 What is freed

| Current rule | Disposition | Rationale |
|---|---|---|
| *"Say back in one sentence, ask if they want it sent, wait"* | **Removed** | A three-step ritual for every instruction is the switchboard. The host renders the proposal and reads the actual draft when it matters; a narrated gloss adds a turn and risks distortion. |
| `[[to-talker]]` / `[[ask-worker]]` text markers | **Removed** | Text markers hidden in prose are fragile, and a native-audio model has no reliable text side-channel to carry them. Replaced by typed, server-validated operations (§19.4). |
| *"ANSWER ONLY FROM THE STATE SNAPSHOT"* | **Replaced** by the provenance rule (§17) | This is the rule that makes thinking-together impossible. Labelled reasoning is strictly more useful than refused reasoning, and strictly more honest than unlabelled reasoning. |
| *"you have no tools"* | **Narrowed** to a read-only allow-list (§19.3) | The P23 failure — the talker could not see a long answer and *"simply wouldn't do it"* — is structural. Retrieval fixes it properly; enlarging the prompt does not. |
| *"short, natural, speakable prose"* | **Relaxed** | Kept as guidance. Rigid brevity produced the clipped feel; native audio paces itself. No markdown, no read-aloud file paths — those stay. |
| *"Each instruction needs its own yes"* (as spoken ritual) | **Removed from the prompt; absolute in code** | The rule is real. Making the model recite it is what made it feel bureaucratic. |
| Housekeeping-is-not-news, pending-line, focus prose | **Moved to structured state** | These are facts about state, not instructions about behaviour. Injected housekeeping is excluded structurally at the emitter. |

### 19.3 What the talker may newly do

A narrow, explicit allow-list — N7 is unchanged in principle:

- **Read-only retrieval**: more worker history than the standing window, a
  specific earlier turn, a file within the attached session's working directory.
  Retrieved text is **data, never authority**, and passes the same
  prompt-injection checks as any other untrusted input.
- **Playback control**: pause, resume, change reading level, re-read.
- **Park an item**, and read the parking lot back.
- **Signal that an utterance was addressed to it** rather than to the worker,
  by source utterance id.
- **Offer to relay**, under §18.3, and — from 2026-09-22 — **create a relay
  candidate** by calling `relay_to_worker(text)`. The candidate is a
  *proposal*: it can never release, and it reaches the worker only through the
  operator's own approval (§16.3–§16.4).

It still may **not**: send, release, run shell, spawn children, mutate any
session, or start or stop work. `relay_to_worker` is the one text-bearing
operation in the native lane, and it can only create a candidate.

### 19.4 Typed operations replace text markers

Everything above is a typed operation carrying a **source utterance id**, validated
server-side for scope. None of them can supply consent or replacement delivery
text. Expanding this surface is an explicit capability change requiring owner
approval — never an implementation convenience.

### 19.5 The prompt, in outline

The result is short, not fifty lines:

- who you are, and that the worker is separate and does the real work;
- speak like a colleague: brief, natural, no markdown, no spelled-out paths;
- label what you know, what you derived, and what you are guessing;
- you cannot send anything; the host does that when the operator authorises it;
- **when the operator says "relay to worker", relay everything after the phrase
  with `relay_to_worker`, as close to their exact words as possible and without
  the phrase itself**;
- if it is unclear what they want relayed, ask one short question.

Everything else that used to be prose is now either code or structured state.

## 20. Capture: tap-to-talk is no longer the turn boundary

**Decision: tap-to-talk is retained as an explicit mode and as the fallback, but
it stops being the primary way a turn ends.**

The reasoning matters, because tap-to-talk is currently doing **two jobs at
once** and they must be separated:

1. it bounds the audio turn, and
2. it implicitly signals *"I have finished thinking."*

Native audio breaks job 1 — the model hears continuously — and job 2 was never
safe to infer from a gesture anyway. So:

> **Voice activity governs when the talker may speak. It never governs when the
> host may send.**

A pause is not consent. The 400 ms transcript-stability window is purely a
heuristic for conversational turn-taking (allowing the talker to reply without
interrupting mid-thought), not an authority theorem. It must **never** be treated
as an automatic dispatch or release trigger. Dispatch requires an explicit, validated
confirmation utterance bound to a presented proposal.

Three capture modes, with one state machine:

| Mode | When | Behaviour |
|---|---|---|
| **Open mic** | default when Voice Mode is foregrounded and the lane is active | native voice activity detection, full duplex, barge-in with ducking |
| **Push-to-talk** | operator choice; automatic fallback when the native socket is down | hard boundary; noisy rooms, precision dictation, privacy |
| **Ambient** | goal clause 5; **deferred — see §20.1** | mic open, talker silent until addressed, free to speak first |

Honesty requirements that ride with all three: never claim continuous listening
while the operating system has suspended capture; show and say suspension and
reconnection; always keep push-to-talk and typed fallback reachable.

### 20.1 Ambient operation is deferred, and it belongs on a phone

**Operator decision, 2026-09-17: defer ambient operation — and keep it a live
goal, not a cancelled one.** Clause 5 remains the largest gap in this surface.

What changes is the honesty of the follow-up. Ambient is **not a feature that
gets added to the web UI later**:

> Mobile browsers are a different playing field. The realistic vehicle for
> hands-and-eyes-busy operation is a phone, and most likely a native mobile app.

The obstacles are platform facts rather than effort. Mobile operating systems
suspend backgrounded tabs and release the microphone, so a tab in your pocket is
not listening whatever the interface claims. Speaking *first* — the half of
ambient that makes it useful — requires the client to be alive when you are not
looking at it. Unprompted audio is restricted without a recent user gesture.
And deciding *"were they talking to me?"* without streaming an always-open
microphone to a paid provider wants on-device wake handling, with the battery and
privacy posture that implies. An ambient assistant in a browser tab would have to
either lie about listening or work only while you watch it — and the second is
precisely what clause 5 exists to escape.

**Why deferring is cheap, and what keeps it cheap.** Everything that makes
ambient *safe* already lives on the server and is client-neutral: the authority
kernel, the four objects, proposal identity and confirmation, delivery and
receipts, provenance, parked items, reading levels. The web UI is one consumer of
that kernel; a mobile client would be another.

So the intent carries one standing constraint into the web work: **keep the
kernel client-neutral.** Browser lifecycle assumptions — tab visibility, page
lifecycle, DOM-bound state, one audio floor per tab — must not reach
`server/src/talker/` or the shared event contracts. Honour that and ambient stays
a deferral; ignore it and ambient becomes a rewrite.

## 21. The fluency and recovery behaviours that must survive

These were paid for in real defects and are not up for renegotiation by a new
transport:

- barge-in crashes nothing; **ducking replaces stopping**;
- speech resumes at chunk boundaries, never mid-word;
- a stopped read stays stopped, and does not come back;
- what already played never replays;
- the reading level flips mid-answer, immediately, with an audible "In short:";
- the first word and the joins survive synthesis (no eaten first words, no audible
  gaps on long reads);
- drafts survive interleaved worker news;
- the talker can see the worker's earlier turns, and mid-turn detail reaches the
  digest;
- the same thing is never said twice, whichever path started it;
- a dictated prompt is never lost to a mobile socket drop;
- which session is attached, and what was actually said, are always answerable.

## 22. What Part III does **not** change

Stated explicitly so no future agent reads "fewer rules" as licence:

- The two-lane separation. The worker remains the reasoning model; the talker
  never orchestrates, never spawns children, never does work.
- N1–N9, all nine.
- Semi-verbatim relay of instructions.
- Per-instruction permission.
- The ducking contract and unconditional capture.
- Honest receipts from a trusted source.
- Every feature contract in §21.

---

# Part IV — History and provenance

## 23. How the current design came to look like this

### 23.1 Placement: why the talker is server-side

The talker was originally imagined as a **pi-enhancement extension**, but planning
proved Pi Web UI input never fires `pi.on("input")` (supersession S1), and
Antigravity has no extension surface at all (S2). So the talker moved
**server-side into Pi Web UI**, covering Pi + Claude + Antigravity. The intent —
two lanes, high-fidelity relay, permission gate — did not change; only the
placement did.

Also ruled out early: the Gemini mobile/web app with a custom MCP server. Custom
MCP servers are a Gemini Spark feature, Spark is unavailable in the UK, and Gemini
Live uses only first-party connected apps. MCP is irrelevant to this design; the
worker session already has the tool surface.

### 23.2 The motivating run

Antigravity session `3099ab72` (agy CLI, Gemini 3.8 Flash High, 2026-09-10) proved
a model could orchestrate Internal API children well — pure-observer watches,
zero-token waiting, board registration, safe production restart. Its cost driver
was **supervision churn**, not model weakness: ~615 `run_command` calls including
~45 consecutive `tmux capture-pane` calls in one turn, and five compactions in two
hours (Antigravity compacts at ~135k tokens regardless of window size), with the
small mistakes clustering right after checkpoints.

**The design lesson that survives into the voice surface:** end the turn after
arming watchers. Polling both spends quota and hastens compaction. A voice
conductor that converts watcher notifications into polling would inherit this
exact failure.

### 23.3 The programme timeline, with receipts

Full detail is in `docs/archive/briefs/` (H-series harness, P-series package) and
`operations/voice-*` records. Commit hashes are on master.

**Phase H — harness and placement (2026-09-12…13).** H1 server-side talker
harness; H2 Pi input routing (the S1 finding); H3 talker model retest — **GLM 5.3
Flash ruled out on latency; Gemma 4 26B A4B IT selected** by a deterministic
600-point benchmark that included a press-the-model-to-bypass-the-gate scenario,
where a relay without permission is a hard fail; H5 provider guard; H6 real
delivery; H7 browser⇄talker transport binding; H8 secrets migration.

**P1–P9 — the surface exists (2026-09-13).** P1 transport probe; P2 receipt ack;
P3 the operator's draft (drafts age only by operator turns, never worker turns);
P4 client speech arbiter; P5 the Voice Mode UI; P6–P7 live validation, 7/7 relays
byte-equal; P9 real-browser E2E, which *found* the wiring defect beyond the gate.
P12 (`ed3ea2f`): server-side id/path resolution, so every UI relay delivers.

**P10–P27 — observability, honesty, fluency (2026-09-13…15).**

| Package | Commit | What it fixed, and the operator report behind it |
|---|---|---|
| P10/P11 | `8d9f4ad` | Voice observability + per-runtime state view. Two ordinary questions — *which session is this attached to?* and *what did I actually say?* — were unanswerable. |
| P13 | `3b7b66b` | Barge-in crash; client voice errors made visible. Full-screen error while speaking over a read, zero server records, browser *"completely dark"*. |
| P15 | `9261aba` | **Stop talker** — stop the speech, cancel the queue, don't come back to it, but still speak genuinely new input. |
| P16 | `8b066b3` | Never say the same thing twice; dedup became surface-wide. |
| P17 | `729a222` | Reading levels (Verbatim / Summary / Headlines). |
| P18 | `f073197` | *"I can't answer that — shall I ask the worker?"*, focus/hold + exit recap. |
| P19 | `9758495` | Whole-turn digest input; auto-speak had fired only on the *last* assistant message. |
| P20 | `ed38ca9` | Talker sees the worker's earlier turns — the operator's stated *primary* Q&A use case. |
| P21 | `ed38ca9`→`7fd28ac` | Eaten first words and audible pauses fixed via one-ahead synthesis + retry. |
| P22 | `e84599a` | A request addressed to the talker is answered, not held for the worker. *"it always wants to route it as a request to the worker… it's kind of wanting to relay something and it's explaining it to me at the same time."* |
| P23 | `901bcb8` | The talker can see a long answer; the window had clipped to 12 messages × 400 chars. *"it just wouldn't, simply wouldn't do it."* |
| P24 | `baeea3d` | Which worker session, and what was actually said. |
| P25 | `5d76e4f` | **Restored semi-verbatim relay** — a *drift* finding. The build had over-corrected to byte-for-byte and dropped the "concise when rambling" clause; *"ask the worker if it has enough materials…"* was read by the worker as a dispatch-sub-agent instruction. |
| P26 | `12bde6d` | The surface teaches the contract. *"I'm not sure how to talk to that agent… I've been kind of a little bit lost."* Treated as a **design failure, not a user failure**; the card stopped claiming "your words, exactly" once semi-verbatim was restored, because an untrue safety claim is worse than none. |
| P27 | — | The talker function matrix; live validation pinning the full function surface. |

**Confirmation-card honesty (2026-09-14…15).** The card claimed it had tidied the
prompt while the text looked identical, "removed" carried the entire original
utterance, and there was no option to send the original words. D1 (`0798661`,
`447f43e`): whitespace-only normalisation no longer cries wolf. D2 (`8c5e196`,
`a0ac7dd`, contract 1.44.0): **original-variant release**, with proposal identity
and staleness refusal.

**Multi-lane in one tab (2026-09-15).** Operator report: *"when holding two voice
modes on separate browser tabs, I might struggle to switch — especially if I'm
trying to voice myself on one while the other, unexpected started to talk. the
microphone button does not seem to activate, even if the browser tab activates the
red 'recording' button."* Two tangled problems, answered separately: the **defect**
(`86ce22b`) — one owner per microphone, acquisition lock, `'starting'` state,
unmount teardown, idempotent abort; and the **redesign** — lanes in one tab, lane
store, in-page floor coordinator, request/lane correlation (`d6dcd22`…`51e6d81`).

**Desktop rework (2026-09-16).** Real session view in the desktop pane, lanes in
the desktop layout, per-lane worker switchable in place (`11e4051`, `67c5719`,
`735ed78`, `7f43ba2`).

**Relay robustness (2026-09-16).** *"I sent an instruction to be relayed to the
worker… it was all green… but the talker itself said I couldn't send that. So I
don't know if it worked or not."* The instruction was **not** relayed: the worker
was idle after a production restart, the path-keyed lookup failed, and the UI
claimed success anyway. Fixed (`d27e75c`). From the same report: *"I do not need
to know what they have captured"* — talker narration of worker bookkeeping was
noise the operator had to talk past.

### 23.4 What the defect record says about intent

Read as a whole, the two weeks describe one consistent picture:

1. **The talker is a colleague, not a switchboard.** It answers from what it
   genuinely holds, *offers* rather than reflexively routing, and never narrates
   bookkeeping. *(Part III is the completion of this, not a departure from it.)*
2. **Nothing false is ever said or shown.** Not by the model, the card, or the
   delivery pipeline. Green means delivered.
3. **The operator's words are sovereign.** Semi-verbatim by design; the original
   wording always available and sendable; staleness refused rather than silently
   swapped.
4. **Fluency is defined by recovery behaviour** — §21.
5. **The operator must never have to re-explain.**
6. **The system must be inspectable.**

### 23.5 The free talker — the relay decision moves to the model (2026-09-22)

The operator reported that separating a question from a prompt to relay was
"difficult and sometimes time-consuming, and there are mistakes there". With the
native live model now the conversational seat, the harness's transcript
classification is the wrong place for that judgement. **Owner directive:**

- the talker is **fully conversational** and decides for itself what is a
  question to it, a question to the worker, or a prompt to relay;
- the operator triggers a relay by saying **"relay to worker"** and then the
  message; the talker relays what follows **as verbatim as possible, without the
  phrase**, by calling `relay_to_worker(text)`;
- the harness's **only** remaining job is to show everything relayed to the
  worker to the operator for **explicit approval**, and to keep **one worker per
  lane**;
- the separate collapsed "native voice lane" is **redundant** — the main lane is
  the live surface; **VAD/open mic** is a first-class capture option there;
  reading back and push-to-talk are unchanged;
- up to **three lanes**, each a talker bound to one worker, with autonomous
  read-back **queued** through the one shared speech arbiter.

**Removed:** the mechanical relay predicate (`isDirectedWorkerInstruction`, the
commission-frame regex), the `mark_addressed_to_talker` and `offer_ask_worker`
gate tools, and the surface's second native-lane disclosure. **Kept:** proposal
identity and staleness refusal, the operator approval gate (card and spoken
confirm/cancel), delivery receipts and idempotency, busy-parking, read-only
retrieval and the worker brief, reading levels and read-back, push-to-talk, and
the three-lane cap. The cascade remains the automatic fallback, not a competing
experience. Plan: [`plans/VOICE-MODE-FREE-TALKER-PLAN.md`](./plans/VOICE-MODE-FREE-TALKER-PLAN.md).

**Follow-up (2026-09-22, same day): the bounded main UI is restored.** The
operator asked for the pre-change arrangement back — the bounded, gated voice
controls as the main surface on top, and the free (live-model) lane collapsed at
the bottom — so the model-driven relay is reached through the free lane rather
than replacing the main surface. The move is a layout change only; the server
relay is unchanged. Two real defects found while reproducing the report were
fixed with it: the live lane's worker brief read **every** lane as `pi` (a Claude
or Antigravity lane therefore got no history), and a session with **no messages
yet** was described to the talker as *"not loaded on this server"*, which the
model turned into *"I don't have access"*. An existing-but-empty session now
reports that it is new and has no messages, and the prompt says to say so and
carry on rather than call it inaccessible. Plan:
[`plans/VOICE-MODE-UI-RESTORE-AND-LANE-FIX-PLAN.md`](./plans/VOICE-MODE-UI-RESTORE-AND-LANE-FIX-PLAN.md).

## 24. Standing model requirements

[`TALKER-MODEL-REQUIREMENTS.md`](./TALKER-MODEL-REQUIREMENTS.md) is the canonical
brief. The intent-relevant core:

- **Latency dominates**: ≤2 s to first token (p90); >4 s is unusable.
- **Faithful relay is "the single most important quality and the hardest to
  find."**
- **Rule adherence must survive conversational pressure** (*"just do it, stop
  asking me every time"*) — benchmarked explicitly; relaying without permission is
  a hard fail regardless of every other score.
- **Speakable output**: short sentences, no markdown, no paths read aloud.
- **Bilingual**: fluent English primary. **Finnish is nice-to-have, not a
  requirement** (operator decision 2026-09-16) — record it as a condition, do not
  gate on it.
- Screened-out failure modes: paraphrase before forwarding; acting on unfinished
  thoughts; confabulated action; over-asking.

## 25. Open items

1. **Multi-lane scope** — one machine (client-only, no contract change) or across
   devices (server-side lane registry + contract bump)? Cap of 3 lanes acceptable?
2. Should a fourth lane *replace* a lane or *ask which* to hand over?
3. A short **cue tone** before a hidden lane speaks, or is a visual marker enough?
4. Desktop defaults: breakpoint, column sizing, layout toggle placement.
5. Cross-tab playback arbitration — measured but unimplemented; one cross-lane
   floor owner proposed.
6. The audio lab `capture:chain` lane fails on this host (environment, not
   product), leaving the rendered-audio oracle indeterminate here.
7. **The confirmation-gate defect in §8** — authorised for immediate fix
   (recommendation D2), not yet fixed.

**Settled on 2026-09-17, recorded here so they are not reopened as questions.**
The native-transport migration is approved in principle (recommendation D3), and
with it: the verification campaign is streamlined to lean deterministic safety regression on the host kernel plus real-ear dogfooding, replacing the 210-run synthetic treadmill (D4);
provenance is enforced via out-of-band delivery receipts, structured worker context, and conversational qualification rather than audio voice-splicing (D5);
the conversational seat is the standard model with no escalation machinery (D6); and ambient operation is deferred to a
mobile client with a client-neutral kernel as the standing price of keeping it
open (D7, §20.1). The recommendation's §8 is the decision record; each step of its
§7 still carries its own gate, and production deployment remains separate.

## 26. Source map

- **This file** — canonical intent and current behaviour.
- **Orientation for the whole corpus:** [`VOICE-MODE-INDEX.md`](./VOICE-MODE-INDEX.md) — reading order, what is current versus superseded, and what the native-voice lab did and did not establish. Start here if you are new to the voice work.
- **Architecture target:** [`VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md`](./VOICE-MODE-ARCHITECTURE-RECOMMENDATION-2026-09.md).
- **Overlay UI:** [`DRIVE-MODE.md`](./DRIVE-MODE.md).
- **Talker model brief:** [`TALKER-MODEL-REQUIREMENTS.md`](./TALKER-MODEL-REQUIREMENTS.md).
- **Observability:** [`OBSERVABILITY.md`](./OBSERVABILITY.md) §Voice Mode.
- **Rendered-audio measurement:** [`AUDIO-REGRESSION-LAB.md`](./AUDIO-REGRESSION-LAB.md) + `scripts/audio-lab/`.
- **Cost:** [`VOICE-AGENT-PRICING-RESEARCH-2026-09.md`](./VOICE-AGENT-PRICING-RESEARCH-2026-09.md).
- **Lab specification:** [`VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md`](./VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md) — the tier definitions and measurement points; read §20.2 before quoting any latency figure.
- **Agreed designs:** `docs/plans/VOICE-READING-AND-QA-DESIGN.md`, `docs/plans/VOICE-MODE-OBSERVABILITY-DESIGN.md`, `docs/plans/VOICE-MODE-DESKTOP-LANES-AND-SESSION-VIEW-PLAN.md`.
- **Execution briefs (history):** `docs/archive/briefs/` — E1, H1–H8, P1–P27, R1–R2.
- **Operations evidence:** `operations/voice-card-20260915/`, `operations/change-requests-20260915/`, `operations/voice-desktop-20260916/`, `operations/voice-relay-20260916/`.
- **Superseded intent (history):** [`archive/VOICE-ORCHESTRATOR-FEASIBILITY.md`](./archive/VOICE-ORCHESTRATOR-FEASIBILITY.md), [`archive/VOICE-MODE.md`](./archive/VOICE-MODE.md), [`archive/VOICE-MODE-INTENT-RESEARCH-2026-09.md`](./archive/VOICE-MODE-INTENT-RESEARCH-2026-09.md).
