# Deployment Guide

> Production runbook for Pi Web UI. See [`README.md`](./README.md) for the public overview, [`docs/PLATFORM-SUPPORT.md`](./docs/PLATFORM-SUPPORT.md) for Linux/macOS adoption posture, [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for system structure, and [`docs/PROCESS-ISOLATION-DESIGN.md`](./docs/PROCESS-ISOLATION-DESIGN.md) for the Pi worker-isolation rationale.

## What You Are Deploying

Pi Web UI is a single web application that fronts four runtime paths:

- **Pi Coding Agent** — worker-managed Pi sessions
- **Claude Code** — profile-driven SDK backend, direct `claude -p` fallback, or the channel-backed Claude Code path
- **OpenCode** — `opencode serve`-backed sessions
- **Antigravity** — `agy -p` Gemini sessions with Pi-owned turn logs plus agy-owned conversation DBs

Operationally, this means deployment must consider:
- the Node/Express server itself
- Pi worker capacity and memory
- availability of `claude` if the Claude Code path is needed
- profile config and token env vars if you want provider-routed Claude sessions (e.g. GLM 5.2 / Z.ai)
- availability of Bun if the channel-backed Claude path is enabled
- availability of `opencode` if OpenCode is needed
- availability of `agy` if Antigravity is needed

## Recommended deployment shapes

### 1. Linux VPS or home server
This is the clearest serious long-running setup.

Best for:
- 24/7 availability
- mobile access
- multiple devices
- longer-running coding workflows

### 2. Always-on macOS machine
A Mac mini or similar machine can work well for personal/internal-network use.

Best for:
- technically comfortable users
- local-network access
- always-on personal workflows

### 3. Local laptop/workstation only
Fine for development and occasional personal use, but less ideal if you want the UI and runtimes available all the time.

## Reverse proxy recommendation

The maintainer's preferred shape uses **Caddy** in front of Pi Web UI.

Why Caddy is a good fit:
- simple HTTPS setup
- strong defaults
- pleasant for self-hosted personal services

Nginx is also perfectly viable, and an example is included below.

## Production Checklist

- [ ] Use Node.js 22.19+ (Pi SDK 0.80.10 requirement)
- [ ] Set strong `JWT_SECRET` and `CSRF_SECRET`
- [ ] Set a real `AUTH_PASSWORD` / hash
- [ ] Set `ALLOWED_ORIGINS` correctly
- [ ] Enable HTTPS / WSS
- [ ] Configure systemd or equivalent restart policy
- [ ] Confirm Pi CLI / SDK availability
- [ ] Confirm `claude` availability if using the Claude Code path
- [ ] If using provider profiles: confirm `CLAUDE_PROFILES_ENABLED=true`, profile file exists, and auth token env vars are set (never commit token values)
- [ ] Confirm Bun availability if using the channel-backed Claude path
- [ ] Confirm `opencode` availability if using OpenCode
- [ ] Confirm `agy` availability if using Antigravity
- [ ] Configure logging / monitoring
- [ ] If using Telegram notifications: set `NOTIFICATIONS_ENABLED=true`, `NOTIFICATIONS_PUBLIC_BASE_URL`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`
- [ ] Verify `npm run build` succeeds before restart

## Recommended Environment Variables

### Core app

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | backend port |
| `JWT_SECRET` | strong random secret |
| `CSRF_SECRET` | strong random secret |
| `AUTH_PASSWORD` | password or bcrypt hash |
| `ALLOWED_ORIGINS` | frontend origins allowed to connect |

### Pi worker path

| Variable | Default | Purpose |
|---|---:|---|
| `PI_MAX_WORKERS` | `5` | max concurrent Pi workers |
| `PI_WORKER_MEMORY` | `512` | MB per worker |
| `PI_IDLE_TIMEOUT` | `1800000` | Pi worker idle timeout |

### Claude provider profiles / SDK backend

This is the recommended current Claude deployment path. Use explicit profiles for:
- native Claude subscription sessions through the SDK backend
- GLM/Z.ai routing through the Claude Code harness
- keeping direct CLI and channel-backed fallbacks available without changing the browser UX


| Variable | Default | Purpose |
|---|---:|---|
| `CLAUDE_PROFILES_ENABLED` | `false` | enable the provider profile system |
| `CLAUDE_PROFILES_PATH` | `~/.pi-web-ui/claude-profiles.json` | path to the profile config file |
| `CLAUDE_DEFAULT_PROFILE` | — | profile id to use for all new Claude sessions (overrides `defaultProfileId` in the file) |
| `CLAUDE_SDK_ENABLED` | `true` (when profiles enabled) | enable the `sdk-subscription` backend |
| `CLAUDE_DIRECT_PROFILES_ENABLED` | `true` | enable `cli-direct` profile support |
| `CLAUDE_BACKEND_DEFAULT` | `direct` | default backend: `sdk` \| `direct` \| `channel` |

To roll back to legacy direct mode: set `CLAUDE_PROFILES_ENABLED=false`, `CLAUDE_SDK_ENABLED=false`, `CLAUDE_BACKEND_DEFAULT=direct`.

See [`docs/CLAUDE-PROVIDER-PROFILES.md`](./docs/CLAUDE-PROVIDER-PROFILES.md) for the full profile field reference, examples, and validation instructions.

### Claude channel-backed path

Treat this as an explicit opt-in backend, not the default starting point. It remains valuable as a richer PTY/plugin path and as an escape hatch if upstream Claude behaviour changes again.


| Variable | Default | Purpose |
|---|---:|---|
| `CLAUDE_CHANNEL_ENABLED` | `false` | enable the channel-backed Claude backend instead of legacy direct mode |
| `CLAUDE_CHANNEL_PLUGIN_DIR` | `./pi-claude-channel` | local plugin bridge directory |
| `CLAUDE_CHANNEL_WS_PORT` | `3100` | local channel WebSocket port |
| `CLAUDE_CHANNEL_HOOK_PORT` | `3101` | local Claude hook receiver port |

Prerequisites:
- `claude` installed and authenticated for the same service user
- Bun available so `pi-claude-channel/package.json` scripts can run when needed
- write access to `~/.claude/settings.json` so managed hooks can be installed

### OpenCode

| Variable | Default | Purpose |
|---|---:|---|
| `OPENCODE_ENABLED` | `true` | enable/disable OpenCode |
| `OPENCODE_SERVER_HOST` | `127.0.0.1` | OpenCode server bind host |
| `OPENCODE_SERVER_PORT` | `4096` | OpenCode server port |
| `OPENCODE_SERVER_PASSWORD` | empty | optional basic-auth password for OpenCode server |
| `OPENCODE_WORKING_DIR` | `process.cwd()` | default OpenCode working dir |
| `OPENCODE_MAX_SESSIONS` | `4` | max active OpenCode sessions tracked by lifecycle logic |
| `OPENCODE_IDLE_TIMEOUT_MS` | `1800000` | idle timeout |
| `OPENCODE_STALE_STREAMING_MS` | `900000` | stale-stream reset window |
| `OPENCODE_MAX_PINNED_SESSIONS` | `2` | max pinned OpenCode sessions |
| `OPENCODE_CLEANUP_INTERVAL_MS` | `60000` | cleanup loop interval |
| `OPENCODE_MODEL_PROVIDERS` | `zai-coding-plan,kilo,opencode` | provider ids whose models appear in the picker, or `all`/`*` for every authenticated provider. Pi Web UI never reads provider keys — they stay in OpenCode's auth storage |
| `OPENCODE_MODEL_SNAPSHOT_PATH` | `~/.pi-web-ui/opencode-model-snapshot.json` | host-side audit snapshot for the weekly model-refresh job (ids only) |

### Notification layer (optional Telegram operator ping)

| Variable | Default | Purpose |
|---|---:|---|
| `NOTIFICATIONS_ENABLED` | `false` | master switch; off keeps the manager inert |
| `NOTIFICATIONS_DIR` | `~/.pi-web-ui/notifications` | persistence for opt-ins, durable outbox, and delivery log |
| `NOTIFICATIONS_DEBOUNCE_MS` | `1500` | coalesce repeated `agent_end` notifications per session |
| `NOTIFICATIONS_TAIL_MAX_CHARS` | `1200` | assistant-tail length before truncation |
| `NOTIFICATIONS_PUBLIC_BASE_URL` | first `ALLOWED_ORIGINS` | base URL used for deep links back into the session |
| `NOTIFICATIONS_MAX_DELIVERY_ATTEMPTS` | `5` | retry cap before a delivery is marked failed |
| `NOTIFICATIONS_INGRESS_POLL_MS` | `5000` | positive interval for draining terminal-client spool records |
| `NOTIFICATIONS_CHANNEL_TIMEOUT_MS` | `10000` | positive per-attempt Telegram request timeout, including body read |
| `TELEGRAM_BOT_TOKEN` | unset | Telegram bot token; secret, keep only in uncommitted env/config |
| `TELEGRAM_CHAT_ID` | unset | operator chat id |

If you enable notifications, make sure `NOTIFICATIONS_PUBLIC_BASE_URL` resolves to the browser URL operators actually open. Otherwise Telegram messages may deliver correctly but deep links will point at the wrong host/origin.

### Antigravity

| Variable | Default | Purpose |
|---|---:|---|
| `ANTIGRAVITY_ENABLED` | `true` | enable/disable the Antigravity runtime |
| `ANTIGRAVITY_SESSION_DIR` | `~/.pi-web-ui/antigravity-sessions` | Pi-owned Antigravity JSONL turn log directory |
| `ANTIGRAVITY_DEFAULT_MODEL` | `Gemini 3.5 Flash (Medium)` | default `agy` model |
| `ANTIGRAVITY_PROMPT_TIMEOUT_MS` | `600000` | max prompt duration before timeout |
| `ANTIGRAVITY_IDLE_TIMEOUT_MS` | `1800000` | idle timeout for unpinned inactive sessions |
| `ANTIGRAVITY_HEARTBEAT_INTERVAL_MS` | `5000` | synthetic liveness heartbeat interval while a subprocess runs |
| `ANTIGRAVITY_STALL_TIMEOUT_MS` | `300000` | kill a silent `agy -p` turn if the per-turn log file mtime stops advancing (default 5 min) |
| `ANTIGRAVITY_MAX_ATTEMPTS` | `2` | total attempts for a stalled or timed-out `agy -p` turn |
| `ANTIGRAVITY_MAX_SESSIONS` | `4` | max in-memory Antigravity sessions tracked |
| `ANTIGRAVITY_MAX_PINNED_SESSIONS` | `2` | max pinned Antigravity sessions |
| `ANTIGRAVITY_CLEANUP_INTERVAL_MS` | `60000` | cleanup loop interval |

## Runtime Capacity Notes

### Pi Coding Agent worker path

This is the main memory-sensitive runtime because it uses worker processes.

Typical rough sizing:
- base server: a few hundred MB+
- each Pi worker: roughly hundreds of MB depending on task/tool load
- leave headroom for builds, subprocesses, and runtime bursts

### Claude Code

The Claude Code path uses one of three backends:
- **SDK backend** — `@anthropic-ai/claude-agent-sdk` with provider profiles (preferred when profiles are enabled)
- **legacy `claude -p` subprocesses** — profile-aware or plain direct mode
- **channel-backed Claude Code path** — PTY supervision with local plugin bridge

Operational concerns:
- `claude` binary on PATH and authenticated for the service user
- auth/session behaviour
- replay-store vs native-Claude session-file correlation
- logs and subprocess/PTY cleanup
- hook configuration in `~/.claude/settings.json` for the channel-backed path
- profile config file readable and valid; auth token env vars set (never in the profile file itself) for the SDK/profile path

### OpenCode

OpenCode uses a long-lived `opencode serve` backend when enabled and used. By default, **Pi Web UI manages that backend itself** through `server/src/opencode/opencode-process-manager.ts`.

Ensure:
- the `opencode` binary exists on the host and is on `PATH`
- the configured port is free for Pi Web UI to manage
- any password/basic-auth settings are aligned with Pi Web UI config

Do **not** add a separate `opencode-serve.service` dependency to `pi-web-ui.service` unless you have deliberately implemented an external-only OpenCode lifecycle. A standalone `opencode-serve.service` with `Restart=always` on the same port can enter a restart loop if Pi Web UI already owns the port. Recent OpenCode/Bun builds may leave `/tmp/.fb*.so` native shared-object files on failed startup, so such a loop can fill the root disk.

### Antigravity

Antigravity uses `agy -p` in subprocess-per-turn mode rather than a long-lived server. Ensure:
- the `agy` binary exists on the host and is on `PATH` (or set `AGY_BINARY`)
- the service user has already authenticated with Antigravity / Gemini CLI
- the service user can read and write `~/.gemini/antigravity-cli/`
- disk space is available for both `~/.pi-web-ui/antigravity-sessions/` and agy's own log/conversation directories

## systemd Example

### Pi Web UI service

Example `/etc/systemd/system/pi-web-ui.service`:

```ini
[Unit]
Description=Pi Web UI
After=network.target
Wants=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/pi-web-ui
Environment=NODE_ENV=production
Environment=PORT=3456
Environment=PI_MAX_WORKERS=5
Environment=PI_WORKER_MEMORY=512
Environment=PI_IDLE_TIMEOUT=1800000
Environment=OPENCODE_ENABLED=true
Environment=OPENCODE_SERVER_HOST=127.0.0.1
Environment=OPENCODE_SERVER_PORT=4097
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
RestartSec=10
MemoryMax=6G
MemoryHigh=5G

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable pi-web-ui
sudo systemctl start pi-web-ui
sudo systemctl status pi-web-ui
```

### Weekly OpenCode model refresh (optional)

Keeps the OpenCode model list current as Kilo Gateway / OpenCode Zen and upstream
labs add models. It warms the models.dev cache, recycles the OpenCode backend
(idle-aware — deferred while sessions run), and records an ids-only audit snapshot.
No credentials are involved; it calls the internal API over the local Unix socket.

Templates ship in `deploy/systemd/` (kept generic — copy host-specific units into
`/etc/systemd/system`, never commit machine-specific ones):

```bash
sudo cp deploy/systemd/opencode-model-refresh.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-model-refresh.timer
systemctl list-timers opencode-model-refresh.timer
journalctl -u opencode-model-refresh.service   # diffs of added/removed models
```

The service unit's `PATH` must include `node`/`npm` and the `opencode` binary.
Run on demand any time with `npm run opencode:refresh-models`. New providers still
need a one-time `opencode auth login`; the refresh diff surfaces them so you can
add the id to `OPENCODE_MODEL_PROVIDERS` (or set it to `all`). See
[`docs/OPENCODE-MODEL-AUTOMATION.md`](./docs/OPENCODE-MODEL-AUTOMATION.md).

## Caddy Example

```caddy
pi.example.com {
    encode zstd gzip

    handle /ws* {
        reverse_proxy 127.0.0.1:3456
    }

    handle /api/* {
        reverse_proxy 127.0.0.1:3456
    }

    handle {
        root * /opt/pi-web-ui/client/dist
        try_files {path} /index.html
        file_server
    }
}
```

Adjust the domain, backend port, and static-file path to your own environment.

## Nginx Example

```nginx
server {
    listen 443 ssl http2;
    server_name pi.example.com;

    ssl_certificate /etc/letsencrypt/live/pi.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pi.example.com/privkey.pem;

    location / {
        root /opt/pi-web-ui/client/dist;
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

## Common Operational Checks

### General

```bash
sudo systemctl status pi-web-ui
sudo journalctl -u pi-web-ui -f
curl http://localhost:<port>/api/health/live
curl http://localhost:<port>/api/health/ready
```

### Pi Coding Agent path

```bash
curl http://localhost:<port>/api/health/ready | jq '.workerStats'
ps aux | grep "pi --mode rpc"
```

### Claude Code

```bash
which claude
claude auth status --json
sudo journalctl -u pi-web-ui -f | grep ClaudeChannel
npm run debug:where -- <session-id-or-runtime-session-id-or-path>
```

### OpenCode

```bash
which opencode
curl http://localhost:<port>/api/health/ready | jq '.checks.opencode'
curl "http://localhost:<port>/api/models?sdkType=opencode"
```

### Antigravity

```bash
which agy
agy --version
agy models
agy -p "Reply OK"
curl "http://localhost:<port>/api/models?sdkType=antigravity"
npm run debug:where -- <session-id-or-runtime-session-id-or-path>
```

### Notifications

```bash
curl http://localhost:<port>/api/sessions/<session-id>/notifications
TOKEN=$(cat ~/.pi-web-ui/internal-api-token)
curl --unix-socket ~/.pi-web-ui/internal-api.sock \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost/api/v1/notifications
ls -la ~/.pi-web-ui/notifications
```

## Troubleshooting

### Build or startup failure

```bash
npm run lint
npm run typecheck
npm run build
```

### Worker pressure / OOM on Pi path

- reduce `PI_MAX_WORKERS`
- reduce `PI_WORKER_MEMORY` only if you know sessions can tolerate it
- increase host RAM / swap if appropriate
- inspect `journalctl` and OOM logs

### Claude Code unavailable

- verify `claude` is on PATH for the service user
- verify auth state for the same user running the service
- if using provider profiles: check startup logs for Zod validation errors and confirm `CLAUDE_PROFILES_ENABLED=true` and the profile file is readable
- if using the SDK backend: confirm `@anthropic-ai/claude-agent-sdk` is installed (`ls node_modules/@anthropic-ai/claude-agent-sdk`)
- if channel-backed mode is enabled, verify Bun availability and `CLAUDE_CHANNEL_*` values
- inspect `~/.claude/settings.json` if hooks appear to be missing or malformed
- check `server/src/claude/` logs/errors in journal output
- run `npm run debug:where -- <session-id-or-runtime-session-id-or-path>` when the problem is session-specific

### OpenCode unavailable

- verify `opencode` is on PATH for the service user
- verify `OPENCODE_ENABLED=true`
- verify port and host settings
- inspect `server/src/opencode/opencode-process-manager.ts` behaviour via logs

## Deploy / Redeploy Flow

Serialize the entire build/restart operation so two trusted local agents cannot
interleave production control. The wrapper takes an argument vector (never an
`eval` string), holds `~/.pi-web-ui/production-control.lock` for the command
lifetime, rejects unsafe lock paths, and preserves the command exit status:

```bash
npm run production:lock -- bash -lc '
  npm ci --include=dev &&
  npm run lint &&
  npm run typecheck &&
  npm test &&
  npm run build &&
  sudo systemctl restart pi-web-ui &&
  sudo systemctl status pi-web-ui --no-pager &&
  npm run internal-api:wait
'
```

`internal-api:wait` verifies the expected `pi-web-ui-internal-api` identity on
the Unix socket, not merely the public HTTP listener. Its default deadline is
60 seconds. Override `PI_WEB_UI_WAIT_SOCKET`, `PI_WEB_UI_WAIT_TIMEOUT_MS`,
`PI_WEB_UI_WAIT_INTERVAL_MS`, or `PI_WEB_UI_WAIT_REQUEST_TIMEOUT_MS` for a
non-default install.

The helpers do not deploy or restart anything by themselves. Production control
still requires explicit operator authorization. A public readiness check can be
run in addition after the Internal API is ready:

```bash
curl http://localhost:<port>/api/health/ready
```

## Docker Note

Docker is possible, but if you rely on Pi CLI, Claude CLI auth, or local OpenCode runtime state, containerisation adds complexity around credentials, mounted state, and runtime binaries. If using Docker, plan those mounts explicitly rather than assuming a pure stateless web app.
