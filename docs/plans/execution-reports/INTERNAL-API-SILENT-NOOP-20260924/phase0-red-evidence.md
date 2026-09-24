# Phase 0 — RED evidence: the three silent no-op symptoms on unmodified master

- Date: 2026-09-24
- Executor: pi-01a0d366 (goal-engine execution of `INTERNAL-API-SILENT-NOOP-AND-SESSION-OWNERSHIP-PLAN.md`)
- Code under test: `master` `9f65fd22` (unmodified; contract 1.44.0)
- Environment: disposable validation server (`npm run validate:server -- --dir /tmp/pi-validation-phase0 --port 0`), isolated lease dir (`PI_SESSION_LEASE_DIR=/tmp/pi-validation-phase0/session-leases`) and isolated goal home (`PI_WEB_UI_GOAL_HOME=/tmp/pi-validation-phase0`). **No production state was touched.**
- Session under test: `01a0d398-1572-7068-aee3-40835aaa2d87` (pi runtime, model `zai/glm-5.3` fallback default)
- Fence fixture: `fence-fixture.mjs` in this directory (imports `acquireSessionLease`/`refreshSessionLease` from pi-enhancement `auto-compact-75/session-ownership.mjs`; heartbeats every 10 s)

## Reproduction of the 23 Sep incident shape

1. Server run 1: session created through the API (server-side runtime owned the lease).
2. Server stopped gracefully; restarted (run 2) — session registered but **not loaded**.
3. Fixture acquired the lease on the session file (`status:"owned"`, `recoveredStaleLease:true`, `pid:1594141`, `mode:"tui"`, `pidStartIdentity:"117919365"`) and heartbeated.
4. Internal API actions against the session loaded the server-side copy → extension startup verify → **fence**.

Server log (wrapper2.log):

```
[auto-compact-75] Ownership: conflict (pid 1594141, tui) [2026-09-24T13-25-54-675Z_01a0d398-….jsonl] — session is owned by another live runtime (pid 1594141). This runtime is fenced; run /autocompact75 resync when idle, or close and reopen the session.
```

## RED-1 — goal start reported success without changing anything (S3 baseline)

`POST /sessions/:id/goal {"action":"start","objective":"RED evidence: …"}` on the fenced session:

```json
{"sessionId":"01a0d398-…","runtime":"pi","action":"start","accepted":true,
 "receipt":{"runId":"9f2c571d-1991-4dfb-9ec8-5e192b001c30","status":null,"dispatchMode":"prompt"},
 "goal":{"supported":true,"status":"idle"}}
HTTP 200 in 0.020700s
```

Inner receipt `GET /runs/9f2c571d-…` (evidence-red1-inner-receipt.txt): `status:"completed"`,
`cessation:{state:"confirmed",basis:"documented_handler_return"}`, `assistantMessages: 0`.
Isolated goal home: **no goal-engine state file was ever written** (`(no goal-engine dir — nothing was written)`).
→ The API claimed success (200 accepted + completed receipt) for an action that did not happen. Files: `evidence-red1-goal-noop.txt`, `evidence-red1-inner-receipt.txt`.

## RED-2 — prompt swallowed; request hangs until the 15-min watchdog (S1 baseline)

`POST /sessions/:id/prompt {"message":"…reply PONG…","mode":"prompt"}` on the fenced session:

- The synchronous HTTP request **did not return within 60 s** (client timeout abandoned it; the server-side run stayed non-terminal awaiting `agent_end` — the plan's §1 symptom 3, TURN_STALLED after 15 min).
- Events snapshot after 60 s: `count: 1, types: session_update` — **no `agent_start` ever arrived**.
- `GET /sessions/:id` throughout: `status:"idle"`, `messageCount:0` — the server's own read path shows nothing happened.

File: `evidence-red2-prompt-accepted.txt` (empty — request never returned; this is itself the evidence), fence lines above.

## RED-3 — control action 404 on a registered, idle, persisted session (S5 baseline)

`POST /sessions/:id/control {"action":"set_thinking_level","level":"high"}` immediately after server restart (session registered but not loaded):

```
{"error":"Pi session not loaded","code":"SESSION_NOT_FOUND",…}
HTTP 404 in 0.007743s
```

while `GET /sessions/:id` for the same id returns a healthy idle session. File: `evidence-red3-control-404.txt`.

## Dead-owner RED baseline (S7) — the fence never recovers on its own

1. The first hung run wedged the session: a second prompt returned `409 SESSION_BUSY` ("Wait for the running turn…") — collateral damage of one swallowed prompt.
2. `POST /sessions/:id/abort` cleared the wedged run (200, session idle again).
3. Fixture killed (`kill -9`, verified DEAD).
4. A new prompt **hung again** (no response in 15 s; still no `agent_start` in the events snapshot) — the conflict fence persists even with the recorded owner dead. The extension's own log still describes the dead pid 1594141 as "another live runtime".

→ Automatic dead-owner recovery (S7) does not exist on master. Files: `evidence-red-deadowner-prompt.txt` (empty — request hung), fence lines in wrapper2.log.

## Notes

- The synchronous prompt hang also blocks the goal-control path for non-slash flows — but the goal route completes because the composed `/goal …` slash command terminates at `documented_handler_return` without needing a turn (the exact mechanism RED-1 exploits).
- Model calls: **zero** in this whole procedure (the fence swallows input before any provider call).
- Raw server logs: `/tmp/pi-validation-phase0/wrapper2.log` (ephemeral); the load-time fence line is quoted above verbatim.
