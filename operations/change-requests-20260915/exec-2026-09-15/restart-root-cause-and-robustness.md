# The production restart of 2026-09-15 14:27:05Z: established root cause, and what is now prevented

Session `01a0a6a0` (second successor of `01a0a455`). Written 2026-09-15 ~20:20Z.
Read with `docs/PRODUCTION-STOP-ROBUSTNESS.md` (the canonical doc, corrected this
session) and `operations/change-requests-20260915/ROOT-CAUSE-STARTING-POINTS.md`
(the entry points written before the merge).

---

## 1. Root cause — established, and independently re-verified here

The other agent's finding (commit `d921ac7`) is confirmed, and I verified the
mechanism from the artefacts rather than from the narrative:

> At 14:27:03Z the coordination child in `/root/pi-web-ui-wt-coordination` ran a
> red-proof command that renamed `restart-production.sh` aside and `git stash`-ed
> `scripts/restart-pi-web-ui.sh` back to its pre-guard revision, then ran
> `server/tests/unit/restart-drainage.test.ts`. Two seconds later the service
> received SIGTERM.

My own checks:

| Claim | How it was checked | Result |
|---|---|---|
| The reverted revision calls a bare `systemctl` with no env seam | `git show 1c05f6f^:scripts/restart-pi-web-ui.sh` | **0 occurrences** of `PI_WEB_UI_RESTART_SYSTEMCTL`; `systemctl restart pi-web-ui` at the direct and lock-path call sites |
| That revision accepted the suite's arguments | same revision, argument loop | `--no-lock` supported ✓ — so the suite's invocation was accepted, not rejected |
| That revision had no capacity pre-flight | same revision | no capacity/`activeTurns` code at all |
| Why production's audit file has no requester record | same revision honours `PI_WEB_UI_STOP_AUDIT_FILE`, which the suite redirected to its own temp file | record written, but **not** into production's file — exactly the observed gap |
| The service really stopped then | `journalctl -u pi-web-ui.service` 14:24–14:30 | `Stopping pi-web-ui.service` at 14:27:05Z, clean exit, started again 14:27:21Z |
| No crash-loop / OOM explains it | systemd unit state | `NRestarts=0`, clean SIGTERM handling |

**So: not bad luck.** It had a mechanism, and the mechanism had three structural
enablers:

1. **The interception lived inside the code under test.** The suite's only
   protection was `PI_WEB_UI_RESTART_SYSTEMCTL`, an env seam *the script* honours.
   The red-proof deliberately reverted the script, which removed the guard **and**
   the interception in one step. A red-proof that disarms the safety net is not a
   red-proof; it is an uncontrolled experiment on production.
2. **The production unit name was reachable from any working tree.** The test
   exercised `scripts/restart-pi-web-ui.sh` from a worktree whose content had been
   temporarily rewritten.
3. **The suite ran inside the unit's own control group.** The SIGTERM that
   restarted the service killed the session running the test
   (`01a0a52f`'s transcript ends at 14:27:03Z), which is why the event looked
   like an external actor for hours.

## 2. A second, previously unrecorded stop — found by the new detector

Running the new checker over today's journal found **two** unclaimed stops, not
one:

```
2026-09-15T14:27:05.000Z  unclaimed-request  (nearest requester record 5669s away)
2026-09-15T15:35:23.000Z  unclaimed-request  (nearest requester record 1571s away)
```

The 15:35:23Z one is not the test incident. The journal shows
`[NotificationManager] explicit notification queued: … "Production restart
initiated"` at exactly 15:35:23Z — that message is
`scripts/restart-production.sh`'s own notify call. So production was restarted by
the repository's **canonical, recommended** path, and that path wrote **no
requester record at all** (it only announced itself through the notification
hook). In the forensic record it was indistinguishable from an unexplained stop.

That is now fixed: both restart paths write the record through one shared
implementation, `scripts/record-restart-requester.sh`.

## 3. What is now in place (all shipped in this session's commits)

| Layer | What it does | Why it cannot be reverted with the implementation |
|---|---|---|
| `server/tests/systemctl-guard.ts`, installed by `server/tests/setup-env.ts` | Prepends a `systemctl` shim to `PATH` for **every** Vitest process. State-changing verbs are refused with a non-zero exit and logged; read-only verbs pass through to the real binary. | It is test-environment code, not code under test. A `git stash` of a script cannot remove it. It also generalises `d921ac7`, which covered **one** suite. |
| `tests/setup-env.ts` audit redirection | Points `PI_WEB_UI_STOP_AUDIT_FILE` at a per-process temp file unless a suite sets it. | Same: environment-owned. A test run can no longer append a false requester line to production's record. |
| `scripts/record-restart-requester.sh` | One recorder for the requester record (journal + durable file), used by both restart paths. | Removes the "which path records?" gap that hid the 15:35:23Z restart. |
| `scripts/check-unexplained-stops.ts` | Cross-checks systemd's stop events against the requester records; reports every unclaimed stop with journal context and a heuristic split between systemd's own restart policy and an unclaimed request. | Independent lane: it does not trust the record it is checking. |

### Evidence that the guard meets the incident's own shape

Zero-risk reproduction (the historical revision, copied to a temp dir, with the
unit name changed to one that cannot exist so this proof could never restart
anything real):

```
$ PATH=<guard dir>:/usr/bin:/bin bash <historical revision> --reason "guard proof — incident shape" --no-lock
RESTART-REQUESTED ts=2026-09-15T20:15:05Z uid=0 user=root pid=3203431 … cwd=/root/pi-web-ui
systemctl guard: refusing mutating verb "restart" during a test run.
$ systemctl show pi-web-ui.service -p NRestarts -p ActiveEnterTimestamp
NRestarts=0
ActiveEnterTimestamp=Tue 2026-09-15 16:37:59 UTC     # unchanged before and after
```

The guard log records the attempt with pid/ppid/tty/cwd/argv — the attributability
the incident lacked:

```
ts=2026-09-15T20:15:05Z pid=3203476 ppid=3203431 tty=not a tty cwd=/root/pi-web-ui argv=restart pi-web-ui-guard-probe.service
refused restart pi-web-ui-guard-probe.service
```

A live positive control fell out of the work by accident: a first version of my
own test for the restart paths sealed the sink it asserted on but not the others,
skipped the pre-flight (a plain file is not a unix socket), and attempted a real
`systemctl restart pi-web-ui.service` from a Vitest process. The guard refused it
(logged, cwd `/root/pi-web-ui/server`). No notification was delivered and
production was untouched. The lesson is recorded in that test's own header: seal
**every** sink a restart path can reach, not the one you are asserting on.

## 4. What is honestly not prevented

- A human or agent with root and a checkout can still run
  `systemctl restart pi-web-ui` directly. No repository script can stop that; the
  record can only report who did not claim it.
- A test **outside** Vitest (a bare `node`, a shell script, a CI runner) is not
  covered by the PATH guard. A bare shell in the same directory would still reach
  the real binary.
- The `--force` and `--no-lock` escape hatches remain: they are deliberate, and
  each is named in the record.

### Options considered and not taken (trade-offs, stated)

| Option | Why it is not free |
|---|---|
| Require an owner-issued approval token for a non-dry-run restart | Would break the weekly Command Code catalogue refresh's unattended, committed-then-restart path unless that automation also mints tokens — real friction on a working workflow for a hazard the PATH guard already covers. |
| Make `--no-lock` verify lock ownership | Narrower and defensible, but it lives in the code under test, so the exact scenario that caused 14:27 (a reverted revision) would not have been prevented by it. Worth doing for hygiene, not for this hazard. |
| `RefuseManualStop=yes` on the unit | Would refuse **all** manual restarts, including the repository's own audited path. |
| Run tests in a systemd scope without access to `/run/systemd/private` | Genuinely strongest structurally (mechanism-independent, absolute paths included), but changes how every suite runs and needs a survey of suites that use systemd (`systemd-run` appears in the validation-server cgroup guard paths). Worth scoping as a follow-up rather than smuggling in now. |
| Containment: workers in their own scope/slice (separate unit from the daemon) | This is the real fix for the whole class, and it is already the recorded, unstarted roadmap in `docs/PROCESS-ISOLATION-DESIGN.md` ("Out-of-process worker migration"). It is a programme, not a patch, and the operator paused the surrounding plan. |

**Bottom line:** the 14:27 event was preventable, and the cheapest half of that
prevention is now in place and tested. The residual risk is not a script bug; it
is that this host lets anything running as root, in the same cgroup, reach the
production service manager. Closing that is the isolation roadmap, not another
guard.

## 5. Also true after this session (things that stopped being true)

- `docs/PRODUCTION-STOP-ROBUSTNESS.md` said "a restart that does not appear there
  is, by elimination, not one of ours" — **falsified twice on 2026-09-15**
  (redirected record at 14:27:05Z, never-written record at 15:35:23Z). Corrected
  in place, with both counter-examples.
- The same doc's "Note on Stage J" (in the plan) attributed the always-red
  Agent OS Stage J to environmental limits. The decisive cause was the harness's
  own missing timeout; Stage J now passes 1/1 (agent-os `14deb69`).
- `agent-os` full suite is 2114/2115. The one failure,
  `tests/review-report.test.ts` "action verbs keep the sitting courtesy", is
  **pre-existing on HEAD** and caused by `0dfe915` ("retire review-sitting pause
  on primary session-end capture prompt delivery"), which retired the behaviour
  that assertion pins without updating it. Not touched by this work; it belongs to
  whoever owns that change.
