# Brief D — audit & regression assets (Wave 0 child; plan Phase 0 re-verification + Phase 6 asset preparation)

**Session:** assigned at dispatch. **Worktree:** `/root/pi-web-ui-track-d` (branch `feat/voice-audit`, based on master `f70030d`). **Runtime:** pi. **Model:** `clinepass/cline-pass/deepseek-v4.1-flash`, thinking `high` (this entry advertises `high` only — do not request any other level).

## Bounded outcome

1. **Gate 0 independently re-verified** with captured evidence (the plan's Phase 0 exit gate).
2. **Phase 6 assets in place**, ready for a later wave: the frozen 20-utterance fidelity corpus migrated into the server test tree, and the regression harness skeleton (loader + scoring helpers + runner config). The kernel-dependent veto suites are **not** yours in this wave.
3. **No Gate-0 gap left unfixed** — if the audit finds a real remaining gap in the benchmarks repo or the lab docs, fix it minimally (see constraints) and report it.

## Owned paths — edit nothing else

- `server/tests/fixtures/**`, `server/tests/regression/**`;
- `operations/voice-live-20260917/evidence/D/**` (committed on your branch);
- `/root/agent-benchmarks/**` — **only if** a Gate-0 gap must be fixed there; if so, work on a branch named `voice-audit-20260917` in that repo and hand the branch name back. Never touch `benchmarks/04-voice-live-lab/runs/**` (gitignored run data).
- **NO-TOUCH:** `server/src/**`, `client/**`, `shared/**`, `docs/VOICE-MODE-*`, all other ops paths.

## Task 1 — Gate 0 re-verification (independent; record each criterion honestly)

Run and capture:

```bash
cd /root/agent-benchmarks/benchmarks/04-voice-live-lab
node generate_reports.mjs --test-manifest-audit; echo "EXIT:$?"
```

Criteria to verify and evidence:
1. Exit 0; generated `report.json` / `report.html` mark unrun matrices as `not measured` / `unmeasured` — inspect the generated files.
2. **Empty-run-set edge case (real proof, not description):** prove the generator fails closed when there are no run manifests. Do this without mutating the real `runs/` directory — e.g. copy the lab directory (or the generator + lib) to a temp location outside both repos, remove the run set there, run, and capture the output as evidence (a zero-run set must render `not measured` / refuse green standings). If the generator offers a flag for an alternate runs path, prefer it.
3. Grep the reporting layer (`generate_reports.mjs`, `lib/**`) for hard-coded verdicts, scores or recommendation literals; report what you find (expected: none).
4. The published `site/` is gone from git (verify in the bench repo history/working tree).

## Task 2 — fidelity corpus migration

- Source (frozen corpus, from the L7 lab work): `/root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier2/fidelity-corpus.json` (and `t2-fidelity-corpus.json` in the same directory — inspect both; migrate the corpus the plan's §7.1.3 requires: 20 utterances with negations, conditionals, file paths, target names).
- Deliverable: `server/tests/fixtures/fidelity-corpus.json` with a small provenance header/field (source path + bench commit hash) — structure it so the regression runner can read it (a JSON document with an utterances array; you may wrap the source if the source is an array).
- Add a **loader/scoring test that executes**: at minimum shape validation (20 utterances; required fields present) plus the scoring helpers below. No skipped/empty suites.

## Task 3 — regression harness skeleton

Under `server/tests/regression/`:

- `harness/corpus.ts` — typed loader for the fixture + scoring helpers: recognised→delivered byte equality (semi-verbatim), required-word recall, and **critical-token retention** for negations (`not`, `never`) and conditionals (`if`, `unless`) and file paths/target names.
- `harness/run.ts` — a small runner shape the later veto suites can reuse.
- One executing test file (e.g. `fidelity-corpus.test.ts`) that loads the corpus and asserts its shape + one worked scoring example. **Do not** write kernel-dependent veto tests yet (those need the merged kernel; a later child owns them).
- Wire it so `npm --prefix /root/pi-web-ui-track-d/server test -- tests/regression/` executes your tests with 0 failures and no skips.

## Anti-cheat constraints

- Every claim in your handback must be a captured real output, not a description. Paste the key lines.
- Do not weaken or fake a suite to make it green: a suite with 0 executed tests or skips fails.
- No edits to production code in this wave.

## Stop protocol

If a Gate-0 gap is structural (needs an owner decision or touches another track), write `/root/voice-exec-20260917/coordination/D/01-questions.md`, print `PARENT-INPUT-NEEDED`, end your turn.

## Handback (end of work, then end your turn)

Commit on `feat/voice-audit` (and, if used, a named branch in agent-benchmarks). Write `/root/voice-exec-20260917/coordination/D/complete.md`:

- **Audit results**: one line per criterion above with the observed evidence (this is the Gate 0 record).
- Outcome of the corpus migration + harness skeleton.
- **Changed-path inventory** (exact, both repos; name any agent-benchmarks branch).
- Gate commands + observed results.
- Any bench-repo fixes made (with rationale) or "none needed".
- `FROZEN` marker.

Declare on the agent-os board (`agent-os board declare --join-session <your session id>`); leave the board entry on completion.
