# Agent Instructions for Pi Web UI

> Auto-loaded developer/agent guide. Start here, then open the canonical docs linked below.

## Read These Docs by Task

- **Project overview / runbook:** [`README.md`](./README.md)
- **Architecture:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Wire protocol / WebSocket JSON-RPC:** [`docs/PROTOCOL.md`](./docs/PROTOCOL.md)
- **API index:** [`API.md`](./API.md)
- **Security rules:** [`SECURITY.md`](./SECURITY.md)
- **Deployment / service operations:** [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- **Worker/process isolation design:** [`docs/PROCESS-ISOLATION-DESIGN.md`](./docs/PROCESS-ISOLATION-DESIGN.md)

## Mission

Improve Pi Web UI safely with small, verified changes. Prefer targeted fixes over broad refactors unless the task explicitly requires structural work.

## Required Workflow

1. **Use TDD for code changes.**
2. **Keep diffs minimal.**
3. **Run the relevant checks before finishing:**
   - `npm run lint`
   - `npm run typecheck`
   - `npm run build`
   - relevant tests (`npm test`, workspace tests, or E2E as appropriate)
4. **For UI changes:**
   - use `webapp-testing` for localhost/dev-server verification
   - use `playwright-cli` only for live/external site verification
5. **Before commit/push:** review `git status --short` and `git diff --stat`.

## Repo Map

- `client/` — React + Vite frontend
- `server/` — Express server, WebSocket handlers, Pi/Claude runtime integration
- `shared/` — shared protocol/types package used by server and client
- `tests/` — E2E tests and benchmark scripts
- `extensions/` — local extension code
- `docs/` — deeper architecture/protocol/design docs

## Architecture Facts You Should Know

- Frontend: React + Zustand + Vite
- Backend: Express + WebSocket
- Protocol: JSON-RPC-style messaging over WebSocket
- Two runtime paths:
  - **Pi SDK sessions** via persistent worker processes
  - **Claude Direct sessions** via `claude -p` subprocesses
- Session storage:
  - Pi SDK: `~/.pi/agent/sessions/`
  - Claude Direct: `~/.pi-web-ui/claude-sessions/`
  - unified registry: `~/.pi-web-ui/session-registry.json`

## Key Files

- `client/src/store/sessionStore.ts` — main frontend session state
- `client/src/hooks/useWebSocket.ts` / `client/src/lib/session-websocket.ts` — client WS helpers
- `server/src/websocket/connection.ts` — main upgrade/connection handling
- `server/src/websocket/session-websocket.ts` — per-session WebSocket handling
- `server/src/pi/multi-session-manager.ts` — Pi SDK session lifecycle
- `server/src/workers/worker-pool.ts` — worker process pool
- `server/src/claude/claude-service.ts` — Claude Direct lifecycle
- `server/src/session-registry.ts` — unified session index

## Non-Negotiable Security Rules

- Add `cookieAuthMiddleware` to protected routes.
- Validate inputs with Zod.
- Validate file paths before access.
- Run prompt-injection detection before forwarding user input to the AI runtime.
- Preserve origin / auth / CSRF protections when changing WebSocket or auth code.

See [`SECURITY.md`](./SECURITY.md) for the full security model.

## Debugging Entry Points

- **WebSocket / JSON-RPC:** `server/src/websocket/connection.ts`, `server/src/websocket/session-websocket.ts`
- **Auth / CSRF:** `server/src/security/auth.ts`, `server/src/security/csrf.ts`
- **Pi SDK workers:** `server/src/pi/multi-session-manager.ts`, `server/src/workers/worker-pool.ts`
- **Claude Direct:** `server/src/claude/claude-service.ts`, `server/src/claude/claude-process-pool.ts`
- **Health/config:** `server/src/routes/health.ts`, `server/src/routes/config.ts`

Use [`README.md`](./README.md) for the practical debugging commands by problem type.

## UI / Product Conventions

- The app uses a **light theme**. Match existing light UI styles.
- Avoid introducing noisy UI for raw tool chatter unless the feature explicitly needs it.
- Do not rely on historical “passing test counts” in old docs; run the current checks.

## Handy Commands

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm run build
npm test
npm run test:e2e
```

## Final Rule

If a topic is already documented deeply elsewhere, **link to the canonical doc instead of duplicating it here**.
