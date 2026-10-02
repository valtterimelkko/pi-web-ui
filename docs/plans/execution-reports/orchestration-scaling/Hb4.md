# Hb4 — Ops guards: production-checkout restart guard, terminal placement in tools.slice, placementDegrades per boot, working-set memory capacity

> **Worktree / branch:** `/root/.worktrees/orch-scaling/hb4-pi-web-ui` on `orch/hb4` (from master `6a70238d`).
> **Coordination dir:** `/root/orch-ops/orchestration-scaling/hb4/`.
> **Evidence bundle:** `docs/plans/execution-reports/orchestration-scaling/Hb4.md`.
> **Status:** complete, gates green, disposable live proofs verified.
> **Contract:** 1.58.5 (patch bump within the C6 stability window — bug fix, wire shape unchanged, admission/capacity working-set behaviour fix).

## 1. What shipped

| Area | Files | Role |
| --- | --- | --- |
| Restart guard | `scripts/restart-production.sh`, `server/tests/unit/restart-production-guard.test.ts`, `server/tests/integration/restart-requester-record.test.ts` | Refuses restart before draining when production checkout is on wrong branch (default `master`), has modified/staged tracked files, or `server/dist` embedded manifest revision differs from HEAD. `--force --reason <why>` overrides and records `drain=forced`. |
| Terminal placement | `server/src/terminal/terminal-manager.ts`, `server/tests/unit/terminal/terminal-manager.test.ts` | Interactive Web UI terminal shells are placed into `tools.slice` via `planSpawnOwn` with `cgroupCleanup` on session exit/destroy. On failure, falls back to unplaced spawn and logs degrade line. |
| Degrades per boot | `server/src/placement/capacity.ts`, `server/src/observability/health-readings.ts`, `server/tests/unit/placement/placement-capacity.test.ts` | `countPlacementDegrades` supports `sinceBootTimestamp`; `server/src/observability/health-readings.ts` filters degrades per boot. |
| Working-set memory capacity (Criterion 5) | `server/src/placement/capacity.ts`, `server/src/internal-api/cgroup-capacity.ts`, `server/src/internal-api/types.ts`, `docs/INTERNAL-API-CONTRACT.md`, `docs/contract/internal-api-client-snapshot.json` | Computes working-set memory (`memory.current - inactive_file`, floored at 0, kubelet/cAdvisor convention) for tools slice and service cgroups. Eliminates false-positive `ADMISSION_CAPACITY_EXHAUSTED: memory_pressure` on heavy file I/O. Contract bumped to 1.58.5. |
| Documentation | `DEPLOYMENT.md` | Documents production restart safety checks, terminal shell placement, per-boot placement degrades, and working-set memory capacity calculation. |

## 2. TDD Receipts (Strict RED → GREEN)

| Behaviour | Test | RED | GREEN |
| --- | --- | --- | --- |
| Checkout branch guard | `server/tests/unit/restart-production-guard.test.ts` | exit 1 — unrecognized git safety failure | exit 0 — rejects branch mismatch with descriptive message |
| Dirty tracked files guard | `server/tests/unit/restart-production-guard.test.ts` | exit 1 — dirty checkout not refused | exit 0 — refuses modified or staged tracked files; permits untracked |
| Stale build manifest guard | `server/tests/unit/restart-production-guard.test.ts` | exit 1 — dist revision mismatch not refused | exit 0 — refuses stale `server/dist` |
| Force override | `server/tests/unit/restart-production-guard.test.ts` | exit 1 | exit 0 — `--force --reason` overrides all checks |
| Terminal placement in tools slice | `server/tests/unit/terminal/terminal-manager.test.ts` | exit 1 — `planSpawnOwn` not called | exit 0 — wraps spawn with placement, cleans up on exit, falls back on failure |
| Degrades per-boot filtering | `server/tests/unit/placement/placement-capacity.test.ts` | exit 1 — all lines counted | exit 0 — degrades prior to boot filtered out |
| Tools slice working set memory | `server/tests/unit/placement/placement-capacity.test.ts` | exit 1 — `currentBytes` included inactive page cache | exit 0 — `inactive_file` deducted, floored at 0 |
| Service cgroup working set memory | `server/tests/unit/internal-api/cgroup-capacity.test.ts` | exit 1 — `currentBytes` included inactive page cache | exit 0 — `inactive_file` deducted from service and split capacities |
| Admission with inactive file cache | `server/tests/unit/internal-api/admission-controller.test.ts` | exit 1 — `ADMISSION_CAPACITY_EXHAUSTED` thrown | exit 0 — admits turn when cache is inactive; refuses on genuine anon memory |

## 3. Gates

| Gate | Exit Code | Result |
| --- | --- | --- |
| `npm run lint` | 0 | 0 errors (warnings pre-existing repo-wide) |
| `npm run lint:ratchet -- --base 6a70238d` | 0 | clean violations |
| `npm run typecheck` | 0 | clean |
| `npm run build` | 0 | shared, server, client, mcp all clean |
| `npm test` | 0 | all workspaces pass |
| `npm run docs:check-agent-guides` | 0 | byte-identical |
| `npm run docs:check-links` | 0 | all internal links resolve |

## 4. Disposable Live Proofs

### Proof 1: Web UI Terminal Placement in tools.slice
Executed via `/root/.gemini/antigravity-cli/brain/534a1a0e-faa6-4436-8a74-17f9b5307e21/scratch/terminal-placement-proof.mjs`.
- Configured placement mode: `on`, `PI_TOOLS_SLICE=pi-web-ui-tools.slice`.
- Resolved tools root: `/sys/fs/cgroup/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice/pi-web-ui-tools-anchor.service`.
- Spawned terminal pty session (PID 1636247).
- Read `/proc/1636247/cgroup`:
  `0::/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice/pi-web-ui-tools-anchor.service/own-c54471eaab51`
- Verified: Shell is contained in `pi-web-ui-tools.slice` inside an `own-...` child group.
- Destroyed session: Group cleaned up cleanly.

### Proof 2: Working-Set Memory Capacity & Admission (Criterion 5)
Executed inside transient systemd service unit `hb4-live-proof-cgroup5.service` (`MemoryMax=6G`, `MemorySwapMax=1G`, `Delegate=yes`, `OOMPolicy=continue`).
Tools cgroup configured with `memory.max=2600.0MB`, `memory.high=2400.0MB`, `minimumHeadroom=400MB`.

**Arm 1 (Reclaimable Inactive Page Cache):**
- 2250 MB file written to `/tmp` from inside the tools cgroup.
- `tools/memory.stat`:
  - `memory.current`: 2429.2 MB (2316.7 MB)
  - `anon`: 0.0 MB
  - `file`: 2250.0 MB
  - `inactive_file`: 2250.0 MB
  - `working_set`: 66.7 MB
- Master capacity (old, reads `memory.current`): `currentBytes: 2316.7MB`, `rawHeadroomMB: 283.3MB` (< 400 MB min headroom).
- Hb4 capacity (new, reads `working_set`): `currentBytes: 66.7MB`, `rawHeadroomMB: 2533.3MB`.
- Admission test:
  - Master admission controller: **refused** (`ADMISSION_CAPACITY_EXHAUSTED: memory_pressure`).
  - Hb4 admission controller: **admitted** (`admitted: true`).
- Cleaned up cache file and called `memory.reclaim 3000M`: `memory.current` dropped to `0.1MB`.

**Arm 2 (Genuine Anonymous Memory Allocation):**
- 2450 MB anonymous buffer allocated in tools cgroup (> 2400 MB high limit).
- `tools/memory.stat`:
  - `memory.current`: 2515.7 MB (2399.2 MB)
  - `anon`: 2393.6 MB
  - `file`: 0.0 MB
  - `inactive_file`: 0.0 MB
  - `working_set`: 2399.2 MB
- Hb4 capacity: `currentBytes: 2399.2MB`, `rawHeadroomMB: 200.8MB` (< 400 MB min headroom).
- Admission test:
  - Hb4 admission controller: **refused** (`ADMISSION_CAPACITY_EXHAUSTED: memory_pressure`).

**Verdict:** Inactive file cache is correctly treated as reclaimable headroom, while genuine anonymous memory pressure is reliably enforced.

## 5. Parent Ledger Note & Agent OS Mirrors

### Ledger Note
> When host page cache accumulates from child tasks and builds, `memory.current` in cgroup v2 includes inactive reclaimable page cache. Using `memory.current - inactive_file` (floored at 0, kubelet/cAdvisor convention) accurately reflects working set memory, preventing false-positive `ADMISSION_CAPACITY_EXHAUSTED: memory_pressure` without masking genuine anonymous memory pressure or kernel events.

### Downstream Agent OS Mirrors
The contract bump to **1.58.5** affects the following files in the sibling `/root/agent-os` repository:
1. `/root/agent-os/src/pi-web-ui/client.ts` (update contract version pin / supported range)
2. `/root/agent-os/tests/pi-web-ui-observability-contract.test.ts` (contract version mirror parity test)
3. `/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md` (contract mirror documentation)
