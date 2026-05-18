# Claude Runtime Backends

> Canonical reference for the Claude runtime family in Pi Web UI.
>
> Important: the UI and registry treat Claude sessions as one runtime family (`sdkType: 'claude'`), but the server can drive Claude through two different backend implementations with different failure modes.

## Why This Doc Exists

Recent work introduced a **channel-backed Claude Code path** alongside the older **`claude -p` subprocess path**. Agents were repeatedly losing time rediscovering:

- where Claude session files live
- which code path is active
- which logs belong to the channel plugin vs the main service
- how to diagnose stuck tools, auth expiry, PTY idle detection, and replay mismatches

This doc centralizes that.

## The Two Claude Backend Modes

### 1. Legacy direct mode

- **How it runs:** `claude -p`
- **Main modules:**
  - `server/src/claude/claude-service.ts`
  - `server/src/claude/claude-process-pool.ts`
  - `server/src/claude/claude-event-normalizer.ts`
  - `server/src/claude/claude-history-replay.ts`
  - `server/src/claude/claude-session-store.ts`
- **Strengths:** straightforward subprocess-per-turn model
- **Main limitations:** no true mid-turn steer, subprocess lock edge cases, weaker interactivity

### 2. Channel-backed mode

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

Both Claude backend modes still use Pi Web UI's own replay file:

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

- `CLAUDE_CHANNEL_ENABLED`
- `CLAUDE_CHANNEL_PLUGIN_DIR`
- `CLAUDE_CHANNEL_WS_PORT`
- `CLAUDE_CHANNEL_HOOK_PORT`

See [`../DEPLOYMENT.md`](../DEPLOYMENT.md) for operational guidance.

## Logs and Quick Checks

### Main logs

```bash
sudo journalctl -u pi-web-ui -f
sudo journalctl -u pi-web-ui -f | grep ClaudeChannel
claude auth status --json
```

### Session file locations

- Pi-owned replay file: `~/.pi-web-ui/claude-sessions/<internal-session-id>.jsonl`
- Native Claude session file: `~/.claude/projects/-<encoded-cwd>/<claudeSessionId>.jsonl`
- Hook config: `~/.claude/settings.json`

### Fast session lookup

```bash
npm run debug:where -- <session-id-or-claudeSessionId-or-path>
```

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
If Claude Code loses auth mid-turn, the channel path surfaces that separately and tries to recover stuck sessions cleanly. First run:

```bash
claude auth status --json
```

Then inspect channel-related journal lines and `claude-channel-service.ts` auth-expiry handling.

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
