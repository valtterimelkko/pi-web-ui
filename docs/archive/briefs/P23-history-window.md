# P23 — The history window must be able to answer "what has been done in this session"

## The live defect (operator-reported, root cause PROVEN from the real session)

The operator attached Voice Mode to a real worker session and asked the talker to
summarise the session's **production queue** — a clear numbered list of one, two, three.
Reported: *"it just wouldn't, simply wouldn't do it"*, and it kept offering to pass the
question to the worker.

## The evidence — this is not a hypothesis

The worker session is `/root/si`:

    /root/.pi/agent/sessions/--root-si--/2026-09-14T12-46-43-058Z_01a09ff4-9b72-73f4-a687-94f99224ad49.jsonl

- It has **32 messages**. The production queue is in **message 16** — the assistant's
  3,472-character answer ("Here's the full picture of what's left for Semester 1…",
  containing "The decision gate — PD3–PD5", "the production queue (weeks 1–2 first…)").
- The talker's window takes the **last 12** messages (`SESSION_HISTORY_LIMITS.entries`)
  and clips each to **400 characters** (`entryChars`).
- The last 12 messages are **21–32** — which are the Agent OS *capture* bookkeeping at
  the end of the session. **Message 16 is not in the window at all.**
- Even if it were, a 3,472-character message would show only its first 400 characters:
  the bottom line, never the list.

So the talker could not see the queue by any route. It correctly said it could not tell
from what it held and correctly offered the P18 fallback. **The defect is the window,
not the talker's honesty.** The honest fallback must survive this change — the aim is
that the talker can answer *more* accurately, never that it bluffs more.

## A second, structural problem in the same evidence

Of the 12 windowed messages, **9 were tool results** and only 3 were the worker's own
words. Tool results are the least useful material for "what has been done" and they are
clipped anyway, yet they consume most of the budget. The window is spending its capacity
on the wrong content.

## Required outcome

1. Asked to summarise what the session has done, the talker can see the **worker's own
   statements** across a useful stretch — not just the last few turns' tool chatter.
2. The queue case is reproducible as a test: given the real session above, the
   projection must include the production-queue material.
3. The window stays **bounded** — a large session must not flood the prompt — and the
   disclosure line stays truthful about what is shown and what is not.
4. The P18 `[[ask-worker]]` fallback still works for genuinely beyond-window questions.

## Design guidance (yours to improve)

- Consider **budget-based selection weighted toward worker/assistant messages** rather
  than a flat count, so tool results cannot crowd out the material a summary needs.
- A larger per-message allowance for the worker's own messages would let a long answer
  survive — 400 characters cannot hold a numbered list inside a 3,472-character answer.
- Keep the existing honest disclosure (exact counts of what is and is not included) and
  the existing never-imply-more-than-the-window prompt rule. Do **not** silently raise
  the ceiling without keeping the disclosure truthful.

## Owned paths (do not edit anything else)

- `server/src/talker/state-view.ts`
- `server/src/talker/history.ts`
- `server/tests/unit/talker/session-history-projection.test.ts`
- new test files under `server/tests/unit/talker/`

**Do not touch** `talker.ts`, `utterance-classifier.ts`, `types.ts` or
`scripts/talker-prompts/v3-harness.txt` — a sibling child (P22) owns those this session.
If you believe the supplied history is itself pre-truncated upstream, **report that
finding rather than editing `session-registry.ts`** (it is not yours this session).

## Required evidence

- TDD, RED first.
- A test built from the **real session file above** showing the production-queue material
  now appears in the rendered history block (it does not today). If reading a real
  session file in a unit test is impractical, construct the equivalent message list
  faithfully and say so explicitly.
- A test proving the window is still bounded (a large synthetic session cannot exceed
  the budget) and the disclosure line stays truthful in both the complete and truncated
  cases.
- `npm run lint` + ratchet ≤ 326, `npm run typecheck`, talker suites green.

## Reporting

Report to the parent: the before/after of what the projection shows for the real session,
the counts, and anything you could not do. **Do not commit.** The parent reviews,
commits and pushes.
