# Pi Web UI Agent OS-First Resource Scaling and Runtime Lifecycle Hardening

**Status:** Phases 0–6 **COMPLETE**; Phase 7 Pi/Internal API shadow implementation **COMPLETE — PAUSE 7: CONTINUE SHADOW**; **Phases 8–9 PAUSED 2026-08-20 by owner decision — see "Programme pause" below.** Contained routing and production observation remain unauthorised
**Supersedes:** the original plan at commit `b8d9109`
**Revision basis:** production evidence gathered 3–5 August 2026
**Execution report:** [`PI-WEB-UI-HARDENING-EXECUTION-REPORT.md`](./execution-reports/PI-WEB-UI-HARDENING-EXECUTION-REPORT.md)
**Primary repository:** `/root/pi-web-ui`
**Companion repository when explicitly named:** `/root/agent-os`
**Production service:** `pi-web-ui.service` on port `3456`
**Production operation rule:** use `npm run production:lock -- ...`; Caddy and unrelated services are out of scope and must not be restarted.

> ## Programme pause — 2026-08-20
>
> **Phases 8 and 9 are paused by owner decision. This plan is not abandoned, not
> failed, and not waiting for anyone to pick it up.** Everything already recorded
> as complete stays complete and in service; nothing needs unwinding or
> re-validating.
>
> **Why.** This plan is Agent OS-first by name and by premise: it was written in
> anticipation of heavy conductor-to-child Internal API traffic. **That premise
> changed on the Agent OS side.** Agent OS paused conductor development on
> 2026-08-19 for a couple of months, and the work that replaced it is local CLI
> work on its memory layer, not concurrent Pi sessions. The anticipated load is
> not arriving in that window.
>
> **The plan already gates itself here.** Phase 8B begins "only when the owner
> considers the conductor reliable enough for representative workflows", and
> Phase 9 states that if 8B is not yet justified, full Phase 9 must remain
> pending. **8B's entry condition is not met.** Recording the pause respects that
> gate rather than overriding it.
>
> **What measured evidence says about the risk of stopping here** (host read-only
> observation, 2026-08-20): service memory `220 MB` against a `12 GiB` limit;
> peak since restart `638 MB`; `memory.events` `low/high/max/oom/oom_kill` **all
> zero**; cumulative service memory-pressure stall time **zero**; tasks 11 of
> `TasksMax=1024`; host ~19 GiB available with PSI zeros; no kernel OOM in 14
> days. The service has never reached even its `high` watermark. This is
> `observed-production` read-only evidence and nothing more: it does not certify
> behaviour under load that has not been run.
>
> **What is complete and in service.** Phases 1–5 are the protective half and
> they are live: OpenCode inactivation, truthful cgroup/host capacity with
> conservative admission, PID and pressure guards, bounded `TasksMax`, lifecycle
> ownership and fencing, clean shutdown, truthful readiness, the single execution
> arbiter with priority reservations and bounded control lane, and Agent OS
> backpressure/defer/P1 control. Phase 6 is a bounded hybrid whose pilot stays
> **off** outside disposable validation; Phase 7 stays **shadow-only** with no
> contained routing.
>
> **What is deliberately not being done.** Phases 8A, 8B and 9 buy **capacity**,
> and capacity is not the constraint at ~2% of the provisioned memory limit.
> Promoting concurrency that will not be used is work without payoff.
>
> **The accepted residual risk, stated plainly.** Phase 6's per-session cgroup
> containment is implemented but not routed, so a single runaway session is not
> contained to its own session and can climb toward the service limit. The blast
> radius is a `pi-web-ui.service` restart rather than host exhaustion, bounded by
> the 12 GiB cap on a 30 GiB host, `TasksMax=1024` against fork storms, and the
> arbiter's admission ceiling. It has never fired. **This is an accepted risk,
> not an unnoticed one.**
>
> **What resumes this plan.** Any of: conductor development restarting at Agent OS
> with concurrent dispatch; a sustained rise in ordinary Web UI workload; or any
> non-zero `memory.events` counter, observed pressure, or OOM on
> `pi-web-ui.service`. **8A is the natural resumption point** — it is
> maturity-independent, uses the frozen Phase 6 fixture, and should run **before**
> new traffic arrives rather than during it.
>
> **Ownership boundary.** The changed premise is Agent OS's to report and is
> recorded on that side. Whether Pi Web UI needs the remaining hardening for its
> **own** workload — ordinary long-running browser sessions, growing transcripts,
> real tool work — remains a Pi Web UI decision. Neither repository certifies the
> other's readiness.

> **Completion boundary:** Phases 1–6 have been fully executed, validated, and
> recorded in the execution report. PAUSE 6 authorises only a bounded hybrid
> direction for later design and evidence: it does not enable a production
> route, create a second public API, or pre-authorise Phase 7–9 rollout. Phase 7
> remains conditional and Phase 9 retains the production rollout/observation
> gate.
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
| 3 — Lifecycle and readiness | **COMPLETE** | Ownership/fencing refinements, clean shutdown, truthful readiness, and OpenCode ownership safety are unit- and disposable-live validated. The phase itself did not restart production; a later operator-requested latest-code restart brought the committed Phase 3/4 generation into service. |
| 4 — Execution arbiter | **COMPLETE** | Priority reservations, bounded control lane, emergency mode, and the frozen benchmark/live evidence are recorded. Read-only production recheck on 5 August observed contract 1.16.0, `controlReserve=1`, `maxActiveTurns=6`, service-cgroup memory truth and `TasksMax=1024`; the binary does not embed an exact Git revision, so do not overstate provenance. |
| 5 — Agent OS integration | **COMPLETE** | Companion-repo verify + gap-fill, contract parity, durable capacity deferral, backpressure, P1 control, and exactly-once disposable live proof are recorded. |
| 6 — Worker-cgroup pilot | **COMPLETE — BOUNDED HYBRID** | Frozen fixture, contained-heavy boundary, adversarial validation, final review and cleanup passed. The pilot remains off outside disposable validation; the decision constrains any later expansion to one canonical API and automatic server-owned policy. |
| 7 — shadow gate | **SHADOW IMPLEMENTED / PAUSE 7: CONTINUE SHADOW** | Pi/Internal API shadow classification is implemented and disposable-live validated; owner chose continued shadow evidence; no contained routing or production observation is authorised. |
| 8–9 | **PAUSED 2026-08-20** (was planned / not started) | Owner decision: the anticipated Agent OS conductor load is not arriving in this window and 8B's own maturity gate is not met. Nothing started, nothing unwound. Resumption trigger and accepted residual risk are in "Programme pause" above. |

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

### 1.1 Operational story and decision lens

This plan began after repeated real use, not as an abstract isolation project.
As Agent OS Internal API traffic and very long ordinary Web UI sessions grew,
the service became heavy enough that the operator sometimes had to restart Pi
Web UI, approximately daily during the worst period. The original service
budget was approximately 4 GiB max / 3 GiB high. Raising it to 12 GiB max /
9 GiB high provided necessary headroom, but the triggering evidence also showed
that one accepted turn could create hundreds of tasks and place the main Node
process under shared-cgroup pressure. A larger budget alone could delay rather
than contain the same failure.

The roadmap therefore has two related but distinct hypotheses:

1. truthful capacity, conservative admission, lifecycle ownership and P0/P1
   reservations can reduce avoidable overload and preserve control; and
2. selected session runtimes/process trees may need their own failure boundary
   so one tool-heavy or state-heavy session cannot make the whole Web UI require
   restart.

Neither hypothesis should be converted into a claim that every long session is
resource-heavy, that containment reduces total memory, or that Agent OS caused
all observed pressure. Long-lived browser sessions are an explicit part of the
original problem statement and must remain in the evidence programme. Future
agents should use this history when deciding whether to expand, hold or reverse
containment: optimise for a Web UI that stays available under real work, not for
shipping a second execution path merely because the pilot exists.

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

> **Owner-authorised human-pin exception — 2026-09-02.** The operator explicitly
> authorised raising the human Web UI pin allowance from two to five per runtime.
> This is a bounded interactive-residency policy change, not an inference from the
> larger memory ceiling and not authority to raise active-turn admission,
> execution concurrency, or the Pi four-session soft cache. RED/GREEN tests cover
> five accepted human claims, sixth-claim refusal, and independent source-owned
> Internal API/watch claims. Disposable browser-WebSocket validation reproduced
> that boundary for Pi, Claude SDK, and Command Code with 296,464,384 bytes RSS,
> zero high/OOM events, no PID pressure, and no host pressure. Production was not
> restarted or used for validation; production rollout still requires its own
> explicit gate.

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

The repository contains a worker-oriented architecture through
`server/src/workers/worker-pool.ts`, but it is **not the current production Pi
prompt authority**. Ordinary `/ws`, `/ws/sessions/:id` and Internal API Pi
traffic still resolve through `MultiSessionManager` and an in-process Pi SDK
`AgentSession`; the Phase 6 adapter/worker route is dormant outside its
conformance harness. The pilot hardens that candidate worker boundary without
claiming it is already the live architecture. If later activated, the worker
would own one persistent `AgentSession`, queued follow-ups, extension/events and
descendants, while the control process remains authoritative for admission and
assignment. Dormant historical sessions must not retain a process.

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

## Phase 6 — Per-session cgroup hardening pilot for the existing Pi worker path (P1 architecture) — COMPLETE / BOUNDED HYBRID

> **Execution record (2026-08-05):** the frozen fixture passed unit, integration and disposable live validation. Final evidence is `/tmp/pi-web-ui-phase6-8YjMEM/summary.json`; independent final review returned GO. The owner recorded PAUSE 6 as the bounded `hybrid` defined below. Ordinary Pi traffic remains unchanged and the pilot remains off outside validation. See [`execution-reports/PI-WEB-UI-HARDENING-EXECUTION-REPORT.md`](./execution-reports/PI-WEB-UI-HARDENING-EXECUTION-REPORT.md#phase-6--per-session-cgroup-hardening-pilot).

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

### Phase 6 executed fixture/evidence record — `worker-cgroup-conformance` v1

**Status: owner-approved fixture executed successfully; PAUSE 6 bounded `hybrid` recorded.**

**Approval record:** The operator approved the complete `worker-cgroup-conformance/v1`
fixture, settings and implementation boundary on 2026-08-05. The settings are
now frozen for Phase 6 and 8A. Any change requires a new proposal, approval,
fixture version and re-baseline.

#### Preflight finding that fixes the implementation boundary

The repository currently contains two different Pi execution shapes, and they must
not be conflated in the evidence:

- the live browser WebSocket and Internal API Pi prompt paths call
  `MultiSessionManager`/`AgentSession` in the server process;
- `WorkerPool`, `SessionWorker`, `SessionRPCClient`, and the new
  `SessionWebSocketHandler` are present, but the main WebSocket upgrade path and
  Internal API prompt path do not use them; and
- `SessionWorker.spawn()` currently invokes the literal `pi` command and does not
  apply a cgroup launcher, assignment identity, run/epoch fence, or receipt
  lifecycle. `WorkerManagerConfig.piPath` is not currently used by that spawn
  path.

Therefore a test that merely instantiates `WorkerPool` would not prove the stated
worker/RPC/arbiter/event/receipt boundary, and a production Pi prompt would not
prove per-worker containment. Phase 6 Task 6.1/6.3 must first add one minimal,
server-derived pilot adapter/launcher seam and wire the explicit `heavy` pilot
profile through that seam. Ordinary interactive Pi work remains on the current
path until a later gate. If the seam cannot create an exact disposable cgroup,
the heavy route must fail closed; it must never silently fall back to an
uncontained heavy worker.

This is a prerequisite for truthful Phase 6 evidence, not permission to migrate
all Pi sessions or to claim that the current worker classes are already the live
Pi architecture. The canonical process-isolation design must be corrected or
made precise in the same task before any pilot result is described as production
parity. The existing `RunReceiptManager` only defers release for cancelled or
failed runs, so the pilot adapter must also wait for the worker's active-turn
quiescence before treating a normal `agent_end` as the terminal capacity
boundary (or add that behaviour test-first). A raw `agent_end` while the worker
still reports active work is evidence, not permission to release the turn.

#### Fixture identity and invariant settings

| Field | Frozen v1 value |
|---|---|
| Fixture name/version | `worker-cgroup-conformance/v1` |
| Semantic workload | A local deterministic JSONL worker fixture; no provider, network, model, repository, or real Agent OS task. Only provider/workload semantics are substituted. |
| Real boundaries exercised | The pilot adapter's real assignment, `WorkerPool`/`SessionWorker`, RPC framing, `SessionRPCClient`, normalized event sink, `AdmissionController`, `RunReceiptManager`, cgroup launcher, cancellation/drain, crash recovery, and disposal paths. |
| Pilot profile | Server-derived `heavy`; no caller-supplied raw cgroup values. The ordinary/default Pi path is unchanged in the pilot run. |
| Initial concurrency | One worker/run at a time; one independent sibling worker is created only for the isolation/crash scenario. |
| Worker pool | `maxWorkers=2`, explicit disposal, `idleTimeoutMs=60000`, cleanup interval disabled in the fixture and stopped in teardown. |
| RPC/readiness | `commandTimeoutMs=2000`, `readinessFallbackMs=250`; every command has a correlated response and every run has an event-derived terminal boundary. |
| Receipt/admission | `maxActiveTurns=2`, `interactiveReserve=1`, `controlReserve=1` (one P2 execution slot), `retryAfterSeconds=1`, `turnIdleTimeoutMs=2000`, `turnMaxMs=10000`, `drainTimeoutMs=2000`, `drainPollMs=50`; receipt directory is a mode-0700 temporary directory. |
| Worker runtime budget | `maxOldSpaceSize=128` MB. The worker unit uses cgroup-v2 `MemoryHigh=128M`, `MemoryMax=384M`, `MemorySwapMax=0`, `TasksMax=64`, `CPUWeight=100`, `KillMode=control-group`, and `TimeoutStopSec=10s`. `CPUQuota` is unset. |
| Control runtime budget | The disposable controller/server is a separate transient unit with `MemoryHigh=768M`, `MemoryMax=1G`, `MemorySwapMax=0`, `TasksMax=256`, and `KillMode=control-group`. No production unit is reused. |
| Sampling | Two warm-up normal turns, then 30 measured warm turns and five cold start/dispose samples for each plain-spawn baseline and contained-worker candidate. Adversarial scenarios run three times each; churn runs 20 cycles. |
| Evidence cadence | Sample cgroup memory/PID/events and process membership every 100 ms; poll drain/quiescence every 50 ms; record raw JSON evidence under the disposable run directory, never in tracked fixtures. |

The worker launch must use a unique transient service/unit (for example
`pi-web-ui-phase6-<nonce>-worker-<session>.service`) in a disposable
`pi-web-ui-phase6-<nonce>.slice`, created with `systemd-run --pipe --wait
--collect` or an equivalent exact cgroup launcher. The unit name and the actual
worker cgroup path resolved from `/proc/<worker-pid>/cgroup` are evidence, not
inputs. The implementation must not mistake the `systemd-run` client PID for the
worker PID, and must record the complete descendant PID set. Cgroup-v2 or
transient-unit capability failure is `blocked`, not a simulated pass. Teardown
must stop only the nonce-matched units, verify `cgroup.events:populated=0` and
an empty member set, then verify the units were collected. It must not touch
`pi-web-ui.service`, `tmux-web-ui.service`, `twui-*` scopes, or any existing
production process.

#### Implementation order for the later execution agent

Keep the first implementation slice narrow and test-first:

1. Add characterization RED tests for the current Pi prompt ownership and for
   `WorkerManagerConfig.piPath`; make the live-vs-dormant worker distinction
   explicit rather than silently changing the default route.
2. Introduce an internal `WorkerLauncher`/`WorkerResourceIdentity` seam. The
   plain launcher preserves the existing child-process behaviour for the
   baseline; the transient-unit launcher owns unit creation, actual worker PID
   discovery, stop, cgroup snapshots and fail-closed teardown. No request body
   may supply an executable, unit name, cgroup path or raw limit.
3. Make `SessionWorker` and `WorkerPool` consume that seam, carry the immutable
   assignment/session identity, and release stale workers idempotently. A
   `systemd-run` client process is never reported as the worker resource owner.
4. Add the pilot executor adapter that binds server-derived `heavy` assignment
   to admission, receipts, event correlation and attempt epochs. It must own
   one session at a time, wait for active-turn quiescence, reject a second owner,
   fence late events, and expose bounded reconciliation/cardinality evidence.
5. Add the deterministic worker fixture and unit/integration tests for the
   matrix below. The fixture may substitute only provider/workload semantics;
   worker, launcher, RPC, receipt, arbiter and event code must be the real
   implementation under test.
6. Add one disposable live runner that starts a uniquely named control unit,
   launches only nonce-matched worker units, runs baseline then candidate, writes
   bounded evidence, and always performs identity-checked teardown. Wire the
   pilot profile only in the disposable validation configuration first.
7. Reconcile `docs/PROCESS-ISOLATION-DESIGN.md`, the worker API comments and the
   Phase 6 execution report so they distinguish the current in-process Pi path,
   the dormant worker classes, and the measured pilot route.

Each behaviour-changing row requires focused RED output before production code,
then focused GREEN, affected worker/internal-API suites, disposable evidence,
and independent review. A live runner failure or missing cgroup capability is
reported as blocked; it is not repaired by weakening assertions or by routing
back to the uncontained path.

#### Deterministic worker protocol and scenario matrix

The fixture worker speaks the same newline-delimited RPC shape consumed by
`SessionWorker`. A prompt selects one named scenario; the worker emits the
normalised lifecycle/tool events, records a small session marker in the
fixture-owned JSONL file, and returns a correlated response. It never executes
shell input from a prompt and has hard-coded finite child counts/durations.
The pilot adapter, not the fixture worker, owns `{sessionId, runId,
executionInstanceId, attemptEpoch}` correlation and fencing metadata.

| Scenario | Frozen parameters | Required proof |
|---|---|---|
| `normal-turn` | 100 ms deterministic tool interval; two warm-ups, then 30 measured warm turns | Exactly one ordered lifecycle/event sequence, one `agent_end`, durable session marker, completed receipt, one lease release. |
| `bounded-fanout` | Four child helpers, 250 ms each, maximum four descendants | All helpers and their descendants remain in the assigned worker cgroup; no worker descendant appears in the control cgroup (the short-lived launcher client is accounted separately); event/replay sequence remains exactly once. |
| `memory-high` | One helper allocates 160 MiB and holds it for 1500 ms under the fixed worker budget | A worker-scoped `memory.events high` delta or an explicit bounded allocation failure is recorded; control remains healthy; no control-cgroup `high`, `max`, `oom`, or `oom_kill` delta. |
| `pid-pressure` | At most 64 child-spawn attempts, each held for 500 ms, under `TasksMax=64` | Worker-scoped `pids.events max` or bounded `EAGAIN` is recorded; no unbounded fan-out, host/control failure, or false successful receipt. |
| `cancel-drain` | One helper holds for 5000 ms; P1 cancel at 250 ms | Receipt becomes cancelled/failed only through the documented path; admission release is not observable while active turn work remains non-quiescent; active descendants drain or are explicitly quarantined within the 2 s fixture drain bound. A warm idle worker may remain populated only with an explicit idle state. |
| `intentional-crash` | Persist marker, emit no terminal success, exit with code 42 | Only the target assignment fails; crash evidence is recorded; sibling worker/control remains usable; session JSONL survives. |
| `rehydrate` | 20 concurrent rehydrate requests for the crashed session, then one normal turn | Single-flight ownership returns one worker; no duplicate cgroup/observer/receipt owner; the new run completes from the preserved session identity. |
| `late-event-fence` | Deliver one old-epoch `agent_end` 500 ms after cancellation and 50 ms after a new epoch starts | The old event is evidence only; it cannot complete the new receipt, release its lease, or produce a duplicate notification. |
| `restart-unknown` | Start a 3000 ms hold, terminate the disposable controller at 250 ms, restart it after 500 ms | Persisted run is `interrupted` with `SERVER_RESTART`/unknown cessation; the old worker unit is reconciled and stopped; recovery is explicit and never a false completion. |
| `ws-parity` | Three normal turns through the pilot session-WebSocket adapter | WebSocket event envelopes match the internal normalised event sequence and session identity; no duplicate subscriber or observer remains. |
| `churn` | 20 serial start → normal/cancel → drain → dispose cycles | Worker/cgroup/receipt/observer/timer cardinalities return to baseline after every cycle and after final teardown. |
| `p1-under-load` | One active bounded-fanout or hold worker; ten P1 health/evidence/cancel probes at 100 ms intervals | P1 control remains responsive and the worker pressure is not misreported as control-plane capacity; compare P1 P95 with the plain-spawn baseline. |

The `intentional-crash`, `memory-high`, and `pid-pressure` cases are expected to
produce worker-side failure/pressure evidence when the kernel enforces the
limit. They are not allowed to produce control-plane `oom`, `oom_kill`, or
unbounded `pids.events max`; an absent expected worker pressure signal is a
failed containment probe, not a pass by omission.

#### Baseline, acceptance, and evidence ledger

Run the same deterministic normal fixture in two modes: plain child spawn
(baseline) and the exact transient worker cgroup (candidate). Do not compare a
real provider run with the synthetic fixture. Record dispatch-to-admission,
admission-to-first-event, terminal completion, cold-start, warm-turn and P1
probe timings separately, plus worker/control RSS, PID high-water, cgroup event
counters, event counts, receipt state transitions, release timestamps and
cleanup cardinalities.

Phase 6 cannot pass unless all of the following are true:

- the pilot route is selected by server policy and the exact cgroup properties
  and worker/session identity are observed, not merely configured;
- normal, fan-out, cancellation, crash, rehydration, late-event, restart,
  WebSocket-parity and churn cases meet the matrix above;
- every accepted run is terminal or explicitly `interrupted`/
  `unknown`/quarantined, with no false success or duplicate terminalisation;
- no pilot-owned admission, receipt, event subscription, timer or cgroup release
  occurs while the owned assignment still has non-quiescent active work; a warm
  idle worker may remain populated only when its idle ownership is explicit, and
  full disposal still requires an empty cgroup. Agent OS project/worktree and
  retention leases, and generic broker ownership, are outside this deterministic
  fixture and remain required representative Phase 8B evidence;
- all contained descendants remain in the assigned worker cgroup and a target
  crash/pressure event cannot damage a sibling or the controller;
- control-plane `memory.events` (`high`, `max`, `oom`, `oom_kill`) and
  `pids.events max` remain zero outside the deliberately pressured worker
  scenario; worker pressure is bounded and recorded;
- control/P1 P95 is no worse than both the frozen safe baseline and the §6.7
  absolute/20% limits; useful deterministic completions/hour are no more than
  10% below baseline; drain P95 is at most 10 s and never exceeds 30 s; and
- all transient units, descendants, temporary receipt/session files, event
  subscriptions and timers are cleaned, with a final zero/empty cardinality
  snapshot.

The Phase 6 report must include the exact fixture version and hashes, every
setting in the tables above, the actual unit/cgroup identities, raw evidence
paths, RED/GREEN chronology for each new behaviour, baseline/candidate results,
limitations, reviewer findings, rollback state, and the explicit PAUSE 6 choice.
The approved fixture and settings become immutable `worker-cgroup-conformance/v1`
inputs for 8A. A change to scenario text, helper count/duration, cgroup budget,
receipt/admission timeout, sampling count, or launch mode requires a new
proposal, owner approval, fixture version, and Phase 6 re-baseline.

Pi contains a dormant worker-oriented path, but ordinary production Pi traffic
is in-process. This is deliberately a containment and assignment pilot on the
candidate worker boundary, not evidence of current process isolation or
permission to create a second executor authority.

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
- terminal receipt cannot release active-turn capacity while the assignment
  remains non-quiescent; a warm idle worker is not active-turn work and is
  tracked separately;
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

**Recorded owner decision (2026-08-05): bounded `hybrid`.** This means:

- one canonical Internal API remains the product surface; do not create a
  separate operator-selected “heavy API”;
- Agent OS and browser users must not need to remember a special invocation;
- a versioned, server-owned policy selects an execution profile from validated
  workload facts and observed resource behaviour; callers may not select raw
  limits or promote their own priority;
- begin with shadow classification and reason-code evidence before real routing;
- as a future Phase 7 entry criterion, persist selected profile, policy version,
  reason, affinity and resource identity in receipts/diagnostics; Phase 6's
  hard-coded fixture-only `heavy` assignment does not yet provide this public
  metadata contract;
- preserve session affinity and migrate, if supported, only at a positively
  quiescent turn boundary with one fenced owner;
- no production contained-heavy routing is authorised by this decision; real Pi
  correlation/parity, 8A, representative 8B and Phase 9 gates still apply; and
- ordinary long-running Web UI sessions remain in scope rather than assuming
  only Agent OS work can become resource-heavy.

**What Phase 6 does not prove:** the short deterministic fixture does not measure
several-hour sessions, large real JSONL transcripts, provider/model behaviour,
real tool distributions, generic production restart recovery, classification
accuracy, the share of work that would use containment, or whether the original
restart pressure came mainly from Agent OS, long browser sessions, or both. It
proves the contained boundary and its low warm-path overhead, not that the
production problem is solved.

**Stop/reverse criteria for the bounded hybrid direction:** Phase 7 must freeze
its exact shadow thresholds before implementation. Unless the owner approves a
better evidence-based sample, the default decision floor is at least 20
naturally arising Agent OS implementation/tool turns, three owned ordinary Web
UI sessions observed for at least two hours with growing transcripts, and one
bounded known fork/memory-heavy case. An insufficient sample means `continue
shadow`, never promotion. Apply the following action mapping:

- `continue shadow` while the sample is incomplete or classification uncertainty
  remains material;
- `hold expansion` when fewer than 5% of eligible turns are automatically
  identified and no resource-pressure candidate is observed, when more than 10%
  of classified turns are false positives, or when any known bounded
  fork/memory-heavy case is missed;
- `rollback routed traffic` immediately on false success/dual ownership,
  control-plane OOM/restart, unreconciled cgroup identity, or sustained §6.7
  control-SLO breach; retain evidence and return eligible work only after
  positive quiescence; and
- otherwise continue only one bounded runtime/path gate at a time.

Also recommend `hold` or `rollback` rather than further expansion if
representative evidence shows any of the following after one bounded remediation
cycle:

- the automatic classifier cannot identify useful candidates without routine
  operator labelling;
- maintaining the contained executor requires a divergent public API, replay,
  event, retention, cancellation or receipt authority;
- real Pi correlation, follow-up, extension/notification parity, rehydration or
  turn-boundary handoff cannot be made fail-closed;
- useful attempts/hour regresses by more than 10%, P0/P1/browser latency breaches
  §6.7, cold-start/idle RSS materially reduces safe throughput, or queue age and
  starvation become unbounded;
- several-hour Agent OS or ordinary Web UI sessions still drive control-plane
  pressure/restarts because the relevant state remains in-process;
- false-positive containment causes more bounded worker failures than it prevents
  control-plane incidents, or false negatives leave known fork/memory-heavy work
  uncontained;
- cleanup, drain, cgroup identity or capacity-debt cannot reliably return to a
  truthful bounded state; or
- operational evidence shows the simpler admission/lifecycle/memory posture has
  already solved the real problem and the extra path has no compensating value.

A green unit/live suite is insufficient if any §6.7 throughput or conductor
latency threshold fails.

---

## Phase 7 — Conditional broader worker/runtime containment rollout (P2, separately owner-authorised shadow gate) — SHADOW IMPLEMENTED / PAUSE 7 RECORDED

PAUSE 6's bounded `hybrid` selects a direction, not general rollout authority.
The owner approved the following lowest-risk Phase 7 entry scope on **2026-08-05**:

- **Runtime/path:** Pi runtime, Agent OS → Pi Web UI Internal API prompts. The
  ordinary browser/WebSocket path remains the proven route; ordinary long Web UI
  sessions may be observed as an evidence cohort but are not routed by this
  scope. Claude, Antigravity and OpenCode are out of scope.
- **Mode:** shadow-only. Existing execution and ownership remain unchanged; no
  real turn is moved into a contained worker. Disposable shadow evidence is
  authorised, but no production observation, configuration change or routing is
  authorised.
- **Policy:** use the proposed server-owned `phase7-pi-shadow/v1` policy
  identifier. The execution agent may propose reason codes and per-turn
  classifier thresholds, constrained by the PAUSE 6 evidence floors and
  stop/reverse criteria. Callers cannot select profiles, limits, affinity or
  priority.
- **Mutable repositories:** `/root/pi-web-ui` only. `/root/agent-os` is
  read-only context/validation unless a separately approved contract change is
  demonstrated as necessary. `/root/tmux`, Caddy and unrelated services remain
  untouched.
- **Evidence floor:** at least 20 naturally arising Agent OS implementation/tool
  turns, three ordinary Web UI sessions observed for at least two hours with
  growing transcripts, and one bounded known fork- or memory-heavy case. An
  incomplete or materially uncertain sample means continue shadow.
- **Acceptance and rollback:** preserve one canonical API, persist the selected
  or shadow profile, policy version, reason, affinity and honest resource
  identity in receipts/diagnostics, and prove no P0/P1, lifecycle or cleanup
  regression. Disable only the shadow policy if the gate fails; preserve all
  receipts and evidence. Any future contained routing, production observation or
  Phase 7 scope/settings change requires a new owner pause and approval.

### Phase 7 shadow implementation record (2026-08-05)

**Evidence label:** `unit-validated` + `integration-validated` +
`live-validated-disposable`; no production observation, restart, configuration
change or contained route.

The Pi Internal API prompt and batch-prompt paths now classify only on the
isolated `validationMode` server under `phase7-pi-shadow/v1`. The frozen
server-owned thresholds are 4,096 UTF-8 prompt bytes, 8 attributable
`tool_execution_start` events and a 60-second long-horizon signal. Receipts and
bounded diagnostics persist profile, reason codes, session affinity, and the
truthful shared `pi-control-process` identity (`sessionScoped:false`); prompt
text is omitted. Dynamic tool evidence is persisted before terminalisation and
survives disk-backed restart recovery as `interrupted` evidence. No caller can
select a profile or forge the server-derived initial classification.

Focused Phase 7 suites are green, the full server suite is 227 files / 2,860
tests, the client suite is 73 files / 863 tests, and disposable Pi live
validation passed `phase7-pi-shadow`, `smoke`, and `run-receipt-idempotency`.
The live scenario also verified the session evidence bundle's receipt and
bounded diagnostic projection. The independent review findings were fixed and
re-reviewed; see the execution report for the RED → GREEN ledger and exact
commands.

**PAUSE 7 — recorded:** this implementation stops at shadow evidence. The
existing uncontained Pi path remains the only execution path; no contained
routing, production observation, Phase 8A/8B, or Phase 9 work is authorised by
this record. Further expansion requires a new owner decision after the plan's
sample, parity, throughput, control-latency, recovery and rollback gates.

**Owner PAUSE 7 decision (2026-08-05): `continue shadow`.** The owner chose to
continue collecting the approved shadow evidence. This is not approval for
contained routing, production observation, Phase 8A/8B or Phase 9; those remain
separate gates requiring fresh evidence and explicit owner decisions.

This approval allowed the execution agent to begin Phase 7 shadow
implementation, red-first validation and disposable evidence collection. It did
not authorise a contained route, production access, Phase 8A/8B, or Phase 9.
The broader options below remain unapproved possibilities for later PAUSE 7
review; this entry scope selects none of them.

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

Use the exact operator-approved `worker-cgroup-conformance/v1` Phase 6
fixture version and every exact test setting recorded in its Phase 6 evidence at
increasing concurrency on disposable infrastructure. Do not redesign the
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
- no active-turn capacity release while its executor remains non-quiescent;
  an explicitly tracked warm idle executor may remain populated;
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
Agent OS dispatch, defer/backpressure, recovery and long-running work. In the
same evidence track, include at least one owned representative long-running
ordinary Web UI Pi session with a growing transcript and bounded real tool work;
exercise follow-up, replay/reconnect, browser responsiveness, turn-boundary
profile/affinity decisions, cleanup and restart-safe recovery. This session must
use sanitised owned work and must not be treated as “heavy” merely because it is
old: record transcript/runtime memory, descendants, latency and classifier
reason codes so the evidence can distinguish duration from actual pressure.
Long-horizon watches must expire/release claims, restart as detached evidence,
and be re-registered explicitly.

#### 8B.2 Product acceptance targets

- Agent OS queue/defer age and retry behaviour remain bounded;
- the representative long-running Web UI session remains usable without
  control-plane pressure, replay/follow-up drift, dual ownership or forced
  service restart, and its selected profile is justified by recorded policy
  evidence rather than operator labelling;
- P1 recovery and browser control meet the §6.7 absolute/P95 thresholds;
- no Agent OS project/class starvation;
- useful attempts/hour stays within the §6.7 regression threshold versus the
  prior safe level;
- every accepted run reaches terminal or explicit unknown/quarantined state;
- no capacity/worktree release while its executor remains non-quiescent; an
  explicitly tracked warm idle executor may remain populated;
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

### 11.2 Pilot milestone and Agent OS scaling milestone

The **Phase 6 pilot milestone** is complete when the frozen contained-worker
boundary, lifecycle matrix, performance gate, cleanup, review and owner pause
decision are recorded. That milestone is complete with bounded `hybrid`; it is
not a production or Agent OS scaling claim.

The broader **Agent OS scaling milestone** remains incomplete until:

- Agent OS owns durable ready/deferred work and handles Pi Web UI backpressure
  without duplicate dispatch or busy-looping;
- P1 conductor/recovery remains available under P2 saturation;
- the heavy Pi worker-cgroup pilot contains descendants and proves
  drain/quarantine;
- real Pi event/replay/follow-up/extension/notification parity is live-validated;
- representative Phase 8B Agent OS and ordinary long-running Web UI evidence
  passes the recorded classifier, throughput, control-latency and cleanup gates;
- the owner has separately authorised and accepted each bounded runtime/path
  expansion; and
- no broader executor migration is claimed complete unless its separate pause
  gate passed.

A `hold` or `rollback` remains a valid safe later outcome. Neither the bounded
`hybrid` direction nor the completed fixture may be reported as completion of
the scaling milestone.

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
