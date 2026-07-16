# Pi Web UI Troubleshooting and Runtime Logs

> Start here when an agent needs logs, session-file locations, health commands, or the fastest path to a runtime-specific diagnosis.

## Fastest Starting Points

Follow this order unless you already know the exact failing subsystem:

### Fastest API-first debugging for agents

When you have Internal API access, start here before reaching for browser automation or host logs:

1. `GET /api/v1/diagnostics` — recent secret-scrubbed server logs
2. `GET /api/v1/sessions/:id/diagnostics` — same, scoped to one session
3. `GET /api/v1/sessions/:id/transcript?view=screen` — read-only "what the user sees" projection
4. `GET /api/v1/sessions/:id/history` — lower-level replay/debug detail only if needed

This is often the most token-efficient route for LLM agents because it avoids driving the UI and avoids rediscovering log locations first.

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
| **Notification layer** | `~/.pi-web-ui/notifications/` | `journalctl -u pi-web-ui -f`, `GET /api/v1/notifications` | Contains opt-ins, durable outbox/status ledger, and `ingress/` terminal-client spool. |
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
npm run internal-api:wait
```

A missing socket for a few seconds during restart is normal. The readiness helper
waits for the expected API identity. If the enabled server remains up without an
Internal API, treat startup as failed and inspect the journal for socket ownership,
permission, or binding errors.

### Check runtime capabilities before dispatch

```bash
curl -s --unix-socket ~/.pi-web-ui/internal-api.sock \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost/api/v1/capabilities | python3 -m json.tool
```

### Recommended orchestration-debug flow

1. `GET /api/v1/capabilities` — confirm runtime availability and feature flags
2. `GET /api/v1/diagnostics` — fast sanity check before deeper digging
3. `POST /api/v1/sessions` or `/sessions/batch` — create child sessions
4. `POST /api/v1/sessions/:id/prompt` — dispatch work
5. `GET /api/v1/sessions/:id/events` — monitor progress when the runtime supports stable SSE monitoring
6. `GET /api/v1/sessions/:id/wait` — wait for completion without polling loops in your own code
7. `GET /api/v1/sessions/:id/transcript` — extract child results in a runtime-agnostic form
8. `GET /api/v1/sessions/:id/transcript?view=screen` — fetch the UI-faithful view when you need operator-visible state
9. `POST /api/v1/sessions/:id/transfer` — hand child context back into another session

### Which read path should you use?

- `GET /api/v1/sessions/:id/transcript` — best default for runtime-agnostic result reading
- `GET /api/v1/sessions/:id/transcript?view=screen` — best when you need what the user sees by default
- `GET /api/v1/sessions/:id/history` — best for replay/debug reconstruction
- `GET /api/v1/sessions/:id/diagnostics` — best for correlated backend/log context

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

## Notification layer

### Useful checks

```bash
ls -la ~/.pi-web-ui/notifications
TOKEN=$(cat ~/.pi-web-ui/internal-api-token)
curl -s --unix-socket ~/.pi-web-ui/internal-api.sock \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost/api/v1/notifications | python3 -m json.tool
```

### Typical symptoms

- **Bell toggle missing or always off in browser** → check `server/src/routes/notifications-web.ts`, cookie auth, and whether the session row has valid `runtime` + `sessionPath`.
- **Opt-in recorded but no Telegram message arrives** → verify `NOTIFICATIONS_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and inspect delivery status/`lastError` via `GET /api/v1/notifications`.
- **Telegram message arrives but deep link is wrong** → verify `NOTIFICATIONS_PUBLIC_BASE_URL` matches the actual browser URL operators open.
- **Pending deliveries never clear after restart** → inspect `~/.pi-web-ui/notifications/` plus startup logs to confirm outbox rehydration and channel configuration.
- **`scripts/notify.sh` says `queued locally`** → the API did not become ready within its bounded wait; inspect `~/.pi-web-ui/notifications/ingress/` (directory `0700`, records `0600`) and wait for the next startup/periodic drain.
- **Explicit emit accepted but Telegram is absent** → `202` means durably queued, not delivered. Poll the response `statusUrl`/`Location`; check `lastError` and `NOTIFICATIONS_CHANNEL_TIMEOUT_MS`.
- **Two deploys/restarts overlap** → run the complete authorized operation under `npm run production:lock -- <command> [args...]`; lock contention exits `75` rather than interleaving.

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
- **Compaction fails on Codex models** (`Summarization failed: … Model not found …`) or **`npm install` fails in postinstall** → the embedded Pi SDK's compaction session-ID patch; full runbook in [`PI-CODEX-COMPACTION-SESSION-ID.md`](./PI-CODEX-COMPACTION-SESSION-ID.md). Quick check: `/autocompact75` in a Pi session should report `SDK integrity: OK`

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

None. Both the server and client Vitest suites are green with **zero** skipped
tests in the baseline.

The previously-skipped `dual-path-coexistence.test.ts` >
`should use channel path when channel is healthy` is now **enabled and
deterministic**. Its earlier flakiness was not a timer/sandbox issue: routing the
prompt through `ClaudeService` without a `channel` profile fell through to the
direct-CLI backend and spawned a **real `claude -p`** (real network → slow,
flaky, token cost). The test now drives the `ClaudeChannelService` directly with
the PTY/process-manager mocked, so the WS round-trip runs entirely against
`MockClaudeChannelServer` (runs in ~100ms, no real process).

## Client test suite

The **client** Vitest suite is green (0 failures). The earlier batch of
pre-existing client failures was multi-causal and has been resolved:

- `tests/unit/lib/jsonrpc-client.test.ts` — fixed the mock harness (the failing
  WebSocket mocks never suppressed the inherited auto-`open`; `runAllTimersAsync`
  fired the request-timeout before responses) **and** a real reconnection bug
  (`connect()` early-returned during reconnect because `attemptReconnect` pre-set
  state to `connecting`).
- `tests/unit/hooks/useSessionStream.test.ts` — the mock now answers the
  `initialize`/`prompt` JSON-RPC requests the hook awaits; also fixed two real
  hook bugs (the identity guard captured a render-time `''` instead of the active
  session, blocking every received event; and `handleTurnEnd` pushed a `null`
  message because the `setMessages` updater read `currentMessageRef.current` after
  it was nulled).
- `SessionItem` / `TransferConfirmationModal` — test mocks drifted from the
  components (missing `lucide-react` icons, `useWebSocket`/`getState`).
- `CollapsibleToolCard` / `VirtualizedMessageList` — assertions updated to match
  the intentional verbosity changes (cards auto-expand on completion; common
  tools are now shown as cards).

## Fast test loop for agents

Don't run the whole suite on every edit. Target a single file or test, and use
the machine-readable outputs to jump straight to failures. Commands below use the
`server` workspace; swap to `client`/`shared` as needed.

```bash
# One file (fastest iteration):
npx vitest run tests/unit/internal-api/error-codes.test.ts --root server
# One test by name (substring match across file path + test name):
npx vitest run -t "correlation id" --root server
# Restore full app logging while debugging a test:
VITEST_LOG=1 npx vitest run tests/unit/pi/multi-session-manager.test.ts --root server
# Per-test timing (per-file timing is already in the default summary):
npx vitest run tests/unit/claude/ --root server --reporter=verbose
```

- **Per-file timing** — the default reporter summary already prints
  `✓ tests/.../foo.test.ts (N tests) Xms` per file, so you can see which file to
  target. Add `--reporter=verbose` for per-test timing.
- **Machine-readable results** — every run also writes a JSON report to
  `server/test-results.json` (and `client/test-results.json`), git-ignored. It
  has `numTotalTests`/`numPassedTests`/`numFailedTests` and a `testResults[]`
  array whose `assertionResults[]` carry per-test `status` + `fullName` +
  `failureMessages`. Parse it to jump straight to the failing test.
- **Run the full suite** the proper way (fixtures resolve correctly):
  `npm run test --workspace=server` (cwd is the workspace). Run `npm test`
  (server + client) only at task completion / before commit.

## Real-timer waits in tests

Most `setTimeout` waits in the server suite are either **event-loop yields**
(`await new Promise(r => setTimeout(r, 0))`, ~free) or **real async-I/O settle
waits** that cannot be replaced by fake timers without breaking the test:

- `tests/integration/claude/channel-prompt-flow.test.ts`,
  `channel-permission-flow.test.ts`, `dual-path-coexistence.test.ts` — wait for
  a **real WebSocket** round-trip with a mock channel server (network I/O; fake
  timers cannot drive it). `dual-path-coexistence`'s channel-healthy case waits
  deterministically for the mock server to receive the prompt (via `vi.waitFor`)
  rather than sleeping.
- `tests/unit/opencode/opencode-service-goal.test.ts` (50/150ms) — wait for
  fire-and-forget `clearGoal`/`abort` **real fs + fetch** side-effects to settle.
  Inline `// Reason:` comments mark each.

Genuine internal-timing waits (polling/retry intervals that `vi.useFakeTimers` +
`vi.advanceTimersByTimeAsync` could drive) are preferred where they exist; the
`GET /sessions/:id/wait` timeout case in `session-routes-orchestration.test.ts`
already uses fake timers.

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
