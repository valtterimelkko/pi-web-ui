# Agent Instructions for Pi Web UI

> **For users**: See [README.md](./README.md). This document is for developers/agents working on the codebase.

## Your Role

Improve the Pi Web UI with test-driven development. Verify changes via:
1. `webapp-testing` skill — local dev server testing
2. `playwright-cli` skill — live site testing (`https://pi.letsautomate.work`)
3. `npm test` — unit + integration test suite

## Architecture

```
Browser (React + Vite)
  └─ WebSocket /ws  ──────────────────────────────────────────────────────────
                                                                              │
Express Server (server/src/)                                                  │
  ├─ websocket/connection.ts          ← main WS handler, message dispatcher  │
  ├─ pi/multi-session-manager.ts      ← Pi SDK session lifecycle             │
  ├─ workers/worker-pool.ts           ← Pi SDK worker processes              │
  ├─ claude/claude-service.ts         ← Claude Direct session lifecycle      │
  ├─ claude/claude-process-pool.ts    ← claude -p subprocess pool            │
  ├─ session-registry.ts              ← unified session index (both SDKs)    │
  └─ routes/                          ← REST API                             │

Session storage:
  ~/.pi/agent/sessions/               ← Pi SDK sessions (JSONL)
  ~/.pi-web-ui/claude-sessions/       ← Claude Direct sessions (JSONL)
  ~/.pi-web-ui/session-registry.json  ← unified index
```

### Dual-SDK Session Paths

**Pi SDK** — persistent worker process per session (`pi --mode rpc`)
- Managed by `MultiSessionManager` + `WorkerPool`
- All providers, all extensions, model switching
- Sessions stored in `~/.pi/agent/sessions/`

**Claude Direct** — ephemeral `claude -p` subprocess per turn
- Managed by `ClaudeService` + `ClaudeProcessPool`
- **First turn**: `claude -p --session-id <uuid>` (creates session)
- **Follow-up turns**: `claude -p --resume <uuid>` (avoids session lock)
- `ANTHROPIC_API_KEY` is explicitly stripped — forces subscription auth, not API key
- Sessions stored in `~/.pi-web-ui/claude-sessions/`
- Multiple Claude Direct sessions are fully isolated; sessions can coexist in sidebar

### Frontend Key Files
| File | Purpose |
|------|---------|
| `client/src/websocket/connection.ts` | Main WS message handler |
| `client/src/store/sessionStore.ts` | Zustand store, all WS event handling |
| `client/src/hooks/useWebSocket.ts` | WS send helpers (sendPrompt, setModel etc.) |
| `client/src/components/Chat/` | Chat UI, message bubbles, tool cards |
| `client/src/components/Session/NewSessionModal.tsx` | Session creation + SDK selector |
| `client/src/components/Settings/SettingsModal.tsx` | Model selector (filters by SDK type) |

## Development Workflow

```bash
npm install          # install deps
npm run dev          # start dev servers (client + server)
npm run build        # TypeScript compile + Vite build
npm test             # run all tests (735+ passing)
npm run test:e2e     # Playwright E2E tests
```

### Making Changes
1. Write tests first (TDD)
2. Make minimal changes
3. `npm run build` — must pass
4. `npm test` — must not regress
5. Deploy: `npm run build && sudo systemctl restart pi-web-ui`

## Debugging

### WebSocket issues
- Browser DevTools → Network → WS for connection status
- Close code 1006 = abnormal close; check `ALLOWED_ORIGINS` in `.env.production`
- Key file: `server/src/websocket/connection.ts`

### Claude Direct issues
```bash
which claude                        # must be on PATH
claude auth status --json           # must show loggedIn: true
sudo journalctl -u pi-web-ui -f     # look for [ClaudeService] or [ClaudeProcessPool]
```
Common problems:
- `claude` not in PATH for systemd → check `Environment=PATH=` in service file (must include `/root/.local/bin`)
- "Session ID already in use" → handled by retry + `--resume` logic; if persistent, check for hung `claude` processes: `ps aux | grep "claude -p"`

### Pi SDK worker issues
```bash
ps aux | grep "pi --mode rpc"       # list active workers
curl http://localhost:3456/api/health/ready | jq '.workerStats'
```

### Auth / 401 errors
- Check JWT cookie in browser DevTools → Application → Cookies
- Key files: `server/src/security/auth.ts`, `server/src/security/csrf.ts`

### Health endpoints
```bash
curl http://localhost:3456/api/health/live    # liveness
curl http://localhost:3456/api/health/ready   # readiness + worker stats
curl http://localhost:3456/api/config/validate
```

## UI Style Guide

The UI uses a **light theme**:
- Backgrounds: `bg-white`, `bg-gray-50`, `bg-gray-100`
- Primary accent: `bg-gray-900`, `text-blue-600`
- Text: `text-gray-900` (primary), `text-gray-500` (secondary)
- Claude Direct badge: `bg-amber-100 text-amber-700`

When adding components, match the existing light theme. Do NOT use the dark slate palette (`bg-slate-900` etc.) — that was replaced.

## Adding a Component
1. `client/src/components/MyComponent/MyComponent.tsx` + `index.ts`
2. Export from `client/src/components/index.ts`
3. Add tests in `client/tests/unit/components/`

## Adding an API Endpoint
1. `server/src/routes/my-feature.ts` — add `cookieAuthMiddleware` + `apiLimiter`
2. Mount in `server/src/app.ts`
3. Add tests in `server/tests/unit/routes/`

## Testing

```bash
npm test                                                    # all tests
npm test -- server/tests/unit/security/auth.test.ts        # specific file
npm run test:e2e                                            # E2E (requires server running)
```

**Current status:** 735/737 passing. 2 pre-existing failures in `terminal-manager.test.ts` (unrelated to main functionality).

## Security Rules

- Always add `router.use(cookieAuthMiddleware)` on protected routes
- Validate all input with Zod schemas
- Validate file paths before access (`validatePath()`)
- Run `detectPromptInjection()` on user input before forwarding to AI

## Known Issues

1. Session tree navigation doesn't sync with CLI forks (workaround: refresh)
2. Extension UI timeout hardcoded to 30s (`server/src/pi/extension-ui-handler.ts`)
3. Claude Direct requires `claude auth login` to have been run on the server

## Resources

- [README.md](./README.md) — user docs, deployment, feature list
- [API.md](./API.md) — WebSocket + REST protocol reference
- [SECURITY.md](./SECURITY.md) — security architecture
- [DEPLOYMENT.md](./DEPLOYMENT.md) — production deployment guide
