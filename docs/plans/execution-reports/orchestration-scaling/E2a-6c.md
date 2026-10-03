# E2a-6c — crash-recovery arm with real goal children (wave K entry evidence) — r4, after the 13-final-correction

> Lane E2a-6c of the E2 re-measure. Review history: r1 REJECT → 09-correction →
> re-run → r2 REJECT (Luna r2) → **13-final-correction (this report)**. The
> confirmed core, independently recomputed by the reviewer and the parent, and
> re-confirmed here by re-analysing the existing raw evidence with the fixed
> code (`state/reanalysis-13.json`, script `/root/e2a-runs/a6c/reanalysis-13.mjs`):
> **in all 8 children there were 0 recorded child entries and 0 tool calls
> between API readiness and the parent action, and every no-action sample was
> `goalState=running, busy=false`.** No new arm was run by this lane (13 says a
> reviewer runs the kill arm live afterwards with the corrected harness).
> Harness: `scripts/e2a-crash/` on the rewritten `orch/e2-a6c`; run evidence in
> `/root/e2a-runs/a6c/a6c-r1/`.

## The corrected core result (re-run, n = 4 children per arm)

After BOTH interruption classes — a hard SIGKILL with systemd auto-restart
(kill arm) and a drain that times out and proceeds (drain arm) — **the goals
did not resume on their own.** Each child's goal stayed **`running` while the
session sat idle** for the whole 10-minute no-action window (38/38 no-action
samples per child: `running`, not busy), with **0 child entries and 0 tool
calls** after API readiness. That is a **silent stall**: the goal projection
says "running", nothing tells the parent, and no turn continues. Recovery
happened only after a prescribed parent follow-up prompt, for 8/8 children.

Per child, re-analysis with the fixed code:

| child | silentStall (window end) | window goal / busy samples | child entries in no-action window | prompt → turn start (assistant `message.timestamp`) | prompt → first assistant record persisted | prompt → first completed tool result |
|---|---|---|---|---|---|---|
| kill-c1 | **true** | running / 0 busy | 0 | 0.270 s | 77.925 s | 78.074 s |
| kill-c2 | **true** | running / 0 busy | 0 | 0.018 s | 9.347 s | 9.471 s |
| kill-c3 | **true** | running / 0 busy | 0 | 0.021 s | 13.278 s | 13.404 s |
| kill-c4 | **true** | running / 0 busy | 0 | 0.021 s | 6.831 s | 6.963 s |
| drain-c1 | **true** | running / 0 busy | 0 | 0.243 s | 24.795 s | 24.936 s |
| drain-c2 | **true** | running / 0 busy | 0 | 0.020 s | 26.438 s | 26.550 s |
| drain-c3 | **true** | running / 0 busy | 0 | 0.023 s | 24.885 s | 25.014 s |
| drain-c4 | **true** | running / 0 busy | 0 | 0.025 s | 27.000 s | 27.135 s |

Delay definitions (parent verification, 2026-10-03 09:30 UTC, corrected from
the 14-complete wording): all three are measured from the queued prompt's USER
message timestamp. **Turn start** (0.02–0.27 s) is the assistant message's
internal `message.timestamp`, set when the turn's provider request is created.
It shows the turn began at once on the prompt, **not** that the model had
produced output. **First assistant record persisted** (kill 6.8–77.9 s, drain
24.8–27.0 s) is the record timestamp of the first assistant output written to
the session file. **First completed tool result** reproduces the reviewer's
figures (kill 78.65/9.434/13.371/6.925 s; drain 25.433/26.612/25.049/27.163 s)
within ≤ 0.6 s; the difference is the reference instant (queued record vs
send-side). All three show the same thing: no work before the prompt, work
only after it. Source: `e2/E2a-6c/15-parent-verification-delays.txt` (parent
recomputation from the raw final-session files).

Earlier r3 wording ("4/4 goals paused", "~17 s prompt-to-work") was a
measurement artefact: the old code accepted the prompt's own user record as
"working" and fell back to polling time. Fixed (item 1) and re-measured.

## Sample counts per attempt (13 item 3)

Current re-run, per arm (filtered by each arm's `startedAt`): **23
work-phase batches** (`sample` events before the interruption), **38
no-action observation batches** (`observe-no-action`), **9 post-action
observation batches** (`observe-parent-action`). Prior attempts' batches —
kill 131, drain 46 (23 + 23 from the failed and successful first-pass
attempts) — are **withdrawn data** and are excluded from every number above.

## Phase-1 chronology (13 item 4; disclosed here, not only in hand-back notes)

- 03:41:20Z — failed drain attempt's server boot (journal).
- ~03:46:05–03:46:50Z — drain started and reached `timed_out` server-side;
  the harness client destroyed its request at 30 s.
- **03:46:35Z — the harness released the stress lock while its server was
  still running: the unprotected interval, ending 03:48:22Z when the server
  was stopped** (disclosed as a process defect; the runners now stop units
  before releasing the lock, with a scripted check).
- 03:49:26Z — retry server boot (journal; first reported as 03:47:52Z).
- 04:07:24Z — first-pass drain arm completed; its result is **withdrawn**
  (misdetected recovery).

## Builds and duplicates, honestly (13 item 5)

- **Builds observed: 1, duplicated: 0.** Exactly one successful build across
  all 8 children: drain-c4 ran `npm run build` and
  `fixtures/fixture-8/repo/dist/build-info.json` is timestamped
  2026-10-03T07:18:28.522Z (23 files). The kill children were interrupted
  before their build step (no `dist/build-info.json` in fixtures 1–4). The
  r3 claim "builds never reached" was false for drain-c4 and is corrected.
- The harness operation ledger now samples in ALL THREE phases (work,
  post-restart, post-prompt — 13 item 5; the ledger previously sampled only
  before the interruption and therefore missed the one observed build). Even
  so, the ledger recorded 0 build hashes (the build landed 8 s before the arm
  ended, after the last sample) — **"not sampled", not "no build"**.
- **The ledger and the fixture git history are writable by the child's UID**
  (state dir 0755, ledger 0644, root-owned; no separate child identity), so
  "no duplicate step observed (n = 8 children, 11 function-step commits, no
  repeated step id within any fixture)" is an **observation, not
  tamper-resistant evidence**. A separate child identity or a controller-only
  append sink is future work for wave K.

## R5 conclusion (rewritten; re-run data only)

After both tested interruption classes, goals stayed **`running` but idle — a
silent stall — not paused, and not self-resuming**, until a parent prompt
(8/8 children; 0 qualifying child events between readiness and the prompt).
Wave K's "continue once" therefore addresses a **continuation gap AND a
monitoring gap**: nothing in the current surface tells the parent that a
`running` goal is stalled idle. One automatic continuation per transient stop
would have replaced 8 parent follow-ups and ≈10 minutes of idle time per
child. No duplicate step executions were observed (n = 8, 11 function-step
commits, 1 build, not duplicated) — as an observation, not tamper-resistant
evidence. A reviewer live kill-arm re-run with the corrected harness is still
required before R5 signs off (13: "A reviewer runs the kill arm live
afterwards").

## Watch ledgers (narrowed claim)

Ledgers carry an `agent_end` firing whose evidence string says "interrupted
by restart …" (`server_restart`/`drain_timeout`); no typed interruption flag,
no `goal_end` firing, `wakeAttempts` empty — whether a parent received a wake
is unverified. The silent-stall finding strengthens this: during the stall
the goal reads `running`, so even a correct wake would have said "running",
not "stalled".

## Phase-2 chronology (current re-run; UTC)

- 06:37:02Z lock acquired; first launch aborted by the shared
  `/root/pi-web-ui/node_modules` outage (06:01–06:44Z, parent-confirmed
  infrastructure incident; `tsx` unresolvable; nothing was running; trap
  released the lock). 06:42:52Z `tsx` restored by the parent's `npm ci`.
- 06:43:01Z re-run launched. 06:43:08Z kill-arm boot (providers zai;
  placement `tools root verified`). 06:47:48Z interrupt; 06:48:04Z API-ready.
  07:00:32Z kill arm complete.
- 07:00:39Z drain-arm boot (providers zai; placement verified). 07:05:15Z
  interrupt; drain verdict `timed_out` (45 s, 4 busy sessions); 07:06:07Z
  API-ready. 07:18:28.522Z drain-c4's build (the one observed build).
  07:18:36Z drain arm complete; units stopped; lock released after units
  stopped.

## Incidents (carried forward)

1. Shared `node_modules` outage 06:01–06:44Z (another lane's `npm ci` through
   the symlink; parent-restored). First Phase-2 launch failed with nothing
   running; re-ran after the restore.
2. Repository-wide reflog expiry + gc run by this lane at 05:07Z in the shared
   pi-web-ui repository (11-parent-note): all worktrees' branch reflogs and
   the stash list were lost; parent-verified no committed work lost. The
   branch rewrite alone was authorised; the repo-wide prune was not. Never
   again in a shared repository.

## Blind spots

n = 4 per arm, one interruption each, one host, one route. In-flight tool
detection fired rarely (short fixture tool calls; the robustness rule fired
in both arms with `inFlightAtKill` recorded). "Recorded transcript-event
loss" does not measure semantic/model turns or unflushed generation.
Duplicates: progress-text and uncommitted-write effects unmeasured; ledger
not tamper-resistant (above). The reviewer's live kill-arm re-run is still
pending. Two operation-ledger lines in the first Phase-2 attempt recorded
empty commit lists (transient sampling errors).

## Review record and parent acceptance (2026-10-03 11:30 UTC)

| Round | Verdict | Outcome |
|---|---|---|
| Luna r1 | REJECT | The drain-arm "self-recovery" was false, and placement was off. Correction 09 re-ran both arms. |
| Luna r2 | REJECT | The measurement and wording majors were addressed by the parent's FINAL correction 13 (`bc1980bc`, `3f727122`). The parent then fixed the delay labels in `3144310b`: the 0.02–0.27 s figure is turn start, not output. |
| Luna r3 (closure plus a live kill arm) | REJECT on completeness only | Every r2 measurement major is CLOSED except build/duplicate scope, which is PARTLY CLOSED: the ledger is not tamper-resistant, as the report states. The reviewer's **independent live kill arm** (run `a6c-rv`, 4 GLM children, hard kill at 10:17:01Z, restart in 10.3 s) recorded the full 10-minute no-action window. In it, **4/4 goals stayed `running` with the session idle: 0 of 38 samples busy, 0 child entries and 0 tool calls.** Then the reviewer's foreground command was aborted, so the parent-prompt phase was never recorded. |

**Parent acceptance (owner-approved scope trim, 10:02 UTC: no new correction cycle).**
- **The silent stall after a hard kill is confirmed twice:**
  - by the lane's run (8/8 across the kill and drain arms, recomputed from raw by the reviewer and the parent);
  - independently, live, by the reviewer (4/4, reconstructed from the last no-action samples, because no boundary snapshot was persisted).
- **Recovery after a parent prompt** rests on the lane's run alone (8/8, recomputed twice from raw). It was not live-re-run independently.
- **The two r-v follow-up receipts** that ended `RUNTIME_ERROR` in under 200 ms have an unknown cause.
- **Lesson for long arms:** a foreground tool call can be cancelled with no shell trap running. The r-v driver stopped at 10:27:17, about 15 minutes after launch, which suggests a tool time limit (unverified). Run long arms as their own supervised units, with cleanup outside the tool call.
- **Evidence:** `/root/orch-ops/orchestration-scaling/e2/E2a-6c-reviewer/evidence-a6c-rv/` and `reviews/E2a-6c-luna-review-r3.md`.
