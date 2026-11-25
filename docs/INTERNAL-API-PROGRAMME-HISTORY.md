# Internal API improvement programmes — history, invariants and how to triangulate

Read this **before** changing Internal API behaviour (admission, receipts, queues, watchdogs, watches, goals,
notifications, alerts, runtime adapters' dispatch paths). The owner's standing request: on any new Internal API
issue, first triangulate what earlier programmes did, so a fix neither repeats nor contradicts them and no
earlier safeguard regresses.

## How to triangulate (do this first)

1. **Find the programmes that touched the same subsystem** in the map below, then open their plans. Each plan's
   status line and execution record say what shipped; a plan's header can be stale, so trust the execution
   record and the contract changelog over it.
2. **Read the matching rows of [`RECURRING-DEFECT-LEDGER.md`](RECURRING-DEFECT-LEDGER.md).** Each row names the
   failure class and the regression tests that guard it. Run those tests before and after your change.
3. **Read the contract history** for the surface you touch: [`INTERNAL-API-CONTRACT.md`](INTERNAL-API-CONTRACT.md)
   exception table and changelog (one entry per version, with why). A public shape change needs a version bump,
   an exception row, a regenerated client snapshot and the Agent OS and pi-orch mirrors.
4. **Check the invariants below.** If your fix would weaken one, stop and ask the owner; do not trade one
   programme's safeguard for another's symptom.
5. **Ask the memory layer** for decisions and rejected ideas that never reached a plan:
   `npm --prefix /root/agent-os run agent-os -- recall "<question>"`, and `agent-os worklog` for who did what.
6. **Write down the triangulation** (which programmes, which invariants, why your change is compatible) in your
   own plan before implementing.

## Programmes (oldest first)

| When | Programme (plan) | Contract | What it established |
|---|---|---|---|
| Jul 2026 | [Multi-client robustness](plans/INTERNAL-API-MULTI-CLIENT-ROBUSTNESS-PLAN.md) | 1.8.0 | Socket/event broker foundations shared by every client; everything later builds on it |
| Jul 2026 | [Observability hardening](plans/OBSERVABILITY-HARDENING-PLAN.md), [session evidence](plans/SESSION-EVIDENCE-OBSERVABILITY-PLAN.md) | — | Logger/diagnostics buffer, correlation ids; one-call `GET /sessions/:id/evidence` |
| Jul 2026 | [Dispatch and identity integrity](plans/INTERNAL-API-DISPATCH-AND-IDENTITY-INTEGRITY-PLAN.md) ([report](plans/INTERNAL-API-DISPATCH-AND-IDENTITY-INTEGRITY-REPORT.md)) | — | Receipts tied to the real dispatched run and session identity |
| Aug 2026 | [Unbounded events stream fix](plans/INTERNAL-API-EVENTS-UNBOUNDED-STREAM-FIX-PLAN.md) | 1.24.0 | `?mode=snapshot` and `?timeout=` so monitoring never holds an unbounded SSE read |
| Aug 2026 | Orchestration user defects [round 1](plans/INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25.md), [round 2](plans/INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25-ROUND-2.md) | — | Server-side fixes from observed long-running parent/child use |
| Aug–Sep 2026 | [Resource scaling and lifecycle hardening](plans/PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md) | — | Phases 0–6: cgroup-aware capacity, tools slice/placement, lifecycle fencing. **Phases 8–9 paused by the owner** — do not reopen without his decision |
| Sep 2026 | [Child orchestration surfacing](plans/CHILD-ORCHESTRATION-SURFACING-PLAN.md), [session adoption](plans/SESSION-ADOPTION-PLAN.md), [cross-runtime goals](plans/CROSS-RUNTIME-GOAL-FUNCTION-PLAN.md) | 1.27–1.38 | Parent linkage and child events, adoption, server-owned goal function |
| Sep 2026 | [Capacity scaling and orchestration robustness](plans/INTERNAL-API-CAPACITY-SCALING-AND-ORCHESTRATION-ROBUSTNESS-PLAN.md) | — | Admission classes, interactive/control reserves, concurrency limits (Tier 2) |
| Sep 2026 | [Silent no-op and session ownership](plans/INTERNAL-API-SILENT-NOOP-AND-SESSION-OWNERSHIP-PLAN.md) | — | Receipt truth, session-ownership checks, post-terminal fencing |
| Sep 2026 | [Unified coordination](plans/UNIFIED-COORDINATION-AND-INTERNAL-API-ROBUSTNESS-PLAN.md) | — | Header still says draft, but superseded and absorbed: phases 1–3 delivered, 4–5 absorbed into later Pi Web UI programmes (see Agent OS roadmap). **Not fresh work** |
| Sep–Oct 2026 | [Orchestration scaling readiness](plans/ORCHESTRATION-SCALING-READINESS-PLAN.md) ([reports](plans/execution-reports/orchestration-scaling/)) | 1.57–1.60 | Start watchdog (`NEVER_STARTED`), Pi queue semantics, turn-count mismatch detector, quarantine reconciliation, drain-then-restart, budgets |
| Oct 2026 | [Parent orchestration machinery](plans/PARENT-ORCHESTRATION-MACHINERY-PLAN.md) | 1.61–1.62 | Per-profile caps, stable goal ids, stalled goal state, no false goal completion, quarantined debt attribution |
| Nov 2026 | [Antigravity post-turn work](plans/ANTIGRAVITY-POST-TURN-WORK-PLAN.md) | 1.70.0 | Known pending tool work keeps an Antigravity turn alive; provider error classes `PROVIDER_QUOTA_EXHAUSTED` / `PROVIDER_TRANSIENT` |
| 25 Nov 2026 | [Queued delivery and alert robustness](plans/INTERNAL-API-QUEUED-DELIVERY-AND-ALERT-ROBUSTNESS-PLAN.md) | 1.71.0 | Receipt-owned Devin queued delivery with `liveness.delivery`; item-scoped cancellation; honest no-activity wording; permit-ownership alert classification; Devin quota on the receipt; Devin idle process reaping |

## Invariants earlier programmes rely on (do not weaken without the owner)

- **Receipts tell the truth.** A receipt is the authoritative outcome; never mark one started, failed or safe to
  retry without evidence. Unknown stays unknown (`unconfirmed`), and late terminal evidence is kept beside the
  decision, not used to rewrite it.
- **Cancellation is item-scoped.** Removing one queued item never aborts an unrelated running turn or a queued
  neighbour. A proven removal is `cancelled_before_dispatch`; the removal owner writes it.
- **Execution clocks start at actual dispatch**, not at acceptance; the absolute acceptance budget stays bounded.
- **Admission is the memory and capacity guard.** Do not add a parallel gate or raise limits to hide a symptom;
  a memory refusal means something holds memory — find it (see the defect ledger's idle-process row).
- **Capacity is released only on confirmed cessation.** Retained debt (draining/quarantined) is not a leak and
  must not be freed by telemetry; a genuine unexplained permit must still alert.
- **No blanket timeout increase or generic tool keep-alive**; long silent commands are fixed at the workflow
  (scoped searches, model-free waits), and a hung command must still fail.
- **Monitoring reads are bounded** (snapshot or timeout); never an unbounded stream in a tool call.
- **Restarts are drain restarts.** Production restarts go through the drain; the owner's standing wish is that
  other agents' work is not cut off.
- **Additive contract changes only**, each with an owner exception row and mirrors kept in step.

## Subsystem → programmes to read first

| Touching… | Read |
|---|---|
| Admission, capacity, memory refusals | Capacity scaling; resource scaling; parent machinery; queued delivery (lane E) |
| Run receipts, watchdogs, `NEVER_STARTED`, stalls | Orchestration scaling; silent no-op; queued delivery (lane A) |
| Follow-up queues, steer, cancellation | Orchestration scaling (Pi queue); queued delivery (Devin queue) |
| Health alerts, turn-count mismatch | Orchestration scaling (detector); parent machinery (debt); queued delivery (lane B) |
| Provider errors, quota | Antigravity post-turn; queued delivery (lane C) |
| Goals, watches, wakes | Cross-runtime goals; parent machinery; child surfacing |
| Events, transcripts, evidence reads | Multi-client; unbounded stream fix; session evidence |
