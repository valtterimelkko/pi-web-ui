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

Canonical fixture settings and acceptance criteria remain in [`plans/PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md`](./plans/PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md). Changing a frozen scenario parameter requires owner approval and a new fixture version.

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

## What Phase 6 does not claim

- Ordinary Pi WebSocket/Internal API prompts are **not** migrated.
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
