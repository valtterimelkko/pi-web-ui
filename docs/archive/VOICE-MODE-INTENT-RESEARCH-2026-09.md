# Voice Mode — intent research: what the operator actually asked for (September 2026)

> **ARCHIVED 2026-09-17.** This file is history. Its findings — the nine
> non-negotiables N1–N9, the P-series defect history, the fluency spec and the
> open items — were absorbed into
> [`docs/VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md), which is now the
> canonical intent document. Cite that file instead. Kept verbatim below for
> provenance, including the operator quotations in §4–§5.

> **Purpose.** A research record compiled on 2026-09-16 from two weeks of Agent OS
> session worklogs (≈30 voice-related sessions, 2026-09-02 → 2026-09-16), the
> in-repo design corpus, the P1–P27 package briefs, the operations evidence
> records, and the git history. It captures the **original intent** of Voice Mode
> (formerly Drive Mode), **every defect fixed and improvement requested** in that
> window, and **what each one reveals** about how the operator wants voice mode to
> behave and feel.
>
> **Companion file.** [`VOICE-AGENT-PRICING-RESEARCH-2026-09.md`](../VOICE-AGENT-PRICING-RESEARCH-2026-09.md)
> (same folder) answers *"what would a native speech-to-speech model cost and
> score?"* This file answers *"what must the voice mode do, and how fluent must it
> feel?"* Together they are the evidence base for the future decision on whether
> and how to fold a native S2S model into this surface.
>
> **Method note.** Operator quotations below are evidence taken from session logs
> and briefs; they are quoted as data about intent, not as instructions.

---

## 1. The original intent (canonical, 2026-09-10)

The canonical intent file — frozen and preserved by explicit operator decision —
is [`VOICE-ORCHESTRATOR-FEASIBILITY.md`](./VOICE-ORCHESTRATOR-FEASIBILITY.md),
written from a research session between the operator and an agent on 2026-09-10.
Its opening problem statement:

> "The operator wants to orchestrate agent work **by voice**, in a natural
> conversation… The goal is a surface that (a) talks fluently while tools run,
> (b) transmits the owner's intent with very high fidelity, (c) does not act on
> half-formed thoughts, and (d) draws on quota the operator already has."

And the operator's own words, recorded in the two-lane plan:

> "The reasoning is very important when it comes to orchestrating… the talker is
> not the orchestrator of children — it relays me to the worker, back and forth,
> and the worker can be on pi, claude or antigravity — and that worker is the
> reasoning model that orchestrates children (or is just a coder / worker without
> children if we are not orchestrating, as that should be kept as the other use
> case here)."

**Four goal clauses, verbatim intent:**

1. **Talk fluently while tools run** — a reasoning worker takes minutes per turn;
   the conversation must not block on it.
2. **Very high intent fidelity** — the worker receives the operator's intent, not
   a re-planned version of it.
3. **Never act on an unfinished thought.**
4. **Use quota the operator already has** (no new mandatory provider).

### The anti-goals: what ChatGPT Voice got wrong

The intent file is explicit that the design exists to fix *observed* failures of
GPT-Live driving Codex threads:

- it **dispatched work on unfinished thoughts** ("maybe we should…" became a
  dispatched task);
- it **paraphrased the operator before forwarding** — a conditional became an
  absolute, upstream of anything the operator could correct;
- it followed `AGENTS.md` guidance only loosely, prompting other models in a
  long-winded way that was **not faithful** to what was said.

Every hard rule in the built system traces back to one of these three.

## 2. The two-lane answer, and the two-axes correction

**The design answer:** two lanes per session. The **worker lane** keeps full
reasoning (and may itself orchestrate children or just code). The **talker lane**
is a separate small, fast, server-side harness that owns the spoken conversation:
it answers, acks, holds the operator's draft, and relays the operator's own words
— never doing work itself.

**Terminology correction (2026-09-12, operator-initiated):** early framing
conflated "voice" with "orchestration". The corrected model is two independent
axes — **Axis 1, the relay** (talker active or not) and **Axis 2, the worker's
role** (orchestrating children or working directly). All four combinations are
legitimate; *"just talking to a coding session"* is a **primary use case**, not a
degraded mode. "Drive Mode" was renamed **Voice Mode** at the same time; the
`DRIVE-MODE.md` doc survives to describe the overlay UI the voice feature speaks
through.

Two supersessions from planning are themselves intent-relevant history: the
talker was originally imagined as a **pi-enhancement extension**, but planning
proved Pi Web UI input never fires `pi.on("input")` (S1), and Antigravity has no
extension surface at all (S2) — so the talker moved **server-side into Pi Web
UI**, covering Pi + Claude + Antigravity. The intent (two lanes, high-fidelity
relay, permission gate) did not change; only the placement did.

## 3. The non-negotiables (where each one comes from)

These are the load-bearing rules. Each cites its origin; none may be quietly
weakened.

| # | Rule | Origin |
|---|---|---|
| N1 | **The relay is gated by code, not by the model.** The talker model has *no send path*; text reaches the worker only when a pending verbatim draft exists and the operator's next utterance mechanically classifies as confirmation. | Intent file rule 2 + 6; `VOICE-MODE.md` "mechanical gate" |
| N2 | **The relay text is always the operator's own words — semi-verbatim.** Own words; may be made more concise when speech rambles; never summarised into a plan, never expanded. | Intent file rule 3 ("the single most important quality"); restored as a drift fix in P25/`5d76e4f` |
| N3 | **Never act on an unfinished thought.** The draft mechanism exists so a half-composed instruction survives interleaved worker news (P3); each instruction requires **its own** permission. | Intent file rule 2; ChatGPT-Voice anti-goal |
| N4 | **Conversation first.** Questions and thinking-aloud are answered from a compact state view; nothing is dispatched. Requests addressed *to the talker* are answered by the talker, not routed to the worker (P22). | Intent file rule 1; P22 operator report |
| N5 | **You speaking is never interrupted.** Already-playing audio **ducks**, never hard-stops; capture is unconditional, only playback is scheduled. | Speech priority ladder, plan §4.1; operator-decided |
| N6 | **Honest delivery, always.** Fixed ack strings produced *after* the delivery outcome is known (delivered / queued / refused); the talker never claims the worker finished, never confabulates action. | Intent file rule 4; TALKER-MODEL-REQUIREMENTS "explicit uncertainty" |
| N7 | **Allow-list, not model judgement.** What the talker may do is an explicit allow-list denied in code; the utterance classifier is mechanical — model output is never an input to the gate. | Intent file rule 6; `utterance-classifier.ts` |
| N8 | **Never widen the gate's reachability.** If work seems to require it, the design is wrong, not the transport. | `VOICE-MODE.md`, verbatim |
| N9 | **Failures are visible, never silent** — server voice-turn records, client speech events, uploaded client voice crashes; a failed send restores the text. | P13 (operator instruction), observability design D4 |

## 4. Programme timeline (the two weeks, with receipts)

Full detail for every item below is in `docs/archive/briefs/` (H-series harness
briefs, P-series package briefs) and `operations/voice-*` records. Commit hashes
are on master.

### Phase H — harness and placement (2026-09-12…13)

- H1 server-side talker harness (state-view projection, justified-gate prompt,
  pending-proposal store); H2 Pi input routing (the S1 finding); H3 talker model
  retest — **GLM 5.3 Flash was the lean, ruled out on latency; Gemma 4 26B A4B IT
  selected** by a deterministic 600-point benchmark including a
  press-the-model-to-bypass-the-gate scenario (a relay-without-permission is a
  hard fail); H5 provider guard; H6 real MultiSessionManager delivery; H7
  browser⇄talker transport binding; H8 secrets migration.

### Phase P1–P9 — the surface exists (2026-09-13)

- P1 transport probe; P2 **receipt ack** (tier 2 of the speech ladder, server
  side); P3 **the operator's draft** — an unfinished instruction survives
  interleaving (drafts age only by operator turns, never worker turns); P4 client
  **speech arbiter** (`speechArbiter.ts`, playback-only authority); P5 the Voice
  Mode UI — two-lane surface, four-state floor banner, confirmation card; P6–P7
  Phase-5 live validation, 7/7 relays byte-equal, gate red-first; P9 real-browser
  E2E — which *found* the wiring defect beyond the gate.
- P12 (`ed3ea2f`): UI relays deliver — server-side id/path resolution, so
  "every UI relay now delivers".

### Phase P10–P27 — observability, honesty, fluency (2026-09-13…15)

- P10/P11 (`8d9f4ad`): **Voice Mode observability** (the `voiceTurnId` record
  vocabulary, now in `OBSERVABILITY.md` §Voice Mode) + per-runtime talker state
  view. Born from P24's lesson: two ordinary operator questions — *which session
  is this attached to?* and *what did I actually say?* — were unanswerable.
- P13 (`3b7b66b`): **barge-in crash fixed, client voice errors visible** —
  operator reproducibly got a full-screen error speaking while the talker read;
  zero server records; the browser was "completely dark". Operator instruction:
  make this class visible, then they re-test.
- P15 (`9261aba`): **"Stop talker"** — requested directly: stop the speech,
  cancel the queue, *don't come back to it*, but still speak genuinely new input.
  Playback-only; capture is never suppressed by it.
- P16 (`8b066b3`): **never say the same thing twice** — read-aloud and auto-speak
  collided at the same tier; dedup became surface-wide, whichever path started it.
- P17 (`729a222`): **reading levels** — Verbatim / Summary / Headlines
  (operator-approved design `VOICE-READING-AND-QA-DESIGN.md`, see §6 below).
- P18 (`f073197`): **Q&A package C** — "I can't answer that — shall I ask the
  worker?" (through the existing gate), focus/hold + exit recap, tier-4 split into
  elicited vs unprompted chatter.
- P19 (`9758495`): **whole-turn digest input** — mid-turn detail became reachable;
  auto-speak had fired only on the *last* assistant message.
- P20 (`7fd28ac`): **talker sees the worker's earlier turns** — mid-session
  attach Q&A; the operator's stated *primary* Q&A use case.
- P21 (`ed38ca9`): **eaten first words + pauses fixed** — one-ahead synthesis +
  synthesis retry. Operator report: the talker was "eating a few words" at the
  start of speech, with audible pauses on longer reads.
- P22 (`e84599a`): **a request addressed to the talker is answered, not held for
  the worker** — "summarise what has been done in this session" was being drafted
  as a worker instruction because every imperative classified as `statement`.
  Operator words: *"it always wants to route it as a request to the worker… it's
  kind of wanting to relay something and it's explaining it to me at the same
  time."*
- P23 (`901bcb8`): **the talker can see a long answer** — the history window took
  the last 12 messages clipped to 400 chars, so a real production-queue answer
  (message 16 of 32) was invisible. Operator: *"it just wouldn't, simply wouldn't
  do it."* The history window must be able to answer "what has been done in this
  session".
- P24 (`baeea3d`): **which worker session, and what was actually said** —
  diagnosability made first-class.
- P25 (`5d76e4f`): **restore the intent's semi-verbatim relay** — a *drift*
  finding: the build had over-corrected to byte-for-byte verbatim and dropped the
  intent's "optionally made more concise when the speech rambles" clause. The
  harm was real: "ask the worker if it has enough materials…" read by the worker
  as a dispatch-sub-agent instruction. Fix: mechanical transform — strip
  carriage/filler, never content.
- P26 (`12bde6d`): **the surface teaches the contract** — operator: *"I'm not
  sure how to talk to that agent… I've been kind of a little bit lost."* Treated
  as a **design failure, not a user failure**: the card now says truthfully what
  happens to the operator's words (and stopped claiming "your words, exactly"
  once semi-verbatim was restored — an untrue safety claim is worse than none).
- P27: the talker function matrix — live validation pinning the full function
  surface, including the card contract.
- **Audio regression lab** (`9e48834`, `abd06e8`, `d26484d`, `184c51c`,
  `575842a`, `500eaf6`, `548d682`, `386d410`, 2026-09-14): built because claims
  like "the first words were eaten" are claims about **rendered audio** that
  neither server logs nor transcripts can confirm. See §7.

### Wave — confirmation-card honesty (2026-09-14…15)

Operator reported the card claimed it had tidied his prompt while the text looked
verbatim identical, that "removed" carried his entire original utterance, and that
he had expected an option to **send his original words** which never appeared.
D1 (`0798661`, `447f43e`): whitespace-only normalisation no longer cries wolf;
deleting punctuation is a *visible* change and the card says so. D2 (`8c5e196` +
`a0ac7dd`, contract 1.44.0): **original-variant release** — the operator can send
their own original words, with proposal identity + staleness refusal so the card
can never release stale bytes. Archive: `operations/voice-card-20260915/`.

### Wave — multi-lane in one tab (2026-09-15)

Operator report (from `MULTILANE-DESIGN.md`): *"when holding two voice modes on
separate browser tabs, I might struggle to switch — especially if I'm trying to
voice myself on one while the other, unexpected started to talk. the microphone
button does not seem to activate, even if the browser tab activates the red
'recording' button."* Two tangled problems, answered separately:

- **The defect** (`86ce22b`): one owner per microphone — a tap during device
  acquisition could start a second recorder and leave the button dead while the
  browser showed "recording"; fixed with a single-owner capture object,
  acquisition lock, `'starting'` state, unmount teardown, and an idempotent abort
  endpoint.
- **The redesign**: lanes in one tab — lane store, per-lane state, in-page floor
  coordinator, `talkerBus` request/lane correlation (`d6dcd22`…`51e6d81`).
  Cross-lane *playback* arbitration across tabs remains a design note only
  (`operations/change-requests-20260915/child-voice/MULTILANE-DESIGN.md`),
  awaiting operator decisions (§9).

### Wave — desktop rework (2026-09-16)

Operator-requested: the desktop session pane must render the **real session
view**, lanes must work in the desktop layout with a smaller session pane, and
any lane's worker must be **switchable in place** (`11e4051`, `67c5719`,
`735ed78`; per-lane spoken-content scoping `7f43ba2`). Live-validated in a real
browser with paired evidence: `operations/voice-desktop-20260916/`.

### Wave — relay robustness (2026-09-16)

Operator report: *"I sent an instruction to be relayed to the worker… it was all
green… but the talker itself said I couldn't send that. So I don't know if it
worked or not."* Investigation: the instruction was **not** relayed — the worker
was idle/unloaded after a production restart, the path-keyed lookup failed, and
the UI had claimed success anyway. Fixed (`d27e75c`): a relayed instruction
survives an idle or restarted worker, **and says so plainly** — the surface may
never report green when delivery was refused. Also from the same report: the
talker summarising "what the worker has captured" was noise the operator had to
talk past — *"I do not need to know what they have captured."*

### In flight at capture time

- **Injection marking** (session `01a0aa8f`, working 2026-09-16): Agent OS
  routine injections are being marked structurally at the emitter and **excluded
  from the talker's spoken context** — bookkeeping must never be spoken to the
  operator.

## 5. What the defect record says about intent

Read as a whole, two weeks of fixes describe one consistent picture of what the
operator wants:

1. **The talker is a colleague, not a switchboard.** It answers from what it
   genuinely holds (P20, P22, P23), it *offers* to ask the worker rather than
   reflexively routing (P18, P22), and it never narrates bookkeeping the operator
   didn't ask for (relay-robustness report, injection marking).
2. **Nothing false is ever said or shown.** Not by the model (N6), not by the card
   (D1/D2), not by the delivery pipeline (d27e75c). Green means delivered. "Your
   words" means what it says it did to them. An untrue safety claim is worse than
   no claim (P26).
3. **The operator's words are sacrosent and sovereign.** Semi-verbatim by design;
   concise-when-rambling by design; the *original* wording is always available and
   sendable (D2); staleness is refused rather than silently swapped.
4. **Fluency is defined by recovery behaviour.** Barge-in must crash nothing
   (P13); ducking replaces stopping (N5); speech resumes at chunk boundaries,
   never mid-word; a stopped read stays stopped (P15); what already played never
   replays; the level can flip mid-answer with an audible "In short:" marker
   (P17); the first word and the joins must survive synthesis (P21).
5. **The operator must never have to re-explain.** Drafts survive interleaving
   (P3); the talker can see the worker's earlier turns (P20); mid-turn detail
   reaches the digest (P19); a dictated prompt is never lost to a mobile socket
   drop (E1); the same thing is never said twice (P16).
6. **The system must be inspectable.** Which session is attached, what was
   actually said, what phase a turn reached, what a confirmation released — all
   one documented query away (P10, P11, P24, `OBSERVABILITY.md`).

## 6. Fluency spec — the agreed reading and Q&A design (operator-approved, 2026-09-14)

`docs/plans/VOICE-READING-AND-QA-DESIGN.md` is the operator-approved
specification; its key decisions are intent, not implementation detail:

- **Three reading levels** — Verbatim (precision moments), Summary (the default),
  Headlines (*"Done: X. Needs you: Y."* — a different *extraction*, not a shorter
  summary, designed to be left on permanently while wearing headphones).
- **Short turns are spoken verbatim even in Summary** — under ~30 seconds of
  speech (~400 chars), summarising is pure overhead and risks distortion. Named
  constant, reasoning recorded.
- **The level flips mid-answer, immediately** — the current item stops at the
  next sentence boundary, the unplayed remainder is re-digested, what was already
  heard never repeats, and the change is announced ("In short:") because *not
  knowing whether you heard everything* is the dangerous failure of
  summarisation. Rationale the operator approved: "reaching for the switch means
  you want it *now*; a control that makes you wait out the very verbosity you are
  trying to escape reads as broken."
- **Ask-the-worker is an offer through the gate** — when the talker cannot answer
  from what it holds, it offers; confirming is the same mechanical gate as any
  relay.

## 7. The audio regression lab — why it exists

[`AUDIO-REGRESSION-LAB.md`](../AUDIO-REGRESSION-LAB.md) is the measurement
answer to a class of operator reports that motivated P21: *"the first words were
eaten"*, *"a chunk vanished"*, *"it stopped instead of ducking"* are claims about
**rendered audio**, and no server log or transcript can confirm or refute them.
The lab drives the *real* product player and arbiter in a real headless Chrome,
records the OS output of a private PulseAudio null sink with an independent
`parec` monitor, and scores against **frozen tolerances** (head/tail loss fails
at ≥100 ms; chunk joins ≤100 ms p95; ducking ≈0.15 gain; sample-domain
correlation ≥0.6) with a demonstrated adversarial matrix. Run it before and
after any change in the speech path:

```bash
npx tsx scripts/audio-lab/cli.ts run
```

Known host caveat: on this machine `doctor` reports 18/19 — the
`capture:chain` lane fails (private PulseAudio daemon cannot start), so the
OS-output oracle lane is unusable here and yields indeterminate; the app lane and
offline record verification still work. A pass is evidence about *this* render,
never a promise about a user's laptop — read its limitations section before
quoting a pass.

## 8. The talker model — standing requirements

[`TALKER-MODEL-REQUIREMENTS.md`](../TALKER-MODEL-REQUIREMENTS.md) is the
canonical brief. The intent-relevant core:

- **Latency dominates**: ≤2 s to first token target (p90); >4 s is unusable for
  conversation. This is why the talker is a small model and why GLM 5.3 Flash was
  rejected and Gemma 4 26B A4B IT (`google/gemma-4-26b-a4b-it` via OpenRouter)
  selected by benchmark.
- **Faithful relay is "the single most important quality and the hardest to
  find"** — preserve the operator's wording and every specific; condensing
  rambling is allowed, re-planning is not.
- **Rule adherence must survive conversational pressure** ("just do it, stop
  asking me every time") — benchmarked explicitly; relaying without permission is
  a hard fail regardless of every other score.
- **Speakable output**: short sentences, no markdown, no paths read aloud.
- **Bilingual**: fluent English primary, **Finnish secondary** — the operator
  switches mid-conversation. (Finnish capability remains *unverified* for
  alternative models; see the pricing research §8.)
- Screened-out failure modes, all observed in production voice agents: paraphrase
  before forwarding; acting on unfinished thoughts; confabulated action;
  over-asking.

## 9. Open items and operator decisions pending

From `MULTILANE-DESIGN.md` §6 (child V, 2026-09-15 — awaiting the operator):

1. Multi-lane scope: **one machine** (client-only BroadcastChannel, no contract
   change) or **across devices** (server-side lane registry + contract bump)?
   Cap of 3 lanes — acceptable?
2. Should a fourth lane *replace* a lane or *ask which* to hand over?
3. Is a short **cue tone** wanted before a hidden lane speaks, or is a visual
   marker enough?
4. Desktop defaults: breakpoint, column sizing, whether the layout toggle belongs
   on the entry screen, whether desktop should default on for wide screens.

Other open threads: cross-tab playback arbitration is measured-but-unimplemented
(per-tab arbiter singletons; one cross-lane floor owner proposed); Finnish
quality unverified on any candidate replacement model; the audio lab
`capture:chain` lane fails on this host (environment, not product); the
native-S2S replacement decision itself (pricing research §8.6 — standard
`gemini-3.8-live` is the default *candidate*, nothing chosen).

## 10. Reading this alongside the pricing research

The two files together frame the standing decision. The pricing research
establishes that a native S2S model (now: Gemini 3.8 Live, $3/$12 audio tokens —
identical to 3.1 Flash Live) could collapse the STT → text → talker → TTS
cascade into one spoken lane at ≈$22–32/month. This file establishes everything
a replacement would have to *preserve*: the mechanical gate (N1/N7), semi-verbatim
relay of the operator's own words (N2), the anti-duet ladder with unconditional
capture (N5), honest delivery disclosure (N6), reading levels with mid-answer
flips (§6), the fluency/recovery behaviours (§5.4), and the observability
vocabulary (§5.6). Historical evidence says the risk is precisely where S2S
models are strongest-sounding: the AA arena's own caveat — *a preferred
conversation does not always result in successful task completion* — is the
same failure shape the operator observed in ChatGPT Voice and designed this
whole system to prevent. Latency (≤2 s TTFA) and the ≤$0.36/h class of cost are
already met by the candidates; fidelity-under-pressure is the open question.

## 11. Source map

- **Canonical intent:** `docs/VOICE-ORCHESTRATOR-FEASIBILITY.md` (frozen);
  `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` §1–§2 (intent table I1–I18,
  supersessions S1–S3).
- **Canonical current behaviour:** `docs/VOICE-MODE.md`; overlay UI:
  `docs/DRIVE-MODE.md`.
- **Talker requirements:** `docs/TALKER-MODEL-REQUIREMENTS.md`.
- **Package briefs:** `docs/archive/briefs/P1…P27`, `H1…H8`, `E1`, `R1–R2`.
- **Agreed designs:** `docs/plans/VOICE-READING-AND-QA-DESIGN.md`;
  `docs/plans/VOICE-MODE-OBSERVABILITY-DESIGN.md`;
  `docs/plans/VOICE-MODE-DESKTOP-LANES-AND-SESSION-VIEW-PLAN.md`.
- **Validation/lab:** `docs/plans/VOICE-MODE-VALIDATION-RESULTS.md`;
  `docs/plans/VOICE-MODE-BROWSER-E2E-RESULTS.md`;
  `docs/AUDIO-REGRESSION-LAB.md` + `scripts/audio-lab/`.
- **Operations evidence:** `operations/voice-card-20260915/`;
  `operations/change-requests-20260915/` (incl. `child-voice/complete.md`,
  `child-voice/MULTILANE-DESIGN.md`); `operations/voice-desktop-20260916/`;
  `operations/voice-relay-20260916/`.
- **Session worklogs:** ~30 pi sessions 2026-09-12…16 (P1–P27 series, wave
  children, relay/desktop validations) retrieved via `agent-os worklog`; the
  intent quotes in §4–§5 are operator statements recorded in those logs and
  briefs.
- **Companion:** `docs/VOICE-AGENT-PRICING-RESEARCH-2026-09.md` (§8 covers
  Gemini 3.8 Live, launch-day data).
