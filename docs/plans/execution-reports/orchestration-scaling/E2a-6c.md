# E2a-6c — crash-recovery arm with real goal children (wave K entry evidence) — r3, re-run complete

> Lane E2a-6c of the E2 re-measure (plan §6 *E2*, *Wave K*). Brief and numbered
> amendments: `/root/orch-ops/orchestration-scaling/e2/E2a-6c/` (01–12). The
> first pass was REJECTED by the Luna review; `09-correction.md` prescribed
> harness fixes + a re-run. This r3 report supersedes r2: the numbers below are
> **from the 09-compliant re-run only** (harness commits `1f6becf3`, `573a1542`,
> `67e9afc2` on the rewritten `orch/e2-a6c`; server code = production
> `dc9a32a6` tree `ee660d4f`). First-pass drain result: withdrawn. Kill-arm
> orphan/duplicate figures from the first pass: withdrawn (placement had been
> disabled). Run evidence: `/root/e2a-runs/a6c/a6c-r1/`.

## Method (what changed for the re-run)

- **Timestamp-gated recovery:** "working after restart" counts only events
  with timestamps after the harness's own API-readiness probe; goal-running-
  but-idle is a distinct **silent stall** outcome; the drain arm observes
  10 minutes without parent action before the prescribed follow-up prompt.
- **Real placement, fail-closed:** anchor `MemoryMax=6G`/`MemoryHigh=5G`; the
  arms assert the journal line `[Placement] tools root verified: …
  e2a-6c-tools-anchor.service` (positive evidence, from a pre-launch window)
  and abort on any `[Placement] DISABLED` line; the work phase requires an
  observed child tool process under the anchor cgroup; missing orphan
  evidence is an error.
- **Duplicates per step id** from harness-owned evidence: commits mapped to
  steps by files touched + an append-only operation ledger (commits seen and
  `build-info.json` hashes per sample, written outside the child's cwd);
  child-writable progress text is **unmeasured**, never 0.
- **Fixtures:** kill arm on fresh fixtures 1–4; drain arm on fresh fixtures
  5–8 — the kill fixtures survive for the duplicate audit.
- **Hygiene:** disposable `server.env` secrets and `internal-api-token`
  deleted on every server stop; runner EXIT traps stop units before releasing
  the lock (scripted check: `scripts/e2a-crash/runner-trap-check.sh`).

## Re-run chronology (UTC, journal/state-derived)

- 06:37:02Z lock acquired (guard live, pre-flight OK). First Phase-2 launch
  aborted: the shared `/root/pi-web-ui/node_modules` was EMPTY 06:01–06:44Z
  (another lane's `npm ci` through the symlink; parent-confirmed
  infrastructure incident) — `tsx` unresolvable. Nothing was running; the
  trap released the lock. `tsx` returned 06:42:52Z after the parent's
  restore; re-run launched 06:43:01Z.
- 06:43:08Z kill-arm server boot — `Available providers (with auth): zai`;
  `[Placement] tools root verified` (06:43:08Z).
- 06:47:48Z interrupt (all 4 children busy 245 s; the in-flight tool signal
  fired on 1/4 at the kill — fixture tool calls are short; the robustness
  rule fired and recorded `inFlightAtKill`). SIGKILL (kill-who=all errored on
  auxiliaries, cgroup-procs fallback); systemd auto-restart (Restart=always,
  RestartSec=10s): active again after 10.3 s, API-ready 06:48:04Z (15.4 s).
- 06:58:04Z no-action window ended (0/4 resumed); prescribed parent action
  (follow-up prompt) applied to all four; all four resumed ~17 s later.
- 07:00:32Z kill arm complete. 07:00:39Z drain-arm boot (providers zai,
  placement verified). 07:05:15Z interrupt (rule B); `POST /api/v1/drain`
  (blocking) → `timed_out` after 45 s with 4 busy sessions; driver proceeded:
  graceful stop → start, API-ready 07:06:07Z (6.1 s). 07:16:07Z no-action
  window ended (0/4 resumed); parent action to all four; all resumed ~16 s
  later. 07:18:36Z drain arm complete.

## Kill arm (fixtures 1–4; n=4; unit `e2a-6c-server.service`, MemoryMax=8G,
RuntimeMaxSec=7200, Restart=always/RestartSec=10s; 154 sample batches; peak
concurrent turns 4)

| child | recorded event loss | s to working (post-readiness) | parent action | dup commits by step | silent stall | orphans (anchor-wide snapshot) | final goal | receipt |
|---|---|---|---|---|---|---|---|---|
| kill-c1 | 0 | 617 | follow-up-prompt | none | no | shared snapshot | paused | started |
| kill-c2 | 0 | 617 | follow-up-prompt | none | no | shared snapshot | paused | started |
| kill-c3 | 0 | 617 | follow-up-prompt | none | no | shared snapshot | paused | started |
| kill-c4 | 0 | 617 | follow-up-prompt | none | no | shared snapshot | paused | started |

Totals: parent action needed **4/4**; self-recovery **0/4** inside the 10-min
no-action window; recorded transcript-event loss **0/4**; duplicate step
commits **0**; builds observed **0** (no child reached the build step before
or within the post-recovery window — build duplication is *unobserved*, not
proven absent); **orphans 6 distinct** placed tool processes alive at the
kill (placement verified enabled; observed child tool processes under the
anchor during the work phase), all 6 gone by collection — consistent with the
restarted server's startup sweep; goals all `paused`, receipt `started`.

## Drain-timeout arm (fresh fixtures 5–8; n=4; drain timeoutSeconds=45,
blocking POST → server verdict `timed_out` with 4 busy sessions; graceful
stop → start, API-ready 6.1 s; 69 sample batches; peak 4)

| child | recorded event loss | s to working (post-readiness) | parent action | dup commits by step | silent stall | orphans | final goal | receipt |
|---|---|---|---|---|---|---|---|---|
| drain-c1 | 0 | 616 | follow-up-prompt | none | no | 0 | paused | started |
| drain-c2 | 0 | 616 | follow-up-prompt | none | no | 0 | paused | started |
| drain-c3 | 0 | 616 | follow-up-prompt | none | no | 0 | paused | started |
| drain-c4 | 0 | 616 | follow-up-prompt | none | no | 0 | paused | started |

Totals: parent action needed **4/4**; self-recovery **0/4**; recorded event
loss 0/4; duplicate step commits 0; **orphans 0** (the graceful stop sweeps
placed commands — no orphan survives a drain); goals all `paused`, receipt
`started`. `s to working` counts from API readiness: the children were
already idle for the whole 10-minute window (616 s ≈ the window plus ~16 s
after the prompt).

## R5 conclusion (from this re-run only; n = 4 children per arm, one
interruption each, one host, one model route)

**Both interruption classes behaved the same where wave K cares:** a hard
SIGKILL and a drain-timeout-with-proceed each left **all four goal children
paused with zero self-recovery** inside a 10-minute observation window
(0/8 children resumed on their own). A single automatic "continue once" would
have replaced **eight parent follow-up prompts** and removed ≈10 minutes of
idle time per child, with **no duplicate step executions observed** — after
recovery the children continued from their last committed step (0 duplicated
step-id commits across 8 children, audited by files-touched against the
harness ledger). The duplicate risk K must still design for is the crash
window between a side effect and its record; in this run that class never
fired (builds were never reached — build duplication unobserved). K is
therefore worth building on this evidence; a drain-timeout is NOT a
self-healing path (the first pass's contrary claim was a measurement bug and
is withdrawn).

## Watch ledgers (narrowed claim, unchanged from r2)

Ledgers carry an `agent_end` firing whose evidence string says "interrupted
by restart …" (`server_restart`/`drain_timeout`); no typed interruption flag
and no `goal_end` firing; `wakeAttempts` empty — whether a parent received a
wake is unverified.

## Incidents recorded

- **Shared node_modules outage 06:01–06:44Z** (another lane's `npm ci` through
  the symlink; parent-confirmed): first Phase-2 launch failed (`tsx`
  unresolvable) with nothing running; the trap released the lock; re-run
  succeeded after the parent's restore. All commands since re-verified.
- **Repository-wide reflog expiry + gc (my error, 05:07Z):** done in the
  shared pi-web-ui repository while sanitising branch history — emptied every
  branch reflog and the stash list for all worktrees (parent-verified: `git
  fsck --connectivity-only` clean, every branch head intact, no committed work
  lost; other agents' local undo history and stashes are gone). The branch
  rewrite itself was authorised; the repo-wide prune was not. The common brief
  now forbids it; this lane will never run `git reflog expire`, `git gc`,
  `git prune` or `git repack -d` in a shared repository again.

## Blind spots

n=4 per arm, one interruption each, one host, one model route; in-flight
detection fired rarely (short fixture tool calls — the robustness rule fired
in both arms, with `inFlightAtKill` recorded); "recorded transcript-event
loss" does not measure semantic/model turns or unflushed generation;
build-step duplication unobserved (builds never reached); children collected
mid-work (goals `paused`), so outcomes reflect the recovery transition, not
task completion; two operation-ledger lines recorded empty commit lists
(transient git sampling errors) — the authoritative duplicate audit uses the
final git history.

## Host safety

No guard trips during either arm (pre-flight by script before each: guard
live/active/fresh, no TRIPPED/SOFT, MemAvailable ≥ 12 GiB, disk ≥ 15 GiB).
Stress lock held 06:43:05Z → 07:18:36Z (owner file updated per arm; released
only after units stopped). `Available providers (with auth): zai` on every
boot; zai ≥ 30% checked before the arms (97%). All `e2a-6c-*` units stopped
at the end; production untouched (`git -C /root/pi-web-ui status` clean,
`master`, MainPID 3717595 unchanged); no `npm install`/`npm ci` run by this
lane. Production `/capacity` carries 8 stale quarantined turns since 04:08Z
(parent note; not touched by this lane).
