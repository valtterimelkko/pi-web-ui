# P22 — Requests addressed to the talker must not become worker instructions

## The live defect (operator-reported, reproduced from the code)

The operator asked the talker, by voice: **"summarise what has been done in this session"**
and variants. Reported behaviour: *"it always wants to route it as a request to the
worker ... it's kind of wanting to relay something and it's explaining it to me at the
same time."*

## Root cause — established, not guessed

`server/src/talker/utterance-classifier.ts` returns exactly four classes:
`confirm | cancel | question | statement`. An imperative with no "?" and no leading
question word — "summarise what's been done" — is not a question, so it returns
**`statement`**.

In `server/src/talker/talker.ts` (the final block of `handleTurn`), **every `statement`
is unconditionally appended to the draft**:

```ts
const opensBatch = this.proposals.snapshotDraft() === null;
this.proposals.appendToDraft(record.id, utterance, turn);
```

So the harness holds the operator's own words — "summarise what's been done" — as a
**pending worker instruction**. The model then sees `PENDING INSTRUCTION` in its state
view and correctly offers to send it, *while also* answering from history (P20). Hence
both at once: the relay offer and the answer.

**This has teeth beyond the annoyance.** The draft is live, so if the operator next says
"yes" — including agreeing with the summary, or any confirm-classified utterance — the
harness **releases their own words "summarise what's been done" to the worker as a
task**. An unintended relay, produced by the gate working exactly as designed on an
utterance that was never worker-directed.

## The missing concept

The system models two things: *an instruction for the worker* (hold, confirm, relay) and
*a question the talker cannot answer* (offer to ask the worker). It has no concept of
**a request the talker can fulfil itself from what it already holds** — summarise the
session so far, read back the queue, restate what is pending, recap what happened while
the operator was focused.

## Required outcome

1. A request addressed to the talker must **not** enter the draft, and must not produce
   a relay offer.
2. A genuine worker instruction (including one phrased as an imperative) must still be
   drafted exactly as today. The distinction must not blunt the gate.
3. The talker must answer the self-service request from the snapshot and history.

## Design guidance (yours to improve, but respect the safety direction)

The safe direction is **narrowing**. Suppressing a draft can only ever *reduce* releases,
because a release requires a live draft. So a model-emitted marker in the P18 mould —
the `[[ask-worker]]` precedent, which the harness strips before speaking — is the
natural mechanism: when the model judges an utterance was addressed to it and not the
worker, it marks it, and the harness does not draft it. The model decides only
"was this for me?"; it still cannot release anything.

Wrong-guess behaviour must be safe and self-correcting: a genuine instruction
mis-marked as self-service leaves nothing pending, so a later "yes" meets the existing
mechanical nothing-pending reply (F2) rather than sending. Pin that in a test.

## Owned paths (do not edit anything else)

- `server/src/talker/talker.ts`
- `server/src/talker/utterance-classifier.ts`
- `server/src/talker/types.ts`
- `scripts/talker-prompts/v3-harness.txt`
- `server/tests/unit/talker/prompt.test.ts`
- new test files under `server/tests/unit/talker/`

**Do not touch** `state-view.ts`, `history.ts` or `session-registry.ts` — a sibling child
(P23) owns those this session.

## Required evidence

- TDD, RED first: the failing test must show today's behaviour (an imperative addressed
  to the talker lands in the draft).
- A test proving a genuine worker instruction — "tell the worker to rebase the branch" —
  still drafts and still releases on confirmation.
- A test proving the mis-mark case is safe (nothing pending, no send).
- The gate itself untouched: `release()` stays private with one caller.
- `npm run lint` + ratchet ≤ 326, `npm run typecheck`, and the talker suites green.

## Reporting

Report to the parent: what you changed, the RED evidence, the counts, and anything you
could not do. **Do not commit.** The parent reviews, commits and pushes.
