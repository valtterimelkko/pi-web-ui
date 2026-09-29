# B3b — per-run output-token and streamed-byte budgets (the rest of B3)

**Status:** implemented, gated, live-proven on pristine pi-ai. Correction 01 applied (defaults re-derived on the guard's real run boundary; live proof's second session streams throughout with justified pacing). Awaiting independent review and parent sign-off.
**Lane:** `b3b` · **Worktree:** `/root/.worktrees/orch-scaling/b3b-pi-web-ui` · **Branch:** `orch/b3b` (base master `08276a86`)
**Contract:** **1.50.0** · **Build commit for the live run:** `b016bbd9` worktree build (rebuilt after the last server-source change)

## What shipped

Beside B3a's tool-argument cap, every in-process Pi session (Internal API, browser, hosted, extension-pool — the single `PiService.createSession` `session.subscribe` funnel) now enforces two more per-run budgets against runaway generation:

- **Output tokens per run** — `server/src/pi/run-budget.ts` (`RunBudgetGuard`) sums the public `usage.output` each assistant message reports at `message_end`, `agent_start` → `agent_end`.
- **Streamed bytes per run** — the same guard counts UTF-8 bytes of every streamed `text_delta` + `thinking_delta` + `toolcall_delta` (allocation-free `TextEncoder.encodeInto` counting, O(delta)).

**Runtime reporting caveat (measured, stated):** pi-ai reports usage only in the final streaming chunk, i.e. **at message end** (`openai-completions.js`: `output.usage` is set only when a chunk carries `usage`; with `include_usage: true` that is the final chunk). So the output-token cap trips at message boundaries and the streamed-byte cap is the LIVE mid-stream bound within a message — the "combine with the byte cap" arrangement the brief anticipated. Providers without usage reporting (37 of 73,843 measured assistant messages, 0.05%) never trip the token cap; the byte cap still bounds them.

**On breach:** one synthetic `run_budget_exceeded` event through the same funnel (`data: { budget: "output_tokens" | "streamed_bytes", cap, observed }`), then the public `AgentSession.abort()` with the bounded single-in-flight retry pattern B3a's corrections 03–05 pinned (max 3 attempts; rejection → retry on the next delta; slow abort → no duplicates; run state captured so a queued follow-up run is never touched). The Internal API Pi dispatch path turns the event into `PiRunBudgetExceededError`; `runtimeErrorCode` maps it to the SAME `RUN_BUDGET_EXCEEDED` terminal receipt code as B3a (receipt persists only the code — which budget tripped lives on the event stream). B3a's `tool_args_budget_exceeded` event gains an additive `data.budget: "tool_args"` so all three budgets share one discriminator (its 1.48.0 fields are unchanged).

**Config (`server/src/config.ts`):** `PI_RUN_BUDGET_MAX_OUTPUT_TOKENS` (default `1000000` after correction 01; first round 500,000), `PI_RUN_BUDGET_MAX_STREAMED_BYTES` (default `16777216` = 16 MiB). Same never-stop-startup contract as B3a: unset/blank → default; `0` disables that dimension; invalid or out-of-range values log one warning and fall back (bounds: tokens [1,000, 10,000,000]; bytes [65,536, 1,073,741,824] — the byte floor sits below the measured realistic max so tighter operator experiments stay configurable). `parseToolArgsCap` now delegates to the shared `parseRunBudgetCap` (identical semantics and bounds).

## Defaults — measured rule (read-only scan of real sessions)

Corpus: `~/.pi/agent/sessions`, 732 JSONL files (0 parse failures), grouped into runs by user-message boundaries — **3,352 runs**, 73,843 assistant messages. Measured per run (script `/tmp/b3b-measure/session-budget-measure.mjs`, disposable; only aggregates reported, no session content copied anywhere):

| metric | p50 | p90 | p99 | p99.9 | max | measured breaches at the default |
|---|---|---|---|---|---|---|
| output tokens / run (n=3,279) | 5,981 | 45,953 | 130,100 | 204,869 | 267,569 | **0 / 3,279** (>500,000) — superseded by correction 01's boundary-corrected measurement below |
| streamed bytes / run (n=3,286) | 20,823 | 164,160 | 465,659 | 736,295 | 999,449 | **0 / 3,286** (>16 MiB) |

**Rule (B3a-style):** defaults must not fail realistic long turns — 0 measured false positives — with margin above the observed maximum (tokens ~1.9×, bytes ~16×). A runaway grows without bound, so a cap above every observed run still bounds it.

## Commits

```
72cdb970 config: PI_RUN_BUDGET_MAX_OUTPUT_TOKENS / PI_RUN_BUDGET_MAX_STREAMED_BYTES (B3b)
af82c2bb pi: per-run output-token and streamed-byte budget guard (B3b)
7632b90c pi: wire RunBudgetGuard into the PiService subscribe funnel (B3b)
0e6b5b30 internal-api: run_budget_exceeded event + RUN_BUDGET_EXCEEDED for per-run budgets (contract 1.50.0, B3b)
216d779d docs: contract 1.50.0 run-budget docs — changelog, observability, receipts, env example (B3b)
098f9869 tests: B3b live-proof driver — runaway text-generation fixture (bytes/tokens/cap-off scenarios)
9e4da5e6 tests: track streamed bytes continuously in the B3b live-proof fixture record
b016bbd9 docs: RunBudget log lines appear only on abort-retry failure, not per breach (B3b evidence accuracy)
```

Diff vs base: `git diff --stat 08276a86..HEAD` → **21 files changed, 1,747 insertions(+), 32 deletions(-)**.

## TDD receipts

| behaviour | RED | GREEN |
|---|---|---|
| config knobs (defaults, bounds, 0-disable, warn+fallback, singleton fields) | `config.test.ts` — `Tests 8 failed \| 27 passed (35)` (exit 1) | `Tests 35 passed (35)`, exit 0 |
| guard (bytes across 3 delta kinds, UTF-8 byte counting, tokens at message_end, malformed tolerance, reset, once-per-run, 0-disable, emit-before-abort, bounded abort retry, slow-abort no-duplicates) | module missing — `Failed to load url .../run-budget.js`, no tests ran | `Tests 17 passed (17)`, exit 0 |
| PiService wiring (every event through the guard, synthetic dispatch, handler-swap race, fresh guard per session) | `Tests 4 failed \| 1 passed (5)` (exit 1) | 4 guard files together: `Tests 42 passed (42)`, exit 0 |
| internal-api receipt mapping (sync 500 + receipt failed RUN_BUDGET_EXCEEDED for both budgets; no false positive; detached 202 path; SSE/registry consistency) | `Tests 4 failed \| 1 passed (5)` (exit 1) | both budget route files: `Tests 10 passed (10)`, exit 0 |
| contract pins 1.48.0 → 1.50.0 | (pins edited with the bump commit) | capabilities + command-code contract: `Tests 14 passed (14)`, exit 0 |
| additive `data.budget: "tool_args"` | assertion added with the field | B3a files re-run: `Tests 25 passed (25)`, exit 0 |

## Gates (exact commands and exit codes, at final commit `b016bbd9`)

Run from the worktree root; the full suite with a cleaned environment (`env -i HOME=/root PATH="$PATH" NODE_ENV=test`) because this shell inherits `NODE_ENV=production` (skill §6 lesson; B3a hit the same).

- `npm run lint` → **exit 0** (0 errors; pre-existing warnings unchanged; none in my files)
- `npm run typecheck` → **exit 0**
- `npm run build` → **exit 0**
- `npm run docs:check-links` → **exit 0** — `OK: 1266 internal link(s) resolve across 318 Markdown files.`
- `npm run docs:check-agent-guides` → **exit 0** — `AGENTS.md and CLAUDE.md are byte-identical`
- Full server unit suite (`cd server && env -i HOME=/root PATH="$PATH" NODE_ENV=test npx vitest run tests/unit`) → **exit 0 — Test Files 466 passed (466); Tests 5,530 passed | 3 skipped (5,533)**. Zero failures; the load-flaky files B3a documented (extension-factory isolation, voice-live-lab) all pass here.

## Live validation (disposable, pristine pi-ai)

- Harness: `npx tsx server/tests/unit/pi-ai/pristine-harness.mts build /tmp/b3b-live --fixture-port 46920` → exit 0 (pristine 0.87.1 verified in both resolution copies by the harness's own `assertPristinePiAi`; shared tree only ever read).
- Driver (under `systemd-run --scope --collect`, outside the production cgroup):
  `systemd-run --scope --collect npx tsx server/tests/unit/pi-ai/run-budget-live-proof.mts --scratch /tmp/b3b-live --scenario all` → **exit 0**. Run dir `/tmp/b3b-live` (disposable). Raw verdict + run log preserved: `/root/orch-ops/orchestration-scaling/b3b/measure/live-verdict.json` + `live-proof-run.log` (never overwritten).
- Build: worktree `npm run build` at `b016bbd9` immediately before the run; the harness copies `server/dist` into the scratch.

| scenario | server env | result |
|---|---|---|
| **bytes** (default budgets, paced 4 KiB / 3 ms ≈ 1.4 MB/s) | defaults | A: `500` `RUN_BUDGET_EXCEEDED`, wall 14.1 s; receipt `failed` / `RUN_BUDGET_EXCEEDED`; fixture streamed **16,797,696 bytes** (cap 16,777,216 + in-flight deltas) then the connection was destroyed. Session B completed **mid-run in 44 ms**, receipt `completed`. **A2 lag p99 max 24 ms over 14 samples, 0 readings ≥300 ms, no two consecutive ≥300** — B2's proposed threshold met with margin. |
| **tokens** (`PI_RUN_BUDGET_MAX_OUTPUT_TOKENS=2000`) | token cap 2,000 | A: `500` `RUN_BUDGET_EXCEEDED`, wall 214 ms; receipt `failed` / `RUN_BUDGET_EXCEEDED`. Fixture streamed 65,536 bytes (far under the byte default) and finished cleanly; the final usage chunk reported 50,000 output tokens → breach at `message_end`. Session B completed in 26 ms. |
| **cap-off** (positive control) | both knobs `0` | Same volumes that abort cap-on: fixture streamed **17,825,792 bytes** (17 MiB target, past the 16 MiB default) and finished with a 600,000-output-token usage chunk — **A: `200`, receipt `completed`, no error code**. Proves the budgets (not the fixture or the server) terminate cap-on runs. Lag p99 max 9 ms over 15 samples. |

- Servers stopped: **yes** — the driver's `finally` stops each server (log: `server group 2647158 stopped`, twice per scenario, idempotent); verified after the run: no process for the stale pid, no socket file, `pgrep` finds no `b3b-live`/pristine-harness processes.
- The parent sees the terminal state without polling: the synchronous dispatch answers `500` with `code: "RUN_BUDGET_EXCEEDED"` and the `runId`; detached dispatches surface it through the receipt (`GET /runs/:runId` → `status:"failed"`, `errorCode:"RUN_BUDGET_EXCEEDED"`) and the `run_budget_exceeded` event on the session stream (watch-observable).

## Definition of victory (plan §6 B3, the B3-open items) — item by item

- **Per-run output-token cap from public usage/message events; runtime reports tokens only at message end → stated and combined with the byte cap** — met (caveat measured in the adapter and stated in contract/observability docs; live tokens scenario proves the message_end path).
- **Per-run streamed-byte cap over all streamed assistant output (text + thinking + tool arguments)** — met (live bytes scenario aborts at 16 MiB across a text-only stream; the guard's unit tests pin the three-delta aggregation).
- **Which budget tripped is distinguishable in the event detail (`budget: "output_tokens" | "streamed_bytes" | "tool_args"`) without breaking B3a's contract** — met (`run_budget_exceeded.data.budget`; additive `data.budget: "tool_args"` on the unchanged 1.48.0 event; receipt keeps persisting only the code).
- **Defaults derived from real data, rule recorded, must not fail realistic long turns** — met (0/3,279 and 0/3,286 measured breaches; table above).
- **Env-configurable; `0` disables; invalid values warn and fall back** — met (config TDD receipts).
- **Disposable live proof reproducing the 2026-09-12 pattern (very long generation with streamed output): abort at cap, receipt carries the code, second session keeps streaming, A2 lag under 300 ms during a paced run, cap-off positive control** — met (table above).
- **Parent sees the terminal state through receipt/watch without polling** — met (500+runId sync; receipt + stream event otherwise).
- **Contract bump and docs; tests; gates green; evidence bundle committed** — met (contract 1.50.0; INTERNAL-API-CONTRACT.md changelog, INTERNAL-API.md receipts, OBSERVABILITY.md §Run budgets, `.env.example`, RECENT-CHANGES.md; gates above; this bundle).

## Not done, and why

- **Agent OS contract mirror** (`/root/agent-os/…/PI-WEB-UI-INTERNAL-API-CONTRACT.md`) — parent updates it at merge per the common brief. Mirror needs: version **1.50.0**; new SSE event `run_budget_exceeded` (`data: { budget: "output_tokens" | "streamed_bytes", cap, observed }`); `RUN_BUDGET_EXCEEDED` widened to three budgets; additive `data.budget: "tool_args"` on `tool_args_budget_exceeded`; env knobs `PI_RUN_BUDGET_MAX_OUTPUT_TOKENS` (1,000,000) / `PI_RUN_BUDGET_MAX_STREAMED_BYTES` (16 MiB).
- **Unpaced upstream-quadratic tool-argument residual** — explicitly out of scope (brief; R2 item).
- **Browser UI rendering of the breach event** — none, mirroring B3a's deliberate deferral; the wire event rides the normal session-event stream.
- No production contact of any kind; no restart; no push (lane branch stays local per owner rule).

## Residual risks

1. **Output-token cap granularity** — tokens are only known at message end, so a single enormous message is bounded LIVE only by the byte cap; the token cap bounds cross-message accumulation (and still fires before a multi-message runaway continues). This is inherent to the runtime's reporting and is documented, not fixable from pi-web-ui without private APIs.
2. **Providers without usage reporting** (0.05% of measured messages) never trip the token cap; the byte cap remains the bound.
3. **Bytes ≠ tokens scaling** — the byte default (16 MiB) is ~16× the observed max, the token default (1,000,000) ~3.7×. An operator wanting the tighter measured envelope sets the env knobs; `0` disables each independently.
4. **Concurrent guard aborts** — if a stream tripped BOTH B3a's tool-args cap and a B3b cap, both guards would emit their own synthetic event and call `abort()`; each guard keeps its own single-in-flight discipline and `AgentSession.abort()` is idempotent, so the effect is a duplicate reason event, not a duplicated abort loop. Not observed in any run (caps differ by orders of magnitude).
5. **A2 sampler starvation** — as in B3a, lag readings during a pinned loop are a floor; here the paced runs never approached the threshold (p99 max 24 ms), so the margin is wide.
6. **Out-of-lane discovery (correction 01, reported to the parent):** in one live-proof run, a cap-off dispatch whose assistant message accumulated 17.8 MB terminalised its receipt (`agentEndAt`/`terminalAt` written) but its synchronous HTTP response never arrived — pi's `prompt()` settlement (or a later await in the dispatch chain) did not complete within the 300 s client timeout, on an otherwise idle, healthy server (no errors, flat 8 ms lag). Not reproduced when cap-off was re-run alone. Evidence: `/root/orch-ops/orchestration-scaling/b3b/measure/live-proof-run.log` (first correction-01 attempt) + `/tmp/b3b-live/state/run-receipts/d3c831e1-*.json` (terminal receipt, hung response). The dispatch/response path is outside this lane's owned seam; the parent may want a follow-up look.

## Correction 01 (parent adjudication of Luna review r1, 2026-09-29 — FINAL round)

Both findings accepted and fixed. Commits this correction: `3be64b7a` (config default + pin), `2c840181`/`d2301347` + two follow-ups (live-proof driver v2), `aacb54e2` (docs).

### [major] Defaults re-measured on the guard's real boundary

pi-agent-core's loop consumes queued follow-ups/steers INSIDE one run (one `agent_start`; verified in `agent-loop.js` `getFollowUpMessages → pendingMessages → continue`), and `RunBudgetGuard` accumulates across them. The session JSONL (`SessionMessageEntry`) carries no queued-vs-fresh marker, so the conservative merge the correction prescribed was used:

- **Merge rule:** consecutive user-message segments whose gap (next user ts − previous assistant ts) is <2 s are one run. **Threshold justified from the data itself:** the gap distribution is strongly bimodal — 921 gaps <2 s (loop-consumed follow-ups) vs 491 in [2 s, 30 s) and 1,223 ≥30 s (fresh prompts); p50 6.9 s, p90 ~33 min.
- **Merged distributions (2 s, the guard boundary approximation):** 3,273 runs — output tokens p50 6,056, p99 130,100, p99.9 204,869, **max 267,569**; streamed bytes p50 21,015, p99 465,659, p99.9 736,295, **max 999,449**. Luna's hypothetical 535k sum does not occur: the two largest real segments are never adjacent within the gap.
- **Worst case (30 s merge):** 2,115 runs — max **270,689 tokens** / **1,050,331 bytes**. Sensitivity at 5 s: max 267,569 / 999,449 (unchanged).
- **Defaults decision (same rule: margin over the merged max, never below 2×):**
  - Output tokens: **500,000 → 1,000,000** (the 2× rule invalidated 500,000: 2 × 270,689 = 541,378). 1,000,000 = 3.7× the merged max — deliberately loose so the message-end token cap can never abort a legitimate long agentic loop; the byte cap is the live volume bound.
  - Streamed bytes: **16 MiB unchanged** (15.3× the merged max; ≥2× rule satisfied).
  - Measured breaches at the new defaults: **0/3,273** (tokens) and **0/3,280** (bytes) merged runs.
- **Tests:** config default expectations updated (RED `Tests 3 failed | 50 passed` → GREEN `53 passed`); new characterisation pin `accumulation spans a queued follow-up consumed within one run` (guard accumulates across a user message with no intervening `agent_start`; control proves `agent_start` resets) — passes against the existing behaviour by design (a pin, not a fix); full suite re-run green.
- TDD receipts: RED `cd server && NODE_ENV=test npx vitest run tests/unit/config.test.ts tests/unit/pi/run-budget.test.ts` → `Tests 3 failed | 50 passed (53)` exit 1; GREEN same command → `Tests 53 passed (53)` exit 0.

### [minor] Live proof: B streams throughout; pacing justified

Driver v2 (`run-budget-live-proof.mts`):

- **Session B now streams for the whole runaway window:** every request after the first is a paced 64 B/66 ms stream (~970 B/s ≈ the measured p99 real rate of 1,014 B/s) that holds until session A's run has resolved (+500 ms grace, 100 s safety cap; A's own 120 s prompt timeout bounds any wedge). The verdict records `timeline.bSpannedARun` and `bHeldUntilAResolved` — in the canonical run all three cap-on scenarios show **true/true** (B streamed 16.5 s / 10.6 s / 3.6 s across A's windows and completed normally after A's abort).
- **Pacing justified against measured rates:** the correction's suggested source — the session corpus — yields per-run streamed bytes/second (includes tool time): p50 148, p90 446, p99 1,014, p99.9 4,551, max 6,583 B/s (`b3b/measure/measurement-v2.json`). The stress run's 4 KiB/3 ms ≈ 1,367,000 B/s is ~300× the p99.9 real rate (a deliberate stress bound). The NEW **bytes-realistic** scenario streams 64 B/3 ms ≈ 333 chunks/s ≈ 21,000 B/s — B3a's measured ~300 deltas/s provider pace, ~3× the most intense real run — with the byte cap lowered to 128 KiB, and **aborts at the cap at realistic pacing** (6.7 s, receipt `failed`/`RUN_BUDGET_EXCEEDED`, lag p99 max **31 ms**, 0 ≥300).
- **Canonical correction-01 run** (`systemd-run --scope --collect npx tsx server/tests/unit/pi-ai/run-budget-live-proof.mts --scratch /tmp/b3b-live --scenario all` → exit 0; raw evidence `b3b/measure/live-verdict-correction01.json` + `live-proof-run-correction01.log`; servers stopped and verified):

| scenario | abort | receipt | B stream | lag p99 max (samples) | ≥300 ms |
|---|---|---|---|---|---|
| bytes (defaults, stress) | at 16 MiB cap (16,801,792 B streamed) | `failed`/`RUN_BUDGET_EXCEEDED` | 16.5 s, held until A resolved, completed after | **245 ms** (19) | **0** |
| bytes-realistic (~333 chunks/s, 128 KiB cap) | at cap, realistic pacing (131,328 B) | `failed`/`RUN_BUDGET_EXCEEDED` | 10.6 s, held, completed after | **31 ms** (13) | **0** |
| tokens (token cap 2,000) | at `message_end` (50,000 reported) | `failed`/`RUN_BUDGET_EXCEEDED` | 3.6 s, held, completed after | 9 ms (6) | 0 |
| cap-off (control, knobs 0) | none — 17,825,792 B completed | `completed` | 100 s (hit the 100 s hold cap; A drifted to 115 s) | 481 ms (35) | 35 (see below) |

- **Lag note (measured, causal isolation):** during streaming the server's lag is flat and low in EVERY scenario (8–31 ms). At the END of a run whose accumulated assistant message reached 16.7–17.8 MB there is ONE ~250–670 ms stall (varies run to run), which the 60 s p99 ring replays across subsequent 1 s samples. The cap-off control — **guard disabled** — shows the same stall (481–674 ms), proving it is the upstream finalisation/persist of a giant message, not the budget mechanism; at the realistic-scale 131 KB message there is no stall at all. The B2-gate criterion (<300 ms during the paced run) is met by both cap-on byte scenarios in the canonical run (245 ms and 31 ms, zero ≥300 readings, no two consecutive); the stall class and its variance are recorded as a residual.
- The first correction-01 attempt additionally surfaced the out-of-lane dispatch-settling discovery recorded under Residual risks 6; the harness was hardened against it (bounded hold, 120 s prompt timeout) and cap-off re-ran clean standalone.
