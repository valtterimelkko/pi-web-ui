# P20 — Give the talker the worker's session history (mid-session attach)

## The gap, confirmed on a live turn

The operator attached Voice Mode to a **mid-session** worker (several completed
turns) and asked *"What has happened earlier in this session?"*. The turn was
classified `question` and reached `phase: proposed` — the talker correctly offered to
ask the worker, because **it genuinely had nothing to answer from**.

`history.ts` is a *bounded rolling conversation history* — the talker's window on its
conversation with the operator. `state-view.ts` supplies current status plus the last
assistant message. **Neither gives the talker the worker session's earlier turns.**

This is not an edge case — it is the operator's stated *primary* Q&A use case:

> "if I have an already ongoing worker session, but then I attach the voice mode to it
> in the middle of it, I might want to ask questions about the earlier turns and the
> earlier stuff in the worker's session."

## The bounded outcome

**A question about earlier turns can be answered from the session's actual history,
and the talker says honestly when it cannot.**

1. The talker's context includes a **bounded view of the worker session's recent
   history** — enough that "what has happened earlier?" is answerable for a
   mid-session attach.
2. **Bounded and cheap**: the session can be enormous, so do not feed the whole
   transcript. Choose a defensible window (recent turns, or a token/char budget) and
   **document the choice**.
3. **The offer-to-ask-the-worker still exists** and must still fire when the question
   genuinely exceeds what the history view holds — it is the honest fallback, and this
   change must not make the talker bluff instead.
4. **Honesty is preserved**: if the history is truncated or absent, say so. Never imply
   knowledge beyond the window.

## Invariants

- **Summarise one direction only** — operator → worker stays verbatim; the gate is
  untouched (`release()` private with one caller, `takeForRelease` atomic).
- **The offer must not become a paraphrase channel** — a relayed question is the
  operator's verbatim words.
- **Reading levels (P17), whole-turn digest (P19), focus/hold (P18) must not regress.**
- **No new lint warnings** (ceiling 326; check the current actual).
- **Production is off-limits.**

## TDD

RED-first for: a mid-session question about earlier turns being answered from history
rather than deferred; an over-window question still deferring honestly; and truncation
being stated rather than hidden.

## Evidence

Exact commands and exit codes; RED evidence; the full talker suite; the ratchet result;
**live proof** that a mid-session "what happened earlier" question is answered from real
history; anything that did not work.

## Owned paths

`server/src/talker/**` (state view, history, prompt), their tests.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
