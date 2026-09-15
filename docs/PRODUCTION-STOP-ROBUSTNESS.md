# Production stop robustness

Canonical reference for how `pi-web-ui.service` is stopped, why stops used to
run to systemd's `TimeoutStopSec` and lose the control group with them, what is
now instrumented, what remains unestablished, and (added 2026-09-15) who can
restart it, what that costs when a test does it, and which guards now make a
silent restart loud instead of invisible.

Companion surfaces:

- `deploy/systemd/pi-web-ui.service` — the unit (unchanged by this work)
- `deploy/systemd/pi-web-ui.service.d/10-stop-audit.conf` — the stop-audit drop-in
- `scripts/systemd-stop-audit.sh` — the `ExecStopPre`/`ExecStopPost` hook
- `scripts/record-restart-requester.sh` — the one requester record both restart paths write
- `scripts/restart-pi-web-ui.sh` — the restart path that names its requester
- `scripts/restart-production.sh` — the canonical pre-flight restart path
- `scripts/check-unexplained-stops.ts` — cross-checks systemd's stops against the requester records
- `server/tests/systemctl-guard.ts` — the guard that stops a test process driving the host service manager
- [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md#unexplained-restarts-what-is-instrumented-and-one-dead-end-2026-09-14) — session-ID evidence ladder and log lookup
- [`docs/LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) — the cgroup guard for disposable validation

## The incident — 2026-09-15 08:29:56 → 08:30:50 UTC

Proved from the journal, not inferred:

| Time (UTC) | Event |
|---|---|
| 08:29:56 | A stop of `pi-web-ui.service` begins (`TimeoutStopUSec=30` ⇒ 08:30:26 minus 30s) |
| 08:29:58 → 08:30:17 | The process keeps serving: memory log, client pings, a **new** WebSocket client connects at 08:30:13 and switches session at 08:30:16 |
| 08:30:26 | `State 'stop-sigterm' timed out. Killing.` → SIGKILL to the whole control group: the main node process, `npm run validate:server`, `npm exec tsx`, three `esbuild` processes, and four mid-turn orchestration children |
| 08:30:26 | `Failed with result 'timeout'`; `ExecStopPost` fires: `STOP OBSERVED code=killed signal=KILL` |
| 08:30:36 → 08:30:50 | `Scheduled restart job, restart counter is at 1` → unit active again |

**The app never ran its shutdown handler.** No `[Server] Shutting down...`, no
step timings, no `Shutdown complete` — while the same PID that systemd reported
as the main process was still logging and accepting connections 17–21s into the
stop window. So the loop was alive and the SIGTERM path did not execute.

## The decisive discriminator

This is the finding that makes the event class diagnosable, and it was not
previously recorded:

> systemd emits `Stopping <unit>...` **only when `unit_stop()` returns > 0**
> (`systemd` v255 `src/core/job.c:873-878`), and `service_stop()` returns 0
> whenever the unit is already in a stopping state **or** is in
> `START_PRE`/`START`/`START_POST`/`RELOAD` (`src/core/service.c:2765-2821`).

Correlating every stop of this unit between 2026-09-14 and 2026-09-15 gives a
perfect relationship:

| Stop time (UTC) | `Stopping ...` logged | App handler ran | Outcome |
|---|---|---|---|
| 09-14 04:50:54 | yes | yes | clean restart |
| 09-14 12:54:25 | yes | yes | clean restart |
| 09-14 14:09:17 | yes | yes | clean restart |
| 09-14 15:03:00 | yes | yes | exit 1 (forced; `http-server` step hung) |
| **09-14 15:26:12** | **no** | **no** | SIGKILL after timeout |
| 09-14 15:30:07 | yes | yes | clean restart |
| **09-14 15:43:23** | **no** | **no** | SIGKILL after timeout |
| **09-14 15:57:42** | **no** | **no** | SIGKILL after timeout |
| **09-14 16:03:39** | **no** | **no** | SIGKILL after timeout |
| **09-14 16:10:55** | **no** | **no** | SIGKILL after timeout |
| **09-14 16:33:07** | **no** | **no** | SIGKILL after timeout |
| 09-14 16:34:15–16:45 | (watchdog) | n/a | `Failed with result 'watchdog'` ×11 — a *separate* defect (unref'd watchdog worker), fixed 2026-09-14 |
| 09-14 16:45:08 | yes | yes | clean restart, 31ms |
| 09-14 18:04:17 | yes | yes | exit 1 (forced; `http-server` step hung) |
| 09-14 21:15:56 | yes | yes | exit 1 (forced; `http-server` step hung) |
| **09-15 08:30:26** | **no** | **no** | SIGKILL after timeout |

15 stop events, 7 of them SIGKILLs after a full 30s, and the `Stopping ...` line
present exactly when the handler ran. Two consequences:

1. **The 08:30 stop was not a stop job against a RUNNING unit.** At 08:29:56 the
   service had been running since 09-14 21:16, so a stop job would have logged
   the line. It came from systemd's internal stop paths instead, of which the
   candidates that fit a healthy RUNNING unit are narrow.
2. **The handback question "who asked for a restart?" may be the wrong first
   question for these seven events.** Whatever initiated them, the literal
   `systemctl restart` hypothesis would have produced the `Stopping ...` line.

### Candidate mechanism (NOT established)

The only systemd path that stops a healthy RUNNING service without a job, and
without an INFO-level log, is
`service_notify_cgroup_oom_event()` with `OOMPolicy=stop`
(`src/core/service.c:3648-3676`). It is **not established** as the cause:

- it logs at **debug** level (`"Process of control group was killed by the OOM
  killer."`), so at the default `LogLevel=info` it leaves no journal trace at
  all;
- the unit's `OOMPolicy=stop` is confirmed via `systemctl show`;
- the 08:30 kill reports `Consumed … 4.0G memory peak`, and the unit file says
  `MemoryMax=4G` — but **no kernel OOM message exists anywhere in the journal
  for 09-14 or 09-15**, and `systemd-oomd` is `inactive`. A kernel cgroup-OOM
  kill would have logged `oom-kill:` and `Out of memory: Killed process`.

The 09-14 16:33 event reports only a 1.5G peak, which does not fit either.
**What actually stopped the unit seven times is not established.**

### What is ruled out, with evidence

- **The event loop being blocked.** It was logging and serving throughout.
- **Watchdog expiry.** All watchdog outcomes are labelled `Failed with result
  'watchdog'` and killed with SIGABRT; the seven events are `'timeout'`/SIGKILL.
- **`auditd` / an execve rule.** `auditd` is not installed and `/etc/audit/rules.d`
  does not exist.
- **`dbus-monitor`.** Root `systemctl` uses `/run/systemd/private`, not the
  system bus; verified blind on 2026-09-14. Do not repeat this.
- **The catalogue-refresh timers.** `command-code-model-refresh.timer` last ran
  09-14 04:48 and was not due for days.
- **The host-update agent.** It ran 07:55–08:04, explicitly deferred
  `pi-web-ui.service` in `needrestart`, and did not restart the unit. Both of its
  board entries and its session log confirm this.
- **The `-.mount` dependency.** `RequiresMountsFor=/root/pi-web-ui` generates
  `Requires=-.mount system.slice sysinit.target`; no mount unit changed state in
  the window.

## What is now instrumented

### 1. The stop is recorded from systemd's side (drop-in)

`ExecStopPre` runs **before SIGTERM**, while the app is still alive — the only
hook that can prove systemd was about to signal the unit. `ExecStopPost` runs
after, with `SERVICE_RESULT`, `EXIT_CODE` and `EXIT_STATUS` populated.

```
STOP-AUDIT phase=pre ts=<ISO8601Z> invocation=<id> service_result=<r> exit_code=<c>
  exit_status=<s> mainpid=<pid> main_alive=<yes|no> active_state=<..> sub_state=<..>
  unit_result=<..> nrestarts=<n> elapsed_s=<n|unset> main_started=<..>
  cgroup_procs=<n> procs=<comma-separated process names>
```

Written to the journal **and** to an append-only, bounded
`/root/.pi-web-ui/stop-audit.log`, because the journal has already lost one stop
line and a single lost line is the difference between a diagnosis and another
unexplained restart. Never fails the stop (a failing `ExecStopPre` marks the unit
failed).

Reading next time:

- `phase=pre` present, app `[Shutdown] event=stop_signal` absent → SIGTERM was
  sent and the process did not handle it.
- `phase=pre` absent → the stop never reached the signal stage.
- `elapsed_s` is the stop duration even when the app was killed.

### 2. The stop is recorded from the app's side, synchronously

`server/src/shutdown-signal.ts`, on signal receipt and **before any `await`**:

```
[Shutdown] event=stop_signal signal=SIGTERM received_at=<ISO8601Z> pid=… ppid=… uptime_s=… note="recorded synchronously before any await"
```

Written with `fs.writeSync(2, …)` (`server/src/sync-stderr.ts`), not
`process.stderr.write` — the latter is **asynchronous on a pipe**, and live
validation of the worker proved the reason line is lost that way.

The same handler publishes the signal time into a `SharedArrayBuffer` and arms a
hard-exit deadline, both synchronously.

### 3. A backstop that survives a blocked main thread

`server/src/shutdown-escape-worker.ts` runs on a worker thread — the same
reasoning that moved the watchdog ping off the loop it watches. If the process is
still alive `PI_WEB_UI_SHUTDOWN_ESCAPE_MS` after the signal was recorded
(default 12000), it writes and then ends the process:

```
[Shutdown] event=shutdown_escape signal_recorded_ms_ago=… window_ms=… action=force_exit note="main thread did not exit inside the grace window; ending the process before systemd TimeoutStopSec"
```

Known limit, stated rather than hidden: the worker can only act once the **main
thread has recorded the signal**. A SIGTERM delivered to a process whose loop is
blocked *before* the handler runs leaves no `stop_signal` line and the worker
stays idle — and that gap is exactly what `ExecStopPre` closes from systemd's
side (it records that a stop was starting, regardless of the app).

### 4. `server.close()` is bounded

Proved defect: on 09-14 18:04:17 and 21:15:56 the handler ran, five of six steps
finished within 25 ms, and the `http-server` step never completed —
`server.close()` waits for every open connection, and WebSocket clients are
long-lived by design. Live measurement of the same condition:

```
CONTROL bare close() with a live client:        STILL-PENDING after 5005ms
FIX    closeHttpServer() with the same client:  closed after 2ms
```

`server/src/http-server-close.ts` stops listening, drops remaining connections,
and reports `timed-out` rather than blocking teardown.

## Timing ladder

Keep these consistent; the margin before systemd's escalation is the point.

| Offset | Event |
|---|---|
| t+0s | systemd may send SIGTERM; the app records it synchronously |
| t+12s | escape worker force-exits if the process is still alive (`PI_WEB_UI_SHUTDOWN_ESCAPE_MS`) |
| t+20s | `ShutdownCoordinator` hard-exit deadline (`DEFAULT_FORCE_EXIT_AFTER_MS`) |
| t+30s | systemd `TimeoutStopUSec` → SIGKILL of the whole control group |

Reaching the last row loses work that no record can recover.

## Install

```bash
sudo mkdir -p /etc/systemd/system/pi-web-ui.service.d
sudo cp deploy/systemd/pi-web-ui.service.d/10-stop-audit.conf /etc/systemd/system/pi-web-ui.service.d/
sudo systemctl daemon-reload
systemctl show pi-web-ui.service -p ExecStopPre -p ExecStopPost
```

The host's `/etc/systemd/system/pi-web-ui.service` currently carries an ad-hoc
`ExecStopPost` added on 2026-09-14 that is **not** in the repo's unit file.
`ExecStopPost` directives accumulate, so installing the drop-in yields both
records; the new `STOP-AUDIT` line supersedes it and the old line can be deleted.
See the drop-in's header for the exact string.

Restart with the naming wrapper, not `systemctl` directly:

```bash
scripts/restart-pi-web-ui.sh --reason "why you are restarting"
```

## Verify

```bash
# the audit hook records, and never fails the stop
sudo env INVOCATION_ID=test MAINPID=1 /root/pi-web-ui/scripts/systemd-stop-audit.sh pre

# the requester is named, without restarting anything
scripts/restart-pi-web-ui.sh --reason "verification" --dry-run

# what happened on the last stop
journalctl -u pi-web-ui.service --since "-1h" | grep -E 'STOP-AUDIT|RESTART-REQUESTED|event=stop_signal|event=shutdown_escape'

# the durable record
tail -5 /root/.pi-web-ui/stop-audit.log

# which stops were SIGKILLed rather than handled
journalctl -u pi-web-ui.service | grep 'event=stop_signal'
```

## Naming the requester: a platform limit, stated

Nothing in this repository can name an arbitrary process that asks systemd to
stop the unit:

- `auditd` is not installed and there is no `/etc/audit/rules.d`, so an `execve`
  rule on `/usr/bin/systemctl` cannot be added without installing it;
- root `systemctl` talks to `/run/systemd/private`, so bus monitoring is
  structurally blind (verified 2026-09-14);
- the remaining option is `LogLevel=debug` in `/etc/systemd/system.conf` plus
  `systemctl daemon-reexec`. That does log the job's origin, but it is a
  host-wide change needing the owner's agreement.

What the repo can do, and now does, is make every restart path it owns announce
itself *before* restarting — uid, user, pid, ppid, tty, cwd, argv, reason, and
the ancestor chain up to PID 1 — in the journal and the durable audit file.

**Corrected 2026-09-15 (this claim was falsified twice in one day).** This
section used to end: "A restart that does not appear there is, by elimination,
not one of ours." That inference is wrong, and acting on it wasted real time.
The record is written by the requesting code itself, so it can be redirected or
simply never written:

- **14:27:05Z** — the record was redirected. A Vitest run of
  `restart-drainage.test.ts` executed a `git stash`-ed revision of
  `scripts/restart-pi-web-ui.sh`; the suite pointed `PI_WEB_UI_STOP_AUDIT_FILE`
  at its own temp file, so production's record has no `RESTART-REQUESTED` line
  for a restart that was entirely repository-caused. A fixed suite (commit
  `d921ac7`) put a `systemctl` stub on PATH so this cannot recur from that suite;
  the test workspace now installs that guard for every test process (see below).
- **15:35:23Z** — the record was never written. The restart went through
  `scripts/restart-production.sh`, the repo's own canonical path, which
  announced itself only through the notification hook. Both paths now share one
  recorder, `scripts/record-restart-requester.sh`.

What is true instead: a restart with no record is a restart nobody claimed, and
the honest instrument is a cross-check of two independently written lanes — the
stops systemd logged and the records the repository claims. That is
`scripts/check-unexplained-stops.ts` (see below).

## Restart paths reachable on this host

| Path | Can it restart while turns are active? | Notes |
|---|---|---|
| `scripts/command-code-weekly-refresh.ts` (§8) | **Yes, by design** | Only when `--restart` is set *and* it committed. It polls `/capacity.activeTurns` for up to 30 min (30s poll) and restarts once it reads `0`. |
| `scripts/restart-pi-web-ui.sh` | Yes, immediately | Names the requester via `record-restart-requester.sh`; takes the cooperative production lock by default. Use this for deliberate restarts. |
| `scripts/restart-production.sh` | Yes, immediately | The canonical pre-flight path; since 2026-09-15 it names the requester too, and refuses unknown arguments rather than ignoring them. |
| `server/tests/unit/restart-drainage.test.ts` and any suite that runs those scripts | **Yes, if a stub is missing** | This is the path that actually restarted production at 14:27:05Z. Three layers now protect it: the scripts' own pre-flight; the suite's own PATH stub (`d921ac7`); and the **test-workspace guard** (`server/tests/systemctl-guard.ts`, installed by `tests/setup-env.ts`) which refuses any state-changing `systemctl` verb in any test process, whatever revision of whatever script asks. |
| `with-production-lock.sh` | No — it is a lock, not a restart | Prevents two builds/restarts/deploys interleaving. |
| `docs/TROUBLESHOOTING.md` (`sudo systemctl restart pi-web-ui`) | Yes, immediately, no idle check | Documentation only, but it is an instruction an agent may follow. |
| `deploy/systemd/*.service` | No | The three refresh units run one-shots and call the Internal API; only the Command Code weekly refresh restarts, via the script above. |
| `agent-os-supervisor.service` | No | `Wants=pi-web-ui.service`; a one-shot orphan-recovery scan that never restarts the unit. |
| `pi-web-ui-health-probe.service` | No, by design | Alert-only; asserted by `server/tests/integration/health-probe-script.test.ts`. |

### Preventing a repeat, and what is honestly not preventable

The 14:27:05Z restart was not bad luck: it had a mechanism, and the mechanism had
three structural enablers — the interception lived **inside the code under test**
(so the red-proof `git stash` removed the guard and the interception together),
the suite could reach the **production unit name** from any worktree, and the
suite ran **inside the unit's own control group**, so it killed itself too.

Layers now in place, each deliberately owned by something *other* than the code
under test (all shipped 2026-09-15, `server/tests/systemctl-guard.ts`):

1. **The test workspace cannot drive the service manager.** A `systemctl` shim is
   prepended to `PATH` for every Vitest process by `tests/setup-env.ts`. Mutating
   verbs are refused with a non-zero exit and recorded in a durable log
   (`$TMPDIR/pi-web-ui-systemctl-guard-*.log`); read-only verbs pass through to
   the real binary. No test may remove it, because no test owns it — reverting an
   implementation cannot revert the environment that runs it.
2. **A test cannot pollute production's restart record.** `tests/setup-env.ts`
   redirects `PI_WEB_UI_STOP_AUDIT_FILE` to a per-process temp path, so even a
   suite that forgets the seam cannot append a false requester line.
3. **Silences are made loud.** `scripts/check-unexplained-stops.ts` compares
   systemd's stop events with the requester records and reports every stop nobody
   claimed (with the surrounding journal context and a heuristic split between
   systemd's own restart policy and an unclaimed request). Read-only; installing
   it on a timer is an owner decision.

What remains possible, stated plainly: any human or agent with root on this host
and a checkout can still run `systemctl restart pi-web-ui`, and a test *outside*
Vitest (a bare `node`, a shell script, a CI runner) is not covered by the guard.
Preventing that class entirely is not a script change — it is containment, which
is the unstarted out-of-process-worker roadmap in
[`PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md): workers in their
own scope/slice, so production's unit is not reachable from, and not killed by,
the things that share the host with it. Friction-bearing alternatives were
considered and rejected for now (they buy less than they cost): a mandatory
approval token for non-dry-run restarts would break the weekly catalogue
refresh's unattended restart; making `--no-lock` verify lock ownership is
narrower but does nothing against a reverted revision, because that check lives
in the code under test; and `RefuseManualStop=yes` on the unit would refuse *all*
restarts, including the repository's own audited path.

### The idle check can be raced

`command-code-weekly-refresh.ts` reads `capacity.activeTurns`, then — in a
separate step — calls `systemctl restart`. Between that read and the restart a
new turn can start, so `activeTurns === 0` is a *sample*, not a reservation.
Verified today that the sampler itself is not obviously broken:
`/capacity.activeTurns` correctly reported `4` while four sessions were busy.
The race is in the gap, not the gauge.

The fix belongs with that workstream (currently owner-gated) and is one line:
route the restart through `scripts/restart-pi-web-ui.sh` and take the production
lock, or have the Internal API expose a "reserve an idle window" primitive. Until
then, treat the refresh's restart as best-effort idle-aware, not exclusive.

---

## Sibling defect — a watch wake silently lost to the idle watchdog

Same family (a liveness instrument acting on a run it cannot see), different
layer, and it happened six minutes after the 08:30 restart. Bounded evidence,
collected 2026-09-15.

### The event

Run `5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f` targeted **this parent session**
(`01a0a410-…`):

| Field | Value |
|---|---|
| accepted / started | `08:36:09.437Z` / `08:36:09.457Z` (20 ms apart) |
| mode / dispatchMode | `follow_up` / **`prompt`** |
| outputEvidence | 0 assistant messages, 0 tool calls, `disposition: "unknown"` |
| terminal | `08:51:10.383Z` — exactly the 15-minute idle window |
| watchdog | `reason: "idle"`, `idleTimeoutMs: 900000`, `cessation.basis: "watchdog"` |
| errorCode / status | `TURN_STALLED` / `failed` |

Operator notice: *"Run quarantined (TURN_STALLED) … terminalised by the watchdog
without confirmed runtime cessation. The admission slot is held until the runtime
confirms cessation (or a 30s drain quarantine)."*

### Verified / refuted

**Verified.** The wake was silently lost. The parent session's JSONL contains no
user message carrying the wake — the conversation runs
`08:36:03.838` (custom) → `08:36:13.837` (its own assistant turn) with nothing in
between. The parent never saw it. The watchdog did terminalise the run, and the
reason recorded was `idle`.

**Refuted — and this matters.** It was **not** a `follow_up` parked behind the
parent's own long turn. The receipt records `mode: follow_up` but
**`dispatchMode: "prompt"`**: the watch-wake resolver promotes to a plain prompt
when it believes the target is idle (`routes/sessions.ts`:
`if (!busy) dispatchMode = 'prompt'`), and only queues
(`queue_while_busy`, pi-only) when it sees the session busy. So the dispatcher
believed the session was free and dispatched a real turn — it did not queue
behind the parent. What the same request *did* log is the reason the turn could
not run:

```
08:36:09 [MultiSessionManager] Rehydrating session from disk: …/01a0a410-….jsonl
08:36:09 [auto-compact-75] Ownership: conflict (pid 2142860, tui) — session is owned by another
         live runtime (pid 2142860). This runtime is fenced.
```

So the session was rehydrated into this service while a **bare-CLI/TUI `pi`
process still owned it**, the dispatch went to a fenced instance, and the run was
marked started with nothing behind it.

**Also refuted.** The notice's claim that the slot is held is wrong for this
event, and `quarantinedRuns` proves it: measured after the event, `/capacity`
returns `quarantinedRuns: 0` (and `stalledRuns: 6`). `terminalize()` holds the
lease through `drainAndRelease`; because the runtime was never executing this run,
`isRuntimeQuiescent` returned true on the first poll and the lease was released.
The observed `activeTurns` returning to 4 with 4 busy sessions is therefore
correct, not a leak.

### Which watchdog applies, and why the reason was wrong

`reconcileStalledRuns` iterates `activeRuns`, which `addActive()` populates for
every non-terminal receipt — including `queued` (`isTerminal` excludes it) — with
`lastActivityAtMs = acceptedAtMs`. The **idle** watchdog therefore applies to a
queued or accepted-but-never-executing run, and measures from **acceptance**, not
from turn start. `lastActivityAtMs` only advances on eligible activity events, of
which a run that never executes produces none, so 15 minutes after acceptance the
idle watchdog fires.

`idle` was the wrong reason: it asserts a turn was executing and went quiet. A run
with zero eligible activity events and zero output evidence never executed at all.

### Fixed (small, in the watchdog area)

1. **`RunStallReason` gains `no_activity`** (`types.ts`, allowlisted in
   `run-receipt-store.ts`). `reconcileStalledRuns` classifies a run as
   `no_activity` when the idle window elapses and `neverProducedWork(active)` — no
   eligible activity ever **and** no assistant/tool output evidence. `absolute`
   still wins when the ceiling is hit; `idle` is unchanged for a turn that really
   was working. The log line now says so explicitly instead of
   "idle timeout exceeded".
2. **The operator notice no longer lies.** `run-receipts/stall-notification.ts`
   (pure, tested) titles a never-executed run **"Wake lost (never executed)"**,
   states that the message never reached the session, offers the actionable step
   (re-dispatch), and drops the false "slot is held / 30s drain quarantine / no
   action required" claims. Quarantine wording is kept for genuinely executing
   turns, with the drain described as it behaves (drain → release on quiescence,
   otherwise held as capacity debt). A comment in `server.ts` that claimed the
   slot "is already released by terminalisation" — contradicting the notice and
   the code — is corrected.
3. **The live-validation scenario stays honest.** `stalled-run-reaped` asserted
   `reason === 'idle'`; it now asserts the reason **pairs with observed work**
   (`toolCalls > 0` ⇒ `idle`, otherwise `no_activity`), so neither an honest
   classification nor a never-executed run can pass silently.

Tests: `run-stall-classification.test.ts` (6), `stall-notification.test.ts` (5),
plus two existing tests that pinned the old `idle` label, updated rather than
deleted.

### What was deliberately NOT changed

- **Not exempting queued runs from the idle watchdog.** A queued run that is
  never drained would then hold an admission slot until the 6-hour absolute
  ceiling instead of 15 minutes — trading a lost wake for stranded capacity. The
  right bound for a queued run is neither the idle window nor the ceiling but a
  delivery deadline, and the right recovery is a reclaim/replay of the queued
  message, both of which are lifecycle features rather than watchdog fixes.
- **Not replaying the wake.** Re-delivery needs a policy decision (is a
  stale wake still wanted?), and the code has no place to record "this wake was
  never delivered" that a replay could read. Recommended follow-up, below.
- **`workState` stays `failed`.** The status honestly reflects that acceptance
  did not lead to completion; the distinction now lives in
  `liveness.watchdog.reason` and in the notice. Changing `workState` for this case
  would alter a public field's meaning for every consumer.

### Recommended follow-up (owner decision, not done here)

1. **Record the lost delivery on the receipt** — a `delivery: { queued, delivered }`
   marker set when a Pi follow-up is actually drained, so a lost wake is
   machine-readable and replayable rather than only inferable from
   `no_activity`.
2. **Reclaim or replay.** A `no_activity` wake on a session that was fenced by an
   owner conflict (as here) is recoverable: the wake text is still in the watch
   record. Either replay it once the ownership conflict clears, or surface it as a
   pending wake for the operator.
3. **A delivery deadline distinct from the idle window.** For `queue_while_busy`
   deliveries, bound queue residency separately, so a long legitimate parent turn
   cannot expire a wake that was correctly queued (the parent's own turn here ran
   `08:35:04` → `08:52`, **17 minutes** — longer than the 15-minute idle window,
   so a correctly-queued wake would have been killed too).
4. **`stalledRuns: 6` within about an hour** of the restart is worth a look: if
   several of those were also never-executed runs, the lost-wake rate is a
   pattern, not an incident.
