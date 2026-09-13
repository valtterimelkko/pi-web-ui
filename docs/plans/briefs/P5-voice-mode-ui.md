# P5 — The Voice Mode UI (talking while working)

## Context you need

**Read these first — they are the specification, not background:**

- `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` **§4.1** (the speech priority ladder)
  and **§4.2** (interleaved composition).
- `client/src/lib/speechArbiter.ts` — **just landed and frozen.** It already
  schedules speech by tier, ducks on barge-in, restores at chunk boundaries,
  drops chatter, and has **no capture-side API at all**. Use it; do not
  reimplement it and do not edit it.
- `client/src/hooks/useReadAloud.ts` (chunked playback through the arbiter) and
  `client/src/hooks/useDriveModeDictation.ts`, which now exposes an
  **`operatorSpeaking`** floor signal.

The relay underneath is proven end to end: a real browser WebSocket drives
`talker_turn` and receives `talker_turn_result` (P1), the receipt ack exists (P2),
and the speech arbiter is in (P4). What is missing is the **surface**.

## The aim

**A Voice Mode the operator can actually talk to while the worker runs, where it
is unmistakable who currently has the floor.**

## The invariants — do not soften these

1. **The mic is never disabled.** Taking the floor is always one tap, at any
   moment, including while speech is playing. Tapping while speech plays is the
   **barge-in gesture**: it takes the floor and the arbiter ducks. Disabling the
   control while the surface speaks is the "locked out for minutes" failure the
   operator explicitly rejected. If you find yourself adding a `disabled` to the
   mic control, stop and report instead.
2. **The confirmation is explicit and quoted.** A pending proposal is shown
   **verbatim** — the operator's own words, not a paraphrase. A text fallback
   path must exist alongside the voice path.
3. **An ambiguous confirmation does not act.** No guessing.
4. **Nothing in the UI sends anything by itself.** The surface may submit speech
   to the arbiter and drive `talker_turn`; it must never invent a relay.

## What to build

1. **The four states, visually unmistakable.** The operator asked for clarity
   about who is talking:
   - **You have the floor** (recording)
   - **Talker speaking**
   - **Working silently** (worker running, nothing speaking)
   - **Answer ready — held** (an answer awaits because the operator holds the
     floor, or speech is deferred)
   `speechArbiter`'s `getState()` already exposes `queued` and `ducked`, which is
   what the held/ready indicator needs.
2. **The talking-while-working phase machine.** Drive Mode currently **blocks**
   in its `agent-working` state. That blocking is replaced: the surface stays
   usable, the operator can speak at any time, and dictation is not gated on the
   worker being idle.
3. **Remove the mic-tap hard stop.** Tapping while speech plays currently stops
   it hard; it must instead take the floor and let the arbiter duck and restore
   at a chunk boundary.
4. **The confirmation card.** The exact pending proposal, verbatim, with
   confirm / cancel / ambiguous-does-nothing, and a text fallback.
5. **Rename Drive Mode → Voice Mode** in **user-facing labels** and the store's
   **public** naming. Do **not** sweep file names or internal identifiers: that
   is a large mechanical diff for no user benefit and it makes the review
   impossible. If you believe an internal rename is genuinely required, report it
   rather than doing it.

## Owned paths (yours)

- `client/src/components/DriveMode/**` (the surface — keeping the directory name
  is fine and expected)
- `client/src/store/driveModeStore.ts` — labels and public naming only
- `client/src/hooks/useTalkerTurn.ts` if the surface needs more from it
- Their tests under `client/tests/unit/`

## Off-limits — do not modify

- **`client/src/lib/speechArbiter.ts`** — frozen; consume its interface.
- `client/src/hooks/useReadAloud.ts` and `useDriveModeDictation.ts` — just
  landed; use the signals they expose.
- **`server/**` entirely** — a sibling child owns the talker harness.
- `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` — read it, do not edit it.

## A trap that has cost time here

Client tests use a **different vitest config**: jsdom and the React environment
live in `client/vitest.config.ts`, **rooted at `client/`**. Run client tests from
the `client/` directory with paths relative to it. Running them from the repo root
fails with `No test files found`, and using the default config fails with
`document is not defined` — both look like real bugs and are not.

## TDD expectation

Write each behavioural test first and show it failing for the right reason. Worth
pinning because they are the properties most likely to break:

- the mic control is **enabled** while speech is playing (the invariant above);
- tapping while speech plays takes the floor and **ducks** rather than stopping;
- the four states are distinguishable from the state the surface receives;
- an **ambiguous** confirmation submits nothing;
- the confirmation text is the pending proposal **verbatim** (compare it, do not
  eyeball it).

## Evidence you must return

- Exact commands and exit codes, using the **client** config from `client/`.
- RED evidence per property, showing failure for the right reason.
- The full client suite result, so the parent can confirm no regression.
- A **screenshot or a precise description of the four visual states** — this is a
  user-facing surface and the parent has to judge whether the clarity the
  operator asked for is actually there. If you cannot render it, say so plainly
  rather than describing an interface you have not seen.
- Anything that did **not** work, stated plainly.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
