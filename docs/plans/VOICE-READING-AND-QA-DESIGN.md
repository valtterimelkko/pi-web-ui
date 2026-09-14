# Voice Mode — reading levels and Q&A: design (agreed 2026-09-14)

Operator-approved design. Implemented as three sequenced packages (A, B, C) because
they share the voice-surface files.

## The reframe

The verbosity is NOT the talker being chatty. Today two separate paths exist:
- the worker's final answer is read **verbatim** by the auto-speak path — raw text
  straight to TTS, no talker involvement;
- the talker's own words are a different channel (answers, questions, chatter).

So a reading level is not "make the talker quieter" — it is **putting the talker into
the reading path where there currently is none**.

## The three levels

| Level | What it is | When |
|---|---|---|
| **Verbatim** | the worker's words, word for word | errors, exact commands, precision matters |
| **Summary** | the talker's digest of the turn | the default |
| **Headlines** | *status + asks*, nothing else | always-on; headphones while doing other work |

**Headlines is not a shorter summary — it is a different extraction.** It answers a
different question: *what changed, and what is waiting on me?* Format: one line —
**"Done: X. Needs you: Y."** Two to four items is fine, but it stays one sentence so
it can never blur into a summary. This is why Headlines can be left on permanently:
it carries signal, not narration.

## Short turns are spoken verbatim, even in Summary mode

Hard rule, so it is testable rather than a judgement call:

**Under ~30 seconds of speech (~400 characters), speak the turn verbatim.**

Rationale: summarising two sentences is pure overhead and risks distorting them. The
threshold is a named constant with the reasoning recorded, not a magic number.

**Headlines is exempt** from the threshold: in Headlines mode you always get the one
line, because the point is signal-only, not fidelity.

## Flipping the level mid-speech

The operator asked what happens if they realise mid-answer that they want a summary.
**Decision: the flip is immediate, and it is bounded.**

1. The current item **stops at the next chunk (sentence) boundary** — never mid-word,
   consistent with the whole speech design.
2. The talker **summarises what remains unplayed**, and that speaks at tier 3.
3. **It never repeats what you already heard.** If the remainder is trivial, it says
   so briefly and stops.
4. The change is **announced audibly and briefly** ("In short:") — because the one
   dangerous failure of summarisation is *not knowing whether you heard everything*.
   The same marker is used in the normal summary path, so it is consistent.

Why immediate rather than "applies to the next answer": reaching for the switch means
you want it *now*; a control that makes you wait out the very verbosity you are trying
to escape reads as broken. This also matches what a person does when you say "just
give me the gist" — they stop and summarise from where they are; they do not finish
the document first. The fallback is cheap: if the remainder is short, speaking it
verbatim is fine anyway.

## Rules that keep it safe

1. **Summarise one direction only.** Worker → operator may be condensed freely.
   **Operator → worker stays verbatim, always.** The gate exists because the exact
   words matter to the work; a readability convenience for the operator must never
   touch the relay path.
2. **Summary and Headlines speak at tier 3** — they are the answer, condensed, not
   commentary. In tier 4 they would be dropped whenever anything else speaks, making
   the setting silently unreliable.
3. **The transcript remains the channel of record.** Speech is an enhancement over it,
   never a replacement. The talker signals when it is summarising, and says so when a
   turn was dense enough that a digest risks omission.
4. **The read-aloud button stays** — it becomes the occasional escape hatch rather
   than the tool you must remember to click.

## The whole-turn input (package B)

Today auto-speak fires at turn end on the **last** assistant message, which is why
mid-turn detail is reachable only by clicking read-aloud. A summariser can read the
**whole turn**, interim included — so detail that would otherwise sit unread surfaces
automatically, and the operator needs read-aloud far less.

## The Q&A work (package C)

1. **"I can't answer that — shall I ask the worker?"** When the talker cannot answer
   from what it holds, it offers to pass the question on, **through the existing
   confirmation gate**. No new mode. The talker's honest failure becomes a next step.
2. **Focus/hold control** for concentrated Q&A: while on, the worker's answers are
   transcript-only (not spoken) and the talker holds the floor. **On exit, anything
   that arrived while focused is surfaced explicitly** — never silently lost.
3. **Tier 4 splits**: an *elicited* reply (the answer to a question the operator just
   asked) outranks *unprompted* musings. A direct answer is the conversation, not
   commentary, and should not be the first thing dropped.

**No relay/answer mode is added.** The classifier already separates questions
(answered) from instructions (proposed for relay), and that is the natural reading.
A mode would create the role confusion it was meant to avoid.

**The talker can suggest but never switches** — it proposes ("this needs the worker"),
the operator presses. Same discipline as the gate: the model proposes, never acts.

## Known limits

- Summarising costs a model call before speech starts (~1s later first word, minutes
  saved on a long turn). That is why short turns skip it.
- The talker's knowledge is a bounded window, so questions about old turns may fall
  outside it — which is exactly when the offer to ask the worker fires.
