# Voice Mode — execution state (PARENT)

> **READ THIS FIRST after any compaction or handover.** This file is the durable
> record of the 2026-09-12/13 voice-harness execution. Everything below the
> summary is append-only history with raw evidence, in the order it happened.

## Where things stand (2026-09-13)

**All work packages are complete, verified and merged.** Production is healthy.

| Package | Outcome |
|---|---|
| H1 talker harness | ✅ committed — 10 modules, structural send gate, 97 tests |
| H2 Pi input routing | ✅ merged — the extension input event now fires for Web UI input |
| H3 model retest | ✅ committed — 5 candidates retested against the real harness |
| H4 long-session | ✅ committed — design claim NOT falsified, 157 turns, 17 trims |
| H5 Gemma provider guard | ✅ committed — provider preference + bounded retry |
| H6 server integration | ✅ committed — one talker per session, injection check applies |
| H7 transport binding | ✅ merged — the browser can now reach the talker |
| E1 mobile socket durability | ✅ merged — resume recovery, no lost sends |
| H8 secrets migration | ✅ complete — every live secret now outside the repo |
| R1 stall root cause | ✅ 3 investigations converged, parent-reproduced |
| R2 stall defect fixes | ✅ committed + **deployed to production** |

**Production:** contract 1.42.0, `capabilities` ~0.2 s, zero startup errors, and
the broker eviction counter **0** where it previously ratcheted to 659,400.

## The two things a resumed agent most needs to know

1. **The talker's send gate is structural, not instructed.** The release path is
   private, reachable only from the confirmed-proposal branch, and takes **no
   relay text** — the text comes solely from a verbatim utterance store the model
   cannot write to. **Never widen its reachability.** If work appears to require
   that, the design is wrong, not the transport.
2. **There are TWO physical copies of the pi-ai library**, and hosted sessions
   load the **nested** one under `pi-coding-agent/node_modules`. A patch applied
   only to the root copy appears to succeed and changes nothing. The fix now ships
   via a `postinstall` regeneration script that patches every copy and fails loudly
   on drift.

## What remains

- **Phase 4 — the Voice Mode user interface.** The only substantive work left.
  Rename Drive Mode → **Voice Mode** (operator-decided). Needs the
  talking-while-working phase machine, sentence-chunked TTS, voice confirmation
  with a text fallback echoing the exact proposal, and the **anti-duet rule** —
  now **DECIDED** (operator, 2026-09-13) and written up in the plan at
  **§4.1 The speech priority ladder**: the operator's own speech outranks
  everything (never interrupted), an unacknowledged utterance gets one short
  **receipt** ack before the worker's answer is relayed, and **no operator
  utterance may ever be lost** — capture is unconditional, only playback is
  scheduled. Adds acceptance criteria **A9/A10/A11**, with A10 (unconditional
  capture) the highest-value test in the phase.
- **Not yet exercised:** the merged transport has not been driven from a real
  browser against a real worker — only tests and server-side live validation.
  This is why the phase opens with a bounded E2E probe rather than UI work.
- **Optional:** reusing Pi's stored zai credential for the Claude GLM profiles
  instead of the migrated token (a code change in `claude-profiles.ts`, separate
  from the completed migration).

## Operating lessons that cost time here

- `git worktree` + this repo needs **per-package `node_modules` shadows**
  (`server/node_modules/zod`, `shared/node_modules/zod`), not just a top-level
  symlink — the top-level-only approach resolves zod 4 instead of 3 and produces
  spurious typecheck errors in untouched files.
- Vitest has **two configs**: jsdom lives in `client/vitest.config.ts`, rooted at
  `client/`. Running a client hook test with the default config fails on
  `document is not defined` and looks like a real bug.
- `gh`-style owner questions and long waits: see the incident sections below. The
  notification helper rides the Internal API, so during an API outage it **spools
  silently** — reach the operator via the Telegram bot API directly (a workaround
  is recorded in the incident section).
- **Cancel watch registrations for settled children.** 11 stale polls per 30 s is
  real load, and reduced polling was one of the lessons from the stall.

---

---

---

---

---

---

---

---

---

## 2026-09-13 ~19:55 — OBJECTIVE MET: the browser relays, byte-for-byte (P12)

The browser E2E left one open defect: the assembled UI worked up to the confirm gate
and then every confirmed relay was **refused**, because the UI sent the session **id**
while the delivery machinery resolved **paths**. Fixed server-side, once, at the
delivery boundary (`resolveSessionRef` + `canonicalWorkerRef`), path-first so every
existing path-based caller behaves identically, and loud on an unresolvable
reference — no try-id-then-path guessing, because a silent wrong answer is worse than
a refusal. The manager's own semantics are deliberately unchanged: `prompt()` still
refuses an id, pinned by a test, because resolution belongs at the boundary.

**Parent-verified evidence, read from the raw JSON rather than the report:**

| Check | Value |
|---|---|
| Worker transcript at the proposal | **0 entries** — the gate held |
| `card_eq_worker` / `released_eq_worker` / `utterance_eq_worker` | **all true** |
| Byte count in the worker's own transcript | **68** |
| Release banner (screenshot `08-released.png`) | *"delivered (prompt)"* where it previously read **refused** |
| Path regression (live) | `talker-live-validate.ts` → LIVE-VALIDATED, `TALKER-RELAY-OK` |
| Suites / typecheck / ratchet | 126/126 · clean · **1736 ≤ 1738** |

**Honest residual from that run:** the worker's own model was quota-exhausted
(Kimi 403), so the worker could not produce an *answer*. What this run proves is the
**relay** — the operator's words in the worker's own transcript, byte-for-byte, from
the real UI. A completed conversational turn is proven separately (the live path
regression and P9's three bisect runs).

**Also corrected:** the `TalkerTurnMessage` doc comment in `protocol.ts` still claimed
*"Pi: the session path"* — the contract that caused this defect. The child flagged it
as outside its owned paths; the parent folded it in. A wrong contract comment on the
exact field that broke is worth fixing, not tolerating.

**Still open, carried forward deliberately:** the REST `/api/sessions` listing on a
disposable server exposes the operator's **production** sessions (found by P9,
file:line in its results doc, not fixed — product was frozen for that package); the
Antigravity validation gap; and the operator listening check.

---

## 2026-09-13 ~15:48 — CI GREEN on 4e88f78 (programme complete)

**Parent-verified directly, not taken from the background watch:**

| Workflow | Latest run | Verdict |
|---|---|---|
| `application.yml` | `4e88f78` (15:38) | **success** |
| `agent-guides-sync.yml` | unchanged since 08 Sep | success |

The failing runs listed above it (`0ea0cbf`, `e8934a1`, `2dc5ff6`, `662f40f`,
`6d9618a`) are the superseded commits from this session — real failures at the
time, and their record stays. The head is green, and a new commit to master will
build green.

**Watch-ledger hygiene, applied to our own work.** Eight registrations were still
polling every 30 s for children that had finished hours earlier (~16 requests/min
of noise, plus a residency claim each). All cancelled with confirmed remote
deletes; the full ledger of 22 is now released. One (`ww_9`) reports
`remote_delete: not-authorised` from a generation mismatch — its local delivery is
stopped and the generation was already superseded, so it is inert, but it is the
one entry without a *confirmed* remote delete and is recorded as such rather than
rounded up to "clean". The lesson from tonight (cancel watches for settled
children as part of finishing) had been applied to the children but not to our own
accumulated registrations.

**Still open, carried forward deliberately:** `docx-fidelity-guard` (979 lines of
unique unpushed work in a 6-week-old branch — owner decision: merge, push for
safekeeping, or discard); F3 (the talker's state view is Pi-manager-based, so
status conversation about a Claude worker is blind); and the two recorded
validation gaps (Antigravity; the operator listening check).

---

## 2026-09-13 ~15:35 — P8: CI green (ratchet cleared, coverage verified)

**The CI failure was NOT a broken gate.** Correcting the parent's earlier claim: the
workflow alternates (20 pass / 20 fail in the last 40 runs); the last success was
12 Sep at `warnings: 1735, ceiling: 1738`. This session's commits added ~41
warnings and pushed it over. **The debt was ours, not the gate's.**

**The ratchet also caught a real bug the normal lint cannot see.** `npm run lint`
checks `.ts/.tsx` plus two named `.mjs` files; the ratchet lints every
`js/mjs/cjs`. In `scripts/talker-spot-check.mjs` the summary object declared
`turns` **twice** — `results.length` then the mapped array — so the count was
silently discarded by the duplicate key. Fixed as `turnCount` (commit `2dc5ff6`).

**P8 result, parent-verified:**
- `warnings: 1776 → 1736`, ceiling **1738, unchanged** — `violations: []`, exit 0.
- **No suppressions**: grep for added `eslint-disable`/`@ts-ignore`/`@ts-nocheck`
  returns nothing.
- **No test weakened or deleted**: 0 test files removed, 0 `it(` removed. Five
  `expect(` lines changed — checked in context: they are `result.released!` →
  `const released = …; if (!released) throw`, i.e. a non-null assertion replaced by
  real narrowing **plus a guard**, so the assertions are stronger, not weaker.
- **No threshold or default touched**: `maxWarnings: 1738` and every vitest
  threshold unchanged.
- Production-source edits are behaviour-neutral: `let`→`const` where never
  reassigned, plus genuine `any`→`unknown` narrowing with type guards in the
  talker scripts.
- **5 warnings honestly reported as unfixable** without behaviour risk (a
  deliberate closure-ordering `let`, and three cyclic-init `let`s with receipts) —
  reported rather than silenced, which is the right call.
- **Coverage, all four workspaces pass**: server 80.32/78.14/84.09/80.32,
  client 70.69/78.05/60.25/70.69, shared 93.31/82.73/94.44/93.31,
  internal-api-mcp 94.63/80.44/88.54/94.63.

**Still open, stated not hidden:** F3 (the talker's state view is Pi-manager-based,
so status conversation about a Claude worker is blind) and the two carried-forward
validation gaps (Antigravity; the operator listening check).

---

## 2026-09-13 ~13:10 — P5 the Voice Mode UI COMPLETE (verified by the parent)

P5's goal read back **achieved**. The surface exists and the parent **looked at
it** rather than accepting a description.

**Real screenshots, not a claim.** The child produced eight PNGs in
`/tmp/voice-mode-shots/` by driving the actual UI (`start recording` / `stop
recording` buttons, a fake media device, stubbed network) — `1-idle`,
`2-you-have-the-floor`, `3-talker-speaking`, `4-answer-ready-held`,
`5-working-silently`, `6-barge-in-floor-with-badges`, `7-confirmation-card`,
`7b-confirmation-card-scrolled`. The parent read them directly.

**What the four states actually look like:** *You have the floor* is a red orb
with a red badge; *Answer ready — held* is purple with an `answer held` chip and a
**neutral, still-enabled** mic; *Talker speaking* is blue; `idle` is quiet. The
barge-in state reads **"You have the floor · speech ducked · answer held"** — the
exact information the operator asked for.

**The confirmation card** says *"Ready to send — your words, exactly:"*, shows the
operator's verbatim text behind a blue rule, and offers explicit Confirm / Cancel
plus a typed fallback.

**The operator's hard constraint, checked in the source.** The mic control carries
`disabled={voice.state === 'processing'}`. That line is **pre-existing** (it was
`dictation.state` in HEAD), and `processing` is the *transcription round-trip*
state — not a speech state — so the mic is never disabled while the surface
speaks, which is what the operator rejected. The call site documents the intent.
The child **kept** it rather than removing it, which is correct: removing it would
have introduced a double-submit.

**The dev harness decision.** `client/voice-harness.html` + `src/dev/voiceHarness.tsx`
were kept deliberately. It renders the REAL components with only the network
stubbed, which is what made the screenshots honest, and it lets the operator look
at the surface without a backend. Verified it cannot ship: a production build
emits only `index.html` + assets, and grepping `dist/` for harness markers finds
nothing. It opts out of `tsc` and `eslint` because it is dev-only scaffolding —
recorded here as a conscious trade-off rather than silent drift.

**Independent verification:** client typecheck clean; full client suite **97 files
/ 1064 tests passing** (up from 1037); production build succeeded; screenshots
inspected directly.

Two cosmetic observations, not defects, for the operator's eye: the
"answer ready — held" badge repeats the word *held* in its chip, and the typed
fallback placeholder is truncated mid-word in the card.

Committed `6d9618a`.

---

## 2026-09-13 ~12:49 — P3 the operator's draft COMPLETE (verified by the parent)

P3's goal read back **achieved**. The parent ran the suite: **15 files, 173 tests
passing**, up from 150 — so 23 tests were added net and nothing was lost.

**The three properties, verified in the code:**

- **The draft survives interleaving** — compose, run many conversation turns,
  resume, confirm; the released text is the whole draft, verbatim.
- **A lapsed draft is surfaced, never dropped** — a refusal quotes the draft,
  keeps it, and a re-confirmed yes then releases it. Release-time enforcement
  holds even when no tick observed the lapse.
- **Supersession holds both** — a second unreleased instruction accumulates, and a
  confirm releases both in composition order, byte-verbatim.

**The parent's explicit question — was any safety-property test weakened?** No.
Six existing tests were **renamed, none dropped**. Checked by diffing for removed
assertions and then locating each property under its new name: atomic consumption
("authorisation used once"), cancel-clears-so-a-later-yes-releases-nothing,
release-time staleness at the send boundary, exactly-once for a multi-part draft,
and ambiguous-never-acts all survive. Several were **strengthened** — a refused
release must now *not destroy* the draft, and "cancel clears the whole accumulated
draft" is broader than the single-candidate original. The old replace-and-expire
tests changed because they encoded exactly the semantics this package replaces.

**The gate is still structural, not merely intended.** Checked directly rather
than inferred: `release()` is still `private` with a **single caller**, and there
is still exactly **one** delivery call, carrying `taken.text`. Subset selection
("just the second one") resolves against a fixed mechanical ordinal vocabulary and
takes parts **by id**, so text still comes from the store and selection cannot
compose it. Without that, partial selection would have handed the model a
text-composition path into the relay.

One self-correction worth recording: the parent's first check for the term
"over-aged" returned zero matches and looked like a missing safety test. The grep
was wrong (`\|` inside `grep -E`, where alternation is `|`), not the code — the
test exists and passes. Checked rather than reported as a defect.

Committed `fa6550c`, path-limited to P3's server files (P5 still owned the client
tree; the staged set was verified to contain zero client paths).

---

## 2026-09-13 ~12:23 — P4 client speech arbiter COMPLETE (verified by the parent)

P4's goal read back **achieved**. The parent ran the client suite rather than
trusting the report: **94 files, 1037 tests, all passing**, client typecheck
clean.

**The three properties, verified in the source and by running the tests:**

- **Chatter dropped, not queued.** Tier 4 plays only from a completely idle
  arbiter and is dropped — not deferred — whenever a higher tier is playing,
  waiting, paused, or the operator holds the floor.
- **Ducking restores at a chunk boundary.** Barge-in lowers the in-flight gain
  live and per chunk; restoration is a chunk-boundary event so nothing resumes
  mid-word. `stopAll()` is the only hard cancel — barge-in never stops.
- **Capture is not gated by playback.** The arbiter has **no capture-side API at
  all**, which is the structural reason an utterance cannot be lost to playback
  state. That is a better answer than a behavioural guard would have been.

Also carried: the receipt ack's precedence over a playing answer (tier 2 preempts
tier 3 at a boundary and the answer resumes), sentence chunking that avoids
splitting decimals and abbreviations, and a new `operatorSpeaking` signal from the
dictation hook — the client had no such state before.

**The child found a real defect in its own first pass**, which is the most
valuable thing in this package: the preemption branch was not gated on the
operator's floor, so an ack arriving while an answer played *and* the operator was
mid-utterance would have started speech over them — exactly the failure rule 1
forbids. Its own RED test caught it (`expected [ 'a1.', 'ack.' ] to deeply equal
[ 'a1.', 'a2.' ]`), and preemption is now gated on `!operatorSpeaking` at
`speechArbiter.ts:207`, with the switch at the first boundary after release. The
parent confirmed the gate in the source rather than accepting the claim.

**Known limits, stated by the child rather than claimed:** audible ducking quality
and real AudioContext/TTS behaviour are not testable headlessly.

Committed `0041ecf`, path-limited to P4's client files.

## 2026-09-13 ~12:23 — P5 (the Voice Mode UI) dispatched

With the arbiter interface in place the surface is unblocked, so P5 is running
**in parallel with P3** — disjoint trees, client versus server, no coordination
hazard.

The brief carries the operator's own constraint most prominently: **the mic is
never disabled.** Tapping while speech plays is the barge-in gesture; adding a
`disabled` to that control is the "locked out for minutes" failure the operator
rejected, so the brief says explicitly to stop and report rather than do it.

It also requires a **screenshot or a precise description of the four visual
states**, and says plainly that describing an interface the child has not seen is
not acceptable. This is a user-facing surface and the parent has to judge whether
the clarity the operator asked for is actually present — a green test suite cannot
answer that question.

The rename is scoped deliberately: **user-facing labels and the store's public
naming only**, not a file-name sweep. The brief states the reason (a large
mechanical diff that makes review impossible for no user benefit) so a later agent
does not "tidy" it.

---

## 2026-09-13 ~12:06 — P2 receipt ack COMPLETE (verified by the parent)

P2's goal read back **achieved**. The parent reviewed the diff and ran the suite
rather than trusting the report.

**The three properties, verified in the code:**

- **A receipt, never an agreement.** `RECEIPT_ACK = 'Noted — still holding that.'`
  Nothing has been relayed when it is spoken and the confirmation step follows.
  Tests pin the string exactly and assert it cannot be read as assent, a send, or
  an action taken.
- **Once per relay, never per utterance.** `takeReceipt()` marks the whole
  outstanding set acknowledged and returns the count it covered, so three
  utterances in a row yield **one** receipt. It consumes the condition by the
  take rather than by observation — deliberately mirroring `takeForRelease()` —
  so repeated answer-ready moments cannot repeat it, and a later utterance
  re-arms exactly one more. That symmetry with the release path is the nicest
  thing in this diff; it makes the receipt's lifetime behave like the gate's.
- **Harness-produced, never model-produced.** The selector is a pure function
  taking only a count, so no model behaviour can compose, substitute for,
  suppress, or extend a receipt. Tests cover an imitating reply, a model failure,
  and an attempt to re-arm an already-given receipt.

**The gate is untouched.** The diff adds an `acknowledged` flag, a count method
and `takeReceipt()`; `takeForRelease`, `recordCandidate`, `tickTurn`, `cancel`
and `recordReleased` are all unmodified — checked by grepping the diff for
release-path identifiers, which found only a comment.

**Independent verification:** the parent ran the talker suite — **13 files, 150
tests, all passing** — including the pre-existing talker suite, which is what
demonstrates the gate did not regress. Committed `5e97bb4`, path-limited to P2's
server files because P4 still owned the client tree.

## 2026-09-13 ~12:07 — P3 (the operator's draft) dispatched

P2 released `pending-proposal.ts`, so the §4.2 draft work could start without two
writers in one file. P3 owns `pending-proposal.ts`, `talker.ts`, `prompt.ts` and
their tests; **P4 still owns the client tree.** Dispatched at `max` with its own
goal armed.

The brief specifies the invariants rather than the method, and adds one design
point the plan implies but did not state: **a release releases verbatim text
selected by utterance id — never composed.** If the operator says "just the
second one", the harness selects a subset of ids; the model must have no route to
compose, edit, summarise or re-word what is sent. Without that, partial selection
would quietly hand the model a text-composition path into the relay, which is
exactly what the gate exists to prevent.

The brief also warns P3 that **existing tests asserting the old semantics will
legitimately need to change** (candidate replacement, expiry at
`maxPendingAgeTurns`, a second "yes" after release finding nothing) — and that it
must name each changed test and justify it, and must never weaken a test pinning a
genuine safety property. That instruction exists because those old tests are the
very semantics this package replaces, and a confused child might otherwise either
refuse to touch them or silently delete them.

---

## 2026-09-13 — §4.2 Interleaved composition: the operator's draft (DECIDED)

**The operator's question, and it found a real gap.** Their scenario: the worker
is mid-task and emits something important; the operator is simultaneously
composing a new instruction with the talker and may go back and forth before
permitting a relay; the worker's news arrives during that composition and is
relayed; then they resume the half-finished thought. *Will the talker still know
where they left off, without making them re-explain?*

**Today's answer is no.** Verified in code, not inferred:

- `recordCandidate()` **replaces** any existing candidate — a second utterance
  silently supersedes the first, and the first is never offered for release.
- `tickTurn()` **expires** the candidate after `maxPendingAgeTurns` (6). Since
  that counter advances on *worker* turns, an interleaved worker conversation
  ages the operator's unfinished instruction out of existence, and a later "yes"
  releases nothing at all.

Both behaviours were deliberate and defensible alone (a "yes" must resolve to one
thing; stale text must never be released). The error is that they are applied to
**the wrong object**.

**The decision.** Separate the operator's thread from the confirmation:

- **The draft** — the operator's accumulating verbatim composing thread — is
  **harness state resolved by object reference**, never reconstructed from
  conversation history and never written by the model. Same principle the release
  gate already follows, which is what makes it survive interruption, worker news,
  compaction and model variance.
- **The confirmation** is a snapshot of the draft, released atomically once.

**Ageing is re-anchored, not removed.** The confirmation window still exists and
still refuses to release un-reconfirmed text. But it expires the *confirmation*,
not the *draft*: the draft is marked needs-re-confirmation and the talker says so
("You were composing something — 'tell the worker to X'. Still want that?").
Nothing is silently dropped; nothing stale is released.

**Supersession gets loud**, per the operator's accepted recommendation: a new
utterance that would replace an unreleased one makes the talker hold both and ask
which, rather than replacing silently.

**Two independent lanes.** Relaying worker news never touches the draft, and
resuming the draft never discards the worker's news (it stays in the transcript).
The talker arbitrates playback order, never content ownership.

A mid-thought **pause** needs no special mechanism: with tap-to-talk the utterance
ends only on tap-stop, so a pause is silence inside one utterance, not an
ambiguous boundary. This is a small argument in favour of keeping tap-to-talk.

**Added criteria:** A12 (an unfinished instruction survives interleaving and is
released verbatim), A13 (a lapsed draft is offered for re-confirmation, never
dropped), A14 (taking the floor mid-relay loses neither lane).

**Work queued:** the draft is server-side in `pending-proposal.ts` / `talker.ts`,
which P2 currently holds for acknowledgement marking — so the draft goes to a
later child to avoid two writers in one file. The client speech arbiter (P4) is
dispatched now because it is independent of that file.

---

## 2026-09-13 — Phase 4 opens: the anti-duet rule is DECIDED

**Operator decision (verbatim intent):** choose option (b) — the talker finishes
before the worker's answer speaks — **with three refinements**:

1. *"if I was just speaking to it, it should not interrupt me"* — the operator's
   own speech is the highest-precedence thing in the system, above both the
   talker and the worker.
2. *"important not to lose my instructions as well"* — no operator utterance may
   be dropped because something was playing.
3. *"it should acknowledge what I've said shortly if I just said something
   before relaying what the worker said"* — a brief receipt ack precedes the
   relay.

**Why this is better than what the parent proposed:** the parent's option (a)
(the talker yields immediately) optimised for hearing the worker's result, but
treated the operator's speech as one input among several. The operator's
refinement makes it the top of the ladder, which is how conversation actually
works. The parent's options (a)/(b)/(c) are superseded.

**Two consequences the parent worked out and wrote into the plan (§4.1):**

- **Capture is unconditional; playback is scheduled.** The anti-duet rule gates
  *when the surface speaks*, never *whether an utterance is kept*. This is the
  direct answer to refinement 2, and it is the one place where a careless
  implementation would silently lose work. Made the phase's highest-value test.
- **The receipt ack is not a confirmation, and fires at most once per relay.**
  Per-utterance acks would flood the surface when the operator says several
  things in a row; and an ack that sounds like agreement would violate the spirit
  of A3 (nothing relays without confirmation). The ack joins the existing
  harness-generated fixed-string set in `server/src/talker/ack.ts`, so it is
  produced mechanically from a fixed vocabulary and **the gate is not widened**.

**Verified code facts backing the above** (parent, not delegated):
`ack.ts` already holds harness-generated fixed strings, but they are all
*delivery-outcome* acks (`sending that now` / `queued` / `couldn't deliver`) —
there is **no receipt ack today**, so refinement 3 is genuinely new work that
fits an established pattern. `client/src/hooks/useDriveModeDictation.ts` exposes
no "operator is mid-utterance" state and a repository-wide grep for
`isListening|isSpeaking|bargeIn|duckVol|vadActive` returns **nothing**, so
refinement 1 needs new client-side signal. `useReadAloud.ts` has AudioContext
scheduling but no queue, pause, or ducking — so barge-in is new work, and the
phase's existing sentence-chunked TTS is what will make it clean rather than
mid-word.

**Supersession:** the parent's earlier (a)/(b)/(c) framing is **superseded** —
(b) was chosen, then strengthened by the three refinements. Do not re-derive (a).

---

# Voice harness execution — live state (parent)

> Parent keeps this current. If a different agent picks this up, read this file
> first, then `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md`.
> Written 2026-09-12. **Update on every wake.**

## Goal

Execute the agreed two-lane voice scope end-to-end with children, using TDD and
live validation, developing additional validation methods, cleaning up worktrees
afterwards.

## Parent

- Session: `01a0920a-55bc-7367-8281-00dc765d8225` (bare Pi CLI)
- Board entry: `pi-01a0920a`
- Wake path: `watch_wake_register` (bare CLI ⇒ server-side `onFire` cannot reach me)

## Children — all four complete

| Child | Session id | Outcome |
|---|---|---|
| **H1** talker harness | `01a096a8-81e9-72aa-93c7-bbbca093c60a` | ✅ committed `de6cafe` — 97 tests, structural gate verified |
| **H2** Pi input routing | `01a096a8-84c3-72aa-93c7-bbbef32af902` | ✅ merged `5c17304` — 8 tests, live-validated |
| **H3** model retest | `01a0970c-a362-72aa-93c7-bbc265ebeea4` | ✅ committed `cc3f86a` — five candidates measured, one defect found |
| **H4** long-session | `01a0970c-944c-72aa-93c7-bbc089136e0c` | ✅ committed `cc3f86a` — design claim NOT falsified, 157 turns |
| **H5** Gemma provider guard | `01a09754-7e0e-72aa-93c7-bbc6edcebe39` | ✅ committed `f84fa86` — 3-part fix, live 330ms median, 0/12 degenerate |
| **H6** server integration | `01a09727-7df1-72aa-93c7-bbc47c5951df` | ✅ committed `13e30da` — registry wired, gate unchanged |

All four worktrees and all four child branches are cleaned up. Only the 9 stale
worktrees from a **previous execution** remain (listed at the end).

### Isolation failure — honest record

H3 and H4 were given isolated worktrees and their sessions did report the
worktree as `cwd`, but **both wrote their artefacts into the main tree**
(`/root/pi-web-ui`) instead. Cause: their briefs named `/root/pi-web-ui` as "the
repo" while instructing them not to touch certain paths, so they followed the
absolute paths. **No collision occurred** — their changes were disjoint
(H3: results + probe + harness flag; H4: two test files) — and `server/src/talker/`
was untouched by both, as required. But the isolation I intended did not hold, and
the lesson is: name the worktree as the repo, not the main tree, and never let
the brief's scope limits be the only thing keeping children apart.

### 2026-09-12 ~20:53 — H5 mid-work verification + the mobile-socket finding

**H5 is still running** (98 msgs); the wake was a mid-work turn end, not a stall.
Its changes are already in the tree, so the parent verified them now rather than
waiting:

- **Ran its tests: 25/25 pass** (up from 9).
- **Full talker suite: 138/138 pass**, `npm run typecheck` exit 0 — no regression.
- **Read the retry control flow directly.** `completeTurn` makes two *sequential*
  calls, not a loop: a good first reply returns immediately with `retries: 0`; a
  degenerate first reply triggers exactly one more call; a still-degenerate second
  reply **throws an honest error** (surfaced as `MODEL_FAILURE_REPLY`) rather than
  fabricating text. Boundedness is structural, not a counter that could be
  misconfigured.
- **Confirmed the assertions that matter exist**: exactly-2-calls on persistent
  degeneracy, 1-call-no-retry for good replies (explicitly labelled a regression
  guard against retry storms), the provider preference carried on both attempts,
  and HTTP errors NOT triggering a content retry.
- The provider order is overridable (`TALKER_PROVIDER_ORDER`) so it can be
  re-targeted when the provider set changes — which it will.

Still outstanding for H5: its own live numbers. Not committed yet.

### NEW FINDING — the mobile-browser socket defect (operator-reported)

The operator reports that on mobile, dictated prompts frequently never leave the
device, and that copying the text and refreshing the browser is the only fix.
Investigated and confirmed — it is a real client defect, and it directly threatens
Drive Mode, where a lost utterance cannot easily be retyped.

Three verified links in the chain:

1. **Reconnection is scheduled with `setTimeout`** (`client/src/lib/websocket.ts`
   `attemptReconnect`). Mobile browsers **freeze timers** when the tab is
   backgrounded or the screen locks, so the backoff never fires while suspended
   and is stale on return.
2. **Nothing reconnects on resume.** The whole client contains exactly **one**
   `visibilitychange` handler, and it exists only to flush throttled localStorage
   writes (`sessionStore.ts:67`). There is **no** `online`, `focus`, or resume
   check in `useWebSocket`. So a returned tab sits on a `CLOSED` socket with no
   recovery.
3. **The send failure is silent.** `WebSocketClient.send()` returns `false` when
   not open, and callers discard it — `useDriveModeDictation` does
   `if (sessionId) { sendPrompt(text); }` with the boolean ignored. The dictated
   text is dropped with only a `console.error`.

Also: a suspended tab can consume the bounded reconnect budget
(`maxReconnectAttempts = 5`) while frozen, before it ever retries. It is **not**
an auth/token-expiry problem.

**Why refresh fixes it:** a refresh is currently the only thing that reconnects.

**Planned fix (E1, queued — deliberately not started while H5 writes this tree):**
reconnect immediately on `visibilitychange→visible` / `online` / focus and reset
the attempt budget; queue outbound sends while the socket is not open and flush
after reconnect; surface send failure to the operator instead of a console log;
preserve the dictation transcript on failure so a spoken instruction is never lost.

## Queued, not yet dispatched (blocked on H1)

- **H3** — retest the top five Benchmark 3 finalists against the *real* harness,
  in this repo rather than the benchmark repo. Candidate list pending operator
  confirmation of the marker-penalised fifth pick.
- **H4** — long-session check (100+ turns, repeated window cycling) against the
  real harness, proving the bounded window and the pending-proposal rule.

## Decisions already settled (do not relitigate)

- Talker model: `openrouter/google/gemma-4-26b-a4b-it`, **thinking off**.
- Send acknowledgement is exactly **"sending that now"**, spoken only after the
  harness confirms the send succeeded.
- The gate is **structural**: the talker cannot send; only the harness sends, from
  a confirmed pending proposal, using the operator's **raw utterance** by id.
- The prompt **justifies** the gate; the pushback turn is a mandatory test.
- No LLM summariser in v1; bounded rolling window, turn-boundary trimming, never
  trimmed mid-exchange.

## H3 — approved candidate list

Operator approved 2026-09-12. Retest against the **real harness** in this repo:
1. `openrouter/google/gemma-4-26b-a4b-it` (thinking off) — the incumbent
2. `google/gemini-3.6-flash` (minimal)
3. `deepseek/deepseek-flash` (off)
4. `openai/gpt-4o-mini` (off)
5. **`openai/gpt-5-nano`** (minimal — provider floor; no thinking-off exists)

**Why #5 is `gpt-5-nano`:** it is marker-penalised (1 hard fail in the earlier
sweep), and its documented failure was specifically a *propose-and-relay-in-the-
same-turn* pattern — which is exactly what the structural gate should make
impossible once the model no longer owns the send. It is also the fastest
candidate after gpt-4o-mini. It therefore tests the harness change rather than
merely re-running the field.

## Supervision standard set by the operator (2026-09-12)

- **Independently verify each child's work** after it stops — not to the deepest
  depth, but genuinely: check claims against the tree, run the key evidence
  yourself rather than trusting the report.
- **Rework is allowed**: the same model may be asked to redo a section that is
  not up to standard, rather than the parent silently fixing it.
- **Operator does not need code review.** They are needed when **usage testing**
  starts, not before. Keep them informed by Telegram; questions go to Telegram or
  they will not be seen.
- Milestones go to Telegram as well as this file.

## Outstanding operator question (non-blocking)

None. The H3 fifth-candidate question was answered 2026-09-12 (gpt-5-nano).

### 2026-09-12 ~19:45 — wave 2 accepted; a real production defect fixed

**H3 (retest) and H4 (long-session) both accepted**, verified by the parent:

- H4's numbers reproduce exactly on my run: `turns=157 trims=17 entriesDropped=290
  releases=26`. Its strongest assertion was read and is **non-vacuous** (an exact
  `.toBe(PENDING_KEEP)` on every pending-regime trim, plus an assertion that
  material was actually dropped).
- Full talker suite after both landed: **108/108**.
- `npm run typecheck` exit 0; `npm run lint` exit 0 (the six "error" matches in
  the log are pre-existing warnings whose variable names contain "error").

**A real production defect was found and fixed (TDD, RED-first).**
`model-client.ts` hardcoded `reasoning: { enabled: false }`. Some OpenRouter
endpoints **reject** that with HTTP 400 *"Reasoning is mandatory for this
endpoint and cannot be disabled"* — so the talker could not run on them **at
all**. Reasoning is now configurable; the production model's behaviour is
unchanged by default.

**Proven both directions, live:**
- production model, default path: **PASSED**, 561 ms median, 0 breaches, verbatim EXACT
- `gemini-3.6-flash`, which previously could not run: **now PASSES**, 902 ms median, pushback 2/2

### Headline findings

1. **H4: the design claim survived.** The bounded window with no summariser does
   not corrupt the gate — including the adversarial case where trims land
   *during* a live proposal: every trim stopped exactly at the pending floor, and
   the release stayed verbatim-correct from the store even after the proposing
   utterance had been dropped from history. Correctness state genuinely lives in
   the harness, not in model memory.
2. **H3: `gpt-5-nano` is disqualified** (pushback hold 2/5). It accepts the
   operator's "stop asking" premise as its new understanding of the rule. The
   structural change did eliminate its old same-turn relay pattern as predicted,
   but not this.
3. **H3: `gemini-3.6-flash` is now a measured, qualified challenger** — cleanest
   candidate: 26/26 within 2 s, max 1,280 ms, pushback 5/5, no warts.
4. **H3: `deepseek-v4.1-flash` fails on tail latency** (two turns over the 4 s
   hard line). Its prose was the best in the field; voice needs the tail.
5. **⚠️ Quality risk now attached to the incumbent.** Gemma showed **output
   instability** twice, independently: H3 saw one empty reply in 21 conversational
   turns; H4 saw `"thought"` repetition loops and empty strings on long-context
   turns. H4's raw SSE probe cleared the harness (HTTP 200, clean completion,
   no reasoning chunks) — this is model degeneracy, faithfully relayed. In a
   **voice** surface an empty reply is **silence**, which is the worst failure
   shape.

### Queued next (in order)

| # | Work | Why |
|---|---|---|
| **H5** | **Degenerate-output guard** in `model-client.ts`: detect empty / runaway-repetition replies, retry once, then fall back honestly. TDD. | The incumbent's instability is a measured production risk, and a guard makes it cheap to keep the ~18× cost advantage. **Owner asked about this — see the open question below.** |
| **H6** | **Wire the talker into the server** (Phase 3 integration): construct `TalkerSession` with the real `MultiSessionManager` and expose a turn entry point; request-receipt discipline. | Nothing consumes the harness yet — it is a library with tests and a CLI runner. This is what makes it a product surface. |
| **P2** | Consolidate the streaming-vs-idle steer decision inside `MultiSessionManager.steer()` so the Internal API and RPC call sites inherit it. | Removes the defect *class* H2 surfaced rather than patching call sites. |

### 2026-09-12 ~21:35 — H5 committed; wave 3 (E1 + H7) dispatched

**H5 accepted and committed (`f84fa86`).** Parent verified before committing:
25/25 its tests, **138/138** full talker suite, typecheck clean, and the retry
control flow read directly — two sequential calls with an early return, never a
loop, honest throw after the second degenerate reply, plus an explicit regression
guard that good replies are not retried.

**Its live numbers were better than the pre-fix baseline:**

| | before H5 | after H5 |
|---|---|---|
| harness median TTFT | 561 ms | **330 ms** (p90 433, max 1224) |
| gate breaches | 0 | 0 |
| verbatim fidelity | EXACT | EXACT |
| pushback | 2/2 | 3/3 |
| direct client calls | — | **0/12 degenerate, 0 retries** |

The median improved because routing now avoids the slow providers — the
preference list is doing measurable work, not just guarding.

### Wave 3 dispatched — E1 + H7, isolated worktrees

Both write to this repo, so each got its own worktree with the zod-shadow fix
applied up front (E1's server typecheck verified clean before dispatch).

| Child | Session id | Worktree | Brief |
|---|---|---|---|
| **E1** mobile socket durability | `01a0978b-c7ff-72aa-93c7-bbc87374c2b2` | `/root/pi-web-ui-wt-e1` | `docs/plans/briefs/E1-mobile-socket-durability.md` |
| **H7** transport binding | `01a0978b-db7b-72aa-93c7-bbcbaac56`→`01a0978b-db7b-72aa-93c7-bbcb32baac56` | `/root/pi-web-ui-wt-h7` | `docs/plans/briefs/H7-transport-binding.md` |

Watches `ww_7_1789248930606` (E1) and `ww_8_1789248934131` (H7); backstop
`deadline-8ef4288c-1bf1-404e-bbfc-6039bad4851a`.

**File ownership is deliberately disjoint** so the wave cannot self-collide:
E1 owns `client/src/lib/websocket.ts`, `client/src/hooks/useWebSocket.ts` and
`useDriveModeDictation.ts`; H7 owns `shared/src/protocol-types.ts`, the server
router and its own client hook. Each brief names the other's files as off-limits.

**E1** is the operator-reported mobile defect (see the prior entry). **H7** adds
the missing caller for `handleOperatorTurn` — today an operator utterance cannot
reach the talker from the browser at all, so the harness is wired but not yet
reachable.

### 2026-09-12 ~21:40 — operator confirmed the lifecycle model (answering session 3)

**The operator's model, stated and confirmed:** a plain session is worker-only;
the talker appears only when Drive Mode is started. The old sequential Drive Mode
is replaced rather than kept alongside.

**Verified against the code:** the operator's model matches what was built. The
registry creates a talker **lazily, on the first operator utterance** for a
session (`session-registry.ts` — `getOrCreate`, LRU-bounded), so an ordinary
session carries **zero** talker overhead. The talker is also deliberately *not* a
second worker: it converses and relays; the "worker" is the existing session, so
Drive Mode spawns nothing new.

**Not built yet, by design:** the Drive Mode UI. The harness, the server wiring
and (in flight) the transport exist; H7's brief explicitly puts UI work out of
scope. So the talker currently has **no UI surface at all** — it is not being
tested "somewhere else", it simply has no front door yet.

**Two questions sent for confirmation before the UI phase**, because they are
cheap now and expensive later:

1. Is the talker **Drive-Mode-only**, or also invocable in an ordinary session?
   Earlier operator commentary suggested the capability is general ("useful for
   any kind of session"), while the current model makes Drive Mode the trigger.
2. **What does closing Drive Mode do?** Assumption: the talker conversation ends
   but the worker keeps running untouched, and reopening rebinds to the same
   worker. The alternative (closing stops the worker) seems wrong but is
   unstated.

**Answer given:** the build matches the operator's model; the two questions above
are protocol rather than blockers. Phase 4 (Drive Mode UI, anti-duet, talking
while working) remains the next functional phase after E1/H7.

### 2026-09-12 ~22:20–22:32 — SERVER EVENT-LOOP STALL (transient, self-recovered)

**What happened.** The production `pi-web-ui` Internal API stopped responding for
roughly ten minutes. Every request timed out (13–28 s, `http=000`), the unix-socket
accept queue backed up to **67–72 pending** connections against a 511 backlog, the
main thread sat in state **R (spinning)** with all 11 worker threads parked on
futex, and the 30-second memory heartbeat stopped printing from 22:21:45.

**Ruled out, with evidence:**

- **Not memory.** Heap 535 MB of a 4288 MB limit, RSS ~1.5 GB. Plenty of headroom.
- **Not CPU load.** Main process at 2.4% CPU; load average ~2.2 on the host.
- **Not the validation servers.** E1's four validation processes were at 0.0% CPU
  and idle throughout.
- **Not disk.** 80 GB free.

**What it broke:** H7's session stopped advancing (no writes from 21:59 while the
API was down); E1 kept working because it is client-side. **All six parent watch
registrations failed to poll**, so wake delivery was degraded — the parent fell
back to reconciling from session files on disk, and the local `wake_deadline`
timer kept working because it does not use the API.

**It recovered on its own** at ~22:30–22:31, before a restart was performed. The
operator had approved a restart; the parent re-probed first and found the API
answering in 32–53 ms with the backlog drained, so **no restart was performed** —
restarting would have killed two healthy sessions for nothing.

**Open (do not lose this):** the stall was never root-caused. A repeat would hit a
batch mid-flight again. Suspects to examine when there is evidence: the watch-wake
polling path (six watches polling continuously), the client reconnect storm the
backlog implies, or an event-loop-blocking synchronous section. The
`[EventLoopShed] lagMs=1728` line at 22:17:51 is the only direct clue.

**Second finding from the same window — the notification path has no independent
delivery route.** `scripts/notify.sh` talks to the Internal API; with the API down
it **spooled the blocker message locally instead of sending it**, so the operator
would have received nothing during the outage. The parent worked around it by
posting directly to the Telegram bot API (reading the bot credentials from the
production env without printing them) and then deleted the spooled copy to avoid a
duplicate on recovery. Worth fixing: during an outage is exactly when the operator
needs to be told.

### 2026-09-12 ~22:38–22:45 — R1 dispatch failure and the codex-route outage

**R1 never ran.** The first investigation child was dispatched on
`openai-codex/gpt-5.6-sol` (medium) as the operator requested. The session was
created, the model binding was applied and *verification passed* — and then the
assistant reply came back **empty**: `stopReason: error`, `content: ""`,
`toolCalls: 0`, `assistantTextChars: 0`, run disposition `no-text`. The brief had
arrived intact (7,479 chars). It failed silently.

**Isolated to the provider route, not the model and not the brief:**

| Probe | Result |
|---|---|
| `openai-codex/gpt-5.6-sol` (medium) | **empty content** |
| `openai-codex/gpt-5.6-luna` (medium, same pool) | **empty content** |
| `openai-codex/gpt-5.6-sol` (medium), retried ~4 min later | **still empty** |
| `zai/glm-5.3-flash` (control) | `"GLM-ALIVE"` |
| `openrouter/google/gemini-3.8-flash` (high) | `"ALIVE-PROBE"` |

Also checked: the `openai-codex` **OAuth credential is valid** (expires
2026-09-14), the model is present in the registry, and the binding is verified by
the server. So the route is accepted and then fails **server-side at the
provider** — a codex-route outage, not a local misconfiguration.

**Defect worth flagging:** a provider failure on this path surfaces as **HTTP 200
with empty content and `stopReason: error`** — a silent no-op. A caller that does
not inspect `stopReason` sees success. That is how R1 "completed" while doing
nothing.

**Resolution:** two fresh investigators were dispatched on routes verified live
by probe, deliberately on **different model families** so their answers can be
cross-checked:

| | Session | Route |
|---|---|---|
| **R1b** | `01a097c9-e0c5-72aa-93c7-bbd679be83fe` | `zai/glm-5.3` @ max |
| **R1c** | `01a097ca-d680-72aa-93c7-bbdd5165e7ed` | `openrouter/google/gemini-3.8-flash` @ high |

Watches `ww_10` (R1c) and `ww_11` (R1b). **The point of two is convergence:** if
independent investigators on different families agree on the mechanism, that is
far stronger evidence than one confident answer. If they disagree, the
disagreement is itself the finding.

All four probe sessions were deleted after use.

### 2026-09-12 ~23:10–23:20 — R1 root cause CONVERGED; H7 verified; merge serialised

#### R1 root cause — confirmed by convergence

Two independent investigators (R1 on `zai/glm-5.3` @ max, and its own continuation
on the same session; plus R1b) reached the **identical mechanism**, verified by the
parent reproducing the benchmark.

**Mechanism.** A hosted child generation **ran away**: at 21:59:57 the H7 child
session (inside the production server process, `zai/glm-5.3-flash`,
`zaiToolStream: true`) began streaming and emitted its **entire 131,072-token
output budget over 29.5 minutes**, ending 22:29:31.086 with `stopReason: "length"`
and only a 549-byte final tool call.

Every streamed tool-args delta runs this at `pi-ai/dist/api/openai-completions.js:455-456`:

```js
block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
block.arguments = parseStreamingJson(block.partialArgs);
```

and `parseStreamingJson` on an **incomplete** JSON string performs **four O(n)
passes per delta** (two throwing `JSON.parse` attempts, a full char-by-char
`repairJson` walk, then `partialParse`) over an ever-growing string. Linear per
call, **quadratic in total**, all synchronous on the server's single event loop.

**Parent reproduced the cost independently** (`/tmp/r1-bench/parse-bench.mjs`):
0.399 ms/call at 5 KB → **14.566 ms at 460 KB**, integrating to **124.1 s of pure
parse CPU** for one such generation. Matches the child's 13.9 ms / 121 s.

**Everything else follows**, to the second: growing heartbeat gaps (31 s → 232 s),
the `[EventLoopShed] lagMs=1728` at 22:17:51, health-probe failures from 22:15:29,
the 67–72 queued unix-socket connections (pollers piling on a loop that cannot
accept), 200–300 MB heap swings from per-delta allocations and exceptions, and
recovery **within seconds** of the provider cutting the stream at 22:29:31.

**Rejected with evidence:** watch-wake polling (memory-served route; the queue was
a symptom), EventLoopShed (passive flag-setter; it *detected* the stall), timer
fan-out, the sibling Vite/validation servers and host starvation (sar clean), and
a GC-only spiral (an amplifier, not the source).

**This exonerates my earlier hypotheses** — watch polling and the validation
servers were both wrong. It also explains H7's apparent 23-minute "stall": it was
between tool calls during that runaway generation.

#### Tmux freeze — separate cause, NOT the API

The tmux web UI answered in **10–17 ms throughout** (Caddy) and has no Internal API
dependency. The operator's WebSocket closed at 22:17:50 and reconnects returned
**401 — an expired Authelia session** — until re-login. What closed the socket is
unknown. The two events were coincident, not related.

#### Recommended fixes (documented, NOT implemented — production changes)

1. **pi-ai adapter (root fix):** parse tool args at `finishBlock` (or throttled),
   not per delta; cap `partialArgs` length and fail early with a clear error.
2. **Server-side generation watchdog:** abort an in-process stream that saturates
   the broker cap for minutes — shedding broker deliveries cannot relieve a burn
   inside the provider adapter.
3. **Out-of-band notification path** for `notify.sh` (the confirmed spool-during-
   outage defect).

#### H7 verified and ready — but merge is deliberately serialised

Parent verification of H7: **10/10** its server transport tests, **8/8** client
tests (I initially mis-ran these with the default vitest config; jsdom lives in
`client/vitest.config.ts` — H7 was right), `release()` still private and reachable
only from the confirm branch, **`server/src/talker/` untouched**, server and client
typecheck both exit 0.

**Merge held back on purpose:** E1 modifies the same shared file (`useWebSocket.ts`
+31/−11 vs H7's +9/−1), and E1 is still writing. Merging now would risk a messy
conflict on the file that both need. Sequence: let E1 finish, then merge H7, then
E1, resolving that one file by hand and re-running both suites.

### 2026-09-12 ~23:25 — THIRD investigation CONVERGES on trigger, and finds a REAL CODE DEFECT

R1c (gemini-3.8, high) was run as an independent third angle. Result: **it agrees
on the trigger and the timeline, and it found a genuine defect that R1/R1b missed.**

#### Where all three agree (the trigger)

The 21:59:57 runaway generation: ~29 m 34 s of continuous streaming to the
**131,072-token ceiling** at 22:29:31.086 (`stopReason: length`), pumping
**157,814 deltas**, all on the main thread. Instant recovery the moment the
provider cut the stream. R1c's session-file quote confirms the same
`usage.output = 131072` line with `input: 221` — a benign 221-token prompt.

#### The defect R1/R1b missed — CONFIRMED BY THE PARENT

**`server/src/internal-api/event-broker.ts` has an accounting leak.** Two
eviction loops exist and they are not equivalent:

```js
// line 226 — count-based trim: decrements ONLY the local `bytes`
while (buffer.length > this.replayBufferSize) { const old = buffer.shift(); if (old) bytes -= old.bytes; }

// line 229 — byte-based trim: decrements the global counter correctly
while (bytes > this.replayBufferMaxBytes && buffer.length > 0) {
  const old = buffer.shift();
  if (old) { bytes -= old.bytes; this.retainedBytesTotal = Math.max(0, this.retainedBytesTotal - old.bytes); ... }
}
// line 236 — then, unconditionally:
this.retainedBytesTotal += measured.bytes;
```

Because the count-based path never decrements `retainedBytesTotal`, the counter
**ratchets monotonically upward**. Once it exceeds
`DEFAULT_REPLAY_BUDGET_MAX_BYTES` (32 MB), `enforceGlobalBounds()`
(line 302-306) runs its eviction `while` loop **on every published event** —
scanning every session's buffers, up to a 10,000-iteration guard.

**And it does not self-repair.** `dropSessionState` (line 286) subtracts only that
session's `replayBufferBytes` (bounded by the 1 MB per-session cap), never the
leaked total — and it is skipped entirely when a session is *hot* (subscribed),
which is exactly the streaming case. There is no full reset; `retainedBytesTotal`
is only ever decremented by the two bounded paths above. **The only thing that
clears it is a process restart.**

**Live confirmation (parent-run):** `/api/v1/diagnostics` currently reports
`EvictedEventsTotal: 632022`, with the process at ~3.0% CPU. The counter is
inflated **now**, so production is running the per-event eviction scan today.

#### Disagreement worth recording — the tmux cause

- **R1/R1b** attributed the operator's tmux freeze to an **expired Authelia
  session** (401s on reconnect).
- **R1c** attributed it to the operator's own health-check `curl` for H7 hanging
  **180 s in the kernel listen queue**, freezing the tmux pane.

Both are evidenced and they are **not mutually exclusive**: the stuck request and
the later 401 re-login can both be true. What is settled either way is that the
tmux web UI was answering normally at the HTTP layer (10–17 ms) and shares no
dependency with the Internal API. **The freeze was a consequence of our stall,
not a second unrelated outage** — R1c's framing is the more useful one for the
operator, because it means "tmux stopped responding" was *our* fault.

#### Status of the three recommended fixes

Unchanged and still not implemented (all touch production):
1. **Broker leak fix (NEW, and the highest-value one):** decrement
   `retainedBytesTotal` in the count-based trim too. Small, contained, testable —
   and it removes an escalating per-event cost that persists until restart.
2. **pi-ai adapter:** parse tool args at `finishBlock`/throttled; cap
   `partialArgs`. The root trigger.
3. **Generation watchdog** and **out-of-band notifications** as previously noted.

### 2026-09-12 ~23:22 — E1 mid-work verification (parent)

E1 is **still running** (475 msgs); the wake was a mid-work turn end. Verified what
is already in its worktree, since the work is substantial:

**Scope discipline: clean.** Zero changes under `server/`; zero touches to H7's
files (`talkerBus.ts`, `useTalkerTurn.ts`). Its edits are confined to the client
paths its brief owned.

**Tests: 18/18 pass** in `client/tests/unit/lib/websocket.test.ts` — including the
three resume-listener cases that were failing mid-work.

**The two claims I most wanted to check, verified in the code:**

1. **Budgets reset on resume.** `handleResume()` (line 378) sets
   `reconnectAttempts = 0` (line 386) and is wired to all three resume events —
   `visibilitychange`, `online`, `focus` (lines 597–601). This is the fix for the
   frozen-tab case, where a suspended tab could otherwise burn the 5-attempt
   budget while unable to retry.

2. **Ordered delivery is genuinely enforced** — and the reason is subtler than the
   brief anticipated. A queued prompt flushed immediately after reconnect would be
   **refused with `SESSION_NOT_FOUND`**, because the server rehydrates the session
   asynchronously before acknowledging with `session_switched`. E1 gates the flush
   on that ack (`switchAckPending`) with a **15 s bounded fallback** so a lost ack
   cannot stall the queue permanently. It also keeps messages on a synchronous
   `send` throw rather than dropping them, and falls back to `queueOutbound`.

That ordering detail is exactly the trap the brief flagged, and E1 solved it
rather than racing it.

**Merge sequence (unchanged):** H7 first (verified, idle), then E1 once it stops
writing, resolving the shared `client/src/hooks/useWebSocket.ts` by hand and
re-running both suites afterwards.

### 2026-09-12 ~23:38 — E1 and H7 MERGED (the shared-file conflict, resolved)

Both client children landed. The predicted single-file conflict happened exactly
as foreseen, and resolving it surfaced a **real cross-child regression**.

**Merge order:** H7 first (`c22bb6a`), then E1 (`17d2f1c`).

**The conflict** was `client/src/hooks/useWebSocket.ts` — the one file both edit,
and precisely why the parent refused to merge H7 early. It was confined to the
**import block**: H7 adds `emitTalkerTurnResult`, E1 adds `useUIStore` and the
`WebSocketSendResult` type. Both additive, so the fix was to combine them. Git
auto-merged the `onMessage` region, and the parent verified both sides survived
rather than assuming: H7's tap is intact and E1's send-result handling is intact.

**The regression the merge exposed — and neither child could have seen it.**
E1 changed `sendMessage`'s contract from `boolean` to `'sent' | 'queued' |
'failed'`. H7's `useTalkerTurn` was written against the boolean and failed
typecheck (`TS2322: Type 'string' is not assignable to type 'boolean'`). Each
child's branch was internally consistent; only the combination breaks. Fixed at
the call site following E1's own established pattern (`sent === 'failed'`),
treating `'queued'` as **accepted** because a queued message still flushes on
reconnect. This is the classic argument for merging and re-verifying rather than
accepting two green branches.

**Post-merge verification (parent-run, on the combined tree):**

| Check | Result |
|---|---|
| client typecheck | **exit 0** |
| server typecheck | **exit 0** |
| E1 client suites (websocket, dictation hook, dictate component) | **40/40** |
| H7 client suites (useTalkerTurn, talkerBus) | **8/8** |
| H7 server transport test | **10/10** |
| talker suite | **138/138** |

**Cleanup done:** `/root/pi-web-ui-wt-e1` and `/root/pi-web-ui-wt-h7` removed;
branches `fix/mobile-socket-durability` (7cdb147) and `feat/talker-transport`
(39752dc) deleted. Only master remains among active worktrees.

**E1's own live validation: 9/9.** It also found two traps the brief did not
anticipate: CSRF staleness after a backend restart (flushed prompts were refused
with `CSRF_TOKEN_REFRESH_REQUIRED`), fixed by refreshing CSRF via `/api/auth/me`
and deliberately **not** `checkAuthStatus()` — which flips `isAuthenticated:false`
and logged the app out mid-outage during its validation; and a singleton
replacement bug that discarded queued messages on any remount during
`reconnecting`.

### 2026-09-12 ~23:48 — R2 verified and committed; H8's restart deployed; production healthy

#### H8's restart happened, safely

PID `1653997` → `2893943` at 23:45:47, then → `2895528` after the rebuild-restart.
H8 **held the restart until capacity cleared** (it found `activeTurns=2` earlier
and refused to kill four in-flight children) — the sequencing steer worked.

**The restart cleared the leak:** `EvictedEventsTotal` **659,400 → 0**.

#### R2 verified by the parent, not just accepted

**The revert test was run by the parent.** Stashing only the implementation fix
(keeping the test) and re-running produced **3 failed / 3** with the right
assertion — *"tracked must stay under the global budget"*. Restoring the fix gave
**3/3 green**. The property test genuinely catches the bug.

**Defect A was three leaks, not one.** R2 fixed the brief's count-trim omission
**and** found two more the brief did not identify:
- an oversized event popped by its own byte-trim was subtracted before being
  added, and the `Math.max(0, ...)` clamp swallowed the difference — fixed by
  restructuring to **add-before-trim**;
- `clearAll()` dropped every buffer but kept the counter.
It also found a **blind spot in its own property test**: the first caps let
byte-trims preempt count-trims entirely, so the property *passed with the fix
reverted*. Raising the per-session cap to 500 made both trim paths interleave.

**Defect B — verified patched in both physical copies.** Confirmed by reading the
code, not the report:

```js
const PARTIAL_ARGS_PARSE_INTERVAL_MS = 250;
const MAX_STREAMING_TOOL_ARGS_CHARS = 64 * 1024;
if (nextPartialArgs.length > MAX_STREAMING_TOOL_ARGS_CHARS) throw new Error('...stalled-stream guard');
if (nowMs - (lastStreamingArgsParseAt.get(block) ?? 0) >= PARTIAL_ARGS_PARSE_INTERVAL_MS) {
  lastStreamingArgsParseAt.set(block, nowMs);
  block.arguments = parseStreamingJson(nextPartialArgs);   // throttled
}
```

**The critical catch:** there are **two physical pi-ai copies** (root, and nested
under `pi-coding-agent/node_modules`). The in-process hosted sessions resolve the
**nested** one — so patching only the obvious root copy would have left the
production defect live. Both are patched. The fix ships via a `postinstall`
script that survives `npm ci`, fails loudly (exit 1) on version drift, and a
guard test fails independently if the patch is missing.

#### Deployed to production

`dist` was **24 hours stale** (built 00:36; R2's source landed 23:45), so the
first restart deployed the OLD broker. Rebuilt (`npm run build --workspace=server`,
exit 0) and restarted again. Post-deploy: nine probes at ~0.2 s, contract 1.42.0,
**0 startup errors**, and the eviction counter **stayed 0 under real traffic**
(1847 sessions visible, events endpoints exercised) where it previously ratcheted
to 659,400.

#### Watch hygiene

The restart invalidated all 13 registrations. **11 were cancelled** — they
belonged to completed children and were pure polling load (reduced polling is one
of the lessons from the stall investigation). Only H8 and R2 remain watched, both
idle.

### 2026-09-13 ~00:05 — SECRETS MIGRATION COMPLETE (and it was incomplete until now)

H8's migration plus the parent's follow-up has removed **every live secret from
the repository tree**. `pi-web-ui` is a public repo, so this was the point.

#### What H8 did (verified by the parent)

Moved six secrets from `.env.production` (mode 644, inside the repo) to
`/root/.pi-web-ui/secrets.env` (mode **600**, **outside** the repo), loaded via a
systemd drop-in; added `TALKER_API_KEY`; tightened `.env.production` to 600.
The name-diff confirmed **exactly** the six removed, nothing else touched.

It correctly **held the restart** at `activeTurns=2` until capacity cleared rather
than killing four in-flight children, and it **escalated instead of acting** on a
finding outside its authorisation — which is what a good child does.

#### H8's escalation, and why it mattered

It reported that `/root/pi-web-ui/.env` (mode 644, inside the repo) contained the
**same live values** of `AUTH_PASSWORD` and `TELEGRAM_BOT_TOKEN` — the very leak
vector the migration exists to eliminate — and left it alone pending a decision.

**Investigating it exposed a gap that made the migration incomplete:**
`CSRF_SECRET` is **required in production** (`server/src/routes/config.ts` checks
it when `nodeEnv === 'production'`), and it existed in **exactly one place — the
repo's `.env`**. Because `dotenv.config()` loads `.env` without `override: true`,
systemd's values won for the six migrated secrets while `CSRF_SECRET` still flowed
in from the repository.

So `.env` was **load-bearing**, and deleting it would have broken the config check.
Completing the migration required moving the secret *before* removing the file.

#### What the parent did

1. Appended `CSRF_SECRET` to `/root/.pi-web-ui/secrets.env` (now eight secrets).
2. Moved the file **out** of the repo: `/root/pi-web-ui/.env` →
   `/root/.pi-web-ui/env.dev`, mode 600 (backup at `/tmp/h8-backup/env.dev.before`).
3. Restarted, then **verified `CSRF_SECRET` still resolves** — config issues:
   **none**.
4. Ran a secrets audit of the repo's `.env*` files.

#### The audit result — and a false alarm worth recording

| File | Secret-like vars | Verdict |
|---|---|---|
| `.env.production` | **0** | non-secret config only ✓ |
| `.env.example` (tracked, public) | 6 *names* | **placeholders — verified** ✓ |
| `.env` | — | **gone from the repo** ✓ |

`.env.example` initially looked alarming: tracked in a **public** repo with
non-empty `JWT_SECRET` (28 chars), `CSRF_SECRET` (28) and `AUTH_PASSWORD` (23).
Comparing against the live values showed **all three differ** and are markedly
shorter than production's (`JWT_SECRET` 44, `AUTH_PASSWORD` 60) — placeholder
documentation, which is correct for an example file. **No live value has been
committed.** A full-history scan for key-shaped strings had already found only the
literal placeholder `sk-proj-12345…`.

#### Post-migration state

`capabilities` 200 in 0.24 s, `health` 200, `sessions` 200 in 0.07 s, contract
1.42.0, **0 startup errors**, eviction counter still **0**. Production is healthy
and now runs with **zero secrets inside the repository directory**.

#### Still owned by the operator

- **Rotation decision:** the six values sat in a world-readable (644) file inside
  a public repo's directory for an unknown period. Nothing was committed, but
  `AUTH_PASSWORD`, `JWT_SECRET` and `CSRF_SECRET` are worth rotating as
  defence-in-depth. **Not done — credentials are the operator's call.**
- **Stale worktrees:** all nine have HEADs already in master, but several hold
  **uncommitted source edits** (`client/src/lib/browserDiagnostics.ts`, `.gitignore`,
  docs) owned by a *prior* execution. Deleting them destroys content that exists
  nowhere else, so the parent deliberately did **not** delete them unilaterally.
  The two worktrees created *by this execution* (wt-e1, wt-h7) were removed.

## Cleanup owed at the end

- ~~Merge or discard H2's branch `talker/pi-input-routing`~~ — **done** (merged 5c17304).
- ~~Remove `/root/pi-web-ui-wt-e1` and `/root/pi-web-ui-wt-h7`~~ — **done**,
  with their branches deleted after merge.
- **9 stale worktrees from a previous execution** under
  `/root/.pi-web-ui/operations/four-angle-20260908/children/*` plus
  `/root/pi-capacity-release-20260907` — confirm they are unreferenced, then
  remove (operator instruction: clean up unneeded worktrees/branches).
