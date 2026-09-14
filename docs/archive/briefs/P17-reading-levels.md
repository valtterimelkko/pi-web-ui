# P17 — Reading levels: Verbatim / Summary / Headlines (package A)

## Read first

`docs/plans/VOICE-READING-AND-QA-DESIGN.md` — the agreed design. It is the
specification. Do not re-derive it.

## The reframe you must not miss

The verbosity is **not** the talker being chatty. Today the worker's final answer is
read **verbatim** by the auto-speak path — raw text straight to TTS, with no talker
involvement. A reading level is therefore **putting the talker into the reading path
where there currently is none**: instead of submitting the raw answer at tier 3,
submit a digest the talker produced.

## The bounded outcome

**The operator can choose how much of the worker's output is spoken, change it
mid-answer, and always know which level they are hearing.**

1. **A three-level control in the voice surface** (Verbatim / Summary / Headlines),
   persisted as the operator's default, with a **visible indicator of the active
   level** so they are never unsure whether they heard everything.
2. **Summary**: the talker digests the turn and that digest speaks instead of the raw
   text, announced briefly ("In short:").
3. **Headlines**: **one line — "Done: X. Needs you: Y."** This is a *different
   extraction*, not a shorter summary: it answers "what changed, and what waits on
   me?". Two to four items may fit but it stays **one sentence**, so it can never blur
   into a summary. It is designed to be **left on permanently** (headphones while
   doing other work), so it must carry signal and no narration.
4. **Short turns speak verbatim even in Summary**: under **~30 seconds of speech
   (~400 characters)** the turn is spoken verbatim. Use a **named constant** with the
   reasoning recorded; Headlines is exempt from this threshold.
5. **Flipping mid-answer is immediate and bounded** (the operator's edge case):
   the current item stops at the **next chunk boundary** (never mid-word), the talker
   **summarises the unplayed remainder**, it **never repeats what was already heard**,
   and the change is announced ("In short:"). If the remainder is trivial, say so
   briefly and stop. Rationale: a control that makes you wait out the verbosity you
   are escaping reads as broken.

## Rules that must not be softened

- **Summarise ONE direction only.** Worker → operator may be condensed. **Operator →
  worker stays verbatim, always.** The gate exists for that fidelity; a readability
  convenience must never touch the relay path. `release()` stays private with one
  caller; `takeForRelease` stays atomic.
- **Summary and Headlines speak at tier 3** (the answer, condensed) — never tier 4,
  where they would be dropped whenever anything else speaks and the setting would be
  silently unreliable.
- **The transcript remains the channel of record.** The talker signals when it is
  summarising and says so when a turn is dense enough that a digest risks omission.
- **Read-aloud stays as-is** — it becomes the occasional escape hatch.
- **No new lint warnings** (ceiling 326, currently 306 — 20 of real margin).
- **Production is off-limits.** Disposable servers only.

## TDD

RED-first for at least: short-turn verbatim fallback; a long turn summarised rather
than read raw; the mid-speech flip summarising the *remainder* and not repeating what
was heard; and the level indicator reflecting the active level.

## Evidence

Exact commands and exit codes; the RED evidence; the full client suite; a
**screenshot** of the control and indicator; an honest statement of what you could not
verify headlessly (audible output); anything that did not work.

## Owned paths

`client/src/components/DriveMode/**`, `client/src/hooks/**`, the talker prompt if the
summary requires it, their tests. **`speechArbiter.ts` is read-only.**

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
