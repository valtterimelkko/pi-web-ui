# Pi Web UI Agent OS-First Resource Scaling and Runtime Lifecycle Hardening

**Status:** Phases 1–5 **COMPLETE**; Phase 0 baseline recorded; Phases 6–9 remain planned
**Supersedes:** the original plan at commit `b8d9109`
**Revision basis:** production evidence gathered 3–4 August 2026
**Execution report:** [`PI-WEB-UI-HARDENING-EXECUTION-REPORT.md`](./execution-reports/PI-WEB-UI-HARDENING-EXECUTION-REPORT.md)
**Primary repository:** `/root/pi-web-ui`
**Companion repository when explicitly named:** `/root/agent-os`
**Production service:** `pi-web-ui.service` on port `3456`
**Production operation rule:** use `npm run production:lock -- ...`; Caddy and unrelated services are out of scope and must not be restarted.

> **Completion boundary:** Phases 1–5 have been fully executed, validated, and
> recorded with a `proceed` decision in the execution report. This is not a
> claim that the conditional Phase 6–8 work or the final Phase 9 production
> rollout/observation is complete. Phase 3–5 production rollout remains
> intentionally gated by Phase 9.
>
> The execution report is the evidence record; this document retains the
> original acceptance criteria and remains the forward-looking plan for the
> phases that have not yet started. Do not convert a planned or unit-tested
> behaviour into a completion claim.
> Every production behaviour change requires recorded RED → GREEN evidence,
> affected-suite validation, disposable live validation where the behaviour can
> be exercised live, and the explicit pause/review gates below.

---

## Current execution status

| Phase | Status | Recorded evidence / boundary |
|---|---|---|
| 0 — Re-baseline | **BASELINE RECORDED** | `observed-production`; topology, ownership, rollback values, and safety gates captured. |
| 1 — OpenCode inactivation | **COMPLETE** | Disabled-runtime contract, disposable validation, and authorised production inactivation are recorded as `deployed-production`/`observed-production`. Task 1.4 was explicitly held: `/root/tmux` scopes were not touched. |
| 2 — Capacity and admission | **COMPLETE** | Service-cgroup truth, conservative admission, PID/host-pressure guards, bounded `TasksMax`, disposable validation, and production correction are recorded. |
| 3 — Lifecycle and readiness | **COMPLETE** | Ownership/fencing refinements, clean shutdown, truthful readiness, and OpenCode ownership safety are unit- and disposable-live validated. Production rollout is intentionally deferred to Phase 9. |
| 4 — Execution arbiter | **COMPLETE** | Priority reservations, bounded control lane, emergency mode, and the frozen benchmark/live evidence are recorded. Production rollout is intentionally deferred to Phase 9. |
| 5 — Agent OS integration | **COMPLETE** | Companion-repo verify + gap-fill, contract parity, durable capacity deferral, backpressure, P1 control, and exactly-once disposable live proof are recorded. |
| 6–9 | **PLANNED / NOT STARTED** | Worker-cgroup pilot, conditional expansion, capacity ramp/soak, and final production rollout remain future work. |

All phase-level completion claims above are backed by the linked execution report. A phase being complete does not waive its later production rollout or observation gate where the report explicitly leaves that gate for Phase 9.

## 1. Intent and operating priority

Pi Web UI is the local runtime gateway through which Agent OS executes and
supervises increasingly substantial work. Agent OS is expected to become a
high-volume, central part of the operator's work. Pi Web UI, Agent OS, and the
`/root/tmux` system are priority workloads on this host.

The plan therefore optimises for both:

1. **control-plane availability** — browser, Internal API, conductor recovery,
   cancellation, evidence reads, and owner interaction remain responsive; and
2. **useful Agent OS throughput** — normal and heavy delegated work can use the
   available host resources without artificial cold starts, over-conservative
   global throttling, or a duplicate orchestration system inside Pi Web UI.

The goal is not the largest possible simultaneous session count. The goal is
maximum **completed useful work per hour** while retaining deterministic
recovery, bounded failure domains, and responsive operator/conductor control.

The central invariants are:

> **Every accepted operation either completes what it promised or records an
> explicit terminal/failure outcome. Every resource claim has an owner, a
> bound, and a cleanup path.**

> **A terminal run receipt is not proof that its tools, descendants, workspace,
> or runtime are quiescent. Execution capacity is released only after the
> relevant runtime boundary is fenced and drained, or the outcome is recorded
> as unknown/quarantined.**

> **Agent OS owns work objects, orchestration policy, durable ready/deferred
> work, retries, and project/worktree authority. Pi Web UI owns local runtime
> admission, execution identity, resource containment, event/replay projection,
> and execution receipts.**

A larger memory budget is an intentional capacity decision. It is not a
substitute for lifecycle ownership, task/process containment, or admission
truth.

---

## 2. Current production evidence

This evidence is a dated operational snapshot. Counts will change; execution
must re-baseline rather than treating these numbers as permanent constants.
Do not copy prompts, transcript bodies, tokens, cookies, environment values, or
private payloads into the repository.

### 2.1 Host and service budget

As of 3 August 2026:

| Area | Observed state | Meaning |
|---|---|---|
| host memory | approximately 30 GiB total and approximately 20 GiB available during the latest review | The host has material headroom, but tmux scopes and external processes also consume it. |
| live Pi Web UI limit | `MemoryMax=12G`, `MemoryHigh=9G`, `MemorySwapMax=512M` through persistent `systemctl set-property` drop-ins | This is the approved interim budget. Keep a soft-pressure boundary below the hard maximum. |
| Node old-space | `NODE_OPTIONS=--max-old-space-size=2048` | Keep 2 GiB initially. A larger Node heap does not contain native or descendant-process memory. |
| current generation | approximately 3.6–3.8 GiB during active Agent OS work; observed current-generation peak approximately 5.9–6.4 GiB | Legitimate orchestration can approach the previous 6 GiB high boundary. The 12/9 budget is justified as headroom, not as permission for more unmeasured concurrency. |
| current cgroup events | no current-generation `high`, `max`, `oom`, or `oom_kill` increment at the latest sample | Useful current-window evidence only; the service cgroup is recreated on restart, so persist bounded summaries if historical trends are required. |

The previous 8 GiB max / 6 GiB high values are the immediate rollback target.
Do not set `MemoryHigh=MemoryMax`, increase Node old-space to 4 GiB, or raise
swap as part of the first hardening phases.

### 2.2 Incident-shaped evidence: one turn can become hundreds of tasks

Immediately before the 3 August recovery restart, `pi-web-ui.service` contained:

- 482 tasks;
- approximately 3.2 GiB memory peak under the old 4/3 GiB service budget;
- 512 MiB service swap peak;
- the main Node process blocked in `mem_cgroup_handle_over_high`; and
- an Agent OS-dispatched Pi session whose descendants included `npm test`, many
  Node test workers, TypeScript/esbuild helpers, and related subprocesses.

The service remained under one shared cgroup. One accepted turn could therefore
consume hundreds of PIDs/threads and substantial CPU/memory while counting as
only one admission lease. Increasing memory alone would merely allow that tree
to grow further before the browser/control plane became unresponsive.

Current `TasksMax` is approximately 37,558, effectively unbounded for this
workload. PID/task ownership and pressure telemetry are first-class resource
requirements, not optional observability.

### 2.3 Capacity endpoint is currently materially wrong

The current `/api/v1/capacity` implementation reads cgroup-root files rather
than the process's nested service cgroup. During review it reported:

- approximately 32.9 GiB `limitBytes` (host-sized) instead of 12 GiB;
- 16 total turns / 15 API turns from CPU-derived defaults;
- 256 MiB reserved per turn; and
- abundant projected headroom while the real service cgroup had a much smaller
  budget.

Agent OS performs capacity preflight. Incorrect capacity data can therefore
amplify load by telling the conductor that unsafe work is available. Correct
cgroup resolution and explicit production limits are P0.

### 2.4 Lifecycle and retained-state evidence

The original investigation and recheck found:

- 17 stop/start transactions since 20 July at the latest recount;
- application `Forced shutdown` records on 24, 29, 30, and 31 July and 1 August;
- a five-second application force-exit despite systemd's 30-second stop window;
- approximately 154 run receipts at the latest count, including a material
  historical `TURN_STALLED` population and restart-interrupted work;
- approximately 310 registry entries, five retention-lease files, and two watch
  ledgers at the latest bounded recount;
- route/service observer maps and replay tails whose lifecycle ownership is not
  complete; and
- queued Pi follow-ups that can be receipt-terminalised before the underlying
  SDK queue entry is conclusively fenced.

Registry count is not resident memory. Historical session deletion is not a
resource fix. Materialised sessions, active turns, descendants, observers,
watches, and resident claims must be measured separately.

### 2.5 OpenCode evidence and ownership boundary

OpenCode remains implemented and supported in the codebase, but the operator no
longer uses the Pi Web UI OpenCode runtime and wants it **temporarily inactive**
in production without deleting the implementation or historical state.

The review distinguished:

1. one Pi-Web-UI-managed `opencode serve` process on port 4097, approximately
   323 MiB RSS, inside `pi-web-ui.service`; and
2. 17 old `opencode serve` processes in five `twui-tmux-*.scope` cgroups,
   approximately 4 GiB combined RSS and historically about 48% aggregate CPU.

The 17 tmux-scope processes:

- were approximately 15–35 days old at inspection;
- had no established TCP connections at inspection;
- belonged to old transient tmux scopes whose historical session names were not
  present in the current `tmux list-sessions` output; and
- shared some scopes with stale Z.AI MCP servers and test-fixture processes.

They are strong orphan-cleanup candidates, but they are **not** Pi Web UI-owned.
Disabling OpenCode in Pi Web UI will stop only the managed backend. Stale tmux
scope cleanup is a separate, exact-scope, operator-authorised operation. Never
use broad `pgrep`, `pkill`, `tmux kill-server`, or process-name matching.

### 2.6 Agent OS boundary and performance evidence

Agent OS already:

- treats Pi Web UI as the runtime execution gateway;
- keeps work-object/attempt identity and policy in `/root/agent-os`;
- performs capacity preflight and durable receipt polling;
- separates runtime completion, evidence collection, acceptance assessment, and
  positive quiescence;
- supports up to four non-overlapping project worktree leases; and
- uses detached answer-mode turns, run receipts, and retained sessions for
  longer-lived work.

Agent OS transcript/session stability checks do not prove descendant cgroup
emptiness. Pi Web UI must eventually expose resource-boundary cessation evidence.
Do not solve that by moving Agent OS's work graph or governance state into Pi
Web UI.

### 2.7 Existing safeguards to preserve

- `RunReceiptStore.init()` converts persisted accepted/queued/started work to
  explicit restart-interrupted evidence.
- `RunReceiptManager` already has idle and absolute watchdog concepts.
- Pi session identity checks fail closed for missing files and filename/header
  mismatches.
- Internal API shutdown already tracks its own HTTP sockets through
  `closeServerWithGrace`.
- Source-owned retention is separate from human UI pin policy.
- Agent OS already uses stable idempotency/run identity and positive-quiescence
  gates for lease release.
- Disposable validation is the default; production validation requires explicit
  permission and `--allow-production`.

Do not reimplement these as unrelated refactors. Add regression tests where new
ownership or scheduling work intersects them.

---

## 3. Locked decisions and explicit deferrals

### 3.1 Approved interim memory posture

Keep in production until a later measured decision:

```ini
MemoryMax=12G
MemoryHigh=9G
MemorySwapMax=512M
Environment=NODE_OPTIONS=--max-old-space-size=2048
TimeoutStopSec=30
```

Treat 9 GiB as the practical pressure/admission boundary and 12 GiB as a hard
safety ceiling. A `memory.events.high` increment, sustained pressure near 9 GiB,
or degraded control latency must stop/defer background admission before another
memory increase is considered.

### 3.2 OpenCode is inactive, not removed

Production target:

```dotenv
OPENCODE_ENABLED=false
```

Keep:

- all OpenCode source and tests;
- OpenCode registry entries and runtime-native state;
- disposable/CI regression coverage where credentials and isolation permit;
- an explicit rollback path (`OPENCODE_ENABLED=true` + controlled restart).

The UI should truthfully show OpenCode as temporarily disabled/unavailable. Do
not silently select another runtime. Historical OpenCode sessions may remain
visible but unavailable for replay while the backend is disabled.

### 3.3 Agent OS remains the durable scheduler and authority

Pi Web UI may expose resource class, priority, queue/refusal, assignment,
fencing, and executor-drain fields needed for local runtime safety. It must not
become a second owner of:

- work-object identity;
- project/worktree authority;
- business dependencies;
- owner confirmation;
- semantic retry policy; or
- cross-system orchestration history.

A transactional local execution ledger may be considered later only if Pi Web
UI needs restart-survivable **local executor assignment**. It must remain a
projection beneath Agent OS authority. SQLite or a new `/api/v2/jobs` surface is
not required for the first hardening milestone.

### 3.4 Isolation is staged to avoid harming Agent OS

Do not immediately move every Pi turn through a cold new process.

First:

- make capacity truthful;
- add shared admission and priority reservations;
- make lifecycle cleanup and fencing correct; and
- add resource/latency evidence.

Then pilot isolated executors for long, tool-heavy Agent OS work while retaining
a measured fast path. Only expand isolation when the pilot proves acceptable
throughput, first-event latency, event fidelity, follow-up behaviour, and memory
cost.

### 3.5 No automatic concurrency increase

The 12 GiB ceiling does not authorize more turns or resident sessions.
Initial production guardrails remain:

```dotenv
INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS=6
INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE=1
INTERNAL_API_ADMISSION_MIN_HEADROOM_MB=1536
INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN=768
```

These are **Phase 2 target values**, not a claim about the currently enforced
production state. At the latest review the running endpoint still advertised
CPU-derived 16/15 turn limits. Until Phase 2 is deployed and observed, Agent OS
must ignore that unsafe advertised count and enforce a separately configured
maximum of four concurrent P2 executions (never more than its existing four
project leases); if that fixed ceiling cannot be verified, automated P2 fan-out
pauses. P0/P1 read, evidence, cancel, and recovery remain available.

These targets are temporary shared-cgroup guardrails, not proof of workload
isolation. Raise execution concurrency one slot at a time only after the defined
load/latency gates pass. Do not raise the current four-resident-Pi assumption to
eight in the critical path.

---

## 4. Target architecture

### 4.1 Near-term architecture

```text
Agent OS conductor + durable supervisor
  ├─ work objects / immutable plans / owner authority
  ├─ durable ready/deferred work and retry eligibility
  ├─ project/worktree leases
  ├─ bounded receipt polling and recovery
  └─ submits idempotent execution requests
                  │ Unix socket
                  ▼
Pi Web UI control plane
  ├─ shared Execution Arbiter for every prompt ingress
  │   ├─ P0 human/browser control reserve
  │   ├─ P1 Agent OS conductor/recovery reserve
  │   ├─ P2 normal Agent OS execution
  │   └─ P3 bulk/background work
  ├─ runtime services, receipts, replay, registry
  ├─ cgroup + host pressure telemetry
  └─ explicit refusal / Retry-After / cancellation
                  │
                  ├─ existing Pi worker path
                  ├─ exact-cgroup Pi worker pilot for heavy work
                  ├─ Claude runtime-specific paths
                  └─ Antigravity per-turn subprocess path
```

### 4.2 Later architecture, conditional on pilot evidence

```text
priority workload hierarchy
  ├─ pi-web-ui control service/cgroup
  │    HTTP, WS, auth, arbiter, receipts, registry, replay
  ├─ managed executor slice
  │    ├─ Pi per-active-session executors
  │    ├─ Claude runtime-appropriate executors
  │    └─ Antigravity per-turn executors
  ├─ agent-os-supervisor.service
  └─ tmux-web-ui.service + independently owned tmux scopes
```

Pi already has a process-per-active-session worker architecture through
`server/src/workers/worker-pool.ts`; it is not an embedded single-process runtime.
The missing boundary is an **exact per-worker/session cgroup and cross-process
resource assignment protocol**. The pilot therefore hardens the existing worker
path rather than creating a second executor system. The worker owns the
persistent `AgentSession`, queued follow-ups, extension/events, and descendants,
while the control process alone owns admission and assignment. Runs within that
worker use run identity and fencing epochs. Dormant historical sessions do not
retain a process.

OpenCode remains disabled in Pi Web UI. If re-enabled later, managed OpenCode
servers must be explicit shard/fault domains. External or tmux-owned servers are
attach-only and never automatically killed or included as managed capacity.

### 4.3 Priority classes

- **P0 — human interactive/control:** browser prompts, aborts, permission answers.
- **P1 — Agent OS control/recovery:** root/conductor wake, hard stop, receipt and
  evidence collection, cancellation, lease finalisation.
- **P2 — Agent OS execution:** ordinary delegated child turns.
- **P3 — bulk/background:** comparisons, refreshes, optional expanded evidence.

P2/P3 must not consume P0/P1 reserved control capacity. Scheduling is
non-preemptive at turn boundaries: do not destroy a valid active model turn to
admit a newer one. Use bounded fairness/aging for queued Agent OS work in Agent
OS; Pi Web UI returns truthful capacity/refusal rather than spinning or silently
queueing semantic work.

### 4.4 Performance-preserving choices

- Keep one or two unbound/warm Pi executor slots only if measured first-event
  improvement justifies their idle RSS.
- Keep a session executor warm for an adaptive idle interval when a retained
  follow-up/root wake is likely; do not preload every resident lease.
- Single-flight rehydration by session prevents a restart/queue stampede.
- High-volume Agent OS observation defaults to detached answers, `runId`, bounded
  receipt polling, `/wait`, and recent/screen transcript reads. SSE/full replay
  is opt-in for a human view or escalation.
- Persist authority-changing Agent OS transitions synchronously; coalesce routine
  polling/metrics so evidence durability does not become the throughput bottleneck.
- Use operator-defined resource profiles (`interactive`, `standard`, `heavy`,
  optionally `long-horizon`) rather than caller-selected raw cgroup values.
- Measure useful attempts/hour, queue delay, first-event latency, provider quota
  use, stall rate, executor RSS, drain time, and browser/conductor control latency.

---

## 5. Scope and non-goals

### In scope

- temporary production OpenCode inactivation while retaining implementation and
  historical state;
- exact, owner-authorised cleanup of confirmed stale tmux scopes;
- cgroup-v2 service-path resolution and host/service pressure telemetry;
- explicit shared capacity limits and stable refusal reasons;
- PID/task, memory, CPU/PSI, and descendant ownership evidence;
- lifecycle ownership for observers, brokers, watches, retention, queues, and
  shutdown;
- stalled/cancelled run fencing and late-event handling;
- a single execution-arbitration concept across browser and Internal API ingress;
- Agent OS priority/control reservations and caller-side defer/backpressure;
- a measured per-session cgroup pilot on the existing Pi worker path for heavy
  Agent OS work;
- truthful readiness/capacity/diagnostics and controlled rollout documentation.

### Explicitly out of scope

- deleting OpenCode implementation, tests, provider state, registry history, or
  historical sessions;
- broad killing by process name or stopping current tmux sessions;
- moving Agent OS work objects/governance into Pi Web UI;
- a mandatory Pi Web UI durable semantic job queue in the critical path;
- moving every Pi turn to a cold executor before pilot evidence;
- increasing resident sessions or concurrency merely because memory increased;
- Caddy, unrelated sites, provider credentials, Telegram secrets, auth policy,
  CSRF policy, or prompt-injection policy;
- production load validation without exact explicit operator authorisation;
- destructive session-file cleanup as a memory strategy.

---

## 6. Execution discipline and anti-premature-victory contract

### 6.1 Required reading

Before implementation, read completely:

- `AGENTS.md`, `docs/MAINTAINER-INDEX.md`;
- `docs/ARCHITECTURE.md`, `docs/PROCESS-ISOLATION-DESIGN.md`;
- `docs/EVENT-PIPELINE.md`, `docs/PROTOCOL.md`;
- `docs/INTERNAL-API.md`, `docs/INTERNAL-API-ORCHESTRATION.md`,
  `docs/INTERNAL-API-CONTRACT.md`;
- `docs/LIVE-VALIDATION.md`, `docs/LONG-HORIZON-VALIDATION.md`;
- `docs/OBSERVABILITY.md`, `docs/TROUBLESHOOTING.md`,
  `docs/SHARP-EDGES.md`;
- `DEPLOYMENT.md`, `docs/OPENCODE-DIRECT-INTEGRATION.md`;
- `docs/SELF-NOTIFICATIONS.md` and `docs/NOTIFICATIONS.md` §9;
- `/root/agent-os/docs/CURRENT-STATE.md` and its Pi Web UI contract mirror before
  companion changes; and
- skills `test-driven-development`, `systematic-debugging`, and
  `pi-web-ui-internal-api-orchestration` before corresponding work.

Use `scripts/notify.sh` only at meaningful phase gates, a real blocker/question,
and one final `done`. Never include secrets or private transcript bodies.

### 6.2 TDD is mandatory for every behaviour change

For each smallest production behaviour:

1. add one focused test;
2. run it against unchanged production code;
3. record the expected RED assertion failure;
4. confirm it failed because the behaviour is missing, not because the test is
   malformed;
5. implement the minimum GREEN change;
6. run the focused test and affected suite;
7. refactor only while green;
8. record exact commands and results in the implementation report.

If the test passes before implementation, it does not prove a new behaviour.
Either the behaviour already exists (record it as verified baseline, not newly
implemented) or the test is wrong. Production code written before RED must be
reverted and implemented again test-first.

Host configuration and documentation-only changes do not manufacture fake RED
tests. They require configuration parsing/contract tests where code behaviour
changes, plus docs/config validation and live smoke at their rollout gate.

### 6.3 Evidence levels — never collapse them

Every claim must use one of these labels:

- `planned`;
- `implemented-not-validated`;
- `unit-validated`;
- `integration-validated`;
- `live-validated-disposable`;
- `deployed-production`;
- `observed-production`.

A later label requires evidence for every earlier applicable gate. Unit tests do
not prove runtime behaviour. Disposable live validation does not prove a
production rollout. A successful restart does not prove an observation window.

### 6.4 Mandatory phase completion ledger

Each phase report must include:

- scoped files and behaviour;
- RED command/output summary per behaviour;
- GREEN command/output summary;
- affected suites;
- disposable live-validation target and exact scenario results;
- resource/process cleanup evidence;
- limitations/skips (a skip is not a pass);
- git status/diff summary;
- independent reviewer findings and disposition;
- rollback state; and
- the explicit pause decision: `proceed`, `hold`, `rollback`, or `needs owner`.

### 6.5 Independent review before each production gate

A reviewer that did not implement the phase must inspect:

- behaviour against acceptance criteria;
- missing RED chronology;
- cleanup/ownership leaks;
- security and compatibility regressions;
- unsupported completion language;
- process/cgroup scope safety; and
- whether the proposed next phase can reduce Agent OS throughput or control
  availability.

Critical/high findings block progression. Medium findings require explicit
accept/defer rationale. Do not self-sign-off by paraphrasing passing tests.

### 6.6 Systematic debugging

Any unexpected test, build, typecheck, live-validation, resource, or rollout
result starts a root-cause investigation. Do not weaken assertions, increase
timeouts blindly, raise memory again, or add retries before identifying the
failing boundary. Three failed fix hypotheses trigger an architecture pause.

### 6.7 Benchmark contract (must be frozen before Phase 4)

Record the baseline revision, host/service limits, enabled runtimes, model,
provider conditions, workload fixture versions, polling interval, raw result
location, and exact class proportions. The default mixed fixture is 10% P0, 20%
P1, 60% P2, and 10% P3; changing it requires recorded workload evidence before
baseline collection. Use at minimum:

- 30 deterministic local operations per P0/P1/P2 class for scheduler/control
  latency and cleanup;
- 10 representative real-runtime completions per affected path, over at least a
  30-minute mixed run, for end-to-end parity/throughput; and
- the same workload mix and concurrency for baseline and candidate.

Provider waiting time must be reported separately from local dispatch and
first-event overhead; do not claim it was removed when timestamps cannot prove
that. Promotion requires:

- 100% successful P1 read/cancel/recovery operations;
- local P1 and browser-control P95 no worse than both 2 seconds and 20% above
  baseline (use the stricter bound when baseline is measurable);
- useful real-runtime completions/hour no more than 10% below baseline unless the
  owner explicitly accepts a safety/throughput trade-off;
- deferred P2 dispatch no later than advertised `Retry-After` plus one configured
  Agent OS poll interval once capacity exists;
- terminal-to-owned-boundary drain P95 at most 10 seconds and maximum 30 seconds,
  otherwise quarantine;
- zero counter/observer/timer/lease/cgroup cleanup drift after every loop;
- zero `memory.events.max/oom/oom_kill` and `pids.events.max` increments in the
  control plane;
- every continuously eligible P2 starts within advertised `Retry-After` plus one
  poll interval after a permit becomes available; and
- eligible P3 ages into service within five permit-release cycles when no P0/P1
  pressure exists.

If the real provider cannot supply 10 comparable completions, label the gate
blocked or limited; do not substitute synthetic success for runtime parity.

---

## 7. Phased execution plan

## Phase 0 — Re-baseline, topology freeze, and execution safety (P0) — BASELINE RECORDED

**Status:** Baseline recorded as `observed-production`; no production code/config change. See the execution report for the captured topology, ownership classification, and Gate 0 decision.

**No production code change.**

Capture bounded evidence:

- service PID, unit/drop-ins, `MemoryCurrent/Peak/High/Max`, swap, TasksMax;
- actual cgroup path from `/proc/self/cgroup`;
- `memory.current/max/high/events/stat/pressure`;
- `pids.current/max/events`, CPU/IO pressure, process tree;
- host available memory/swap/load and top aggregate process families;
- `/health`, `/api/health/ready`, authenticated `/api/v1/health`, `/capacity`;
- active/stalled receipts, materialised sessions, registry count, leases, watches,
  observer/broker metrics available today;
- current Agent OS attempts/supervisor state without reading prompt bodies;
- actual enforced admission values and whether Agent OS is obeying the temporary
  fixed P2 ceiling rather than the unsafe `/capacity` advertisement;
- actual Pi worker topology: parent/worker PIDs, worker/session mapping, current
  `PI_MAX_WORKERS`/memory/idle policy names, cgroup membership, and whether the
  canonical process-isolation design matches implementation;
- Pi-Web-UI-managed versus tmux-scope OpenCode PIDs, ports, ages, cgroups,
  connections, and complete scope members; and
- current `tmux list-sessions` and exact current scope identities.

Also record hashes/contents of the non-secret memory and TasksMax drop-ins and
the exact pre-change rollback values. Reconcile the tracked `DEPLOYMENT.md`
example (which may lag the live 12/9 budget) without treating generic deployment
documentation as live host evidence.

Before every production restart in this plan, Agent OS enters a recorded
maintenance handshake: stop new P2/P3 dispatch, retain P1 evidence/cancel access,
inventory active run IDs and recovery owners, drain to an explicit criterion or
mark each remaining run interrupted/unknown, then reopen dispatch only after
readiness and capacity are verified.

Add a dated execution report. Do not copy live state into tracked fixtures.

**Gate 0 checks:**

```bash
npm run docs:check-agent-guides
npm run docs:check-links
npm run internal-api:wait
```

**PAUSE 0 — mandatory:** a reviewer confirms ownership classification and that
current active tmux/Agent OS work will not be touched. No OpenCode cleanup or
production change may begin before `proceed` is recorded.

---

## Phase 1 — Temporarily inactivate Pi Web UI OpenCode and reclaim only proven stale scopes (P0 operational) — COMPLETE

> **Phase status: COMPLETE (`proceed`).** The disabled-runtime contract, disposable
> validation, and authorised production inactivation passed their recorded gates.
> The stale tmux-scope cleanup was correctly **held/no-op** because those scopes
> belong to `/root/tmux`; no current tmux work or historical OpenCode state was
> touched. See the execution report for evidence and rollback state.

### Task 1.1 — Preserve product support while documenting temporary inactivation

Update as needed:

- `docs/OPENCODE-DIRECT-INTEGRATION.md` — optional/inactive runbook, state
  preservation, safe rollback, managed/external ownership;
- `DEPLOYMENT.md` and `.env.example` comments — exact effect of
  `OPENCODE_ENABLED=false` without changing the public default casually;
- `docs/INTERNAL-API-CONTRACT.md`, `docs/INTERNAL-API.md`, and capability types —
  version/add the disabled-runtime contract;
- `docs/ARCHITECTURE.md`, runtime overview/feature matrix where they claim live
  production availability rather than supported capability;
- this plan's execution report; and
- UI copy only if needed to distinguish `temporarily disabled` from an auth or
  installation failure.

Specify exact existing stable errors per operation: session creation/transfer
uses `RUNTIME_UNAVAILABLE`; OpenCode-only model/backend operations use
`OPENCODE_UNAVAILABLE`. Capabilities must expose `enabled=false` distinctly from
installed/healthy state. Historical listing remains available; operations that
require backend replay fail read-only with the contracted error and do not mutate
or silently substitute a runtime.

If UI/API behaviour changes, TDD RED cases must prove:

- disabled runtime is advertised as disabled/unavailable, not unhealthy or
  silently substituted;
- new OpenCode creation and transfer fail closed with stable bounded errors;
- historical registry entries remain and are not deleted;
- Pi/Claude/Antigravity capabilities remain unchanged; and
- disabled startup does not spawn or attach to OpenCode.

Do not remove OpenCode from shared runtime types, tests, disposable validation,
or implementation.

### Task 1.2 — Disposable disabled-runtime validation

Boot a disposable server with `OPENCODE_ENABLED=false` and prove:

- health/capabilities identify OpenCode as disabled;
- the browser new-session and transfer surfaces disable OpenCode;
- direct Internal API OpenCode creation is refused without a receipt/side
  effect;
- no disposable managed `opencode serve` remains after shutdown; and
- Pi and Claude smoke scenarios still pass.

Use `webapp-testing` for the localhost UI state and the Internal API runner for
backend truth. The production browser is not the test target.

### Task 1.3 — Production inactivation (authorised service operation)

Under one production lock and after explicit rollout authority plus the Agent OS
maintenance handshake:

1. inspect `systemctl show pi-web-ui.service -p EnvironmentFiles` and modify the
   exact configured untracked environment source (currently expected to be
   `/root/pi-web-ui/.env.production`) to set `OPENCODE_ENABLED=false`, without
   printing any environment values;
2. restart `pi-web-ui.service` only;
3. wait for Internal API readiness;
4. verify the new service process received `OPENCODE_ENABLED=false` using a
   redacted key-only/equality check against `/proc/<pid>/environ` (never print the
   environment) and that capabilities report disabled;
5. verify the previous managed port 4097/PID is gone and no replacement was
   spawned;
6. verify health/capabilities/UI truth for all runtimes;
7. compare stable before/after registry IDs and bounded runtime-native locators,
   not only counts, to prove historical entries were preserved; and
8. verify Caddy and tmux services/PIDs were untouched before reopening Agent OS
   P2/P3 dispatch.

### Task 1.4 — Exact stale tmux-scope cleanup

This is separate from Pi Web UI inactivation and requires its own explicit owner
pause decision.

For each candidate scope:

- re-list every process, port, age, connection, memory, CPU, and command;
- prove no current tmux session maps to the scope;
- prove it is not the current execution agent/conductor scope;
- record the unit invocation ID, active-enter timestamp, cgroup path, main/control
  group identity, and complete sorted member set;
- immediately before stop, atomically re-read and match that identity/member set;
  unit reuse, membership drift, a new connection, or any mismatch means **hold**;
- stop the exact systemd scope under an operation lock/record appropriate to the
  tmux system;
- verify the exact cgroup is empty/inactive and its ports are gone; and
- record reclaimed memory/CPU.

Never kill by executable name. If any scope contains an ambiguous process or
active connection, leave it intact and ask the owner.

### Phase 1 quality gate

- focused config/UI/API tests GREEN with recorded RED where behaviour changed;
- disabled disposable backend + browser validation GREEN;
- production smoke GREEN only after authorisation;
- no current tmux session affected;
- no historical OpenCode data deleted;
- independent review complete.

**PAUSE 1 — mandatory:** report separately:

- Pi Web UI OpenCode status;
- managed process result;
- each tmux scope cleaned/held and why;
- reclaimed resources; and
- rollback command/config.

Do not call the broader hardening plan complete.

---

## Phase 2 — Truthful cgroup/host capacity and conservative admission (P0 code) — COMPLETE

> **Phase status: COMPLETE (`proceed`).** Capacity now resolves the actual service
> cgroup, admission is conservative and pressure-aware, `TasksMax` is bounded,
> disposable nested-cgroup validation passed, and the production correction was
> observed with direct cgroup/API parity. See the execution report for evidence.

### Task 2.1 — Resolve actual process cgroup

Files:

- `server/src/internal-api/admission-controller.ts`;
- focused admission/cgroup helper tests;
- `server/src/config.ts`, types, capacity docs.

RED tests:

- parse cgroup-v2 `0::/system.slice/pi-web-ui.service` from injected
  `/proc/self/cgroup`;
- resolve nested slice/service directories safely beneath an injected cgroup
  root;
- prefer service `memory.current/max/high` over cgroup-root/host values;
- handle `memory.max=max`, missing/invalid files, v1/non-cgroup fallback;
- reject traversal/symlink escape in injected fixtures;
- expose bounded source metadata without leaking machine-specific sensitive
  paths; and
- prove a 12 GiB service reports approximately 12 GiB rather than host RAM.

### Task 2.2 — Add memory, PID, and pressure truth

Capacity/diagnostics should include low-cardinality:

- service current/high/max/headroom and source;
- process RSS and V8 heap limit separately;
- `memory.events` deltas/current counters;
- `pids.current/max/events`;
- CPU/IO/memory PSI summaries;
- host available memory/pressure as a separate gate because tmux/external work
  is outside the service cgroup;
- active/stalled/draining turns; and
- configured reservations and refusal reason.

Unknown telemetry must be labelled. It must not become a fabricated numeric
limit. Missing service telemetry should conservatively refuse/defer P2/P3 work
while preserving bounded P0/P1 control where safe.

### Task 2.3 — Explicit conservative production configuration

RED tests:

- no CPU-derived production default silently becomes 15+ turns;
- `6/1/1536/768` configuration projects correctly;
- duplicate release cannot underflow;
- memory, PID/task, host-pressure, runtime, and global limits return distinct
  stable refusal reasons and `Retry-After`;
- stalled/draining work is represented separately from reusable capacity; and
- Agent OS capacity preflight sees the same resource truth used by final prompt
  admission.

Apply explicit production env values only after code/live gates pass. Consider a
conservative service-level `TasksMax` only after a bounded normal/heavy workload
inventory; an initial candidate range is 512–768, not a blind fixed decision.
Prove normal builds/tests do not hit it and that a bounded fork-heavy fixture is
refused before selecting a value. If selected, apply it under the production lock
with `systemctl set-property pi-web-ui.service TasksMax=<measured-value>`, verify
`systemctl show ... -p TasksMax`, direct `pids.current`, and normal-build/task
high-water evidence. Record the exact pre-change value (approximately 37,558 at
the latest review) and roll back with another explicit `set-property`; never use
a broad `systemctl revert` that could remove memory drop-ins.

### Phase 2 live validation

Add a disposable/systemd-transient validation scenario such as
`capacity-cgroup-truth` that runs under a known nested cgroup and asserts exact
memory/PID source and refusal behaviour. Do not infer this from unit fixtures
alone.

Also run Pi/Claude smoke and receipt idempotency to prove admission has not
broken ordinary execution.

### Task 2.4 — Compatibility and authorised production correction

Before rollout, update the current Agent OS client minimally to capability/version
check the corrected contract, fail conservative on unknown/mismatched capacity,
and retain the temporary fixed ceiling. This compatibility patch does not wait
for the broader Phase 5 scheduling work.

After disposable gates and explicit authority, use the production lock and Agent
OS maintenance handshake to deploy the corrected capacity source and explicit
`6/1/1536/768` target values. Observe direct cgroup/API parity and safe Agent OS
preflight before reopening P2/P3. The unsafe 16/15 advertisement must not remain
until Phase 9.

### Phase 2 quality gate

```bash
# focused RED/GREEN commands first
npm run typecheck
npm run build
npm test --workspace=server
```

Plus disposable `capacity-cgroup-truth`, `smoke`, and
`run-receipt-idempotency` evidence, followed by the separately authorised locked
production correction and observation.

**PAUSE 2 — mandatory:** compare `/capacity` with `systemctl show` and direct
cgroup files. Any material mismatch blocks progression; restore the fixed Agent
OS ceiling or pause automated P2 fan-out.

---

## Phase 3 — Lifecycle ownership, fencing, shutdown, and readiness (P0 code) — COMPLETE

> **Phase status: COMPLETE (`proceed`).** Lifecycle ownership, drain/quarantine
> safeguards, clean shutdown, truthful readiness, and managed-versus-attached
> OpenCode safety are unit- and disposable-live validated. Production rollout of
> this code remains intentionally reserved for Phase 9; that is not a Phase 3
> incompleteness. See the execution report for the accepted deferrals and evidence.

### Task 3.1 — Observer, broker, watch, and retention ownership

TDD must prove:

- persistent observer attach is idempotent and stores removable callbacks;
- unload/delete/dispose removes the exact owner callbacks, queue correlations,
  grace timers, extension snapshots, and subscriptions;
- rehydration can attach fresh observers;
- broker replay is bounded by count, age, sessions, and preferably bytes;
- active SSE/watch/notification owners keep required observation alive until
  final unsubscribe;
- watch expiry/replace/delete releases only its own claim;
- reloaded watch evidence stays detached until explicitly re-registered;
- resident leases have bounded count/TTL and durable-only leases do not
  materialise sessions; and
- repeated lifecycle loops return maps/timers/subscribers/materialised sessions
  to baseline.

`InternalApiEventBroker.clear()`/`clearAll()` already exist. Do not claim their
creation as new work; test and fix ownership calls around them.

### Task 3.2 — Fence stalled/cancelled queued Pi work

TDD RED cases:

- idle `follow_up` promotes and completes normally;
- busy queued follow-up starts only on its exact delivered user-message
  evidence;
- watchdog terminalisation requests runtime cancellation and fences the exact
  queue item;
- another queued client's work is preserved;
- late `agent_end`/tool/event evidence cannot create a second terminal success;
- admission/execution capacity is not reusable while runtime cessation is
  unknown/draining; and
- restart recovery preserves explicit interrupted/uncertain evidence.

Receipt status, runtime cancellation acknowledgement, descendant/runtime drain,
observer removal, and admission release must be ordered and idempotent.

Phase 3 must distinguish two resources instead of pretending the shared service
cgroup proves per-session quiescence:

1. a **turn permit** may be released only after the runtime adapter's exact
   stop/idle acknowledgement and queue fencing; and
2. **resource-boundary quiescence** is provable only after the existing Pi worker
   has an exact per-session cgroup in Phase 6.

For the interim worker/shared-cgroup path, absent stop acknowledgement retires or
quarantines that session and keeps a conservative non-reusable execution slot.
A bounded reconciler owns retry/inspection; after 30 seconds it records unknown
and requires operator recovery. Version the receipt/capacity contract so terminal
answer status does not silently imply resource release.

### Task 3.3 — Shutdown single-flight and complete

TDD RED cases:

- repeated SIGTERM/SIGINT/fatal-trigger calls share one promise;
- teardown attempts every owner even if one fails;
- main HTTP keep-alives, WebSockets, SSE, watches, observers, runtime services,
  timers, notification/run-receipt writes, and owned children close;
- normal completion exits 0 without `Forced shutdown`;
- last-resort timeout is aligned below systemd's 30-second window and clearly
  reports unresolved resources; and
- late callbacks after teardown are fenced.

### Task 3.4 — Truthful readiness

TDD must separate:

- V8 `heap_size_limit` percentage;
- process RSS;
- service cgroup current/high/max;
- host pressure;
- admission state (`ready`, `degraded-not-accepting-background`, `not-ready`);
- optional disabled runtime health; and
- control/read/cancel availability from new-execution availability.

A high `heapUsed/heapTotal` allocation ratio alone must not make the server
unready.

### Task 3.5 — Retain OpenCode ownership safety while disabled

Even with production OpenCode inactive, remove/fence broad external process
killing before any future re-enable:

- managed versus attached identity is explicit;
- attached external service is never recycled/killed automatically;
- managed stop uses exact owned process/cgroup identity;
- disabled shutdown is idempotent; and
- OpenCode-specific live validation remains disposable and optional, not a
  production rollout requirement.

### Phase 3 live validation

Run on disposable targets:

- `stalled-run-reaped` with a short watchdog;
- follow-up and strict follow-up scenarios;
- `notify-on-agent-end` capture channel;
- a new `shutdown-clean` scenario proving exit 0, socket removal, and no owned
  descendants;
- a repeated load/unload/watch-expiry loop proving counts return to baseline;
- Pi and Claude smoke/receipt idempotency; and
- optional OpenCode ownership regression in a disposable server despite
  production disablement.

### Phase 3 quality gate and pause

Focused suites → server suite → typecheck/build → disposable live matrix →
independent review.

**PAUSE 3 — mandatory:** no shared arbiter or executor work begins until stalled
runs, shutdown, readiness, and retained-object ownership are green without
resource-count growth.

---

## Phase 4 — One execution arbiter and priority reservations (P0/P1 code) — COMPLETE

> **Phase status: COMPLETE (`proceed`).** The shared priority arbiter, bounded
> control lane, emergency mode, and frozen benchmark/live validation are complete.
> Production rollout remains intentionally gated by Phase 9. See the execution
> report for the measured acceptance evidence and explicitly deferred work.

### Task 4.1 — Define one admission and assignment authority

Browser/WebSocket prompts, Internal API prompts, execution-state materialisation,
and Pi worker assignments must use one control-process authority. Reconcile the
existing worker-pool and runtime-local limits so they are subordinate safety
ceilings, not independent admission systems.

Use one atomic assignment state machine for initial prompts and queued
follow-ups:

```text
reserved → assigned(worker, epoch) → executing
         → terminal-awaiting-drain → released | quarantined
```

Only the control process transitions/admit/dequeues work and grants a permit;
workers report readiness/events/drain and may not self-admit. Follow-ups must
reacquire a permit before delivery. Persist/reconcile enough assignment identity
to prevent control process and worker both owning a run after restart. A future
separate cgroup worker does not get a separate counter.

Do not route read-only health, receipt, cancellation, approval response, or
bounded evidence reads through a saturated execution queue.

### Task 4.2 — Introduce P0/P1/P2/P3 classes

Additive contract fields may expose class, refusal, and reservation. Priority is
server-derived authority, never a caller-trusted label:

- authenticated browser-origin prompt/control maps to P0;
- a narrowly separate Agent OS control identity/capability maps only enumerated
  root-wake, receipt/evidence, cancel, and lease-finalisation operations to P1;
- ordinary authenticated Internal API prompt execution defaults to P2;
- P3 is server/config-assigned bulk work.

Define separate execution permits and bounded non-execution control budgets,
reserve/borrowing/debt rules, and an emergency mode that refuses new execution
while preserving read/cancel/evidence. If the current shared bearer token cannot
distinguish Agent OS control identity safely, add that trusted Unix-socket
identity/capability before P1 is enabled; callers cannot submit `priority=P1`.

TDD RED cases:

- saturated P2/P3 cannot consume P0 browser/abort/approval capacity;
- saturated child work cannot consume P1 Agent OS root-wake/cancel/evidence
  capacity;
- P0/P1 actions remain bounded and cannot bypass all memory/PID safety;
- no starvation under weighted/aged P2 admission;
- final prompt admission remains atomic after preflight;
- disconnect/cancel semantics remain origin-correct;
- capacity and diagnostics show class counts without high-cardinality labels;
- browser and Internal API work cannot double-acquire or leak a lease; and
- an old client receives compatible stable behaviour.

Pi Web UI should reject/defer excess semantic work with stable `429` and
`Retry-After`; it must not silently invent a durable semantic queue.

### Task 4.3 — Shared-ingress live validation

Add a disposable mixed-ingress scenario:

- saturate P2 with bounded synthetic/real turns;
- prove a browser-WebSocket P0 control action remains responsive;
- prove a P1 Agent OS cancel/evidence request completes;
- prove extra P2 is refused/deferred without a receipt leak;
- release work and prove capacity returns exactly; and
- repeat to detect counter drift.

For localhost browser validation use `webapp-testing`; use the exact browser-WS
driver when protocol-level control is the subject.

### Performance gate

Measure unloaded versus saturated:

- health/capacity/read/cancel latency;
- browser admission and first-event latency;
- P1 root-wake/control latency;
- useful completion throughput; and
- CPU/RSS/PID overhead.

Use the frozen §6.7 benchmark contract. Do not replace its sample sizes and
numeric thresholds with a qualitative claim.

**PAUSE 4 — owner decision:** if the arbiter breaches any §6.7 throughput or
control-latency threshold, hold and tune from evidence. Do not proceed to worker
cgroup changes to hide an arbiter regression.

---

## Phase 5 — Agent OS backpressure and throughput integration (companion repo) — COMPLETE

> **Phase status: COMPLETE (`proceed`).** The companion-repo verify + gap-fill
> closed the Phase 5 deltas, including durable preflight deferrals, contract
> mirror parity, backpressure, P1 control, lease release, and exactly-once
> disposable live proof. No production dispatch or restart was claimed. See the
> execution report for the complete evidence record.

This phase changes `/root/agent-os` only after the Pi Web UI contract required
by Phase 4 is implemented and documented. Use a separate branch/commit and the
Agent OS repository's own instructions and TDD gates.

### Task 5.1 — Keep durable ready/deferred work in Agent OS

Agent OS should persist:

- ready/deferred state;
- priority/resource class;
- stable idempotency/run request identity;
- capacity refusal and next eligible retry;
- owner-authorised retry policy;
- P1 control/recovery work independent of P2 child execution; and
- project/worktree lease correctness.

Do not busy-loop on `429`, create speculative sessions, or hold a project lease
while merely waiting for generic execution capacity unless the existing
authority contract requires and documents it.

### Task 5.2 — Low-overhead supervision

TDD must prove default use of detached answers, run receipts, bounded polling,
and recent transcript projection. Permanent SSE/full transcript collection is
opt-in. Persist authority-changing events synchronously while coalescing routine
observations.

### Task 5.3 — Cross-repo contract parity

Update the Agent OS Pi Web UI contract mirror and installed orchestration skill
only from canonical sources. Verify contract version/capability before dispatch.
OpenCode must be removed from current route recommendation/availability, not
from historical evidence or generic runtime types.

### Phase 5 live validation

Use a disposable Pi Web UI server and disposable/owned Agent OS work object:

- fill P2 capacity;
- observe durable defer with Retry-After;
- prove P1 supervisor/root action still executes;
- later dispatch exactly once with the same authority/idempotency identity;
- collect terminal receipt/output;
- prove project and retention leases release only after positive evidence; and
- clean all task-owned state/processes.

**PAUSE 5 — mandatory:** compare useful attempts/hour and conductor control
latency against the frozen §6.7 baseline. No worker-cgroup pilot proceeds if any
threshold or recovery-correctness gate fails.

---

## Phase 6 — Per-session cgroup hardening pilot for the existing Pi worker path (P1 architecture) — PLANNED / NOT STARTED

> **Agent OS dependency:** Phase 6 does not need to wait for the Agent OS MVP or
> for Step 7C/7F. Step 7C/7F is conductor/model-comparison evidence, not the
> primary resource-containment test. Use an owned disposable heavy-work fixture
> that exercises the real Pi worker path, descendants, cancellation and drain;
> later Agent OS conductor missions may provide representative workload evidence
> but must not be the only way to test the boundary.
>
> **Recommended Phase 6 shape — executor-containment conformance harness:** this
> is not a hand-authored set of realistic Agent OS tasks and not a mock of the
> worker/cgroup boundary. Build one reusable deterministic fixture that drives
> the real worker/RPC/arbiter/event/receipt path while substituting only the
> workload/provider behaviour. Its scenarios should cover: a normal tool turn;
> bounded child-process fan-out; bounded memory/PID pressure; cancellation while
> active; intentional worker failure and rehydration; late-event fencing; server
> restart with unknown/draining state; and repeated start→drain→dispose cycles.
> Run it at low pilot concurrency first. The fixture supplies repeatable
> lifecycle/resource evidence without requiring the operator to invent a new
> real-world task for every development iteration.
>
> **Execution ownership:** the execution agent is responsible for forming the
> fixture proposal and the exact disposable test setting, including scenario
> parameters, resource bounds, concurrency, safety limits and evidence to
> collect. The operator's role in test design is only to approve or decline the
> proposal; the execution agent owns any revision and the operator does not
> invent the task or tune every stage. The execution agent must freeze the
> approved fixture version and settings in the Phase 6 evidence. Phase 8A must
> reuse that exact approved fixture/settings as its baseline; any change requires
> a new proposal,
> approval, version and re-baseline. This does not remove the owner's separate
> PAUSE 6 choice about promote, hybrid, hold or rollback.

Pi already uses process-per-session workers. This is deliberately a containment
and assignment pilot on that existing architecture, not a new parallel executor
system or immediate migration of every worker.

### Task 6.1 — Inventory and harden the existing worker boundary

Before design changes, reconcile `docs/PROCESS-ISOLATION-DESIGN.md` with the
actual `worker-pool`, RPC, memory-limit, follow-up, crash, and cgroup behaviour.
Update the canonical design if it overstates isolation. Reuse the existing worker
RPC/event bridge; do not create a second session executor authority.

Define a small runtime-neutral control-process handle such as:

- `start(assignment, eventSink)`;
- `cancel(handle, reason)`;
- `observe/reconcile(handle)`;
- `dispose(handle)`;
- `resourceIdentity(handle)`; and
- `drain/quiescence(handle)`.

Events are fenced by session/run/attempt epoch. Late events become evidence only
and cannot complete a newer run or free capacity twice.

### Task 6.2 — Pi per-active-session worker cgroup boundary

The pilot hardens an existing worker. The worker owns:

- one persistent Pi `AgentSession` while active/warm;
- exact session JSONL identity and fail-closed rehydration;
- queued follow-ups;
- extension/UI/normalized events;
- all tool and subagent descendants; and
- cgroup/process resource identity.

Launch/reparent the existing worker through a managed systemd transient
service/scope or equivalent exact cgroup boundary with `KillMode=control-group`,
memory high/max, bounded swap, TasksMax, CPU weight/quota as measured, and drain
evidence from `cgroup.events.populated` or equivalent. The main control-process
arbiter remains authoritative across these cgroups.

Process groups alone are not sufficient for daemonised/double-fork descendants.

### Task 6.3 — Route only measured heavy Agent OS work first

Pilot eligibility is operator/config controlled, for example a bounded
`heavy`/`long-horizon` resource profile. Keep ordinary interactive/short work on
the proven path initially. Never let caller-provided raw limits bypass policy.

TDD RED cases:

- heavy Agent OS work enters the isolated executor;
- a bounded fork/test fixture reaches only that executor's PID/memory boundary;
- control-plane health/browser/P1 cancellation remain responsive;
- cancellation empties the executor cgroup or records quarantine/unknown;
- terminal receipt cannot release capacity while the cgroup remains populated;
- worker crash/OOM affects one session, records resource failure, and preserves
  durable session state;
- rehydration is single-flight and identity-safe;
- queued follow-up/event ordering retains parity;
- extension and notification events remain exactly once;
- idle disposal removes the cgroup/process and observer state; and
- legacy uncontained and pilot-contained worker paths cannot concurrently own
  the same Pi session.

### Task 6.4 — Warmth and adaptive idle policy

Benchmark cold start, warmed module/runtime, session rehydration, and one/two
unbound warm slots. Adopt warmth only if first-event P95 improves materially
without reducing safe concurrency or keeping stale session ownership.

Prewarm only imminent retained/root-wake sessions. Do not equate resident lease
with permanent process residency.

### Phase 6 adversarial live validation

On a disposable/transient executor hierarchy:

- ordinary Pi tool turn;
- bounded test-worker/process fan-out (safe fixture, never a real fork bomb);
- memory/PID limit event;
- abort during tool execution;
- executor crash and rehydrate;
- queued follow-up and late-event fencing;
- server restart while executor state is running/unknown;
- repeated start/drain/dispose cycles;
- notification capture and browser-WS event parity; and
- simultaneous P0/P1 control under heavy P2 executor load.

Record control-plane and executor cgroup events separately.

### Pilot performance acceptance

Compare the current worker path versus exact-cgroup heavy workers:

- dispatch→admission latency;
- admission→first-event latency (exclude provider response where possible);
- total completion time and useful attempts/hour;
- base and peak RSS;
- PID/task high-water;
- event/replay parity;
- cancellation/drain time;
- browser/P1 latency; and
- provider quota/retry differences.

**PAUSE 6 — explicit owner choice:**

- `promote` — expand per-worker cgroup containment;
- `hybrid` — retain exact cgroups only for heavy workers;
- `hold` — keep pilot off and fix measured problems;
- `rollback` — remove pilot routing while retaining evidence.

A green unit/live suite is insufficient if any §6.7 throughput or conductor
latency threshold fails.

---

## Phase 7 — Conditional broader worker/runtime containment rollout (P2, not pre-authorised by earlier phases) — PLANNED / NOT STARTED

Execute only after PAUSE 6 records `promote` or a bounded `hybrid` expansion.

Possible work:

- migrate more active Pi sessions to per-session executors;
- split the control service into a protected cgroup with higher CPU/IO weight;
- place managed executors under an aggregate slice;
- add runtime-appropriate Claude containment where direct/SDK/channel semantics
  permit it;
- retain Antigravity per-turn containment;
- add local executor assignment persistence only if restart reconciliation cannot
  be made truthful with current receipts/Agent OS state.

Every runtime migration is its own RED→GREEN→disposable-live→performance gate.
Do not bundle all runtimes into one refactor. OpenCode remains disabled unless a
separate owner decision reactivates it.

**PAUSE 7 per runtime:** compare parity, throughput, memory, control latency,
recovery, and rollback before enabling the next runtime/path.

---

## Phase 8 — Capacity ramp, observability, and sustained proof (P1/P2) — PLANNED / NOT STARTED

Phase 8 has two formal evidence tracks, **8A** and **8B**. They are not extra
numbered roadmap phases, but they have different workloads, acceptance claims
and maturity dependencies.

### 8A — Platform ramp/soak (maturity-independent)

Use the exact operator-approved Phase 6 fixture version and exact test settings
at increasing concurrency on disposable infrastructure. Do not redesign the
workload for 8A: the frozen Phase 6 fixture is the comparison baseline. This can
proceed before Agent OS MVP and does not require the operator to invent bespoke
real-world tasks. Any necessary change is an execution-agent proposal requiring
operator approval, followed by a new fixture version and re-baseline.

### 8A.1 Concurrency ladder

Run 1, 3, 5, and 6 concurrent fixture turns across the enabled pilot paths.
Increase one P2 slot only after the prior level passes. Do not include disabled
OpenCode in any capacity claim.

At each level sample:

- service and executor cgroup memory/PID/pressure/events;
- host headroom/PSI and tmux workload pressure;
- `/capacity`, readiness, receipt and class counts;
- broker/observer/watch/lease/timer counts;
- first-event and completion latency;
- P0 browser and P1 control latency; and
- cleanup/drain time.

#### 8A.2 Platform acceptance targets

- no control-plane `oom`, `oom_kill`, `max`, or unexpected sustained `high`;
- resource exhaustion is contained to the assigned executor and recorded;
- every accepted fixture run reaches terminal or explicit unknown/quarantined
  state;
- no capacity release while its executor remains populated;
- no duplicate terminalisation or false success;
- no unbounded process, observer, broker, timer, lease, or watch growth;
- P0/P1 control meets the §6.7 absolute/P95 thresholds; and
- all task-owned disposable state/processes are cleaned.

### 8B — Representative Agent OS proof (maturity-gated)

Begin 8B only when the owner considers the conductor reliable enough for
representative workflows. This does not require waiting for a formal Agent OS
MVP label, and the MVP label alone is not sufficient evidence. Use naturally
arising owner work or a small bounded owner-selected sample; do not invent a new
bespoke task for every test stage.

#### 8B.1 Representative workload and soak

Run the relevant mixed P0/P1/P2 ramp and a bounded several-hour soak with actual
Agent OS dispatch, defer/backpressure, recovery and long-running work. Long-
horizon watches must expire/release claims, restart as detached evidence, and be
re-registered explicitly.

#### 8B.2 Product acceptance targets

- Agent OS queue/defer age and retry behaviour remain bounded;
- P1 recovery and browser control meet the §6.7 absolute/P95 thresholds;
- no Agent OS project/class starvation;
- useful attempts/hour stays within the §6.7 regression threshold versus the
  prior safe level;
- every accepted run reaches terminal or explicit unknown/quarantined state;
- no capacity/worktree release while its executor remains populated;
- no duplicate terminalisation or false success;
- no unbounded process, observer, broker, timer, lease, or watch growth; and
- all task-owned disposable state/processes are cleaned.

**PAUSE 8 — capacity promotion:** 8A may promote at most one platform slot
within the tested fixture and its evidence boundary. Any Agent OS real-workload
capacity promotion requires 8B. On disposable infrastructure, stop or roll
back the harness automatically on pressure, stalls, control-SLO breach or
cleanup drift. Production rollback is never an unlocked autonomous mutation: it
must use the pre-authorised threshold, recorded rollback values, Agent OS
maintenance handshake and production lock.

---

## Phase 9 — Controlled production rollout and observation — PLANNED / NOT STARTED

**Phase 9 is the final numbered phase in this Pi Web UI plan.** Its rollout
sequence is explicit:

1. **8A passes** using the frozen Phase 6 fixture/settings.
2. A **limited safety rollout follows 8A**, under the existing conservative
   capacity and with a bounded observation window. This is an interim safety
   observation, not completion of Phase 9 and not an Agent OS scaling claim.
3. **8B completes** once the conductor is reliable enough for representative
   owner workflows.
4. **Full Phase 9 remains pending until 8B is complete.** Full Phase 9 includes
   any production capacity promotion, increased-concurrency claim, or mature
   Agent OS real-workload rollout/observation.

If 8B is not yet justified, full Phase 9 must remain pending and the limited
rollout must remain strictly bounded; it cannot be used to promote concurrency
or claim mature Agent OS scaling. Production code/config rollout requires
explicit operator authorisation after all applicable gates.

### Preflight

- clean/reviewed Git state and exact source revision;
- full diff and secret/artifact inspection;
- current production PID, ports, unit/drop-ins, env key names, and lock;
- build artifact timestamp;
- current Agent OS/tmux active work and pause-safe window;
- exact runtime/process ownership classification;
- rollback code/config/unit values; and
- Caddy PID/config recorded but untouched.

### Locked operation

Use one coherent locked operation where practical so build/config/restart cannot
interleave with another deployment. Restart only `pi-web-ui.service`.

Immediate checks:

- service active with fresh PID;
- Internal API ready;
- `/health`, readiness, `/api/v1/health`, `/capacity`, capabilities correct;
- memory approximately 12/9 GiB and Node old-space 2 GiB;
- OpenCode disabled with no managed backend;
- Pi/Claude/Antigravity expected availability;
- expected child cgroups/processes only;
- no `Forced shutdown`, `EADDRINUSE`, broad kill, or secret-bearing log;
- Agent OS P1 control read/cancel path available; and
- tmux/Caddy unchanged.

### Observation window

Do not send final `done` immediately after restart. Observe:

- memory/PID/pressure events and RSS;
- capacity/refusals/class counts;
- receipt stalls/unknown/drain outcomes;
- Agent OS defer/throughput/control latency;
- browser responsiveness;
- observer/watch/lease cleanup;
- executor/process growth; and
- stop/restart cause evidence.

Rollback under the production lock on material regression. The immediate memory
rollback is 8 GiB max / 6 GiB high with Node old-space still 2 GiB. Preserve
receipts and bounded diagnostics; do not delete history.

**PAUSE 9 — final production verdict:** `observed-production` requires the
observation window, not merely startup health.

---

## 8. Validation matrix by phase

| Phase | Unit/TDD | Integration | Disposable live | Browser/WS | Production |
|---|---|---|---|---|---|
| 0 baseline | n/a | docs checks | none | none | read-only evidence |
| 1 OpenCode inactive | config/API/UI tests where changed | disabled startup/shutdown | disabled-runtime + Pi/Claude smoke | localhost disabled UI | authorised restart; exact process verification |
| 2 capacity truth | cgroup/admission RED→GREEN | route/config/types | nested-cgroup truth + refusal | optional capacity UI | rollout only after review |
| 3 lifecycle | observer/queue/shutdown/readiness RED→GREEN | affected route/runtime suites | stalled, follow-up, notification, shutdown, cleanup loop | WS event/abort where relevant | later smoke only |
| 4 arbiter | priority/admission RED→GREEN | mixed ingress | saturated P2 with P0/P1 proof | browser-WS + localhost | no load by default |
| 5 Agent OS | Agent OS RED→GREEN | contract mirror/client | disposable end-to-end defer→dispatch | none required | no production dispatch by default |
| 6 worker-cgroup pilot | adapter/worker/cgroup RED→GREEN | event/replay/follow-up | heavy/fork-bounded/crash/drain matrix | WS parity | pilot only after owner choice |
| 7 expansion | per-runtime RED→GREEN | full affected runtime | per-runtime live matrix | as affected | one path at a time |
| 8A platform / 8B Agent OS proof | fixture/harness tests | load harness + Agent OS integration when mature | concurrency/soak | latency regression | 8A/8B only as applicable and explicitly authorised |
| 9 rollout | prior gates retained | full suite | prior evidence | smoke | locked deploy + observation |

A capability skip is evidence of missing coverage, not a pass. Antigravity live
validation remains separately authorised because its conversation state is not
disposable-safe.

---

## 9. Repository quality gates

Run focused commands after each RED/GREEN behaviour. Before any Pi Web UI
commit/production gate run:

```bash
npm run docs:check-agent-guides
npm run docs:check-links
npm run lint
npm run typecheck
npm run build
npm test
```

When applicable:

```bash
npm run test:e2e
npm run benchmark:quick
npm run benchmark
```

For Agent OS companion changes, run its canonical focused/full test, offline
validation, contract parity, and any authorised disposable live-validation
gates documented in `/root/agent-os`.

Before commit/push:

```bash
git status --short
git diff --stat
git diff --cached --stat
git diff --check
```

Explicitly inspect for `.env*` values, tokens, cookies, auth dumps, session JSONL,
notification spools, validation directories, process dumps containing private
payloads, generated test output, and local machine artifacts. None may be
committed.

A gate is **blocked**, not passed, when:

- RED was not recorded before production code;
- a new test passed immediately and was mislabelled TDD;
- a disposable test touched production state;
- a runtime-affecting phase lacks applicable live validation;
- a skip is represented as coverage;
- capacity differs materially from direct cgroup evidence;
- a normal SIGTERM still reports forced/status-1 failure;
- a terminal receipt is used as descendant/workspace quiescence proof;
- a child process/scope is unclassified;
- a tmux/external process is killed broadly;
- P2 saturation can block P0/P1 control;
- Agent OS useful throughput/control latency regresses without an owner-approved
  trade-off;
- cleanup counts fail to return to baseline;
- a critical/high independent-review finding remains open;
- Caddy or an unrelated service is restarted; or
- completion is claimed before the required pause/observation gate.

---

## 10. Rollback principles

Every phase must have a narrow rollback that preserves evidence:

- OpenCode: the safe rollback for Phase 1 code/UI regressions leaves
  `OPENCODE_ENABLED=false` and reverts only the new presentation/contract change.
  Re-enabling is prohibited until Phase 3.5 exact managed/attached ownership
  safety is deployed and disposable-live validated; after that separate owner
  authorisation may restore `true` under the maintenance handshake/lock. Never
  recreate deleted historical state because none should be deleted.
- stale tmux scopes: no automatic recreation; ambiguous scopes are held rather
  than stopped.
- memory: restore 8G max / 6G high, keep 2G Node heap and 512 MiB swap.
- admission/arbiter: restore prior explicit conservative caps, not CPU-derived
  defaults.
- Agent OS defer logic: retain attempts/receipts and stop dispatch rather than
  minting replacement identity.
- worker-cgroup pilot: disable pilot routing and return eligible work to the
  proven worker path only after exact worker drain/ownership reconciliation.
- runtime expansion: roll back one runtime/path without reverting unrelated
  validated lifecycle fixes.

Never roll back by deleting run receipts, session files, registry history,
leases, watches, or evidence.

---

## 11. Definition of done

### 11.1 Critical hardening complete

The critical milestone is complete only when:

- production OpenCode is intentionally disabled and its managed backend absent;
- every cleaned tmux scope was exact, inactive, owner-authorised, and evidenced;
- `/capacity` matches the real service cgroup and exposes host/PID pressure;
- explicit conservative admission is deployed;
- stalled/cancelled work is fenced without false capacity release;
- observers, broker tails, watches, leases, queues, and timers are owned/bounded;
- normal shutdown is single-flight and clean;
- readiness is truthful and disabled optional runtimes do not create false
  failure;
- one shared arbiter protects P0 human and P1 Agent OS control from P2/P3
  saturation;
- focused/full quality gates and applicable disposable live validation pass;
- independent review has no unresolved critical/high findings; and
- production observation, not only restart, is recorded.

### 11.2 Agent OS scaling milestone complete

The scaling milestone is complete only when:

- Agent OS owns durable ready/deferred work and handles Pi Web UI backpressure
  without duplicate dispatch or busy-looping;
- P1 conductor/recovery remains available under P2 saturation;
- the heavy Pi worker-cgroup pilot contains descendants and proves
  drain/quarantine;
- event/replay/follow-up/extension/notification parity is live-validated;
- measured Agent OS useful throughput and control latency meet the Phase 6
  acceptance gate;
- the owner has recorded `promote` or an explicitly bounded `hybrid`; and
- no broader executor migration is claimed complete unless its separate pause
  gate passed.

A `hold` or `rollback` is a valid safe pilot outcome but means the scaling
milestone remains paused/incomplete; it must never be reported as completion.

### 11.3 Final report requirements

The execution report must include:

- exact revisions and commands;
- per-behaviour RED→GREEN chronology;
- unit/integration/live evidence with target classification;
- resource/cgroup/PID measurements;
- OpenCode/tmux ownership and cleanup disposition;
- Agent OS throughput/control-latency comparison;
- independent review findings/dispositions;
- every pause decision;
- production rollout/observation/rollback status;
- secret/artifact inspection; and
- one final Telegram `done` notification only after the actually authorised
  milestone—not the entire conditional roadmap—is complete.
