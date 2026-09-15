# Process Isolation Design

> Canonical record of Pi Web UI's **current** Pi process ownership and the bounded Phase 6 worker-containment pilot. This document must not be read as a claim that ordinary production Pi traffic already runs in per-session worker cgroups.

## Current runtime ownership

Pi Web UI supports five runtime families. Their execution shapes differ:

| Runtime/path | Current execution owner |
|---|---|
| Pi browser `/ws`, `/ws/sessions/:id` and Internal API prompts | `MultiSessionManager` / Pi SDK `AgentSession` in the main server process; the upgrade handler routes the per-session WebSocket shape to the same legacy authority |
| Dormant worker-oriented classes | `WorkerPool` → `SessionWorker` → `pi --mode rpc`; not wired into current production prompt ingress |
| Pi Phase 6 `heavy` pilot | internal `PilotExecutorAdapter` over the dormant worker path; enabled only by the disposable conformance harness |
| Claude | SDK/channel or `claude -p`, according to backend selection |
| OpenCode | long-lived `opencode serve` backend when enabled |
| Antigravity | `agy -p` subprocesses per turn plus Pi-owned replay logs |

All current production Pi prompt routes therefore remain **in-process**. `WorkerPool`, `SessionWorker`, `SessionWebSocketHandler` and the pilot adapters must not be used as evidence that ordinary Pi sessions are process-isolated or that a second worker API is live. No Phase 6 change migrates ordinary Pi browser or Internal API traffic.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md), and [`INTERNAL-API.md`](./INTERNAL-API.md) for the broader runtime architecture.

## Worker-oriented path

The worker path consists of:

- `server/src/workers/worker-pool.ts` — bounded worker ownership, same-session single-flight creation, plain/contained mutual exclusion, idle/crash release, and shutdown;
- `server/src/workers/session-worker.ts` — newline-delimited RPC process lifecycle, readiness, event subscribers, command correlation, and launcher-observed resource identity;
- `server/src/workers/session-rpc-client.ts` — prompt/control calls and normalised event projection;
- `server/src/workers/worker-launcher.ts` — direct-child baseline and fail-closed transient-systemd launcher;
- `server/src/workers/pilot-executor-adapter.ts` — server-derived heavy assignment, admission, receipts, run epochs, cancellation/drain, queued follow-ups, and stale-terminal fencing; and
- `server/src/websocket/pilot-session-websocket.ts` — receipt-aware pilot events projected as browser `session_event` envelopes without bypassing the pilot executor.

A worker retains one session path while warm. A warm `ready` worker may remain populated, but it is not active-turn work. Full disposal is complete only after its owned process/cgroup is empty.

## Plain baseline versus contained pilot

### Plain launcher

`PlainWorkerLauncher` preserves the historical direct-child behaviour and is used only as the deterministic Phase 6 comparison baseline. Its resource snapshots walk the bounded `/proc` descendant tree and sum observed RSS. A process group is not treated as an exact daemon-proof containment boundary.

### Contained heavy launcher

`TransientSystemdWorkerLauncher` is the Phase 6 candidate. It accepts only a server-created `heavy` assignment and launches a uniquely named service inside a nonce-owned disposable slice. The frozen v1 settings are:

- `MemoryHigh=128M`
- `MemoryMax=384M`
- `MemorySwapMax=0`
- `TasksMax=64`
- `CPUWeight=100`
- `KillMode=control-group`
- `TimeoutStopSec=10s`
- Node old-space `128` MiB

The launcher uses `systemd-run --pipe --wait --collect`. Before launch it requires the generation unit to be absent. It binds the invocation to a random non-secret launch token inherited by the worker, then discovers and verifies the service `InvocationID`, `MainPID`, `ControlGroup`, `/proc/<MainPID>/cgroup`, `/proc/<MainPID>/environ`, and exact observed properties. The `systemd-run` client PID is recorded separately. A caller cannot supply an executable, unit name, cgroup path, or raw limits through a request body.

Capability, identity, or property mismatch fails closed. There is no automatic heavy→plain fallback.

## Ownership and lifecycle invariants

1. **One owner per session path.** A process-wide worker ownership registry prevents plain and contained pools from concurrently owning the same session path. A warm-worker lookup must retain the same session, execution-instance and profile identity with a monotonic turn epoch. Ownership is released only through the idempotent worker release path.
2. **Single-flight creation.** Concurrent creation/rehydration requests for one path wait for the same spawn promise; none receives a not-yet-ready duplicate.
3. **Immutable launch identity.** A contained generation is launched with `{sessionId, sessionPath, runId, executionInstanceId, attemptEpoch, profile:'heavy'}`. The launcher-observed unit/cgroup/PIDs are outputs, not request inputs.
4. **Receipt-aware active turns.** The pilot acquires P2 admission, attaches the lease to the run receipt, and records events through `RunReceiptManager`.
5. **`agent_end` is not a drain signal.** Normal completion waits for a valid terminal event, worker `ready`/`idle`, and a generation-scoped resource snapshot containing only the immutable warm-worker `MainPID` (no active descendants). Positive `resource_quiescence` evidence is persisted before admission release. Cancellation terminalises through the documented receipt path; uncertainty or persistence failure retains/quarantines draining debt.
6. **Epoch fencing.** Every pilot turn sends `{runId, executionInstanceId, attemptEpoch}` through RPC. An explicitly old or unattributable terminal event is evidence only; it cannot finish a newer receipt, release admission, or generate a duplicate projected notification.
7. **Queued follow-ups do not overlap ownership.** Same-session pilot follow-ups serialise behind the active owner and acquire admission only after the previous turn drains.
8. **Exact teardown.** Reconciliation re-verifies `MainPID` and `ControlGroup`, stops only the nonce-owned unit, verifies `cgroup.events populated=0` plus an empty `cgroup.procs` (or cgroup removal), and verifies `LoadState=not-found` collection. Exact failed launch units are also collected when systemd never assigned a `MainPID`.
9. **Spawn/shutdown is fenced.** Termination waits for any in-flight launcher result and reconciles a late handle; pool shutdown awaits every owner with all-settled semantics before reporting aggregate failure.
10. **Crash recovery preserves durable state.** Worker failure removes only that worker from pool capacity after resource reconciliation. Rehydration uses the same session path with one replacement owner.

## Disposable Phase 6 conformance harness

The owner-approved frozen fixture is `worker-cgroup-conformance/v1`:

- deterministic local JSONL RPC worker;
- no provider, model, network, repository task, or production service;
- plain baseline followed by exact-cgroup candidate;
- normal, bounded fan-out, memory/PID pressure, cancel/drain, crash, rehydrate, queued follow-up, late-event fence, restart recovery, WebSocket projection, P1 health/evidence/cancel under load, and churn evidence;
- a separate transient controller budget (`MemoryHigh=768M`, `MemoryMax=1G`, `MemorySwapMax=0`, `TasksMax=256`); and
- private raw evidence in a nonce-owned temporary directory.

Run it with:

```bash
npm run validate:phase6-worker-cgroup
```

The parent creates a fresh mode-0700 child directory with an exact nonce/fixture ownership marker and only `pi-web-ui-phase6-<nonce>*` transient units. Signal and normal cleanup stop the exact nonce-owned slice after worker-level reconciliation, verify no owned service remains and archive bounded evidence before removing temporary receipt/session directories. It never reuses or stops `pi-web-ui.service`, `tmux-web-ui.service`, `twui-*` scopes, Caddy, or another existing process.

Canonical fixture settings and acceptance criteria remain in [`plans/PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md`](./plans/PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md). Changing a frozen scenario parameter requires owner approval and a new fixture version. **The fixture contract stands unchanged, but the plan's Phases 8–9 are paused as of 2026-08-20**, so the ramp/soak that would consume this fixture is not current work; the pilot remains off outside disposable validation.

## PAUSE 6 bounded-hybrid direction

The recorded PAUSE 6 decision retains this boundary for conditional heavy work,
but it does not authorise a second public “heavy API” or manual per-task operator
selection. Phase 7 remains unstarted and requires a separate owner-confirmed
scope before code changes or real routing. Any future resolver must sit behind
the canonical session/prompt surface, use versioned server-owned policy and
begin in shadow mode. Agent OS may supply validated workload facts, but cannot
supply raw cgroup settings or assign itself P0/P1 priority. Exposing selected
profile, reason, policy version, session affinity and observed resource identity
in receipts/diagnostics is a future Phase 7 entry criterion, not a current Phase
6 public metadata capability.

Ordinary long-running Web UI sessions remain part of the original problem. They
must be included in representative evidence and may become containment
candidates from observed behaviour at a safe turn boundary; age alone is not a
heavy-work signal. The canonical plan records the detailed stop/reverse criteria
for abandoning the hybrid direction if automatic useful selection, one shared
lifecycle authority, real Pi parity, throughput/control SLOs or truthful cleanup
cannot be sustained.

## Out-of-process worker migration roadmap (architecture, unstarted)

This section is the recorded architecture for the **migration of ordinary Pi execution from in-process `MultiSessionManager`/`AgentSession` ownership in the main daemon to per-session out-of-process workers**. It is a roadmap, not a description of current behaviour: ordinary Pi browser and Internal API prompts remain in-process today, and no part of this section is switched on. It exists so the migration can be reviewed, costed and gated before any code moves traffic.

### Why migrate

Today a single runaway Pi turn (prompt-injection spiral, tool loop, transcript growth into the multi-GB class) shares the main daemon's heap and event loop with every other session, the browser WebSocket fan-out, and the Internal API. A worker that exhausts its heap — the default V8 old-space ceiling sits in the 2 GB class, or the launcher-imposed cgroup ceiling for contained launches — currently terminates the daemon with it. Out-of-process workers turn that failure class into a per-session, recoverable event: the daemon survives, detects the worker exit, and reports the turn as failed.

### Topology

```
   Browser ──/ws, /ws/sessions/:id──┐
                                    ▼
                        ┌───────────────────────┐   newline-delimited JSON-RPC   ┌────────────────────────────┐
   Internal API ───────▶│  main daemon          │─────────── over stdio ────────▶│ worker per session path    │
                        │  session registry     │◀─────── events / responses ────│ own process group, or a    │
                        │  MultiSessionManager  │                                │ transient systemd unit     │
                        │  WorkerPool (1 owner  │                                │ (pi --mode rpc / SDK       │
                        │  per session path)    │   process exit / heartbeat     │  session inside)           │
                        │  event projection ────│◀─── loss ⇒ detect, isolate,    └────────────────────────────┘
                        │  (session_event       │     emit turn_failed, rehydrate
                        │   envelopes)          │
                        └───────────────────────┘
```

The worker owns the agent session; the daemon owns everything shared (registry, admission, receipts, projection, sockets). A worker death removes exactly its own session from service.

### IPC protocol

The transport is the worker path's existing newline-delimited JSON-RPC over stdio (`server/src/workers/session-worker.ts`, shapes in `server/src/workers/types.ts`):

- **daemon→worker commands:** `prompt`, `steer`, `abort`, `get_state`, `set_model`, `set_thinking_level`, `compact`, `get_messages`;
- **worker→daemon responses:** `{type:'response', command, success, data|error}` correlated by id;
- **worker→daemon events:** `message_start|update|end`, `tool_execution_start|update|end`, `extension_ui_request`, `session_compaction`, `error`, `streaming_started|ended`, `agent_start|agent_end`, each carrying the `pilotCorrelation` `{runId, executionInstanceId, attemptEpoch}` echo contract so stale terminals cannot cross worker replacements.

Stdio is deliberate: no listening socket per worker, no port allocation, no extra auth surface; the pipe's lifecycle is the worker's lifecycle. Frame-size and back-pressure limits must be explicit in the launcher hardening (below) so a runaway worker cannot exhaust the daemon through its own stdout.

### Heartbeat and crash recovery

Today the worker path has **no heartbeat**: failure is observed only as process exit (ownership invariant 10). The migration adds:

1. **Worker heartbeat.** A periodic cheap liveness frame (worker→daemon) with a monotonic timestamp, plus a daemon-side watchdog: a worker that misses N consecutive beats while a turn is open is treated as dead even if the OS process lingers ( wedged event loop, stopped cgroup, hung provider call).
2. **Crash containment.** The daemon is never inside the worker's cgroup/process group, so a worker OOM kill, `SIGKILL`, or abnormal exit cannot take the daemon, sibling sessions, or browser sockets down.
3. **`turn_failed` projection.** On detected death (exit or heartbeat loss) during an open turn, the daemon emits a `turn_failed` session event on that session's stream — a new projected event; today a crash surfaces only as a vanished `agent_end` or a raw `{type:'error'}`. The event carries the session path, run/execution/epoch correlation, and the observed cause (`worker_exit`, `heartbeat_timeout`, `oom`).
4. **Clean recovery for parent orchestrators.** A parent that dispatched a child turn receives `turn_failed` as a terminal, attributable signal (instead of silence), releases/retries against its own policy, and the session path is rehydrated with a replacement worker on the next prompt — resuming from the durable session JSONL transcript, which the worker never owned.
5. **Receipt honesty.** The failed turn terminalises through the existing `RunReceiptManager` path (receipt retained, admission released, draining debt quarantined on uncertainty), so crash recovery never fabricates a successful `agent_end`.

### Preserving WebSocket event streaming and session resume

The migration changes **who produces** events, not **how browsers receive** them:

- `/ws` and `/ws/sessions/:id` keep delivering the same `session_event` envelopes; worker RPC events are projected through the existing normaliser/`json-rpc-to-rpc-converter` and pilot-session projection, so no client-side contract changes and no second WebSocket API is introduced.
- Replay and resume stay anchored to the durable session JSONL and the shared session registry, exactly as for in-process sessions: reconnecting clients replay from the transcript; a replaced worker re-attaches by session path + immutable launch identity, and epoch fencing (invariant 6) guarantees a dead worker's late events cannot finish a newer turn.
- Session identity, pinning, transfer, and Internal API contracts are untouched: workers are an execution-location change behind the canonical session/prompt surface, per the PAUSE 6 resolver rule.

### Hardening roadmap: `worker-launcher.ts` and `worker-pool.ts`

| Step | Scope | Gate |
|---|---|---|
| R1 — liveness + failure truth | Worker heartbeat frames; daemon watchdog; end-to-end `turn_failed` projection on exit/OOM/heartbeat loss, fixture-proven in the frozen `worker-cgroup-conformance` harness with a new crash-scenario version | New fixture version, owner-approved; no production routing |
| R2 — ownership durability | `worker-pool.ts` persists ownership records (path, identity, epoch, worker pid) so a **daemon** restart reconciles or adopts live workers instead of orphaning them — explicitly not claimed today | Reconciliation evidence under kill -9 of the daemon; all-settled shutdown unchanged |
| R3 — launcher hardening | `worker-launcher.ts`: frame size/back-pressure limits on the stdio pipe; re-verification of `MainPID`/`ControlGroup` identity on rehydrate; failed-launch collection parity for the plain baseline; an owner-approved ordinary-session resource envelope (the frozen heavy envelope — 384M `MemoryMax`, 128M old-space — is a pilot setting, not the migration default) | Identity mismatch fails closed; no fallback to in-process on launch failure |
| R4 — gated migration | Ordinary Pi traffic moves to workers behind a server-owned policy in shadow mode (per the PAUSE 6 direction), then canary, then default; rollback is a configuration flip back to in-process `MultiSessionManager` execution | Shadow evidence, SLOs met, owner sign-off at every step; Phases 8–9 of the scaling plan remain paused until separately authorised |

Each step consumes the existing conformance fixture contract; none of them, by itself, migrates ordinary traffic or enables a second public worker API.

## What Phase 6 does not claim

- Ordinary Pi WebSocket/Internal API prompts are **not** migrated. (The migration roadmap above is the recorded architecture for changing that, not a claim that it has happened.)
- The pilot is not enabled in production configuration.
- A deterministic local fixture is not provider/model parity evidence.
- The short harness does not cover several-hour sessions, growing real JSONL transcripts, real tool distributions, classifier accuracy, expected route utilisation, or the relative historical contribution of Agent OS and ordinary browser sessions.
- The current stale-terminal fence is validated with fixture-echoed explicit run/execution/epoch correlation. A real Pi worker must preserve this correlation contract before the pilot can be promoted beyond the harness.
- Restart recovery is the frozen disposable controller manifest/reconciliation scenario; generic production `WorkerPool` ownership persistence across server restart is not added.
- Prewarming is not added. The measurements compare existing warm reuse with cold start/dispose; cold transient-unit startup cost is retained as evidence.
- Passing Phase 6 proves a bounded containment mechanism, not that the historical service-restart problem is solved.

## Operational diagnosis

For an ordinary production Pi session, begin with `MultiSessionManager` and the session-ID evidence ladder in [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). For the worker pilot, inspect the run receipt, assignment epoch, launcher resource identity, unit `ControlGroup`, cgroup snapshots, and exact teardown evidence. Do not infer worker ownership from a `systemd-run` client PID.

## Related docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md)
- [`INTERNAL-API.md`](./INTERNAL-API.md)
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)
- [`OBSERVABILITY.md`](./OBSERVABILITY.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
