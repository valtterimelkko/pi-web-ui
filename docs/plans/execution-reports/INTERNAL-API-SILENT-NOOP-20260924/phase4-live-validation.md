# Phase 4 live validation — ownership gate, recovery, and status (S6/S7/S8 live evidence)

- Date: 2026-09-24, disposable server `/tmp/pi-validation-p1` (source mode Phase 4b build) with an
  **isolated agent dir** (`PI_AGENT_DIR=/tmp/pi-validation-p1/agent-dir`) carrying the Phase 4a
  store build of auto-compact-75 — the live `/root/.pi/agent/extensions` copy was NOT modified.
- Session: `01a0d3ae-dc54-76c3-8b50-91e8c0c82699`; fence fixture pid 1644592 (tui) holds the lease.

## S8 — ownership snapshot on GET /sessions/:id (display-only)

```json
{"ownership":{"status":"conflict",
 "reason":"session is owned by another live runtime (pid 1644592)",
 "ownerPid":1644592,"ownerMode":"tui",
 "updatedAt":"2026-09-24T14:47:09.521Z","leaseState":"owned"}}
```

## S6 — live foreign owner: 409, no run, in milliseconds

Prompt (detached):

```
HTTP 409 in 0.005710s
{"error":"Pi session is owned by another live runtime","code":"SESSION_OWNED_BY_OTHER_RUNTIME",
 "ownerPid":1644592,"ownerMode":"tui",
 "reason":"session is owned by another live runtime (pid 1644592)",
 "hint":"Stop the other runtime or hand the session off intentionally, then retry.",
 "ownership":{...}}
```

Goal control: identical 409 in 0.005790s. No run receipt is created; the session and lease are untouched.

Observed gating ladder (plan-conformant): with nothing published yet (fresh server, unloaded session)
the first prompt proceeds per "unknown → no gating", loads the session, the extension fences, and
**Phase 1 fails it fast** (PROMPT_NOT_EXECUTED). Once the conflict is published, every further
prompt/goal/control refuses 409 as above.

## S7 — dead owner: automatic recovery, pin-preserving, real turn

1. Fixture killed (`kill -9`).
2. `POST /sessions/:id/prompt {"message":"S7 recovery probe: reply with exactly PONG"}`:

```
HTTP 200 in 11.557379s
{"runId":"201dff2b-…","content":"PONG","turnComplete":true,…}
```

3. Ownership read-back after recovery:

```json
{"ownership":{"status":"owned",
 "reason":"recovered a lease from a dead runtime",
 "ownerPid":1770964,"ownerMode":"print","leaseState":"owned"}}
```

The exact 23 Sep loss (an hour stuck fenced) now self-heals inside a single prompt call: dispose →
rehydrate → extension startup reclaims the dead lease → owned → the turn runs for real.

Raw evidence: `live-p4b-prompt-409.txt`, `live-p4b-ownership-s8.txt`, `live-p4b-recovery.txt` in this directory.
Unit evidence: `pi-ownership-gate.test.ts` (7 tests incl. pinned-session pin restoration and the
C1 fail-closed uncertain case), `session-ownership-status.test.ts` (15 tests).
