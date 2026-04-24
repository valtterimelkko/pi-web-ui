# Pi Web UI

A persistent browser UI for coding-agent sessions with real-time streaming, unified session management, and three backend runtime paths:

- **Pi SDK**
- **Claude Direct**
- **OpenCode Direct**

## Documentation Map

- **Quick agent/developer rules:** [`AGENTS.md`](./AGENTS.md)
- **Architecture:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **WebSocket protocol:** [`docs/PROTOCOL.md`](./docs/PROTOCOL.md)
- **REST/API index:** [`API.md`](./API.md)
- **Security:** [`SECURITY.md`](./SECURITY.md)
- **Deployment / production runbook:** [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- **Pi worker isolation design:** [`docs/PROCESS-ISOLATION-DESIGN.md`](./docs/PROCESS-ISOLATION-DESIGN.md)
- **OpenCode Direct architecture:** [`docs/OPENCODE-DIRECT-INTEGRATION.md`](./docs/OPENCODE-DIRECT-INTEGRATION.md)
- **Tests:** [`tests/README.md`](./tests/README.md)

## What It Is

Pi Web UI is a web interface around multiple agent runtimes.

It combines:
- a **React + Vite** frontend
- an **Express + WebSocket** backend
- a **unified sidebar/session registry** across runtimes
- **runtime-specific adapters** so Pi SDK, Claude Direct, and OpenCode Direct feel similar in the UI
- **persistent storage** so sessions survive reconnects and, depending on runtime, process restarts

## Runtime Paths

| Runtime | What it uses | Best described as | Primary persistence |
|---|---|---|---|
| **Pi SDK** | Pi SDK + Pi worker/session lifecycle | Pi-native path with extensions/tools | `~/.pi/agent/sessions/` |
| **Claude Direct** | `claude -p` subprocesses | Claude CLI path with Pi-owned replay/persistence | `~/.pi-web-ui/claude-sessions/` |
| **OpenCode Direct** | `opencode serve` + HTTP/SSE | OpenCode-backed path for supported Z.AI GLM usage | OpenCode runtime + Pi registry metadata |

Unified session metadata lives in:
- `~/.pi-web-ui/session-registry.json`

## Core Capabilities

- Real-time streamed chat
- Create, switch, pin, rename, and export sessions
- Unified session list across all three runtimes
- Tool execution rendering and history replay
- Runtime availability reporting (`claude_available`, `opencode_available`)
- OpenCode permission bridge via the existing extension approval UI
- Security hardening: cookie auth, CSRF, origin validation, rate limiting, prompt-injection detection
- Health/config/model endpoints for debugging and operations

## Architecture at a Glance

```text
Browser (React + Zustand + Vite)
  └─ WebSocket /ws + REST /api/*
       └─ Express server
            ├─ security + auth middleware
            ├─ runtime-aware WebSocket router
            ├─ Pi SDK session manager + worker pool
            ├─ Claude Direct service + process pool
            ├─ OpenCode Direct service + process manager/client
            └─ unified session registry
```

## Quick Start

### Requirements

- Node.js 20+
- npm
- Pi CLI / Pi SDK environment available on the machine
- For **Claude Direct**: `claude` installed and authenticated
- For **OpenCode Direct**: `opencode` installed and configured

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
```

At minimum, set strong values for:

```bash
JWT_SECRET=your-random-secret
CSRF_SECRET=your-random-secret
AUTH_PASSWORD=your-password-or-bcrypt-hash
ALLOWED_ORIGINS=http://localhost:<frontend-port>
```

If using OpenCode Direct locally, also check:

```bash
OPENCODE_ENABLED=true
OPENCODE_SERVER_HOST=127.0.0.1
OPENCODE_SERVER_PORT=4096
OPENCODE_WORKING_DIR=/path/to/workspace-or-default-root

# Optional: reduce approval prompts for trusted, unattended OpenCode Direct work.
OPENCODE_TRUSTED_PERMISSIONS=false
OPENCODE_PERMISSION_APPROVE_MODE=always

# Optional: recycle the OpenCode backend after 24h, but only while idle.
OPENCODE_SERVER_MAX_UPTIME_MS=86400000
```

`OPENCODE_TRUSTED_PERMISSIONS=true` creates new OpenCode Direct sessions with permissive session-level rules for long-running autonomous work while still denying catastrophic disk/system shell patterns. `OPENCODE_SERVER_MAX_UPTIME_MS` is idle-aware: Pi Web UI defers recycling while an OpenCode session is actively running.

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for production values and service guidance.

### Run Locally

```bash
npm run dev
```

Useful commands:

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:e2e
```

## Repo Layout

```text
client/       React frontend
server/       Express server and runtime integrations
shared/       shared protocol/types package
docs/         architecture / protocol / design docs
tests/        Playwright E2E + benchmarks
server/tests/ server unit/integration tests
extensions/   local extension code
```

## Day-to-Day Development

Recommended verification flow:

1. Make the smallest change that solves the problem.
2. Run:
   ```bash
   npm run lint
   npm run typecheck
   npm run build
   ```
3. Run relevant tests:
   ```bash
   npm test
   ```
4. For localhost UI verification, use `webapp-testing`.
5. For live external sites, use `playwright-cli`.

See [`AGENTS.md`](./AGENTS.md) for the compact contributor workflow.

## Debugging by Problem Type

### WebSocket / streaming / session routing

Check:
- browser DevTools → Network → WS
- `server/src/websocket/connection.ts`
- `server/src/websocket/session-websocket.ts`
- `client/src/store/sessionStore.ts`

Useful endpoints:

```bash
curl http://localhost:<server-port>/api/health/live
curl http://localhost:<server-port>/api/health/ready
curl http://localhost:<server-port>/api/config/validate
```

### Pi SDK path

Check:
- `server/src/pi/multi-session-manager.ts`
- `server/src/workers/worker-pool.ts`
- `server/src/pi/pi-service.ts`

Useful checks:

```bash
ps aux | grep "pi --mode rpc"
curl http://localhost:<server-port>/api/health/ready | jq '.workerStats'
```

### Claude Direct path

Check:
- `server/src/claude/claude-service.ts`
- `server/src/claude/claude-process-pool.ts`
- `server/src/claude/claude-history-replay.ts`

Useful checks:

```bash
which claude
claude auth status --json
sudo journalctl -u pi-web-ui -f
```

See also [`docs/CLAUDE-DIRECT-UX-ISSUES.md`](./docs/CLAUDE-DIRECT-UX-ISSUES.md).

### OpenCode Direct path

Check:
- `server/src/opencode/opencode-service.ts`
- `server/src/opencode/opencode-process-manager.ts`
- `server/src/opencode/opencode-client.ts`
- `server/src/opencode/opencode-event-adapter.ts`

Useful checks:

```bash
which opencode
curl http://localhost:<server-port>/api/health/ready | jq '.checks.opencode'
curl "http://localhost:<server-port>/api/models?sdkType=opencode"
```

See [`docs/OPENCODE-DIRECT-INTEGRATION.md`](./docs/OPENCODE-DIRECT-INTEGRATION.md).

### Auth / CSRF / 401 issues

Check:
- `server/src/security/auth.ts`
- `server/src/security/csrf.ts`
- `server/src/middleware/auth.ts`
- browser cookies / JWT / CSRF flow

### Build / type / test issues

Run in order:

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

## Production Operations

```bash
sudo systemctl start pi-web-ui
sudo systemctl stop pi-web-ui
sudo systemctl restart pi-web-ui
sudo systemctl status pi-web-ui
sudo journalctl -u pi-web-ui -f
```

For full deployment, reverse proxy, service env, and runtime-specific configuration, see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Updating Dependencies

The repo uses workspace packages. For runtime-sensitive upgrades, inspect:
- `server/src/pi/`
- `server/src/claude/`
- `server/src/opencode/`
- `shared/src/`

Typical breakage after upgrades:
- changed event payload shapes
- changed session/runtime APIs
- changed model metadata or provider lists

## Contributor Notes

- Keep overview docs short and signpost to canonical deep docs.
- Prefer updating the canonical doc instead of duplicating information.
- `AGENTS.md` and `CLAUDE.md` should stay identical.
