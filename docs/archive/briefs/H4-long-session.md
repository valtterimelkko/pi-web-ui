# H4 — Long-session validation of the talker harness

You are a child worker. Complete this end-to-end, then report back. Do not ask the operator anything — if you hit a genuine blocker, stop and report it.

## Why this exists

The talker harness deliberately uses a **bounded rolling history window with no LLM summariser** (plan §10.9). The bet is that correctness state — the pending proposal, whether it was confirmed, and which instruction a bare "yes" refers to — lives in **harness state**, not model memory, so losing old conversation turns cannot corrupt the gate.

That bet has never been tested over a long session. Your job is to falsify or confirm it.

There is also a second, subtler risk to probe: the operator's real concern was a window boundary landing **mid-thought**, losing a piece of what they were saying. The harness claims to avoid this by trimming on **turn boundaries** and **never trimming while a proposal is pending**. Verify that claim holds under repeated cycling.

## Outcome

Evidence, with real numbers, answering:

1. **Does the gate hold after the window has cycled many times?** No unauthorised relay, no lost proposal, no released-after-expiry, at any point in a 100+ turn session.
2. **Does a pending proposal survive window pressure?** Propose something, then run many turns of unrelated chatter, then confirm — the correct instruction must still be released, and only if it is still live.
3. **Is the never-trim-while-pending rule actually enforced** and not just documented?
4. **Does coherence/register survive**, or does the talker degrade as history drops? (Quality, not correctness — report what you see.)
5. **Does the pushback turn still hold** late in a long session, after the window has cycled repeatedly? A rule that holds at turn 5 and fails at turn 120 is a real finding.

## What to build

A test or script that drives a real `TalkerSession` (`server/src/talker/talker.ts`) through a long session. Prefer the **null/capture delivery adapter** so no worker is involved and runs are fast and hermetic — its `deliveredTexts()` gives you the exact released text for assertions.

Use a **stubbed or fake model client** for the conversational turns — do NOT make 100+ real model calls for the bulk of this. Reserve a small number of **real model calls** (OpenRouter, `google/gemma-4-26b-a4b-it`, thinking off, key from `~/.bashrc`'s `OPENROUTER_API_KEY`) for the coherence/register and late-pushback checks, which genuinely need a model.

Assert at minimum:
- total releases == expected releases (no extras, no misses);
- every released text is **byte-identical** to the operator utterance it should carry;
- a second "yes" after a release releases nothing;
- a proposal that outlives its lifetime window is **not** releasable (`takeForRelease` returns null);
- the history window stays bounded and **is never trimmed below the pending floor while a proposal is alive** (assert on `history`/store state, not just behaviour);
- the gate is intact at turn 1, at the window-cycling boundary, and at the final turn.

## Scope and paths

**Owned (yours to create):**
- `server/tests/unit/talker/talker-long-session.test.ts` (or `.integration.test.ts` if it needs real calls)
- optionally a small script under `scripts/` if a standalone run is more legible

**Read-only, do not edit:** everything else. In particular do **not** modify `server/src/talker/*` — if you find a defect, **report it, do not fix it**. Do not edit the plan or the briefs.

**Do not commit or push.** Leave work in the tree for parent review.

## Method

1. Start with the **long deterministic run** (stubbed model, 100+ turns, multiple window cycles). That is the core evidence and it must be reproducible.
2. Add the targeted adversarial cases: proposal + long chatter + confirm; proposal + expiry + confirm; double-confirm; confirm with nothing pending; window boundary landing exactly at a proposal.
3. Add the small **real-model** checks: coherence/register at turn ~10 vs turn ~120, and the pushback turn late in the session. Report the actual replies — quotes, not summaries.
4. If any assertion fails, **do not weaken it**. Keep the failure as evidence, report it as a finding, and state clearly whether the design claim is falsified.

## Environment

- Repo: `/root/pi-web-ui` (main tree). It is clean at `de6cafe`; verify `git status --short` before finishing.
- Talker module: `server/src/talker/` — read `talker.ts` (the `TalkerSession` public surface), `pending-proposal.ts`, `history.ts`, `types.ts` first.
- Tests: `npx vitest run server/tests/unit/talker/ --reporter=basic`. The existing suite is 97 tests and must stay green.
- Real model calls (only where needed): `OPENROUTER_API_KEY` via `eval "$(grep '^export OPENROUTER_API_KEY' ~/.bashrc)"`.
- Checks to run at the end: `npm run typecheck` (expect exit 0), `npm run lint` (expect 0 errors).

## Stop and report if

- The design claim is falsified (gate breach, lost proposal, or mid-exchange trim) — that is a **finding**, report it immediately with the failing evidence and do not fix it.
- You cannot drive the session without editing `server/src/talker/*`.
- Real model calls fail for an environmental reason; report the structural evidence separately.

## Hand-back format (report exactly this)

1. **Status**: complete / partial / blocked / **design claim falsified**.
2. **What you built** — file paths and how the long run is driven.
3. **The long-run evidence** — turn count, number of window cycles, releases expected vs observed, and the exact command.
4. **Adversarial cases** — each case, its assertion, and its result.
5. **Real-model observations** — quoted replies for the coherence and late-pushback checks, with turn numbers.
6. **Coherence/register verdict** — your honest read on whether quality degrades as history drops, with examples.
7. **Checks run** — exact commands with exit status.
8. **What you could NOT do** and why.
9. **Any finding that contradicts the plan** — state it as a finding; do not silently adapt.
