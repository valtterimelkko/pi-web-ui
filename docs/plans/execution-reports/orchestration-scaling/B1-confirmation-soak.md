# B1 confirmation soak — evaluation (2026-09-28)

> Parent evaluation for R2 input. Run `full-1790523945117-ea387201`, 2026-09-27 15:45:54 → 2026-09-28 15:45:54 UTC, B0 harness, B1 build plus the `pi-enhancement` subagent overlay (`/root/pi-enhancement/subagent`). Run directory: `/root/.pi-web-ui/validation/heap-soak/full-1790523945117-ea387201/` (`report.md`, `samples.csv`, `events.jsonl`, `snapshots/`). Evaluated by the parent in session "Int API Program 2" (`d5db9012-…`); proposed plan changes in §6 are held for the owner review and are not yet applied to the plan.

## 1. Verdict

**B1's confirmation-soak criteria are met.** The heap is flat on the fixed build. Two small residuals are named in §4. Neither pins deleted children.

| Criterion (plan B1) | Result | Evidence |
|---|---|---|
| Run completes with the server alive | **met** | Soak unit journal: one start (2026-09-27 15:45:45), no OOM or fatal line, still running at window end; stopped afterwards with `cli.ts stop`. `terminalState: complete`. |
| Post-GC slope under 10 MB/h | **met** — trailing 12 h 0.31 MB/h, overall −0.32 MB/h | `report.md`; hourly minimum post-GC heap 143 → 195 MB in the first four hours (warm-up), then 195 → 200 MB over the remaining 20 h. Manual post-GC reading after the window: 200.5 MB. |
| Idle stretches return to baseline | **met after warm-up** | `report.md` marks the first eight idle stretches (first ~2 h) "NO" while the floor was still rising through warm-up. After that, every stretch but four in hours 3.7–4.5 returns to the ~193–200 MB floor. |
| No deleted child retained | **met (one bounded slot)** | End snapshot: `AgentSession` 1, `SessionManager` 1 (start 7/7, 12 h 1/1). The one instance is the subagent extension's module-level `backgroundStatusCtx` (last-context slot, `~/.pi/agent/extensions/subagent/index.ts:93`): bounded at one, not growth. |
| Soak on a build carrying both fixes | **met (behavioural)** | The A1 build reached 1 GiB in ~20 min under the same profile; this build held ~200 MB for 24 h with 8,092 children. |

## 2. Against A1

| | A1 (pre-fix) | Confirmation soak |
|---|---|---|
| Server | V8 OOM at 5 h 03 min | Alive for 24 h |
| Post-GC heap | 146 → 4,044 MB | 143 → 200 MB, flat after ~4 h |
| Children created | 916 | 8,092 (lane A 7,499; lane B 593) |
| Failures from admission refusal / dead socket | 1,216 | 0 |
| Event-loop lag (proxy) max | — | 130 ms (mean 1.2 ms) |
| Sample coverage | 20.8% | 99.3% (716/721, largest gap 1.1 intervals) |

## 3. Load actually delivered

The zai quota guard shaped the run: normal 864 min, throttled 121 min, paused 454 min. So about 16.4 h ran under GLM load and about 7.6 h were quota-paused idle, with slopes fitted separately per state (normal 0.46, throttled 0.32, paused 0.12 MB/h). The best-effort free lane B mostly failed ("no tool_execution_start event observed", 555 events); per the owner's design it does not gate the verdict.

## 4. Residual growth (the "third retainer" question)

Between the 12 h and end snapshots, total self size grew 216.0 → 217.9 MB (≈ 0.16 MB/h). The growing types are file-watcher state for deleted child sessions:

- `Timeout` 36 → 539 → 881, `Date` 13 → 672 → 920, `Stats` 6 → 242 → 350, `FSWatcher` 7 → 226 → 310, plus ~5,600 run-directory path strings.
- Retainer paths: `SessionWatcher.debounceTimers` and chokidar's `awaitWriteFinish` `_pendingWrites`.
- **Code cause for the first (by reading, not yet test-proven):** `server/src/pi/session-watcher.ts` `handleChange('unlink')` calls `clearTimeout` on a pending debounce timer but never `debounceTimers.delete(filePath)`. A file added and unlinked inside the debounce window leaves a dead `Timeout` in the map for ever. Chokidar's `_pendingWrites` entries for files unlinked before they stabilise look like the same pattern inside the library.

This is small and linear with churn, far below any threshold, but it is unbounded. It is the same class as E1's "claims every path, wires one".

## 5. Harness defects found (B0 follow-ups)

1. **End snapshot never fires.** `snapshotOffsetsMs` places the last snapshot at exactly `totalMs`, but the sampler loop exits on `isRunComplete` (`elapsed >= totalMs`) first. Only the 0 h and 12 h snapshots were taken, and `report.md` compared those. The parent took the end snapshot by hand after the window (`snapshots/snapshot-end-manual.heapsnapshot`, via the inspector, before stopping the server).
2. **The server unit outlives a completed run** until `cli.ts stop` is run. Documented in the README, but a completed run should tear down, or the Telegram completion message should say the server is still up.
3. **Orphan sweep races live children.** All 167 lane-A `SESSION_NOT_FOUND` failures had a tool call seen, then `orphan_swept`, then the driver's own delete or poll. The harness counts its own sweep as a child failure. That is harness accounting, not a server fault.
4. RSS rose ~940 → ~1,160 MB at hour 12 and stayed. This coincides with the 12 h snapshot. Heap was unaffected. This is noted, not investigated.

## 6. Proposed plan changes (for owner review — not yet applied)

1. **B1 → shipped** on this evidence. Record the bounded `backgroundStatusCtx` slot as accepted.
2. **New small item (or B1.1): SessionWatcher unlink cleanup.** TDD: add→unlink inside the debounce window leaves `debounceTimers` empty. Assess chokidar `awaitWriteFinish` retention for unlinked files.
3. **B0.1 widened:** stale-`dist` guard (already open) + end-snapshot scheduling + teardown or clear messaging at completion + sweep-race accounting.
4. **R2 heap-cap input:** the fixed build's steady floor under this load is ~200 MB post-GC, with a peak of 242 MB. The 4 GiB cap is not binding for this profile. The evidence points to "neither" (keep the cap and `PI_MAX_SESSIONS`) unless B2's heap gate needs headroom for a different profile.
5. **Production lag is a different problem from heap (new evidence, A2 telemetry since the 2026-09-27 17:39 restart).** Production heap is healthy (hourly minimum sampled heap 88 → ~146 MB over 22 h, not forced-GC; peak 515 MB). But production event-loop lag p99 reached 671–849 ms in several hours (maxima up to 919 ms), often with **zero** active API turns. The soak never exceeded 130 ms, so its load profile does not reproduce the production lag source. Before B2 sets `event_loop_lag` thresholds, and before B3, attribute production lag spikes (browser session opens, registry scans, replay — see the session-load performance findings). Otherwise lag-aware admission would refuse API work because of unrelated browser activity.
6. **E2's final re-measure** should use a load profile with a browser-like replay/open component, so lag regressions are visible, not only heap.
