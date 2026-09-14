# P16 — Never say the same thing twice (read-aloud vs talker collision)

## The defect, confirmed in code

`ReadAloud` submits at **`TIER_ANSWER`** (`useReadAloud.ts:239`) — the **same tier** as
the talker's auto-speak (`DriveModeDictate.tsx` auto-speak effect). The dedup guard
`spokenAnswerRef` is written **only** by the auto-speak path (`:137`); read-aloud never
touches it.

So: press read-aloud on a message → the turn ends → the auto-speak guard sees nothing
was spoken → it submits the **same text** at the **same tier** → the arbiter queues it
FIFO → **the operator hears the same message twice, back to back.**

## The aim

**The surface never speaks the same content twice, whichever path started it** — and
the operator's explicit actions still win.

## Required behaviour

1. **No duplicate**: if read-aloud has played a given answer, the auto-speak must not
   submit that same text afterwards. (This is the bug above — pin it with a test that
   fails first.)
2. **A genuinely new answer still speaks**: a *different* final assistant message after
   a read-aloud must still be auto-spoken. Do not fix this by disabling auto-speak.
3. **Explicit actions still work**: pressing read-aloud is an operator action and must
   always play what they asked for, even if the talker spoke it — but it must **mark**
   the text as spoken so the auto path cannot repeat it.
4. **While read-aloud is playing**, the auto-speak must not queue a duplicate of the
   same text behind it.
5. **Stop talker keeps working** (P15): after a stop, a cancelled answer still must not
   come back, and genuinely new text still speaks. Do not regress P15's pinned tests.

## The general principle (the operator asked for robustness, not a one-off patch)

This is one instance of a class: **the speech surface has several producers** (the
talker's auto-speak, read-aloud, receipt acks) and **must never say the same thing
twice**. Prefer a **single shared notion of what has already been spoken** that every
producer consults and updates, rather than another pairwise special case. Keep it small
and local to the client — do not redesign the arbiter (it is frozen; consume it).

## Invariants — do not soften

- **Capture is never gated** — no utterance may be lost; stopping/ducking/skipping
  affects playback only.
- **The operator's speech is never interrupted**; barge-in keeps ducking (they have
  just confirmed this works — do not regress it).
- **Stop talker (P15) keeps its behaviour**, including that a cancelled answer does not
  return.
- **No server changes**: this is client speech arbitration only.
- **No new lint warnings** — the ratchet has 38 warnings of headroom (1700/1738).
- **Production is off-limits.**

## TDD

RED first, showing the duplicate: read-aloud a message, end the turn, and assert the
auto-speak does **not** submit it again. Then pin the inverse (new text does speak) and
the explicit-action case.

## Evidence you must return

- Exact commands, exit codes, and the RED evidence for the duplicate.
- The full client suite result, and P15's stop-talker suite specifically (no regression).
- A plain statement of anything not verifiable headlessly (audible behaviour).
- Anything that did not work.

## Owned paths

`client/src/components/DriveMode/**`, `client/src/hooks/useReadAloud.ts` and
`useDriveModeDictation.ts`, `client/src/lib/speechArbiter.ts` **read-only**, their tests.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
