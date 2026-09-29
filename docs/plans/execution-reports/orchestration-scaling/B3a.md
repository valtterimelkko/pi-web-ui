# B3a — per-run budgets on streamed tool-call arguments (patch replaced, pi-ai pristine)

**Status:** complete, awaiting independent review and parent sign-off.
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

Diff vs base: `git diff --stat 12d01198..HEAD` → 25 files changed, 1,853 insertions(+), 366 deletions(-).

## Cap defaults — decided by measurement, per the parent's rule

The design proposed 64 KB/call + 256 KB/run (patch parity, 0/5,633 observed false positives). The parent's `01-answer.md` made the default conditional on the B2 lag gate measured with the fine-delta fixture on pristine pi-ai. Measured outcome:

| run (unpaced fine-delta fixture, ~4 B/delta, local) | cap | abort | wall | lag p99 max (A2 instrument) |
|---|---|---|---|---|
| cap-on | 64 KB/256 KB | at cap, `RUN_BUDGET_EXCEEDED` | 21.9 s | **8,305 ms — BREACH** |
| cap-on | 16 KB/64 KB | at cap, `RUN_BUDGET_EXCEEDED` | 2.3 s | **93 ms — pass** |
| cap-off (positive control) | disabled | no abort (streamed past the bound) | ~47 s | **7,378 ms — stall class shown** |

Incident-rate paced run (~90 deltas/s, the 12 September profile), 16 KB default: abort at cap after 46.3 s, **lag p99 max 3 ms across 47 samples, zero over 300 ms**; session B completed in 42 ms mid-runaway. Per the parent's rule the defaults are **16,384 / 65,536**, both numbers reported.

Accepted trade-off (recorded in docs): ~0.16% of measured real tool calls (9/5,633; largest observed argument 36.9 KB — a big `write`) would breach the 16 KB default; raising `PI_TOOL_ARGS_MAX_CALL_CHARS` is the remedy, no code change.

## TDD receipts

| behaviour | RED | GREEN |
|---|---|---|
| config caps (bounds, disable, never-stop-startup) | `config.test.ts` — 7 failed (exit 1) | `Tests 27 passed (27)`, exit 0 |
| guard (breach per cap, reset, disable, emit-before-abort, malformed tolerance) | module missing — `Failed to load url .../tool-args-budget.js`, no tests ran | `Tests 12 passed (12)`, exit 0 |
| PiService wiring | closure reverted — `Tests 3 failed \| 1 passed (4)` | `Tests 4 passed (4)`, exit 0 |
| receipt terminal code | breach receipts completed as `completed` (masking), `RUN_BUDGET_EXCEEDED` absent — `5 failed` | `Tests 21 passed (21)` across the four internal-api files, exit 0 |
| default change 64K→16K | `Tests 3 failed \| 24 passed (27)` | `Tests 27 passed (27)`, exit 0 |

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
- Positive control: caps disabled on pristine pi-ai — the run streamed past the cap bound without aborting and the lag instrument showed the stall class (p99 7,378 ms). Scaling evidence: the Phase A pristine benchmark integrated one 460 KB fine-delta generation to **140,899 ms** of parse CPU (exit 0, `measure/bench-e.output.txt`).
- Raw verdict + run log: `/root/orch-ops/orchestration-scaling/b3a/measure/live-verdict.json`, `live-proof-run.log`. Run dir `/tmp/b3a-live` (disposable; scratch only).

## Restore procedure (parent, at deploy)

Accepted as written in `01-design.md` §4: `npm pack @earendil-works/pi-ai@0.87.1` (tarball sha256 `35b4432f27cc2665f86beebb9af6a39b1251970883c3044bd8be4f4e8c731ca0`), verify marker absent + file hashes, replace BOTH physical copies in the main checkout, post-checks. Note for the deploy window: the shared tree currently still carries the patch AND is missing the b1-2b factory patch (parallel-lane rehearsal state); the parent reconciles both lanes' restores together.

## Definition of victory (frozen) — item by item

- **TDD for breach detection, the terminal code in the receipt, and config bounds** — met (receipts above).
- **Disposable live proof on pristine pi-ai: fixture reproducing the 2026-09-12 pattern; turn aborts at the cap; receipt carries the code; a second session keeps streaming; lag under the B2 threshold; positive control shows the stall class** — met, with the parent's amendment applied: at the 64 KB parity default the fine-delta fixture BREACHED the lag gate, so per the `01-answer.md` rule the default is 16,384/65,536 and both measured. At the shipped default: unpaced p99 93 ms (abort ~2.3 s), incident-paced p99 max 3 ms (47 samples, zero over 300 ms); the cap-off control showed p99 7,378 ms.
- **Patch script, postinstall entry and old guard test removed; nothing references them** — met (live-file sweep: no references; historical records preserved deliberately).
- **Gates per the common brief; evidence bundle committed** — met, with the pre-existing b1-2b/voice failures documented above (not this lane's; proven for the factory files).

## Not done, and why

- **Agent OS contract mirror** (`/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md`) — parent updates it at merge (gate decision 2); untouched.
- **Browser UI notice for the breach event** — gate decision 3: none now; the wire event exists.
- **The 5+1 b1-2b factory guard failures and 2 voice tier-2 failures in the full suite** — other lanes'/environmental; not repairable from this lane without touching excluded paths (and the factory patch itself, which the hard owner rule reserves to b1-2b).
- **Priming production or the shared tree** — forbidden; the parent runs the restore procedure.

## Residual risks

1. **False positives at 16 KB** — ~0.16% of measured real calls (9/5,633; max observed 36.9 KB). A breached turn fails terminally; remediation is `PI_TOOL_ARGS_MAX_CALL_CHARS` (bounds 1 KB–1 MB, `0` disables). If production telemetry shows legit breaches, raising the env is one line, no deploy of code.
2. **Provider tool_stream rotation** (R1 §9 caveat): per-call accumulation may reset provider-side; the per-run total (65,536) bounds the aggregate; rotated small buffers parse cheaply, so no stall mechanism remains in that mode.
3. **Sampler starvation during a pinned loop** — the A2 sampler itself can be delayed while the loop is saturated (one sample in the 64 KB window); the lag ring (60 s) still recorded the worst deferral. Short breach windows are therefore measured as a floor, not an overestimate.
4. **Pre-abort CPU at the 16 KB default, unpaced worst case** ≈ 1.3 s in ≤0.72 ms slices — bounded and aborting; the unbounded mechanism (141 s measured at incident scale) is deleted.
5. The pristine harness builds a 479 MB scratch under `/tmp` per root; disposable, never committed, cleaned by the operator or tmp reaping.
