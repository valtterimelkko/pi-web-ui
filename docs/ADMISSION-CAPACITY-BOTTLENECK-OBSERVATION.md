# Admission Capacity Bottleneck & PID Pressure Observation

> **Date:** 2026-09-11  
> **Source:** Conductor & Benchmark Multi-Child Dispatch Workloads  
> **Target:** \`/root/pi-web-ui/server/src/internal-api/admission-controller.ts\`  
> **Component:** Admission Controller · Internal API · Resource Governance

---

## 1. Executive Summary

During automated multi-child orchestration and parallel capability benchmarking (e.g. running 4 specialist probes concurrently in Benchmark 1, or parent conductor + 2 concurrent children in Benchmark 2), the system consistently rejects the 4th concurrent turn with:

\`\`\`json
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "error": "ADMISSION_CAPACITY_EXHAUSTED",
  "reason": "pid_pressure",
  "retryAfterSeconds": 2,
  "detail": "currentTasks=11 reservedTasks=1024 projectedTasks=1035 taskLimit=1024"
}
\`\`\`

Despite the service reporting \`executionCapacity: 5\` and \`maxActiveTurns: 6\`, and despite the host having **24 GB of available RAM** and idle CPU, **the admission controller hard-caps actual concurrent turns at 3**. Any attempt to dispatch a 4th turn is blocked.

---

## 2. Mathematical Root Cause

In \`server/src/internal-api/admission-controller.ts\`:

1. **Systemd Cgroup Limit (\`pids.max\` / \`taskLimit\`):**
   * The production systemd unit drop-in (\`/etc/systemd/system.control/pi-web-ui.service.d/50-TasksMax.conf\`) configures:
     \`\`\`ini
     [Service]
     TasksMax=1024
     \`\`\`
   * \`readServicePidsCapacity()\` correctly reads \`/sys/fs/cgroup/system.slice/pi-web-ui.service/pids.max\` as \`1024\`.

2. **Per-Turn Reservation Constant (\`reservedPidsPerTurn\`):**
   * Line 189 of \`admission-controller.ts\` hardcodes:
     \`\`\`typescript
     reservedPidsPerTurn: 256,
     \`\`\`

3. **PID Pressure Assertion (\`evaluatePressure()\` lines 349-350):**
   \`\`\`typescript
   const pidPressure = pids.max !== undefined && pids.current !== undefined
     && pids.current + ((activeExecutionTurns + 1) * this.reservedPidsPerTurn) >= pids.max;
   \`\`\`

4. **The Arithmetic Bottleneck:**
   * Baseline host service tasks: \`pids.current ≈ 11\`.
   * When 0 turns active: \`11 + (0 + 1) * 256 = 267 < 1024\` → Turn 1 admitted.
   * When 1 turn active:  \`11 + (1 + 1) * 256 = 523 < 1024\` → Turn 2 admitted.
   * When 2 turns active: \`11 + (2 + 1) * 256 = 779 < 1024\` → Turn 3 admitted.
   * When 3 turns active: \`11 + (3 + 1) * 256 = 1035 >= 1024\` → **Turn 4 REFUSED (503)**.

The formula guarantees that:
$$\text{Max Admitted Turns} = \left\lfloor \frac{\text{TasksMax} - \text{pids.current}}{\text{reservedPidsPerTurn}} \right\rfloor = \left\lfloor \frac{1024 - 11}{256} \right\rfloor = 3$$

Even though \`executionCapacity\` is set to 5, the PID pressure gate triggers at turn 4 every time.

---

## 3. Real-World Impact on Agent Workloads

1. **Multi-Agent Benchmarks & Orchestration:**
   * Standard bounded multi-agent patterns recommend 2–4 concurrent children.
   * In Benchmark 1 (4 probes: \`fxa-coursekit\`, \`fxb-reconcile\`, \`fxc-module\`, \`fxd-dashboard\`), all 4 cannot start in parallel. The 4th probe is starved until one of the first three completes.
   * In Benchmark 2, if a parent orchestrator runs 2 concurrent children and attempts to dispatch a third (e.g. dynamic defect investigation or feasibility subagent), it risks an immediate 503 failure.
2. **Artificial Serialization:**
   * Total benchmark wall-clock time increases because independent, non-interfering workloads are forced into sequential batches.
   * Agents that do not implement exponential backoff on 503 crash or abort their goals prematurely.

---

## 4. Empirical PID Usage vs Conservative Reservation

* In practice, each active Pi coding session turn spawns:
  * 1 Node.js process / worker thread.
  * 1 sub-shell or tool execution process (\`bash\`, \`git\`, \`python\`, or compiler).
  * Observed task count per active turn: **5 to 25 tasks**.
* The current reservation of **256 PIDs per turn** assumes an extreme 10x–50x safety factor.
* While defensive, this safety factor directly collides with \`TasksMax=1024\`.

---

## 5. Potential Remediation Paths (For Investigation)

1. **Increase Systemd \`TasksMax\` (Host Level):**
   * Change \`TasksMax=1024\` to \`TasksMax=4096\` or \`TasksMax=8192\` via:
     \`\`\`bash
     systemctl set-property pi-web-ui.service TasksMax=4096
     \`\`\`
   * With \`TasksMax=4096\` and \`reservedPidsPerTurn=256\`, the PID ceiling would support up to 15 concurrent turns before pressure.
2. **Tune \`reservedPidsPerTurn\` (Application Level):**
   * Adjust default \`reservedPidsPerTurn\` from 256 down to 64 or 96 in \`admission-controller.ts\` (or make it an environment variable / configuration knob \`PI_WEB_UI_RESERVED_PIDS_PER_TURN\`).
   * At 64 PIDs/turn within \`TasksMax=1024\`, the system safely accommodates $\lfloor (1024 - 50) / 64 \rfloor = 15$ concurrent turns.
3. **Dynamic PID Projection:**
   * Base projection on measured average PID consumption per runtime rather than a worst-case 256-PID flat reservation.
