# P3 — The operator's draft (plan §4.2, interleaved composition)

## Context you need

The operator asked what happens when they are composing an instruction with the
talker while the worker emits something important, the news gets relayed, and
they then resume a half-finished thought — *"will it still remember where I left
off, so that I don't have to re-explain anything?"*

**Today it would not.** Verified in code:

- `recordCandidate()` **replaces** any existing candidate, so a second utterance
  silently supersedes the first and the first is never offered for release.
- `tickTurn()` **expires** the candidate after `maxPendingAgeTurns` (6). That
  counter advances on **worker** turns — so an interleaved worker conversation
  ages the operator's unfinished instruction out of existence, and a later "yes"
  releases nothing at all.

Both behaviours were deliberate and defensible alone: a spoken "yes" must resolve
to exactly one thing, and stale text must never be released. The mistake is that
the bounds are applied to **the wrong object**. **Read
`docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` §4.2 before you start** — it is the
specification, and it is short.

## The aim

**An operator's unfinished instruction survives interleaving, and a confirmation
releases exactly what it quoted.**

## The invariants — these are the whole task

1. **The draft is the operator's composing thread**, an accumulating verbatim
   record of what they have said toward an instruction not yet released. It is
   **harness state, held by object reference** — never reconstructed from
   conversation history and **never written by the model**. This is the same
   principle the release gate already follows, and it is what makes the thing
   robust: interruption, worker news, compaction and model variance cannot lose a
   draft the harness holds.

2. **A release releases verbatim text, selected by id — never composed.** If the
   operator wants to send only part of the draft ("just the second one"), the
   harness selects a **subset of utterance ids**. The model must have no route to
   compose, edit, summarise or re-word what is sent. Preserve this absolutely: it
   is the gate.

3. **The confirmation is a snapshot of the draft**, quoted verbatim, released
   atomically **exactly once**. `takeForRelease()` keeps its atomicity and its
   release-time staleness enforcement.

4. **Ageing expires the confirmation, not the draft.** The safety property stays —
   the system still refuses to release text the operator has not re-confirmed
   after a gap. But a lapsed window marks the draft **needs re-confirmation** and
   the talker surfaces it ("You were composing something — 'tell the worker to
   X'. Still want that?"). **Nothing is ever silently dropped.**

5. **Supersession is loud.** When a new utterance would replace an unreleased
   one, the talker **holds both and asks which** rather than replacing silently.
   The operator accepted this explicitly.

6. **Explicit abandon works** ("forget that") and an **ambiguous** confirmation
   never acts.

## Owned paths (yours)

- `server/src/talker/pending-proposal.ts`
- `server/src/talker/talker.ts` — the turn logic that surfaces draft state
- `server/src/talker/prompt.ts` if the talker needs to be told the draft state
- Their tests under `server/tests/unit/talker/`

## Off-limits — do not modify

- **`client/**`** — a sibling child owns the client speech arbiter.
- `server/src/talker/ack.ts` — just landed and is frozen for this package.
- `server/src/websocket/**`, `server/src/internal-api/**` — a wire-shape change is
  a parent decision. Report it instead.
- **Production.** Disposable validation only.

## Expect existing tests to need changing — say which and why

`pending-proposal.test.ts` and any talker test asserting the **old** semantics
(replacement of the candidate, expiry at `maxPendingAgeTurns`, a second "yes"
after release finding nothing) **will legitimately need to change**, because
those semantics are what this package replaces. That is expected — but you must
state explicitly in your report **which tests you changed and why**, and you must
**not** weaken a test that pins a genuine safety property (atomic release,
release-time staleness, ambiguity never acting). If a change feels like weakening
a safety property, stop and report instead.

## TDD expectation

Write the behavioural test first and show it failing for the right reason.

The three properties most worth pinning, because they are the ones a careless
implementation loses:

- **the draft survives interleaving** — compose, advance several worker turns,
  resume, confirm; the released text is the whole draft, verbatim;
- **a lapsed draft is surfaced, not dropped** — drive past the window, then ask;
  the draft is still there and requires re-confirmation;
- **supersession holds both** — a second unreleased instruction does not destroy
  the first.

## Evidence you must return

- Exact commands and exit codes.
- RED evidence per property, showing failure for the **right** reason.
- The **full test-file result** for the talker suite, so the parent can confirm
  the gate is unregressed.
- Which existing tests you changed, and why each change preserves rather than
  weakens a safety property.
- Anything that did **not** work, stated plainly.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
