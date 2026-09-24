# Phase 2 live validation — goal actions tell the truth (S3 live evidence)

- Date: 2026-09-24, disposable server `/tmp/pi-validation-p1` (source mode, Phase 2 build), same fenced session as Phase 1 (fixture pid 1644592 owns the lease).
- Session: `01a0d3ae-dc54-76c3-8b50-91e8c0c82699`

## The identical call, before and after

Phase 0 RED (unmodified master): `200 accepted:true in 0.0207s`, receipt `completed/documented_handler_return`, zero goal state written.

Phase 2 build:

```
HTTP 409 in 0.542340s
{"sessionId":"01a0d3ae-…","runtime":"pi","action":"start",
 "accepted":false,"applied":false,
 "error":"Goal action 'start' did not apply: status_unchanged",
 "code":"GOAL_ACTION_NOT_APPLIED",
 "observedGoal":{"supported":true,"status":"idle"},
 "extensionWarnings":[
   "Ownership: conflict (pid 1644592, tui) […] This runtime is fenced; run /autocompact75 resync when idle, or close and reopen the session.",
   "🧠 Memory loaded: 125 lines project, 1 lines session",
   "Goal Engine is read-only because this runtime does not own the session: session is owned by another live runtime (pid 1644592). Stop the other runtime or use /autocompact75 takeover for an intentional handoff."],
 "receipt":{"runId":"a4f11581-970e-478d-a70f-0a298bbd5b0e","status":"failed","errorCode":"GOAL_ACTION_NOT_APPLIED"}}
```

The body quotes the goal-engine's own read-only warning (the S3 live-validation requirement), plus the fence notice and the session's memory-load notification (bounded capture, newest evidence).

Raw evidence: `live-p2-goal.txt` in this directory.
