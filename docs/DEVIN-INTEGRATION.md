# Devin Integration (ACP)

> How Pi Web UI drives the Devin CLI (Cognition) as a sixth runtime, over
> `devin acp` only. Lane A1 of the devin-parity programme — plan of record:
> `DEVIN-PARITY-PLAN.md` (Agent OS plans directory), §4 W1.
> Status: implemented, feature-gated, **off by default** (`DEVIN_ENABLED=false`).

## Overview

Devin joins Pi Web UI at the same standing as Antigravity: browser sessions
and the Internal API, streaming (text, thinking, tool calls, usage), replay,
resume, cancel, models with thinking levels, watches that wake Devin sessions,
and session transfer. Two frozen design points shape everything else:

- **ACP only.** The runtime spawns `devin acp` (JSON-RPC 2.0 over stdio, one
  JSON object per line, ACP protocol 1). `devin -p` is never used — the plan
  excludes it.
- **The model travels per session**, through `session/set_config_option` on
  the `model` config option. A `--model` spawn flag loses to Devin's config
  file (live-verified in the W0 trial), so the flag is never passed.

## Feature gate

`DEVIN_ENABLED=true` turns the runtime on. Disabled is the default and fails
closed everywhere: create answers 503, `/api/models?sdkType=devin` and
`models.devin` return empty, capabilities advertise `available: false`,
health reports devin unavailable. The gate is checked exactly like
`COMMAND_CODE_ENABLED`.

## Process model (plan D1)

One `devin acp` child per live session:

- **Lazy spawn** — the child starts on the session's first prompt, not at
  create.
- **Idle shutdown** — a child with no pending turn is stopped after
  `DEVIN_PROCESS_IDLE_SHUTDOWN_MS` (default 5 minutes).
- **Respawn → resume** — the next turn spawns a fresh child and calls
  `session/load` with the native session id (Devin names them, e.g.
  `brass-akubra`), so history and context survive the restart. Review fix
  (2026-11-08): `session/update` notifications that arrive during
  `session/load` (the history replay) are dropped — they never stream as
  live events and never merge old replies into the new turn's finalText —
  and the turn adapter is reset immediately before each `session/prompt`.
  Pi Web UI's
  own per-session JSONL turn store
  (`DEVIN_SESSION_DIR`, default `~/.pi-web-ui/devin-sessions/`) holds the
  replayable turns.
- **Real HOME in production** — `DEVIN_HOME` defaults to the user's home so
  every session lands in the one `sessions.db` the worklog reads and the host
  kit in `~/.config/devin/` applies. Tests and validation pass a throwaway
  home; three concurrent sessions on one store were live-validated (no lock
  errors).

## Environment allow-list (plan D2)

Every spawn passes ONLY `HOME`, `PATH`, `LANG`, `TERM` plus deliberate
`DEVIN_*` variables. The server's environment is never forwarded — Devin
hooks inherit the spawning environment, and the trial showed a Claude
session's tokens leak into hook logs when the full env is passed.

## ACP surface used

`initialize` (protocolVersion 1, fs/terminal client capabilities false) ·
`session/new {cwd, mcpServers: []}` · `session/load` (resume + replay) ·
`session/prompt` · `session/cancel` · `session/set_config_option` (`model`,
`mode`). Children run in Devin's `bypass` mode (set right after session
creation). Agent→client requests are answered by policy:

- `session/request_permission` → select the first `allow` option (children
  also run bypass; this is the belt to those braces);
- anything else → JSON-RPC method-not-found (`-32601`).

Unknown agent notifications (`_cognition.ai/*`) are ignored safely and logged
at debug. Review fix (2026-11-08): a spawn error (e.g. ENOENT) is handled —
pending requests fail, the client marks itself exited — and any handshake
failure or timeout (initialize / session/new / session/load /
set_config_option) stops the spawned child before the error propagates, so a
failed start never leaks an orphan `devin acp` process.

## Events

The adapter maps ACP `session/update` payloads to normalized events:
`agent_message_chunk` → text deltas, `agent_thought_chunk` → thinking deltas,
`tool_call`/`tool_call_update` → tool cards (title, kind, rawInput, output
text, status), `usage_update` → usage. The prompt result's `usage` (input,
output, cached read) finalises the turn's token accounting. **`agent_end` is
always emitted** — on success, cancel and error — which is what run-receipt
terminal detection and the watches depend on.

## Models and thinking levels

`GET /api/models?sdkType=devin` and `GET /api/v1/models` list the whole
`devin models list --format json` catalogue (served live from the CLI with a
60-second cache; `npm run devin:refresh-models` prints an observational
summary).

- **No allow-list.** Owner ruling 01 (2026-11-08): every catalogue model is
  usable everywhere — Internal API create/set_model, children, the browser
  picker. Each entry carries an additive `pricing` field (`free` boolean plus
  the CLI's raw price text) so callers can see which models are free; it is
  information, never a gate.
- **Thinking levels are sibling-model swaps** (plan D4): a model's levels are
  the catalogue ids that differ ONLY in the trailing token among
  `low|medium|high|xhigh|max` — exact `base-<level>` equality, so another
  family sharing a prefix (`swe-2-flash-*` vs `swe-2-*`, `x-codex-high` vs
  `x-medium`) is never absorbed into the ladder. Speed variants (`-fast`,
  `-lightning`,
  `-priority`) and `fusion-*` combos are separate models, never levels.
  Changing level while a turn runs refuses with 409 `SESSION_BUSY`; when
  idle it sets the sibling id as the session's model. Review fix
  (2026-11-08): a failed `session/set_config_option` for `model` surfaces —
  it fails the turn at spawn (clear error, error turn persisted) and
  rejects `set_model` when idle (the Internal API control answers 4xx) —
  never a silent turn on the CLI's default model.

## Follow-up and steer

A follow-up on a busy session queues FIFO and runs as the next turn
(Antigravity semantics). There is no mid-run join in the ACP protocol, so
steer is refused honestly with 409 `SESSION_BUSY` — send it as a follow-up
instead. Review fix (2026-11-08): `abort` also clears that session's queued
follow-ups — abort stops everything pending.

## Permissions

Children run in Devin's `bypass` mode (plan D6). The client additionally
answers any `session/request_permission` with the first allow option so a
prompt can never hang on an unanswered permission.

## Native session listing

`GET /api/v1/sessions/native?runtime=devin` (plus `limit`, `since`, `before`
like the other runtimes) lists every session in
`<DEVIN_HOME>/.local/share/devin/cli/sessions.db` — the Agent OS worklog
builds its session list from this endpoint. The database is opened
**read-only** (`node:sqlite` `readOnly: true`), never written or locked; a
busy WAL is retried briefly and then fails open with an empty list. Registry
sessions surface the native id (`devinNativeSessionId` / `nativeSessionId`)
for joining.

## Session lifecycle cleanup

Devin sessions join the hygiene funnel like the other runtimes: archiving a
session unpins it through the devin service, and retention deletion removes
its turn-store JSONL (`DEVIN_SESSION_DIR`) with the registry record (review
fix 2026-11-08, mirroring the antigravity branch in `session-cleanup.ts`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DEVIN_ENABLED` | `false` | Feature gate (see above) |
| `DEVIN_EXECUTABLE_PATH` | `/root/.local/bin/devin` | CLI binary |
| `DEVIN_HOME` | the user's home | HOME handed to `devin acp` |
| `DEVIN_SESSION_DIR` | `~/.pi-web-ui/devin-sessions` | Turn-store JSONLs |
| `DEVIN_DEFAULT_MODEL` | `swe-2-flash-medium` | Model for new sessions |
| `DEVIN_PROMPT_TIMEOUT_MS` | `3600000` | Turn watchdog; cancels the turn |
| `DEVIN_IDLE_TIMEOUT_MS` | `1800000` | Session-meta idle eviction |
| `DEVIN_MAX_SESSIONS` | `4` | Eviction ceiling |
| `DEVIN_PROCESS_IDLE_SHUTDOWN_MS` | `300000` | Idle child shutdown |
| `DEVIN_NATIVE_SESSIONS_DB` | `<DEVIN_HOME>/.local/share/devin/cli/sessions.db` | Native listing source |

## Live validation

Disposable-server scenarios (throwaway `HOME`, `swe-2-flash-medium` only)
cover: create via Internal API, prompt with a tool call (stream shows text,
thinking, tool output, usage), cancel of a running `sleep 60`, follow-up
queued while busy, resume after process restart, level change
medium→high, a watch `onFire` delivering a prompt to an idle session, and
three concurrent sessions. See `docs/LIVE-VALIDATION.md` for the runner.

## Troubleshooting

See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) → the Devin section
(`scripts/debug-where.mjs <session-id>` prints the store, JSONL and log
paths for a Devin session).
