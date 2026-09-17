# Child D — Wave 0 audit evidence (Voice Mode execution, 2026-09-17)

Branch: `feat/voice-audit` (worktree `/root/pi-web-ui-track-d`).
Scope: Gate 0 re-verification, fidelity-corpus migration, regression-harness skeleton.

Each file below is a captured real output (command + observed result), not a description.

## Gate 0 criteria → evidence

| # | Criterion (brief) | Evidence file | Observed |
|---|---|---|---|
| 1 | `node generate_reports.mjs --test-manifest-audit` exits 0; generated report marks unrun matrices `not measured` | `01-gate0-exit-command.txt` | `EXIT:0`; `report.json` `verdict: "not measured"`, `totals {manifests:1, measured:0, dryRuns:1}`, tier `t3` status `not measured`; `report.html` uses `badge-unmeasured` / `NOT MEASURED` and renders the tier row `not measured`. |
| 2 | Empty-run-set proof: a zero-run set fails closed (no green standings) | `02-empty-run-set.txt` | Generator + lib copied to a temp dir **outside both repos**, no `runs/`: `verdict: "not measured"`, `totals.manifests: 0`, HTML `NOT MEASURED` + `No run manifests found.` — no `MEASURED` badge. Also the bench repo's own suite (`node --test`) passes 10/10, incl. "an empty run set renders as not measured, never as a pass" and "a missing runs directory yields not measured". `runs/` mtimes predate the session: never written. |
| 3 | No hard-coded verdicts / scores / recommendation literals in the reporting layer | `03-hardcoded-literals.txt` | Verdict is derived (`measured.length > 0 ? 'measured' : 'not measured'`); the report consumes it unchanged. No percentage, numeric benchmark score or recommendation string is authored. All ≥2-digit numbers are CSS colours, dates, versions or hash sizes. |
| 4 | The published `site/` is gone from git | `04-published-site.txt` | The plan's lab-scoped path `benchmarks/04-voice-live-lab/site/` **never existed** in the working tree or in any commit (`git ls-files` / `git log --all` empty), so it is absent as required. The repo-root `site/index.html` (which hosted the B4 figures) is deliberately retained and corrected per owner decision D1 (annotate, not erase); the withdrawn numbers now appear only inside an explicit "withdrawn" notice (commit `678724b`). See the note below. |

### Note on criterion 4 (recorded honestly, no silent resolution)

The brief's wording — "the published `site/` is gone from git" — does not literally match the
repo: the top-level `site/index.html` still exists because it hosts Benchmarks 1–3, and owner
decision D1 explicitly requires annotating historical records rather than erasing them. The
B4 correction was applied in place. Deleting the page would contradict D1 and touch other
tracks, so nothing was deleted; the criterion is recorded as **met for the lab-scoped site
path (never existed) and superseded by D1 for the root leaderboard**. Flagged for the
conductor; no bench-repo change made.

## Task 2 — corpus migration → evidence

`05-corpus-migration.txt`: source `/root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier2/fidelity-corpus.json`
(sha256 `f7d738c3…`), migrated to `server/tests/fixtures/fidelity-corpus.json` with a
provenance header (source repo/path, bench HEAD `46b8cc1e…`, source blob sha1 `82ae6e60…`,
source sha256, migration date/author). `items[]` deep-equal the source (20 items, `fc-01`…`fc-20`;
totals requiredWords 68, negations 12, conditionals 9, targets 31, distractors 20).
Observed gap preserved, not edited away: the frozen corpus declares **no file-path token**
(§7.1.3 names file paths as a critical class), so the harness still implements file-path
retention and the fixture records the absence in `observedGaps`.

## Task 3 — regression harness → evidence

`06-regression-suite.txt`: `npm --prefix /root/pi-web-ui-track-d/server test -- tests/regression/`
→ **13 passed / 13, 0 failed, 0 skipped, 0 todo**, `EXIT:0`. Files:

- `server/tests/fixtures/fidelity-corpus.json`
- `server/tests/regression/harness/corpus.ts` — typed loader + validator + scoring helpers
  (required-word recall; negation/conditional/target survival; file-path retention; bare
  `not|never`, `if|unless` cue retention; recognised→delivered byte equality).
- `server/tests/regression/harness/run.ts` — runner shape for later veto suites; a suite with
  0 executed checks fails.
- `server/tests/regression/fidelity-corpus.test.ts` — executing shape + provenance + worked
  scoring example. No kernel-dependent veto tests (a later child owns them).

## Bench-repo fixes

**None needed.** The four Gate 0 criteria hold (with the criterion-4 wording note above). The
only bench-repo working-tree change is the regenerated `report.json` / `report.html` produced
by running the mandated Gate 0 command; no bench commit was made.