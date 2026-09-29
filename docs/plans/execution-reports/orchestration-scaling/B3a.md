# B3a — per-run budgets on streamed tool-call arguments (patch replaced, pi-ai pristine)

**Status:** complete; cap default re-decided under parent correction 02 (2026-09-29). Awaiting independent review and parent sign-off.
**Lane:** `b3a` · **Worktree:** `/root/.worktrees/orch-scaling/b3a-pi-web-ui` · **Branch:** `orch/b3a` (base master `12d01198`)
**Design gate:** `01-design.md` accepted by the parent (`01-answer.md`, 2026-09-29), with one decision amended by measurement (cap defaults, below).

## What shipped

The 2026-09-12 stall class (a runaway generation whose streamed tool-call arguments were re-parsed per delta — quadratic, synchronous) was previously bounded by a `node_modules` patch to `@earendil-works/pi-ai`. Per the owner rule (2026-09-29: upstream packages stay pristine), the patch is **removed** and the bound now lives in pi-web-ui:

- `server/src/pi/tool-args-budget.ts` — per-tool-call and per-run counters over the public `toolcall_delta` events, installed at the single `PiService.createSession` `session.subscribe` funnel (covers Internal API, browser, hosted and extension-pool sessions; subagent children are OS processes, outside the shared loop). On breach: one synthetic `tool_args_budget_exceeded` event through the same handler, then `AgentSession.abort()` (public API).
- `server/src/internal-api` — `RUN_BUDGET_EXCEEDED` terminal receipt code (contract **1.48.0**), `tool_args_budget_exceeded` SSE event type + registry entry, `runtimeErrorCode` mapping, Pi dispatch path turns the synthetic event into `PiToolArgsBudgetExceededError` so the receipt fails loudly instead of completing as `completed` (the masking bug the tests pin).
- `server/src/config.ts` — `PI_TOOL_ARGS_MAX_CALL_CHARS` / `PI_TOOL_ARGS_MAX_TURN_CHARS`; invalid or inverted values log one warning and fall back to defaults (configuration never stops startup); `0` disables.
- **Removed:** `scripts/patch-pi-ai-toolstream.mjs`, its root `postinstall` entry (the b1-2b factory entry remains), `server/tests/unit/pi-ai/toolstream-parse-regression.test.ts`. No live file references them (historical records in `RECENT-CHANGES.md` 0.87.0 entry and the VOICE-HARNESS plan quotation preserved deliberately).
- **Docs:** `docs/OBSERVABILITY.md#run-budgets`, `docs/INTERNAL-API.md` (receipts), `docs/INTERNAL-API-CONTRACT.md` (1.48.0 changelog), `docs/RECENT-CHANGES.md`, `docs/ARCHITECTURE.md` (dangling style reference removed), `.env.example`.
- **New test infrastructure:** `server/tests/unit/pi-ai/pristine-harness.mts` + `tool-args-live-proof.mts` — build a disposable resolution root with pristine npm-published pi-ai in BOTH copies (root + nested under pi-coding-agent), boot the compiled server with the full validation isolation envelope (fake HOME, isolated agent dir, Agent OS interception, `buildValidationIsolationEnv`), and drive the incident pattern. The shared tree is only ever read; nothing is hard-linked over or patched.

## Commits

```
c1825e96 config: PI_TOOL_ARGS_MAX_CALL_CHARS / PI_TOOL_ARGS_MAX_TURN_CHARS (B3a)
828e611f pi: streaming tool-argument budget guard at the PiService subscribe funnel (B3a)
368634a0 internal-api: RUN_BUDGET_EXCEEDED terminal code + tool_args_budget_exceeded event (contract 1.48.0, B3a)
64e6a3ad b3a: remove the pi-ai toolstream patch — script, postinstall entry, guard test
ff7e3924 b3a gate: default caps 16,384/65,536 — live proof on pristine pi-ai decided the B2 lag gate
c1bba3cb tests: pin contract-version expectations to 1.48.0 (B3a bump)
```

Diff vs base: `git diff --stat 12d01198..HEAD` → 26 files changed, 2,244 insertions(+), 366 deletions(-).

## Cap defaults — correction 02 re-decides with PACED measurements

The design proposed 64 KB/call + 256 KB/run (patch parity, 0/5,633 observed false positives). The first gate (`01-answer.md`) made the default conditional on the unpaced fine-delta fixture and landed on 16,384/65,536. The parent's review (`02-correction.md`) under-specified rule corrected: the unpaced fixture is a lab worst case, the 16 KB cost is concrete (~1 in 600 real calls — big `write`s up to 36.9 KB — failing terminally), and pacing is what real generation does (collapse needs parse-time × delta-rate ≥ 1). Re-measured on pristine pi-ai with the same harness, fine deltas, all runs aborting at the cap with `RUN_BUDGET_EXCEEDED`, session B completing mid-run in 35–41 ms:

| run | caps | pace | abort wall | lag p99 max | readings ≥300 ms | two consecutive ≥300 |
|---|---|---|---|---|---|---|
| 1 | 65,536/262,144 | ~90/s (`--pace-delta-ms 11`) | 184.6 s | **4 ms** (185 samples) | 0 | no |
| 2 | 65,536/262,144 | ~300/s (`--pace-delta-ms 3`) | 52.0 s | **10 ms** (52 samples) | 0 | no |
| 3 (record) | 32,768/131,072 | unpaced | 6.6 s | 6,268 ms (1 sample; sampler starved) | 1 | n/a |

**Decision (frozen rule, `02-correction.md`): run 2 passes the B2 gate → default 65,536 / 262,144.** The unpaced lab worst case and the positive control were re-run and preserved under correction 03 (see below); the original unpaced readings were 8,305 ms (64 KB on) and 7,378 ms (control). Raw verdicts for the correction-02 runs: `/root/orch-ops/orchestration-scaling/b3a/measure/correction02-runs.json` (per-run full logs `b3a-corr-run{1,2,3}.log` alongside), run dirs `/tmp/b3a-live2` (disposable).

### Correction 02 — voice-live-lab failures at base

`tests/voice-live-lab/tier2-lean.test.ts` failed 2 tests inside the earlier parallel full-suite run. Checked per the correction: a disposable base worktree (`/tmp/b3a-base`, commit `12d01198`, node_modules symlinked, clean env) passes the file **47/47 (exit 0)** — and the same file also passes **47/47 at this lane's HEAD in an isolated clean run**. The failure was load-flakiness of the fidelity scoring inside the parallel suite, not the diff and not the base state; recorded here as requested.

## TDD receipts

| behaviour | RED | GREEN |
|---|---|---|
| config caps (bounds, disable, never-stop-startup) | `config.test.ts` — 7 failed (exit 1) | `Tests 27 passed (27)`, exit 0 |
| guard (breach per cap, reset, disable, emit-before-abort, malformed tolerance) | module missing — `Failed to load url .../tool-args-budget.js`, no tests ran | `Tests 12 passed (12)`, exit 0 |
| PiService wiring | closure reverted — `Tests 3 failed \| 1 passed (4)` | `Tests 4 passed (4)`, exit 0 |
| receipt terminal code | breach receipts completed as `completed` (masking), `RUN_BUDGET_EXCEEDED` absent — `5 failed` | `Tests 21 passed (21)` across the four internal-api files, exit 0 |
| default change 64K→16K | `Tests 3 failed \| 24 passed (27)` | `Tests 27 passed (27)`, exit 0 |
| correction-02 default flip 16K→64K | `config.test.ts` — `Tests 3 failed \| 24 passed (27)` (exit 1) | `Tests 27 passed (27)`, exit 0 |
| correction-03 abort-retry recovery | `tool-args-budget.test.ts` — `Tests 2 failed \| 12 passed (14)` (retry tests: latched guard never re-attempts) | `Tests 18 passed (18)` guard + wiring, exit 0 |
| correction-03 detached boundary | characterisation (shared path already routed the breach correctly) — `Tests 12 passed (12)` on first run; now pinned | — |

## Correction 03 (review findings, 2026-09-29)

All four findings accepted and fixed; commits this correction: see `complete.md`.

1. **[major] Positive control + 64 KB unpaced preserved.** Re-run at build HEAD on a fresh pristine scratch (`/tmp/b3a-live3`, markers 0/0, versions 0.87.1), each run written to its own never-overwritten files:
   - **cap-off positive control** (`measure/corr03-capoff.{json,log}`): unpaced fine deltas, caps disabled — the run streamed **98,307 bytes past the cap bound without aborting** (receipt `completed`; the tool call executed and the turn continued), session B completed in 38 ms mid-run; **lag p99 max 23,643 ms** (1 of 2 samples ≥300 ms — the sampler itself starved mid-pin). The stall class is reproduced from preserved raw evidence.
   - **64 KB/262 KB unpaced residual** (`measure/corr03-64k-unpaced.{json,log}`): abort at cap **21.7 s**, receipt `failed`/`RUN_BUDGET_EXCEEDED`, session B 45 ms; **lag p99 max 10,615 ms** (1 of 2 samples ≥300 ms), bounded by the abort.
   These are the figures cited in this bundle (superseding the overwritten first-round readings of 7,378/8,305 ms, which remain quoted as history in the correction-02 section only).
2. **[minor] Abort-failure recovery** — the guard no longer latches before abort succeeds: exactly one abort attempt is in flight at a time; a settled rejection leaves the run un-latched so the next delta retries (bounded at 3 attempts, then one error-level log and a terminal latch for the run). RED: 2 retry tests failed against the old latch; GREEN 18/18 guard+wiring. A merely slow abort never spawns duplicate attempts (exposed by the wiring tests' synchronous burst).
3. **[minor] Receipt hint accuracy** — the `RUN_BUDGET_EXCEEDED` hint now states the receipt persists only the code and directs parents to the session event stream (`tool_args_budget_exceeded` carries `data.scope`/`capChars`/`observedChars`, also in session diagnostics). No receipt fields added. Contract text checked: it makes no receipt-detail claim (no change needed).
4. **[minor] Evidence accuracy** — diff stat refreshed (see the line above; correction-05 final: 26 files, 2,244 insertions); the correction-02 RED receipt added to the TDD table above.

Also (review "also"): the **detached** boundary is now pinned by a route test — a `202 {detached:true, runId}` dispatch whose run breaches ends in a receipt `failed` with `RUN_BUDGET_EXCEEDED` through the shared `executePromptWithReceipt` path (`session-routes-tool-args-budget.test.ts`, 5 tests, all passing).

## Correction 05 (final round, review r2 ACCEPT-WITH-MINORS + parent, 2026-09-29)

1. **Evidence accuracy** — diff stat refreshed to the final-commit value (line above); the detached-test count corrected (the route file has 5 tests; the earlier “12/12” was a multi-file count stated wrongly).
2. **Stale figures** — OBSERVABILITY.md and the contract entry now cite the preserved correction-03 readings: cap-off p99 max **23,643 ms** (`measure/corr03-capoff.json`), 64 KB unpaced **10,615 ms** over a 21.7 s pre-abort window (`measure/corr03-64k-unpaced.json`), each from two A2 samples with one ≥300 ms (sampler-starvation caveat stated; readings are a floor).
3. **Receipt/diagnostics claims** — the guard's module docstring, the error-class docstring, OBSERVABILITY.md and the hint now say the receipt persists only the code; structured details are on the session event stream and the human-readable warning is in the log (`ToolArgsBudget` component). The “also in the session diagnostics” parenthetical is gone.
4. **Rejecting-race test strength** — the test now holds run 2's abort in flight when run 1's rejection settles, then feeds more deltas: pre-correction-04 code cleared run 2's in-flight flag and spawned a duplicate attempt (RED: `expected 3 to be 2`, shown by temporarily reverting the run capture; the resolving variant failed too, `expected 1 to be 2`); post-fix GREEN 16/16 guard file.
5. **Restore procedure made safe (parent finding)** — the old `rm -rf` + `cp -a` of the tarball's `package/` would have deleted both installed copies' nested `node_modules/` (their dependencies). Verified on this host: the only differing repo file vs the pristine extract is `dist/api/openai-completions.js`. The procedure above now backs up and replaces exactly that file in both copies, with marker-count, file-hash and `diff -rq` (apart from `node_modules`) verification and an explicit rollback.

## Gates (exact commands and exit codes)

Run from the worktree root unless noted. Full suites were run with a cleaned environment (`env -i HOME=/root PATH=… NODE_ENV=test`) after the first run showed ambient production env leaking in (skill §6 lesson: `OPENCODE_SERVER_PORT=4097`, `COMMAND_CODE_ALLOWED_CWD_ROOTS=/root`, `NODE_ENV=production` are exported in this shell's parentage and broke 5 unrelated tests).

- `npm run build` → exit 0 (fresh `server/dist`; the live proof ran from a copy of this build)
- `npm run lint` → exit 0 (0 errors; pre-existing warnings unchanged; my files lint-clean)
- `npm run typecheck` → exit 0
- `npm run docs:check-links` → exit 0 — `OK: 1262 internal link(s) resolve across 316 Markdown files.`
- `npm run docs:check-agent-guides` → exit 0 — `AGENTS.md and CLAUDE.md are byte-identical`
- Server workspace full suite (`cd server && env -i HOME=/root PATH="$PATH" NODE_ENV=test npx vitest run`) → **6,444 passed / 8 failed / 3 skipped** (exit 1). The 8 failures are **not this lane's**:
  - 5 × `tests/unit/pi/extension-factory-isolation.test.ts` + 1 × `tests/unit/pi/extension-factory-patch-regression.test.ts` — b1-2b's guard tests: the shared `node_modules` currently lacks the pi-coding-agent factory patch (their lane restores it at deploy). Proven independent of this diff: with base `12d01198` `config.ts` swapped in, the same 5 still fail. My diff does not touch their seam.
  - 2 × `tests/voice-live-lab/tier2-lean.test.ts` — voice lane, zero overlap with this diff (not base-verified; recorded honestly as unverified-at-base).
  - In the earlier dirty-env run, 5 further failures (`pi-max-sessions`, `command-code-contract`, `capabilities`, `opencode-service-expanded` ×3…) were environmental; each passes in the clean run (the two contract-pin failures were mine and are fixed in `c1bba3cb`).

## Live validation (disposable, pristine pi-ai — the frozen criterion)

- Harness: `npx tsx server/tests/unit/pi-ai/pristine-harness.mts build|serve|stop /tmp/b3a-live` — pristine root verified (`grep -c PARTIAL_ARGS_PARSE_INTERVAL_MS` → 0 and 0 on both copies; version 0.87.1 both).
- Driver: `systemd-run --scope --collect npx tsx server/tests/unit/pi-ai/tool-args-live-proof.mts --scratch /tmp/b3a-live --scenario both|cap-on …` (outside the production cgroup).
- Receipt evidence (cap-on, both 64 KB and 16 KB defaults): synchronous dispatch answers `500` `{code:"RUN_BUDGET_EXCEEDED", runId}`; `GET /runs/:runId` → `status:"failed"`, `errorCode:"RUN_BUDGET_EXCEEDED"`, `servedModel:"b3a-fixture/b3a-runaway"`.
- Second session keeps streaming: session B's prompt completed mid-runaway in 32–43 ms, receipt `completed`, in every run.
- Positive control (preserved under correction 03): caps disabled on pristine pi-ai, unpaced — the run streamed 98,307 bytes past the cap bound **without aborting** (receipt `completed`) and the lag instrument showed the stall class: **p99 max 23,643 ms** (1 of 2 samples ≥300 ms; sampler starved mid-pin). Raw evidence: `measure/corr03-capoff.json` + `corr03-capoff.log` (never overwritten). Scaling evidence: the Phase A pristine benchmark integrated one 460 KB fine-delta generation to **140,899 ms** of parse CPU (exit 0, `measure/bench-e.output.txt`).
- 64 KB/262 KB unpaced residual (preserved under correction 03): abort at cap 21.7 s, receipt `failed`/`RUN_BUDGET_EXCEEDED`, lag p99 max **10,615 ms** (bounded by the abort). Raw evidence: `measure/corr03-64k-unpaced.json` + `corr03-64k-unpaced.log`.
- Raw verdict + run log: `/root/orch-ops/orchestration-scaling/b3a/measure/live-verdict.json`, `live-proof-run.log`. Run dir `/tmp/b3a-live` (disposable; scratch only).

## Restore procedure (parent, at deploy) — SAFE form (parent finding, correction 05)

The original `01-design.md` §4 procedure (`rm -rf` each copy + `cp -a` the tarball's `package/`) is **unsafe and must not be used**: both installed pi-ai copies contain a nested `node_modules/` (their dependencies), which that procedure would delete. Verified on this host: `diff -rq` of the pristine 0.87.1 extract against an installed copy shows the ONLY differing repo file is `dist/api/openai-completions.js` — so the restore replaces exactly that one file, in BOTH physical copies, after a backup:

```bash
cd /tmp && rm -rf b3a-restore && mkdir b3a-restore && cd b3a-restore

# 1) Fetch pristine and pin it
npm pack @earendil-works/pi-ai@0.87.1
# → earendil-works-pi-ai-0.87.1.tgz ; sha256 must be:
#   35b4432f27cc2665f86beebb9af6a39b1251970883c3044bd8be4f4e8c731ca0
tar xzf earendil-works-pi-ai-0.87.1.tgz                     # → package/
grep -c PARTIAL_ARGS_PARSE_INTERVAL_MS package/dist/api/openai-completions.js   # expect 0
sha256sum package/dist/api/openai-completions.js
#   expect a2397cb3114a3d1a05993f6f19671ecbcc85540d8f8c59a233808c717df2682c

# 2) BACKUP the two current files OUTSIDE the repo (an install wipes node_modules;
#    never park backups inside the checkout)
BK=/var/tmp/pi-ai-restore-$(date +%Y%m%dT%H%M%S); mkdir -p "$BK"
cd /root/pi-web-ui
cp -a node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js "$BK/root-copy.js"
cp -a node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js "$BK/nested-copy.js"

# 3) Replace ONLY the adapter file, in both physical copies
cp /tmp/b3a-restore/package/dist/api/openai-completions.js \
   node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js
cp /tmp/b3a-restore/package/dist/api/openai-completions.js \
   node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js

# 4) Verify: marker gone, hash pristine, and the tree matches the extract apart
#    from the nested dependencies (any other line means ABORT and restore the backups)
grep -c PARTIAL_ARGS_PARSE_INTERVAL_MS \
  node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js \
  node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js
#   expect 0 and 0
sha256sum node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js \
          node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js
#   both must be a2397cb3114a3d1a05993f6f19671ecbcc85540d8f8c59a233808c717df2682c
diff -rq /tmp/b3a-restore/package node_modules/@earendil-works/pi-ai | grep -v 'Only in.*node_modules'
diff -rq /tmp/b3a-restore/package node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai | grep -v 'Only in.*node_modules'
#   expect NO output from either (only 'Only in …: node_modules' lines filtered)
```

Rollback if verification fails: copy `$BK/root-copy.js` / `$BK/nested-copy.js` back over the two files. The tarball hash is the primary pin; if the registry ever serves a re-packed tarball for the same version (hash mismatch), fall back to the extracted-file hash + marker absence in step 1 and say so in the deploy record. The b1-2b factory restore is a separate procedure (their lane); the shared tree currently still carries the pi-ai patch AND is missing the factory patch — the parent reconciles both restores together at deploy.

## Definition of victory (frozen) — item by item

- **TDD for breach detection, the terminal code in the receipt, and config bounds** — met (receipts above).
- **Disposable live proof on pristine pi-ai: fixture reproducing the 2026-09-12 pattern; turn aborts at the cap; receipt carries the code; a second session keeps streaming; lag vs B2 threshold measured with the fine-delta fixture; positive control shows the stall class** — met; the cap default was re-decided under correction 02 with paced measurements (**65,536/262,144**; table above). At that default: incident-paced p99 max 4 ms (185 samples), fast-provider-paced p99 max 10 ms (52 samples), zero readings ≥300 ms in either; the cap-off control re-run under correction 03 shows the stall class from preserved raw evidence (p99 max 23,643 ms, `measure/corr03-capoff.json`).
- **Patch script, postinstall entry and old guard test removed; nothing references them** — met (live-file sweep: no references; historical records preserved deliberately).
- **Gates per the common brief; evidence bundle committed** — met, with the pre-existing b1-2b/voice failures documented above (not this lane's; proven for the factory files).

## Not done, and why

- **Agent OS contract mirror** (`/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md`) — parent updates it at merge (gate decision 2); untouched.
- **Browser UI notice for the breach event** — gate decision 3: none now; the wire event exists (the review also noted browser rendering was untested — consistent with this deliberate deferral; the event rides the normal session-event handler).
- **The b1-2b factory guard failures and the load-flaky single failures in the full suites** — other lanes'/environmental; not repairable from this lane without touching excluded paths (and the factory patch itself, which the hard owner rule reserves to b1-2b).
- **Priming production or the shared tree** — forbidden; the parent runs the restore procedure.

## Residual risks

1. **Unpaced lab worst case at the 64 KB default** — an unpaced fine-delta local stream pins the loop for its whole pre-abort window (correction 03 preserved run: abort at cap 21.7 s, lag p99 max **10,615 ms**, `measure/corr03-64k-unpaced.json`; the abort itself is never at risk). Real generation paces itself; at ~90 and ~300 deltas/s the measured p99 max is 4–10 ms. An operator who prefers the tighter bound sets `PI_TOOL_ARGS_MAX_CALL_CHARS=16384` (then ~0.16% of measured real calls — 9/5,633, max observed 36.9 KB — fail terminally instead; that trade-off is what correction 02 weighed and declined as the default).
2. **Provider tool_stream rotation** (R1 §9 caveat): per-call accumulation may reset provider-side; the per-run total (262,144) bounds the aggregate; rotated small buffers parse cheaply, so no stall mechanism remains in that mode.
3. **Sampler starvation during a pinned loop** — the A2 sampler itself can be delayed while the loop is saturated (one sample in the unpaced windows); the lag ring (60 s) still recorded the worst deferral. Short breach windows are therefore measured as a floor, not an overestimate.
4. **Pre-abort CPU at the 64 KB default, unpaced worst case** ≈ 18 s in ≤2.25 ms slices — bounded and aborting; the unbounded mechanism (141 s measured at incident scale) is deleted.
5. The pristine harness builds a ~479 MB scratch under `/tmp` per root; disposable, never committed, cleaned by the operator or tmp reaping.
