# Phase 1 live validation — PROMPT_NOT_EXECUTED fail-fast (S1 partial evidence)

- Date: 2026-09-24, disposable server `/tmp/pi-validation-p1` (source mode, working tree with Phase 1 changes; production default grace 2000 ms — **no test overrides**)
- Same incident repro as Phase 0: fixture owns the lease (`pid 1644592`, tui), server copy fenced.
- Session: `01a0d3ae-dc54-76c3-8b50-91e8c0c82699`

## Synchronous prompt (was: hang >60 s → TURN_STALLED at 15 min)

```
HTTP 500 in 2.755902s
{"error":"Runtime prompt failed. Inspect diagnostics using the returned runId.","code":"PROMPT_NOT_EXECUTED","runId":"7b4d3f04-566a-4d35-b7ee-5c055108d1d5"}
```

Receipt `GET /runs/7b4d3f04-…`:

```json
{"status":"failed","errorCode":"PROMPT_NOT_EXECUTED",
 "acceptedAt":"2026-09-24T13:51:36.302Z","terminalAt":"2026-09-24T13:51:39.039Z"}
```

**terminalAt − acceptedAt = 2737 ms < 5000 ms (S1 bound met; failure, not watchdog).**

## Detached prompt (202 accepted → failed receipt)

```json
{"status":"failed","errorCode":"PROMPT_NOT_EXECUTED","terminal_minus_accepted_ms":2009}
```

## Extension warning captured into the error detail (Phase 2 capture, Phase 1 consumer)

Server log records the `PromptNotExecutedError` message:

> Prompt accepted but no turn started (input likely swallowed by a runtime extension): **Session input blocked: session is owned by another live runtime (pid 1644592). Run /autocompact75 resync when idle (the idle re-check is retrying automatically), or close and reopen the session.**

The API now quotes the extension's own fence warning instead of reporting a silent success.

Raw evidence files in this directory: `live-p1-prompt.txt`, `live-p1-receipt.txt`, `live-p1-detached.txt`.
