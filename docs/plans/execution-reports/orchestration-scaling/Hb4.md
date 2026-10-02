# Hb4 — Ops guards: production-checkout restart guard, terminal placement in tools.slice, placementDegrades per boot, working-set memory capacity

> **Worktree / branch:** `/root/.worktrees/orch-scaling/hb4-pi-web-ui` on `orch/hb4` (from master `6a70238d`).
> **Coordination dir:** `/root/orch-ops/orchestration-scaling/hb4/`.
> **Evidence bundle:** `docs/plans/execution-reports/orchestration-scaling/Hb4.md` (this file).
> **Status:** complete — correction 02 (`../hb4/02-correction.md`, Luna review REJECT round) applied: restart guard fails closed on unreadable git state, terminal cgroup removal waits for the group to empty, both live proofs re-run on disposable units with auditable single-sample evidence.
> **Contract:** 1.58.5 (patch bump within the C6 stability window — bug fix, wire shape unchanged, admission/capacity working-set behaviour fix).

## 1. Commits on `orch/hb4` (complete list, in order)

- `863c4e7c` `fix(ops): add production checkout restart safety guard`
- `476e01c7` `feat(terminal): place terminal shell in tools slice with cleanup and degrade fallback`
- `16da31e5` `feat(observability): filter placementDegrades per boot`
- `5cd72a65` `feat(internal-api): compute working-set memory capacity excluding inactive file cache (contract 1.58.5)`
- `2dc17455` `chore(hb4): lint polish (no non-null assertion) and the Hb4 evidence bundle` — the "upcoming lint-polish commit" cited by the first hand-back; it exists and is HEAD~1
- `a79b1f16` `fix(ops,terminal): correction 02 — unreadable git state refuses restart; terminal cgroup removal waits for the group to empty` (M1, M2, minors; this round)

## 2. What shipped

| Area | Files | Role |
| --- | --- | --- |
| Restart guard (criterion 1) | `scripts/restart-production.sh`, tests in `server/tests/unit/drain-restart-scripts.test.ts` | Refuses restart before draining when the production checkout is on the wrong branch (default `master`), has modified/staged tracked files, or `server/dist` build identity revision ≠ HEAD. **Correction 02 M1:** every git/jq command's exit status is captured; a check that cannot run refuses with `could not verify the production checkout` (corrupted index, unresolvable HEAD, unreadable build identity) instead of reading as clean. `--force --reason` still overrides, recorded `drain=forced`. |
| Terminal placement + cleanup (criterion 2) | `server/src/terminal/terminal-manager.ts`, `server/src/placement/spawn-wrap.ts`, `server/tests/unit/terminal/terminal-manager-placement.test.ts` | Interactive terminal shells planned via `planSpawnOwn` into the tools slice. **Correction 02 M2:** the plan's `cleanup` now uses the existing bounded, cgroup-aware `removeGroup` (kill → wait for `cgroup.procs` to empty → rmdir child cgroup directories) and logs a placement degrade (`own-group-removal-failed`) when the group still cannot be removed — the previous kill-then-immediate-`rmdirSync` swallowed `EBUSY` and leaked groups with lingering descendants. |
| Degrades per boot (criterion 3) | `server/src/placement/capacity.ts`, `server/src/observability/health-readings.ts` (the `placementDegrades` reading only), `server/tests/unit/placement/placement-capacity.test.ts` | `readDegradeCount` accepts `sinceMs`; the health sampler filters degrades **since this server process started** (`now − process.uptime()`), not host boot — wording corrected everywhere in this round. |
| Working-set memory capacity (criterion 5, correction 01) | `server/src/placement/capacity.ts`, `server/src/internal-api/cgroup-capacity.ts`, `docs/INTERNAL-API-CONTRACT.md`, `docs/contract/internal-api-client-snapshot.json` | `working_set = max(0, memory.current − inactive_file)` (kubelet/cAdvisor convention) for the tools slice and the service cgroup; kernel signals (`memory.events`, `memory.high`) unchanged. Contract 1.58.5. |
| Documentation | `DEPLOYMENT.md` | Restart safety checks incl. could-not-verify refusals; bounded terminal group removal; per-server-process degrade counting; working-set formula. |

## 3. TDD receipts (strict RED → GREEN; correction 02 round)

| Behaviour | Test file | RED | GREEN |
| --- | --- | --- | --- |
| Guard refuses when `git status` cannot run (corrupted index) | `server/tests/unit/drain-restart-scripts.test.ts` | vitest exit 1 — `2 failed` (script proceeded to restart: status 0, no refusal) | included in `70 passed` (exit 0) |
| Guard refuses when the branch cannot be resolved (broken HEAD) | `server/tests/unit/drain-restart-scripts.test.ts` | vitest exit 1 — wrong message (`on branch 'HEAD'`) | included in `70 passed` (exit 0) |
| Terminal destroy waits for a populated group to empty (lingering descendant) | `server/tests/unit/terminal/terminal-manager-placement.test.ts` | vitest exit 1 — `expected true to be false` (group leaked past a 3 s deadline) | included in `7 passed` (exit 0) |
| Terminal destroy logs a degrade when removal still fails (never empties) | `server/tests/unit/terminal/terminal-manager-placement.test.ts` | written after the fix (degrade path did not exist before it) | included in `7 passed` (exit 0) |

Exact commands (all through `systemd-run --scope -p CPUQuota=400% -p MemoryMax=6G -p MemorySwapMax=1G`, `env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test`, cwd `server/`):

- RED (M1): `npx vitest run tests/unit/drain-restart-scripts.test.ts -t "could-not-verify"` → exit 1 — `Tests 2 failed | 68 skipped`
- GREEN (M1, whole file): `npx vitest run tests/unit/drain-restart-scripts.test.ts` → exit 0 — `Test Files 1 passed (1) / Tests 70 passed (70)`
- RED (M2): `npx vitest run tests/unit/terminal/terminal-manager-placement.test.ts -t "populated cgroup"` → exit 1 — `expected true to be false`
- GREEN (M2 + degrade path): `npx vitest run tests/unit/terminal/` → exit 0 — `Test Files 3 passed / Tests 20 passed`

Prior rounds' RED→GREEN receipts (criteria 1–5, pre-correction-02) live in git history at commits `863c4e7c`…`5cd72a65`; their test files are named in §2 (the first hand-back's citations of `server/tests/unit/restart-production-guard.test.ts` and `terminal-manager.test.ts` for the placement receipt were wrong — those cases live in `drain-restart-scripts.test.ts` and `terminal-manager-placement.test.ts` respectively).

## 4. Disposable live proofs (correction 02: M3 + M4, re-run on disposable units only)

Harness: `/root/orch-ops/orchestration-scaling/hb4/harness/` (`run-proofs.sh`, `terminal-proof.mjs`, `memory-proof.mjs`). Every proof runs inside its own transient **delegated** systemd unit (`Delegate=yes`, `MemoryMax=6G`, `MemorySwapMax=1G`, `OOMPolicy=continue`, `TasksMax=512`, `CPUQuota=400%`) via `systemd-run --wait`; the driver creates, inside the unit it owns, the production-shaped topology (`<unit>/control` memory.max 4G for the server side, `<unit>/tools` memory.max 2600M / memory.high 2400M for the tools slice — service side and tools slice disjoint, like `pi-web-ui.service` vs `pi-web-ui-tools.slice`), after the no-internal-process bootstrap (driver joins `control` first, then `+memory +pids` on the unit root and on `tools`, each limit read back as a number). No production unit, `/sys/fs/cgroup/pi.slice` or `/root/pi-web-ui` was touched. Both units were stopped and are gone; every disposable server was stopped via `validation-server-stop.mjs`; all created sessions were deleted.

### 4.1 M3 — terminal shell placement + populated-group cleanup

Run: `bash run-proofs.sh terminal` → exit 0. Unit `hb4c02-terminal-proof.service` (cgroup `/system.slice/hb4c02-terminal-proof.service`, unit `memory.max` 6442450944 read back). Build under proof: **`a79b1f161e9ec4ddc878a27f445e8e7c5aee83fa`** (`build-2b962c11…`, the lane's compiled `server/dist`). Result file: `runs/20261002T044650Z-terminal/terminal-proof-result.json`.

1. `TerminalManager.create` (real class, real cgroupfs, real pty) → success, shell pid 1886533.
2. `/proc/1886533/cgroup` = `0::/system.slice/hb4c02-terminal-proof.service/tools/own-57729d953418` — the shell lands in an `own-*` group **under the disposable tools slice**; the group's limits read back exactly: `memory.max` 2147483648, `memory.high` 1610612736 (configured per-child 2G/1.5G).
3. `sleep 600 &` written into the terminal (pid 1886554): `/proc/1886554/cgroup` = the same `own-57729d953418` group (descendant contained).
4. `destroy('proof-client')` → **the `own-*` group is gone after 3 ms** and the sleep descendant is dead (kill −0 fails) — the M2 bounded removal working on a populated group.
5. Degrade log after the run: empty (no placement degrades).

The rejected round-1 proof had placed the shell under production's `pi-web-ui-tools-anchor.service`; that path was never touched this round (the drivers hard-refuse any cgroup path containing `pi.slice`/`pi-web-ui`).

### 4.2 M4 — auditable working-set memory + admission proof

Run: `bash run-proofs.sh memory` → exit 0. Unit `hb4c02-memory-proof.service` (unit `memory.max` 6442450944 read back; host `MemAvailable` 21630.5 MB at start, ≥ 12 GB rule satisfied). Result file: `runs/20261002T045840Z-memory/memory-proof-result.json`.

**Two real servers, one live tools cgroup:** this lane's build (**`a79b1f161e9ec4ddc878a27f445e8e7c5aee83fa`**) and master's build (**`6a70238df41c0eb3d98960a3391a79dcfdfee2fa`**, `build-5071def1…`, throwaway worktree `/tmp/hb4c02-master` at master `6a70238d`, `node_modules` symlinked like the lane worktree, built 04:41Z) — both booted via `scripts/validation-server.ts --compiled` inside the unit with **identical** admission knobs (`INTERNAL_API_ADMISSION_MIN_HEADROOM_MB=4800`, `RESERVED_MB_PER_TURN=1`, `HOST_MIN_HEADROOM_MB=512`, `MAX_ACTIVE_TURNS=8`, `INTERACTIVE_RESERVE=1`, `RESERVED_PIDS_PER_TURN=8`) and **identical** `PI_TOOLS_SLICE` pointing at the same live `<unit>/tools` subtree. Probes: `GET /api/v1/capacity` (raw JSON recorded) and `POST /api/v1/sessions` (`{runtime:'pi', cwd:<workspace>, model:'zai/glm-5.3-flash'}`) — the approved live route; the isolated agent dir carried **only** the `zai` credential.

**Sample discipline:** per arm, ONE raw sample per group (single read of `memory.current` and of `memory.stat`, timestamped) feeds the raw/computed columns; each server's `/capacity` value and each admission outcome carries its own timestamp, so every number is attributable to its sample. **Sample count: 1 raw sample per group per arm** (arm 1 additionally re-sampled only while waiting for `inactive_file` to settle, ≤ 3 tries, all recorded). **Load claim: peak concurrent active turns = 0, from the recorded `activeTurns` field of every capacity probe in the run (8/8 probes, all `0`)** — probes are single creates (admission evaluates before any runtime work); no prompts were sent; admitted sessions were deleted immediately (`deletedAt` recorded for all three).

| Arm | Sample (timestamp) | raw `current` | `inactive_file` | `anon` | computed ws |
| --- | --- | --- | --- | --- | --- |
| 1 tools (04:58:55.328Z) | single | 2334.0 MB | 2266.8 MB | 0.0 MB | 67.2 MB |
| 1 control (04:58:55.328Z) | single | 970.1 MB | 0.4 MB | 932.2 MB | 969.6 MB |
| 2 tools (04:59:01.863Z) | single | 2245.3 MB | 0.0 MB | 2240.8 MB | 2245.3 MB |
| 2 control (04:59:01.863Z) | single | 985.8 MB | 0.4 MB | 947.2 MB | 985.4 MB |

**Arm 1 — page cache 2250 MB (charged to `<unit>/tools/arm1-cache`, allocation-free):**

| Probe (timestamp) | build | `/capacity` current | headroom (min 4800 MB) | `available` | CREATE outcome |
| --- | --- | --- | --- | --- | --- |
| mine (04:58:55.329Z) | `a79b1f16` | 1037.3 MB | 5658.7 MB | true, activeTurns=0 | **admitted** (HTTP 201; session deleted 04:58:55.948Z) |
| master (04:58:55.948Z) | `6a70238d` | 3311.9 MB | 3384.1 MB | false, `reason=memory_pressure` | **refused** (HTTP 503 `ADMISSION_CAPACITY_EXHAUSTED`, `reason=memory_pressure`) |

Reconciliation: mine's `current` 1037.3 MB vs samples 969.6 + 67.2 = 1036.8 MB (+0.5 MB over 1 ms — control-side churn); master's 3311.9 MB vs 970.1 + 2334.0 = 3304.1 MB (+7.8 MB over 0.62 s — includes the pi child from mine's admitted create). Both reconcile within ordinary cgroup drift, and the drift direction is stated, not hidden. Master's refusal is doubly determined: raw headroom 3384.1 < 4800 MB **and** raw current 3311.9 ≥ `memory.high` 2400 MB; mine's working set (1037.3 MB) sits far below both thresholds.

**Recovery control (04:59:00.449Z):** after `rm` + `memory.reclaim 3G`, tools `current` 0.1 MB / `inactive_file` 0.0 MB and both builds report `available=true` again (headroom ≈ 5719 MB) — the pressure was the arm, not the setup.

**Arm 2 — self-limiting anonymous allocation (single process in `<unit>/tools/arm2-anon`, self-capped at 2350 MB, stopped at `anon` 2240.8 MB ≪ the 10 GB rule):**

| Probe (timestamp) | build | `/capacity` current | headroom (min 4800 MB) | `available` | CREATE outcome |
| --- | --- | --- | --- | --- | --- |
| mine (04:59:01.863Z) | `a79b1f16` | 3231.2 MB | 3464.8 MB | false, `reason=memory_pressure` | **refused** (HTTP 503 `ADMISSION_CAPACITY_EXHAUSTED`, `reason=memory_pressure`) |
| master (04:59:01.869Z) | `6a70238d` | 3231.2 MB | 3464.8 MB | false, `reason=memory_pressure` | refused (HTTP 503, `reason=memory_pressure`) |

Reconciliation: mine's 3231.2 MB vs 985.4 + 2245.3 = 3230.7 MB (+0.5 MB, same-instant samples). The genuine anonymous pressure is enforced by the working-set arithmetic (headroom 3464.8 < 4800 **and** current ≥ high 2400) — inactive-file deduction does not mask real pressure.

Baseline control (before any arm): both builds `available=true`, `activeTurns=0`, and both CREATEs admitted (201) — the setup itself refuses nothing.

**Verdict:** reclaimable inactive file cache is treated as headroom by this build while master refuses on it (arm 1, production's live defect class), and genuine anonymous pressure is still refused by this build (arm 2) — with every figure traceable to a timestamped sample and a named build.

### 4.3 Proof-run history (honest record)

- `runs/20261002T044444Z-terminal` — abort: `EACCES` writing `<unit>/control/memory.max`; root cause: subtree controllers must be enabled after the no-internal-process bootstrap (driver joins `control` first). Driver fixed.
- `runs/20261002T044717Z-memory` — abort: driver import bug (`spawn` from `node:fs`). Fixed.
- `runs/20261002T044738Z-memory` — abort: servers booted with `NODE_ENV=production` demanded `JWT_SECRET`; switched to validation-mode `NODE_ENV=test` (admission knobs stay explicit). No live members survived (unit stop killed the cgroup).
- `runs/20261002T044650Z-terminal` — the passing M3 run reported above.
- `runs/20261002T044830Z-memory` — all four verdicts already correct, but the driver neither recorded `activeTurns` nor surfaced the CREATE refusal body's `reason` (label read `refused(unknown)`). Driver fixed (`e.responseBody`, `activeTurns` persisted) and superseded by:
- `runs/20261002T045840Z-memory` — the passing M4 run reported above.

## 5. Gates (run at `a79b1f16`, the final code commit)

| Gate | Command | Exit | Result |
| --- | --- | --- | --- |
| Full server unit suite | `cd server && NODE_ENV=test npx vitest run tests/unit` | 0 | `Test Files 512 passed (512) / Tests 6240 passed \| 3 skipped` |
| Focused suites | drain-restart-scripts, terminal/*, placement/*, observability/health-readings, integration/restart-requester-record | 0 | `18 files / 206 tests passed` |
| Lint | `npm run lint` | 0 | 0 errors (304 warnings, pre-existing repo-wide) |
| Lint ratchet | `npm run lint:ratchet -- --base master` | 0 | `violations: []` (ceiling 326, 34 changed files checked) |
| Typecheck | `npm run typecheck` | 0 | clean |
| Build | `npm run build` | 0 | all workspaces; dist identity `a79b1f16…` (the build the proofs ran) |
| Docs links | `npm run docs:check-links` | 0 | 1338 links across 350 files resolve |
| Agent guides | `npm run docs:check-agent-guides` | 0 | AGENTS.md ≡ CLAUDE.md |
| Whitespace | `git diff --check master...HEAD` | 0 | clean |
| Main checkout untouched | `git -C /root/pi-web-ui status --porcelain` + `rev-parse --abbrev-ref HEAD` | 0 | empty status, `master` |

## 6. Parent ledger note & Agent OS mirrors

### Ledger note (the parent writes the row)
> cgroup v2 `memory.current` includes reclaimable inactive file page cache (children's builds/tests). Admission must count `max(0, memory.current − inactive_file)` (kubelet/cAdvisor convention) for the tools slice and the service cgroup, or it false-positives `ADMISSION_CAPACITY_EXHAUSTED: memory_pressure` while the host has headroom. Kernel signals (`memory.events`, `memory.high`) stay raw. Same class to watch: any new consumer of `memory.current` (restart guards, health readings) must decide explicitly whether it means raw or working set.

### Downstream Agent OS mirrors for contract 1.58.5 (parent makes these)
1. `/root/agent-os/src/pi-web-ui/client.ts` (contract version pin)
2. `/root/agent-os/tests/pi-web-ui-observability-contract.test.ts` (mirror parity test)
3. `/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md` (mirror doc)
