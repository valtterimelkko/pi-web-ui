# Child L — brief: Phase 1 lab/QA instrumentation

You are **Child L** in the Voice Mode native-primary programme. You are the SOLE WRITER in the
isolated git worktree **`/root/pi-web-ui-wt-voice-lab`** (branch `task/voice-native-lab`, based on
`57efe420`). Your session id is provided in the dispatch prompt. Do all work in that worktree.

**Mandatory:** load and follow the `agent-os-child` skill. Declare presence on the board once your
session id is known:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "L: Phase 1 lab/QA instrumentation" --path scripts/voice-lane-lab --path scripts/voice-live-lab --exclude server/src --exclude client/src --exclude shared/src --join-session <YOUR-SID>`
and leave the board (`agent-os board leave --id <entry>`) before you finish.
This session runs under a **goal**: the outcome below is your durable aim. Keep working until it is
true, then stop. If blocked, record honestly instead of claiming success.

## The outcome that must be true when you are done

Deliver the Phase 1 instrumentation that the whole programme's fix loop and comparison depend on —
evidence-grade, not demo-grade:

1. **Built-app primary-control mode in the lane lab.** Extend `scripts/voice-lane-lab/` so it can
   launch the *built production-shape client* (not the current dev-lab page) against a disposable
   compiled validation server, drive the **main Voice Mode controls** through real
   `getUserMedia` with Chromium file-backed fake audio capture (a real-speech WAV; private profile;
   `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture`),
   and observe the captured stream at the boundary (PCM digests, durations, causal timestamps).
   Prove start/stop works and that the utterance traverses the production capture worklet +
   resampling path. A fixed WAV plus hopeful sleeps is not acceptable for adaptive steps: provide a
   lab-only controllable `MediaStream` fixture source (`synthetic-stream-source`, labelled) feeding
   the unchanged product capture pipeline for approval/correction steps.
2. **Per-attempt immutable records.** Every attempt writes a manifest + raw assertions (fixture and
   captured-input digests, recognised revisions where available, timings, screenshots/console
   errors, status/reason codes, retries, cleanup verification). New attempts never overwrite failed
   records. A campaign index lists every scheduled cell including skipped/invalid.
3. **Corpus schema + deterministic director.** One schema-versioned corpus under
   `scripts/voice-lane-lab/corpus/` with the 24 catalogue IDs from the plan (§5.2): id/family/tier,
   provenance, opening worker state, exact input turns, permitted route outcomes, expected
   payloads/constrained semantic slots, forbidden additions/removals, required negation/names/
   numbers, approval/repair turns, per-step deadlines, expected final worker artefact. The director
   is a deterministic finite-state machine with predefined utterances and frozen repair branches
   (never an LLM improvising). Confirmation steps only after observing a matching candidate and a
   completed presentation — never on a blind timer. **Do NOT author holdout wording** (the four
   holdout IDs' surface forms are frozen by a separate validator); leave the holdout slot files
   empty with a schema placeholder.
4. **Two synthetic voices, validated before freezing.** Local TTS (the existing local speech
   synthesis in `scripts/voice-live-lab/lib/voice-slice/operator-audio.ts` is a starting point;
   Supertonic is available) producing two intelligible voices with normal and moderately varied
   rate/pause profiles, each hashed with corpus provenance. Validate each generated fixture with an
   independent ASR pass plus known-word/negation checks; disagreement makes the fixture invalid
   until resolved. Labels must say *synthetic speech based on real wording*.
5. **Offline verifier, TDD'd against damaged evidence.** A verifier that recomputes verdicts from
   raw records: injected failures must be caught for the right reason; clean controls must pass;
   malformed/empty/missing evidence must fail closed (exit 2 class), never pass.
6. **Oracle sensitivity.** For each lab oracle you rely on, run one injection pass proving it
   catches deliberately damaged records/audio before it is trusted to grade the product.
7. **Negative controls wired into existing seams.** E0-only bypass hooks (fixture transcript
   injection, direct model text input, fabricated frames) must be clearly labelled and excluded
   from any measured E2 path.
8. **Scripts-inclusive strict compile check.** Standard typecheck excludes `scripts/`; add one
   strict check (a `tsconfig` variant or equivalent) covering your changed lab import graph, and
   document how to run it.

## Gate G1 — must pass, paste exact commands and exit statuses

```
cd /root/pi-web-ui-wt-voice-lab
# 1. lab test suite (your own new/updated tests included)
npm test --workspace=server -- tests/voice-live-lab        # or the exact scoped path you create; paste it
# 2. scripts-inclusive strict check
npx tsc -p scripts/tsconfig.voice-lab.json --noEmit        # exact config name yours to create; paste it
# 3. built-app capture proof (dry-run acceptable if it costs nothing; a real run is stronger)
npx tsx scripts/voice-lane-lab/cli.ts built-app --episode C01 --dry-run   # exact flags yours; document them
```

Also required in the handback: the **injected-failure evidence** (verifier catches each damaged
record type you claim), the **clean-control evidence** (verifier passes), the **capture start/stop
evidence**, and the **fixture intelligibility evidence** (ASR pass + known-word checks).

## Owned paths — nothing else may be modified

- `scripts/voice-lane-lab/**`
- `scripts/voice-live-lab/**`
- `scripts/audio-lab/**` — only if the audio-lab `doctor` gate is relevant to your work
- `server/tests/voice-live-lab/**` (fixtures/tests for the lab only, if that is where they belong)

## NO-TOUCH — do not modify, do not run `git add` on

- `server/src/**`, `client/src/**`, `shared/**`
- `package.json` / `package-lock.json` / any workspace manifest (the parent adds script entries
  after review; use direct `npx tsx …` commands)
- `server/tests/unit/pi-ai/**` (another lineage)
- `/root/pi-web-ui` (the main checkout) — READ-ONLY to you

## How to work

- **TDD, RED first.** For every behaviour you claim, write the failing test/output first and paste
  the RED evidence in the handback. A test that never failed proves nothing.
- **Real browser, real capture.** Playwright/Chromium with fake *file* capture is the required E2
  ingress path; a fake stream that never touches the product capture pipeline is E0 only.
- **One heavy runner at a time.** Do not run parallel browser/audio runners; the programme has one
  shared host.
- **Keep the diff minimal** and path-limited. Do not refactor unrelated code, do not reformat.
- Commit on your branch with clear messages. **DO NOT PUSH. DO NOT MERGE.** Never restart, deploy
  or validate against production.
- Worktree hygiene: `node_modules` is symlinked from the main checkout on purpose. Do not run
  `npm install`. If a cache error mentions `node_modules/.vite`, retry once with `--no-cache`.

## Handback — write ONCE at the end

Write `/root/voice-native-20260922/coordination/L/complete.md`, beginning with the word `FROZEN`,
containing: what changed (file paths), the RED evidence (verbatim), the green evidence, exact
commands + exit statuses, the fixture/voice hashes and intelligibility results, what you
deliberately did **not** do, and any uncertainty or residual risk. Also write a machine-readable
`/root/voice-native-20260922/coordination/L/complete.json` with `{status, files, gates:[{command,exit}], red:[{case,evidence}], uncertainties:[]}`.
Preserve superseded handbacks by renaming, never overwriting.

## Questions — the bar is high

If you need the conductor, write `/root/voice-native-20260922/coordination/L/NN-questions.md` (or
`NN-blocked.md`) and **end your turn immediately**; also print the standalone line
`PARENT-INPUT-NEEDED` as your last line. Never wait, never poll, never hold your turn open. Ask only
about: a contradiction or impossibility in these instructions; an authority or scope boundary you
cannot cross; something irreversible; a premise that turned out to be false. Everything below that
line is yours to decide, record and move on with.
