# P19 — Whole-turn digest input (package B)

## Read first

`docs/plans/VOICE-READING-AND-QA-DESIGN.md` — the agreed design (see "The whole-turn
input (package B)"). It is the specification. Package A (reading levels) is already
committed; build on it, do not re-derive it.

## The gap this closes

Today the auto-speak fires at turn end on the **last** assistant message. That is
precisely why detail the worker emits **mid-turn** is reachable only by clicking
read-aloud — the operator has to remember to hunt for it.

A summariser can read the **whole turn**, interim included. So the digest input becomes
the turn's assistant output rather than a single message, and detail that would
otherwise sit unread surfaces automatically.

**The operator's own words for why this matters:** some workers put important small
details in their interim output, not at agent_end; they do not want to be clicking
read-aloud to find them, but they also do not want every trivial interim line spoken.

## The bounded outcome

**The digest is computed from the whole turn, so mid-turn detail is surfaced without
the operator asking — and verbatim mode still speaks the turn faithfully.**

1. **Digest input = the turn**, not the last message. Interim assistant output is
   included.
2. **Verbatim mode reads the turn faithfully** — if verbatim currently reads only the
   final message, decide and state whether it should read the turn or stay as it is.
   **Report your decision and its reasoning**; do not change verbatim's contract
   silently.
3. **No duplication**: the whole-turn digest must not cause the same content to be
   spoken twice across successive turns (the P16 spoken-ledger exists — check it
   applies to the turn-scoped digest).
4. **Headlines still yields one line** (P17): digesting a whole turn must not turn the
   headline into a summary.

## Invariants — do not soften

- **Summarise one direction only** — operator → worker stays verbatim.
- **Summary/Headlines speak at tier 3**, never chatter.
- **The short-turn verbatim threshold still applies** (P17), including its exemption
  for Headlines. A whole-turn input must not silently defeat it — if the *turn* is
  long but the *last message* is short, say which rule wins and why.
- **The mid-answer flip (P17) still works**, including digesting only the unplayed
  remainder.
- **Focus/hold (P18) still works** — do not regress its tests.
- **Capture is never gated**; the operator's speech is never interrupted.
- **The relay path is untouched** (`release()` private, one caller; the digest has no
  delivery path).
- **No new lint warnings** (ceiling 326; check the current actual with the ratchet).
- **Production is off-limits.**

## TDD

RED-first for: a mid-turn detail surfacing in the digest when it would not have
before; no duplication across turns; Headlines still one line for a long turn; and the
short-turn rule's interaction with a long turn.

## Evidence

Exact commands; RED evidence; the full client suite plus P17's and P18's suites
unregressed; the ratchet result; a plain statement of what could not be verified
headlessly; anything that did not work.

## Owned paths

`client/src/lib/turnDigest.ts`, `client/src/hooks/useTurnDigest.ts`,
`client/src/components/DriveMode/useAnswerReader.ts` and `DriveModeDictate.tsx`,
`scripts/talker-prompts/digest.txt` and `server/src/talker/digest.ts`, their tests.
**`speechArbiter.ts` is read-only.**

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
