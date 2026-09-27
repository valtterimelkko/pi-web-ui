# A1 — 24-hour heap soak: run result and R1 analysis

> **Run:** `full-1790411484255-ec8b813c`, started 2026-09-26 08:31 UTC from master `4159e68d`.
> **Run directory (preserved):** `/root/.pi-web-ui/validation/heap-soak/full-1790411484255-ec8b813c/`; the retainer analysis is in its `analysis/` subdirectory.
> **Analysed by:** Claude Code session `38c5e91e-6849-4f04-8b6b-301eb79468ab` on 2026-09-27, holding R1 with the owner.
> **Harness build evidence:** [`A1-harness.md`](./A1-harness.md).
> **Status:** complete with deviations. The verdict is accepted at R1; A1 is not `shipped` against its definition of victory (see §5).

## 1. What happened

The soak server did not run for 24 hours. After **5 h 03 min** it reached its 4 GiB V8 heap cap and exited:

```
journalctl -u pi-web-ui-soak-server-full-1790411484255-ec8b813c
13:34:40  Mark-Compact 4076.4 (4108.7) -> 4063.8 (4130.4) MB ... allocation failure
13:34:40  FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
13:39:59  Main process exited, code=exited, status=1/FAILURE
```

The supervisor did not notice. It kept cycling against the dead socket for another 19 h (`ECONNREFUSED`, and every sample failing with a CDP `collectGarbage` timeout). At the window's end it wrote `report.md` and sent the Telegram message `✅ Done: [soak] run … complete — verdict=leak trailingSlope=513.93MB/h peakHeap=4044MB`, neither of which mentions the crash.

## 2. Key numbers

| Measure | Value |
| --- | --- |
| Post-GC heap | 146 MB → 4,044 MB in 5 h 03 min |
| Slope (overall / wave / idle) | 514 / 529 / 482 MB/h (declared leak rule: > 10 MB/h) |
| Idle return to baseline | never: each idle stretch stays at its new high |
| Event-loop lag proxy | mean 0.5 ms, p95 1 ms, max 3 ms |
| Sample coverage | 150 / 721 (20.8%); no gaps while the server was alive |
| Children | 916 created, 917 delete attempts; lane A 289 successes, lane B 8 |
| Admission refusals | 574 lane A + 36 lane B `ADMISSION_CAPACITY_EXHAUSTED` (`memory_pressure`) from 08:52 UTC (minute 21) |
| Retained per child created | about 4.4 MB |
| Snapshots | 0 ms (100 MB file), 1 GiB threshold (297 MB), 2 GiB threshold (477 MB), 12 h (**0 bytes**, server already dead) |

## 3. What retains memory

**Method.** The report's constructor diff failed on the empty 12 h snapshot. The analysis instead used the start and the two threshold snapshots, with two scripts in `analysis/`:
- `retainers.mjs`: builds reverse edges, does a breadth-first search from the root skipping weak edges, and prints the shortest retainer chain per instance of a constructor.
- `cut2.mjs`: repeats the search with chosen objects treated as cut, reporting the reachable bytes and instances that remain.

**Constructor diff (0 ms → 2 GiB).**
- Strings grew by 1.87 GB.
- `AgentSession` went from 7 to 469, with `ExtensionRunner`, `DefaultResourceLoader`, `DeadlineManager`, `ShellTaskManager` and `SettingsManager` growing the same way.
- `code` objects went from 281k to 811k.
- Children created by each snapshot: 208 at the 1 GiB snapshot (208 `AgentSession` retained) and 468 at the 2 GiB one (469 retained). **Every child created stays in memory after deletion.**
- The largest strings are 208 per-session copies of the ~270 KB `<skills>` prompt.

**Retainer 1: `PiService.sessions`.**
- In `server/src/pi/multi-session-manager.ts`, `disposeSession` and `unloadSession` call `removeEventHandler` but not `piService.releaseSessionRefs`. Only `stopSession` calls it.
- Internal API DELETE goes `disposeLoadedSession` → `disposeSession` (`routes/sessions.ts`, `routes/batch-helpers.ts`), and idle browser cleanup uses `unloadSession`.
- Commit `91effe69` (2026-09-05, "unload/dispose clears every PiService-owned map") wired only `stopSession`, and its wiring test covered only that path.

**Retainer 2: the `subagent` extension's exit listener.**
- `~/.pi/agent/extensions/subagent/index.ts:148` registers `process.once("exit", …)` at module scope. The source is in the `pi-enhancement` store; the soak's copy is byte-identical to production.
- Extension modules are evaluated once per session, so every session adds a listener whose closure reaches `backgroundStatusCtx` → the session context → the `AgentSession`.
- No other extension under `~/.pi/agent/extensions` has a module-level `process.on` or `process.once`.

**Sufficiency test (1 GiB snapshot).**

| Cut | `AgentSession` reachable | Reachable heap |
| --- | --- | --- |
| none | 208 | 1,166 MB |
| `PiService.sessions` only | 208 (202 via `process._events.exit`) | 1,166 MB |
| both | 6 (the live sessions in `MultiSessionManager.sessions`) | 242 MB |

Each retainer alone is enough to keep every deleted child alive; together they account for about 80% of the heap. Cutting `process._events` also cuts unrelated listeners, so this is a slight over-cut. The remainder (242 MB against about 200 MB at start) is small but not yet explained. The B1 confirmation soak decides whether a third retainer exists.

**Production relevance (inferred, not measured).** Production runs the same dispose paths and the same extension. This is the likely cause of the §2 baseline "heap grows with uptime, median 1,505 MB at 0 resident sessions", which the roughly three restarts per day have hidden.

## 4. Admission and control findings (for B2)

- **Admission ignores the heap.** It refused prompts on cgroup `memory_pressure` because the soak unit had `MemoryMax=6G`. With production's 18 GiB cgroup it would not have refused anything before the 4 GiB heap OOM, which confirms the B2 rationale directly.
- **Cleanup refused under pressure.** At the critical floor, `wrapControl` returned `503 CONTROL_CRITICAL` to DELETE requests. Once B1 lands, deletes are what free memory.
- **Ineffective refusals.** Refusing prompts did not stop the growth, because the leak happens on create and dispose, not on prompt.

## 5. Definition of victory, item by item

| Item | Result |
| --- | --- |
| Gate 0 and Gate 1 re-run by the review session | met before launch ([`A1-harness.md`](./A1-harness.md) §11) |
| 24 h run, ≥95% sample coverage | **not met**: 20.8%, because the server died at 5 h 03 min |
| Load really happened, every cycle | partly: cycles ran with tool calls until minute 21; afterwards cgroup admission refused most prompts while creates continued |
| `report.md` states slope, idle return, peak, lag, verdict against the pre-declared rule | met, but the report does not say that the server died (a "not victory" condition) |
| Snapshot comparison names growing constructors | the harness failed (empty 12 h snapshot); done manually here, with retainer paths |
| No production state changed; soak units stopped; run dir preserved | units stopped (only the empty slice remains) and the run dir is preserved; production checksums not re-verified at R1 |
| No synthetic data in Agent OS | the audit's seven "LEAK DETECTED" hits match the run ID in operator sessions and Agent OS captures that discuss the run. One was checked: an ordinary production GLM session. Most likely all false positives; not fully verified. Board check clean. |

## 6. Harness defects found (fix before the B1 confirmation soak)

1. The supervisor does not detect server death. It should end the run, mark it `server_died` with the time, and say so in `report.md` and in the Telegram message.
2. The snapshot comparison crashes on an empty snapshot. It should fall back to the latest valid one (the threshold snapshots) and add a retainer-path and cut summary in the style of `analysis/`.
3. `sampler.ts` fills `residentSessionCount` and `registryEntryCount` from the same session-list length. The server also listed 1,702 sessions at t=0 on a disposable server, which is unexplained.
4. The soak unit's `MemoryMax=6G` differs from production's 18 GiB, so cgroup admission throttled the load from minute 21.
5. The production-write audit greps for the run ID, which false-positives on anything that discusses the run. It should look for writes by soak processes, or a marker that only soak children emit.

## 7. Not done and residual risks

- No code was changed; the analysis was read-only.
- Production checksums were not re-verified.
- The remaining ~20% of growth is unexplained until the confirmation soak.
- Production impact is inferred from shared code; A2 telemetry or a post-fix production observation would measure it.
