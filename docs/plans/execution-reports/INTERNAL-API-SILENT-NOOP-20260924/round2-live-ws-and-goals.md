# Round 2 live evidence — browser re-attach over WebSocket + non-interactive goal flags

Disposable server /tmp/pi-validation-ws (contract 1.45.0 build, isolated agent dir carrying the
4a auto-compact-75 build AND the round-2 goal-engine build). Session 01a0d487-…; fence fixture pid
2128347 (tui).

## Fix 1 — real WebSocket browser client across dead-owner recovery

Handshake per docs/LIVE-VALIDATION.md option 3: POST /api/auth/login {password} + Origin → cookie;
ws://127.0.0.1:<port>/ws with Cookie+Origin → authenticated → switch_session (subscribe+view).
The SAME connection stayed open through: fence published (conflict) → owner killed → Internal API
prompt → automatic recovery → real turn ("PONG", HTTP 200).

Verdict (ws-verdict.txt): {"recovered": true, "anyEventAfter": true, ...}
Received on that connection:
  {"type":"session_event","event":{"type":"session_recovered","message":"Session was fenced by
   another runtime; the dead owner was detected and the session recovered automatically…"}}

## Fix 3 — non-interactive goal flags end-to-end (new extension in the isolated dir)

- goal start (fresh): applied:true.
- goal start --replace on the ACTIVE goal (impossible before: ~30 s confirm timeout → 409):
  **applied:true**, goal replaced.
- goal clear on the ACTIVE goal (route defaults --yes): **applied:true**, goal idle.

Raw: ws-recovery-events.json, ws-verdict.txt (this directory).
