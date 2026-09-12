# R1 — Root-cause investigation: the pi-web-ui event-loop stall

You are a child investigator. **This is a READ-ONLY investigation.** Find the root cause — or prove you cannot — and report evidence. Do not fix anything, do not change code, do not restart anything.

## What happened

On **2026-09-12 between ~22:17 and ~22:31**, the production `pi-web-ui` service (systemd unit `pi-web-ui.service`, PID 1653997, `node server/dist/index.js`) stopped responding to everything, then **recovered on its own** around 22:30–22:31 without any intervention. A restart was authorised but not performed, because a re-probe found the service healthy again.

**The operator reports that concurrently, their tmux web UI also appeared frozen — it could not connect to sessions.** That is a second symptom, and it matters: it suggests either a broader host-level event or a second surface failing for the same underlying reason.

## Hard evidence already gathered (do not re-derive; verify or extend)

**Symptoms during the stall:**

| Observation | Value |
|---|---|
| API requests | every request timed out — 13 s, 24 s, 28 s; `http=000` (no response) |
| Unix-socket accept queue (`/root/.pi-web-ui/internal-api.sock`) | **67, then 72 pending** connections against a 511 backlog — the server was accepting *nothing* |
| Main thread state | **`R` (running/spinning)** while all 11 worker threads sat in `futex_wait_queue` |
| `wchan` | `0` |
| Logs | stopped advancing — 2 lines in 5 minutes; the 30-second `[MultiSessionManager] Memory:` heartbeat was silent from **22:21:45** |
| CPU | main process ~2.4% — **idle**, not saturated |
| Memory | heap **535 MB of a 4288 MB limit**; RSS ~1.5 GB — **not exhausted** |
| Load average | ~2.2 on the host |
| Disk | 80 GB free on `/` |

**The one direct clue in the logs:**

```
22:17:51 [EventLoopShed] event-loop shed mode enabled: lagMs=1728
```

That is ~3 minutes *before* the stall became total, and it is the only shed event in the window.

**Already ruled out (with evidence above):** memory exhaustion, CPU saturation, disk pressure. Also ruled out as a cause: a sibling child's four `validation-server.ts` processes, which were at **0.0% CPU and idle** throughout (`--port 3469 --dir /tmp/pi-e1-val`, PID 2787180 etc.).

**Timeline context:**

- ~22:05–22:08: a sibling child began live-validation work, spawning a Vite dev server and a validation server; the service logged a restart-time memory line at 22:08:46.
- 22:17:51: the event-loop-shed event (`lagMs=1728`).
- ~22:21:45: last log line before silence.
- ~22:30–22:31: service answering normally again, backlog drained to zero, no restart performed.
- After recovery: three consecutive probes answered 200 in **32–53 ms**.

**Second, separate finding worth noting in your report:** the notification path (`scripts/notify.sh`) depends on the Internal API, so during the outage it **spooled messages locally instead of delivering them** — the operator would have been told nothing. That is a design defect independent of your root cause; mention it only if it interacts with what you find.

## What to investigate

You have freedom in method, but here are the hypotheses with the strongest prior:

1. **The watch-wake polling path.** Six `watch_wake` registrations were active, polling the durable ledger on an interval (30 s) and hitting `GET /sessions/:id/watch?sinceIndex=N`. Read `server/src/internal-api/watch/*` and the watch manager, and determine what work each poll does, how it scales with the number of watches, and whether a poll can do unbounded work (re-reading large session files, O(n²) scans, unbounded JSON parsing). **Check specifically whether a poll parses a whole session transcript per tick.**
2. **The event-loop shed monitor itself.** Read `server/src/internal-api/event-loop-shed.ts`. What triggered it, what does it do once enabled, and can its own behaviour (e.g. shedding, retry, queueing) contribute to a stall rather than relieve one?
3. **A synchronous blocking section on the main thread.** The evidence points here: main thread `R`, workers idle on futex, no I/O progress, idle CPU. Look for synchronous filesystem or CPU-heavy work on the request or timer path — e.g. `fs.readFileSync`, large `JSON.parse`, `JSON.stringify` of large structures, a regex with catastrophic backtracking, or a loop over sessions × messages. The comment in `client/src/store/sessionStore.ts` mentions a ~2.2 MB persisted payload with ~800 cached sessions, so **large-payload serialisation is a known landmine in this codebase**.
4. **Session/timer fan-out.** A per-session interval that does real work, multiplied by session count; or a timer that re-schedules itself with a growing payload.
5. **The concurrent sibling work.** A Vite dev server and four validation servers were running on the host. Determine whether they could starve or block the service without CPU saturation (e.g. file-watcher floods, inotify exhaustion, FUSE/`/mnt/gdrive` access, disk I/O wait).

**On the tmux freeze:** do not assume it is the same cause. Check whether anything else on the host stalled at the same time, and whether both surfaces shared a dependency — CPU, disk I/O, the FUSE mount, a session store, or the same Node process. If you cannot connect them, say so.

## Method requirements

- **Read the logs yourself** rather than trusting my summary, and quote what you find: `journalctl -u pi-web-ui.service --since "2026-09-12 21:50" --until "2026-09-12 22:40" --no-pager`.
- Distinguish **proven** from **plausible**. A ranked list of suspects with the evidence for and against each is a legitimate and useful outcome — **do not manufacture a single confident cause**. If the evidence does not support a conclusion, say exactly that.
- You may write **only** under `/tmp/r1-*`. Do not create worktree files, do not edit repository files, do not commit.
- **Do not restart, stop, or signal any service.** Do not touch production.

## Explicitly forbidden

- Modifying, creating or deleting any file outside `/tmp/r1-*`.
- Restarting, stopping, reloading or signalling `pi-web-ui.service` or any other service.
- Changing configuration, or any write to a live system.
- Claiming a root cause without evidence that discriminates it from the alternatives.

## Stop and report if

- You find a **reproducible** trigger (best outcome — describe exactly how to reproduce it).
- You conclude the cause cannot be determined from available evidence; then give the ranked suspects, what evidence would discriminate them, and the single highest-value next diagnostic to capture.
- You need to change or restart something to make progress — **stop instead** and report that need.

## Hand-back format (report exactly this)

1. **Status**: root cause identified / ranked suspects only / cannot determine.
2. **The mechanism** — what specifically blocked the event loop, step by step, with the evidence for each step.
3. **Evidence** — quoted log lines, file:line references, command output. Raw, not paraphrased.
4. **Hypotheses tested and rejected**, with what rejected each one.
5. **Does it explain the tmux freeze?** Yes with evidence, no, or unknown.
6. **Reproducible?** If yes, exact steps. If not, why not.
7. **The single best next diagnostic** if you could not settle it.
8. **Recommended fix** — described, not implemented, and explicitly marked as not yet done.
9. **What you could NOT determine**, and why.
10. **Confidence**: high / medium / low, and what would change it.
