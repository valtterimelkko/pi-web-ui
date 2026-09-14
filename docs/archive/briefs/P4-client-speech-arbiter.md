# P4 — The client speech arbiter (priority ladder, ducking, chunked speech)

## Context you need

The operator has **decided** how speech behaves. It is written up in
`docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` **§4.1 "The speech priority ladder"**
and **§4.2 "Interleaved composition"**. **Read both before you start** — they are
short and they are the specification. Do not re-derive them.

The ladder, highest priority first:

1. **The operator speaking is never interrupted.**
2. An unacknowledged operator utterance gets a **receipt ack** before anything
   else speaks.
3. **The worker's completed answer** speaks at the next natural gap.
4. **Talker chatter is lowest** — dropped, not queued, if it would delay 1–3.

**The invariant that matters most: capture is unconditional; only playback is
scheduled.** Your arbiter may delay or drop *speech*, and may never delay, refuse
or drop the *capture* of an operator utterance. If you find yourself gating
capture, you have implemented the wrong thing.

## The bounded outcome

**A client-side speech arbiter exists that schedules playback by the ladder, lets
the operator take the floor at any moment, and never loses an utterance.**

Concretely:

1. **A queue with priorities.** Speech intents arrive tagged with a tier; the
   arbiter plays one at a time in tier order. Tier 4 (chatter) is **dropped**
   when tiers 1–3 are waiting, not deferred indefinitely.
2. **Operator barge-in.** When the operator takes the floor, playback **ducks**
   (lowers volume) — it does **not** hard-stop and later resume mid-word, which
   sounds broken. Restore volume at the next chunk boundary.
3. **Sentence chunking.** Speech is split into sentence-sized chunks so speech
   starts early rather than after a long synthesis. This is also what makes
   pause/resume clean: "pause" stops at a chunk boundary, "resume" continues from
   the next chunk.
4. **An operator-is-speaking signal.** The client currently exposes **none** —
   a repository-wide grep for `isListening|isSpeaking|bargeIn|duckVol|vadActive`
   returns nothing. The arbiter needs it to know when the operator holds the
   floor, and the dictation hook is the natural source.
5. **The mic is never disabled.** The operator's explicit requirement is that
   taking the floor is always one tap. Tapping while speech is playing is the
   **barge-in gesture** — it takes the floor, ducks the speech, and holds
   everything else. Do **not** disable the control while the surface is speaking:
   that is the "locked out for minutes" failure the operator named.

## Owned paths (yours)

- `client/src/hooks/useReadAloud.ts` — currently has AudioContext scheduling and
  **no queue, no pause, no ducking**. This is the core of the work.
- A new arbiter module, e.g. `client/src/lib/speechArbiter.ts`
- `client/src/hooks/useDriveModeDictation.ts` — to expose the operator-is-speaking
  signal (keep its existing return surface working; add, do not break)
- Their tests under `client/tests/unit/`

## Off-limits — do not modify

- **`server/**` entirely.** A sibling child owns the talker harness right now.
- `client/src/lib/talkerBus.ts` and `client/src/hooks/useTalkerTurn.ts` — the
  transport binding is proven and frozen for this package.
- **The release gate.** Nothing you do may add a path that sends or relays
  anything. Your arbiter schedules *speech*; it must have no send capability at
  all. If your work appears to need one, **stop and report**.
- `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` — read it, do not edit it.

## A trap that has cost time here — read it

Client tests use a **different vitest config**. jsdom and the React environment
live in `client/vitest.config.ts`, rooted at `client/`. Running a client hook test
with the **default** config fails with `document is not defined` and looks like a
real bug. Use the client config for client tests. If you see that error, it is the
wrong config, not a broken test.

## TDD expectation

Write each behavioural test first and **show it failing for the right reason**
before implementing. In particular the three properties most likely to be got
wrong — and therefore most worth pinning:

- tier 4 chatter is **dropped** (not queued) when a higher tier is waiting;
- ducking happens (volume lowers) and is restored **at a chunk boundary**, rather
  than a hard stop;
- an operator utterance is **captured** even while speech is playing — the
  capture path is not gated by playback state.

## Evidence you must return

- Exact commands and exit codes, using the **client** vitest config.
- RED evidence per property: the failure message showing it failed for the right
  reason.
- The final arbiter interface (the tier type and how a caller submits an intent),
  quoted — the parent needs it to wire the UI next.
- A plain statement of **what you could not test** headlessly (audio ducking is
  the obvious candidate). Do not claim a listening check you did not do.
- Anything that did **not** work, stated plainly.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
