# Child L4 — brief: W4 harness capabilities (soak runner, busy parking, attachment switch)

You are **Child L4** in the Voice Mode native-primary programme, Wave 4 (Phase 5). SOLE WRITER in
**`/root/pi-web-ui-wt-voice-w4`** (branch `task/voice-native-w4`, based on the frozen revision).
Your session id is in the dispatch prompt.

**Mandatory:** load/follow `agent-os-child`; declare presence:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "L4: W4 harness capabilities" --path scripts/voice-lane-lab --path server/tests/voice-live-lab --exclude client/src --exclude server/src --join-session <SID>`
and leave the board before finishing. The goal objective is your durable aim.

## Context

The frozen comparison (plan §8) needs three capabilities the journey harness does not yet have. The
core 24 cells (12 P-tier episodes × 2 arms) already run; these three unblock the soak and the
holdout families. Implement in priority order and document honestly if one exceeds bounded effort.

**Priority 1 — continuity soak (`SOAK-10MIN`), the §8 soak cell (one per arm).**
`npx tsx scripts/voice-lane-lab/cli.ts primary-mic --episode SOAK-10MIN --arm <arm> --tts synthetic`
must drive a **10-minute** session with **≥8 operator turns**, including **one mid-session
voice-transport reconnect**, and prove **pending work survives**: a proposal created before the
reconnect is still presentable/confirmable after it (or, if the product's design retires it, the
survival/retirement must be recorded truthfully and the verifier must adjudicate it, never fake it).
Record the reconnect in the attempt record (wire frames + evidence); extend the verifier with a soak
branch (duration, turn count, reconnect observed, pending-work disposition). Use the existing
corpus/director machinery with a soak-specific episode definition under
`scripts/voice-lane-lab/corpus/episodes/SOAK-10MIN.json` (or an equivalent soak plan) — a small,
honest script (e.g. two relay cycles, two conversation turns, one reconnect, one confirm) is enough;
do not invent new product behaviour.

**Priority 2 — busy parking (holdout C22 family).** The journey must be able to start with the
attached worker **busy** (existing work continues), have a relay **park** (no candidate; parked item),
then have the operator **promote exactly one** parked item (the product's own promote path — drive
the UI control or send the documented frame, never a fabricated candidate), producing a proposal →
presentation → confirm → release → worker store. Extend the director with the smallest honest
mechanism (e.g. a `parked` observation and an `adaptive-promote` turn kind). If the product path
cannot be driven end-to-end from the journey within bounded effort, stop and document precisely which
seam is missing — an honest unsupported outcome is acceptable, a faked one is not.

**Priority 3 — attachment switch (holdout C24 family).** Two worker attachments; a proposal pending
against the first; switch to the second; the old proposal must **never** be retargeted, and the
switch must be acknowledged audibly. Same rule: real product paths only; document honestly if the
seam is missing.

## Gates — exact commands + exit statuses in the handback

```
cd /root/pi-web-ui-wt-voice-w4
NODE_ENV=test npm test --workspace=server -- tests/voice-live-lab
npx tsc -p scripts/tsconfig.voice-lab.json --noEmit
npm run lint
# one real soak confirmation run (inside §10; paste the attempt path + verdict)
npx tsx scripts/voice-lane-lab/cli.ts primary-mic --episode SOAK-10MIN --arm standard --tts synthetic
```
RED-first for each capability; no more than the one confirmation run above plus, at most, one
confirmation run each for parking/attachment if they land (three real runs total, maximum).

## Owned paths · NO-TOUCH

Owned: `scripts/voice-lane-lab/**`, `server/tests/voice-live-lab/**`.
NO-TOUCH: `client/**`, `server/src/**`, `shared/**`, `package.json`, `server/tests/unit/pi-ai/**`,
`/root/pi-web-ui` (read-only). The conductor edits `scripts/voice-lane-lab/corpus/episodes/C10,C11,C22,C24`
concurrently — do not touch those four files or any holdout wording.

## Handback

`/root/voice-native-20260922/coordination/L4/complete.md` (`FROZEN`) + `complete.json`
`{status, files, gates:[{command,exit}], red:[{case,evidence}], capabilities:{soak,parking,attachment}, uncertainties:[]}`.

## Questions

`/root/voice-native-20260922/coordination/L4/NN-questions.md` + end the turn, `PARENT-INPUT-NEEDED`
last. Never wait or poll. Do not push/merge; never touch production.
