# Claude Runtime Backends

> Canonical reference for the Claude runtime family in Pi Web UI.
>
> Important: the UI and registry treat Claude sessions as one runtime family (`sdkType: 'claude'`), but the server can drive Claude through three backend implementations with different failure modes.
>
> For first-stop debugging, start with [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) and `npm run debug:where -- <session-id-or-runtime-session-id-or-path>`.

## Adopter quick take

Read this doc if Claude Code is one of your reasons for adopting Pi Web UI.

Recommended public framing:
- **Who this path is for:** people who specifically want Claude Code inside the same browser shell as other runtimes
- **Setup difficulty:** medium to high
- **Recommended starting mode:** start with the SDK/profile path, keep direct available as a fallback, and only enable the channel-backed path when you want the richer behaviour and accept the extra moving parts
- **Main caveat:** this runtime family is more wrapper-oriented and operationally sensitive than the Pi Coding Agent and OpenCode paths

## Why This Doc Exists

Recent work first introduced a **channel-backed Claude Code path** alongside the older **`claude -p` subprocess path**, and later added the **SDK/profile backend**. Agents were repeatedly losing time rediscovering:

- where Claude session files live
- which code path is active
- which logs belong to the channel plugin vs the main service
- how to diagnose stuck tools, auth expiry, PTY idle detection, and replay mismatches

This doc centralizes that.

## The Three Claude Backend Modes

### 1. SDK backend (preferred for profiles)

- **How it runs:** Claude Agent SDK `query()` → spawns Claude Code binary with profile-resolved env
- **Main modules:**
  - `server/src/claude/claude-sdk-service.ts`
  - `server/src/claude/claude-sdk-event-adapter.ts`
  - `server/src/claude/claude-profiles.ts`
- **Strengths:** `canUseTool` permission callbacks, AbortController cancellation, structured SDK messages, profile-based provider switching (native Claude subscription, GLM/Z.ai, etc.)
- **When to use:** when `CLAUDE_PROFILES_ENABLED=true` and the session's profile has `backend: 'sdk-subscription'`
- **Main limitations:** requires `@anthropic-ai/claude-agent-sdk` dependency

#### AskUserQuestion support (SDK backend only)

Claude Code's built-in `AskUserQuestion` tool is supported first-class through the **SDK backend**:

- **Flow:** Claude emits `AskUserQuestion` → SDK backend intercepts it via `canUseTool` → emits `ask_user_question_request` to the browser → the user answers in a structured dialog → the SDK backend resolves the callback with the answers → the turn continues.
- **UI:** `client/src/components/Extensions/AskUserQuestionDialog.tsx` renders 1–4 questions with single-select, multi-select, option descriptions, and preview-safe markdown.
- **Cancel/timeout:** if the request is not answered before the timeout, the session aborts, the turn ends, or all subscribers disconnect, the backend emits `ask_user_question_closed` (mapped to `extension_ui_cancel` for the browser) and resolves the callback as cancelled. This prevents zombie dialogs and silent drops of late answers.
- **Configuration:** `CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS` (default 30 minutes, positive integer) is the wall-clock safety net; `CLAUDE_ASK_USER_QUESTION_DISCONNECT_GRACE_MS` (default 120 seconds, positive integer) is the primary last-subscriber abandonment grace. A 5-minute default was the original cause of a production zombie-dialog bug; the current default is intentionally a long safety net.
- **Internal API:** `POST /api/v1/sessions/:id/approvals/:requestId/respond` accepts structured `answers` / `annotations` / `cancelled` for a pending `AskUserQuestion`; returns `409 ASK_ALREADY_CLOSED` if the request already resolved.
- **Not available on:** direct CLI (`claude -p`) or channel-backed backends in this release. Those backends do not wire the interactive callback.

### 2. Legacy direct mode

- **How it runs:** `claude -p`
- **Main modules:**
  - `server/src/claude/claude-service.ts`
  - `server/src/claude/claude-process-pool.ts`
  - `server/src/claude/claude-event-normalizer.ts`
  - `server/src/claude/claude-history-replay.ts`
  - `server/src/claude/claude-session-store.ts`
- **Strengths:** straightforward subprocess-per-turn model, now profile-aware
- **Main limitations:** no true mid-turn steer, subprocess lock edge cases, weaker interactivity
- **Profile support:** when a profile with `backend: 'cli-direct'` is selected, the pool uses the profile's resolved executable/env/model instead of hardcoded defaults

### 3. Channel-backed mode

- **How it runs:** Claude Code launched with the development channel plugin under PTY supervision
- **Main modules:**
  - `server/src/claude/claude-service.ts`
  - `server/src/claude/claude-channel-service.ts`
  - `server/src/claude/claude-channel-process-manager.ts`
  - `server/src/claude/claude-channel-hooks-config.ts`
  - `server/src/claude/claude-channel-ws-client.ts`
  - `server/src/claude/claude-channel-event-adapter.ts`
  - `pi-claude-channel/server.ts`
- **Strengths:** better tool visibility, PTY-driven long-turn awareness, richer live event bridge
- **Main risks:** PTY busy/idle heuristics, channel auth expiry, hook config drift, plugin/runtime coordination

## Runtime State and Persistence

### Pi-owned replay store

All three Claude backend modes still use Pi Web UI's own replay file:

```text
~/.pi-web-ui/claude-sessions/<internal-session-id>.jsonl
```

This is what the Web UI uses for session history reconstruction and the session info modal.

### Native Claude session state

Claude Code itself also keeps native session files:

```text
~/.claude/projects/-<encoded-cwd>/<claudeSessionId>.jsonl
```

These matter for:

- follow-up / resume behaviour
- lock cleanup after aborts or crashes
- channel-backed context usage discovery

### Unified registry

Cross-runtime metadata lives in:

```text
~/.pi-web-ui/session-registry.json
```

For Claude sessions, the registry typically carries:

- internal Pi Web UI session id
- `sdkType: 'claude'`
- Pi-owned replay file path
- Claude native `claudeSessionId`
- cwd
- model / thinking level hints

## Channel-backed Architecture

### High-level flow

```text
Browser
  -> /ws
    -> connection.ts
      -> ClaudeService
        -> ClaudeChannelService
          -> ClaudeChannelProcessManager (node-pty)
            -> claude --dangerously-load-development-channels ...
              -> pi-claude-channel/server.ts
                -> channel WS + hook bridge
```

### Supporting files

- `pi-claude-channel/server.ts` — the plugin/tool server that relays replies, permissions, usage, and generic events
- `server/src/claude/claude-channel-hooks-config.ts` — writes managed HTTP hooks into `~/.claude/settings.json`
- `server/src/claude/claude-channel-ws-client.ts` — receives plugin-emitted events back into Pi Web UI
- `server/src/claude/claude-channel-event-adapter.ts` — converts channel events into the shared normalized event model

### Important environment variables

Defined in `.env.example` and parsed in `server/src/config.ts`:

**Backend selection:**
- `CLAUDE_BACKEND_DEFAULT` — `sdk` | `direct` | `channel` (default: `direct`)
- `CLAUDE_PROFILES_ENABLED` — enable the profile system (default: `false`)
- `CLAUDE_SDK_ENABLED` — enable the SDK backend (default: `true` when profiles enabled)
- `CLAUDE_DIRECT_PROFILES_ENABLED` — enable direct CLI profile support (default: `true`)
- `CLAUDE_DEFAULT_PROFILE` — default profile ID for new Claude sessions
- `CLAUDE_PROFILES_PATH` — path to `claude-profiles.json` (default: `~/.pi-web-ui/claude-profiles.json`)

**Channel-backed:**
- `CLAUDE_CHANNEL_ENABLED`
- `CLAUDE_CHANNEL_PLUGIN_DIR`
- `CLAUDE_CHANNEL_WS_PORT`
- `CLAUDE_CHANNEL_HOOK_PORT`

**Rollback:** to revert to legacy direct mode:
```env
CLAUDE_PROFILES_ENABLED=false
CLAUDE_SDK_ENABLED=false
CLAUDE_BACKEND_DEFAULT=direct
```

See [`../DEPLOYMENT.md`](../DEPLOYMENT.md) for operational guidance.

## Provider Profiles

When `CLAUDE_PROFILES_ENABLED=true`, Claude sessions can run through explicit
provider profiles defined in `~/.pi-web-ui/claude-profiles.json`. Each profile
specifies a backend (`sdk-subscription`, `cli-direct`, or `channel`), a launcher
type (`native-env` or `command`), a model, and optional provider settings
(base URL, auth token, model aliases, skills, tools).

**Key safety rules:**
- `ANTHROPIC_API_KEY` is **always stripped** from the subprocess env (no pay-per-use)
- Auth tokens are sourced from env vars (`authTokenEnv`) or validated secret files (`authTokenPath`) — never stored in the profile file itself
- Token values are never logged, exposed through APIs, or written to artifacts
- `authTokenPath` must be absolute, non-symlink, and readable

**Profile-backed model entries** appear in `/api/v1/models` as `profile:<id>` and in
the web UI model selector. Selecting one creates a session bound to that profile.

**GLM/Z.ai profile example** (uses GLM Coding Plan subscription token):
```json
{
  "id": "glm52-claude-sdk",
  "label": "GLM 5.2 — Claude SDK",
  "backend": "sdk-subscription",
  "launcherType": "native-env",
  "baseUrl": "https://api.z.ai/api/anthropic",
  "authTokenEnv": "GLM_CODING_PLAN_TOKEN",
  "model": "sonnet",
  "modelAliases": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2[1m]"
  },
  "skills": "all",
  "permissionMode": "dontAsk"
}
```

## Logs and Quick Checks

### Main logs

```bash
sudo journalctl -u pi-web-ui -f
sudo journalctl -u pi-web-ui -f | grep ClaudeChannel
claude auth status --json
```

Channel event/activity debug lines are opt-in with `CLAUDE_CHANNEL_DEBUG=1`.
Even in debug mode the channel bridge must not log prompts, tool payloads,
tokens, cookies, or credentials; lifecycle/failure lines remain visible without
that flag. For replay-cost/volume measurements use the repository's bounded
`pi-claude-channel/measure-replay.ts` helper rather than enabling unrestricted
payload logging.

### Session file locations

- Pi-owned replay file: `~/.pi-web-ui/claude-sessions/<internal-session-id>.jsonl`
- Native Claude session file: `~/.claude/projects/-<encoded-cwd>/<claudeSessionId>.jsonl`
- Hook config: `~/.claude/settings.json`

### Fast session lookup

```bash
npm run debug:where -- <session-id-or-claudeSessionId-or-path>
```

## Auth expiry (all backends)

Auth-expiry detection and the user-facing "re-authenticate" message are
**shared across all three backends** via `server/src/claude/claude-auth-errors.ts`.
It used to live only in the channel path (PTY scraping); now the SDK and
direct-CLI paths detect it too, so the primary backends get the same affordance.

- **Detection:** `isClaudeAuthError()` matches real provider 401 / auth-error
  output (e.g. `API Error: 401 ... authentication_error`, `Invalid authentication
  credentials`, `Please run /login`).
- **Surfacing:** the failing backend emits an `error` event with
  `code: 'CLAUDE_AUTH_EXPIRED'` + `reauthRequired: true` plus a closing
  `agent_end`. `connection.ts` recognises the code and does not double-surface it.
- **Profile-aware remediation:** `buildReauthMessage()` tailors the text —
  native subscription → run `claude auth login`; a provider profile (e.g.
  GLM/Z.ai) → refresh that profile's auth token (it names the `authTokenEnv`).
- **Replay:** the error entry persists `code` + `reauthRequired`, so the
  affordance survives session reload (`claude-history-replay.ts`).
- **Client:** `client/src/store/sessionStore.ts` displays the server-provided
  message verbatim (with a generic fallback) — no hardcoded backend-specific
  wording.

For a quick health check, run `claude auth status --json`.

## Common Failure Modes

### Legacy direct mode

#### No true mid-turn steer
`claude -p` is turn-oriented. Follow-up prompts are new turns, not interactive mid-turn control.

#### Session locks after aborts
If Claude's native JSONL still carries stale lock state, inspect `claude-process-pool.ts` and the native session file under `~/.claude/projects/...`.

#### Replay / tool mismatch
If the UI shows stuck tools or fragmented replay, compare the Pi-owned replay store with history reconstruction in `claude-history-replay.ts`.

### Channel-backed mode

#### Busy vs idle detection
The PTY path no longer trusts a single visible prompt frame as "done". It uses a busy-state tracker and a quiet window before declaring the turn idle. If a session looks prematurely complete or permanently busy, inspect:

- `server/src/claude/claude-channel-process-manager.ts`
- PTY output lines in the main journal

#### Auth expiry
See [Auth expiry (all backends)](#auth-expiry-all-backends) above. The channel
path additionally detects auth loss from PTY output
(`claude-channel-process-manager.ts`) and tries to recover stuck sessions
cleanly in `claude-channel-service.ts`.

#### Hook config drift
The channel mode depends on managed entries in:

```text
~/.claude/settings.json
```

If hooks are missing, duplicated, or user-edited into a bad shape, the channel bridge may stop reporting tool or stop events correctly.

#### Tool visibility depends on plugin cooperation
Tool activity in the Web UI depends on the plugin sending `send_event` / `reply` / permission-related events back through the channel bridge. If Claude appears to work but the UI does not reflect tool usage, inspect:

- `pi-claude-channel/server.ts`
- `claude-channel-event-adapter.ts`

## Recent Claude Channel Fix Areas

These were active recent troubleshooting themes and are now important doc-level knowledge:

- PTY idle false positives replaced with a busy-state tracker
- auth expiry surfaced cleanly to the UI
- stuck-session recovery improved
- tool usage surfaced via plugin `send_event`
- working directory, session file, and context usage surfaced in the session info modal
- model switching and thinking level wired through the PTY-backed path

If a future regression appears in one of those areas, search recent commits in `server/src/claude/` first.

## Live Validation

When you make changes to Claude runtime code, use the generic Internal-API
live-validation runner instead of the old browser-auth WebSocket script. Start a
disposable server and pass both paths explicitly (the runner refuses production
defaults unless `--allow-production` is deliberate):

```bash
# Terminal A
VAL_DIR="$(mktemp -d /tmp/pi-web-ui-claude-XXXXXX)"
npm run validate:server -- --dir "$VAL_DIR" --port 0 \
  >"$VAL_DIR/server.log" 2>&1 &

# Terminal B (export VAL_DIR there, or replace it with the printed directory)
PI_WEB_UI_WAIT_SOCKET="$VAL_DIR/internal-api.sock" npm run internal-api:wait
npm run validate:live -- --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --runtime claude --scenario smoke
npm run validate:live -- --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --runtime claude --scenario tool-visibility
npm run validate:live -- --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --runtime claude --scenario session-info
npm run validate:live -- --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --runtime claude --scenario follow-up
```

For the SDK `AskUserQuestion` lifecycle scenarios, use the same socket/token
with a profiles-enabled SDK backend:

```bash
npm run validate:live -- --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --runtime claude --scenario claude-ask-user-question
npm run validate:live -- --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --runtime claude --scenario claude-ask-user-question-cancel
# Boot the validation server with CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS=1..30000 first.
npm run validate:live -- --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --runtime claude --scenario claude-ask-user-question-timeout
npm run validate:live -- --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --runtime claude --scenario claude-ask-user-question-delayed-answer
```

For **profile-specific validation** (SDK/direct backends, GLM profiles):

```bash
# 1. Start a disposable validation server with profiles enabled
CLAUDE_PROFILES_ENABLED=true \
CLAUDE_SDK_ENABLED=true \
CLAUDE_PROFILES_PATH="$VAL_DIR/claude-profiles.json" \
npm run validate:server -- --env-file .env.production \
  --env-key GLM_CODING_PLAN_TOKEN --dir "$VAL_DIR" --port 0

# 2. Run the profile validation scenarios
npm run validate:claude-profiles -- \
  --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --glm-profile "glm52-claude-sdk" \
  --native-profile "claude-sonnet-sdk" \
  --direct-profile "glm52-claude-cli-direct"
```

This validates:
- SDK native Claude subscription works
- SDK GLM profile runs without channel mode
- Direct CLI GLM profile works
- Tool calls visible (`tool_execution_start`/`tool_execution_end`)
- Skills available and usable
- Follow-up/resume works with profile persistence

If Claude is running in channel-backed mode, also run (against the same
validation server):

```bash
npm run validate:live -- --socket "$VAL_DIR/internal-api.sock" \
  --token-path "$VAL_DIR/internal-api-token" \
  --runtime claude --scenario channel-heartbeat
```

What this validates:

- **Session creation:** a real Claude session is created through the Internal API
- **Streaming events:** `agent_start`, `agent_end`, and assistant text reach the runner
- **Tool visibility:** tool execution is surfaced in the full normalized event stream
- **Session info:** the enriched internal-API session info returns live runtime metadata
- **Follow-up turns:** a second turn succeeds when the runtime reports follow-up support
- **Channel liveness:** `stream_activity` is emitted when Claude is using the channel-backed path

The runner uses the explicitly supplied disposable socket/token, creates an
ephemeral session, streams normalized events, and cleans up afterwards — no
browser login required. It does not discover or select a disposable server for
you; use the validation server's printed paths. Omitting them is a deliberate
production target only when `--allow-production` is supplied. See
[`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) for runner usage and
[`INTERNAL-API.md`](./INTERNAL-API.md) for the underlying API.

## How to Decide Which Code Path to Read

- If the issue mentions **`claude -p`**, **resume**, **session locks**, or **NDJSON** → start with legacy direct files.
- If the issue mentions **Claude channel**, **PTY**, **tool visibility**, **`stream_activity`**, **hooks**, or **permission prompts** → start with channel-backed files.
- If the issue is only "Claude session in the UI is wrong" → start with `claude-service.ts`, then branch into the active backend mode.

## Related Docs

- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`SHARP-EDGES.md`](./SHARP-EDGES.md)
- [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md)
- [`PROTOCOL.md`](./PROTOCOL.md)
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
