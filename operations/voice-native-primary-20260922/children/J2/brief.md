# Child J2 — correction brief: director candidate persistence + verifier negation awareness

You are **Child J2**, a bounded correction child in the Voice Mode native-primary programme. You are
the SOLE WRITER in the isolated git worktree **`/root/pi-web-ui-wt-voice-lab-fix`** (branch
`task/voice-native-lab-fix`, based on the merged W1/W2 tree). Your session id is in the dispatch
prompt. Do all work in that worktree.

**Mandatory:** load and follow the `agent-os-child` skill. Declare presence:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "J2: director/verifier fix-loop corrections" --path scripts/voice-lane-lab/lib --path server/tests/voice-live-lab --exclude scripts/voice-lane-lab/corpus --exclude server/src --exclude client --join-session <YOUR-SID>`
and leave the board before you finish. This session runs under a goal: the outcome below is your aim.

## Live evidence you are correcting (fix-loop pass 1, 12 real built-app journeys)

**Defect A — C20 stalled because a candidate that arrived during a `speak` phase was ignored.**
Step trail (C20 attempt-01): `speak t1` → candidate observed (`prop-1`, "update the changelog for the
voice release") while `speak t2` was current → conversation turns `speak t2`/`speak t3` → then the
`adaptive-confirm` (t4) block enters `await-candidate (strict: true)` and waits for a **new**
candidate until its deadline: `terminal: interacting-failure deadline exceeded waiting for candidate`.
The pending candidate already existed and was never invalidated. In contrast C01 works because its
candidate arrives while the machine is already inside `await-candidate`.
**Required behaviour:** a candidate that is observed during a `speak` phase must be recorded; when an
`await-candidate` phase is entered (before arming its deadline) a **live, non-invalidated,
non-consumed** candidate satisfies it immediately (run the strict slot check against it; go on to
`await-presentation`). Amend/cancel must still invalidate the identity so C18's amended-candidate wait
still requires a genuinely new candidate. Release/consumption clears it.

**Defect B — the verifier's `responseMustNotContain` is negation-blind.** Live evidence: C16's honest
response "The worker session is new and has no messages yet, so I can't confirm if the test suite has
finished running." was flagged `response contains forbidden content: "finished"` (the episode forbids
completion claims: passed/finished/succeeded/green). C15's correct response "Understood. I will not
send anything and will wait for your clear instruction to relay a message." was likewise
negation-blind-adjacent (its issue is a required word; the conductor is fixing that slot in the
corpus).
**Required behaviour:** a forbidden phrase counts only when it occurs **without a negation cue
governing it**. Implement clause-level negation awareness in the verifier's response slot check:
- split the response into clauses on `[.;!?\n]`;
- for each occurrence of each `forbidden.split('|')` alternative, look at the clause text before the
  match; if a negation cue appears there (`can't|cannot|can not|don't|doesn't|didn't|hasn't|haven't|
  isn't|aren't|won't|wouldn't|couldn't|not sure|not certain|no idea|don't know|do not know|can't say|
  cannot say|can't confirm|cannot confirm|not yet|yet to`), that occurrence does not count;
- the `|`-alternative semantics must stay as they are (all alternatives required per the current
  data contract) except for this negation guard.
Also add the analogous guard to `responseMustContain`? **No** — required content stays literal.

## Gates — must pass, paste exact commands and exit statuses

```
cd /root/pi-web-ui-wt-voice-lab-fix
NODE_ENV=test npm test --workspace=server -- tests/voice-live-lab
npx tsc -p scripts/tsconfig.voice-lab.json --noEmit
```
Plus: the existing verifier tests must stay green; add RED-first tests for both defects (a director
test with an observation during `speak`, and a verifier test where a negated forbidden phrase passes
while an unnegated one fails). **Do not run real Gemini calls**; the conductor re-runs journeys after
merge.

## Owned paths — nothing else may be modified

- `scripts/voice-lane-lab/lib/director.ts`, `scripts/voice-lane-lab/lib/verifier.ts`,
  `scripts/voice-lane-lab/lib/journey-run.ts` (only if observation capture requires it)
- `server/tests/voice-live-lab/phase1/director.test.ts`,
  `server/tests/voice-live-lab/phase1/verifier.test.ts`, `journey-*.test.ts` as needed

## NO-TOUCH

- `scripts/voice-lane-lab/corpus/**` (the conductor is editing episode data concurrently)
- `client/**`, `server/src/**`, `shared/**`, `package.json`, `server/tests/unit/pi-ai/**`,
  `/root/pi-web-ui` (read-only)
- **Another correction child (H2) is concurrently editing `client/**` and `server/src/voice/**` /
  `server/src/websocket/**` — never touch those paths.**

## How to work

TDD, RED first; minimal path-limited diff; no `npm install`; commit on your branch; **DO NOT PUSH,
DO NOT MERGE**; never touch production.

## Handback

`/root/voice-native-20260922/coordination/J2/complete.md` beginning with `FROZEN` + `complete.json`
with `{status, files, gates:[{command,exit}], red:[{case,evidence}], uncertainties:[]}`.

## Questions

Write `/root/voice-native-20260922/coordination/J2/NN-questions.md` and **end your turn**; print
`PARENT-INPUT-NEEDED` last. Never wait or poll.
