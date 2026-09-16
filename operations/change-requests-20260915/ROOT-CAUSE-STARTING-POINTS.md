# ROOT CAUSE — the 14:27:05Z production restart: **SOLVED** (2026-09-15)

**Answer in one line:** the restart was caused by the *coordination agent's own new test suite*, run in a
deliberate red-proof experiment in which the guard and the test's restart interception were removed together —
so the test executed a real `systemctl restart pi-web-ui`. It killed the very session that ran it.

---

## 1. The mechanism, in order

1. The coordination agent (session `01a0a52f`, worktree `/root/pi-web-ui-wt-coordination`) had written
   `server/tests/unit/restart-drainage.test.ts` to prove the new capacity pre-flight works.
2. To prove the tests were *red* without the implementation ("red→green proof", its words at 14:26:38), it ran a
   command at **14:27:03** that:
   - **renamed `scripts/restart-production.sh` away** (`mv scripts/restart-production.sh /tmp/rp.bak` — the file is
     *still on disk* with mtime 14:07), and
   - **`git stash push -- scripts/restart-pi-web-ui.sh`** — reverting the wrapper to the version that had **no
     capacity pre-flight** and, crucially, called **bare `systemctl`**.
3. Its own test invokes the wrapper **without `--dry-run`** (`['--reason','drainage test','--no-lock']`) and relies
   on the env seam **`PI_WEB_UI_RESTART_SYSTEMCTL`** to point `systemctl` at a recording stub.
4. **That seam is honoured by the script under test — which had just been stashed away.** The reverted wrapper has
   no such indirection (`git show 1c05f6f^:scripts/restart-pi-web-ui.sh` → line 119:
   `exec "$script_dir/with-production-lock.sh" systemctl restart pi-web-ui`). The env var was ignored.
5. The test case *"proceeds to restart when active turns are zero"* therefore ran a **real**
   `systemctl restart pi-web-ui` → **SIGTERM at 14:27:05.049Z**, ~2 seconds after the command.

The guard that should have stopped it was the same commit being tested: it was **uncommitted** in the worktree
(committed later as `1c05f6f`, at 14:39:30 — twelve minutes *after* the restart).

## 2. The evidence, and how it explains every earlier anomaly

| Observation | Explanation |
|---|---|
| Session transcript ends **14:27:03.299Z**, mid-command, tool result never recorded | The actor was a Pi Web UI session inside the service cgroup. The restart SIGKILLed it. **It killed itself.** |
| **No `RESTART-REQUESTED`** in production's `stop-audit.log` — the fact that "ruled out the wrapper" | The wrapper *did* run, but its audit output went to **the test's own temp file**: the suite sets `PI_WEB_UI_STOP_AUDIT_FILE` to `<tmp>/stop-audit.log` (seen live in the session: `/tmp/pi-web-ui-restart-ysGROk/stop-audit.log`). Temp dirs are removed at teardown, so the record is gone. The inference "not the wrapper" was right about *that wrapper on that path*, and wrong about the actor. |
| Clean SIGTERM + 2029 ms graceful teardown + `exit_status=0` | An ordinary systemd stop job from a real restart — not SIGKILL, not OOM, not a timeout escalation. |
| `NRestarts=0` | Manual restart, never a crash loop. |
| Their guard commit timestamp is 12 min *after* | It was uncommitted when the accident happened. |
| My workstream was clean | Every restart call from my worktrees was `--dry-run`; the wrapper exits before the real `systemctl` on that path. **Unrelated, and correctly exonerated.** |

Also confirmed: `/tmp/rp.bak` (3444 bytes, 14:07) — the renamed guard script, untouched since.

## 3. The class of bug — this is the part worth keeping

**A test's safety net may not live in the code under test.**

The suite's *only* interception was an env var the implementation chooses to honour. Reverting the implementation
for a red-proof run removed the guard **and** the interception in one step, converting a unit test into a live
production restart. Three properties made it worse:

- the test runs the real scripts **without `--dry-run`** by design;
- the audit seam redirects evidence out of the production log, so a real restart from a test is **forensically
  silent** — which is why this took hours to attribute;
- the run was deliberate and *correct in intent*: proving a guard catches something requires removing it. The
  mistake was removing it from the tree that production executes, with no independent net underneath.

**Fixed** (`d921ac7`, RED-first): `restart-drainage.test.ts` now installs a `systemctl` stub **at the front of
PATH**, sharing the env-stub's call log, so interception is supplied by the test environment and cannot be
reverted with the implementation. A new test pins it using a deliberately **read-only** subcommand, so the suite
cannot stop the service even while that test is red. Positive control: a bare `systemctl restart pi-web-ui` line
is now captured by the stub with production untouched.

**Rules that follow (worth adopting host-wide):**
1. A red-proof must never run against the tree production executes. Copy the script to a temp dir and run *that*.
2. Never let a test's ability to reach a real destructive command depend on the code under test — use PATH shims.
3. Any test that can reach a restart must still leave a trace in the *production* audit path, not only a temp file.

## 4. Instrumentation gap (unchanged, still an OWNER decision)

The requester of a *bare* `systemctl restart` cannot be named on this host: no `auditd`, and root `systemctl` uses
`/run/systemd/private`, so bus monitoring is structurally blind. This incident was attributed by transcript and
file forensics, not by systemd. To make the next one nameable, one of these is needed — all host-wide, so they need
your agreement, not a unilateral change:
1. `auditd` with an execve rule on `/usr/bin/systemctl`, or
2. `LogLevel=debug` in `/etc/systemd/system.conf` + `systemctl daemon-reexec`, or
3. insist every restart path goes through an audited wrapper that records requester + reason (the wrapper already
   does this — the gap is paths that bypass it, and the audit-redirect seam above).

## 5. Still open after this

- **`activeTurns` is not a safe idle signal** (proven: `/capacity` read `0` while a session was provably mid-turn
  ~59 min). Both new restart guards key on it. My catalogue path counts **busy sessions** instead; the guards
  should too, or the class of "restart kills live children" stays open even with a working guard.
- **The claude direct backend 500 in Stage J** (persisting; see the Agent OS known-issues work).
