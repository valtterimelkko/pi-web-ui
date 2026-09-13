# P2 — The receipt ack (speech priority ladder, server side)

## Context you need

The operator has **decided** the anti-duet rule, and it is written up in
`docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` **§4.1 "The speech priority ladder"**.
**Read §4.1 before you start.** The rule:

1. The operator speaking is never interrupted.
2. An unacknowledged operator utterance gets a short **receipt ack** before
   anything else speaks.
3. The worker's completed answer speaks at the next natural gap.
4. Talker chatter is lowest — dropped, not queued, if it would delay 1–3.

**Capture is unconditional; only playback is scheduled.** Never gate capture.

## What already exists (read these first)

- `server/src/talker/ack.ts` — the harness-generated fixed-string vocabulary.
  It currently holds **delivery-outcome** acks only (`RELEASE_ACK`,
  `QUEUED_ACK`, `REFUSED_ACK`, `MODEL_FAILURE_REPLY`). **There is no receipt
  ack today.** That is the gap you are closing.
- `server/src/talker/pending-proposal.ts` — the release gate. **Do not change its
  release semantics**; see the off-limits list.

## The bounded outcome

**A receipt ack exists, is produced mechanically by the harness, and fires at
most once per relay — without widening the gate.**

Three properties must hold, and each needs a test:

1. **It is a receipt, never an agreement.** Text like *"Noted — still holding
   that"*. It must not be readable as assent or as an action taken. At the
   moment it is produced, **nothing has been relayed** and the confirmation step
   still follows. Add a test that pins the exact strings so a future editor
   cannot casually turn it into "ok, doing it".
2. **It fires at most once per relay**, not once per utterance. If the operator
   says three things in a row, that is **one** ack when the answer is ready —
   not three. Test the multi-utterance case explicitly; this is the property
   that stops the voice surface becoming chatty and annoying.
3. **It is produced by the harness, never by the model.** Same pattern as the
   existing acks: a fixed vocabulary, selected mechanically from state. The
   model must have no way to compose or influence receipt-ack text. Test that a
   model reply cannot substitute for or suppress it.

## Where it belongs

The ack needs to be associated with "an operator utterance has been recorded and
not yet acknowledged". The `UtteranceLog` in `pending-proposal.ts` already tracks
the operator's utterances with turn indices — that is the natural source of
truth. Add an acknowledgement marker there (or alongside it) rather than
inventing a parallel structure. **Do not** add a second store of utterances, and
**do not** move the verbatim text out of `UtteranceLog` — the release path reads
from it by id and that must not change.

If you conclude the cleanest place is a small new module
(`server/src/talker/receipt-ack.ts`) that is acceptable; state why in your
report.

## Owned paths (yours)

- `server/src/talker/ack.ts`
- `server/src/talker/pending-proposal.ts` — **only** to add acknowledgement
  marking; the release path's behaviour must not change
- A new `server/src/talker/*.ts` module if you justify it
- Their tests under `server/tests/unit/talker/`

## Off-limits — do not modify

- **The release path's semantics.** `takeForRelease()` stays atomic, stays
  release-time-staleness-enforcing, and must still return null when nothing is
  pending. `release()` remains unreachable except from the confirm branch. If
  your work appears to require touching this, **stop and report** — the design
  is that the gate is structural and must never be widened.
- `client/src/**` — a sibling package owns the client speech arbiter.
- `server/src/websocket/**` and the Internal API routes — a wire-shape change is
  a parent decision. If you need one, report it rather than making it.
- **Production.** Disposable validation only.

## TDD expectation

Write each test first and **show it failing for the right reason** before
implementing. A test that never failed has not been shown to test anything.
Three properties, three red-then-green runs.

## Evidence you must return

- The exact commands and exit codes.
- The **RED evidence for each of the three properties** — the failure message
  showing it failed for the right reason, not a setup error.
- The final ack strings, quoted.
- The multi-utterance case: show one utterance and three utterances both produce
  exactly one ack.
- The gate-untouched evidence: the existing talker suite passing unchanged, plus
  a statement of what you verified about `takeForRelease`/`release` reachability.
- Anything that did **not** work, stated plainly.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
