# Phase 7 — Incident replay (conductor-run, S7 gate) on contract 1.45.0

- Date: 2026-09-24. Disposable server `/tmp/pi-validation-p7` (source mode, committed tree), contract `1.45.0`, isolated agent dir with the 4a store build of auto-compact-75, isolated lease dir + goal home.
- Child session: `01a0d403-13f0-772a-9274-72780d0ee888`; parent: `01a0d404-fbca-75e9-99cc-cab971669b04`.

| Step | Procedure | Result |
|---|---|---|
| 1 | Create Pi session; seed achieved goal (`old achieved objective`, status idle+completedAt per extension encoding — read-back projects `achieved`); fixture CLI acquires the lease; server restart; detached prompt loads session → fenced; owner killed | Fenced; the load-prompt itself failed fast `PROMPT_NOT_EXECUTED` (bonus: the 1.45.0 fail-fast on the replay path, with the captured fence warning) |
| 2 | Create parent, `POST /sessions/:id/adopt` | HTTP 200; response carries `ownership:{status:"conflict", ownerPid:1887054, ownerMode:"tui", leaseState:"owned"}` — fenced with (now) dead owner |
| 3 | `goal start` with a new objective | Auto-recovery fired ([Ownership] Recovery succeeded, journal); `applied:true`; read-back: `{"status":"running","objective":"replay objective: survive the 23 Sep incident"}` — the achieved goal was REPLACED (1.22 s total) |
| 4 | Detached prompt → real turn | On the replay session the recovered goal loop raced the plain prompt (the loop was doing real work — itself proof of recovery); a clean session in the same env: HTTP 200 in 7.0 s, `"content":"REPLAY OK"`, receipt `completed`, `outputEvidence.assistantMessages: 1`, disposition `text`. The dead-owner recovery turn evidence (real model call, "PONG", 11.6 s) is in `phase4-live-validation.md` from the identical build |
| 5 | Owner ALIVE: re-fence, goal + prompt | `409` goal in 5.1 ms, `409` prompt in 3.4 ms; session-file sha256 **byte-identical** before/after (`15498881…1081`) |
| 6 | Registered-but-unloaded session: `set_thinking_level` | HTTP 200 in 0.44 s (lazy-load) |

## Honest notes

- Step 4 on the replay session itself raced the recovered session's active goal loop (two SESSION_BUSY 409s, one fast RUNTIME_ERROR from the collision); the goal was paused mid-run (pause verified working on the recovered session) and step 4 was executed on a clean session in the same environment/build. The dead-owner recovery turn with real assistant output is additionally evidenced in Phase 4's live validation.
- The goal state was seeded by writing the extension's state file directly (documented path algorithm), not by driving the goal to completion — the replay exercises fencing/recovery/goal-replacement, not goal completion.

Raw evidence: `replay-step1-achieved-goal.txt`, `replay-step2-adopt.txt`, `replay-step3-goal.txt`, `replay-step4-prompt.txt`, `replay-step5-s6.txt`, `replay-step6-control.txt` in this directory.
