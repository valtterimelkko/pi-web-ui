# P18 — Q&A improvements: ask-the-worker, focus/hold, tier-4 split (package C)

## Read first

`docs/plans/VOICE-READING-AND-QA-DESIGN.md` — the agreed design (see "The Q&A work").
It is the specification. Do not re-derive it.

## Three deliverables

### 1. "I can't answer that — shall I ask the worker?"

When the talker cannot answer from what it holds (its knowledge is a **bounded
window**), it currently just says so. The upgrade: it **offers to pass the question
on**, and doing so goes through the **existing confirmation gate** — it proposes, the
operator confirms, it relays.

**No new mode.** This reuses the propose-confirm-relay machinery entirely, and it
turns the talker's honest failure into a useful next step.

Constraint: the offer must not weaken the gate. `release()` stays private with one
caller; `takeForRelease` stays atomic; the relayed text is the **operator's own
question, verbatim** — never the talker's paraphrase of it.

### 2. Focus/hold control (the concentrated-Q&A case)

While focus is on:
- the worker's answers are **transcript-only, not spoken**;
- the talker holds the floor.

On exit: **anything that arrived while focused is surfaced explicitly** — never
silently lost. This is the part that matters: "exit focus" must not mean "the thing
that happened while you were away disappeared".

The talker may **suggest** leaving focus ("this needs the worker"), but it must
**never switch it itself** — the operator presses. Same discipline as the gate: the
model proposes, never acts.

### 3. Split tier 4: an elicited answer outranks unprompted musings

Today the talker's reply to a direct question and its unprompted commentary share
tier 4, so a direct answer is the first thing dropped when anything else speaks.
**A reply to a question the operator just asked is not chatter — it is the
conversation**, and should hold its ground.

Split them. `speechArbiter.ts` is **read-only** — work within its tier model (the
tiers are fixed constants; do not renumber TIER_RECEIPT_ACK/ANSWER/CHATTER's meaning).

## Invariants — do not soften

- **The operator's speech is never interrupted**; barge-in keeps ducking (confirmed
  working — do not regress).
- **No utterance is ever lost** — focus gates *playback only*, never capture.
- **Reading levels (P17) keep working**, including headlines/verbatim at tier 3 and
  the mid-answer flip. Do not regress its pinned tests.
- **Summarise one direction only** — operator → worker stays verbatim, always.
- **No new lint warnings** (ceiling 326, currently 306).
- **Production is off-limits.**

## TDD

RED-first for: the offer reusing the gate (and relaying the operator's verbatim
question, not a paraphrase); focus suppressing speech while capture continues; the
exit recap surfacing what arrived; and an elicited reply outranking unprompted
chatter when both compete.

## Evidence

Exact commands; RED evidence; the full client suite; a screenshot or precise
description of the focus control and the exit recap; an honest statement of what
could not be verified headlessly (audible behaviour); anything that did not work.

## Owned paths

`client/src/components/DriveMode/**`, `client/src/hooks/**`, `client/src/lib/**`
except the arbiter (read-only), the talker prompt/registry if the offer needs it,
their tests.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
