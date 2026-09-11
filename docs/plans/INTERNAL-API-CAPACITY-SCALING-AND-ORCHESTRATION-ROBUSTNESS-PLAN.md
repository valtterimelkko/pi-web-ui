# Plan: Internal API Capacity Scaling & Multi-Agent Orchestration Robustness

> **File:** `docs/plans/INTERNAL-API-CAPACITY-SCALING-AND-ORCHESTRATION-ROBUSTNESS-PLAN.md`  
> **Status:** READY FOR EXECUTION (Awaiting Operator Authorization)  
> **Target Service:** `pi-web-ui.service` (Port 3456)  
> **Target Workload:** High-concurrency multi-agent orchestration, Benchmark 1 (`execute_children.py`), Benchmark 2 (`supervisor.py`), and parallel specialist subagent dispatch.  
> **Related Incidents & Observations:** `docs/ADMISSION-CAPACITY-BOTTLENECK-OBSERVATION.md`, `docs/plans/execution-reports/INTERNAL-API-CAPACITY-REPAIR-2026-09-07.md`, commit `87e0b7b`.

---

## 0. Executive Summary & Problem Statement

### The 3-Turn Bottleneck
During automated multi-child orchestration and parallel benchmarking (such as running 4 specialist probes concurrently in Benchmark 1 or parent conductor + 2–3 children in Benchmark 2), the system consistently rejects the 4th concurrent turn with:
```json
HTTP/1.1 503 Service Unavailable
{
  "error": "ADMISSION_CAPACITY_EXHAUSTED",
  "reason": "pid_pressure",
  "retryAfterSeconds": 2,
  "detail": "currentTasks=11 reservedTasks=1024 projectedTasks=1035 taskLimit=1024"
}
```

### Why Commit `87e0b7b` Did Not Resolve It
There was an impression that recent work had already removed this bottleneck. However, commit `87e0b7b` (7 Sep 2026) only added **diagnostic formatting** to the refusal error message (`detail: currentTasks=... reservedTasks=...`). The underlying disposable test server verified 128 PIDs under test conditions, but the production configuration and defaults were deliberately held back pending separate operational rollout:
1. `DEFAULT_RESERVED_PIDS_PER_TURN = 256` remained in `server/src/internal-api/admission-controller.ts`.
2. `/etc/systemd/system.control/pi-web-ui.service.d/50-TasksMax.conf` remained `TasksMax=1024`.
3. The arithmetic gate in `admission-controller.ts`:
   $$\text{projectedTasks} = \text{pids.current} + (N_{\text{active}} + 1) \times \text{reservedPidsPerTurn} \ge \text{pids.max}$$
   Guarantees that maximum admitted turns is:
   $$\lfloor (1024 - 11) / 256 \rfloor = \lfloor 3.95 \rfloor = 3$$
   Turn 4 evaluates to $11 + (3 + 1) \times 256 = 1035 \ge 1024 \rightarrow$ **rejected every time**.

### Host Hardware Reality
The host is underutilized:
- **Total RAM:** 32.8 GiB, **Available RAM:** ~22.0 GiB (> 65% idle).
- **CPU:** 16 physical/vCPU cores, < 1% average utilization, zero sustained PSI stalls.
- **Kernel PID ceiling:** `kernel.pid_max = 4,194,304`.
- **Production Service Usage:** ~373 MiB RSS, 11 tasks.

This plan scales the Internal API to **Tier 2 (14 concurrent execution turns / 16 total active turns)**, completely unblocking orchestration benchmarks and parallel child execution.

---

## 1. Owner Decisions & Operational Rules (Do Not Re-Ask)

| # | Decision |
|---|---|
| **D1** | **Scope**: Scale `pi-web-ui` in-process service capacity (Option A), de-hardcoding session caches and tuning admission parameters. Worker cgroup isolation (Phase 6/8A) remains a deferred roadmap item. |
| **D2** | **Target Capacity**: Tier 2 — **16 max active turns**, **14 execution capacity (P2/P3)**, **2 control reserve (P0/P1)**. |
| **D3** | **Systemd Limits**: Scale `TasksMax=8192`, `MemoryMax=18G`, `MemoryHigh=14G`. Update service unit `NODE_OPTIONS=--max-old-space-size=4096`. *(Note on TasksHigh: Linux cgroups v2 and systemd resource control have **no** `TasksHigh` or `pids.high` property. Only `TasksMax` exists. Documented explicitly to prevent phantom configuration).* |
| **D4** | **Strict TDD & Failure Assertions**: Every code change requires RED $\rightarrow$ GREEN evidence before live validation. |
| **D5** | **Zero False-Victory Policy**: An execution agent must NOT claim victory based on mocks or disposable tests alone. Production victory requires verifying live drop-ins, truthful `/api/v1/capacity` readbacks, and empirical execution of Benchmark 1 in `/root/agent-benchmarks`. |
| **D6** | **Production Restart Gate**: Production service restart requires explicit maintenance pre-flight: zero active turns, zero nonterminal run receipts, and production lock (`scripts/with-production-lock.sh`). Caddy and `/root/tmux` must remain completely untouched. |

---

## 2. Multi-Layer Bottleneck Audit & Architecture

Scaling concurrency cannot just patch `TasksMax`; it must resolve all 7 cascading layers:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 1: PID Admission Gate (TasksMax=1024, reservedPids=256) → Cap @ 3 │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Arbiter Ceilings (maxActiveTurns=6, execCap=5)        → Cap @ 5 │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 3: MultiSessionManager Pi Cache (hardcoded maxSessions=4)→ Thrash @4│
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 4: Node.js V8 Heap (--max-old-space-size=2048)           → Shed @ 1.6G
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 5: Memory Projection Math (reserved=768MB against 12GB)  → Cap @ 13│
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 6: Runtime Ceilings (antigravity=4, claude=10, cmdc=1)   → Hetero │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 7: Admission Strategy (immediate 503/429 vs bounded hold)→ Bursts │
└─────────────────────────────────────────────────────────────────────────┘
```

1. **Layer 1 (PID Gate):** Lower `reservedPidsPerTurn` from 256 to 96 (or 64). Raise systemd `TasksMax` from 1024 to 8192. (At 96 PIDs/turn with 14 turns: $30 + 15 \times 96 = 1470 \ll 8192$).
2. **Layer 2 (Arbiter Ceilings):** Raise `INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS=16` and `INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE=2`. Yields `executionCapacity=14` and `controlReserve=2`.
3. **Layer 3 (Pi Session Cache):** `server/src/websocket/connection.ts` hardcodes `maxSessions: 4`. When >4 sessions rehydrate or run, it thrashes attempting to evict non-idle sessions. De-hardcode via `config.piMaxSessions` (default 20).
4. **Layer 4 (Node.js Heap):** `--max-old-space-size=2048` enters memory shedding at 80% (1.6 GiB). Scale `NODE_OPTIONS` to `--max-old-space-size=4096` in `/etc/systemd/system/pi-web-ui.service`.
5. **Layer 5 (Memory Projection):** Lower `reservedBytesPerTurn` from 768 MiB to 512 MiB. Raise `MemoryMax=18G` and `MemoryHigh=14G`. Projected headroom at 14 turns: $(18 - 0.5) - (14 + 1) \times 0.512 = 17.5 - 7.68 = 9.82\text{ GiB} \gg 1.5\text{ GiB}$.
6. **Layer 6 (Heterogeneous Runtimes):** Configure `ANTIGRAVITY_MAX_SESSIONS=10` and `MAX_CLAUDE_PROCESSES=16` in `.env.production` so cross-runtime multi-agent runs are not choked.

---

## 3. Production File & System Allowlist

### Application Files
- `server/src/config.ts` (Add `piMaxSessions` parsing from `PI_MAX_SESSIONS`)
- `server/src/websocket/connection.ts` (Pass `config.piMaxSessions` to `MultiSessionManager`)
- `server/src/internal-api/admission-controller.ts` (Update `DEFAULT_RESERVED_PIDS_PER_TURN = 96`, `DEFAULT_RESERVED_BYTES_PER_TURN = 512MB`, `PRODUCTION_ADMISSION_DEFAULTS`)
- `server/tests/unit/internal-api/admission-controller.test.ts` (Update conservative assertions)
- `server/tests/unit/internal-api/admission-explanation.test.ts` (Update explanation test fixture)
- `server/tests/unit/config/pi-max-sessions.test.ts` (New test verifying `PI_MAX_SESSIONS` configuration)

### Environment & Host Configuration
- `/root/pi-web-ui/.env.production` (Set admission, memory, and session knobs)
- `/etc/systemd/system/pi-web-ui.service` (Update `NODE_OPTIONS=--max-old-space-size=4096`)
- `/etc/systemd/system.control/pi-web-ui.service.d/50-TasksMax.conf` (`TasksMax=8192`)
- `/etc/systemd/system.control/pi-web-ui.service.d/50-MemoryMax.conf` (`MemoryMax=18G` / `19327352832`)
- `/etc/systemd/system.control/pi-web-ui.service.d/50-MemoryHigh.conf` (`MemoryHigh=14G` / `15032385536`)

---

## 4. Phased Implementation Sequence

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Code Hardening & De-Hardcoding (TDD)                                │
│ - Make MultiSessionManager.maxSessions configurable via PI_MAX_SESSIONS      │
│ - Lower default reservedPidsPerTurn to 96 and reservedBytesPerTurn to 512MB │
│ - Update and run unit test suites (assert RED -> GREEN)                     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 2: Disposable Server Live Concurrency Ladder Validation               │
│ - Spin up isolated disposable test server in transient systemd scope        │
│ - Exercise ladder: 4, 8, 12, and 14 concurrent turns with real Pi runtime   │
│ - Run Benchmark 1 execute_children.py (all 4 probes parallel) on disposable │
│ - Verify real PID, memory, PSI, and zero 503/429 rejections                 │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 3: Production Systemd & Environment Preparation                        │
│ - Apply systemctl set-property for TasksMax=8192, MemoryMax=18G, High=14G   │
│ - Update service unit NODE_OPTIONS=--max-old-space-size=4096                │
│ - Update /root/pi-web-ui/.env.production with explicit knobs                │
│ - Run daemon-reload and compile server build (npm run build)                │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 4: Gated Production Restart & Benchmark Unblocking                    │
│ - Verify pre-flight: 0 active turns, 0 active runs, production lock held    │
│ - systemctl restart pi-web-ui.service                                       │
│ - Verify /api/v1/capacity truth: maxActiveTurns=16, exec=14, pids.max=8192  │
│ - Run Benchmark 1 in /root/agent-benchmarks: 4 probes parallel, zero 503s  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Phase-by-Phase Plan, TDD, and Definitions of Victory

### Phase 1: Code Hardening & De-Hardcoding (TDD)

#### Intent
Eliminate the hardcoded session manager cap of 4, lower conservative application defaults to realistic baselines, and ensure all knobs are driven cleanly by configuration.

#### TDD Sequence
1. **Test 1 (`pi-max-sessions.test.ts`):**
   - **RED:** Assert that `config.piMaxSessions` parses `process.env.PI_MAX_SESSIONS` (defaulting to 20 when unset, validating positive integers). Run test $\rightarrow$ fails because property does not exist on `Config`.
   - **GREEN:** Add `piMaxSessions` to `Config` in `server/src/config.ts`. In `server/src/websocket/connection.ts`, replace `maxSessions: 4` with `maxSessions: this.config.piMaxSessions ?? 20`.
2. **Test 2 (`admission-controller.test.ts` & `admission-explanation.test.ts`):**
   - **RED:** Update admission controller tests to assert default `reservedPidsPerTurn = 96` and `reservedBytesPerTurn = 512 * 1024 * 1024`. Run test $\rightarrow$ fails against old constants (256 / 768MB).
   - **GREEN:** Update `DEFAULT_RESERVED_PIDS_PER_TURN = 96`, `DEFAULT_RESERVED_BYTES_PER_TURN = 512 * 1024 * 1024`, and `PRODUCTION_ADMISSION_DEFAULTS` in `server/src/internal-api/admission-controller.ts`. Tests pass.

#### Definition of Victory for Phase 1 (DoV-1)
- [ ] `npm test --workspace=server` passes with **zero failures**.
- [ ] `npm run typecheck` passes with **zero errors**.
- [ ] Unit tests prove that `MultiSessionManager` receives the configured `piMaxSessions`.
- [ ] Unit tests prove that admission arithmetic uses 96 PIDs and 512 MiB per turn by default.
- [ ] **ANTI-VICTORY CHECK:** Do NOT claim victory if `connection.ts` still contains a literal `maxSessions: 4`.

---

### Phase 2: Disposable Server Live Concurrency Ladder Validation

#### Intent
Empirically prove on an isolated, disposable test server that 4, 8, 12, and 14 concurrent turns execute cleanly without tripping `pid_pressure`, `memory_pressure`, or `global_limit`.

#### Execution Method
1. Boot a disposable validation server using `scripts/live-validate.ts` or `systemd-run` on an isolated Unix socket (`/tmp/pi-val-capacity.sock`) and port (`4599`) with:
   - `TasksMax=8192`
   - `MemoryMax=18G`
   - `INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS=16`
   - `INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE=2`
   - `INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN=96`
   - `INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN=512`
   - `PI_MAX_SESSIONS=20`
2. **Concurrency Ladder Test:**
   - **Rung 1 (4 turns):** Dispatch 4 concurrent Pi turns (`zai/glm-5.3-flash`) executing `bash` commands. Sample `/api/v1/capacity`. Verify `activeTurns: 4`, zero 503s.
   - **Rung 2 (8 turns):** Dispatch 8 concurrent Pi turns. Verify `activeTurns: 8`, zero 503s.
   - **Rung 3 (12 turns):** Dispatch 12 concurrent Pi turns. Verify `activeTurns: 12`, zero 503s.
   - **Rung 4 (14 turns):** Dispatch 14 concurrent Pi turns (maximum P2 capacity). Verify `activeTurns: 14`, `executionCapacity: 14`.
   - **Saturation Verification:** Attempt turn 15 $\rightarrow$ Verify clean `HTTP 429 global_limit` (capacity exhaustion, not a crash or 503 pressure).
3. **Benchmark 1 Probe Simulation:**
   - Run a test dispatch of all 4 Benchmark 1 probes (`fxa`, `fxb`, `fxc`, `fxd`) simultaneously against the disposable socket.
   - Verify all 4 receive `200/202` on initial prompt; **zero probes are queued for retry**.

#### Definition of Victory for Phase 2 (DoV-2)
- [ ] Real model turns (`zai/glm-5.3-flash`) successfully completed across 4, 8, 12, and 14 concurrent sessions.
- [ ] Peak tasks sampled during 14 concurrent turns remain $< 1500$, comfortably inside `TasksMax=8192`.
- [ ] Peak memory sampled remains $< 4\text{ GiB}$, comfortably inside `MemoryMax=18G`.
- [ ] No `memory.events` (high, max, oom, oom_kill) recorded.
- [ ] All 4 Benchmark 1 synthetic probes start concurrently without any 503 refusal.
- [ ] **ANTI-VICTORY CHECK:** Do NOT claim victory if testing was done only with mocked fetch calls or if concurrency was tested serially instead of overlapping in time.

---

### Phase 3: Production Systemd & Environment Preparation

#### Intent
Safely update the host drop-ins, service unit, and production environment file to match the validated configuration without disrupting active processes.

#### Step-by-Step Procedure
1. **Apply Systemd Properties (Persistent Drop-ins):**
   ```bash
   systemctl set-property pi-web-ui.service TasksMax=8192
   systemctl set-property pi-web-ui.service MemoryMax=19327352832
   systemctl set-property pi-web-ui.service MemoryHigh=15032385536
   ```
2. **Update Service Unit Node Options:**
   In `/etc/systemd/system/pi-web-ui.service`, ensure:
   ```ini
   Environment=NODE_OPTIONS=--max-old-space-size=4096
   ```
3. **Update `/root/pi-web-ui/.env.production`:**
   Add/update the following keys:
   ```ini
   INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS=16
   INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE=2
   INTERNAL_API_ADMISSION_MIN_HEADROOM_MB=1536
   INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN=512
   INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN=96
   PI_MAX_SESSIONS=20
   ANTIGRAVITY_MAX_SESSIONS=10
   MAX_CLAUDE_PROCESSES=16
   ```
4. **Reload Systemd & Build:**
   ```bash
   systemctl daemon-reload
   npm run build
   ```

#### Definition of Victory for Phase 3 (DoV-3)
- [ ] `systemctl show pi-web-ui.service -p TasksMax -p MemoryMax -p MemoryHigh` outputs:
  - `TasksMax=8192`
  - `MemoryMax=19327352832` (~18 GiB)
  - `MemoryHigh=15032385536` (~14 GiB)
- [ ] `/root/pi-web-ui/.env.production` contains all 8 required environment variables.
- [ ] `npm run build` succeeds cleanly.
- [ ] **ANTI-VICTORY CHECK:** Do NOT claim victory if `systemctl set-property` failed or if `daemon-reload` was omitted.

---

### Phase 4: Gated Production Restart & Post-Verification

#### Intent
Execute an operator-authorized restart of `pi-web-ui.service` under the maintenance lock and prove that the admission bottleneck is permanently resolved in production.

#### Pre-Flight Maintenance Checks
1. Check `GET /api/v1/capacity`: verify `activeTurns == 0`.
2. Check `GET /api/v1/runs`: verify zero nonterminal/active run receipts.
3. Check host: verify no other agent is actively streaming in `pi-web-ui`.

#### Production Execution
1. Execute restart under production lock:
   ```bash
   scripts/with-production-lock.sh systemctl restart pi-web-ui.service
   ```
2. Wait for systemd readiness notification (`systemctl is-active pi-web-ui.service == active`).

#### Post-Restart Verification
1. **Query `/api/v1/capacity` on the production socket:**
   Assert that JSON response matches:
   ```json
   {
     "available": true,
     "activeTurns": 0,
     "maxActiveTurns": 16,
     "interactiveReserve": 2,
     "apiTurnLimit": 14,
     "controlReserve": 2,
     "executionCapacity": 14,
     "memory": {
       "limitBytes": 19327352832,
       "highBytes": 15032385536,
       "reservedBytesPerTurn": 536870912
     },
     "pids": {
       "max": 8192,
       "reservedPidsPerTurn": 96
     }
   }
   ```
2. **Empirical Benchmark 1 Verification:**
   Run Benchmark 1 dispatch in `/root/agent-benchmarks`:
   ```bash
   python3 /root/agent-benchmarks/benchmarks/01-workload-capability/execute_children.py --dry-run
   ```
   Followed by a live 4-probe concurrent dispatch test:
   - Observe that `fxa`, `fxb`, `fxc`, and `fxd` are **all prompted immediately** (HTTP 200/202).
   - Verify that **none** of the probes report `queued for prompt (admission capacity full, will retry in loop)`.

#### Definition of Victory for Phase 4 (DoV-4)
- [ ] `pi-web-ui.service` is active and healthy on port 3456.
- [ ] `GET /api/v1/capacity` returns `executionCapacity: 14`, `maxActiveTurns: 16`, `pids.max: 8192`, `reservedPidsPerTurn: 96`.
- [ ] 4 concurrent turns dispatch simultaneously without any `503 Service Unavailable` or `pid_pressure` refusals.
- [ ] `/root/agent-benchmarks/benchmarks/01-workload-capability/execute_children.py` executes all 4 specialist probes in parallel.
- [ ] The observation in `docs/ADMISSION-CAPACITY-BOTTLENECK-OBSERVATION.md` is verified fixed and documented as resolved.
- [ ] **ANTI-VICTORY CHECK:** Do NOT claim victory if `execute_children.py` still logs `queued for prompt` for probe 4.

---

## 6. Rollback Procedures & Values

If any regression occurs during Phase 4:

1. **Restore Systemd Properties:**
   ```bash
   systemctl set-property pi-web-ui.service TasksMax=1024
   systemctl set-property pi-web-ui.service MemoryMax=12884901888
   systemctl set-property pi-web-ui.service MemoryHigh=9663676416
   ```
2. **Restore Unit File:**
   In `/etc/systemd/system/pi-web-ui.service`, restore:
   ```ini
   Environment=NODE_OPTIONS=--max-old-space-size=2048
   ```
3. **Restore `.env.production`:**
   Restore original values:
   ```ini
   INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS=6
   INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE=1
   INTERNAL_API_ADMISSION_MIN_HEADROOM_MB=1536
   INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN=768
   ```
   Remove `INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN` and `PI_MAX_SESSIONS`.
4. **Reload & Restart:**
   ```bash
   systemctl daemon-reload
   systemctl restart pi-web-ui.service
   ```
5. **Verify Rollback:**
   Confirm `/api/v1/capacity` returns to `maxActiveTurns: 6`, `pids.max: 1024`.

---

## 7. Execution Checklist for the Implementing Agent

```markdown
- [ ] 1. Phase 1 (Code & TDD)
  - [ ] Write failing test for config.piMaxSessions in server/tests
  - [ ] Wire PI_MAX_SESSIONS in server/src/config.ts and connection.ts
  - [ ] Update DEFAULT_RESERVED_PIDS_PER_TURN to 96 in admission-controller.ts
  - [ ] Update DEFAULT_RESERVED_BYTES_PER_TURN to 512MB in admission-controller.ts
  - [ ] Update unit tests in admission-controller.test.ts and admission-explanation.test.ts
  - [ ] Run full server suite: verify 100% green (zero failures)
- [ ] 2. Phase 2 (Disposable Live Validation)
  - [ ] Start disposable server with Tier 2 configuration
  - [ ] Execute concurrent ladder (4 -> 8 -> 12 -> 14 turns) with real zai/glm-5.3-flash
  - [ ] Sample and log PID and memory peaks
  - [ ] Verify 4-probe parallel dispatch with zero 503s
  - [ ] Tear down disposable server cleanly
- [ ] 3. Phase 3 (Production Systemd & Configuration)
  - [ ] Apply systemctl set-property TasksMax=8192
  - [ ] Apply systemctl set-property MemoryMax=18G
  - [ ] Apply systemctl set-property MemoryHigh=14G
  - [ ] Update /etc/systemd/system/pi-web-ui.service (NODE_OPTIONS=--max-old-space-size=4096)
  - [ ] Update /root/pi-web-ui/.env.production
  - [ ] Run systemctl daemon-reload
  - [ ] Run npm run build
- [ ] 4. Phase 4 (Gated Production Restart & Benchmark Unblock)
  - [ ] Request explicit operator authority for production restart
  - [ ] Check capacity: activeTurns == 0, active runs == 0
  - [ ] Restart pi-web-ui.service under production lock
  - [ ] Verify live /api/v1/capacity output
  - [ ] Run execute_children.py in /root/agent-benchmarks and confirm all 4 probes run in parallel
  - [ ] Update docs/ADMISSION-CAPACITY-BOTTLENECK-OBSERVATION.md with resolution notes
```
