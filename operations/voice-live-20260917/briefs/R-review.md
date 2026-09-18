# Brief R — independent read-only review (plan §2 anti-cheat review; Gate 8 precondition)

**Session:** assigned at dispatch. **Worktree:** NONE — you must not create, modify or delete any
file in the repository. **Runtime:** pi. **Model:** assigned at dispatch (a different family from the
authors on purpose). **Report:** `/root/voice-exec-20260917/coordination/R/complete.md` (outside the
repo — that is the only file you may write).

## Bounded outcome

An **independent, adversarial, evidence-cited review** of the Voice Mode implementation as merged on
`master` after Waves 1–2 (contract E, kernel A, audit D, bridge B, client C, regression G, vertical
slice + mount F). You are the reviewer of record for the plan's anti-cheat and gate-integrity
requirements. You do not fix anything; you find what is wrong, weak, unproven or overclaimed, with
`file:line` evidence and a falsifiable reproduction for each finding.

## What you are reviewing (read these first, in this order)

1. `docs/VOICE-MODE-INTENT.md` — the intent and the invariants (N1–N9 especially).
2. `docs/VOICE-MODE-EXECUTION-PLAN.md` — the gates and their anti-early-claim guards (all six).
3. `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` — the frozen v1 wire contract.
4. `docs/VOICE-MODE-EXECUTION-LEDGER.md` §12 — what the conductor actually verified, and the findings
   the children reported (F-1…F-6), so you can test those claims rather than repeat them.
5. The implementation, in the repository at `/root/pi-web-ui`:
   `shared/src/types/voice-messages.ts`, `server/src/voice/**`, `server/src/websocket/voice-live-mount.ts`,
   `server/src/websocket/connection.ts`, `server/src/talker/**` (kernel, policy-core, release-store,
   proposal-store, parking-lot, delivery), `client/src/lib/voiceLive/**`,
   `server/tests/{unit/voice,unit/websocket,regression}/**`,
   `scripts/voice-live-lab/lib/voice-slice/**` and `tests/e2e/voice-live-ducking.spec.ts`.

## What to attack (in priority order)

1. **Gate integrity.** For each of Gates 0–6: is the gate's command what the plan says; does it
   actually exercise the property it names; can it pass while the property is broken? Name any test
   that is unfalsifiable, tautological, or satisfied by a mock that hides the real code path. (The
   conductor already probed two falsifications — the probe-on-silence hole in Gate 3b and the veto
   suites in Gate 6 — extend that thinking, don't repeat it.)
2. **The invariants (N1–N9).** Find any way an instruction, a confirmation, or model output can reach
   the worker without the logged authorisation + matching SHA, or any way the operator's words can be
   replaced by generated text on the validated path. Read `policy-core.ts`, `release-store.ts`,
   `proposal-store.ts` and the mount's release predicate adversarially.
3. **The wire contract's structural claims.** Schema-exactness, the confirm rule, envelope
   versioning, the decoded-byte audio ceiling, lane/generation isolation. Try to construct a frame
   that breaks each claim (in reasoning or a scratch evaluation — you may run `node -e`/`npx tsx`
   snippets that do not write to the repo; a scratch file must live under `/tmp`).
4. **The mount and transport.** Auth/cookie/CSRF/origin posture of the voice path; the voice frame
   budget (can it be abused? does the exemption open a flood path?); lane table bounds; what happens
   on disconnect, on reconnects, on a forged `laneId`/`generation`/`requestId`.
5. **Overclaims.** Compare the ledger's verified claims and the children's handbacks against what the
   code and tests actually establish. Flag every sentence that is stronger than its evidence.

## Rules of engagement

- **Read-only.** Do not modify, create or delete anything inside `/root/pi-web-ui` (and no other
  repository). Scratch files only under `/tmp`. If a finding needs a falsification, prefer a `/tmp`
  script that imports the repo's modules by absolute path, or a `git worktree` is **not** yours to
  create — reason precisely instead and say what you could not execute.
- **No credentials.** Never print, copy or commit key material; if you encounter any, report the
  location only.
- **Evidence or it is not a finding.** Each finding: severity (blocker / high / medium / low),
  `file:line`, what you observed, what you expected, how it was (or could be) reproduced, and whether
  the gate claim it touches is therefore overstated.
- **No noise.** Do not report style, naming or test-organisation preferences. Findings must be about
  correctness, safety, security or gate integrity.
- You may run read-only commands (`git log/show/diff/grep`, `cat`, `node -e`, `npx tsx /tmp/…`).
  Running the repository's own test suite is permitted (it writes only ignored artifacts) — if you
  run it, state the exact command and observe the output honestly.

## Deliverable

`/root/voice-exec-20260917/coordination/R/complete.md` containing:

1. **Verdict per gate** (0–6): SOUND / WEAK / BROKEN-BY-EVIDENCE, one paragraph each.
2. **Findings**, ordered by severity, each with the evidence above.
3. **What you could not verify** and why (honesty about coverage limits).
4. **A short list of the strongest things you tried that failed** — negative results are evidence of
   review depth.

## Stop protocol

If you need the conductor (e.g. an ambiguity in intent, or a claim you cannot adjudicate), write
`/root/voice-exec-20260917/coordination/R/01-questions.md`, print `PARENT-INPUT-NEEDED`, end turn.
