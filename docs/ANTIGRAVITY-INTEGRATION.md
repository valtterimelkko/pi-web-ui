# Antigravity Integration

> Read this when working on the Antigravity / `agy` runtime path. For first-stop debugging, start with [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) and `npm run debug:where -- <session-id-or-runtime-session-id-or-path>`.

Pi Web UI integrates Google's Antigravity agent (Gemini Flash tiers, Claude
models, GPT-OSS) as a fourth runtime path, alongside Pi Coding Agent, the
Claude runtime family, and OpenCode.

## Adopter quick take

Read this doc if Gemini/Antigravity access is one of the reasons you want Pi Web UI.

Recommended public framing:
- **Who this path is for:** users who specifically want Antigravity/Gemini available in the same browser shell as the other runtimes
- **Setup difficulty:** medium
- **Current shape:** persistent `agy` process in structured stream-json mode per session — real token streaming, tool-call visibility, real token usage, native follow-up queueing
- **Main caveats:** no mid-run steering join (queue-only), no approval UI path, and the runtime runs with a higher-trust permission posture than Pi or richer Claude/OpenCode paths

## Architecture

```
Browser → WebSocket /ws → WebSocketConnectionManager → AntigravityService
                                                            │
                          AgyStreamProcess (1 per live session, respawn on demand)
                                                            │  stdin:  {"event":"user",…} NDJSON
                                                            ▼
                                              agy --input-format stream-json
                                                  --output-format stream-json
                                                  [--model <slug>] [--conversation <uuid>]
                                                            │  stdout: init / step_update / result NDJSON
                                                            ▼
                                                     AgyEventNormalizer
                                                            ▼
                                            NormalizedEvent pipeline (WS + /events)
```

The runtime uses a **persistent process per session** in agy's structured
headless mode (agy ≥ 1.1.27): one warmed conversation, one `result` event per
turn, streamed `text_delta` fragments (~200 ms cadence), per-step tool events,
and real token usage. Setting `ANTIGRAVITY_STREAM_MODE=false` restores the
legacy text print-mode wrapper (rollback hatch).

Validated protocol facts behind this design (live-validated 2026-09-08 against
agy 1.1.27; full capture in the pi-enhancement research doc
`2026-09-08-agy-json-headless-live-validation.md`):

- **Streaming invariant:** the concatenation of all `text_delta` fragments in
  a turn equals `result.response` byte-for-byte.
- **Queue semantics:** a user event written while a turn runs is buffered by
  agy and executed as the next turn (native follow-up queueing). There is no
  mid-run join: signals kill the whole session process.
- **Resume:** `--conversation <id>` (into one-shot or persistent processes)
  carries full context without replaying old events; `result.response` is only
  the new turn's reply.
- **Loud failures:** unknown `--model` values, effort conflicts, and unsupported
  effort axes fail fast with a structured ERROR envelope (exit 1, zero usage,
  no model call) — the historic silent-downgrade behaviour no longer exists.
- **Conversation-id hazards:** an invalid conversation id silently creates a
  new conversation (detected via `result.conversation_id` mismatch, surfaced as
  a warning, actual id persisted); an *empty* id resumes an unrelated recent
  conversation and is never sent.

## Key Files

| File | Purpose |
|---|---|
| `server/src/antigravity/antigravity-service.ts` | Main service — session management, stream turn execution, follow-up queue, model/thinking-level changes, model listing |
| `server/src/antigravity/agy-stream-process.ts` | Child lifecycle: spawn args, NDJSON framing, FIFO turn queue, stall/timeout watchdogs, abort, idle shutdown |
| `server/src/antigravity/agy-event-normalizer.ts` | Pure stream→NormalizedEvent translator with per-turn accumulator (text, tools, usage) |
| `server/src/antigravity/agy-event-types.ts` | Lenient Zod schemas for the agy wire surface + `helpTextSupportsStream` capability probe |
| `server/src/antigravity/agy-models.ts` | `agy models` parsing, slug canonicalisation, sibling-derived thinking levels, effort validation |
| `server/src/antigravity/antigravity-session-store.ts` | JSONL turn store at `~/.pi-web-ui/antigravity-sessions/<id>.jsonl` (turns carry usage/tools in stream mode) |
| `server/src/antigravity/antigravity-history-replay.ts` | Converts stored turns into normalized replay events (incl. stored tool calls) |
| `server/src/antigravity/antigravity-session-subscribers.ts` | Tracks which WebSocket clients subscribe to which sessions |

## Subprocess Invocation

```bash
agy \
  --input-format stream-json \
  --output-format stream-json \
  --model gemini-3.8-flash-medium \      # canonical slug (init.model echoes it)
  --conversation <uuid>                  # omitted on first turn; never empty
```

The binary path defaults to `/root/.local/bin/agy`, overridable via `AGY_BINARY`.
Prompts are written to stdin as `{"event":"user","message":{"content":…}}`, one
line per turn. The process is spawned lazily on the first prompt, kept warm
across turns (spawn cost ~2.5 s is paid once), and shut down after the idle
timeout (`antigravityIdleTimeoutMs`) by closing stdin (agy exits 0 cleanly).

## Conversation Continuity

The conversation UUID lives in `RegistryEntry.antigravityConversationId` and in
each stored turn. It now comes from the stream itself (`init`/`result` events)
— no filesystem diffing, no log scraping. A mismatch between the stored id and
the id the result reports is surfaced as a warning and the *actual* id is
persisted (an invalid stored id makes agy start a fresh conversation).

Crash recovery: a killed process finalises its in-flight turn as an error, and
the next prompt respawns with `--conversation <last-known-id>` and retries.

## Model + Thinking-Level Selection

- `agy models` prints `<slug>\t<Label>`; both forms are accepted by `--model`,
  but the **slug is canonical** (init.model echoes it; `/models` selectors
  expose the slug).
- **Thinking level = sibling slug swap** (`gemini-3.6-flash-low` →
  `…-high`), derived per model from actual catalogue siblings. Models without
  a level axis (Claude, GPT-OSS) expose `thinkingLevels: []` and reject level
  changes loudly. `--effort` is never passed (live-validated: it conflicts with
  baked-level slugs and is unsupported for non-Gemini families).
- Model/thinking changes while a turn runs return 409 `SESSION_BUSY`; when
  idle, the warm process is dropped and the next turn respawns with the new
  `--model`, resuming the same conversation.

## Event Format

Per turn (normalized, same pipeline as other runtimes):

```
agent_start                                   (service, on prompt accept)
  message_start/user … message_end            (service)
  message_start(assistant)                    (normalizer, first text delta)
  message_update (text_delta …)               (streamed, ~200 ms cadence)
  tool_execution_start / tool_execution_end   (per tool step; tool_info)
  stream_activity                             (non-content steps: liveness)
  message_end(assistant)                      (service, after durable persist)
agent_end {usage:{input,output,thinking,cacheRead,total}, agyStatus, numTurns}
```

Failed turns emit a visible assistant error body + `agent_end` (no blank
screen). `agyStatus` carries the raw agy terminal status
(SUCCESS/ERROR/WAITING/…).

## Session Registry

Sessions are stored in `~/.pi-web-ui/session-registry.json` with:
- `sdkType: 'antigravity'`
- `antigravityConversationId?: string`

## Configuration

All config lives in `server/src/config.ts`:

| Variable | Default | Env override |
|---|---|---|
| `antigravityEnabled` | `true` | `ANTIGRAVITY_ENABLED` |
| `antigravityStreamMode` | `true` | `ANTIGRAVITY_STREAM_MODE` (`false` = legacy text mode) |
| `antigravitySessionDir` | `~/.pi-web-ui/antigravity-sessions` | `ANTIGRAVITY_SESSION_DIR` |
| `antigravityDefaultModel` | `'Gemini 3.5 Flash (Medium)'` | `ANTIGRAVITY_DEFAULT_MODEL` |
| `antigravityPromptTimeoutMs` | `600000` (10m) | `ANTIGRAVITY_PROMPT_TIMEOUT_MS` |
| `antigravityIdleTimeoutMs` | `1800000` (30m) | `ANTIGRAVITY_IDLE_TIMEOUT_MS` |
| `antigravityMaxSessions` | `4` | `ANTIGRAVITY_MAX_SESSIONS` |
| `antigravityMaxPinnedSessions` | `5` | `ANTIGRAVITY_MAX_PINNED_SESSIONS` |
| `antigravityCleanupIntervalMs` | `60000` (1m) | `ANTIGRAVITY_CLEANUP_INTERVAL_MS` |
| `antigravityHeartbeatIntervalMs` | `5000` (5s; legacy mode only) | `ANTIGRAVITY_HEARTBEAT_INTERVAL_MS` |
| `antigravityStallTimeoutMs` | `300000` (5m; stream mode = no-events gap) | `ANTIGRAVITY_STALL_TIMEOUT_MS` |
| `antigravityMaxAttempts` | `2` | `ANTIGRAVITY_MAX_ATTEMPTS` |

## Capabilities

Reported via Internal API `/api/v1/capabilities` (stream mode):

```json
{
  "antigravity": {
    "available": true,
    "enabled": true,
    "backendMode": "stream-json",
    "supportsFollowUp": true,
    "followUpSemantics": "queue_while_busy",
    "supportsSteer": false,
    "supportsModelSwitch": true,
    "supportsThinkingLevel": true,
    "supportsPinning": true,
    "supportsReplayHistory": true,
    "supportsApprovals": false,
    "supportsHeartbeat": false,
    "supportsInteractiveQuestions": false,
    "supportsStructuredQuestionResponse": false
  }
}
```

## Available Models

Fetched live via `agy models` (60 s cache). Each `/models` entry carries
`selector` (the slug), `displayName` (label), and `thinkingLevels` derived from
catalogue siblings. When `agy models` cannot run, a small static fallback list
is served.

## Goal Function (contract 1.38.0)

`agy` has no native goal, so antigravity goals are **fully server-owned** — no
mod, no CLI cooperation:

- `POST /api/v1/sessions/:id/goal {action:"start", objective, verifyCommand?, maxTurns?}`
  arms a control record under `~/.pi-web-ui/antigravity-sessions/goal-control/<sessionId>.json`
  and dispatches a goal start prompt through the normal prompt pipeline
  (queued transparently when a turn is already running).
- A turn-driven sweeper (`AGY_GOAL_SWEEP_MS`, default 15 s) verifies each
  **completed** turn: with `verifyCommand`, exit 0 means achieved
  (`verification.status:"passed"`); without one, the goal prompts ask the model
  to end its reply with exactly `GOAL_STATUS: ACHIEVED`
  (`verification.status:"self_reported"`). Unmet turns get a continuation
  prompt until `maxTurns` (default/cap 100) is exhausted → `failed`/`budget`.
- `pause` disarms the sweeper (the in-flight turn still settles); `resume`
  re-arms and dispatches one continuation; `clear` retires the record.
- `/goal <objective>` / `/goal pause|resume|clear|status` typed at the prompt
  boundary (HTTP `POST /prompt` or the web-UI message box) is intercepted as
  goal control and never reaches the model — it resolves even while the
  session is busy. `/goal --verify "npm test" <objective>` arms with a verifier.
- Projections, `goal_state`/`goal_end` broker events and the browser GoalPanel
  (pause/resume/clear buttons) behave exactly as on the other runtimes.

## Frontend

- `NewSessionModal` shows an Antigravity button (violet theme) when
  `antigravity_available: true` arrives over WebSocket.
- Streaming compose is enabled for antigravity in **queue-only** mode: the
  composer shows a single "Queue — runs after the current turn" affordance;
  the steer option is deliberately absent (no mid-run join exists).

## Turn durability and failure visibility

A prompt (and a follow-up queue write) is persisted as a `running` turn before
it is handed to the agy process (RC1). Successes finalise `done` with real
`usage`, `numTurns`, `agyStatus`, and compact `tools` records; timeouts, stalls,
aborts, and process deaths finalise `error` with a non-empty body. Every
terminal path emits `agent_end`, so failures are visible on replay and can
trigger opted-in notifications.

Watchdogs (stream mode):
- **Hard ceiling** per turn: `antigravityPromptTimeoutMs` → SIGTERM.
- **Stall**: no parsed stream events for `antigravityStallTimeoutMs` → SIGTERM.
- **Abort**: SIGTERM, consume agy's closing `result`, escalate to SIGKILL after
  a 5 s grace window. Reason comes from what WE sent (agy reports the same
  "timeout waiting for response" string for signals and print-timeout expiry).
- A stall/timeout retries within `antigravityMaxAttempts` after a respawn with
  `--conversation`; plain agy ERROR results never retry.

## Live Validation

agy has no conversation-data directory override, so Antigravity is excluded
from the disposable `--runtime all` matrix. Run the antigravity scenarios
against an explicitly authorised server (isolated antigravity-capable instance
or production with `--allow-production`); it touches the real `~/.gemini`
state:

```bash
npm run validate:live -- --socket <sock> --token-path <token> \
  --runtime antigravity --scenario <smoke|follow-up|session-info>
```

Stream-mode specific checks (L1–L11 in
`docs/plans/ANTIGRAVITY-JSON-STREAM-INTEGRATION-PLAN.md`): incremental
`text_delta` streaming, mid-turn follow-up queueing, model-slug echo in
`init.model`, loud model failures, abort/timeout behaviour, crash recovery with
`--conversation` resume, parallel sessions, Internal-API follow-up receipts,
and legacy-session resume.

## Authentication

`agy` uses the local user's Antigravity Google OAuth credentials from
`~/.gemini/antigravity-cli/`. **No API keys** — the server runs as the same OS
user that logged in with `agy`, and no credentials are read into this repo.

## Troubleshooting

Start with [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) and:

```bash
npm run debug:where -- <session-id-or-runtime-session-id-or-path>

# Check binary + stream capability
agy --version
agy --help | grep -E "input-format|output-format"

# Free model probe (no quota): current effective model
agy -p /model

# Check auth
agy -p "Reply OK"

# Check live availability
TOKEN=$(cat ~/.pi-web-ui/internal-api-token)
curl -s --unix-socket ~/.pi-web-ui/internal-api.sock \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost/api/v1/capabilities | python3 -m json.tool

# Session logs
journalctl -u pi-web-ui -f | grep -i antigravity
```

Related docs:
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`CODEBASE-MAP.md`](./CODEBASE-MAP.md)
- [`docs/plans/ANTIGRAVITY-JSON-STREAM-INTEGRATION-PLAN.md`](./plans/ANTIGRAVITY-JSON-STREAM-INTEGRATION-PLAN.md)
