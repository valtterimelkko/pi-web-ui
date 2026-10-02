# Hb3 — Streaming-path telemetry, and the Pi `DELETE` cost (plan H3 items 2 and 5)

> **Worktree:** `/root/.worktrees/orch-scaling/hb3-pi-web-ui` (branch `orch/hb3`, from master `6a70238d`).
> **Commits:** `a23f6120` (streaming telemetry: module + hooks + A2 field + docs; the only source commit — the tree at hand-back is exactly this commit, build `a23f612073be`).
> **Live runs:** disposable servers only; run dirs under `/root/hb3-runs/` (harness `harness/`); production untouched (`git -C /root/pi-web-ui status` clean / `master` — recorded in `complete.md` when the lane closes).
> **Status:** streaming telemetry (criterion 1+2) complete; `DELETE` cost reproduced and attributed (criterion 3 first half) with the fix upstream → `01-question.md` per the brief's own path. Not signed off — the parent and an independent reviewer verify.

## 1. Streaming telemetry (H3 item 2) — shipped

What shipped (all in owned paths): `server/src/observability/streaming-telemetry.ts` (bounded window
aggregation), additive `HealthReadings.streaming` field + sampler-only source (`health-readings.ts`,
`health-telemetry.ts`), receipt hook in the pi event funnel (`pi-service.ts`), delivery hooks at
`handleAgentEvent`'s fan-out (`multi-session-manager.ts`) and the single-client `EventForwarder` send
(`event-forwarder.ts`) — hooks only, one call site each; knob `OBSERVABILITY_STREAMING_TELEMETRY`
(`.env.example`, `docs/OBSERVABILITY.md` § "Streaming-path telemetry (Hb3)").

Design (recorded): per reading window the metrics line carries
`streaming: { windowMs, spans {count, p50Ms, p99Ms, maxMs}, providerGap {count, maxMs, provider}, providers {<p>: {chunks, bytes, chunksPerSec}}, providersTruncated }`.
- **Span** = provider chunk receipt (pi funnel entry) → transport dispatch (all transports the pi path feeds:
  browser envelope + Internal API observers, or the single-client send). Bounded nearest-rank percentiles over
  a 512-sample ring; count exact. This is the per-chunk delivery cost G2's LoopAttribution could not see.
- **Per-provider chunk rate** from `text_delta` / `thinking_delta` / `toolcall_delta` receipts (provider from
  the partial message; ≤ 8 providers per window, top-chunks kept, `providersTruncated` flags the fold).
- **Provider gap** = largest interval between consecutive chunk receipts inside one open message stream
  (reset on `message_start` / `message_end` / `agent_start`, so tool gaps between messages never count).
- Cost: O(1) map/counter work per delta, no logging; percentiles computed once per window-take; hooks are one
  boolean check when disabled. The window-consuming source is registered on the A2 sampler ONLY —
  `getHealthReadings()` (B2 admission) never sees or drains windows.
- Metrics FILE only (additive); no Internal API wire change, no contract bump, Agent OS mirror unchanged.

### Unit tests (strict TDD)

`server/tests/unit/observability/streaming-telemetry.test.ts` — 16 tests: disabled no-op, span
close/abandon semantics, nearest-rank percentiles, ring bound (exact count, bounded samples), per-provider
rate from injected clock, unknown-provider fold, provider cap + truncation flag, mid-stream gap, no gap
across message boundary, gap reset on `message_start` (aborted stream), window take/reset, non-chunk and
non-delta events ignored, tracked-session LRU bound, additive sampler-only reading field, env knob resolution.

- RED (module absent): `cd server && env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test npx vitest run tests/unit/observability/streaming-telemetry.test.ts`
  → **exit 1** — `Failed to load url ../../../src/observability/streaming-telemetry.js … Does the file exist?` (1 file failed, no tests).
- GREEN (same command, after implementation): **exit 0 — 16 passed**; whole observability dir 129/129;
  observability+pi suites 732 passed | 1 skipped (the skip is pre-existing).

### Live proof (disposable servers; `OBSERVABILITY_METRICS_INTERVAL_MS=2000`)

Harness: `/root/hb3-runs/harness/` (T1/G2-shaped: byte-identical deployed extension copies, real skills
corpus, isolated agent dir, fake HOME, Agent OS stub, notifications off, `MemoryMax=12G` + `MemorySwapMax=1G`
units, `NODE_ENV=development`, admission lag gate raised to 5000 ms — G4's documented compensation, because
boot-warmup lag latched the default 300 ms gate on the first boot). Mock: `hb3-mock-provider.mjs` (T1's
calibrated shape + one-shot mid-stream pause + large-delta knob). Run dirs preserved; **credential copies
(`auth.json`, `models.json`) deleted from every run dir after the runs**; no heap snapshots created; every
unit stopped and verified (`stop-server.sh`: pid + process group gone).

| arm | run | load | streaming fields observed (from `health-metrics.jsonl`) |
|---|---|---|---|
| o (on, plain) | `on-mock-02` | 800 deltas @ 40/s, no subscribers | spans p99 ≤ 3 ms, max 3 ms; gapMax 123 ms; 800 chunks counted |
| **p (provider pause)** | `on-mock-02` | same + 8 s mid-stream pause | **gapMax 8029 ms** (the pause), spans stay 1 ms; the pause windows read `chunks: 0` (silence), CPU 1–4 % → **provider attribution** |
| **g (server-side stall)** | `on-mock-06` | 100 × 6 KB deltas @ 40/s + 15 CDP-forced full GCs | **lagP99 752 ms** (vs 2 ms in arm p), **main-thread CPU mean 46.3 %** (vs 8.2 %), bursty gapMax 163 ms, spans 2 ms → **server attribution** (gap + lag + CPU jointly; the documented reading guide) |
| s (fan-out, healthy) | `on-mock-02` / `on-mock-06` | 40 / 150 WS subscribers, small / 6 KB deltas | spans ≤ 3 ms — healthy fan-out is cheap; no stall claimed |
| r (real GLM) | `on-real-01` | one real turn, `zai/glm-5.3-flash`, thinking low | receipt asserts served model `zai/glm-5.3-flash`; **159 zai chunks**, max **40.5 chunks/s** (G2 measured ~45/s), spans p50 0 / p99 2 ms, and one **real 2287 ms provider gap** mid-stream (thinking pause) |
| overhead off | `off-mock-01` | identical arm-o load, `OBSERVABILITY_STREAMING_TELEMETRY=off` | steady-window main-thread CPU mean **4.94 %** vs **5.00 %** on (max 6.0 vs 9.5, single-reading noise); driver wall 20.74 s vs 20.77 s; both boots' lag p99 dominated by their own pre-stream boot-warmup sample (188 / 353 ms — present before any streaming, ages out of the 60 s ring at 02:22:58 → 7 ms) |

Row size bound: with `streaming` present, metrics rows measured ≤ **805 bytes** (proof runs, 2 s interval).

Blind spots (per the plan §4 rule):
1. **Span ends at dispatch, not at the socket write.** Frames queued by the WebSocket outbound governor under
   backpressure are counted at hand-off; the later write is the WebSocket lane's path (Hb1) and is observable
   through the existing queued-frame counters. A stall living entirely inside the governor queue shows in
   lag/queued counters, not in `spans`.
2. **A blocked main thread delays receipts too** — a pure receipt-side gap cannot by itself distinguish
   provider pause from server block; the reading guide (gap + spans + lag + CPU jointly) is the attribution,
   and arm g demonstrates exactly that joint signature.
3. **Lag ring (60 s) crosses arms** — boot-warmup samples appear in early arm windows (noted per row above);
   steady-state rows are quoted for the overhead comparison.
4. Windows are per-sampler-interval (2 s in the proof, 30 s default in production): a pause shorter than the
   window still shows via `chunks` dropping in its window; a pause spanning windows lands in the resumption
   window's `providerGap`.

## 2. `DELETE /api/v1/sessions/:id` cost (H3 item 5) — reproduced and attributed; fix proposed upstream

Instrument: `run-delete-boot.sh` + `hb3-delete-driver.mjs` (G4's sequential create+delete over the disposable
unix socket, real extension set as byte-identical copies). Temporary per-step instrumentation of
`handleDeleteSession` and `emitSessionShutdown` was applied **uncommitted**, rebuilt, measured, and reverted
(tree verified back at `a23f6120`, build re-run, suites re-run — receipts below).

| run | tree | delete wall |
|---|---|---|
| `del-01` (baseline, committed build a23f6120) | master-shape + Lane A | **median 1006 ms** (min 1004.3, max 1015.9, mean 1007; n=10, every op 200) — G4's ~1005 ms reproduced |
| `del-02/03` (temp attribution build) | + uncommitted timing | median 1007/1008 ms (same shape) |
| `del-04` (control: **empty extensions dir**) | — | **median 5 ms** (min 3.4, max 12.7; n=6) |
| `del-05` (**fix preview**: the proposed upstream patch applied to run-dir extension copies ONLY) | full real extension set | **median 5 ms** (min 3.8, max 14.3; n=8) |

Attribution chain (every step timed, per delete, n=16 across two runs):
- `handleDeleteSession` steps: every await except one measures 0–1 ms (`findCommandCode`, `registryEntry`,
  `cancelReceipts`, `abort`, `watchDelete`, `pinExpiryClear`, `unpin`, `deleteFiles`, `registryDelete`).
- `disposeLoadedSession` = 1001–1004 ms → inside it, `emitSessionShutdown`'s
  **`session_shutdown` emission settles in 1000–1002 ms** (reason=quit) — logged per delete.
- That emission awaits the two background-task managers' quit handlers, and **each blocks exactly 500 ms with
  zero owned tasks**:
  - `/root/.pi/agent/extensions/background-shell/core.ts:628` — `shutdownAll` awaits
    `setTimeout(min(_timeoutMs, 500))` unconditionally (called from `background-shell/index.ts:471`);
  - `/root/.pi/agent/extensions/subagent/background.ts:676` — the same unconditional wait
    (called from `subagent/index.ts:1270`).
  500 + 500 = the measured 1000–1002 ms; no other handler contributes measurably.
- Both files are byte-identical between the production agent dir and the run copies (`cmp`), so the
  attribution transfers.

The fix (conditional wait — skip only when there is nothing to settle) sits **outside this lane's owned
paths** (`~/.pi/agent` extensions / pi-enhancement), so per the brief it is proposed in
[`01-question.md`](/root/orch-ops/orchestration-scaling/hb3/01-question.md) with the disposable proof above
(fix preview: 1006 ms → 5 ms, n=8, full extension set).

Teardown safety asserted on the fix-preview boot: after 8 create+delete cycles, `server/pi-sessions/` has
**0** leftover files and `session-registry.json` has **0** entries (same for the baseline boot) — agents
disposed, backing files released. The proposed patch adds an early return **only** for `owned.length === 0`,
so the 500 ms grace is preserved by construction whenever tasks exist; the question file proposes the
upstream RED test that pins this.

## 3. Gates (final tree = commit `a23f6120`, build `a23f612073be`)

| Command | Exit | Evidence |
|---|---|---|
| `npm run lint` | 0 | 0 errors (305 pre-existing warnings, none new) |
| `npm run lint:ratchet` | 0 | `"violations": []` |
| `npm run typecheck` | 0 | clean (shared, server, client, internal-api-mcp) |
| `npm run build` | 0 | all workspaces; embedded manifest revision `a23f612073be…` |
| observability + pi unit suites | 0 | 51 files, 732 passed, 1 skipped (pre-existing skip) |
| full server unit suite (`systemd-run --scope CPUQuota=400% MemoryMax=6G`, guarded env) | 0 | **512 files, 6227 passed, 3 skipped** (one earlier attempt under the same caps was SIGKILL'd, exit 137, with no test failure reported; the immediate re-run passed — recorded for honesty) |
| `npm run docs:check-links` | 0 | 1339 links across 350 files |
| `npm run docs:check-agent-guides` | 0 | byte-identical |
| `npm run docs:check-status` | 0 | 29 Voice Mode docs (no Voice Mode doc touched) |

## 4. Not done / open

- The `DELETE` fix itself: upstream, pending the parent's decision (`01-question.md`).
- `complete.md` is written only after the parent answers and the lane closes.
- Production checks (terminal shell placement etc.) are other lanes' items; nothing here touched production.
