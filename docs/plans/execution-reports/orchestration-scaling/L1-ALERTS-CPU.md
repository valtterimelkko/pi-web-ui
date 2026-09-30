# L1 — Incident-grouped health alerts and CPU telemetry

> **Worktree / branch:** `/root/.worktrees/orch-scaling/l1-pi-web-ui` on `orch/l1` (from master `b64e1f0b`).
> **Commits:** `f29c8e00` (grouping + CPU implementation and tests), `cf8d5adc` (docs), `8ff0fdb9` (strict consecutive-high debounce; L1 live driver; grouping-aware A2 driver), `3f09196c` (A2 driver production-state fix).
> **Build commit (live runs):** `npm run build` (exit 0, `build-03.txt`) ran on the working tree that became `8ff0fdb9`; no `server/src` change after it, so the disposable servers ran `server/dist` of `8ff0fdb9`.
> **Contract:** **no change** — `INTERNAL_API_CONTRACT_VERSION` and `docs/INTERNAL-API*` untouched; the C6 stability window (1.58.x) stays closed. Telemetry is a host file, not an Internal API field.
> **Status:** complete against the brief's frozen definition of victory; **not signed off** — an independent reviewer and the parent verify.

## 1. What shipped

| File | Role |
| --- | --- |
| `server/src/observability/health-alerts.ts` | `HealthIncidentConfig` + validation, `HealthIncidentSummary`, and `HealthIncidentGrouper`: folds the hysteresis evaluator's raw transitions into one alert message per incident and one recovered message, with quiet period, cooldown and consecutive-high debounce, per kind and independent. The latches themselves are unchanged. |
| `server/src/observability/health-readings.ts` | CPU fields in every reading (`cpuPercentOfCore`, `mainThreadCpuPercentOfCore`, `mainThreadCpuSource`), `CpuUsageTracker` (injected-clock process/main-thread deltas, defensive copies, one-decimal rounding), and `readMainThreadCpuTicks()` reading Linux `/proc/self/task/<pid>/stat`, fail-open. |
| `server/src/observability/health-telemetry-config.ts` | `resolveHealthIncidentConfig`: `OBSERVABILITY_HEALTH_ALERT_QUIET_PERIOD_MS` (600000), `..._COOLDOWN_MS` (1800000), `..._DEBOUNCE_READINGS` (2); out-of-range values fall back to the default with a warning like the sampling/rotation knobs. |
| `server/src/observability/health-telemetry.ts` | Owns one `CpuUsageTracker` and one `HealthIncidentGrouper`; every raw transition is still journaled, only the grouped notifications reach the sink. |
| `server/tests/unit/observability/*` | 19 new tests: replay, quiet period, cooldown/reopen, debounce, independence, CPU tracker/reader, config bounds, telemetry integration. |
| `server/tests/fixtures/observability/l1-today-lag-sequence.json` | Byte-identical copy of the parent's `l1/today-sequence.json` (sha256 `8a6cdc34…e914c35` in both), so the replay test is hermetic. |
| `server/tests/integration/health-incident-live-proof.mjs` | New disposable-server live driver (CPU fields, multi-crossing folding, cooldown silence, isolation). |
| `server/tests/integration/health-telemetry-live-proof.mjs` | A2 driver made grouping-aware (quiet-period wait, incident summary, current production-state check). |
| `docs/OBSERVABILITY.md`, `.env.example` | CPU fields, incident-grouping semantics, grouped journal lines, three knobs. |

Grouping semantics as implemented (also documented in `docs/OBSERVABILITY.md`):

- an incident opens after `OBSERVABILITY_HEALTH_ALERT_DEBOUNCE_READINGS` **consecutive** readings at or above the high water mark; a reading below the high mark breaks the run, and the pending window (start, peak, crossing count) survives a dead-band reading until a genuine recovery, so a briefly interrupted excursion is summarised whole;
- while open, every further raw `alert` crossing is counted, not delivered;
- it closes only after the metric sits at or below the recovery threshold for the whole quiet period; the recovered message carries start, end, duration, peak and folded crossings;
- after a close, the cooldown suppresses the next alert message; an incident that reopens inside it is silent and its recovered message says so;
- heap and lag keep independent incidents; state is in memory and a restart starts grouping fresh (documented).

## 2. Strict TDD

RED was taken before any implementation existed, on the lane's baseline tree with only the new tests:

```
$ cd server && env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test \
    npx vitest run tests/unit/observability/health-alerts.test.ts tests/unit/observability/health-readings.test.ts tests/unit/observability/health-telemetry.test.ts
→ exit 1 — "Test Files 3 failed (3)"; "Tests 19 failed | 33 passed (52)"
   HealthIncidentGrouper is not a constructor; CpuUsageTracker is not a constructor;
   readMainThreadCpuTicks is not a function; config has no `incident`
```

Full receipt: `/root/orch-ops/orchestration-scaling/l1/red-01.txt`.

GREEN after implementation, re-run after the last code change (`8ff0fdb9`):

```
$ … same command
→ exit 0 — "Test Files 3 passed (3)"; "Tests 52 passed (52)"
```

Receipt: `/root/orch-ops/orchestration-scaling/l1/green-02-final.txt`. The whole observability directory (including the pre-existing suites that guard the touched files) is also green: `npx vitest run tests/unit/observability` → exit 0, 11 files, **103 passed** (`green-01-observability.txt`).

| Behaviour | Test (in `health-alerts.test.ts` unless noted) | RED | GREEN |
| --- | --- | --- | --- |
| Replay of the real 2026-09-30 sequence: exactly one alert + one recovered, peak 12064 ms, 6 crossings, 29m 29s | `replays the real 2026-09-30 incident…` | exit 1 | exit 0 — 52/52 |
| Quiet period: dead-band resets the clock; close only at ≥ quiet period | `closes only after the metric stayed at or below recovery…` | exit 1 | exit 0 |
| Cooldown: silent reopen, recovered message says so, alert again after cooldown | `suppresses a new alert inside the cooldown…` | exit 1 | exit 0 |
| Debounce: single spike no page; dead band breaks the run but keeps the window | `debounces a single spike…` | exit 1 | exit 0 |
| Heap/lag independence | `groups heap and lag independently…` | exit 1 | exit 0 |
| Config cannot fail to group | `rejects a grouping configuration that cannot group` | exit 1 | exit 0 |
| CPU deltas from injected clock/reader (50 %, rounding 33.3) | `health-readings.test.ts` → `CpuUsageTracker` (4 tests) | exit 1 | exit 0 |
| `/proc` main-thread reader, fail-open | `readMainThreadCpuTicks` | exit 1 | exit 0 |
| CPU fields in the collected reading, fail-open when the source throws | `collectHealthReadings` (3 tests) | exit 1 | exit 0 |
| Telemetry writes CPU fields; grouped delivery end-to-end | `health-telemetry.test.ts` (2 tests) | exit 1 | exit 0 |
| Incident knob defaults, overrides, out-of-range fallback + warning | `createHealthTelemetryConfig` (3 tests) | exit 1 | exit 0 |

The CPU tracker test caught a real defect while writing GREEN: the first implementation stored the reader's object by reference, so a reader that reuses one mutable buffer reported 0 % deltas. The tracker now copies (`health-readings.ts`), and the test pins it.

## 3. Gates

| Command | Exit | Evidence |
| --- | --- | --- |
| `npm run lint` | 0 | `lint-02.txt` — “296 problems (0 errors, 296 warnings)”, no warning in any touched file |
| `npm run typecheck` | 0 | `typecheck-02.txt` — all four workspaces clean |
| `npm run build` | 0 | `build-03.txt` — all workspaces built |
| `npm run docs:check-links` | 0 | `docs-links.txt` — “OK: 1316 internal link(s) resolve across 336 Markdown files.” |
| `npm run docs:check-agent-guides` | 0 | `docs-guides.txt` — “AGENTS.md and CLAUDE.md are byte-identical” |
| `npx vitest run tests/unit/internal-api/contract-stability-window.test.ts` (C6 guard) | 0 | `c6-guard.txt` — 18 passed |
| `npx vitest run tests/unit` (full server unit suite, run 1) | 1 | `server-unit.txt` — 6045 passed, 2 failed, 3 skipped (6050); failures `pi/session-watcher-retention` (the brief's known load-sensitive test) and `claude/claude-sdk-signature-pin` |
| failures re-run alone | 0 | each: “Test Files 1 passed (1)” |
| `npx vitest run tests/unit` (run 2) | 1 | `server-unit-2.txt` — 6046 passed, 1 failed, 3 skipped; the failure was a **different** test, `internal-api/session-routes-post-terminal-fence` |
| that failure re-run alone | 0 | “Test Files 1 passed (1)” |

The full suite shows transient load-sensitive failures in three different files across two runs, all green when re-run alone at the same commit; none is on an L1 path (Pi watcher retention, Claude SDK signature pin, sessions route fence). The brief already pre-declares the first as load-sensitive. Flagged for the reviewer; L1 adds no timers or background load under `VITEST` (`HealthTelemetry` is inert there).

`npm run docs:check-status` was not run: no Voice Mode document was touched.

## 4. Disposable live proof

**Isolation (plan §7).** Both servers ran via `npm run validate:server -- --compiled` inside their own transient systemd scope (`systemd-run --scope --collect`), so the cgroup guard passed and nothing shared the production cgroup. Launcher (preserved): `/root/l1-validation/run4/launch.sh` — fake `HOME`, `PI_AGENT_DIR`/`PI_CODING_AGENT_DIR` in a private empty agent dir, `AGENT_OS_BIN` + PATH `agent-os` stub, `BOARD_STORE_DIR`, `AGENT_OS_VAULT_ROOT`, `PI_WEB_UI_GOAL_HOME`, `PI_BG_TASKS_DIR`, `PI_COMPACTION_LOG` and `NOTIFICATIONS_DIR` inside the run dir, `NOTIFICATIONS_ENABLED=false`. `SESSION_DIR` was never set by hand. No credential copies and no heap snapshots were created, so there was nothing to delete.

### L1 proof — grouping, cooldown and CPU in a real process

Server pacing: interval 1000 ms, heap band 0.10/0.06, lag band 60000/30000 ms (out of the way), **quiet 20000 ms**, **cooldown 60000 ms**, debounce 2 (default).

```
$ systemd-run --scope --collect --unit=l1-incident-proof5 bash /root/l1-validation/run4/launch.sh   # background
$ node server/tests/integration/health-incident-live-proof.mjs \
    --dir /root/l1-validation/run4/validation \
    --socket /root/l1-validation/run4/validation/internal-api.sock \
    --token /root/l1-validation/run4/validation/internal-api-token \
    --inspect-port 9382 --log /root/l1-validation/run4/server.log
→ exit 0 — "PROOF OK"; 16/16 checks
$ node scripts/validation-server-stop.mjs --dir /root/l1-validation/run4/validation
→ exit 0 — "process group 1434094 terminated and verified gone."; socket gone
```

Evidence preserved: `/root/l1-validation/run4/validation/incident-proof-report.json`, `/root/l1-validation/run4/proof-console.txt`, `server.log`, `metrics/`.

Key numbers (from `incident-proof-report.json`, `ok: true`, 16/16):

| Check | Number |
| --- | --- |
| CPU first sample / later sample | `{null, null, proc-thread-self}` / `{0.9 %, 1 %, proc-thread-self}` |
| Steady / peak heap fraction | 0.0441 / 0.1034 (incident summary peak 0.107765) |
| Incident A raw crossings → records | 3 raw crossings → **1 alert**, **1 recovered** |
| Incident A summary | 08:19:33.618Z → 08:20:07.170Z, 33552 ms, peak 0.107765, `alertCrossings: 3`, `reopenedDuringCooldown: false` |
| Incident A message | `heap pressure incident recovered: peak 10.8% of the 4288 MB V8 heap limit, … → … (34s), 3 alert crossings folded` |
| Raw transitions journaled | 3 × `[HealthTelemetry] heap_pressure alert: heap pressure: …` plus 1 grouped recovered line |
| Incident B inside the cooldown | **0 alert records**, 1 recovered, `reopenedDuringCooldown: true`, message contains “reopened during the cooldown without a new alert” |
| Operator path | 0 files in `notifications/ingress`; no production notification file touched; startup line names the run-directory metrics file; no new entry created in the production metrics directory |

Positive controls: the replay test converts yesterday's real 12-notification log into 2 messages (RED would be 12 without grouping); the cooldown check fails if the cooldown is absent; the CPU checks fail if the fields are absent or faked; the raw-transition check proves recording survived grouping.

Iteration history: `/root/l1-validation/run3/` is a first L1 run whose *harness* used a 3 s quiet period shorter than a crossing cycle (so crossings 2–3 opened a second incident after the first closed) and had two driver bugs; it is preserved but superseded by `run4`.

### A2 recheck — the updated driver, and the old surface under grouping

```
$ systemd-run --scope --collect --unit=l1-a2-recheck2 bash /root/l1-validation/a2-recheck/launch.sh   # interval 1000 ms, bands 0.10/0.06, quiet 20000 ms
$ node server/tests/integration/health-telemetry-live-proof.mjs \
    --dir /root/l1-validation/a2-recheck/validation \
    --socket …/internal-api.sock --token …/internal-api-token \
    --inspect-port 9383 --log /root/l1-validation/a2-recheck/server.log \
    --journal-window-seconds 20 --quiet-wait-seconds 30
→ exit 0 — "PROOF OK"; 17/17 checks
$ node scripts/validation-server-stop.mjs --dir /root/l1-validation/a2-recheck/validation
→ exit 0 — "process group 1448837 terminated and verified gone."; socket gone
```

Evidence preserved: `/root/l1-validation/a2-recheck/validation/proof-report.json`, `proof-console.txt`. Key numbers: cadence +5 samples/5 s; 3 generations ≤ 4096 B; 6 resident Pi sessions; exactly one alert and one recovered with incident summary (peak 0.112454, 22004 ms); raw **and** grouped lines journaled; journal windows 0 lines/hour; 2 causal `Memory:` lines; no ingress; no new production metrics entry.

**Servers stopped:** yes — run3, run4 (both boots) and a2-recheck (both boots) were stopped with `validation-server-stop.mjs`, each exit 0 with a verified-gone process group and no socket.

## 5. Blind spots, not done, residual risks

- **Defaults are the brief's, not measured.** 10 min quiet, 30 min cooldown, debounce 2 are implemented and live-proven at shorter values; whether they are the right production pacing is an operational judgement for the owner/reviewer (env-tunable).
- **Grouping state is in memory.** A restart mid-incident starts fresh and can re-alert; this is the brief's explicit requirement, documented in `docs/OBSERVABILITY.md`.
- **The replay fixture is a transition log, not a sample stream**, so the replay test runs with `debounceReadings: 1`; the strict consecutive-high debounce is unit-proven with synthetic reading streams and the live proof ran the default (2).
- **Non-Linux main-thread CPU** falls back to the labelled process figure; the fallback is unit-tested with an injected reader, not live-tested on a non-Linux host.
- **CPU readings are interval averages**: a stall shorter than the sampling interval is not visible in the percentage (the lag window still sees it).
- **The metrics file schema is additive** (three fields). The only in-repo reader that parses the file for specific fields is `scripts/lag-repro/run.ts`, which picks its own fields and ignores additions; the rotation/proof consumers are unchanged.
- **Full-suite load flakiness** (see §3): three distinct tests failed transiently across two runs and all passed alone; not on L1 paths, but not eliminated either.
- **No production change.** No restart, deploy or production telemetry comparison; the parent deploys and can compare production lag-message volume before/after.
- **No live child/model calls** were made or needed: L1 touches notification pacing and a host-file field only, not lifecycle, admission, deploys or budgets, so the realistic-child-pattern rule does not apply to this lane.
- **Not touched:** the B2 admission gate, the notification-ingress pipeline, the Internal API, `types.ts`, the contract docs, `deploy/**`, `node_modules`.
- **Touches outside the brief's owned-path list** (disclosed): `.env.example` (the existing observability knobs are documented there), the new test fixture, and the A2 live driver (`server/tests/integration/health-telemetry-live-proof.mjs`) — all test/doc surfaces within the alert path.

## 6. Definition of victory (brief §1–§5)

| Item | Verdict | Evidence |
| --- | --- | --- |
| 1. Incident grouping (open/fold/quiet close/cooldown/debounce, env-tunable, documented, metrics+admission unchanged, raw recorded) | **met** | §1 semantics; §2 tests; §3 C6 guard green; §4 live proof |
| 2. Replay test RED first: one alert + one recovered, peak 12064, 6 crossings | **met** | §2 RED/GREEN; fixture sha256 equal to the parent's file |
| 3. CPU in the A2 telemetry (process % of one core, main-thread where cheap, documented, injected-clock test, not client-visible) | **met** | §1/§2; §4 CPU checks; no Internal API field touched |
| 4. Gates: lint, typecheck, build, docs, full server unit suite, C6 guard | **met with caveat** | §3 — all gates exit 0 except the full-suite runs, whose transient failures re-ran green alone |
| 5. Evidence: this bundle and `complete.md` with `FROZEN` last | **met** | this file; `/root/orch-ops/orchestration-scaling/l1/complete.md` |

Honest weaker form: **16 of 16 live checks** and **17 of 17 A2-recheck checks** pass at build `8ff0fdb9`; the full server unit suite did not complete a clean 6050/6050 run — two runs produced 2 and 1 transient failures, every one green alone.
