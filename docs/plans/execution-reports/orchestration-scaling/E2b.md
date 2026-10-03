# E2b — Jev re-measure of the five Pi Web UI specs since Stage C (report to R5)

> **Copied into the repo at E2 close (2026-10-03).** Source of record: `/root/orch-ops/orchestration-scaling/e2/E2b/E2b-final.md` (lane evidence in that directory).

Lane E2b, run 2026-10-02 by child session `01a0fdf1-09ca-759b-b4af-15fa4761d277` (pi, GLM 5.3 Flash)
under parent `0798cc10-dba9-5140-b6a4-3f86ecb880c5`. Worktree `/root/.worktrees/orch-scaling/e2b-jev`
(branch `e2b-remeasure`, base `c14792c`). Model: **jev-1.13.0** (pinned), via this repo's `jev-eval`
only. Repo tests before start: `python3 -m pytest -q` → 72 passed.

## Method

- The five baseline specs (`piwebui-orch-parent`, `-orch-children`, `-operator-reports`, `-restarts`,
  `-dev-hotspots`) were copied to `-e2b` specs with **byte-identical questions, criteria, state,
  facts and model**; only the corpus window changed (`since = "2026-09-30"`) plus the documented
  exclusions. Verified by parsed-TOML diff: the only non-corpus difference is `name`.
- Stage C shipped 2026-09-30 03:33 UTC; `since` is date-granular, so the three sessions started
  00:00–03:33 that day (`01a0efa3…`, `01a0efd9…`, `01a0f006…` — c3a/c1 pre-Stage-C lanes) are
  excluded by id from every `-e2b` spec. That is the only time handling; the instrument itself
  cannot filter by time-of-day.
- Pipeline per the repo playbook: dry-run → pilot (`--limit-sessions 20 --sample random --seed 1`)
  → audit → full run. Pilots: 20/20, 20/20, 20/20, 20/20, 5/5, 105/105 ok (190 rows). Fulls: 35, 42, 57, 57,
  4, 0, 341 units — **all ok, 0 errors** (536 full-run units; 726 result rows in total).
- Questions were NOT reworded (comparability). Misreadings on the new population are reported as
  findings below.

## Populations and n (post-Stage C window)

Frozen-run populations (correction 01 item 5; per-population candidate n, exclusions, selected n and
snapshot times are in `analyses/2026-10-02-e2b-remeasure/README.md` and `populations.json`):

| spec | selected n (snapshot 19:13–19:15 UTC) | programme | non-programme |
|---|---|---|---|
| orch-parent (baseline grep) | 35 sessions | 30 | 5 — **n<10, not meaningful** |
| orch-parent **pi-orch variant** (`tool_grep` + `pi-orch`) | 42 sessions | 34 | 8 — **n<10, not meaningful** |
| orch-children (registry origin=internal-api, rebuilt) | 57 sessions | 46 | 11 |
| orch-children **pi-orch variant** (+ ledger `orch-*` ids) | 57 sessions — **identical population, 100% cache hits** | 46 | 11 |
| operator-reports | 341 prompt units / 52 sessions | 237 | 104 |
| restarts | 4 sessions | 4 | 0 — not meaningful |
| dev-hotspots | 0 sessions | — | — |

Live-candidate views are recomputed on each `build_populations.py` run and labelled with their own
`generated_at` in `populations.json`; no historical candidate snapshot is preserved (correction 02
item 2 — earlier "19:24" figures were unsupported and removed). Only the frozen counts above are
authoritative. Exclusions between any live view and the selected runs: the 3 pre-03:33 session ids
(excluded by id), sessions active within 10 minutes of run time (the five E2-wave children), and
sessions created after the run snapshots.

- Programme = cwd under `/root/.worktrees/orch-scaling/`, `/root/orch-ops/orchestration-scaling/`,
  `/root/pi-orch`, or one of the brief's named orchestration parents (`0798cc10`, `8caabeec`,
  `a7de099d`). Non-programme = the owner's other real use (tweet fetches, skill-conflict work, the
  agent-os signal-diet agent `f04d1539`, the STT programme: `stt-bench-wt`, `whisper-parakeet`,
  `skills-transcribe`).
- The pi-orch children variant adds **zero** units: every discoverable spawn-ledger `orch-*` child
  is already in the registry population; two ledger children (`01a0f86e…` R4 smoke, `dabe02d6…`
  antigravity probe) were deleted and are not even in the archive.
- The pi-orch parent variant finds 7 more sessions: lane children that dispatched reviewers through
  the pi-orch client, invisible to the baseline socket/curl grep.

## Comparison against plan §2

Full table with per-measure judgements: `analyses/2026-10-02-e2b-remeasure/comparison.md` (in the
worktree; committed). Headlines:

| Measure (§2) | Baseline | Post-Stage C | Judgement |
|---|---|---|---|
| Orchestration outcome (delivered/partial/unclear) | 60/18/17% (n=70 gated) | 51/24/24% (n=9 gated) | NOT COMPARABLE — n=9; ±1 unit = 11pp |
| Supervision overhead (0–2) | 1.46 | 1.62 | NOT COMPARABLE (n=9) |
| Parent corrected child work | ~41–43% | 56% | NOT COMPARABLE (n=9) |
| Parent friction: waiting | 21% | 10% | NOT COMPARABLE (n=9); direction consistent with watches, no claim made |
| Hand-written curl share of client invocations (code, independent classes: pi-orch / curl / scripted — incl. tsx runners — / non-invoking reference; same corrected classifier both windows) | curl **88.3%** (3,266/3,697), scripted 11.7% (431), pi-orch 0 (n=220 sessions) | curl **60.6%** (243/401), pi-orch 19.0% (76), scripted 20.4% (82) (n=35) | IMPROVED for hand-written curl — same classifier both windows; correction 02: +9 baseline tsx-client calls moved to scripted, 0 in-window; splits: programme 62% curl / non-programme 50% (n=5, n<10 — not meaningful) |
| Parents using sleep loops (code, gated) | 42/70 = 60% | 7/9 = 78% | NOT COMPARABLE (n=9); **no visible improvement** — sleep loops persist |
| Children ending on an assistant turn (code) | 312/321 = 97% | 56/57 = 98% | ROUGHLY SAME (98% vs 97%, same code both windows) |
| Children hitting workspace/tooling problems | 43% | 37% (prog 35%, non-prog 44% at n=11) | ROUGHLY SAME (n=57 vs 321) |
| Children recording `parentSessionId` (code) | 141/321 = 44% | **0/57 = 0%** | No `parentSessionId` in this 57-child sample; **regression not established** — see finding 4 |
| Prompts reporting a malfunction (gate) | 8% (206/2614) | 13% overall; **non-programme 8/104 = 8%** | SAME for the owner's own use; the overall rise is programme narration |
| Reports described as recurring | 184/206 = 89% (n=206 gated reports) | 38/46 = 83% (n=46 gated; prog 31/38, non 7/8 — n<10 not meaningful) | ROUGHLY SAME |
| Malfunction kinds | orchestration 27%, voice 16%, stuck 13%, perf 12% | orchestration 29%, perf 16%, stuck 7%, voice 0%, ui_display 9% | same ballpark (n=46 vs 206); voice complaints gone in-window |
| Restarts: reason deploy / checked children first | 76% / 58% (n=24 gated, same code) | 1 gated unit: deploy, checked | NOT COMPARABLE (n=1) |
| Dev-hotspots sessions | 133 | 0 | instrument blind spot (below), not a work stoppage |

Code-measure calibration on the baseline population (same code, so the deltas above are
like-for-like): clean-end 312/321 (published check said 92% — rule detail differs, so cross-window
numbers use the same-code values); `parentSessionId` 141/321 (published 149/322); sleep-loop gated
parents 42/70 — exactly the published figure; curl share 78% (published 81%).

## Audited examples (unit, date, first prompt — abbreviated)

1. `claude:0798cc10…` (2026-10-02, /root/rc) — "…ORCHESTRATION-SCALING-READINESS-PLAN.md. So…" →
   orchestrated 0.96 CORRECT (pi-orch dispatch evidence in state); outcome `unclear` correct
   (E2 mid-flight).
2. `pi:01a0f838…` (2026-10-01, orch-ops/iv) — reviewer dispatch brief → orchestrated 0.62 is a
   BORDERLINE over-call (read-only reviewer, `api_calls=0`). Gate noise at small n; reported, not
   reworded.
3. `pi:01a0fca9…` (2026-10-02, j6 lane child) — judged `cut_off` 0.84, but the raw session ends with
   the child finished and verified; the state builder's omission marker landed on the tail. Same
   builder as baseline; clean-end is therefore compared by code, not by Jev.
4. `pi:01a0f2a6…#…` (2026-09-30) — "RESUME AFTER A PRODUCTION RESTART: an unplanned host OOM…"
   reported as malfunction 0.9 — it is programme narration in a dispatch brief, not the operator.
   Hence the programme/non-programme split on this spec.
5. `claude:8caabeec…` (2026-10-02, /root/rc) — "Don't hold off - deploy & restart…" → restart gate
   0.84, deploy + pre-flight check CORRECT ("drain settled, 0 runs cut off").

## Findings for R5

1. **The owner's other real use is stable and healthy**: non-programme malfunction-report share is
   byte-for-byte the baseline rate (8% vs 8%), recurrence ~same (88% vs 89%), children clean-end
   ~same (92% vs 97% same-code), tooling problems ~same (44% at n=11 vs 43%). The post-Stage C
   window's apparent shifts are almost entirely the programme's own traffic.
2. **The client shift is real but smaller than the legacy instrument suggested**: hand-written curl
   fell from 88.3% to 60.6% of Internal API client invocations (independent, mutually exclusive
   classes: pi-orch / curl / scripted / non-invoking reference; same corrected classifier on both
   windows' frozen corpora; correction 02 extended `scripted` to tsx runners — that moved +9 baseline
   calls and 0 in-window calls, so the window shares are unchanged). pi-orch is 19.0% of in-window
   invocations (0 in baseline — the client did not exist), scripted clients rose 11.7%→20.4%. Among
   legacy-marker API-reference calls only, curl is 55% (the old instrument's 78%→55%); that share is
   kept labelled as the legacy-instrument measure.
3. **Sleep loops persist** among gated parents (7/9; baseline 42/70) — no visible improvement, but
   n=9. Watch this at the next re-measure.
4. **No `parentSessionId` in the 57-child sample; regression not established**: 0/57 in-window
   children record it (baseline 141/321 = 44%). The in-window orchestrating parents were almost all
   Claude Code sessions, which cannot send `X-Parent-Session`; a parent live probe on 2026-10-02
   19:30 UTC showed a Pi-parent header create records `parentSessionId` with `parentSource: header`
   (supplied by the parent in `01-correction.md`). No eligible Pi-parent cohort was identifiable in
   the frozen sample (0 of 57 children match a spawn-ledger entry), so the measure cannot be
   stratified by parent runtime in-window. Lineage for pi-orch children lives in
   `~/.pi-orch/spawn-ledger.json` owner ids (58 spawns since 09-30).
5. **Programme dominance is the window's defining feature**: 30/35 parent-session matches, 46/57
   children, 237/341 report units are the programme's own lanes. Real-use comparisons must use the
   non-programme parts, and parent-side non-programme n is under 10 — declared not meaningful.
6. **Instrument gaps found while re-measuring** (specs unchanged, so these are reported, not fixed):
   the baseline parent grep misses pi-orch-only parents (+7 sessions found by the variant); the
   restart grep misses `production:drain-restart` (the programme's restarts are invisible to it;
   only 4 systemctl-era units matched); the dev-hotspots repo filter matches only `/root/pi-web-ui`
   itself, which is empty in-window because all work runs in lane worktrees.

## Cost actually spent

3,436,124 input tokens ≈ **$0.144** (jev-1.13.0, $0.042/Mtok input, output free), including all
pilots and both variants. Largest single run ≈ $0.042. Every run's dry-run estimate was
$0.001–$0.045 — all far under the $2 stop-and-ask gate (never triggered). Row totals: 536 full-run
units + 190 pilot rows = 726 result rows.

## Blind spots

- Small n everywhere on the parent side (9–10 gated) and restarts (4); percentages there are not
  findings. Calibration is a group property; borderline per-unit calls exist (example 2).
- Sessions still active at run time are excluded by the instrument: the five E2-wave children
  (E2a-0/6/6c/3 and E2b itself) were absent from the children run; counts drift slightly between
  dry-run and full-run freezes (35→34 in one census snapshot) for the same reason.
- Jev reads a 24k/20k/12k-char head-and-tail state: mid-transcript evidence is dropped unless the
  focus regex keeps it; one audited `cut_off` was a state-builder artefact (example 3).
- The crumb layer was not needed in-window (all 57 children were full-fidelity pi transcripts;
  operator-reports ran on full sessions), so nothing here depends on reconstructed sessions.
- Antigravity children: 2 in-window registry children map to conversations readable only as
  transcript JSONL; both are programme review children and are included.
- The programme restart grant means production restarts in-window are owner-approved maintenance;
  the restart spec's n=4 cannot see drain-restarts at all (finding 6).

## Artifacts

- Specs: `specs/piwebui-{orch-parent,orch-children,operator-reports,restarts,dev-hotspots}-e2b.toml`
  plus `-pi-orch` variants (committed on `e2b-remeasure`; `runs/` never committed).
- Analysis: `analyses/2026-10-02-e2b-remeasure/` — `build_populations.py`, `make_specs.py`,
  `census_e2b.py`, `compare.py`, `README.md`, `populations.json`, `comparison.md`, `comparison.json`,
  census JSONs, frozen parent corpus snapshots.
- Run outputs (gitignored, on disk): `runs/piwebui-*-e2b` and `runs/piwebui-*-e2b-pilot`
  (results.jsonl, states.jsonl, corpus.jsonl + manifest, report.md per run).
