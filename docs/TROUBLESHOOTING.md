# Pi Web UI Troubleshooting and Runtime Logs

> Start here when an agent needs logs, session-file locations, health commands, or the fastest path to a runtime-specific diagnosis.

## Fastest Starting Points

Follow this order unless you already know the exact failing subsystem:

1. **Find the session entry quickly**
   ```bash
   npm run debug:where -- <session-id-or-runtime-session-id-or-path>
   ```
   This reads `~/.pi-web-ui/session-registry.json` and prints the most relevant files and log commands for that session.

2. **Inspect the unified registry directly**
   ```bash
   jq '.' ~/.pi-web-ui/session-registry.json
   ```

3. **Tail the main server log**
   ```bash
   sudo journalctl -u pi-web-ui -f
   ```

4. **Check runtime health**
   ```bash
   curl http://localhost:<server-port>/api/health/ready
   curl http://localhost:<server-port>/api/config/validate
   ```

## Session Files and Log Sources

| Runtime / subsystem | Primary session / state files | Main logs | Notes |
|---|---|---|---|
| **Pi Coding Agent** | `~/.pi/agent/sessions/` | `journalctl -u pi-web-ui -f` | Worker processes are spawned by Pi Web UI. |
| **Claude runtime (Pi-owned replay store)** | `~/.pi-web-ui/claude-sessions/<internal-session-id>.jsonl` | `journalctl -u pi-web-ui -f` | Used for replay and Web UI history regardless of Claude backend mode. |
| **Claude native session state** | `~/.claude/projects/-<encoded-cwd>/<claudeSessionId>.jsonl` | `journalctl -u pi-web-ui -f` | Used by Claude Code itself for resume/follow-up state. |
| **Claude channel hook config** | `~/.claude/settings.json` | `journalctl -u pi-web-ui -f \| grep ClaudeChannel` | Relevant only when channel-backed Claude mode is enabled. |
| **OpenCode** | Registry metadata in `~/.pi-web-ui/session-registry.json`; transcript storage is OpenCode-owned | `journalctl -u opencode-serve -f` if separate service, otherwise the main service log | Pi Web UI does not own the full OpenCode transcript. |
| **Antigravity (agy)** | `~/.pi-web-ui/antigravity-sessions/<session-id>.jsonl` (Pi-owned JSONL turn log) plus per-turn logs under `~/.pi-web-ui/antigravity-sessions/agy-logs/` | `journalctl -u pi-web-ui -f \| grep -i antigravity` | Each turn is one JSON line: prompt, response, model, conversationId, rawStdoutLength. The per-turn agy log records the actual `Print mode: conversation=<uuid>` target. |
| **Antigravity conversation state** | `~/.gemini/antigravity-cli/conversations/<uuid>.db` (SQLite, agy-owned) | `agy --version`, `agy models` | The conversation UUID in the JSONL must match a `.db` file here for continuity to work. |
| **Unified registry** | `~/.pi-web-ui/session-registry.json` | `journalctl -u pi-web-ui -f` | Cross-runtime source of truth for sidebar metadata. |
| **Internal API** | `~/.pi-web-ui/internal-api.sock`, `~/.pi-web-ui/internal-api-token` | `journalctl -u pi-web-ui -f` | Useful when debugging local consumers of the backend API. |

## General Commands

### Systemd / process control

```bash
sudo systemctl status pi-web-ui
sudo systemctl restart pi-web-ui
sudo journalctl -u pi-web-ui -f
```

If OpenCode runs as its own service:

```bash
sudo systemctl status opencode-serve
sudo journalctl -u opencode-serve -f
```

Do not configure `pi-web-ui.service` with `Wants=opencode-serve.service` or `After=opencode-serve.service` unless Pi Web UI is explicitly changed to attach-only mode. Pi Web UI normally manages `opencode serve` itself. A separate `opencode-serve.service` on the same port can restart-loop with `ServeError: Failed to start server. Is port 4097 in use?` and may fill `/tmp` with OpenCode/Bun `.fb*.so` files.

Quick check for this failure mode:

```bash
systemctl show opencode-serve.service -p LoadState -p ActiveState -p UnitFileState -p NRestarts
systemctl show pi-web-ui.service -p Wants -p After
find /tmp -maxdepth 1 -name '.fb*.so' | wc -l
```

### Runtime health endpoints

```bash
curl http://localhost:<server-port>/api/health/live
curl http://localhost:<server-port>/api/health/ready
curl http://localhost:<server-port>/api/config/validate
```

### Session registry inspection

```bash
jq '.' ~/.pi-web-ui/session-registry.json
```

## Internal API orchestration debugging

Use this section when you are driving Pi Web UI programmatically over the Unix
socket rather than through the browser.

### Check the socket and token first

```bash
ls -l ~/.pi-web-ui/internal-api.sock
ls -l ~/.pi-web-ui/internal-api-token
TOKEN=$(cat ~/.pi-web-ui/internal-api-token)
```

### Check runtime capabilities before dispatch

```bash
curl -s --unix-socket ~/.pi-web-ui/internal-api.sock \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost/api/v1/capabilities | python3 -m json.tool
```

### Recommended orchestration-debug flow

1. `GET /api/v1/capabilities` — confirm runtime availability and feature flags
2. `POST /api/v1/sessions` or `/sessions/batch` — create child sessions
3. `POST /api/v1/sessions/:id/prompt` — dispatch work
4. `GET /api/v1/sessions/:id/events` — monitor progress when the runtime supports stable SSE monitoring
5. `GET /api/v1/sessions/:id/wait` — wait for completion without polling loops in your own code
6. `GET /api/v1/sessions/:id/transcript` — extract child results in a runtime-agnostic form
7. `POST /api/v1/sessions/:id/transfer` — hand child context back into another session

### Important Claude caveat

For **Claude channel-backed sessions**, `GET /api/v1/sessions/:id/events` can
be less reliable for parallel fan-out monitoring than it is for Pi, OpenCode,
and Antigravity. In practice this means:
- do not assume multiple Claude child sessions can all be watched over `/events` with the same reliability as OpenCode
- prefer `GET /sessions/:id/wait` + `GET /sessions/:id/transcript` as the safe fallback for Claude orchestration
- use `GET /sessions/:id/info` and `GET /sessions/:id/history` when you need additional diagnosis

### ID confusion to watch for

When correlating failures, distinguish between:
- **Internal session id** — Pi Web UI's `sessionId`
- **Runtime-native id** — e.g. Claude native session id or OpenCode `opencodeSessionId`
- **Registry path/file references** — stored in `~/.pi-web-ui/session-registry.json`

`npm run debug:where -- <id>` understands some, but not all, native ids. For
OpenCode-native session ids you may need to inspect the runtime's own logs and
Pi registry metadata separately.

See also:
- [`INTERNAL-API.md`](./INTERNAL-API.md)
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)

## Pi Coding Agent Path

### Check first

- `server/src/pi/multi-session-manager.ts`
- `server/src/pi/pi-service.ts`
- `server/src/workers/worker-pool.ts`
- `server/src/workers/session-worker.ts`

### Useful commands

```bash
ps aux | grep "pi --mode rpc"
curl http://localhost:<server-port>/api/health/ready | jq '.workerStats'
curl http://localhost:<server-port>/api/health/workers
```

### Typical symptoms

- **Session stuck streaming** → inspect stale-stream reset logic in `multi-session-manager.ts`
- **Worker crash / dispose errors** → inspect `session-worker.ts` and crash logging
- **Pinned session confusion** → check pin state plus stale-stream behaviour; pinning prevents cleanup, not status reset

## Claude Runtime

Claude sessions use the unified `sdkType='claude'` in the UI and registry, but the backend can run in three different modes:

1. **SDK backend** — `@anthropic-ai/claude-agent-sdk` query() with profile-resolved env (preferred when profiles are enabled)
2. **Legacy direct mode** — `claude -p` subprocesses (profile-aware or plain)
3. **Channel-backed mode** — Claude Code launched with the development channel plugin and PTY supervision

Read [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md) for architecture details and [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md) for profile setup and failure modes.

### Check first

**For SDK/profile sessions:**
- `server/src/claude/claude-sdk-service.ts`
- `server/src/claude/claude-profiles.ts`
- `server/src/claude/claude-sdk-event-adapter.ts`

**For legacy direct sessions:**
- `server/src/claude/claude-service.ts`
- `server/src/claude/claude-process-pool.ts`
- `server/src/claude/claude-history-replay.ts`

**For channel-backed sessions:**
- `server/src/claude/claude-channel-service.ts`
- `server/src/claude/claude-channel-process-manager.ts`
- `pi-claude-channel/server.ts`

### Useful commands

```bash
which claude
claude auth status --json
sudo journalctl -u pi-web-ui -f
sudo journalctl -u pi-web-ui -f | grep ClaudeChannel
sudo journalctl -u pi-web-ui -f | grep -i "profile\|ClaudeSdk"

# Live validation via the Internal API (no browser required)
npm run validate:live -- --runtime claude --scenario smoke
npm run validate:live -- --runtime claude --scenario channel-heartbeat

# Profile-specific validation (requires a disposable validation server)
npm run validate:claude-profiles -- --list
```

### Session files to correlate

- Pi-owned replay file: `~/.pi-web-ui/claude-sessions/<internal-session-id>.jsonl`
- Claude native session file: `~/.claude/projects/-<encoded-cwd>/<claudeSessionId>.jsonl`
- Channel hook config: `~/.claude/settings.json`
- Profile config: `~/.pi-web-ui/claude-profiles.json` (or path set by `CLAUDE_PROFILES_PATH`)

### Typical symptoms

- **Profile not appearing in model picker** → confirm `CLAUDE_PROFILES_ENABLED=true`, check startup logs for Zod errors, confirm profile `enabled: true`
- **Session creation fails with a profile** → check `authTokenEnv` is set in the environment; if using `authTokenPath`, verify absolute, non-symlink, readable
- **Wrong model identity at runtime** → check `modelAliases` env var names; run `sdk-model-identity` scenario via `validate:claude-profiles`
- **Session lock / resume trouble** → inspect native Claude JSONL and `claude-process-pool.ts` (legacy direct only)
- **Tools stuck as running** → inspect replay JSONL and history reconstruction
- **Channel session appears idle too early or too late** → inspect PTY busy-state / idle detection in `claude-channel-process-manager.ts`
- **Auth expired** → `claude auth status --json`, then inspect channel auth-expiry handling or legacy subprocess error propagation
- **Live validation cannot connect** → check `~/.pi-web-ui/internal-api.sock`, `~/.pi-web-ui/internal-api-token`, and `docs/INTERNAL-API.md`

## OpenCode

### Check first

- `server/src/opencode/opencode-service.ts`
- `server/src/opencode/opencode-process-manager.ts`
- `server/src/opencode/opencode-client.ts`
- `server/src/opencode/opencode-event-adapter.ts`

### Useful commands

```bash
which opencode
curl http://localhost:<server-port>/api/health/ready | jq '.checks.opencode'
curl "http://localhost:<server-port>/api/models?sdkType=opencode"
```

### Typical symptoms

- **OpenCode unavailable** → verify service health and host/port alignment
- **Duplicate tool cards** → inspect `opencode-event-adapter.ts` deduplication
- **Context window shows 0** → inspect model metadata caching and startup timing
- **Permissions auto-approve unexpectedly during transfer** → inspect transfer dispatch special cases

## Antigravity (agy)

### Check first

- `server/src/antigravity/antigravity-service.ts`
- `server/src/antigravity/antigravity-session-store.ts`
- `server/src/antigravity/antigravity-history-replay.ts`

### Session files

```bash
# Pi-owned turn log (JSONL: one JSON object per line)
ls -la ~/.pi-web-ui/antigravity-sessions/
sed -n '1,5p' ~/.pi-web-ui/antigravity-sessions/<session-id>.jsonl
jq -c '.' ~/.pi-web-ui/antigravity-sessions/<session-id>.jsonl

# agy-owned conversation SQLite DBs (one per agy conversation UUID)
ls -la ~/.gemini/antigravity-cli/conversations/

# Pi-owned per-turn agy logs (best for conversation-id diagnosis)
ls -lt ~/.pi-web-ui/antigravity-sessions/agy-logs/ | head

# agy CLI logs
ls -lt ~/.gemini/antigravity-cli/log/cli-*.log | head
tail -n 50 $(ls -t ~/.gemini/antigravity-cli/log/cli-*.log | head -1)
```

### Useful commands

```bash
# Check agy binary and auth
agy --version
agy models
agy -p "Reply OK"

# Check runtime availability via Internal API
TOKEN=$(cat ~/.pi-web-ui/internal-api-token)
curl -s --unix-socket ~/.pi-web-ui/internal-api.sock \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost/api/v1/capabilities | python3 -m json.tool

# Check models list
curl "http://localhost:<server-port>/api/models?sdkType=antigravity"
```

### Typical symptoms

- **agy not available** → `agy --version` fails; check `AGY_BINARY` env var (default: `/root/.local/bin/agy`)
- **Reply starts mid-sentence** → `rawStdoutLength` missing or wrong in the session JSONL; this tracks the trimmed cumulative stdout length the next resumed `agy` call should slice from. Fix: inspect the JSONL, confirm `rawStdoutLength` is present and growing each turn.
- **Model forgets earlier turns** → conversation ID mismatch; confirm all JSONL entries share the same `conversationId`, that UUID exists in `~/.gemini/antigravity-cli/conversations/`, and that the first turn's per-run log contains the same `Print mode: conversation=<uuid>, sending message` line. If the log shows a different UUID than the JSONL, the session was bound to the wrong agy conversation.
- **Conversation ID is null after first turn** → the per-run log did not contain a sent-conversation line and the `.db` fallback failed to detect the new file; check the conversations directory for a file newer than the turn's timestamp.
- **agy hangs / timeout** → inspect `--print-timeout` setting (default 10m); check the latest agy log file in `~/.gemini/antigravity-cli/log/`
- **Auth expired** → `agy -p "Reply OK"` will prompt to re-login; complete auth via `agy` interactively

## WebSocket / Frontend State

### Check first

- `server/src/websocket/connection.ts`
- `server/src/websocket/session-websocket.ts`
- `client/src/store/sessionStore.ts`
- `client/src/hooks/useWebSocket.ts`

### Useful checks

- Browser DevTools → Network → WS
- `session_info` modal in the UI for cwd, session file, model, and context usage
- `stream_activity` events for long-running Claude channel turns

## Auth / CSRF / Cookies

### Check first

- `server/src/security/auth.ts`
- `server/src/security/csrf.ts`
- `server/src/middleware/auth.ts`

### Typical symptom

- **Everything breaks after a server restart** → clients may need a refresh because CSRF tokens are memory-backed

## Drive Mode

Drive Mode is a shipped frontend feature, not just a historical plan. For the feature overview and key files, read [`DRIVE-MODE.md`](./DRIVE-MODE.md).

## Known skipped tests

- `server/tests/integration/claude/dual-path-coexistence.test.ts` >
  `should use channel path when channel is healthy` — **skipped**. This
  end-to-end test drives a real prompt through a real
  `ClaudeChannelWsClient` ↔ `MockClaudeChannelServer` WebSocket round-trip
  under real timers; in some sandboxes the WS handshake / prompt→`agent_end`
  completion flow does not settle within the test timeout (the
  `agent_end`→`onComplete` wiring itself is correct). It is an
  environment/timing-dependent integration test, not a product regression.
  Re-enable when the channel WS round-trip can be made deterministic (fake
  timers on the WS layer, or a `wsClient` seam the test can drive directly).
  The other two cases in the same file (channel-unhealthy fallback,
  dual-session creation) still run.

## Known pre-existing client test failures (separate from observability work)

The **client** Vitest suite has a number of pre-existing failures at `HEAD`
(verified on a clean tree, independent of the observability/logging work, which
is server-scoped). They are multi-causal and outside the scope of the
observability plan:

- `tests/unit/lib/jsonrpc-client.test.ts` — WebSocket reconnect/promise-timing
  (`PromiseRejectionHandledWarning`, "promise resolved instead of rejecting").
- `tests/unit/components/Sidebar/SessionItem.test.tsx` — jsdom context-menu /
  right-click handling.
- `tests/unit/hooks/useSessionStream.test.ts` — hook async/timing.

These do **not** reflect a regression from the observability work (the only
client-side change in that work is `client/vitest.config.ts`'s `onConsoleLog`
suppression, which is not the cause — the failures reproduce with it reverted).
The **server** suite is the observability plan's test-hygiene surface and is
green. Fixing the client suite is tracked as a separate effort.

## Test output noise (`[Tag]` log lines)

## Test output noise (`[Tag]` log lines)

Server and client tests suppress application `console.*` output by default so
that a failing test shows the assertion diff, not hundreds of `[Tag]` log lines
from the runtime (e.g. `[MultiSessionManager]`, `[ClaudeService]`). The
pass/fail count is never affected — only console output is filtered.

Restore full app logging when you need it:

```bash
VITEST_LOG=1 npx vitest run path/to/file.test.ts --root server
```

This works in `server`, `client`, and `shared`. Genuine test-framework output
(assertion diffs, thrown errors, the reporter summary) is never suppressed.

## Related Docs

- [`README.md`](../README.md)
- [`DEPLOYMENT.md`](../DEPLOYMENT.md)
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`SHARP-EDGES.md`](./SHARP-EDGES.md)
- [`CODEBASE-MAP.md`](./CODEBASE-MAP.md)
