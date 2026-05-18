# Deployment Guide

> Production runbook for Pi Web UI. See [`README.md`](./README.md) for the concise overview, [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for system structure, and [`docs/PROCESS-ISOLATION-DESIGN.md`](./docs/PROCESS-ISOLATION-DESIGN.md) for the Pi worker-isolation rationale.

## What You Are Deploying

Pi Web UI is a single web application that fronts three runtime families:

- **Pi SDK** — worker-managed Pi sessions
- **Claude runtime** — legacy `claude -p` subprocesses or the channel-backed Claude Code path
- **OpenCode Direct** — `opencode serve`-backed sessions

Operationally, this means deployment must consider:
- the Node/Express server itself
- Pi worker capacity and memory
- availability of `claude` if the Claude runtime is needed
- availability of Bun if the channel-backed Claude path is enabled
- availability of `opencode` if OpenCode Direct is needed

## Production Checklist

- [ ] Set strong `JWT_SECRET` and `CSRF_SECRET`
- [ ] Set a real `AUTH_PASSWORD` / hash
- [ ] Set `ALLOWED_ORIGINS` correctly
- [ ] Enable HTTPS / WSS
- [ ] Configure systemd or equivalent restart policy
- [ ] Confirm Pi CLI / SDK availability
- [ ] Confirm `claude` availability if using the Claude runtime
- [ ] Confirm Bun availability if using the channel-backed Claude path
- [ ] Confirm `opencode` availability if using OpenCode Direct
- [ ] Configure logging / monitoring
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

### Claude channel-backed path

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

### OpenCode Direct

| Variable | Default | Purpose |
|---|---:|---|
| `OPENCODE_ENABLED` | `true` | enable/disable OpenCode Direct |
| `OPENCODE_SERVER_HOST` | `127.0.0.1` | OpenCode server bind host |
| `OPENCODE_SERVER_PORT` | `4096` | OpenCode server port |
| `OPENCODE_SERVER_PASSWORD` | empty | optional basic-auth password for OpenCode server |
| `OPENCODE_WORKING_DIR` | `process.cwd()` | default OpenCode working dir |
| `OPENCODE_MAX_SESSIONS` | `4` | max active OpenCode sessions tracked by lifecycle logic |
| `OPENCODE_IDLE_TIMEOUT_MS` | `1800000` | idle timeout |
| `OPENCODE_STALE_STREAMING_MS` | `900000` | stale-stream reset window |
| `OPENCODE_MAX_PINNED_SESSIONS` | `2` | max pinned OpenCode sessions |
| `OPENCODE_CLEANUP_INTERVAL_MS` | `60000` | cleanup loop interval |

## Runtime Capacity Notes

### Pi SDK worker path

This is the main memory-sensitive runtime because it uses worker processes.

Typical rough sizing:
- base server: a few hundred MB+
- each Pi worker: roughly hundreds of MB depending on task/tool load
- leave headroom for builds, subprocesses, and runtime bursts

### Claude runtime

The Claude runtime uses either:
- legacy `claude -p` subprocesses, or
- the channel-backed Claude Code path under PTY supervision.

Operational concerns are mostly:
- `claude` binary on PATH
- auth/session behaviour
- replay-store vs native-Claude session-file correlation
- logs and subprocess/PTy cleanup
- hook configuration in `~/.claude/settings.json` for the channel-backed path

### OpenCode Direct

OpenCode Direct adds a long-lived `opencode serve` process when enabled and used. Ensure:
- the binary exists on the host
- the chosen port is free
- any password/basic-auth settings are aligned with Pi Web UI config
- consider managing `opencode serve` with its own systemd unit so it survives Pi Web UI restarts and server reboots

## systemd Example

### OpenCode serve service (recommended)

If you use OpenCode Direct, run `opencode serve` under its own systemd unit so it stays up independently of Pi Web UI restarts and server reboots.

Example `/etc/systemd/system/opencode-serve.service`:

```ini
[Unit]
Description=OpenCode Server - Headless API backend for Pi Web UI
After=network.target
Wants=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/pi-web-ui
Environment=PATH=/home/pi/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
ExecStart=/home/pi/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4097
Restart=always
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=opencode-serve

[Install]
WantedBy=multi-user.target
```

Adjust the `User`, `WorkingDirectory`, `ExecStart`, and `Environment=PATH` values to match your host.

### Pi Web UI service

Example `/etc/systemd/system/pi-web-ui.service`:

```ini
[Unit]
Description=Pi Web UI
After=network.target opencode-serve.service
Wants=network.target opencode-serve.service

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
sudo systemctl enable opencode-serve
sudo systemctl start opencode-serve
sudo systemctl enable pi-web-ui
sudo systemctl start pi-web-ui
sudo systemctl status pi-web-ui
```

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

### Pi SDK path

```bash
curl http://localhost:<port>/api/health/ready | jq '.workerStats'
ps aux | grep "pi --mode rpc"
```

### Claude runtime

```bash
which claude
claude auth status --json
sudo journalctl -u pi-web-ui -f | grep ClaudeChannel
npm run debug:where -- <session-id-or-runtime-session-id-or-path>
```

### OpenCode Direct

```bash
which opencode
curl http://localhost:<port>/api/health/ready | jq '.checks.opencode'
curl "http://localhost:<port>/api/models?sdkType=opencode"
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

### Claude runtime unavailable

- verify `claude` is on PATH for the service user
- verify auth state for the same user running the service
- if channel-backed mode is enabled, verify Bun availability and `CLAUDE_CHANNEL_*` values
- inspect `~/.claude/settings.json` if hooks appear to be missing or malformed
- check `server/src/claude/` logs/errors in journal output
- run `npm run debug:where -- <session-id-or-runtime-session-id-or-path>` when the problem is session-specific

### OpenCode Direct unavailable

- verify `opencode` is on PATH for the service user
- verify `OPENCODE_ENABLED=true`
- verify port and host settings
- inspect `server/src/opencode/opencode-process-manager.ts` behaviour via logs

## Deploy / Redeploy Flow

```bash
npm install
npm run build
sudo systemctl restart pi-web-ui
sudo systemctl status pi-web-ui
```

Recommended post-redeploy validation:

```bash
npm run lint
npm run typecheck
npm test
curl http://localhost:<port>/api/health/ready
```

## Docker Note

Docker is possible, but if you rely on Pi CLI, Claude CLI auth, or local OpenCode runtime state, containerisation adds complexity around credentials, mounted state, and runtime binaries. If using Docker, plan those mounts explicitly rather than assuming a pure stateless web app.
