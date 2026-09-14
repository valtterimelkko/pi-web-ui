# P15 — Add a "Stop talker" control

## Why

The operator asked for it directly, alongside the existing "stop worker" control.
While the talker is reading a long answer, they often only needed the first part:
they want to **stop the speech, cancel what is queued, and not come back to it** —
then carry on normally when something new arrives from the worker.

## The bounded outcome

**A visible "Stop talker" control that silences the talker and clears its queue, and
that does not resume the cancelled item — while still speaking genuinely new input.**

## Required behaviour (the operator's own words)

1. **Stops the current speech.**
2. **Cancels the queue completely** — it must not resume the stopped item afterwards.
3. **Does not come back to that item** — the cancelled answer is not re-spoken.
4. **Resumes normal behaviour on new input** — a new relay/answer from the worker (or a
   new operator turn) speaks as usual.

## What already exists — use it, do not reinvent

- `client/src/lib/speechArbiter.ts` exposes **`stopAll()`**, documented as *"the only
  hard cancel. Clears queue and current chunk."* That is the primitive; **do not edit
  the arbiter** — it is frozen and consuming its interface is the point.
- `DriveModeDictate.tsx` already has the auto-speak effect and a `spokenAnswerRef`
  guard (`spokenAnswerRef.current !== lastAssistantText`) that prevents the same answer
  being spoken twice. Check whether that guard is sufficient to satisfy requirement 3,
  or whether an explicit suppression is needed — **verify, do not assume.**
- There is an existing abort/stop control for the worker in the same surface. Match its
  placement and affordance so the two read as siblings.

## Invariants — do not soften

- **The release gate and the talker's server-side behaviour are untouched.** This is a
  speech-playback control only; it must not relay, cancel, or alter anything on the
  server.
- **The operator's ladder still holds**: their speech is never interrupted, no utterance
  is ever lost, and a receipt ack is never mistaken for a send. Stopping the talker must
  not gate **capture** — only playback.
- **Barge-in keeps working.** Stopping the talker must not regress the duck-not-stop
  behaviour the operator has just confirmed works.
- **No new lint warnings** — the ratchet has 38 warnings of headroom (1700/1738); do not
  consume them.
- **Production is off-limits.** Disposable servers only.

## TDD

Write the behavioural test first and show it failing for the right reason:

- stopping clears the queue **and** the current item;
- the cancelled answer is **not** re-spoken afterwards (the specific failure this
  feature exists to prevent — pin it);
- **new** text from the worker **does** speak after a stop;
- capture is unaffected (an utterance during/after a stop is still recorded).

## Evidence you must return

- Exact commands and exit codes; the RED-first evidence.
- The final client suite result.
- A **screenshot or precise description** of the control in place, and where it sits
  relative to the existing worker stop.
- A plain statement of anything you could not verify headlessly (audible behaviour).
- Anything that did not work.

## Owned paths

`client/src/components/DriveMode/**`, `client/src/hooks/**`, their tests.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
