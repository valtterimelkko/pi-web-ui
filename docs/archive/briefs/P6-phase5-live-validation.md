# P6 — Phase 5 live validation (the acceptance evidence)

## Context

The Voice Mode harness is complete and each piece is verified: the browser
transport (P1), the receipt ack (P2), the operator's draft (P3), the client
speech arbiter (P4) and the surface itself (P5). What has **not** been done is the
end-to-end acceptance run the plan asks for.

**Read first:**

- `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` §5 (the acceptance criteria table,
  A1–A14) and §10.9 (the harness design).
- `docs/plans/VOICE-HARNESS-EXECUTION-STATE.md` for what was already proven and
  how — in particular **reuse the existing scripts** rather than reinventing:
  `scripts/talker-live-validate.ts` (drives the real graph against a real busy Pi
  worker) and `scripts/ws-validate.mjs --step talker` (drives the browser
  transport, red-first by fault injection via `scripts/talker-drop-proxy.mjs`).
- `docs/plans/TALKER-MODEL-REQUIREMENTS.md` if you need the model reasoning.

## The aim

**An evidence table that lets a sceptical reader decide whether Voice Mode meets
its acceptance criteria — including the one that matters most: that the
operator's own words reach the worker unaltered.**

## What to produce

1. **Run the five scenarios** from `benchmarks/03-voice-relay/scenarios/` — the
   same ones the talker model was selected against — end to end against a **live
   Pi worker** on a disposable validation server: `s1-orchestration`,
   `s2-clarification`, `s3-plain-worker`, `s4-permission-gate`, `s5-sparse-state`.
2. **The verbatim-relay comparison.** For every relay, compare the operator's
   utterance to **the worker's own received text** — read from the worker's
   session transcript, not from the talker's account of what it sent. State the
   comparison method (byte count plus equality, not eyeballing) and show the
   result. This is the single most important piece of evidence in the phase and
   the plan calls it out explicitly.
3. **The evidence table** — per scenario, per criterion, pass/fail, with the
   command that produced it. Cover A1–A14 where the scenario touches them; where
   a criterion is **not** exercised by any scenario, say so rather than marking it
   pass.
4. **Known gaps, stated plainly.** Some things cannot be validated here — the
   other in-scope runtimes (below), and anything headless-unverifiable such as
   audible ducking quality. List them as gaps rather than omitting them.

## Scope limits — be honest about these, do not paper over them

- **Pi only for the full run.** Validation is on a disposable server against the
  real Pi runtime.
- **Claude SDK and Antigravity:** attempt only if a usable profile/backend is
  already available; Antigravity is disabled in disposable mode and needs a
  separately authorised workflow, so if it cannot run, record it as a **gap**.
  Do **not** enable production or reach for real credentials to make a matrix
  look complete.
- **No production.** Disposable validation server only. Never touch the
  production socket or service.

## Owned paths (yours)

- `scripts/` — a new validation script if you need one, or extend the existing
  ones
- `docs/plans/` — a results document, e.g.
  `docs/plans/VOICE-MODE-VALIDATION-RESULTS.md`
- Their tests, if any

## Off-limits — do not modify

- **`server/src/**` and `client/src/**`** — the implementation is frozen for this
  package. **If validation finds a defect, that is a finding to report, not a fix
  to make.** Report it with the failing evidence; the parent will decide.
- `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` — read it, do not edit it.
- The canonical intent file `docs/VOICE-ORCHESTRATOR-FEASIBILITY.md` — the plan
  says any correction to it is the owner's call and must be **proposed, not
  assumed**. Do not edit it.
- `/root/.pi-web-ui/secrets.env` — you may source it into a validation server's
  environment; never print, echo or commit its values.

## A trap that has cost time here

Client tests need the **client** vitest config (`client/vitest.config.ts`, rooted
at `client/`); running them from the repo root reports no files. Server tests run
from `server/`. Validation servers need `TALKER_API_KEY` in **their** environment
and should boot with `env -u NODE_ENV` — ambient production mode demands
production secrets.

## Evidence discipline

- **A scenario that passes on the first run without ever failing is not evidence
  that it tests anything.** For at least the permission gate (`s4`), show it
  failing for the right reason before it passes — the gate is the property the
  whole design rests on.
- Quote raw material: frame text, transcript entries, byte counts. Not summaries
  of them.
- If something fails, report the failure with its evidence. **A failure reported
  honestly is worth far more than a clean table** — this phase exists to find out
  whether the thing works, not to declare that it does.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
