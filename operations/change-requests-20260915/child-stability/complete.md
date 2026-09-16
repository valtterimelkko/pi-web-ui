# Child S — production stop robustness (handback)

**Session:** `01a0a43c-d9cc-74e4-896e-6a5bd3e8986b` · **Tree:** `/root/pi-web-ui-wt-stability` (branch `task/production-stop-robustness`)
**Status:** complete — no git mutations, no `npm run build`, no service changes, no `/etc` writes, no production restart. Everything is staged for the parent to review and install.
**Evidence:** `./evidence/` (this directory)

---

## 1. Headline: the incident class is now decidable, and one mechanism is named

The brief said the initiator was unknowable. It largely still is — but the *event
class* is now diagnosable from the journal alone, and that is new.

**The decisive finding.** systemd emits `Stopping <unit>...` **only when
`unit_stop()` returns > 0** (`systemd` v255 `src/core/job.c:873-878`), and
`service_stop()` returns 0 whenever the unit is already stopping **or** is in
`START_PRE`/`START`/`START_POST`/`RELOAD` (`src/core/service.c:2765-2821`).
Correlating every stop of this unit across 2026-09-14/15 gives a **perfect**
relationship over **15 stop events**:

| | `Stopping ...` logged | app handler ran |
|---|---|---|
| Clean/handled stops (8 events) | **yes** | **yes** |
| SIGKILL-after-timeout stops (**7** events) | **no** | **no** |

The brief described one SIGKILL. There were **seven**: 09-14 15:26:12, 15:43:23,
15:57:42, 16:03:39, 16:10:55, 16:33:07 and 09-15 08:30:26. Six of them
(`15:26`, `15:43`, `15:57`, `16:03`, `16:10`, `16:33` on 09-14) are
**not in the brief's incident list at all**, and they are the same defect class.

Consequences for the working hypothesis:

- At 08:29:56 the unit had been RUNNING since 09-14 21:16, so a stop job would
  have logged the line. **It was not a `systemctl restart` against a running
  unit** — which means "which agent ran `systemctl restart`" may be the wrong
  first question for these seven events.
- The only systemd path that stops a healthy RUNNING service with no job and no
  INFO-level log is `service_notify_cgroup_oom_event()` with `OOMPolicy=stop`
  (`src/core/service.c:3648-3676`), which logs at **debug** only.
  **Not established as the cause:** no kernel OOM message exists anywhere in the
  journal for 09-14/09-15, `systemd-oomd` is `inactive`, and the 16:33 event
  reports a 1.5G peak, which does not fit the 4G limit either. `OOMPolicy=stop`
  is confirmed on the unit via `systemctl show`.
- **What stopped it seven times is still not established.** The instruments added
  here are designed to name it next time (see §4).

Full write-up, ruled-out list with evidence, and restart-path audit:
**`docs/PRODUCTION-STOP-ROBUSTNESS.md`** (new canonical doc).

---

## 2. Required outcomes — what was delivered

| Outcome | Delivered | Evidence |
|---|---|---|
| **A.** Self-describing stops | drop-in with `ExecStopPre`/`ExecStopPost`; durable bounded audit file; synchronous pre-`await` signal record in the app; honest statement of what cannot be named | §3, `evidence/05`, `evidence/08` |
| **B.** Robust to a blocked/starved loop | worker-thread escape backstop; synchronous fd write; bounded `http-server` close; timing ladder with 10s margin | §3, `evidence/05`, `evidence/06` |
| **C.** Root-cause write-up | `docs/PRODUCTION-STOP-ROBUSTNESS.md` + restart-path audit + race analysis | §1, §4 |
| **D.** Cgroup hygiene | hard refusal in `scripts/validation-server.ts` + `systemd-run` recipe + explicit override | §5, `evidence/03`, `evidence/04` |
| **E.** Tests (TDD, RED first) | 8 new/extended test files, 91 tests green, RED captured first | §6 |
| **F.** Deployment left to the parent | diff, install steps, verification commands; nothing installed | §7 |

---

## 3. Exact log formats the instruments emit

**From the app, synchronously on signal receipt, before any `await`**
(`server/src/shutdown-signal.ts`, written with `fs.writeSync(2, …)`):

```
[Shutdown] event=stop_signal signal=SIGTERM received_at=2026-09-15T09:06:28.159Z pid=2232210 ppid=2232208 uptime_s=3 note="recorded synchronously before any await"
```

**From the escape backstop, on the worker thread** (`server/src/shutdown-escape-worker.ts`):

```
[Shutdown] event=shutdown_escape signal_recorded_ms_ago=3500 window_ms=3000 action=force_exit note="main thread did not exit inside the grace window; ending the process before systemd TimeoutStopSec"
```

**From the systemd drop-in, on every stop** (`scripts/systemd-stop-audit.sh`):

```
STOP-AUDIT phase=pre ts=<ISO8601Z> invocation=<id> service_result=unset exit_code=unset exit_status=unset mainpid=<pid> main_alive=yes active_state=active sub_state=running unit_result=success nrestarts=1 elapsed_s=unset main_started=<ts> cgroup_procs=<n> procs=<names>
STOP-AUDIT phase=post ts=<ISO8601Z> invocation=<id> service_result=timeout exit_code=killed exit_status=KILL mainpid=<pid> main_alive=no active_state=inactive sub_state=dead unit_result=timeout nrestarts=2 elapsed_s=30 ... cgroup_procs=<n> procs=<names>
```

- `SERVICE_RESULT` / `EXIT_CODE` / `EXIT_STATUS` are empty on `pre` (systemd does
  not populate them there) and recorded as `unset`, never guessed.
- `elapsed_s` is derived from the matching `pre` invocation — **the stop duration
  even when the app was killed and could not report it.**
- `procs` is the cgroup census, so the cost of `KillMode=control-group` is visible
  *before* it is paid again.
- Written to the journal **and** to an append-only, bounded
  `/root/.pi-web-ui/stop-audit.log`.

**From any repo-owned restart** (`scripts/restart-pi-web-ui.sh`):

```
RESTART-REQUESTED ts=<ISO8601Z> uid=0 user=root pid=… ppid=… tty=… cwd=… reason=… argv=… ancestors=<pid:comm>…
```

**Reading the pair next time:**

| `STOP-AUDIT phase=pre` | app `event=stop_signal` | Conclusion |
|---|---|---|
| present | present | SIGTERM reached the app and was handled |
| present | **absent** | SIGTERM was about to be sent and the app did not handle it |
| **absent** | absent | the stop never reached the signal stage |

---

## 4. What is proved vs inferred vs not established

**Proved (journal):**

1. `08:29:56` stop begins; `08:30:26` `State 'stop-sigterm' timed out. Killing.` →
   SIGKILL of the control group (`KillMode=control-group`) → `Failed with result
   'timeout'`; `08:30:36` `Scheduled restart job, restart counter is at 1`.
2. The killed group at 08:30 included the main node process, `npm run
   validate:server`, `npm exec tsx`, three `esbuild` processes and four mid-turn
   orchestration children.
3. **The app never ran its shutdown handler** while the same PID systemd reported
   as main was still logging and accepting connections 17–21s into the stop
   window (new WebSocket client connected 08:30:13; `switch_session` 08:30:16).
4. Seven `stop-sigterm timed out` events, each with **no** `Stopping ...` line and
   **no** app-side record; eight handled stops, each **with** the line.
5. Agent-side and systemd-side `ExecStopPost` instruments both fire, so stops are
   recorded now — but neither names a requester.
6. **Separate proved defect:** on 09-14 18:04:17 and 21:15:56 the handler ran,
   five of six steps finished within 25ms, and the `http-server` step never
   completed — `server.close()` waiting on long-lived WebSocket clients. The
   coordinator's 25s deadline was the only thing that ended those stops, leaving
   a few seconds of margin under `TimeoutStopSec=30`. Reproduced live:
   `bare close() with a live client → STILL-PENDING after 5005ms`.
7. `auditd` is not installed; `/etc/audit/rules.d` does not exist; no sudo record.
   Root `systemctl` uses `/run/systemd/private`, so `dbus-monitor` is blind
   (consistent with the pre-existing dead-end note).
8. Live unit configuration differs from the repo unit: `MemoryMax=18G`,
   `MemoryHigh=14G`, `TasksMax=8192` come from `systemctl set-property` drop-ins
   dated 2026-09-11; `OOMPolicy=stop`; `RequiresMountsFor=/root/pi-web-ui`
   generates `Requires=-.mount system.slice sysinit.target`.

**Inferred but not established:** the initiator; whether SIGTERM was delivered to
the main process at 08:30 (the evidence proves the *handler* did not run, not that
the signal was never delivered); the mechanism behind the seven internal stops.

**Ruled out, with evidence:** blocked event loop; watchdog expiry (all watchdog
outcomes are `'watchdog'`/SIGABRT, these seven are `'timeout'`/SIGKILL); the
catalogue-refresh timers (last ran 09-14 04:48); the host-update agent (it
explicitly deferred `pi-web-ui.service` in `needrestart` and did not restart the
unit); a mount-unit dependency (nothing changed state in the window).

**Platform limit, stated rather than papered over:** nothing in this repo can name
an arbitrary process that asks systemd to stop the unit. `auditd` is absent, bus
monitoring is structurally blind, and the only remaining option is
`LogLevel=debug` in `/etc/systemd/system.conf` + `daemon-reexec` — a host-wide
change needing the owner's agreement. What the repo *can* do, and now does, is
make every restart path it owns announce itself before restarting.

---

## 5. Cgroup hygiene live-validated in the real production cgroup

While working I discovered, and this is worth the parent's attention:

> **Every session dispatched through orchestration runs inside
> `/system.slice/pi-web-ui.service`.** Verified: `cat /proc/self/cgroup` in this
> session returns `0::/system.slice/pi-web-ui.service`, and the restart wrapper's
> ancestor chain resolves to `MainThread` (PID 2164396), the production node
> process. So *any* `npm run validate:server` started by a dispatched child is
> inside the production cgroup by default, with no visible signal to the agent.

Live results (`evidence/03`, `evidence/04`):

```
### LIVE 1: refusal in the real production cgroup (0::/system.slice/pi-web-ui.service)
[validation-server] Refusing to start a disposable validation server inside the production service cgroup
(/system.slice/pi-web-ui.service). ... systemd-run --scope --collect --unit=pi-web-ui-validate-<nonce> ...
EXIT=78                                   # EX_CONFIG, before any dir/lock/port

### LIVE 2: allow path inside an isolated scope
cgroup path = /system.slice/child-stability-guard-1789463035.scope
verdict = {"allowed":true,"reason":"outside-production-cgroup"}
EXIT=0                                    # scope auto-collected, verified gone
```

---

## 6. RED → GREEN, per behaviour

RED was captured by parking the new modules and re-running (`evidence/01-red-new-behaviours.txt`):

```
 Test Files  5 failed (5)
      Tests  no tests
```

GREEN (`evidence/08-green-final.txt`): **15 test files, 91 tests, all pass.**

| Behaviour | Test file | RED→GREEN |
|---|---|---|
| escape policy (timing, once-only, env parse) | `unit/shutdown-escape-policy.test.ts` (7) | yes |
| escape worker (idle/wait/escape ordering, refed timer) | `unit/shutdown-escape-worker.test.ts` (6) | yes |
| synchronous signal record + deadline arming | `unit/shutdown-signal.test.ts` (9) | yes |
| synchronous fd writer (bytes on fd before return) | `unit/sync-stderr.test.ts` (5) | yes |
| bounded http-server close | `unit/http-server-close.test.ts` (6) | yes |
| cgroup guard decision + path/text contract | `unit/validation-cgroup-guard.test.ts` (10) | yes |
| stop-audit + restart-wrapper shell instruments | `integration/stop-audit-scripts.test.ts` (11) | yes |
| guard refuses end-to-end (exit 78) | `integration/validation-server-cgroup-guard.test.ts` (2) | yes |

Existing suites extended/kept green: `shutdown-coordinator`, `shutdown-coordinator-timing`,
`systemd-notifier`, `systemd-notifier-watchdog`, `systemd-watchdog-worker`,
`watchdog-policy`, `fatal-error-handlers`.

**Two defects were found only by live validation, not by the unit tests:**

1. **Double-parse bug in the guard.** `checkValidationCgroup` accepted the *raw*
   `/proc/self/cgroup` text and re-parsed it, while `readSelfCgroup` returned an
   already-parsed path — so wiring them together silently produced `undetectable`
   and the guard **allowed exactly what it exists to refuse**. Unit tests passed
   because they fed file contents. Fixed (field renamed `cgroupPath`), with a
   regression test pinning the contract, and the integration test now refuses
   correctly (731ms, no server spawned).
2. **The escape reason was lost.** `process.stderr.write()` is asynchronous when
   fd 2 is a pipe, so the line was still buffered when the process ended: the live
   wedge run produced the right SIGKILL at the right moment with the reason
   **missing**. Fixed with `fs.writeSync(2, …)` (`server/src/sync-stderr.ts`) and
   re-proved. *The shipped watchdog pinger has the same pattern in its stall
   reports and was not changed — flagged as a latent issue for the parent.*

**Live proof of B** (`evidence/05-live-escape-wedge.txt`) — real modules, main
thread deliberately wedged inside `onShutdown`, run under
`systemd-run --scope`, escape window 3s:

```
[Harness] ready pid=2232210 escape_after_ms=3000
-- sending SIGTERM to harness pid 2232210 --
[Shutdown] event=stop_signal signal=SIGTERM received_at=... note="recorded synchronously before any await"
[Harness] onShutdown entered; blocking the event loop for 30s
[Shutdown] event=shutdown_escape signal_recorded_ms_ago=3500 window_ms=3000 action=force_exit ...
EXIT_CODE=137                              # ended at ~3.5s instead of systemd's 30s
```

**Live proof of the `http-server` fix** (`evidence/06-live-http-server-close.txt`):

```
CONTROL bare close() with a live client:        STILL-PENDING after 5005ms
FIX    closeHttpServer() with the same client:  closed after 2ms
```

Reproduction harnesses are kept at `evidence/live-harness/` so the parent can
re-run them. All scopes used were `--collect`ed and verified gone; no scopes,
processes or temporary validation directories of mine remain.

---

## 7. Install steps (parent only — nothing was installed)

### Step 1 — the stop-audit drop-in

```bash
sudo mkdir -p /etc/systemd/system/pi-web-ui.service.d
sudo cp deploy/systemd/pi-web-ui.service.d/10-stop-audit.conf /etc/systemd/system/pi-web-ui.service.d/
sudo systemctl daemon-reload
systemctl show pi-web-ui.service -p ExecStopPre -p ExecStopPost
```

Expected: both properties show
`/root/pi-web-ui/scripts/systemd-stop-audit.sh {pre,post}`.

**Host note.** `/etc/systemd/system/pi-web-ui.service` carries an ad-hoc
`ExecStopPost` added on 2026-09-14 that is **not** in the repo unit:

```
ExecStopPost=/bin/sh -c 'echo "pi-web-ui STOP OBSERVED code=${EXIT_CODE:-none} signal=${EXIT_STATUS:-none} at $(date -Is)"'
```

`ExecStopPost` directives accumulate, so installing the drop-in yields both
records. Harmless; the `STOP-AUDIT` line supersedes it. Delete that one line to
leave a single home for the audit. I did **not** touch the unit or `/etc`.

### Step 2 — app-side instruments (no unit change needed)

`server/src/index.ts` already wires them at module load. **They require a
rebuild/restart to take effect**, which the parent owns. No new environment
variables are required; the escape window is tunable via
`PI_WEB_UI_SHUTDOWN_ESCAPE_MS` (default 12000).

### Step 3 — optional: point the weekly refresh at the naming wrapper

`scripts/command-code-weekly-refresh.ts:362` calls `systemctl restart pi-web-ui`
directly. Replacing it with `scripts/restart-pi-web-ui.sh --reason "…" --no-lock`
(that script holds the production lock itself) would make the one repo-owned
restart path name itself. **I deliberately did not make this change** — that
workstream is active and owner-gated, and the edit is the parent's to sequence.

### Verification commands

```bash
# 1. the hook records and never fails the stop
sudo env INVOCATION_ID=verify MAINPID=1 /root/pi-web-ui/scripts/systemd-stop-audit.sh pre

# 2. the requester is named, without restarting anything
scripts/restart-pi-web-ui.sh --reason "verification" --dry-run

# 3. after the next real stop: both sides of the record
journalctl -u pi-web-ui.service --since "-1h" | grep -E 'STOP-AUDIT|RESTART-REQUESTED|event=stop_signal|event=shutdown_escape'
tail -5 /root/.pi-web-ui/stop-audit.log

# 4. regulatory check: no stop should ever again end without a stop_signal line
journalctl -u pi-web-ui.service --since "-7d" | grep -c 'State .stop-sigterm. timed out'   # expect 0 after install
```

### Timing ladder (keep consistent)

| Offset | Event |
|---|---|
| t+0s | SIGTERM; app records it synchronously |
| t+12s | escape worker force-exits (`PI_WEB_UI_SHUTDOWN_ESCAPE_MS`) |
| t+20s | `ShutdownCoordinator` hard-exit deadline (lowered from 25s) |
| t+30s | systemd `TimeoutStopUSec` → SIGKILL of the whole control group |

---

## 8. Changed-path inventory

**Modified (6)** — `docs/LIVE-VALIDATION.md` (+22), `docs/TROUBLESHOOTING.md`
(+19), `scripts/validation-server.ts` (+23), `server/src/index.ts` (+51/-7),
`server/src/shutdown-coordinator.ts` (+14/-7),
`server/tests/unit/live-validation/validation-server-lifecycle.test.ts` (+15).

**New (18)** — `deploy/systemd/pi-web-ui.service.d/10-stop-audit.conf`,
`docs/PRODUCTION-STOP-ROBUSTNESS.md`, `scripts/systemd-stop-audit.sh`,
`scripts/restart-pi-web-ui.sh`, `server/src/{shutdown-escape-policy,shutdown-escape-worker,shutdown-signal,sync-stderr,http-server-close}.ts`,
`server/src/live-validation/validation-cgroup-guard.ts`, and 8 test files.

**Deliberately NOT changed:** the repo unit file (`deploy/systemd/pi-web-ui.service`
— the audit lives in the drop-in); `scripts/command-code-weekly-refresh.ts` (active
workstream); `server/src/systemd-watchdog-worker.ts` (its stall reports have the
same async-pipe write pattern — flagged, not changed, to keep this diff reviewable
and because the watchdog pings rather than being a dying process's last word).

---

## 9. Verification run for the parent

- `npm run typecheck` → **exit 0** (all four workspaces).
- `npx eslint` on all changed/added TS → **0 errors** (3 pre-existing `no-non-null-assertion`
  warnings in `index.ts` untouched; the one warning in my own file was fixed).
- `npm test --workspace=server` → **378 files passed, 4398 tests passed, 7 failed**.
  All 7 failures are **pre-existing and environmental**, proved not mine:
  - `unit/config/pi-max-sessions.test.ts` (1) — fails with `PI_MAX_SESSIONS=20` in
    the shell env, **passes with it unset**. Nothing in my diff references it.
  - `unit/opencode/opencode-service-expanded.test.ts` (3) — `OPENCODE_ENABLED=false`
    in the environment; nothing in my diff references OpenCode.
  - `unit/live-validation/validation-server-lifecycle.test.ts` (3) — **my
    regression**, caused by the new cgroup guard refusing the launcher the test
    spawns. **Fixed**: the test opts in explicitly via
    `PI_WEB_UI_VALIDATION_ALLOW_PRODUCTION_CGROUP=1` with a comment explaining why
    the guard is not weakened for everyone. Re-run: **5/5 pass, 49s** (down from
    314s of timeouts).
- `npm run docs:check-agent-guides` → `AGENTS.md and CLAUDE.md are byte-identical`.
- `npm run docs:check-links` → `907 internal link(s) resolve across 163 Markdown files`.

**Behaviour change needing parent awareness:** that test now sets an override env
var for its spawned launcher. Without it, the suite only passes when the test
runner happens to sit *outside* the production cgroup — which is never true for a
session dispatched through orchestration on this host. The guard itself is
unchanged for real operator use.

## 10. Housekeeping

- No git mutations: no commit, branch, stash, checkout or reset. `git status` shows
  only the paths above.
- No `npm run build` (the production build). `npm run typecheck` did emit
  `shared/dist` as its own prerequisite (`npm run build --workspace=shared` inside
  the repo's `typecheck` script); it is gitignored and the only build artifact
  produced.
- All `systemd-run --scope` units `--collect`ed and verified gone; all harness
  processes killed (two orphans from my first mis-signalled run were found and
  cleaned); my scratch directory removed.
- Two leftover items **not mine, untouched**: `/tmp/pi-web-ui-validation/run-vw7Csq`
  (predates this session, 08:35:53) and a live validation server pair for
  `/tmp/child-voice-srv` belonging to the voice child agent (`/root/pi-web-ui-wt-voice`).

---

# Addendum — second defect of the same family (added on request)

**Scope:** bounded, as instructed — documented, plus one small fix squarely in the
run-lifecycle/watchdog area. Evidence: `evidence/09-wake-lost-receipt.json`,
`evidence/10-wake-lost-evidence.md`.

## Run `5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f` — reading verified in part, refuted in part

| Claim | Verdict |
|---|---|
| The wake was silently lost; the parent never saw it | **Verified** — the parent session's JSONL has no user message carrying the wake (gap `08:36:03.838` → `08:36:13.837`) |
| The *idle* watchdog (15 min) terminalised it | **Verified** — `reason: "idle"` at `08:51:10.383Z`, exactly 15 min after acceptance |
| It was a `follow_up` queued behind the parent's own long turn | **Refuted** — the receipt says `mode: "follow_up"` but **`dispatchMode: "prompt"`**. The wake resolver promotes to a plain prompt when it believes the target is idle (`if (!busy) dispatchMode = 'prompt'`); it only queues when it sees the session busy |
| The admission slot is held / quarantined | **Refuted for this event** — `/capacity` shows `quarantinedRuns: 0`; the runtime was never executing the run, so the drain released the lease on its first poll. `activeTurns` returning to 4 with 4 busy sessions is correct, not a leak |

**What actually happened** (new, from the same request's own logs): the request
rehydrated the target session from disk and found it **owned by another live
runtime** — `[auto-compact-75] Ownership: conflict (pid 2142860, tui) … This
runtime is fenced`. The dispatch went to a fenced instance, the run was marked
started 20 ms after acceptance, and nothing ever executed behind it.

## Answers to the four questions

1. **Which watchdog applies to a queued-but-never-started run?** The **idle** one.
   `reconcileStalledRuns` iterates `activeRuns`, which `addActive()` populates for
   every non-terminal receipt — `queued` included (`isTerminal` excludes it) —
   with `lastActivityAtMs = acceptedAtMs`. It therefore measures from **acceptance**,
   not from turn start, and a never-executing run can never advance the clock
   because only eligible activity events do.
2. **Is `idle` the right reason?** No. `idle` asserts a turn was executing and went
   quiet. Zero eligible activity events plus zero output evidence means nothing
   ever executed. That mislabel is what produced "workState: failed" and a
   quarantine notice for a run that never ran.
3. **Is the slot really released?** In this event, yes — and `quarantinedRuns: 0`
   proves it. The general code path is: `terminalize()` → `drainAndRelease` (lease
   held, runtime polled) → release on quiescence, or at the drain deadline
   `quarantine()` which does **not** release and holds the slot as capacity debt
   until restart/operator recovery. The operator notice's "(or a 30s drain
   quarantine)" wrongly implied the drain releases the slot.
4. **Right behaviour?** Not an exemption (a never-drained queued run would then hold
   a slot to the 6-hour ceiling) and not automatic replay (needs a staleness
   policy and a place to record "never delivered"). The minimum honest fix — the
   one implemented — is to **classify and report a lost wake as a lost wake**.

## Fixed (small, testable, in the watchdog/run-lifecycle area)

1. **`RunStallReason` gains `no_activity`** (`types.ts` + store allowlist).
   `reconcileStalledRuns` uses it when the idle window elapses and
   `neverProducedWork(active)`; `absolute` still wins on the ceiling and `idle` is
   unchanged for a turn that really was working. Log line updated accordingly.
2. **The operator notice is honest.** New pure, tested
   `server/src/internal-api/run-receipts/stall-notification.ts`: a never-executed
   run is titled **"Wake lost (never executed)"**, says the message never reached
   the session, gives the actionable step (re-dispatch), and drops the false
   "slot is held / 30s drain quarantine / no action required" claims. Quarantine
   wording is retained for genuinely executing turns, with the drain described as
   it behaves. A `server.ts` comment that claimed the slot "is already released by
   terminalisation" — contradicting both the notice and the code — is corrected.
3. **Live-validation scenario kept honest.** `stalled-run-reaped` asserted
   `reason === 'idle'`; it now asserts the reason **pairs with observed work**
   (`toolCalls > 0` ⇒ `idle`, else `no_activity`), so neither an honest
   classification nor a never-executed run can pass silently.
4. **Contract doc updated.** `docs/INTERNAL-API.md` documented the reason set as
   (`idle` or `absolute`); it now documents all three and requires consumers that
   switch on `reason` to handle `no_activity` — **this is a public-contract
   addition the parent should be aware of before release**.

Tests: `run-stall-classification.test.ts` (6 new), `stall-notification.test.ts`
(5 new); two existing tests that pinned the old `idle` label were updated rather
than deleted, and the scenario fixture gained the `outputEvidence` it should
always have had.

## Deliberately NOT changed (with reasoning)

- **Not exempting queued runs from the idle watchdog** — trades a lost wake for
  stranded capacity.
- **Not replaying the wake** — needs a staleness policy and a durable
  "never delivered" marker that does not exist yet.
- **`workState` stays `failed`** — the status honestly reflects that acceptance did
  not lead to completion; changing it would alter a public field for every
  consumer.

## Recommended follow-up (owner decision)

1. A receipt-level `delivery: { queued, delivered }` marker so a lost wake is
   machine-readable and replayable rather than only inferable.
2. Reclaim/replay a `no_activity` wake once the ownership conflict clears (the wake
   text survives in the watch record).
3. A **delivery deadline distinct from the idle window** for `queue_while_busy`:
   the parent's own turn on this occasion ran `08:35:04` → `08:52` (**17 minutes**,
   longer than the 15-minute idle window), so a *correctly* queued wake would also
   have been killed.
4. `stalledRuns: 6` within about an hour of the restart is worth a look — if
   several were never-executed runs, the lost-wake rate is a pattern.

## Verification (addendum)

- `npx tsc --noEmit -p server/tsconfig.json` → clean.
- `npx eslint` on all changed files → **0 errors** (2 pre-existing
  `no-non-null-assertion` warnings in files I touched, at lines I did not write).
- Targeted suites: `tests/unit/internal-api/` + `tests/unit/live-validation/` +
  `tests/integration/` → **1188 passed, 0 failed**.
- `npm test --workspace=server` → **4412 passed, 4 failed**, and all 4 are the same
  pre-existing environmental failures proved earlier in §9 (`PI_MAX_SESSIONS=20`
  set in the shell; `OPENCODE_ENABLED=false`). No new failures.
- `npm run typecheck`, `npm run docs:check-links` (907 links), `npm run
  docs:check-agent-guides` → all pass.
- No git mutations, no `npm run build`, nothing installed, no service touched.
