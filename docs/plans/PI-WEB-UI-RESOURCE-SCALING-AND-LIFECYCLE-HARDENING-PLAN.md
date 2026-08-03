# Pi Web UI Resource Scaling and Runtime Lifecycle Hardening

**Status:** Ready for execution
**Baseline:** `27d1463` (`feat(internal-api): add truthful run liveness evidence`)
**Primary repository:** `/root/pi-web-ui`
**Production service:** `pi-web-ui.service` on port `3456`
**Production operation rule:** use `npm run production:lock -- ...`; Caddy is out of scope and must not be restarted.

> This is an execution plan, not an implementation report. The execution agent
> must follow the TDD and validation gates below and record the RED output for
> each new behaviour before changing production code.

---

## 1. Intent

Pi Web UI is becoming the runtime control plane for higher-volume Agent OS
orchestration and longer-lived sessions. The goal is to scale that use safely:

- admit more useful work without confusing host memory with the service's cgroup
  budget;
- ensure every accepted run becomes terminal, is cancellable, and releases its
  admission lease;
- prevent observers, replay buffers, retention claims, watches, and queued
  prompts from keeping sessions resident indefinitely;
- shut down cleanly so ordinary deploys do not look like failures;
- keep OpenCode child processes owned, bounded, and reaped;
- make readiness and capacity endpoints describe the resources that actually
  constrain the service; and
- leave the browser path, Caddy, unrelated sites, and existing runtime
  contracts intact.

The central invariant is:

> **Every accepted operation either completes what it promised or records an
> explicit terminal/failure outcome; every resource claim has an owner, a bound,
> and a cleanup path.**

The memory increase is an intentional capacity decision, not a substitute for
lifecycle fixes. A larger cgroup must not be used to hide a leak or to justify
unbounded concurrency.

---

## 2. Current state and evidence

The investigation was read-only and found no repository changes before this
plan. The following is the baseline to preserve in the execution report; do not
copy live session bodies, tokens, cookies, or full private transcripts into the
repository.

| Area | Observed state | Meaning |
|---|---|---|
| systemd budget | `MemoryMax=4G`, `MemoryHigh=3G`, `MemorySwapMax=512M`, `NODE_OPTIONS=--max-old-space-size=2048` | The service is intentionally constrained, but admission currently reads the host-sized cgroup view rather than `/system.slice/pi-web-ui.service`. |
| memory history | Current service after restart approximately `0.9 GB`; historical peak approximately `3.2 GB`; `oom=0`, `oom_kill=0` | Pressure/throttling and lifecycle retention are more likely than kernel OOM termination. |
| lifecycle | 16 stop/start transactions since 20 July; forced shutdowns on 24, 29, 30, 31 July and 1 August | Journal evidence points to explicit/operator/deployment recovery, amplified by the application's five-second force exit, not kernel OOM. |
| receipts | 152 receipts: 122 completed, 25 failed, 3 cancelled, 2 interrupted; 24 `TURN_STALLED`, 2 `SERVER_RESTART`, 1 `RUNTIME_ERROR` | Run liveness is a real production concern. Existing receipt/watchdog work must be retained and completed at the runtime-fencing boundary. |
| Agent OS | 1,455 ledger events in 14 days; 26 conductor attempts (`18 completed`, `8 timeout`); 138 recent session files, approximately `289.8 MB` | More orchestration and larger histories make retention and fan-out costs material. |
| registry/retention | 305 registered sessions, mostly idle; five resident retention leases; two active watches | Registry count is not equivalent to loaded memory, but resident claims and watches can block cleanup. |
| OpenCode | 18 `opencode serve` processes; 17 outside the Pi Web UI cgroup; approximately `3.95 GB RSS` and `47%` aggregate CPU | The current broad external-process handling does not establish ownership and can leave or kill processes outside the service. |
| readiness | `/api/health/ready` calculates `heapUsed / heapTotal`; it has reported a false `96.9%` error for a healthy process | Heap allocation size is not the service memory limit and must not be the sole readiness signal. |
| startup race | Supervisor observed `Pi Web UI socket unavailable ... ENOENT`; it recovered | Socket ownership/startup diagnostics should distinguish a short restart window from an unhealthy runtime. |

Useful evidence locations are bounded operational data under
`/root/.pi-web-ui/run-receipts`, `/root/.pi-web-ui/pins`, and
`/root/.pi-web-ui/watches`, plus the Agent OS usage ledger. Follow
`docs/TROUBLESHOOTING.md`'s session-ID evidence ladder before investigating a
specific session.

### Existing safeguards to preserve

- `RunReceiptStore.init()` converts persisted accepted/queued/started work to
  explicit `interrupted`/`SERVER_RESTART` evidence after a restart.
- `RunReceiptManager` already has idle and absolute watchdog concepts.
- Pi session identity checks fail closed for missing files and filename/header
  mismatches.
- Internal API shutdown already tracks its own HTTP sockets through
  `closeServerWithGrace`.
- `MemorySwapMax` is deliberately limited; do not turn swap into the new
  capacity plan without evidence.

The execution agent must not redo these as unrelated refactors. Add regression
tests where the new lifecycle work could affect them.

---

## 3. Capacity decision and target contract

### 3.1 Service budget

The requested scale-up is:

```ini
MemoryMax=8G
MemoryHigh=8G
MemorySwapMax=512M
Environment=NODE_OPTIONS=--max-old-space-size=4096
TimeoutStopSec=30
```

`MemoryHigh=8G` is intentionally aligned with `MemoryMax=8G`, as requested.
That removes a useful kernel soft-pressure boundary, so application-level
admission and memory telemetry become mandatory. Keep the 512 MiB swap cap in
the first rollout: swapping agent state tends to create the lag this plan is
trying to remove, and RAM rather than swap is the capacity target.

Raise Node old-space to 4096 MiB only with the readiness and load gates below.
The remaining cgroup budget is needed for native buffers, workers, OpenCode,
other runtime subprocesses, WebSocket/SSE state, and the OS. A larger V8 limit
must not be interpreted as permission for an unlimited heap.

The tracked `DEPLOYMENT.md` example currently says `6G/5G`; it must be brought
into agreement with this contract. The live `/etc/systemd/system/pi-web-ui.service`
unit is host configuration and must be changed during the controlled deployment,
not committed as a machine-specific file.

### 3.2 Initial application guardrails

Use explicit production configuration rather than the current CPU-derived
fallback (which can become approximately 15 turns on this host):

```dotenv
INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS=6
INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE=1
INTERNAL_API_ADMISSION_MIN_HEADROOM_MB=1536
INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN=768
```

This means five Internal API slots initially, while reserving one slot for
interactive Web UI work. Six is a starting point for the 8 GiB budget, not a
permanent product limit. Increase it only after the ramp gate demonstrates that
real per-turn memory use is below the reservation and no stalls/max-memory
counters occur. Do not restore `15` merely because the host has more CPUs.

Initial staged resident-session target: eight Pi sessions, replacing the
hard-coded four-session assumption only after cgroup-aware cleanup and the
load gate pass. Human Web UI pin capacity remains separate from source-owned
API/watch retention. Resident leases remain finite and time-bound.

Application memory policy should use the 8 GiB limit as the source of truth:

- reject new API work before the service approaches the hard cap;
- retain at least 1.5 GiB measured headroom after the projected reservation;
- reserve 768 MiB per admitted turn until load data justifies recalibration;
- trigger cleanup from cgroup/RSS pressure, not `heapUsed / heapTotal` alone;
- expose the measured source, current bytes, limit bytes, headroom, reservation,
  and active/stalled counts through `/api/v1/capacity`.

The exact high/critical application thresholds may be configurable, but the
initial acceptance target is no `memory.events` `high`, `max`, `oom`, or
`oom_kill` increment during the designed load. Because `MemoryHigh ==
MemoryMax`, a kernel `high` event is itself a release-blocking signal.

---

## 4. Scope and non-goals

### In scope

- cgroup-v2-aware memory capacity resolution and admission configuration;
- bounded Internal API concurrency and staged resident-session scaling;
- runtime observer, broker, watch, lease, and queued-run ownership cleanup;
- stalled-run runtime fencing and late-event handling;
- idempotent shutdown of HTTP, WebSocket, runtime, and child-process resources;
- truthful readiness/capacity/diagnostic reporting;
- OpenCode ownership and process-group reaping;
- tracked deployment documentation, `.env.example`, tests, live scenarios,
  observability, and a controlled `pi-web-ui.service` rollout.

### Explicitly out of scope

- Caddy, its configuration, its service, or any unrelated site;
- a repository-wide Pi session-file rescan or destructive deletion of session
  history;
- mass-killing the currently observed OpenCode processes without proving which
  process is Pi Web UI-owned or an orphan and obtaining the required operational
  authority;
- changing provider credentials, Telegram secrets, authentication, CSRF, or
  prompt-injection policy;
- making production the default target for live validation;
- unbounded concurrency simply because the cgroup limit is larger;
- silently changing the public Internal API contract without versioned types,
  tests, and documentation.

---

## 5. Required execution method

### 5.1 Read first

The execution agent must read, in addition to this plan:

- `AGENTS.md` and `docs/MAINTAINER-INDEX.md`;
- `docs/ARCHITECTURE.md`, `docs/EVENT-PIPELINE.md`, `docs/PROTOCOL.md`;
- `docs/INTERNAL-API.md`, `docs/INTERNAL-API-ORCHESTRATION.md`;
- `docs/LIVE-VALIDATION.md`, `docs/LONG-HORIZON-VALIDATION.md`;
- `docs/OBSERVABILITY.md`, `docs/TROUBLESHOOTING.md`, `docs/SHARP-EDGES.md`;
- `DEPLOYMENT.md` and `docs/SELF-NOTIFICATIONS.md` plus `NOTIFICATIONS.md` §9;
- skills `test-driven-development`, `systematic-debugging`, and
  `pi-web-ui-internal-api-orchestration` before the corresponding work.

Use `scripts/notify.sh` only at meaningful gates: phase completion, a real
blocker, a decision that cannot be made safely, and one final `done`. Do not
include tokens, cookies, raw auth errors, or private transcript bodies.

### 5.2 TDD is mandatory

For every production behaviour change:

1. write one minimal failing test;
2. run that focused test and record the expected RED failure;
3. implement the smallest change that makes it GREEN;
4. run the focused test and affected suite;
5. refactor only while green;
6. repeat for the next behaviour.

No production code may be written before its failing test. If a test passes
before the implementation change, it is not proving the new behaviour; fix the
test first. Use `systematic-debugging` for any unexpected test, typecheck,
lint, build, or live-validation failure rather than weakening the assertion.

---

## 6. Phased implementation plan

### Phase 0 — Baseline, safety, and measurement (P0)

**No code changes.** Capture bounded, non-secret baseline evidence:

- `systemctl show pi-web-ui.service -p MemoryMax -p MemoryHigh -p MemorySwapMax
  -p TimeoutStopUSec -p MainPID`;
- `systemctl status pi-web-ui.service`, `/health`, `/api/health/ready`, and
  authenticated `/api/v1/capacity`;
- cgroup `memory.current`, `memory.max`, `memory.events`, `memory.stat` for
  the actual service cgroup, plus process RSS/CPU and a child-process tree;
- bounded journal stop/start/forced-shutdown evidence using the troubleshooting
  runbook; do not begin with a repository-wide grep;
- receipt status/stall counts, active leases, watch statuses, registry count,
  broker/observer counts if available, and OpenCode PIDs/ownership.

Record commands, timestamps, and numeric summaries in the execution report, not
raw session data. Confirm Caddy remains healthy and untouched. All later
production service operations use `npm run production:lock`.

**Gate:** baseline is reproducible, no secret/artifact is added, and the
operator receives a `milestone` notification before implementation begins.

---

### Phase 1 — Cgroup-aware admission and memory budget (P0)

#### Task 1.1 — Resolve the service cgroup correctly

**Files:**

- `server/src/internal-api/admission-controller.ts`;
- new/updated focused tests in
  `server/tests/unit/internal-api/admission-controller.test.ts`;
- optionally a small pure cgroup path helper under
  `server/src/internal-api/` if that makes injection clearer.

**RED tests:**

- parse `/proc/self/cgroup` v2 `0::/system.slice/pi-web-ui.service` and read
  `memory.current`/`memory.max` from the corresponding nested directory;
- prefer the process's actual cgroup path over `/sys/fs/cgroup` root values;
- handle nested slices and safe absolute paths without allowing path traversal;
- handle `memory.max = max`, missing/invalid files, and a non-cgroup fallback;
- prove the current service reports a 4/8 GiB-sized limit rather than the
  approximately 32.9 GiB host limit observed during diagnosis;
- preserve a testable fallback to process RSS/`os.totalmem()` when no usable
  cgroup is available.

**Implementation requirements:**

- inject file reads/root paths in tests rather than making tests depend on the
  host's cgroup;
- support the deployed cgroup-v2 layout; if v1 fallback is retained, test it
  explicitly and document its limits;
- include enough source/path metadata in the internal capacity snapshot to make
  a bad deployment diagnosable, without exposing private filesystem contents;
- never claim a numeric limit when the kernel reports `max`.

#### Task 1.2 — Make admission memory-aware and explicitly bounded

**Files:**

- `server/src/internal-api/admission-controller.ts`;
- `server/src/config.ts`;
- `server/src/internal-api/server.ts`;
- `server/src/internal-api/routes/sessions.ts`;
- `.env.example`, `DEPLOYMENT.md`, and the relevant Internal API docs.

**RED tests:**

- an admission snapshot uses configured total slots and interactive reserve;
- a projected reservation below the minimum headroom is refused with `429` and
  `ADMISSION_CAPACITY_EXHAUSTED`;
- duplicate `release()` calls cannot underflow active counts;
- runtime/global limits and memory pressure produce distinct refusal reasons;
- the default no longer silently becomes the host CPU count when no explicit
  production value is supplied;
- capacity output includes active, stalled, memory current/limit/headroom, and
  the configured reservation values.

**Implementation requirements:**

- wire the initial values from §3.2 and keep them environment-overridable;
- use `memory.max`/RSS as the hard resource source and an application guard
  below it; do not use `MemoryHigh` as if it were still a soft limit;
- keep one interactive reserve slot and document the staged ramp to six/eight;
- do not make browser/WebSocket work wait on Internal API admission;
- preserve `Retry-After` and stable error codes.

#### Task 1.3 — Make resident-session cleanup budget-aware

**Files:** `server/src/pi/multi-session-manager.ts`,
`server/src/websocket/connection.ts`, and Pi unit tests.

**RED tests:**

- configured resident-session limit is honoured;
- idle unpinned sessions are evicted before active, subscribed, or claimed
  sessions;
- pressure cleanup uses cgroup/RSS thresholds and does not raise the old
  2.5 GiB fixed threshold unchanged under an 8 GiB budget;
- a failed dispose cannot leave the session or its observer maps retained;
- repeated load/unload cycles return loaded sessions and observer counts to the
  expected baseline.

**Implementation requirements:**

- make the resident-session target configurable (initial staged target eight);
- preserve the existing two human-pin policy while treating source-owned claims
  separately;
- log cleanup decisions with session id/runtime and measured memory, never
  message bodies;
- call explicit observer/timer cleanup from every unload/dispose/stop path.

**Phase gate:** focused admission and Pi tests GREEN, then `npm run typecheck`
and `npm run build` before moving on.

---

### Phase 2 — Observer, broker, and queued-run ownership (P0)

#### Task 2.1 — Bound the Internal API event broker

**Files:** `server/src/internal-api/event-broker.ts`,
`server/src/internal-api/routes/sessions.ts`,
`server/tests/unit/internal-api/event-broker.test.ts`.

**RED tests:**

- `clear(sessionId)` removes subscribers and replay payloads;
- `clearAll()` removes every session and does not retain callback references;
- replay buffers expire/evict according to the configured bound;
- active SSE/watch consumers continue receiving events until they unsubscribe;
- a deleted/unloaded session does not retain a 100-event tail indefinitely when
  no consumer or durable watch needs it.

**Implementation requirements:**

- retain bounded replay by count and a time/session bound (do not create a
  second unbounded cache);
- distinguish active consumers from a historical evidence tail;
- make cleanup idempotent and observable through low-cardinality metrics;
- avoid clearing a buffer while a watch/SSE/notification subscriber still needs
  it.

#### Task 2.2 — Own and detach runtime observers

**Files:**

- `server/src/internal-api/routes/sessions.ts`;
- `server/src/pi/multi-session-manager.ts`;
- `server/src/opencode/opencode-service.ts`;
- notification/observer integration only where needed to avoid duplicate
  ownership;
- `server/tests/unit/pi/multi-session-manager.test.ts` and relevant route tests.

**RED tests:**

- attaching the same persistent observer twice is idempotent;
- unloading/disposal removes all API observers for that session;
- a later rehydration can attach a fresh observer (no stale `Set` says it is
  already attached);
- deleting a session removes Pi/OpenCode observer callbacks and queued maps;
- `MultiSessionManager.dispose()` clears `apiObservers`, error-grace timers,
  subscription queues, and extension snapshots;
- a live watch or SSE keeps its observation path alive, while its final
  unsubscribe permits cleanup.

**Implementation requirements:**

- store observer callbacks, not only boolean/set membership, so they can be
  removed exactly;
- use a small reference/ownership mechanism: persistent broker observer,
  watch, SSE, notification, and queued-run owners must be distinguishable;
- add an unload/dispose hook or reconciliation callback so the route-level
  observer registry cannot become stale when the manager evicts independently;
- detach observers in `finally` blocks and on route shutdown;
- do not use a global `clearQueue()` or `clearAll()` that deletes another
  client's valid work without preserving/reinstating it.

#### Task 2.3 — Fence stalled/cancelled Pi queued follow-ups

The current route correlates active Pi follow-ups through queue snapshots. The
remaining risk is a watchdog-terminalised queued run: the receipt may be
terminal while the SDK queue entry can still be delivered later.

**Files:** `server/src/internal-api/routes/sessions.ts`,
`server/src/internal-api/run-receipts/run-receipt-manager.ts`,
`server/src/pi/multi-session-manager.ts`, and
`server/tests/unit/internal-api/session-routes-prompt-modes.test.ts`.

**RED tests:**

- an idle `follow_up` promotes to a real prompt and completes;
- a busy Pi `follow_up` is queued, becomes `started` only when its own user
  message is observed, and reaches one terminal receipt;
- a queued run that times out is terminalised as `TURN_STALLED`, releases
  admission, is removed/fenced before delivery, and cannot later mutate the
  transcript as an accepted run;
- abort/delete removes the queued run's observer/subscription and does not
  delete a different queued follow-up;
- a late `agent_end` is recorded as late evidence, never as a second success;
- the watchdog terminal path resolves any waiting prompt boundary and removes
  per-prompt observers, so no promise or callback remains live.

**Implementation requirements:**

- add a run-stall/cancel callback or explicit lifecycle registry so the
  watchdog can ask the owning runtime adapter to fence work; do not rely only
  on `executePromptWithReceipt()`'s race, because detached queued prompts do
  not remain in that call;
- remove one queued message without dropping unrelated queued messages, or
  abort/rebuild the queue with an explicitly tested preservation algorithm;
- make terminalisation, runtime abort, observer removal, and admission release
  idempotent and ordered;
- keep the existing `RunReceiptStore` restart-recovery evidence and liveness
  provenance intact.

**Phase gate:** route, broker, Pi lifecycle, and run-receipt focused suites GREEN;
no observer/broker/queued-run count grows after a repeated test loop.

---

### Phase 3 — Shutdown lifecycle and truthful readiness (P0)

#### Task 3.1 — Make shutdown idempotent and complete

**Files:** `server/src/index.ts`, `server/src/internal-api/server.ts`,
`server/src/internal-api/server-shutdown.ts`,
`server/src/websocket/connection.ts`, and their tests.

**RED tests:**

- two SIGTERM/SIGINT calls share one shutdown promise and execute teardown once;
- normal shutdown closes HTTP keep-alive sockets, WebSocket clients, SSE, runtime
  services, Pi sessions, watches, brokers, timers, and owned child processes;
- `server.close()` completion produces exit code 0 and no `Forced shutdown` log;
- a persistent socket is destroyed only after the configured grace period;
- a second stop call is safe after the server is already closed;
- a shutdown failure in one runtime does not prevent other runtime cleanup and
  is reported after all owners were attempted.

**Implementation requirements:**

- stop accepting new Internal API work before tearing down dependencies;
- track main HTTP sockets as the Internal API server already does;
- close WebSocket clients through an awaited/ bounded close path before
  disposing runtime services;
- call `WatchManager.close()`, detach route observers, clear broker buffers,
  and flush notification/run-receipt ledgers in the correct order;
- replace the unconditional five-second application force-exit with a grace
  bounded by the systemd `TimeoutStopSec=30`; a last-resort timeout must be
  distinguishable from normal shutdown and must not report normal SIGTERM as
  `status=1/FAILURE`;
- guard against late runtime callbacks after teardown.

#### Task 3.2 — Correct `/api/health/ready`

**Files:** `server/src/routes/health.ts`,
`server/tests/unit/routes/health.test.ts`, and health documentation.

**RED tests:**

- a large V8 `heapTotal` with modest heap use does not report false 90% heap
  failure;
- V8 heap-limit percentage and cgroup RSS percentage are separate fields;
- a service cgroup limit is preferred to host memory when available;
- a genuinely high RSS/cgroup reading reports degraded/error with a useful,
  bounded message;
- missing cgroup data uses a clearly labelled fallback and does not throw;
- readiness remains independent of a single runtime not being installed when
  that runtime is configured as optional.

**Implementation requirements:**

- use `v8.getHeapStatistics().heap_size_limit` for V8 heap capacity;
- use cgroup-aware current/limit for service memory, falling back to RSS/host
  memory only when necessary;
- report `heapUsed`, `heapLimit`, `rss`, `cgroupCurrent`, `cgroupLimit`, source,
  and thresholds without exposing paths or secrets unnecessarily;
- keep `/health/live` liveness semantics unchanged.

**Phase gate:** shutdown/readiness tests GREEN; disposable server can start,
serve health, receive SIGTERM, close its socket, and exit cleanly.

---

### Phase 4 — OpenCode ownership and child-process reaping (P0)

#### Task 4.1 — Replace broad external process killing

**Files:** `server/src/opencode/opencode-process-manager.ts`,
`server/src/opencode/opencode-service.ts`,
`server/tests/unit/opencode/opencode-process-manager.test.ts`, and OpenCode
ops documentation.

**RED tests:**

- a process spawned by this manager is marked owned, has a tracked PID/process
  group, and is terminated with SIGTERM followed by bounded SIGKILL fallback;
- `error`, `exit`, timeout, and repeated `stop()` paths are idempotent;
- an already-healthy server is reported as external/attached and is **never**
  killed by normal shutdown or recycle;
- recycling an external server returns a deferred/explicit result rather than
  using `pgrep -f` and killing arbitrary matching processes;
- service shutdown clears session callbacks, API observers, permission maps,
  SSE subscriptions, and lifecycle timers after the process decision is made;
- no child remains after a managed stop in the fake process-tree test.

**Implementation requirements:**

- remove the broad `pgrep -f opencode serve.*--port ...` kill path;
- keep external attach read-only by default; if an operator wants to recycle
  an external service, make that a separately authorised operation with an
  explicit identity/owner check;
- prefer an owned process group or an enumerated descendant-PID tree, with
  timeout and idempotent cleanup; do not kill Caddy or unrelated services;
- log ownership (`managed`/`external`), PID, start time, and stop result;
- make `OpenCodeService.shutdown()` deterministic even if the server was
  attached externally.

#### Task 4.2 — Inventory the existing processes safely

After the code and tests pass, inspect the 18 observed processes with bounded
`ps`, `ss`, cgroup, parent-PID, start-time, and command metadata. Do not kill
anything merely because it matches `opencode serve`.

For each process classify `owned-by-pi-web-ui`, `owned-by-other-service`, or
`orphan/unknown`. Only an operator-authorised cleanup may terminate a confirmed
orphan, and it must be performed under the production lock with a before/after
PID and port check. The execution report must state that Caddy was not touched.

**Phase gate:** no broad process-kill command remains in production code; unit
suite and a disposable OpenCode smoke pass are GREEN.

---

### Phase 5 — Retention, watch, and registry pressure (P1)

#### Task 5.1 — Bound resident retention leases

**Files:** `server/src/internal-api/pin-expiry-manager.ts`, its store/types,
`server/src/internal-api/session-validation.ts`, route tests, `.env.example`,
and `docs/INTERNAL-API.md` / `docs/LONG-HORIZON-VALIDATION.md`.

**RED tests:**

- resident leases have an enforced maximum count and maximum TTL;
- durable-only leases do not materialise a runtime session;
- expired leases are removed durably even when the session is gone;
- restart rehydration never resurrects an expired claim;
- owner mismatch cannot release another caller's claim;
- failed pin/unpin/store operations do not leave a half-recorded lease;
- legacy pin compatibility remains bounded and observable.

**Implementation requirements:**

- retain the current seven-day hard maximum unless evidence justifies a smaller
  value; add a finite resident-lease count configured for the 8 GiB budget;
- make owner/source and expiry visible in evidence; never log tokens;
- on session deletion, release only claims owned by the relevant source;
- distinguish durable recoverability from resident memory retention.

#### Task 5.2 — Give watches a bounded lifecycle

**Files:** `server/src/internal-api/watch/watch-manager.ts`, watch store/types,
watch routes, `server/tests/unit/internal-api/watch-manager.test.ts`,
`watch-routes.test.ts`, and long-horizon docs.

**RED tests:**

- an active watch has a bounded expiry/owner record;
- expiry marks the watch closed/detached, removes its broker subscription, and
  releases only its own runtime claim;
- replacing/deleting a watch is idempotent and cannot double-unpin;
- shutdown closes live subscriptions and timers without deleting evidence;
- reloaded detached ledgers remain readable but do not silently resume live
  observation;
- firings remain capped and persisted atomically.

**Implementation requirements:**

- preserve the documented restart behaviour: a reloaded watch is `detached` and
  must be registered again to observe new events;
- add an optional owner/TTL (with a safe backward-compatible default) and
  document how a long-horizon caller renews/re-registers;
- call `watchManager.close()` from session-route shutdown;
- clear broker state only when no other consumer owns it.

#### Task 5.3 — Keep registry history separate from resident memory

Do not delete old session records or files as a memory fix. Add bounded
observability for registry count, materialised sessions, retained sessions,
active watches, resident leases, and session-file bytes. If a future retention
policy deletes history, it must be a separately approved, copy-safe migration.

**Phase gate:** lease/watch tests GREEN; a long-horizon disposable run records
firings, survives validator disconnect/restart as detached evidence, and does
not retain a live observer after expiry.

---

### Phase 6 — Stop-source instrumentation and documentation (P1)

#### Task 6.1 — Make shutdown causes attributable

**Files:** `server/src/index.ts`, central logging/observability modules,
`DEPLOYMENT.md`, `docs/OBSERVABILITY.md`, and optionally a small host-side
`deploy/systemd/` helper if it is generic and contains no machine-specific
paths/secrets.

Add structured, bounded records for:

- shutdown requested: signal, PID, parent PID, invocation/correlation id, and
  uptime;
- shutdown completed: duration, forced flag, remaining sockets/children, and
  first failure;
- startup/restart: service PID, socket ownership, runtime child ownership;
- cgroup memory current/max/events at startup, cleanup, refusal, and shutdown.

To identify who initiates scheduled/operator stops, document and, where
permitted by host policy, enable audit coverage for `systemctl`/`sudo` execution
and journal fields (`INVOCATION_ID`, `SERVICE_RESULT`, `EXIT_CODE`). The app
cannot infer an operator identity from SIGTERM alone. Do not log environment
values or bearer tokens.

#### Task 6.2 — Update canonical docs

Update, as applicable:

- `DEPLOYMENT.md` memory example and admission defaults;
- `.env.example` comments/defaults;
- `docs/INTERNAL-API.md` capacity, admission, and retention contracts;
- `docs/LIVE-VALIDATION.md` new disposable scenarios and production guardrails;
- `docs/LONG-HORIZON-VALIDATION.md` watch expiry/detached semantics;
- `docs/OBSERVABILITY.md`, `docs/TROUBLESHOOTING.md`, and
  `docs/SHARP-EDGES.md` for cgroup, shutdown, and OpenCode ownership;
- `docs/MAINTAINER-INDEX.md` only if a new canonical document is introduced.

Run `npm run docs:sync-agent-guides` only if `AGENTS.md` changes; otherwise
verify `npm run docs:check-agent-guides`.

---

## 7. Live validation and load proof

Read `docs/LIVE-VALIDATION.md` and use disposable validation by default. Never
point a validator at `~/.pi-web-ui/internal-api.sock` or production unless the
operator explicitly authorises that exact production check and the runner uses
`--allow-production`.

### 7.1 Disposable runtime matrix

Start one isolated validation server with a short path and run:

```bash
npm run validate:live -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime all --scenario smoke --json
```

Then run the relevant scenarios per runtime (Pi, Claude, OpenCode):

- `smoke` and `run-receipt-idempotency`;
- `follow-up`, `follow-up-strict`, and `prompt-mode-busy` where supported;
- `stalled-run-reaped` with `INTERNAL_API_TURN_IDLE_TIMEOUT_MS=2000`;
- `session-evidence` to prove bounded liveness/retention/residency evidence;
- `notify-on-agent-end` to ensure observer cleanup does not duplicate or lose
  notification events (capture channel only; never real Telegram);
- a new `shutdown-clean` scenario or equivalent harness: SIGTERM the disposable
  server, assert socket cleanup, exit 0, no forced-shutdown record, and no owned
  child process left;
- an OpenCode ownership scenario proving attached external processes are not
  killed and managed processes are reaped.

A skipped runtime is capability evidence, not a pass. A failed disposable
scenario must be investigated before any production validation.

### 7.2 Long-horizon proof

Use `npm run validate:long-horizon` for a watch that must outlive a polling
client. Verify:

- ledger firings are durable and bounded;
- a server restart preserves the ledger but reloads it as `detached`;
- the validator explicitly registers a new watch before expecting new firings;
- expiry releases the watch-owned claim and broker observer;
- stalled runs eventually become terminal and release capacity.

### 7.3 Resource-load proof

Add or use a bounded load harness that creates 1, 3, 5, and (only after the
first gate) 6 concurrent turns across disposable Pi/Claude/OpenCode sessions.
At each step sample:

- `/api/v1/capacity`;
- process RSS and V8 heap limit;
- validation cgroup `memory.current`, `memory.max`, and `memory.events`;
- receipt status/terminal counts and stall count;
- broker/observer/watch/lease counts;
- OpenCode managed/external PID counts and CPU;
- readiness status and journal diagnostics.

Initial acceptance targets:

- no `oom`, `oom_kill`, `max`, or unexpected `high` event;
- no receipt remains accepted/queued/started after its watchdog window;
- no duplicate `agent_end` terminalisation or false success;
- no unbounded growth in broker buffers, observer maps, timers, or child PIDs;
- readiness stays `200` under normal designed load;
- memory remains below the application refusal threshold with the configured
  reservation; record actual peak and per-turn cost rather than claiming a
  generic percentage;
- all four runtime paths remain available where the host supports them.

Only after this evidence may the production API slot or resident-session target
be raised. If the evidence is mixed, keep the conservative cap and report the
limiting resource.

### 7.4 Browser/WebSocket regression

If protocol or connection teardown changes affect the browser path, run the
isolated browser-WebSocket or Playwright path described in
`docs/LIVE-VALIDATION.md`; for localhost UI work use `webapp-testing`. Prove:

- session switching/subscription still works;
- user-facing stop/abort still works;
- notification/AskUserQuestion messages are not lost;
- a browser disconnect does not delete another client's queued work;
- reconnect clears the correct grace timer.

Do not use the production browser or Caddy for this gate.

---

## 8. Quality gates and required commands

The execution agent must not skip a gate because a later live test appears
healthy. Run the narrowest relevant check after each phase, then the full set:

```bash
npm run docs:check-agent-guides
npm run docs:check-links
npm run lint
npm run typecheck
npm run build
npm test
```

When applicable also run:

```bash
npm run test:e2e
npm run benchmark:quick
npm run benchmark
```

Use focused commands first, for example:

```bash
npm test --workspace=server -- admission-controller.test.ts
npm test --workspace=server -- event-broker.test.ts
npm test --workspace=server -- run-receipt-manager.test.ts
npm test --workspace=server -- server-shutdown.test.ts
npm test --workspace=server -- opencode-process-manager.test.ts
npm test --workspace=server -- multi-session-manager.test.ts
```

Use the repository's actual Vitest invocation if the workspace script does not
accept a file filter; record the exact command and result in the report.

Before commit/push:

```bash
git status --short
git diff --stat
git diff --cached --stat
```

Explicitly inspect the diff for `.env*` files, tokens, cookies, auth dumps,
session JSONL, notification spools, generated validation directories, and local
machine files. None may be committed.

A quality gate is **blocked**, not passed, when:

- a test was written after implementation without recorded RED output;
- a disposable live test touched production state;
- any OOM/max event occurred without a documented explanation and rollback;
- a normal SIGTERM reports forced/status-1 failure;
- a child process is unclassified or an external process was killed broadly;
- a receipt, observer, lease, watch, or broker buffer remains unowned;
- Caddy was restarted or changed.

---

## 9. Controlled production rollout

Production changes happen only after all code/docs/unit/live gates pass and the
operator has authorised rollout. The plan's service operation scope is
`pi-web-ui.service` only.

### Preflight

1. Reconfirm `git status`, diff, build artifact timestamp, service PID, port 3456,
   Caddy health, and the production lock.
2. Capture current service values and memory/receipt/process baselines.
3. Verify no OpenCode process will be killed by the new ownership logic merely
   because it is external/attached.
4. Ensure the production `.env.production` values are set through the host's
   secret/configuration mechanism; never commit it.

### Rollout under the production lock

Use the repository's canonical build/restart path, for example:

```bash
npm run production:lock -- npm run build
npm run production:lock -- systemctl daemon-reload
npm run production:lock -- systemctl restart pi-web-ui.service
```

The exact command sequence must respect the host's lock wrapper and should be
reported. Do not restart Caddy, `agent-os-supervisor.service`, or an unrelated
OpenCode unit as part of this plan.

Apply the service configuration as host configuration:

```ini
MemoryMax=8G
MemoryHigh=8G
MemorySwapMax=512M
Environment=NODE_OPTIONS=--max-old-space-size=4096
TimeoutStopSec=30
```

Start with the conservative admission values in §3.2. If changing the unit
through a drop-in, record its path and `systemctl show` output; if editing the
existing unit, record the before/after values.

### Immediate verification

Within the same locked operation:

- `systemctl is-active pi-web-ui.service` is `active`;
- `/health`, `/api/health/ready`, and authenticated `/api/v1/health` return
  expected success and all supported runtimes are reported;
- the internal API socket/token are present with safe ownership/mode;
- `/api/v1/capacity` reports `limitBytes` near `8 * 1024^3`, the correct cgroup
  source/path, configured slots, and zero stale active/stalled runs;
- the service PID/cgroup contains only expected owned children;
- journal shows startup and no `Forced shutdown`, `EADDRINUSE`, or broad process
  kill;
- Caddy is still healthy and its PID/configuration is unchanged.

### Ramp and rollback

Hold the initial six total slots for an observation window. Raise slots or the
resident-session target only if the resource-load evidence remains within the
thresholds in §7.3. If lag, memory pressure, stalls, or child growth returns,
first lower admission/resident caps and stop orphaned **confirmed-owned**
processes; do not immediately raise memory again.

Rollback is also locked and service-only: restore the previous code/unit values
(4G max, 3G high, 2 GiB Node old-space, and prior admission caps), rebuild if
needed, and restart only `pi-web-ui.service`. Preserve receipts, diagnostics,
and evidence from the failed attempt. Do not delete session history or touch
Caddy.

### Post-rollout monitoring

Notify a `milestone` after immediate verification and a single `done` only after
the observation window. Review at least:

- `journalctl -u pi-web-ui.service` for shutdown/startup cause and forced exits;
- cgroup `memory.current`, `memory.events`, and service RSS/CPU;
- `/api/v1/capacity`, run receipts, leases, watches, broker/observer metrics;
- OpenCode owned/external process inventory;
- readiness and supervisor socket errors.

If a decision is genuinely required (for example, whether a confirmed external
OpenCode server may be terminated), send one `question` notification with the
specific evidence and options; do not guess.

---

## 10. Recommended improvements after the critical path

These are deliberately sequenced after P0 stability:

1. Add a small capacity dashboard/alert from `/api/v1/capacity`, cgroup
   `memory.events`, receipt stalls, and shutdown cause records.
2. Add a periodic bounded report of materialised sessions versus registry
   sessions and session-file bytes; never equate registry count with heap use.
3. Add an explicit ownership/renewal view for Agent OS retention and watches so
   long-running automation can explain why a session remains resident.
4. Add a disposable multi-runtime resource benchmark to CI/nightly validation,
   with no provider secrets in artifacts.
5. Add a host-level audit runbook for scheduled `systemctl` operations and
   supervisor restarts so the initiating actor is attributable without relying
   on inference from the application journal.
6. Consider a separate systemd unit or cgroup for intentionally external
   OpenCode servers only after an explicit attach-only lifecycle is implemented;
   never add a `Wants=opencode-serve.service` dependency to Pi Web UI by
   accident.

---

## 11. Definition of done

The execution is complete only when all of the following are true:

- the 8 GiB/8 GiB service budget is documented and, when authorised, applied;
- Node heap, admission, resident sessions, swap, and application thresholds are
  coherent with that budget;
- cgroup-aware capacity tests prove the service limit is used;
- every new production code path has a recorded failing test followed by GREEN;
- observer/broker/queue/lease/watch cleanup is idempotent and bounded;
- stalled runs are fenced at the runtime boundary and release capacity;
- normal shutdown exits cleanly without the five-second forced-failure path;
- readiness no longer reports the heap-ratio false positive;
- managed OpenCode children are reaped and external children are not broadly
  killed;
- focused tests, lint, typecheck, build, full tests, and relevant E2E/live/load
  validation pass;
- production verification confirms Pi Web UI only was restarted, Caddy was not
  touched, and no secrets or session artifacts entered GitHub;
- the execution report includes evidence, exact commands, failures and fixes,
  final limits/caps, rollback status, and the final Telegram `done` notification.
