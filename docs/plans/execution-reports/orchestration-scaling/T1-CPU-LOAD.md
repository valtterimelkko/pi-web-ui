# T1-CPU-LOAD — stepped CPU load test of the main thread (R3 input)

**Status:** complete (evidence-only lane; no product code changed; contract unchanged at 1.58.0).
**Lane:** `t1` · **Worktree:** execution worktree on branch `orch/t1` (base master `39908b8d`) · **Build commit for the live run:** `39908b8d` (worktree `npm run build` before the run; no source change before or after).
**Coordination:** the lane's hand-back directory holds `REPORT.md` (≤60 lines, the R3-facing summary), the harness (`harness/`), the raw samples (`raw/*.csv`) and per-run artefacts; run directories live outside the repository and are not committed. This file is the committed evidence bundle and deliberately contains no host paths, session ids or credentials.

## What was measured and why

The plan had no CPU measurement ("CPU input for R3"). Every in-process Pi child's streamed events, extension
loads on create/rehydrate and large tool outputs run on one main thread (one core). R3 must decide Stage D
(children out of process) with numbers, so this lane measured main-thread CPU, whole-process CPU, event-loop lag,
heap, admission refusals and host load at stepped concurrency (5/10/20/30 streaming children) on a disposable
server, plus one real-provider calibration step.

## Method

- **Server:** disposable compiled validation server from this worktree (`--compiled`), launched under a transient
  systemd scope with `-p CPUWeight=100 -p Nice=5` so it cannot starve production; `NODE_OPTIONS=--max-old-space-size=4096`
  (production heap cap parity); real deployed extension set as byte-identical copies in an isolated agent dir;
  isolated `HOME`, `PI_CODING_AGENT_DIR`, Agent OS stub + vault/board redirections, notifications disabled,
  watch-wake pointed at the disposable server's own socket; `SESSION_DIR` left to the repo's validation-env builder.
  Production was never a target and no production socket was contacted.
- **Sampler** (`harness/sampler.mjs`): every 5 s, main thread = utime+stime delta of `/proc/<pid>/task/<pid>/stat`
  (ticks→% of one core), whole process = sum over all threads, host CPU busy from `/proc/stat`, load from
  `/proc/loadavg`, lag/heap/activeTurns from `GET /api/v1/capacity`. Written to CSV; aggregated by
  `harness/analyze.mjs` (no hand reading).
- **Load** (`harness/driver.mjs`): event-driven slot pool through the `pi-orch` CLI (spawn → prompt → wait →
  cleanup). Each child runs one streaming-heavy turn: one real bash tool call producing 204,800 bytes (the tool's
  own cap reduces the tool result to ~51 KB, identical to the real runs) then ~5,200 chars of streamed text.
  Each step holds its target for 300 s, replacing children the moment a turn ends.
- **Load source (parent answer 01, corrections 02–04):** a local, zero-quota, OpenAI-compatible streaming mock
  (`harness/mock-provider.mjs`) registered **only** in the disposable agent dir (provider-level `baseUrl`/`api`/
  `apiKey`, auth credential type `api_key`), streaming ~40 deltas/s (~120 chars/s) after exactly one tool call per
  turn. No real provider credential exists in the mock run's agent dir at all.
- **Calibration step (real):** `zai/glm-5.3-flash` thinking low at target 5 (13/13 children completed: 3.0 tool
  calls, 5,233 chars, 44.7 s per child). Its credential was the only one copied for that run and was deleted after.

## Key numbers (full table in `REPORT.md` in the hand-back directory)

| target | activeTurns mean (max) | main CPU % mean/p95 | proc CPU % mean | lag p99 mean/max ms | heap MB mean | refusals |
|---|---|---|---|---|---|---|
| 0 | 0 (0) | 0.4 / 2.0 | 1.2 | 2.7 / 3 | 166 | 0 |
| 5 | 4.6 (5) | 16.6 / 49.6 | 22.6 | 64 / 185 | 214 | 0 |
| 10 | 8.8 (10) | 26.2 / 71.8 | 34.9 | 83 / 124 | 292 | 0 |
| 20 | 12.5 (15) | 43.0 / 85.8 | 59.1 | 109 / 141 | 469 | 85 |
| 30 | 13.5 (15) | 60.6 / 90.0 | 87.3 | 99 / 120 | 400 | 197 |

- Least squares over the five points: main-thread CPU ≈ **4.00 × concurrent turns − 2.11** on the mock instrument →
  100% of one core at **~26 concurrent turns, extrapolated** (never observed). Real-corrected by the measured 2.1×
  calibration factor: ~1.9%/turn → 100% at ~54 turns.
- At today's 15 API-turn admission cap the main thread sits at ~58% (mock) / ~28% (real-corrected); lag p99 never
  exceeded 185 ms (B2's 300 ms gate: 0 readings ≥300 ms); heap peaked 716 MB against the 4 GiB cap.
- Admission refused 85 dispatches at target 20 and 197 at 30 (429/503 `ADMISSION_CAPACITY_EXHAUSTED`); the server's
  own activeTurns never exceeded 15.
- Attribution: `pi.session.resource_loader` dominates (62 spans, 29.9 s total, ~480 ms per session create); stalls
  attribute to `pi.multi.create_session` blocked by it (8.1 s of 10.7 s); rehydrate negligible. Session-create/
  extension load, not streaming, is the largest attributed per-child main-thread cost.

## Calibration detail

Real zai @5: main-thread CPU mean 7.89% at activeTurns mean 4.41. Mock @5: 16.61% at activeTurns mean 4.58 → the
mock over-drives main-thread CPU **~2.1×** at equal concurrency and equal streamed volume. A real provider's
per-delta rate is not observable from session transcripts (they persist final messages, not deltas), so the mock's
delta rate was chosen and the measured ratio is reported as the calibration. Mock numbers are therefore a
conservative (pessimistic) upper bound; real saturation concurrency is ≥ the mock's extrapolated figure.

## TDD receipts

- `harness/sampler-lib.test.mjs` (5 tests): RED first — `node --test harness/sampler-lib.test.mjs` → exit 1
  (`ERR_MODULE_NOT_FOUND`, module not yet implemented); GREEN after implementing `harness/sampler-lib.mjs` → exit 0
  (5/5).
- `harness/mock-provider.test.mjs` (3 tests): implementation and test written together; positive control by mutation
  — tool name mutated `bash`→`bashx` → `node --test` exit 1 (test caught it); restored → exit 0 (3/3).

## Gates (worktree at the evidence commit)

Recorded in the completion block of the hand-back directory; commands: `npm run lint`, `npm run typecheck`,
`npm run build`, `npm run docs:check-links`, `npm run docs:check-agent-guides`, and the full server unit suite
(`cd server && env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u CLAUDE_WATCH_WAKE_ARMED
NODE_ENV=test npx vitest run tests/unit`). The lane changed no product code; gates are run on the unmodified tree
plus this evidence file.

## Definition of victory (brief, frozen) — item by item

1. Disposable compiled server, realistic isolation, `systemd-run` with `CPUWeight=100` + `Nice=5`, production never
   a target — **met** (server stopped and verified gone after the run).
2. Stepped load 5/10/20/30 concurrent streaming children, ≥5 min per step, pi-orch spawn/prompt/wait, route recorded
   per step and asserted by script — **met with the parent-approved load-source change** (answer 01): mock for all
   steps, one real zai target-5 calibration step. Concurrency 20/30 capped at the 15 API-turn admission limit
   (85 + 197 refusals recorded as a result, not a failure). Served model asserted from the server's own run
   receipts: 1,120/1,120 `mock/mock-stream`; calibration run 13/13 `zai/glm-5.3-flash`.
3. Per-step measurement by script every 5 s (main-thread CPU, process CPU, lag p99, heap, refusals, host load and
   host CPU busy; `LoopAttribution` captured from the server log) — **met**; raw CSV committed to the hand-back
   directory (repo stays free of run artefacts).
4. `REPORT.md` ≤60 lines with the per-step table, the extrapolated saturation paragraph (labelled), contributors and
   an R3 recommendation; raw samples kept as CSV; evidence doc committed in the worktree without host paths, session
   ids or credentials — **met** (53 lines).
5. Hygiene: credential copies deleted, server stopped, `pi-orch cleanup` for the driver's children, heavy commands
   niced, long steps run in the background with result files, `complete.md` with `FROZEN` last — **met**.

## Not done, and why

- **Agent OS contract mirror:** no change (no wire-visible change; contract stays 1.58.0).
- **Real-provider curve above concurrency ~5:** zai/glm-5.3-flash returns empty completions above ~5–8 sustained
  concurrent children (144-child probe: 48/144 produced any tool call; at target 5, 13/13 worked), and the approved
  DeepSeek route was ~12% on its monthly quota, so the parent redirected the curve to the calibrated mock. The only
  real-corrected numbers are the target-5 ratio applied uniformly.
- **Per-delta rate of the real provider:** not measurable from transcripts (see Calibration detail).

## Blind spots (R2 rule — what this evidence does NOT see)

1. **Mock fidelity:** text deltas only — no thinking/reasoning deltas, no tool-argument streaming, 1 tool call per
   child vs the real calibration's 3.0. The 2.1× factor was measured at one concurrency (target 5) and applied
   linearly; the real curve's shape at 10–15 concurrent children is unmeasured.
2. **Admission-capped steps:** at targets 20/30 the server refuses at 15 API turns, so the measured points above
   ~13 average turns do not exist; everything beyond is the labelled linear extrapolation.
3. **Harness wake-loop artifact:** the driver registers its `agent_end` watch ~0.2 s after prompting; the watch-wake
   extension then delivers an immediate settled-fire wake loop into the session (~2 s cadence of extra dispatches)
   until the driver deletes it — 865 of 1,120 runs cancelled, most from this loop. Streaming children are unaffected
   (activeTurns is the server's own count), but a minority of the measured dispatch CPU is this artifact, and the
   loop itself looks like a real defect in the owner's pattern (a watch registered before the first turn starts
   appears to fire immediately) — reported for triage, not fixed here (no product code may change in this lane).
4. **Host contention:** host CPU busy was 8–21% during the mock run (quiet) but 63% during the real zai calibration
   window; the calibration ratio is measured across different host-load conditions.
5. **Single run:** one stepped run per instrument; no repeat runs, so step-to-run variance is unquantified (the
   20→30 step rose 43→61% for +1.0 average turns, so per-step means carry meaningful variance).

## Residual risks

- If the real provider's delta rate is far from the calibrated one at high concurrency, the real-corrected
  saturation point moves; the qualitative conclusion (main thread not saturated at today's 15-turn cap; lag and
  heap comfortable) is robust because it holds even on the pessimistic mock instrument.
- The watch-wake wake-loop finding is untrienaged; if confirmed, watch registration timing matters for any parent
  that waits on a freshly-prompted child.
