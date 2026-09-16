# Child S — production stop robustness: the 2026-09-15 08:30 restart that killed orchestration

**You are a dispatched child worker.** You own one bounded outcome. You do not
commit, push, build for production, install systemd units, or restart anything —
the parent does all of that after reviewing your work.

- Your session id: `01a0a43c-d9cc-74e4-896e-6a5bd3e8986b`
- Your tree (worktree, yours alone): `/root/pi-web-ui-wt-stability`
- Handback: `/root/pi-web-ui/operations/change-requests-20260915/child-stability/complete.md`
  (create the directory; logs/evidence beside it)

## The incident (evidence — do not re-derive, verify what you rely on)

- **08:29:56 UTC**: something asked systemd to stop `pi-web-ui.service`. The unit
  did not exit within `TimeoutStopUSec=30s`.
- **08:30:26**: systemd SIGKILLed the entire control group (`KillMode=control-group`):
  the main process, `npm run validate:server`, `npm exec tsx`, three `esbuild`
  processes, and **four dispatched orchestration children** (pi sessions) that were
  mid-turn — all lost.
- **08:30:50**: the unit restarted (`Restart=always`); `NRestarts=1`.
- **The graceful-shutdown instrument added on 2026-09-14 logged nothing.**
  `server/src/index.ts` builds a `ShutdownCoordinator` that logs `Shutting down...`,
  a duration per step, and `Shutdown complete`. None of those lines exist for the
  event — so either the handler never ran or the process never got SIGTERM.
- **No journal trace of the stop initiator**: no `Stopping Pi Web UI...` line, no
  `Watchdog timeout`, no sudo record. `WatchdogUSec=45`, `Restart=always`.
- Context: a model-catalogue workstream is active on this host;
  `scripts/command-code-weekly-refresh.ts` contains an **idle-aware restart**
  (`systemctl restart pi-web-ui` after polling `activeTurns === 0`, 30-minute
  window, 30-second poll). The owner has now owner-gated restarts for that
  workstream — assume it can still ask for a restart at any moment.
- Verified today: `/capacity.activeTurns` correctly reported `4` while four
  sessions were busy, so the idle *check* is not obviously broken.

Operator's standing requirement, verbatim in substance: *"it is important the
production is very stable and robust, we need to be able to use it for lots of
orchestration — so a very robust structure to it is needed."*

## Required outcomes

**A. Make the next stop self-describing (highest value).** Today the initiator is
unknowable. Add the missing audit trail, committed under the repo's existing
systemd sources (`deploy/systemd/` owns the unit):

- a drop-in (`ExecStopPre=`/`ExecStopPost=`) logging `SERVICE_RESULT`,
  `EXIT_CODE`, `EXIT_STATUS`, `INVOCATION_ID`, `MAINPID`, and the timestamp;
- a way to name the *requester* where the platform allows it (consider an
  `auditd` execve rule for `/usr/bin/systemctl`/`/bin/systemctl`, or the best
  available alternative — state honestly what can and cannot be named);
- an **immediate, synchronous** log of the received signal in the app, written
  before any `await` (`process.stderr.write`), so a blocked event loop still
  records it. Arm a hard-exit deadline synchronously in the same handler.

**B. Make shutdown robust to a starved/blocked event loop.** The handler currently
lives on the loop it must survive. Extend the existing worker-thread pattern
(`server/src/systemd-watchdog-worker.ts`, `server/src/systemd-notifier.ts`) so a
worker can force a fast, *recorded* exit when the main thread fails to acknowledge
shutdown within a few seconds. Target: never reach `TimeoutStopSec`, never lose
the reason, never require SIGKILL. Keep the force-exit path synchronous and
minimal.

**C. Root-cause write-up for 08:30.** As far as the evidence allows, in writing:
what is *proved*, what is *inferred*, what the new instruments will name next
time. Audit every restart path reachable on this host from this repo
(`scripts/command-code-weekly-refresh.ts`, `scripts/with-production-lock.sh`, any
docs that instruct a restart) and state which of them can restart while turns are
active — including whether the idle check can be raced (poll between turns).

**D. Cgroup hygiene (small, structural).** A disposable validation server inside
the production cgroup is a documented trap and this incident killed one. Make it
hard to repeat: `scripts/validation-server.ts` should detect it is inside
`system.slice/pi-web-ui.service` and refuse with a clear message plus an explicit
override flag, and/or print the `systemd-run --scope` recipe. Prefer the guard.

**E. Tests (TDD, RED first).** Extend the existing notifier/watchdog/policy tests
for every behaviour change. If you add a guard to the validation script, cover it.

**F. Deployment stays with the parent.** Hand back: the diff, the exact install
steps (drop-in path, unit change, restart sequence) and the verification commands.
Do **not** install, restart, or touch `/etc` — your brief covers the repo and your
worktree only.

## Constraints

- Your worktree only. No git mutations. No `npm run build`. No service changes.
- If you need a long-running process for testing, run it via
  `systemd-run --scope --collect --unit=<unique> …` and clean it up.
- Reading the journal is encouraged; changing the host is not.

## Handback

RED/GREEN evidence per behaviour, the exact log format the instruments emit, the
incident write-up (proved vs inferred), changed-path inventory, and the install
steps with their verification. No unevidenced claims; "not established" is a
legitimate answer where the evidence stops.
