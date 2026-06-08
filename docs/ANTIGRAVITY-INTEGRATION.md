# Antigravity Integration

Pi Web UI integrates Google's Antigravity agent (Gemini Flash 3.5 and others) as a fourth runtime path, alongside Pi SDK, Claude Direct, and OpenCode Direct.

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

**First turn**: snapshot `~/.gemini/antigravity-cli/conversations/*.db` before and after the `agy -p` call to detect the newly-created conversation UUID.

**Subsequent turns**: pass `--conversation <uuid>` to resume.

**Output extraction quirk**: resumed calls include prior assistant replies before the newest reply in stdout. `extractNewReply()` strips the accumulated prior output length (with 20-char whitespace tolerance) to isolate the new response.

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
| `antigravityEnabled` | `true` | — |
| `antigravitySessionDir` | `~/.pi-web-ui/antigravity-sessions` | `ANTIGRAVITY_SESSION_DIR` |
| `antigravityDefaultModel` | `'Gemini 3.5 Flash (Medium)'` | `ANTIGRAVITY_DEFAULT_MODEL` |
| `antigravityPromptTimeoutMs` | `600000` (10m) | — |
| `antigravityIdleTimeoutMs` | `1800000` (30m) | — |
| `antigravityMaxSessions` | `4` | — |
| `antigravityMaxPinnedSessions` | `2` | — |
| `antigravityCleanupIntervalMs` | `60000` (1m) | — |

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
    "supportsHeartbeat": false
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

```bash
npm run validate:live -- --runtime antigravity --scenario smoke
npm run validate:live -- --runtime antigravity --scenario follow-up
npm run validate:live -- --runtime antigravity --scenario session-info
```

All generic scenarios (`smoke`, `follow-up`, `session-info`) work unchanged because the runtime reports capabilities correctly and emits standard normalized events.

## Known Limitations

- **No streaming**: `agy -p` returns batch output. The entire response is emitted as a single `message_update` after the subprocess completes.
- **No tool visibility**: agy tool calls are not surfaced as individual events.
- **No approvals**: agy runs with `--dangerously-skip-permissions`.
- **Resumed output accumulation**: The output extraction heuristic (20-char tolerance) may occasionally include a few separator chars from prior turns. This is cosmetically minor.

## Authentication

`agy` uses the local user's Antigravity Google OAuth credentials from `~/.gemini/antigravity-cli/`. No API key required — the server runs as the same OS user that logged in with `agy`.

## Troubleshooting

```bash
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
