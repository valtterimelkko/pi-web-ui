# Antigravity Integration

> Read this when working on the Antigravity / `agy` runtime path. For first-stop debugging, start with [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) and `npm run debug:where -- <session-id-or-runtime-session-id-or-path>`.

Pi Web UI integrates Google's Antigravity agent (Gemini Flash 3.5 and others) as a fourth runtime path, alongside Pi Coding Agent, the Claude runtime family, and OpenCode.

## Adopter quick take

Read this doc if Gemini/Antigravity access is one of the reasons you want Pi Web UI.

Recommended public framing:
- **Who this path is for:** users who specifically want Antigravity/Gemini available in the same browser shell as the other runtimes
- **Setup difficulty:** medium
- **Current shape:** subprocess-per-turn wrapper integration
- **Main caveats:** no true streaming today, no approval UI path, and the runtime currently runs with a higher-trust permission posture than Pi or richer Claude/OpenCode paths

## Architecture

```
Browser → WebSocket /ws → WebSocketConnectionManager → AntigravityService
                                                            ↓
                                                   agy CLI subprocess
                                                   (print mode: -p)
                                                            ↓
                                              ~/.gemini/antigravity-cli/
                                              conversations/<uuid>.db
```

The runtime uses **subprocess-per-turn** execution: each user prompt spawns `agy -p ...` as a child process, waits for completion, then emits all events in a single batch.

## Key Files

| File | Purpose |
|---|---|
| `server/src/antigravity/antigravity-service.ts` | Main service — session management, prompt execution, model listing |
| `server/src/antigravity/antigravity-session-store.ts` | JSONL turn store at `~/.pi-web-ui/antigravity-sessions/<id>.jsonl` |
| `server/src/antigravity/antigravity-history-replay.ts` | Converts stored turns to normalized replay events |
| `server/src/antigravity/antigravity-session-subscribers.ts` | Tracks which WebSocket clients subscribe to which sessions |
| `server/src/antigravity/index.ts` | Barrel exports |

## Subprocess Invocation

```bash
agy \
  --dangerously-skip-permissions \
  --print-timeout 10m \
  --model "Gemini 3.5 Flash (Medium)" \
  --conversation <uuid> \          # omitted on first turn
  -p "<user prompt>"
```

The binary path defaults to `/root/.local/bin/agy`, overridable via `AGY_BINARY` env var.

## Conversation Continuity

Antigravity conversations are tracked via the conversation UUID stored in:
- `RegistryEntry.antigravityConversationId` (session registry)
- `AntigravityTurn.conversationId` (JSONL history)

**First turn**: pass a per-run `--log-file`, then parse the `Print mode: conversation=<uuid>, sending message` line to capture the conversation that actually received the prompt. A filesystem snapshot of `~/.gemini/antigravity-cli/conversations/*.db` is only a fallback, because `agy` can create small transient conversation DBs before switching to the real print-mode conversation.

**Subsequent turns**: pass `--conversation <uuid>` to resume, and keep parsing the per-run log as a sanity check for the actual conversation used.

**Output extraction quirk**: resumed calls include prior assistant replies before the newest reply in stdout. `extractNewReply()` slices near the accumulated prior trimmed stdout length (`AntigravitySessionStore.priorReplyAnchor()`) to isolate the new response — but agy's replay of prior turns is **not always byte-stable** across invocations (observed: a run of blank lines collapsed on replay, 10 characters shorter than what the prior turn originally captured). Trusting the recorded byte offset blindly in that case truncates the start of the new reply. `extractNewReply()` therefore verifies/corrects the offset by anchoring on a suffix of the prior turn's actual stored response text (`priorReplyAnchor().text`) near the expected position, searching a ±400 char window and preferring the match closest to the recorded offset (guards against a short/common anchor false-matching earlier in a long transcript). It falls back to the raw offset when no anchor is found within tolerance (agy replayed nothing at all, or replayed content that differs too much to verify) — never worse than offset-only slicing. `buildAgyErrorBody()` (partial output on a timeout/error turn) uses the same shared `sliceAfterPriorReply()` helper.

## Turn durability and failure visibility

A prompt is written to the Pi-owned JSONL store as a `running` turn before the
`agy` subprocess is spawned, and the registry is updated to `status: running`.
A browser refresh therefore retains the user prompt and in-flight state instead
of showing an empty history. Successful turns are finalized as `done`; timeout,
stall, non-zero exit, and spawn failures are finalized as `error` with a
non-empty reason and any safely isolated partial output. Both terminal paths
emit `agent_end`, so the failure is visible in replay and can trigger an
opted-in notification.

If the process crashes while a turn is still `running`, startup deliberately
leaves that turn as an in-flight historical record: replay shows the user prompt
without inventing an assistant reply or `agent_end`. It is evidence of an
interrupted turn, not proof that the model completed. The service does not
silently reconcile it into success; inspect the per-turn `agy-logs/` file,
conversation DB, and diagnostics before deciding whether to retry.

The registry keeps the selected model label intact for UI/metadata. At the agy
boundary the service strips one leading provider prefix such as
`antigravity/` before passing `--model`, and logs a warning if agy still reports
a silent downgrade to another label.

## Event Format

Antigravity emits normalized events in the same format as other runtimes:

```
agent_start
  message_start (role: user)
  message_update (text_delta: prompt text)
  message_end
  message_start (role: assistant)
  message_update (text_delta: agy response)
  message_end
agent_end
```

Events use `{ type: 'text_delta', delta: '<text>' }` as `assistantMessageEvent`, matching the Claude runtime convention.

## Session Registry

Sessions are stored in `~/.pi-web-ui/session-registry.json` with:
- `sdkType: 'antigravity'`
- `antigravityConversationId?: string`

## Configuration

All config lives in `server/src/config.ts`:

| Variable | Default | Env override |
|---|---|---|
| `antigravityEnabled` | `true` | `ANTIGRAVITY_ENABLED` |
| `antigravitySessionDir` | `~/.pi-web-ui/antigravity-sessions` | `ANTIGRAVITY_SESSION_DIR` |
| `antigravityDefaultModel` | `'Gemini 3.5 Flash (Medium)'` | `ANTIGRAVITY_DEFAULT_MODEL` |
| `antigravityPromptTimeoutMs` | `600000` (10m) | `ANTIGRAVITY_PROMPT_TIMEOUT_MS` |
| `antigravityIdleTimeoutMs` | `1800000` (30m) | `ANTIGRAVITY_IDLE_TIMEOUT_MS` |
| `antigravityMaxSessions` | `4` | `ANTIGRAVITY_MAX_SESSIONS` |
| `antigravityMaxPinnedSessions` | `2` | `ANTIGRAVITY_MAX_PINNED_SESSIONS` |
| `antigravityCleanupIntervalMs` | `60000` (1m) | `ANTIGRAVITY_CLEANUP_INTERVAL_MS` |
| `antigravityHeartbeatIntervalMs` | `5000` (5s) | `ANTIGRAVITY_HEARTBEAT_INTERVAL_MS` |
| `antigravityStallTimeoutMs` | `300000` (5m) | `ANTIGRAVITY_STALL_TIMEOUT_MS` |
| `antigravityMaxAttempts` | `2` | `ANTIGRAVITY_MAX_ATTEMPTS` |

## Capabilities

Reported via Internal API `/api/v1/capabilities`:

```json
{
  "antigravity": {
    "available": true,
    "backendMode": "subprocess",
    "supportsFollowUp": true,
    "supportsSteer": false,
    "supportsModelSwitch": true,
    "supportsThinkingLevel": false,
    "supportsPinning": true,
    "supportsReplayHistory": true,
    "supportsApprovals": false,
    "supportsHeartbeat": true
  }
}
```

## Available Models

Fetched live via `agy models`. Fallback list (from `agy` 1.0.6):
- `Gemini 3.5 Flash (Medium)`
- `Gemini 3.5 Flash (High)`
- `Gemini 3.5 Flash (Low)`
- `Gemini 3.1 Pro (Low)`
- `Gemini 3.1 Pro (High)`

## Frontend

The `NewSessionModal` shows an Antigravity button (violet theme) when `antigravity_available: true` is received from the server. Availability is broadcast on WebSocket connect.

`sdkType: 'antigravity'` flows through `createNewSession()` → `WebSocketConnectionManager.handleNewSession()` → `AntigravityService.createSession()`.

## Live Validation

The disposable validation server intentionally disables Antigravity because
`agy` has no supported conversation-data directory override. Do not include it
in the normal `--runtime all` disposable matrix. Run an Antigravity scenario
only against an explicitly authorised target and record that it may touch the
real `~/.gemini` state:

```bash
npm run validate:live -- --allow-production \
  --runtime antigravity --scenario smoke
npm run validate:live -- --allow-production \
  --runtime antigravity --scenario follow-up
npm run validate:live -- --allow-production \
  --runtime antigravity --scenario session-info
```

When using a separately isolated Antigravity-capable server, pass its printed
`--socket` and `--token-path` instead of `--allow-production`. The generic
scenarios work because the runtime reports capabilities correctly and emits
standard normalized events, but the subprocess/credential boundary is not
made disposable by the runner.

## Observability

Because `agy -p` is a batch subprocess with no native streaming, the server adds its own observability so an in-flight turn is never a silent black box:

- **Liveness heartbeat** (`supportsHeartbeat: true`): while the subprocess runs, the service emits a synthetic `stream_activity` event every `antigravityHeartbeatIntervalMs` (default 5s) carrying `{ turnId, elapsedMs }`. It flows through `/events` and the WebSocket exactly like the Claude channel heartbeat, keeps the UI heartbeat fresh during multi-minute turns, is **live-only** (never persisted), and is always cleared when the turn ends.
- **Structured lifecycle logging**: each turn logs through a per-turn child logger bound with `sessionId` / `turnId` / `runtime=antigravity`, so lines are correlatable and land in the `/diagnostics` ring buffer. Emitted: `turn start` (model, conversationId, promptChars), `turn done in <ms>` (responseChars) or `turn failed in <ms>` (reason), a `warn` when the model id is normalized for agy, and a `warn` when agy is detected to have silently downgraded the model.
- **Per-turn timing**: finalized turns persist `turnDurationMs` (wall-clock subprocess time) in the JSONL store.
- **Silent-downgrade detection**: `extractAgyModelDowngrade()` parses the per-run agy log for the "not recognized → propagating override" pattern and surfaces it as a warning, so a fallback to a different model is observable even though the `antigravity/` prefix case is already prevented at the `--model` boundary.
- **Stall watchdog + bounded retry**: root-caused 2026-07-01 by inspecting agy's own internal conversation databases across a stalled production session and a stress-test comparing bare `agy -p` against the Internal API path across all three Flash effort tiers — a turn can go completely silent (no backend calls at all) because agy sometimes loses track of its own workspace root: it calls `list_permissions` looking for it, falls back to poking around its internal `~/.gemini/antigravity-cli/scratch` directory, and when that's empty, runs an unscoped `find / -name "*bike*" ...`-style full-filesystem scan while it "waits for the search to complete" — a local shell command our wrapper can't see progress on (no tool visibility, see below), not a live backend call. This reproduced identically via bare `agy -p` and via the Internal API, and was not clearly tied to one reasoning effort tier, so it's an upstream agy behavior, not something specific to this integration. Since `--log-file` is written incrementally throughout a real turn (unlike stdout, which is only flushed once at the end), `runAgy()` polls its mtime: if it stops advancing for `antigravityStallTimeoutMs` (default 5m — chosen from observed data to sit above a recovered 234s inactivity gap and below a fatal 345s+ one), the subprocess is killed with reason `stall` instead of waiting out the full `antigravityPromptTimeoutMs` (10m). A stall or hard timeout is retried up to `antigravityMaxAttempts` (default 2 total) times; a plain non-zero exit is not retried. Each retry reuses whatever conversation state agy already resolved (a first turn stays fresh unless agy already registered one; a follow-up turn keeps resuming the same conversation) — no special "fresh conversation" logic needed since the anchor-based reply extraction already ignores non-done turns.

## Known Limitations

- **No native streaming**: `agy -p` returns batch output. The entire response is emitted as a single `message_update` after the subprocess completes — but a synthetic `stream_activity` heartbeat (see [Observability](#observability)) provides liveness during the turn.
- **No tool visibility**: agy tool calls are not surfaced as individual events. This is also why a stalled turn's *cause* (e.g. a runaway `find /`) can't be shown directly to the user — only its *symptom* (log-file inactivity) is observable, which is what the stall watchdog above acts on.
- **No approvals**: agy runs with `--dangerously-skip-permissions`.
- **Resumed output accumulation**: if `rawStdoutLength` is missing or corrupted in the JSONL turn log, `priorReplyAnchor()` falls back to summing done turns' response lengths (imprecise but non-zero). If a turn's *replay* of a prior reply also isn't byte-stable (see the output-extraction quirk above), `extractNewReply()`'s anchor search corrects for a bounded drift (±400 chars) using the prior turn's actual response text; a drift larger than that, or a prior response too short to anchor on (< 6 chars), still falls back to the raw offset and can start mid-sentence.
- **Conversation DB ambiguity**: `agy` may create transient `.db` files during a first turn. Pi Web UI should trust the per-run log's `Print mode: conversation=...` line before falling back to filesystem detection.

## Authentication

`agy` uses the local user's Antigravity Google OAuth credentials from `~/.gemini/antigravity-cli/`. No API key required — the server runs as the same OS user that logged in with `agy`.

## Troubleshooting

Start with [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) and:

```bash
npm run debug:where -- <session-id-or-runtime-session-id-or-path>

# Check binary
agy --version

# Check auth
agy -p "Reply OK"

# Check live availability
TOKEN=$(cat ~/.pi-web-ui/internal-api-token)
curl -s --unix-socket ~/.pi-web-ui/internal-api.sock \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost/api/v1/capabilities | python3 -m json.tool

# Check session logs
journalctl -u pi-web-ui -f | grep -i antigravity
```

Related docs:
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`CODEBASE-MAP.md`](./CODEBASE-MAP.md)
