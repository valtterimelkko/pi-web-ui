# Pi Web UI

A self-hosted browser interface for working with multiple coding-agent runtimes from one place.

Pi Web UI started as a personal response to a practical problem: one agent runtime and one subscription was not enough. I wanted a setup where I could combine different coding harnesses, different model providers, and different subscription economics behind a single interface that I could use from a desk, from a phone, or while moving between places.

The result is a persistent web UI with real-time streaming, mobile-friendly session management, voice features, and runtime adapters for four different agent paths:

- **Pi SDK**
- **Claude runtime** (legacy direct `claude -p` or channel-backed Claude Code)
- **OpenCode Direct**
- **Antigravity** (`agy -p` / Google Gemini)

## Credits and upstream projects

This project builds on top of other agent ecosystems rather than replacing them.

- **Pi Coding Agent** is the original foundation and inspiration for the first runtime path. See the upstream website at [shittycodingagent.ai](https://shittycodingagent.ai/) and the current codebase at [github.com/earendil-works/pi-mono/tree/main/packages/coding-agent](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent).
- **Claude Code**, **OpenCode**, and **Antigravity** each provide their own runtime capabilities; Pi Web UI adds a browser layer, persistence layer, replay layer, and cross-runtime UX around them.

If you use Pi Web UI, you are also depending on the capabilities, constraints, and policies of those upstream runtimes.

## Why this exists

Pi Web UI is for people who want more than a single vendor-owned coding surface.

It is designed for workflows where you may want to:
- keep using a favourite high-end agent for the hardest work
- route lighter or cheaper tasks through other runtimes
- preserve chat history and tool traces in one place
- access coding agents from mobile devices or while away from your main machine
- extend the Pi-based path with custom extensions and the OpenCode path with custom plugins

For a longer account of why it was created, how the runtime mix evolved, and how it is used in day-to-day practice, see [`docs/PROJECT-STORY.md`](./docs/PROJECT-STORY.md).

## Make it your own

This repo works well for its original maintainer, but it is also meant to be a strong starting point for other people to adapt.

You do **not** need to use all four runtime paths the same way. For example:
- you might use it mainly as a **Pi** web UI
- you might use it mainly as an **OpenCode** web UI
- you might ignore voice features entirely
- you might swap dictation/TTS providers
- you might fork it and tune the runtime mix around your own subscriptions, models, or hosting preferences

A concrete example from the maintainer's own setup: the **OpenCode** path is used with Z.AI / GLM coding plans because that provider/runtime combination was practical there even when the same route was not available through Pi. Another user might make a very different choice and still find the same browser shell useful.

The intention is not that every future commit will be universally right for every user. Some people may prefer to:
- follow upstream changes from this repo selectively
- run only a subset of the runtime paths
- fork the repo and evolve it in their own direction

That is an expected and healthy way to use this project.

## What it does

Pi Web UI combines:
- a **React + Vite** frontend
- an **Express + WebSocket** backend
- a **local Internal API** over a Unix socket for automation, orchestration, and live validation
- a **unified sidebar/session registry** across runtimes
- **runtime-specific adapters** so Pi SDK, Claude, OpenCode, and Antigravity sessions feel similar in the UI
- **persistent storage** so sessions survive reconnects and, depending on runtime, process restarts
- **mobile-aware UX**, including voice dictation and a Drive Mode overlay with dictation + read-aloud support

## Runtime paths and integration style

| Runtime family | Backend implementation | Integration style | Primary persistence |
|---|---|---|---|
| **Pi SDK** | Pi SDK + Pi worker/session lifecycle | Native SDK integration with extensions/tools | `~/.pi/agent/sessions/` |
| **Claude runtime** | `claude -p` subprocesses **or** channel-backed Claude Code via PTY + plugin bridge | Process-wrapper integration with Pi-owned replay and runtime-specific glue | `~/.pi-web-ui/claude-sessions/` + Claude native session JSONL |
| **OpenCode Direct** | `opencode serve` + HTTP/SSE | Native local server/API integration | OpenCode runtime + Pi registry metadata |
| **Antigravity** | `agy -p` subprocess-per-turn execution | Process-wrapper integration with Pi-owned turn logs | `~/.pi-web-ui/antigravity-sessions/` + `~/.gemini/antigravity-cli/conversations/` |

Unified session metadata lives in:
- `~/.pi-web-ui/session-registry.json`

### Important caveat

Not all runtime paths are equally "official" in the eyes of their upstream providers.

- The **Pi SDK** and **OpenCode Direct** paths use supported integration surfaces.
- The **Claude** and **Antigravity** paths are more wrapper-oriented and may need maintenance when upstream CLI behaviour, authentication flows, or policies change.

That does not make them unusable, but it does mean adopters should treat those integrations as more operationally sensitive.

## Core capabilities

- Real-time streamed chat
- Create, switch, pin, rename, and export sessions
- Unified session list across all runtime paths
- Tool execution rendering and history replay
- Local Internal API for agent orchestration, transcript extraction, cross-runtime context transfer, and browserless validation
- Runtime availability reporting (`claude_available`, `opencode_available`, `antigravity_available`)
- OpenCode permission bridge via the existing extension approval UI
- Voice dictation and Drive Mode read-aloud/dictation flow
- Security hardening: cookie auth, CSRF, origin validation, rate limiting, prompt-injection detection
- Health/config/model endpoints for debugging and operations

## Runtime/provider flexibility

The repo is intentionally opinionated enough to be useful, but not so rigid that adopters must use the same providers or services.

Examples of components you may reasonably replace or reconfigure:
- the OpenCode-backed model/provider mix
- the voice dictation provider
- the text-to-speech path
- companion extensions/plugins
- runtime paths you do not personally need

The maintained version currently uses fast OpenAI-backed dictation/read-aloud flows because they work well in practice, but there is nothing sacred about that choice. If you prefer local Whisper, a different hosted STT provider, or a different TTS path, this repo is intended to be modifiable.

## Companion extensions and plugins

Pi Web UI is most powerful when used alongside companion extension/plugin packs.

- The **Pi runtime** benefits from companion Pi extensions for planning, subagents, memory, goal execution, web tools, orchestration, and richer task/status flows.
- The **OpenCode runtime** benefits from companion plugins for goal execution, memory, and parallel orchestration.
- Some UI affordances in this repo were designed around those companion layers. Core chat/session flows still work without them, but some widgets, status surfaces, or workflow niceties may be absent.

See [`docs/RUNTIME-COMPANIONS.md`](./docs/RUNTIME-COMPANIONS.md).

## Documentation map

> Some deeper docs include concrete Linux paths, systemd commands, socket locations, and maintainer deployment examples because this project is also used as a live operational runbook. For public adopters, treat those values as examples to adapt to your own machine rather than fixed requirements.

### Start here
- **Quick agent/developer rules:** [`AGENTS.md`](./AGENTS.md)
- **Docs index / recommended reading order:** [`docs/README.md`](./docs/README.md)
- **Architecture:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Security:** [`SECURITY.md`](./SECURITY.md)
- **Deployment / production runbook:** [`DEPLOYMENT.md`](./DEPLOYMENT.md)

### Runtime-specific docs
- **Claude backend modes:** [`docs/CLAUDE-BACKENDS.md`](./docs/CLAUDE-BACKENDS.md)
- **OpenCode Direct architecture:** [`docs/OPENCODE-DIRECT-INTEGRATION.md`](./docs/OPENCODE-DIRECT-INTEGRATION.md)
- **Antigravity architecture:** [`docs/ANTIGRAVITY-INTEGRATION.md`](./docs/ANTIGRAVITY-INTEGRATION.md)
- **Pi worker isolation design:** [`docs/PROCESS-ISOLATION-DESIGN.md`](./docs/PROCESS-ISOLATION-DESIGN.md)
- **Drive Mode feature:** [`docs/DRIVE-MODE.md`](./docs/DRIVE-MODE.md)
- **Companion runtime notes:** [`docs/RUNTIME-COMPANIONS.md`](./docs/RUNTIME-COMPANIONS.md)
- **Project story / evolution:** [`docs/PROJECT-STORY.md`](./docs/PROJECT-STORY.md)

### Claude-specific note
If you want to use Claude the same way this project does, read [`docs/CLAUDE-BACKENDS.md`](./docs/CLAUDE-BACKENDS.md) carefully. The richer Claude path is not just `claude -p`; it depends on the local `pi-claude-channel/` bridge, managed hook configuration, and the channel-backed event flow that feeds tool/permission/session events back into the Web UI.

### Operations and interfaces
- **First-stop troubleshooting / logs / session files:** [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)
- **WebSocket protocol:** [`docs/PROTOCOL.md`](./docs/PROTOCOL.md)
- **REST/API index:** [`API.md`](./API.md)
- **Internal API reference:** [`docs/INTERNAL-API.md`](./docs/INTERNAL-API.md)
- **Internal API orchestration guide:** [`docs/INTERNAL-API-ORCHESTRATION.md`](./docs/INTERNAL-API-ORCHESTRATION.md)
- **Live validation:** [`docs/LIVE-VALIDATION.md`](./docs/LIVE-VALIDATION.md)
- **Tests:** [`tests/README.md`](./tests/README.md)

## Architecture at a glance

```text
Browser (React + Zustand + Vite)
  └─ WebSocket /ws + REST /api/*
       └─ Express server
            ├─ security + auth middleware
            ├─ runtime-aware WebSocket router
            ├─ Pi SDK session manager + worker pool
            ├─ Claude service + (legacy process pool or channel-backed PTY/plugin path)
            ├─ OpenCode Direct service + process manager/client
            ├─ Antigravity service + subprocess-per-turn adapter
            └─ unified session registry
```

## Quick Start

### Requirements

- Node.js 20+
- npm
- Pi CLI / Pi SDK environment available on the machine
- For **Claude runtime**: `claude` installed and authenticated
- For **channel-backed Claude mode**: Bun available for `pi-claude-channel/`
- For **OpenCode Direct**: `opencode` installed and configured
- For **Antigravity**: `agy` installed and authenticated for the same OS user

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

If using the Claude channel-backed path, also check:

```bash
CLAUDE_CHANNEL_ENABLED=false
CLAUDE_CHANNEL_PLUGIN_DIR=./pi-claude-channel
CLAUDE_CHANNEL_WS_PORT=3100
CLAUDE_CHANNEL_HOOK_PORT=3101
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

If you want voice dictation / read-aloud features, set an OpenAI key as well:

```bash
OPENAI_API_KEY=your-openai-key
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
npm run validate:live -- --runtime claude --scenario smoke
npm run validate:live -- --runtime antigravity --scenario smoke
npm run debug:where -- <session-id-or-runtime-session-id-or-path>
```

## Repo Layout

```text
client/       React frontend
server/       Express server and runtime integrations
shared/       shared protocol/types package
docs/         architecture / protocol / design docs
tests/        Playwright E2E + benchmarks + utility tests
server/tests/ server unit/integration tests
extensions/   local extension code
scripts/      local operational helpers
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
5. For live runtime validation without opening the browser, use `npm run validate:live -- --runtime <pi|claude|opencode|antigravity|all> --scenario <id>`.
6. For live external sites, use `playwright-cli`.

See [`AGENTS.md`](./AGENTS.md) for the compact contributor workflow.

## Debugging by Problem Type

### First stop for almost all troubleshooting

Read:
- [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)
- [`docs/SHARP-EDGES.md`](./docs/SHARP-EDGES.md)

Useful commands:

```bash
npm run debug:where -- <session-id-or-runtime-session-id-or-path>
sudo journalctl -u pi-web-ui -f
curl http://localhost:<server-port>/api/health/live
curl http://localhost:<server-port>/api/health/ready
curl http://localhost:<server-port>/api/config/validate
```

### WebSocket / streaming / session routing

Check:
- browser DevTools → Network → WS
- `server/src/websocket/connection.ts`
- `server/src/websocket/session-websocket.ts`
- `client/src/store/sessionStore.ts`

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

### Claude runtime

Check:
- `server/src/claude/claude-service.ts`
- `server/src/claude/claude-process-pool.ts`
- `server/src/claude/claude-channel-service.ts`
- `server/src/claude/claude-channel-process-manager.ts`
- `pi-claude-channel/server.ts`

Useful checks:

```bash
which claude
claude auth status --json
sudo journalctl -u pi-web-ui -f
sudo journalctl -u pi-web-ui -f | grep ClaudeChannel
```

See [`docs/CLAUDE-BACKENDS.md`](./docs/CLAUDE-BACKENDS.md).

### OpenCode Direct

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

### Antigravity

Check:
- `server/src/antigravity/antigravity-service.ts`
- `server/src/antigravity/antigravity-session-store.ts`
- `server/src/antigravity/antigravity-history-replay.ts`

Useful checks:

```bash
agy --version
agy models
agy -p "Reply OK"
curl "http://localhost:<server-port>/api/models?sdkType=antigravity"
```

See [`docs/ANTIGRAVITY-INTEGRATION.md`](./docs/ANTIGRAVITY-INTEGRATION.md).

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
