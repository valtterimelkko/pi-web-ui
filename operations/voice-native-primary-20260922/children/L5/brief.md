# Child L5 — brief: W4 remaining seams (soak debug, busy drive, two-session prep)

You are **Child L5** in the Voice Mode native-primary programme, Wave 4. SOLE WRITER in
**`/root/pi-web-ui-wt-voice-w5`** (branch `task/voice-native-w5`, based on current master, which
already contains L4's soak/parking/attachment mechanisms). Your session id is in the dispatch prompt.

**Mandatory:** load/follow `agent-os-child`; declare presence:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "L5: W4 seams (soak, busy, two-session)" --path scripts/voice-lane-lab --path server/tests/voice-live-lab --exclude client/src --exclude server/src --join-session <SID>`
and leave the board before finishing. The goal objective is your durable aim.

## What L4 delivered (read its handback first)

`/root/voice-native-20260922/coordination/L4/complete.md` — the soak runner (SOAK-10MIN), the
`parked`/`adaptive-promote` and `adaptive-switch` mechanisms, the holdout overlay merge, and the
precise missing seams. Your job is the three remaining seams. **RED-first for each.**

### Seam 1 — soak must pass its own bars (priority 1)

L4's real soak run (attempt `SOAK-10MIN-standard/attempt-01`) was recorded honestly as FAIL:
- duration 16.7 min ✓ and one real mid-session reconnect ✓ were proven;
- **6 operator turns recorded (bar ≥8)**;
- **the pre-reconnect pending proposal was never released after the reconnect**;
- an interaction failure: "deadline exceeded waiting for candidate".
Diagnose from the record: why did turns after the reconnect stop producing candidates/observations?
(L4's pace-window observation storage may be insufficient across the reconnect; the lane re-open path
may lose the operator-utterance window; or the plan's repeated C01-t1 relay is refused as a
binding/echo edge.) Fix the runner/plan so a real soak run completes: **≥8 operator turns, ≥10 min,
exactly one reconnect, and the pre-reconnect proposal's pending-work disposition resolved truthfully
(confirmed+released+stored after the reconnect, or a recorded product retirement — never faked).**
At most two real soak confirmation runs.

### Seam 2 — busy drive for C22

The runner must put the disposable worker session into a genuinely BUSY state before the relay (the
product path exists: the mount's `isWorkerBusy` drives the park). Drive it through a real path (an
Internal API prompt to the worker session, or the session pane composer) — never a fabricated busy
flag. The conductor authors the C22 overlay (`corpus/holdout/C22.validator.json`) with
t1 opening / t2 `adaptive-promote` / t3 `adaptive-confirm`; do not edit that file. One real C22
confirmation run (standard arm, `--tts synthetic`).

### Seam 3 — two-session prep for C24

The harness must prepare **two real worker sessions** before the journey and let the switch path
resolve the second from the Internal API session list (L4 built the switch path; the preparation is
missing). One real C24 confirmation run. The conductor authors the C24 overlay.

## Gates — exact commands + exit statuses in the handback

```
cd /root/pi-web-ui-wt-voice-w5
NODE_ENV=test npm test --workspace=server -- tests/voice-live-lab
npx tsc -p scripts/tsconfig.voice-lab.json --noEmit
npm run lint
# real confirmation runs (paste attempt paths + verdicts; max: 2 soak + 1 C22 + 1 C24)
```
Budget: at most four real runs total. If a seam cannot be closed within bounded effort, stop and
document precisely what remains — an honest unsupported outcome beats a faked pass.

## Owned paths · NO-TOUCH

Owned: `scripts/voice-lane-lab/**` (including `corpus/soak/SOAK-10MIN.json`),
`server/tests/voice-live-lab/**`.
NO-TOUCH: `scripts/voice-lane-lab/corpus/holdout/**` (conductor-owned overlays),
`scripts/voice-lane-lab/corpus/episodes/**`, `client/**`, `server/src/**`, `shared/**`,
`package.json`, `/root/pi-web-ui` (read-only).

## Handback

`/root/voice-native-20260922/coordination/L5/complete.md` (`FROZEN`) + `complete.json`
`{status, files, gates:[{command,exit}], red:[{case,evidence}], realRuns:{soak,c22,c24}, uncertainties:[]}`.

## Questions

`/root/voice-native-20260922/coordination/L5/NN-questions.md` + end the turn, `PARENT-INPUT-NEEDED`
last. Never wait or poll. Do not push/merge; never touch production.
