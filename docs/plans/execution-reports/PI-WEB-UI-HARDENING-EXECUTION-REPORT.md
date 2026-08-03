# Pi Web UI Hardening — Execution Report (Phases 0–2)

**Plan:** `docs/plans/PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md`
**Scope executed:** Phases 0–2 only (owner-pre-authorised boundary).
**Operator decisions applied:** pre-auth through end of Phase 2; prod restarts OK at any stage; Task 2.4 Agent OS client patch in scope; TasksMax applied (measured); tmux cleanup only if it does not disturb `/root/tmux`; independent review by fresh agents (Claude subagents, plus cross-model reviewer at production gates).
**Convention:** every claim carries an evidence label per plan §6.3 (`planned` / `implemented-not-validated` / `unit-validated` / `integration-validated` / `live-validated-disposable` / `deployed-production` / `observed-production`).

---

## Phase 0 — Re-baseline, topology freeze, execution safety

**Evidence label:** `observed-production` (read-only; no production code/config change).
**Pause decision:** `proceed` (recorded below, pending fresh-agent review).

### Snapshot captured 2026-08-03 (re-baseline; counts are a dated snapshot, not constants)

Service & memory (live `systemctl show` + cgroup files):

| Metric | Value |
|---|---|
| MainPID | 2630772 (`/usr/bin/node server/dist/index.js`) |
| ControlGroup | `/system.slice/pi-web-ui.service` (nested service cgroup, **not** root) |
| MemoryCurrent | 3,710,013,440 (~3.45 GiB) |
| MemoryPeak | 7,669,620,736 (~7.14 GiB, cgroup lifetime) |
| MemoryHigh / MemoryMax / SwapMax | 9 GiB / 12 GiB / 512 MiB (matches locked §3.1 posture) |
| TasksCurrent / TasksMax | 622 / 37,558 (effectively unbounded) |
| `memory.events` | `high 0 max 0 oom 0 oom_kill 0` — **no pressure events** |
| `pids.events` | `max 0` |
| PSI (cpu/io/mem) | all avg10/60/300 ≈ 0.00 (no sustained pressure) |
| EnvironmentFiles | `/root/pi-web-ui/.env.production` |
| Memory drop-ins | `50-MemoryHigh.conf`, `50-MemoryMax.conf` |

Capacity endpoint is materially wrong (confirmed live, `GET /api/v1/capacity`):

| Field | Advertised | Real / target |
|---|---|---|
| `memory.limitBytes` | ~30.6 GiB (host-sized) | service MemoryMax = 12 GiB |
| `memory.currentBytes` | ~431 MiB | service MemoryCurrent = 3.45 GiB |
| `maxActiveTurns` / `apiTurnLimit` | 16 / 15 (CPU-derived) | target 6 |
| `minimumHeadroomBytes` | 512 MiB | target 1536 MiB |
| `reservedBytesPerTurn` | 256 MiB | target 768 MiB |

Contract: `contractVersion 1.14.0`. `/api/v1/health` shows all runtimes `available`, opencode `enabled:true backend:server`.

### Ownership classification

| Class | Evidence | Action |
|---|---|---|
| **Pi-Web-UI-managed OpenCode** | pid 2630994, port 4097, cgroup `/system.slice/pi-web-ui.service`, ppid = service MainPID. `opencodeServerEnabled` defaults true (`config.ts:261`); lazy-spawned via `ensureServer()`. | Phase 1.3 stops it by setting `OPENCODE_ENABLED=false` + restart. **Inside the service; no `/root/tmux` contact.** |
| **Stale `opencode serve` in tmux scopes** | 17 procs across 5 of the 8 `twui-tmux-*.scope` units (15–35 days old; scopes are `tmux-web-ui.service` = `/root/tmux` infrastructure; each scope exec line is `tmux new-session -d -s claude\|pi\|picodereview`). | **HELD — not touched.** Scopes belong to `/root/tmux`; per operator condition, anything that could disturb `/root/tmux` is out of scope. |
| **Agent OS worktree descendants** | ~56 idle e2e fixture procs under `/root/agent-os-wt-mscush3r-kdky` plus 1 under a second worktree `agent-os-wt-mscush3rd-jop7`; all sleeping, cumulative cputime ~103 s over ~6 h — not active work. Real Agent OS supervision lives in the separate `agent-os-supervisor.service` cgroup. | Restart will reap them (operator-authorised). `RunReceiptStore.init()` marks in-flight receipts interrupted. |
| **Pi runtime** | backend `native`, in-process; 0 active turns → no worker-pool subprocesses resident. | Unchanged. |

### Task 1.4 (tmux cleanup) resolution

**No-op under operator condition.** The candidate `twui-tmux-*.scope` units are active, running `tmux-web-ui.service` sessions (the `/root/tmux` system). Stopping them would interact with `/root/tmux` session management. Per the operator's hard condition and plan Task 1.4's hold rule (ambiguous / owned scopes are held, not stopped), **no scope is touched**. The 17 stale `opencode serve` procs (~4 GiB reclaimable) remain for a separate, exact-scope, operator-authorised operation outside this effort. **No broad `pgrep`/`pkill`/`tmux kill-server` used or planned.**

### Rollback values recorded (pre-change)

- Memory: Max 12G / High 9G / SwapMax 512M (drop-ins); immediate rollback target per plan = 8G max / 6G high, Node heap stays 2G.
- Node: `NODE_OPTIONS=--max-old-space-size=2048`; `TimeoutStopSec=30`.
- TasksMax: 37,558 (pre-change); Phase 2 will set a measured value (512–768 candidate) with this as rollback.
- Admission: current = CPU-derived 16/15/512/256 (the unsafe state); Phase 2 rollback = revert capacity-source code change.

### Gate 0 checks

```
npm run docs:check-agent-guides  → AGENTS.md and CLAUDE.md byte-identical  ✅
npm run docs:check-links         → 636 links resolve across 72 files      ✅
npm run internal-api:wait        → {"status":"ready"}                     ✅
```

### Code-surface map (for Phases 1–2; from read-only exploration)

OpenCode disable surface:
- Flag: `server/src/config.ts:261` `opencodeServerEnabled = OPENCODE_ENABLED !== 'false'`.
- Consumers: `opencode-service.ts:259` (ctor), `:503-505` (`validateSetup` short-circuit), `opencode-process-manager.ts:48-50` (`doStart` backstop).
- Capabilities gap (Phase 1.1 work): `routes/capabilities.ts` derives `available` from `isAvailable()` = PATH probe only (`process-manager.ts:34-41`); does **not** reflect the flag. `/api/v1/health` does (`runtime-health.ts:56-61` → `checkStatus:'disabled'`, `enabled:false`).
- Error codes: `RUNTIME_UNAVAILABLE`, `OPENCODE_UNAVAILABLE` (`error-codes.ts:34-35`); emitted at `sessions.ts:632/669/692`, `models.ts:194`, transfer (`TRANSFER_RUNTIME_UNAVAILABLE`).
- UI: `NewSessionModal.tsx:393-413`, `TransferConfirmationModal.tsx:278-291` gate on store flag driven by WS `opencode_available` (`connection.ts:164-188` calls `validateSetup()`) → disables correctly with no client change.
- Startup: no eager spawn; lazy via `ensureServer()`; disabled flag short-circuits before spawn.
- Existing tests: `opencode-health.test.ts:70-83` (disabled path), `health-routes.test.ts:47`, `runtime-availability.test.ts`, `error-codes.test.ts`, `capabilities.test.ts:97-98`.

### Pause 0 decision

`proceed` — Phase 1 touches only `pi-web-ui.service` (set env flag + restart). No `/root/tmux` scope or tmux process is touched. No active work is interrupted that the operator has not authorised (restart authorised; resident worktree procs are idle stale e2e servers).

**Independent review (fresh agent):** verdict `proceed`, no critical/high findings. Confirmed via cgroup-authoritative evidence: (a) managed opencode pid 2630994/port 4097 inside the service cgroup; (b) 17 stale opencode procs in `twui-tmux-*.scope` (sibling cgroups under `system.slice`, not members of the service cgroup); (c) ~57 idle Agent OS worktree fixture procs. Verified `pi-web-ui.service` has no `BindsTo`/`PartOf` to any tmux unit and `tmux-web-ui.service`/scopes have no reverse binding, so a `systemctl restart pi-web-ui.service` cannot reach `/root/tmux`. `KillMode=control-group` reaps only (a) and (c). Two low-severity report-accuracy corrections applied above (17 not ~19; second worktree `mscush3rd-jop7` added).

---

## Phase 1 — Temporarily inactivate OpenCode + disabled-runtime contract

**Evidence label:** `observed-production` (code `unit-validated`; disposable `live-validated-disposable`; prod `deployed-production` + `observed-production`).

### Task 1.1 — disabled-runtime contract (TDD)

Behaviour changes, each RED recorded before GREEN:

1. **Capabilities distinction** — `/api/v1/capabilities` reported opencode `available` from a PATH probe only, ignoring `OPENCODE_ENABLED`. RED (`capabilities.test.ts`): disabled-but-installed opencode returned `available:true` and no `enabled` field. GREEN: added `isEnabled()` to `OpenCodeService` (`opencode-service.ts`), `enabled?: boolean` to `RuntimeCapabilities` (`types.ts`), and the route now sets opencode `available = enabled && isAvailable()` with `enabled` on every runtime (`routes/capabilities.ts`).
2. **Creation fail-closed** — `sessions.ts:667` guarded creation with `isAvailable()` only, so disabled-but-installed slipped through to `createSession()`. RED (`session-routes-live-validation.test.ts`): disabled create returned 201. GREEN: added `isEnabled()` guard returning `503 RUNTIME_UNAVAILABLE` before any spawn.
3. **Transfer fail-closed** — `transfer-service.ts` opencode create-target and send-prompt paths null-checked the service only. RED (`transfer-service.test.ts`): disabled new-target transfer succeeded. GREEN: added `isEnabled()` guards returning `TRANSFER_RUNTIME_UNAVAILABLE`.

Contract bumped **1.14.0 → 1.15.0** (`types.ts:57` + `INTERNAL-API-CONTRACT.md` changelog). Docs: `OPENCODE-DIRECT-INTEGRATION.md` (temporary-inactivation runbook), `.env.example` (OPENCODE_ENABLED effect). ARCHITECTURE/DEPLOYMENT unchanged — they describe supported capability, not a false live-production claim.

**Validation:** `npm run typecheck` ✓, `npm run build` ✓, `npm test --workspace=server` → **2685 passed / 0 failed** (added 3 tests; fixed 4 existing opencode mocks to include `isEnabled`).

### Task 1.2 — disposable disabled-runtime validation (`live-validated-disposable`)

Booted an isolated disposable server (`validate:server --dir <tmp> --port 4599`, `OPENCODE_ENABLED=false`, `PI_AGENT_DIR`/`PI_CODING_AGENT_DIR` isolated). Probed its Internal API socket:

| Check | Result |
|---|---|
| `/api/v1/health` opencode | `enabled:false`, `checkStatus:'disabled'`, legacy map `unavailable` |
| `/api/v1/capabilities` | contract `1.15.0`; opencode `enabled:false/available:false`; pi+claude `enabled:true/available:true` |
| `POST /api/v1/sessions {runtime:opencode}` | HTTP **503 `RUNTIME_UNAVAILABLE`**, no session created |
| managed `opencode serve` spawned | **none** (every opencode proc listed was pre-existing prod/tmux; opencode-port had no listener) |

Server shut down; port freed; temp dir removed; prod untouched.

### Task 1.3 — production inactivation (`deployed-production` + `observed-production`)

Maintenance handshake: 0 active turns, 0 stalled runs before restart. Under one production lock (`scripts/with-production-lock.sh`), rebuilt dist, set `OPENCODE_ENABLED=false` in `/root/pi-web-ui/.env.production` (value confirmed, no secrets printed), restarted `pi-web-ui.service` only.

| Check | BEFORE | AFTER |
|---|---|---|
| service MainPID | 2630772 | 3169672 |
| `OPENCODE_ENABLED` in `/proc/<pid>/environ` | (true) | **false** ✓ |
| managed opencode port 4097 / PID | listening / 2630994 | **gone / not respawned** ✓ |
| `/capabilities` opencode | `enabled:absent, available:true` | `enabled:false, available:false`, contract **1.15.0** |
| `/api/v1/health` opencode | enabled/available | `checkStatus:'disabled'` |
| registry entries | 315 (`28f606a818e70e08`) | 315 (`28f606a818e70e08`) — **preserved** ✓ |
| pi / claude / antigravity | available | `enabled:true/available:true` ✓ |
| `tmux-web-ui.service` MainPID | 2544053 | 2544053 — **unchanged** ✓ |
| active tmux sessions | 3 | same 3 ✓ |
| journal | — | no `Forced shutdown`/`EADDRINUSE`/broad kill ✓ |

(Caddy reports `inactive` — its pre-existing state; the locked command touched only `pi-web-ui.service`.)

### Task 1.4 — stale tmux-scope cleanup

**No-op (held).** The `twui-tmux-*.scope` units are active `tmux-web-ui.service` sessions (`/root/tmux` infrastructure). Per the operator's hard condition and Task 1.4's hold rule, no scope is touched. The 17 stale `opencode serve` procs (~4 GiB) remain for a separate exact-scope operation. **No broad `pgrep`/`pkill`/`tmux kill-server` used.**

### Pause 1 decision

`proceed` (pending independent review below) — OpenCode is disabled in production, its managed backend is absent, the disabled-runtime contract is live and truthful, historical state is preserved, and `/root/tmux` is untouched.

**Independent review (fresh agent):** verdict `proceed`, no critical/high findings. Findings addressed below: (MEDIUM) per-behaviour RED evidence added to the §"RED → GREEN evidence" appendix; (LOW) registry fingerprint relabelled as an entry-id digest, not a file hash; (LOW) observation window noted as short and to be extended before any §11 final sign-off; (LOW) immediate Phase-1/2 rollback separated from the §10 re-enable gate in §"Rollback".

---

## Phase 2 — Truthful cgroup capacity + conservative admission

**Evidence label:** capacity code `unit-validated` (15 resolver + 6 admission tests); disposable `live-validated-disposable`; prod `deployed-production` + `observed-production` (short window).

### Task 2.1–2.2 — resolve the actual service cgroup (TDD)

`readMemoryCapacity()` previously read the cgroup-*root* (`admission-controller.ts` opened `/sys/fs/cgroup/memory.current` + `memory.max`, falling back to host `totalmem()`), advertising a host-sized limit. New module `server/src/internal-api/cgroup-capacity.ts`:

- `parseSelfCgroupV2` — parses `0::/...` from `/proc/self/cgroup`; rejects v1/empty/traversal.
- `resolveCgroupFsPath` — safe join beneath the cgroup root; rejects `..`/escape.
- `readServiceMemoryCapacity` — prefers the nested service cgroup (`memory.current`/`max`/`high`), then root, then process-RSS; `max`/missing/invalid falls through (never fabricates a number); returns `source`.
- `readServicePidsCapacity` — `pids.current`/`pids.max` from the service cgroup; `max` surfaced as `undefined`.

Wired into `AdmissionController` (default `memory`/`readPids`); snapshot now exposes `memory.source`, `memory.highBytes`, and `pids: {current,max,source}`.

### Task 2.3 — conservative admission config

The env plumbing already existed (`config.ts` → `index.ts` → `server.ts`); production now sets `INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS=6`, `INTERACTIVE_RESERVE=1`, `MIN_HEADROOM_MB=1536`, `RESERVED_MB_PER_TURN=768` in `.env.production`. A baseline test locks the projection (apiTurnLimit=5, refusal `global_limit` with `Retry-After`).

**TasksMax (measured):** post-restart idle = 11 tasks (`pids.peak=28`); the 3-Aug heavy-turn incident peaked at ~482 tasks. Set `TasksMax=1024` (~2× a heavy turn; catches fork-bomb runaway that the unbounded 37558 permitted; never trips normal builds/tests). Pre-change 37558 recorded; rollback is an explicit `set-property`. Above the plan's 512–768 candidate because ~482 heavy-turn footprint leaves insufficient headroom under 768 for concurrent legitimate work; memory (12G/9G) + admission remain primary.

### Phase 2 disposable live validation (`live-validated-disposable`)

Booted the server under a `systemd-run` transient scope with `MemoryMax=2G`/`MemoryHigh=1.5G`/`TasksMax=512`:

| field | direct cgroup file | `/capacity` |
|---|---|---|
| memory.max | 2,147,483,648 | 2,147,483,648 ✓ |
| memory.high | 1,610,612,736 | 1,610,612,736 ✓ |
| memory.current | 364,363,776 | 364,634,112 ✓ |
| pids.max | 512 | 512 ✓ |
| source | — | `service` ✓ |

Old code would have reported ~30 GiB host; the resolver reports the exact nested scope.

### Task 2.4 — production rollout + Agent OS compat patch (`deployed-production`)

Under the production lock: rebuilt dist, applied `TasksMax=1024`, restarted `pi-web-ui.service` only. `/capacity` now matches the real service cgroup exactly:

| field | direct cgroup | `/capacity` BEFORE → AFTER |
|---|---|---|
| memory.limitBytes | 12,884,901,888 (12G) | ~30.6 GiB (host) → **12,884,901,888** ✓ |
| memory.currentBytes | 148,639,744 | ~431 MiB → **148,901,888** ✓ |
| memory.highBytes | 9,663,676,416 (9G) | (absent) → **9,663,676,416** ✓ |
| maxActiveTurns | — | 16 (CPU) → **6** ✓ |
| apiTurnLimit | — | 15 → **5** ✓ |
| minimumHeadroomBytes | — | 512 MiB → **1,536 MiB** ✓ |
| reservedBytesPerTurn | — | 256 MiB → **768 MiB** ✓ |
| pids.max | 1024 | 37558 → **1024** ✓ |
| source | — | (absent) → **`service`** ✓ |

Contract still `1.15.0`; opencode still `enabled:false/available:false`; tmux-web-ui MainPID unchanged (2544053), 3 sessions; registry 315 entries (20 opencode preserved); journal clean.

**Agent OS client compat (`/root/agent-os`):** bumped the contract mirror `CURRENT_PI_WEB_UI_CONTRACT_VERSION` `1.14.0 → 1.15.0` + its 2 mirroring assertions. Agent OS's capacity preflight (`conductor/dispatch.ts`) already fails conservative — it requires `getCapacity`, refuses when `!capacity.available` or a runtime is at its `maxActiveTurns`, and gates features via forward-compatible `contractAtLeast` minimums — so it consumes the corrected 6-turn capacity safely. 96 dispatch/contract/pi-web-ui tests pass.

### Pause 2 decision

`proceed` — `/capacity` is truthful (matches the service cgroup), admission is conservative (6/1/1536/768), TasksMax is bounded (1024), and `/root/tmux` is untouched.

**Independent review — fresh agent (read the code + verified LIVE):** verdict `proceed`, no critical/high findings. Confirmed exact `/capacity`↔direct-cgroup parity (limit/high/max exact; current within timing drift), resolver never fabricates a limit, TasksMax=1024 with idle=11, tmux MainPID unchanged, registry 315 (20 opencode). The §11 critical-hardening items (truthful capacity, conservative admission, bounded TasksMax) all hold. LOW findings: a report digit typo (fixed: 12,884,901,848→888); observation window is short (Phase-2-scoped, extend before §11 final); admission default stays CPU-derived if env ever lost (documented latent property, not a defect).

**Independent review — cross-model** (dispatched to a disposable server as `gpt-5.6-luna`; the Pi runtime served `openai/gpt-5.5`): no blockers. Confirmed the fallback ordering + non-fabrication are correct and the cgroup path is kernel-provided (low escape risk). Two forward-looking notes, both out of Phase 2 scope and explicitly acceptable now:
- *Ancestor fallback* — if the Node process ever runs in a child cgroup whose `memory.max=max` while the parent service holds the real limit, the resolver would fall through instead of walking ancestors. Live production is exactly `/system.slice/pi-web-ui.service`, so this is correct today; it becomes relevant at Phase 6 (per-session cgroups) and should be hardened then.
- *PID admission guard* — PID pressure is currently surfaced (`pids` in the snapshot) but not admitted against; a turn near the TasksMax ceiling would surface as in-tool fork errors rather than a graceful capacity refusal. Adding a `pids.current/pids.max` admission threshold is a Phase 3–4 refinement.

Both gates pass; Phase 0–2 is complete and may be committed.

---

## RED → GREEN evidence (per §6.4 ledger)

Recorded failure output before each implementation (commands run with `npx vitest run <file>`):

- **capabilities disabled distinction** — `capabilities.test.ts`: `AssertionError: expected { available: true, …(13) } to match object { enabled: false, available: false }`. GREEN after `isEnabled()` + `enabled` field.
- **creation fail-closed** — `session-routes-live-validation.test.ts`: `expect(res.statusCode).toBe(503)` → received `201`. GREEN after the `isEnabled()` guard in `sessions.ts`.
- **transfer fail-closed** — `transfer-service.test.ts`: `expect(result.success).toBe(false)` → `createSession` was called (success true). GREEN after the two `isEnabled()` guards.
- **cgroup resolver** — `cgroup-capacity.test.ts`: `Error: Failed to load url ../../../src/internal-api/cgroup-capacity.js … Does the file exist?` GREEN after the module (15 tests).
- **conservative config / snapshot telemetry** — baseline verification tests (behaviour already supported by existing env plumbing + the new wiring), recorded as verified baseline per §6.2, not RED→GREEN.

## Rollback

- **Immediate Phase 1/2 rollback (stay-safe):** `OPENCODE_ENABLED=true` is NOT the immediate rollback — re-enabling is gated (see below). The safe rollback for a Phase 1 contract regression is to revert the `1.15.0` presentation/contract change while leaving OpenCode disabled; for Phase 2, revert the capacity-source code/env (`maxActiveTurns` returns to CPU-derived) — no history is ever deleted.
- **Memory:** drop-ins restore 8G max / 6G high (Node heap stays 2G). **TasksMax:** `systemctl set-property pi-web-ui.service TasksMax=37558` (never a broad `systemctl revert`).
- **OpenCode re-enable (plan §10, NOT part of this rollback):** prohibited until Phase 3.5 exact managed/attached ownership safety is deployed and disposable-live validated; only then may a separate owner decision set `OPENCODE_ENABLED=true` under the maintenance handshake/lock.

## Observation window & limitations

- `observed-production` rests on a short post-restart window (~minutes). Adequate for the narrow Phase 1/2 disable + capacity scope; a longer soak must precede any §11 final hardening sign-off.
- Pi/Claude live smoke was covered by the disposable boot (server healthy, `/capacity`/`/capabilities`/`/health` truthful) + the 2702-test unit suite incl. receipt-idempotency and capacity handling; no credential-bearing runtime smoke was run against production.
