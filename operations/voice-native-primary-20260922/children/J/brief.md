# Child J — brief: primary-mic browser journey, E2 attempt records and the campaign runner

You are **Child J** in the Voice Mode native-primary programme. You are the SOLE WRITER in the
isolated git worktree **`/root/pi-web-ui-wt-voice-journey`** (branch `task/voice-native-journey`,
based on `62739987`). Your session id is provided in the dispatch prompt. Do all work in that worktree.

**Mandatory:** load and follow the `agent-os-child` skill. Declare presence on the board once your
session id is known:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "J: primary-mic journey + campaign runner" --path scripts/voice-lane-lab --path tests/e2e --exclude server/src --exclude client/src --exclude shared --join-session <YOUR-SID>`
and leave the board (`agent-os board leave --id <entry>`) before you finish.
This session runs under a **goal**: the outcome below is your durable aim. Keep working until it is
true, then stop. If blocked, record honestly instead of claiming success.

## Context you must read first

- Plan §4.2 (browser microphone concretely), §6–§8 (measurement/matrix), §11 Phase 2's named
  journey, and §9 (evidence).
- Child L's merged lab: `scripts/voice-lane-lab/lib/{built-app,corpus,director,verifier,records,negative-controls,voices}.ts`
  and `cli.ts` — the built-app capture mode, record schema, corpus and verifier you build on.
  Start with `npx tsx scripts/voice-lane-lab/cli.ts --help` and read the lib files.
- Child C's merged surface: the main controls now bind to the native engine; the native lane is
  started by the main microphone control.
- `tests/e2e/voice-live-e2e.spec.ts` and the `playwright.voice-live*.config.ts` files — the current
  connection-only E2E to be superseded (do not delete the old spec blindly; its config may be reused).

## The outcome that must be true when you are done

1. **The named `primary-mic` browser journey.** One command drives the **built production-shape
   app** against a disposable compiled validation server with `VOICE_MODE_ENGINE=gemini-live`:
   verify the served build and native provider activity, drive the **main** controls with observed
   microphone speech (Chromium file-backed fake audio through the real capture pipeline), and
   record per-attempt immutable evidence (L's record system). Exit codes: **0 pass / 1 demonstrated
   failure / 2 incomplete-invalid**, and **missing credentials or absent ingress evidence ⇒ exit 2** —
   never a green skip.
2. **Real speech through the primary path, no bypass.** Fixture bytes must traverse the production
   capture worklet/resampling and reach the provider as the main-control utterance. Fixture
   transcript injection, direct model text input, fabricated frames or direct worker prompts are
   E0-only and must be refused on this path (L's negative-control markers).
3. **E2 attempt records for episodes.** The journey records, per attempt: manifest (scenario/arm/
   model+effort acknowledgement/build/corpus/scorer hashes/capture mode), fixture and captured-input
   digests, recognised revisions, candidate versions with proposed/presented/delivered bytes,
   approval identity, receipt, worker store/result, provider-call counts and usage, screenshots,
   console errors, status/reason codes, retries, duration, verified cleanup.
4. **Director-driven episodes with controllable adaptive steps.** Use L's deterministic director;
   for approval/correction/repair steps use the labelled `synthetic-stream-source` helper feeding
   the unchanged product capture pipeline. The director confirms only after observing a
   slot-matched candidate AND a completed presentation of that identity; never on a blind timer.
5. **Campaign runner for the §8 matrix.** Execute cells per arm (standard / ET-HIGH), paired by
   episode ID, alternating arm order with a recorded seed, one heavy browser/audio runner at a
   time; write the campaign index covering **every scheduled cell** including
   never-started/skipped/invalid; resume-safe (re-running a completed cell is a no-op; a failed
   cell is never overwritten); arm selection comes from **data** — a `--arm <label> --server-env
   KEY=VALUE` interface (P is defining the exact key in parallel: `VOICE_LIVE_PROFILE=standard|et-high`;
   do not hard-code it beyond a documented default).
6. **Read-only scoring surface.** The runner exposes the raw records and manifests to the offline
   verifier; it does not self-score. A scorer/evaluator pass is a separate later step (Wave 4).
7. **Budget discipline in the runner:** per-cell usage accounting, enforceable attempt deadlines,
   abort of model/audio connections at deadline, and a hard stop if the campaign is told the budget
   is exhausted.

## Gate G2b/J — must pass, paste exact commands and exit statuses

```
cd /root/pi-web-ui-wt-voice-journey
# 1. lab tests still green (L's suite + your additions)
npm test --workspace=server -- tests/voice-live-lab
# 2. scripts-inclusive compile check
npx tsc -p scripts/tsconfig.voice-lab.json --noEmit
# 3. the journey, for real (paste the attempt record path + verdict)
npx tsx scripts/voice-lane-lab/cli.ts primary-mic --episode C01 --arm standard
# 4. the missing-credential path (must be exit 2, never green)
#    e.g. run with GEMINI_API_KEY unset in the child server env
# 5. campaign runner dry validation (no provider calls): enumerate the matrix, verify index shape
npx tsx scripts/voice-lane-lab/cli.ts campaign --plan --arms standard,et-high --dry-run
```
Also required in the handback: the real journey attempt record path + verifier verdict, the exit-2
credential evidence, and the campaign index (dry) showing all scheduled cells and the holdout cells
marked validator-gated.

## Owned paths — nothing else may be modified

- `scripts/voice-lane-lab/**` (continuation of L's merged tree)
- `tests/e2e/**` voice specs + their playwright configs (supersede the connection-only E2E)
- `scripts/tsconfig.voice-lab.json` if new files need it

## NO-TOUCH — do not modify, do not run `git add` on

- `server/src/**`, `client/src/**`, `shared/**` (the product is built, not edited)
- `scripts/voice-live-lab/**` unless a genuinely required adaptation is named in your handback
- `package.json` / workspace manifests
- `server/tests/unit/pi-ai/**` (another lineage)
- `/root/pi-web-ui` (the main checkout) — READ-ONLY to you

If a needed change falls outside owned paths, write the exact request to
`/root/voice-native-20260922/coordination/J/NN-questions.md` and continue with the rest.

## How to work

- **TDD, RED first** for every behaviour; paste failing output.
- One heavy browser/audio runner at a time. Keep real provider calls minimal during development;
  full campaign runs happen only on the conductor's instruction after the freeze.
- Worktree `node_modules` is symlinked from the main checkout on purpose; do not run `npm install`.
- Commit on your branch with clear messages. **DO NOT PUSH. DO NOT MERGE.**
- Never restart, deploy or validate against production. Disposable servers only; verify teardown
  (processes/sockets) in the record.

## Handback — write ONCE at the end

Write `/root/voice-native-20260922/coordination/J/complete.md`, beginning with `FROZEN`,
containing: what changed (file paths), RED evidence verbatim, green evidence, exact commands +
exit statuses, the real journey attempt path + verdict, the campaign index (dry), the arm-selection
interface you implemented, what you deliberately did **not** do, and uncertainty. Also write
`complete.json` with `{status, files, gates:[{command,exit}], red:[{case,evidence}], attemptRecords, uncertainties:[]}`.

## Questions — the bar is high

Write `/root/voice-native-20260922/coordination/J/NN-questions.md` (or `NN-blocked.md`) and **end
your turn immediately**; also print the standalone line `PARENT-INPUT-NEEDED` last. Never wait,
never poll, never hold your turn open. Ask only about: a contradiction or impossibility in these
instructions; an authority or scope boundary you cannot cross; something irreversible; a premise
that turned out to be false. Everything below that line is yours to decide, record and move on with.
