# Pi Web UI

A persistent web interface for the Pi Coding Agent, with real-time chat, session management, tool visibility, and support for both Pi SDK sessions and Claude Direct sessions.

## Documentation Map

- **Agent/developer quick rules:** [`AGENTS.md`](./AGENTS.md)
- **Architecture:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Protocol details:** [`docs/PROTOCOL.md`](./docs/PROTOCOL.md)
- **API index:** [`API.md`](./API.md)
- **Security:** [`SECURITY.md`](./SECURITY.md)
- **Deployment / production runbook:** [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- **Worker isolation design:** [`docs/PROCESS-ISOLATION-DESIGN.md`](./docs/PROCESS-ISOLATION-DESIGN.md)

## What It Is

Pi Web UI is a browser-based interface for running the Pi Coding Agent with persistent sessions and operational visibility.

It combines:
- a **React + Vite** frontend
- an **Express + WebSocket** backend
- **Pi SDK** integration for Pi-native sessions and extensions
- **Claude Direct** integration for `claude -p` sessions
- **file-backed session persistence** so sessions survive reconnects and service restarts

## Core Capabilities

- Real-time chat with streamed assistant responses
- Session list, switching, export, and persistence
- Dual runtime support:
  - **Pi SDK sessions** for Pi extensions/tools and multi-provider model support
  - **Claude Direct sessions** for Claude Code CLI workflows
- Tool execution rendering and file-aware workflows
- Security hardening: JWT auth, CSRF protection, origin validation, rate limiting
- Health/config endpoints for operations and debugging

## Architecture at a Glance

```text
Browser (React + Vite)
  └─ WebSocket /ws and /ws/sessions/:sessionId
       └─ Express server (server/src)
            ├─ WebSocket handlers
            ├─ REST routes
            ├─ Pi SDK session manager + worker pool
            ├─ Claude Direct service + process pool
            └─ unified session registry
```

### Session Runtime Paths

| Path | What it is | Stored in |
|---|---|---|
| **Pi SDK** | Persistent Pi worker/session lifecycle with Pi extensions and model switching | `~/.pi/agent/sessions/` |
| **Claude Direct** | `claude -p` subprocess per turn with Claude session resume support | `~/.pi-web-ui/claude-sessions/` |

Unified sidebar/session metadata is stored in:
- `~/.pi-web-ui/session-registry.json`

For the detailed design, see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and [`docs/PROCESS-ISOLATION-DESIGN.md`](./docs/PROCESS-ISOLATION-DESIGN.md).

## Quick Start

### Requirements

- Node.js 20+
- npm
- Pi CLI / Pi SDK environment available on the machine
- For Claude Direct sessions: `claude` installed and authenticated

### Install

```bash
npm install
```

### Configure

Create a local env file from the example:

```bash
cp .env.example .env
```

At minimum, set strong values for:

```bash
JWT_SECRET=your-random-secret
CSRF_SECRET=your-random-secret
AUTH_PASSWORD=your-password-or-bcrypt-hash
ALLOWED_ORIGINS=http://localhost:<your-frontend-port>
```

Set `ALLOWED_ORIGINS` to match the frontend URL you actually use locally. In this repo, common local setups use either `5173` or `3457` for the frontend, depending on configuration.

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for production-grade values and service configuration.

### Run Locally

```bash
npm run dev
```

If you are unsure which ports your local setup uses, check `client/vite.config.ts` and your `.env` / `.env.example` values.

Useful project commands:

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:e2e
```

## Day-to-Day Development

### Recommended verification flow

1. Make the smallest change that solves the problem.
2. Run:
   ```bash
   npm run lint
   npm run typecheck
   npm run build
   ```
3. Run the relevant tests:
   ```bash
   npm test
   ```
4. For local UI behaviour, use the `webapp-testing` skill.
5. For live-site verification, use the `playwright-cli` skill.

See [`AGENTS.md`](./AGENTS.md) for the compact agent workflow.

## Debugging by Problem Type

### 1. WebSocket / streaming issues

Check:
- browser DevTools → Network → WS
- `server/src/websocket/connection.ts`
- `server/src/websocket/session-websocket.ts`

Useful checks (replace `<server-port>` with your actual backend port):

```bash
curl http://localhost:<server-port>/api/health/live
curl http://localhost:<server-port>/api/health/ready
curl http://localhost:<server-port>/api/config/validate
```

Common symptoms:
- abnormal close / auth failure
- stuck streaming state
- missing session replay
- bad origin / CSRF / cookie handling

Protocol details live in [`docs/PROTOCOL.md`](./docs/PROTOCOL.md).

### 2. Claude Direct issues

Useful checks:

```bash
which claude
claude auth status --json
sudo journalctl -u pi-web-ui -f
```

Relevant files:
- `server/src/claude/claude-service.ts`
- `server/src/claude/claude-process-pool.ts`

Common symptoms:
- `claude` missing from PATH for systemd
- auth/session lock issues
- follow-up turns not resuming correctly

### 3. Pi SDK worker / session issues

Useful checks:

```bash
ps aux | grep "pi --mode rpc"
curl http://localhost:<server-port>/api/health/ready | jq '.workerStats'
```

Relevant files:
- `server/src/pi/multi-session-manager.ts`
- `server/src/workers/worker-pool.ts`
- `server/src/session-registry.ts`

Common symptoms:
- worker spawn failure
- worker OOM / crash isolation problems
- stale or missing session state

### 4. Auth / CSRF / 401 issues

Check:
- browser cookies / JWT presence
- CSRF token exchange
- `server/src/security/auth.ts`
- `server/src/security/csrf.ts`

Useful endpoint:

```bash
curl http://localhost:<server-port>/api/config/validate
```

### 5. Build / type / integration issues

Run in order:

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

Because this is a workspace repo, `shared/` must build before server/client consumers. That ordering is already handled by the root scripts in `package.json`.

## Production Operations

### Start / stop / restart / status

```bash
sudo systemctl start pi-web-ui
sudo systemctl stop pi-web-ui
sudo systemctl restart pi-web-ui
sudo systemctl status pi-web-ui
sudo journalctl -u pi-web-ui -f
```

### Enable / disable on boot

```bash
sudo systemctl enable pi-web-ui
sudo systemctl disable pi-web-ui
```

### Deploy / redeploy

```bash
npm run build
sudo systemctl restart pi-web-ui
```

### Undeploy

If you need to take the service out of rotation quickly:

```bash
sudo systemctl stop pi-web-ui
sudo systemctl disable pi-web-ui
```

For full production setup, reverse proxy configuration, service file details, and worker memory tuning, see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Updating the Pi SDK to the Latest Version

The web UI depends on `@mariozechner/pi-coding-agent` inside this repo. Updating a globally installed Pi CLI does **not** update the copy used by the web UI.

### Update steps

```bash
# Update workspace dependencies
npm install @mariozechner/pi-coding-agent@latest -w server
npm install @mariozechner/pi-coding-agent@latest -w .

# Rebuild and verify
npm run lint
npm run typecheck
npm run build
npm test
```

If the checks pass, restart the service if needed:

```bash
sudo systemctl restart pi-web-ui
```

### Places to inspect if the SDK changed behaviour

- `server/src/pi/pi-service.ts`
- `server/src/pi/event-forwarder.ts`
- `server/src/workers/`
- `shared/src/`

Typical breakage after SDK upgrades:
- renamed event types
- changed session/runtime APIs
- changed model metadata or event payload shapes

## Repo Layout

```text
client/     React frontend
server/     Express server + runtime integration
shared/     shared protocol/types package
tests/      E2E tests and benchmarks
docs/       architecture / protocol / design docs
extensions/ local extension code
```

## Notes for Agents and Contributors

- Keep overview docs short and signpost to the canonical deep docs.
- Prefer editing the canonical source doc over duplicating the same information elsewhere.
- For agent-specific working rules, read [`AGENTS.md`](./AGENTS.md).
