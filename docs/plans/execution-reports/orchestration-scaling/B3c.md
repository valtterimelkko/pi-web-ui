# B3c — streamed-byte budget default re-sized from measurement (16 MiB → 4 MiB)

**Status:** implemented, gated, live-proven at the new default; realistic-child positive control passed; real-model abort attempt honestly negative (see Blind spots).
**Lane:** `b3c` · **Worktree:** `/root/.worktrees/orch-scaling/b3c-pi-web-ui` · **Branch:** `orch/b3c` (base master `fadc6783`)
**Contract:** **1.56.0** · **Build commit for all live runs:** `dc9b1613` worktree build (rebuilt after the last source change; harness scratch dist revision verified `dc9b1613…`)
**Coordination dir:** `/root/orch-ops/orchestration-scaling/b3c/` — every run's verdict, cumulative A2 sample file, stderr log and per-run analysis live in `measure/` there (unique names, never overwritten). Raw run artefacts are deliberately NOT committed to the repo (common brief: no run artefacts in git).

## What shipped

The per-run streamed-byte budget default (`PI_RUN_BUDGET_MAX_STREAMED_BYTES`, B3b/contract 1.50.0) is re-sized **16 MiB → 4 MiB (`4194304`)** from a frozen measurement rule, so a runaway is bounded at a quarter of the volume before the upstream end-of-message finalisation stall (which scales with the finalised message size) can approach the B2 300 ms lag threshold. Env override, `0`-disable and warn-and-fallback semantics unchanged. Config and docs only — no guard, route or event changes.

## The frozen decision rule and the measurement

Rule (brief, frozen): measure the `bytes` scenario ≥5× each at 8 MiB and 4 MiB plus 2× at 16 MiB (positive control); **new default = the largest of {8 MiB, 4 MiB} whose worst measured end-of-run stall is under 200 ms** (two-thirds margin under the 300 ms B2 gate); never below 2× the real merged-run maximum (1,050,331 bytes); if neither qualifies, stop and ask.

Instrument: the B3b pristine-harness live-proof driver, parameterised with `--bytes-cap` (commit `c8838308`; functionally identical to V2a's `driver-cap-param.diff` — verified by diff, comment wording only). 12 runs, each `systemd-run --scope --collect --quiet --unit=b3c-cap-<label> npx tsx server/tests/unit/pi-ai/run-budget-live-proof.mts --scratch /tmp/b3c-live --scenario bytes --bytes-cap <N>` → **exit 0 × 12**. A2 cadence 1 s (harness default); the decision metric is the largest single lag sample (`lagMaxMs`) inside the run window, sliced offline from each run's preserved `health-metrics.jsonl` by the verdict timeline (`measure/analyse.py`, kept with the evidence).

| run | cap | bytes streamed at abort | A abort / receipt | worst stall (lagMaxMs) | worst reading (lagP99Ms) | readings ≥300 |
|---|---|---|---|---|---|---|
| 8m-1 | 8 388 608 | 8 413 184 | `RUN_BUDGET_EXCEEDED` ×2 | 134 | 134 | 0 |
| 8m-2 | 8 388 608 | 8 404 992 | `RUN_BUDGET_EXCEEDED` ×2 | 178 | 178 | 0 |
| 8m-3 | 8 388 608 | 8 404 992 | `RUN_BUDGET_EXCEEDED` ×2 | **209** | 209 | 0 |
| 8m-4 | 8 388 608 | 8 413 184 | `RUN_BUDGET_EXCEEDED` ×2 | 25 | 25 | 0 |
| 8m-5 | 8 388 608 | 8 409 088 | `RUN_BUDGET_EXCEEDED` ×2 | 4 | 4 | 0 |
| 4m-1 | 4 194 304 | 4 218 880 | `RUN_BUDGET_EXCEEDED` ×2 | 40 | 40 | 0 |
| 4m-2 | 4 194 304 | 4 210 688 | `RUN_BUDGET_EXCEEDED` ×2 | 14 | 14 | 0 |
| 4m-3 | 4 194 304 | 4 214 784 | `RUN_BUDGET_EXCEEDED` ×2 | 132 | 132 | 0 |
| 4m-4 | 4 194 304 | 4 214 784 | `RUN_BUDGET_EXCEEDED` ×2 | 2 | 2 | 0 |
| 4m-5 | 4 194 304 | 4 218 880 | `RUN_BUDGET_EXCEEDED` ×2 | 13 | 13 | 0 |
| 16m-1 (control) | 16 777 216 | 16 797 696 | `RUN_BUDGET_EXCEEDED` ×2 | 180 | 180 | 0 |
| 16m-2 (control) | 16 777 216 | 16 801 792 | `RUN_BUDGET_EXCEEDED` ×2 | 187 | 187 | 0 |

All 12 runs: session B streamed throughout A's window (`bSpannedARun: true`, `bHeldUntilAResolved: true`) and completed normally; zero `LoopAttribution` lines in any run (the stall class remains un-attributed, as V2a found for this harness). 8m-3's 209 ms is one real single-sample stall (verified directly in its window slice: flat 0–1 ms while streaming, one 209 ms sample at finalisation replaying across the 60 s ring).

**Decision:** 8 MiB worst = **209 ms → fails** (<200 ms rule); 4 MiB worst = **132 ms → passes** → **new default 4 MiB = 4 194 304 bytes = 3.99× the real maximum (≥2× rule satisfied)**. Applied to my own measurements, not V2a's reported ones — V2a's 8 MiB runs happened to peak at 181 ms; the run-to-run spread crosses 200 ms, which is exactly why the brief ordered a re-measurement.

## TDD receipts

| behaviour | RED | GREEN |
|---|---|---|
| streamed-byte default 16 MiB → 4 MiB (default pin + pair-resolution defaults pin) | `cd server && env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test npx vitest run tests/unit/config.test.ts` → exit 1 — `Tests 2 failed \| 33 passed (35)` | same command set + `tests/unit/pi/run-budget.test.ts` + `tests/unit/internal-api/session-routes-run-budget.test.ts` → exit 0 — `Tests 58 passed (58)` |
| contract version pins 1.51.0 → 1.56.0 | (pins edited with the bump commit) | `npx vitest run tests/unit/internal-api/capabilities.test.ts tests/unit/command-code/command-code-contract.test.ts` → exit 0 — `Tests 14 passed (14)` |

Honest note: the first GREEN run failed once — `pair resolution: invalid values warn and fall back to defaults` pins the default via the fallback path and had not been included in the RED set (`Tests 1 failed | 57 passed`); its assertion was updated (test-only) and the combination re-ran green. The RED state therefore covered 2 of the 3 default pins; the third was found by the first GREEN run.

## Commits

```
c8838308 tests: --bytes-cap option on the B3b live-proof driver for byte-cap sizing runs (B3c, V2a's driver-cap-param.diff)
c5fd99cf config: streamed-byte default re-sized 16 MiB -> 4 MiB from live measurement (B3c)
dc9b1613 docs+contract 1.56.0: streamed-byte default re-size recorded (B3c)
557adc8d docs: B3c evidence bundle (this file; sha placed by the follow-up tidy commit)
```

Diff vs base: `git diff --stat fadc6783..HEAD` → 11 files changed, 53 insertions(+), 24 deletions(-) (plus this evidence file's commit).

## Live validation at the new default (disposable, pristine pi-ai)

Fresh scratch (`/tmp/b3c-live` rebuilt after `npm run build` at `dc9b1613`; scratch dist revision verified), same driver, **no `--bytes-cap`** so the server default (now 4 MiB) applies:

| run | A abort / receipt | bytes at abort | worst stall (lagMaxMs) | readings ≥300 |
|---|---|---|---|---|
| newdef-1 | `500` `RUN_BUDGET_EXCEEDED`; receipt `failed`/`RUN_BUDGET_EXCEEDED` | 4 218 880 | 2 ms | 0 |
| newdef-2 | same | 4 210 688 | 156 ms | 0 |
| newdef-3 | same | 4 214 784 | 1 ms | 0 |

**Definition-of-victory check: no end-of-run reading ≥ 300 ms at the new default** — met in all 3 runs, for both `lagP99Ms` readings and single samples (worst 156 ms), with B streaming through A's window in every run (`bSpannedARun`/`bHeldUntilAResolved` true). Exit 0 × 3; verdicts + metrics kept (`measure/cap-newdef-{1,2,3}-*`).

## Realistic-child pattern (plan §4, R2 rule — budgets step)

Positive control, end to end on a REAL child (verdict files `measure/realistic-pos-metrics.jsonl`, `/root/b3c-live/pos/collect-pos.json` copies):

- Disposable validation server from this worktree, `--compiled`, systemd scope (`b3c-pos`), port 19294. `GET /health` → `buildIdentity.revision: "dc9b1613a1b614af24c118a748a26e51246ee65f"`, `buildMode: "compiled"`, `contractVersion: "1.56.0"`.
- Isolation (v2a fanout pattern): fake `HOME`, `PI_CODING_AGENT_DIR`=`PI_AGENT_DIR` isolated, **real extension set as byte-identical copies** (85 files, `diff -r` exit 0), `agent-os` stub on `PATH` + `AGENT_OS_BIN`, `BOARD_STORE_DIR`, `AGENT_OS_VAULT_ROOT`, `NOTIFICATIONS_DIR` + `NOTIFICATIONS_ENABLED=false`, watch-wake socket/token → the validation server's own, `PI_WEB_UI_GOAL_HOME`, `PI_COMPACTION_LOG`, `PI_BG_TASKS_DIR`, `NODE_OPTIONS=--max-old-space-size=4096`, `SESSION_DIR` never set. zai credential copied into the isolated agent dir (mode 600) and **deleted after the runs** (verified absent). Deviation disclosed: `OBSERVABILITY_METRICS_INTERVAL_MS=5000` (not the production 30 s) for stall resolution.
- Child: Pi session, `model: zai/glm-5.3-flash`, `thinkingLevel: low`, **fresh worktree-like cwd** (`/root/b3c-live/pos/child-cwd`, fresh `git init` + commit), **goal-armed** (`POST /goal {action:"start", maxTurns: 8, verifyCommand: "test -f …/GOAL-DONE"}`), task includes a **background shell** (`sleep 20 && wc -c report.txt > wc-result.txt`) with work continuing while it runs.
- Result: **goal `achieved`, runs 1/8, verification passed.** The child wrote report.txt (1 328 000 bytes — it chose to exceed the 300 KB ask), ran the background shell and confirmed its completion (exit 0), wrote summary.txt (354 B), created GOAL-DONE only after the background task finished. **Zero `run_budget_exceeded` events / no `RUN_BUDGET_EXCEEDED` anywhere in the transcript** — no false trip at the new default. Session `DELETE` → success. Server A2 across the child's lifetime: 155 readings, max `lagMaxMs` 129, zero ≥300.

Real-model abort attempt (supplementary mechanism proof — **honest negative**, two bounded attempts):

- Server #2 at `PI_RUN_BUDGET_MAX_STREAMED_BYTES=131072`: asked for a 300 000-char inline reply → the model refused ("far beyond any single message's output limit … must generate it token by token"), wrote the content to a file via a tool instead; run `completed`, no budget event.
- Server #3 at the config floor `65536`: asked for 100 000 × 'a' inline → refused again ("can't reliably hand-type exactly 100,000 characters in a single reply"); run `completed`, no budget event. Transcripts + receipt preserved (`measure/realistic-abort-retry-*`).

## Production untouched

`systemctl show pi-web-ui.service` → `MainPID=2957930`, `ActiveEnterTimestamp=Tue 2026-09-29 14:44:54 UTC` — identical to V2a's recorded before/after values. No production socket contact; no `~/.pi-web-ui` writes; no restart.

## Gates (exact commands and exit codes, at the evidence commit)

- `npm run lint` → **exit 0** (0 errors; warnings pre-existing in files this lane never touched)
- `npm run typecheck` → **exit 0**
- `npm run build` → **exit 0**
- Full server unit suite: `cd server && env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test npx vitest run tests/unit` → **exit 0 — Test Files 475 passed (475); Tests 5 701 passed | 3 skipped (5 704)**
- `npm run docs:check-links` → **exit 0** — `OK: 1274 internal link(s) resolve across 322 Markdown files.`
- `npm run docs:check-agent-guides` → **exit 0** — `AGENTS.md and CLAUDE.md are byte-identical`
- Load-sensitive re-run check: not needed — zero failures in the full suite.

## Definition of victory — item by item (plan §6 B3c + lane brief)

- **Config test for the new default** — met (`config.test.ts` 58/58; two direct default pins + fallback-path pin at 4 MiB).
- **B3b's live `bytes` scenario at the new default shows no end-of-run reading ≥ 300 ms** — met (3 runs, worst single sample 156 ms, zero ≥300 readings).
- **Docs and contract changelog updated** — met (contract 1.56.0 entry; OBSERVABILITY.md caps + calibration; INTERNAL-API.md receipts section; RECENT-CHANGES.md highlight; `.env.example`; historical 1.50.0 changelog entries and the plan file deliberately untouched).
- Brief decision rule applied on my own measurements with every verdict + A2 sample kept — met (12 runs, table above; `measure/` in the coordination dir, unique names, never overwritten).
- Never below 2× the real maximum — met (3.99×).
- Driver parameterisation (`--bytes-cap`) — met (`c8838308`).
- Realistic-child pattern (R2 rule) — met for the positive control (goal-armed, real extensions byte-identical, fresh git cwd, background shell, real model, no false trip); abort-on-real-child attempted twice and honestly reported not provable with compliant instruct models (see Blind spots 5).

## Not done, and why

- **Agent OS contract mirror** (`/root/agent-os`) — parent updates at merge per the common brief. Mirror needs: version **1.56.0**; `PI_RUN_BUDGET_MAX_STREAMED_BYTES` default now **4 194 304** (was 16 777 216); no new events/codes/fields.
- No plan-file edits (parent keeps §8/§9). No push, merge or rebase (lane rule). No production contact. No Telegram, no Agent OS capture (parent's job).

## Blind spots (R2 rule — what this evidence does NOT see)

1. **Sampler resolution:** the stall metric is the A2 sampler's `lagMaxMs` at 1 s cadence (fixture runs); sub-interval stall structure is invisible to it. It is the same instrument the B2 gate reads.
2. **Tail of the stall distribution:** my two 16 MiB controls (180/187 ms) landed at the low end of V2a's reported 180–651 ms band; two runs do not bound the tail. The <200 ms sizing margin is the designed buffer against exactly this spread.
3. **No causal attribution:** zero `LoopAttribution` lines across all 15 harness runs — the finalisation stall happens outside attributed spans; root cause remains open (unchanged from B3b/V2a).
4. **Realistic-child cadence:** 5 s A2 cadence (disclosed deviation from production's 30 s); the realistic child emitted only small assistant messages, so no stall was expected or seen — the realistic proof covers false-trip behaviour, not the stall class.
5. **Real-model abort path unproven:** compliant instruct models refuse or tool-route large inline volumes, so the budget's abort could not be fired by a real child even at the 64 KiB floor. The guard is model-agnostic (same `RunBudgetGuard` at the same subscribe funnel, unit-pinned across text/thinking/tool-call deltas) and the fixture proves the abort at the exact new default; a determined adversarial child that does stream huge volumes is covered by that path.
6. **Concurrent runaways:** the fixture scenario is one runaway + one streaming session; N concurrent 4 MiB runaways (aggregate admission/heap interaction) is not measured here — B2's admission gates own that dimension.
7. **Three DoV runs only** at the new default; the sizing decision rested on the 12-run measurement, not on these three.

## Residual risks

1. Behaviour change for anyone relying on the undocumented 16 MiB default: a runaway now aborts at 4 MiB. Rollback: `PI_RUN_BUDGET_MAX_STREAMED_BYTES=16777216` or revert `c5fd99cf` (documented in the 1.56.0 changelog entry).
2. 4 MiB sits 3.99× above the measured real merged-run maximum (vs 15.3× before) — if real sessions grow past ~4 MiB/run, breaches become possible; the env knob allows raising per-deployment, and a breach is loudly observable (`run_budget_exceeded` + `failed` receipt), never silent.
3. The un-attributed finalisation stall still exists at every size (132 ms worst at 4 MiB) — bounded well under the gate, but not eliminated.
