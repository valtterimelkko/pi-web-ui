# Agent Instructions for Pi Web UI

> Auto-loaded quick guide. Read this first, then follow the canonical docs linked below.

## Start Here

- **Maintainer docs / runbook:** [`docs/MAINTAINER-INDEX.md`](./docs/MAINTAINER-INDEX.md)
- **Public project overview:** [`README.md`](./README.md)
- **Troubleshooting / logs / session files:** [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)
- **Architecture:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **WebSocket protocol:** [`docs/PROTOCOL.md`](./docs/PROTOCOL.md)
- **REST/API index:** [`API.md`](./API.md)
- **Security rules:** [`SECURITY.md`](./SECURITY.md)
- **Deployment / ops:** [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- **Pi worker isolation design:** [`docs/PROCESS-ISOLATION-DESIGN.md`](./docs/PROCESS-ISOLATION-DESIGN.md)
- **OpenCode design:** [`docs/OPENCODE-DIRECT-INTEGRATION.md`](./docs/OPENCODE-DIRECT-INTEGRATION.md)
- **Antigravity design:** [`docs/ANTIGRAVITY-INTEGRATION.md`](./docs/ANTIGRAVITY-INTEGRATION.md)
- **Code map:** [`docs/CODEBASE-MAP.md`](./docs/CODEBASE-MAP.md)
- **Event pipeline:** [`docs/EVENT-PIPELINE.md`](./docs/EVENT-PIPELINE.md)
- **Known sharp edges:** [`docs/SHARP-EDGES.md`](./docs/SHARP-EDGES.md)

## Quick Reference — If you need to change X, read Y

| Task | File(s) |
|---|---|
| WebSocket message / protocol type | `shared/src/protocol-types.ts`, `server/src/websocket/protocol.ts`, `client/src/store/sessionStore.ts` |
| Runtime-specific replay / events | `server/src/<runtime>/<runtime>-event-*.ts`, `server/src/<runtime>/<runtime>-history-replay.ts` |
| Session lifecycle / cleanup / pinning | `server/src/pi/multi-session-manager.ts` |
| Add a REST route | `server/src/routes/*.ts` → add `cookieAuthMiddleware` |
| Auth / CSRF / security | `server/src/security/*.ts`, `SECURITY.md` |
| Config / env var | `server/src/config.ts`, `.env.example`, `DEPLOYMENT.md` |
| Find logs / session files fast | `docs/TROUBLESHOOTING.md`, `npm run debug:where -- <session-id-or-runtime-session-id-or-path>` |
| Run browserless live validation | `docs/LIVE-VALIDATION.md`, `npm run validate:live -- --runtime <pi|claude|opencode|antigravity|all> --scenario <id>` |
| Add a new runtime | See [`docs/ADDING-A-RUNTIME.md`](./docs/ADDING-A-RUNTIME.md) |
| Fix a frontend store issue | `client/src/store/sessionStore.ts` |
| UI component / modal | `client/src/components/Session/NewSessionModal.tsx` |

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
6. **Before commit/push:** explicitly verify that no secrets, local env files, tokens, auth dumps, session files, cookies, or machine-specific private artifacts are being added.

## Repository Hygiene / Secret-Safety Rules

Treat this repo as permanently public.

### Never commit
- `.env`, `.env.local`, `.env.production`, `.env.production.bak`, `server/.env`, or any other live env file
- API keys, bearer tokens, OAuth refresh tokens, cookies, auth.json files, or copied credential snippets
- real session logs, transcript dumps, local socket tokens, browser storage dumps, or exported request captures containing private data
- private machine notes under folders that are intentionally kept local-only (for example `agent-os/`)

### Always use placeholders in tracked examples
- Keep `.env.example` limited to dummy/example values only
- Use obvious fake values in tests and docs
- Never replace placeholders in tracked files with working credentials “just temporarily”

### Respect `.gitignore`
- If a file is meant to stay local-only, make sure it is gitignored before generating or editing it
- If you create a new class of sensitive local artifact, update `.gitignore` in the same change
- Do not use `git add -f` on ignored secret-bearing files

### Check before committing
Run at least:
```bash
git status --short
git diff --stat
git diff --cached --stat
```
If anything looks like an env file, credential file, session artifact, local runbook dump, or unexpected generated output, stop and inspect before committing.

## Repo Map

- `client/` — React + Vite frontend
- `server/` — Express server, REST routes, WebSocket handlers, runtime integrations
- `shared/` — shared protocol and type definitions
- `tests/` — Playwright E2E tests and benchmark scripts
- `server/tests/` — server unit/integration tests
- `extensions/` — local extension code
- `docs/` — canonical architecture / protocol / design notes

## Architecture Facts You Should Know

- Frontend: **React + Zustand + Vite**
- Backend: **Express + WebSocket**
- Protocol: **JSON message protocol over `/ws`** with session-aware event routing
- Four runtime paths:
  - **Pi Coding Agent** — Pi-native sessions, extensions, worker lifecycle, `~/.pi/agent/sessions/`
  - **Claude runtime** — legacy `claude -p` subprocesses or the channel-backed Claude Code path; replay store in `~/.pi-web-ui/claude-sessions/`, native Claude state in `~/.claude/projects/`
  - **OpenCode** — `opencode serve` backend for OpenCode/Z.AI GLM sessions, with Pi Web UI storing registry metadata only
  - **Antigravity** — `agy -p` subprocess-per-turn Gemini path with Pi-owned turn logs in `~/.pi-web-ui/antigravity-sessions/` and agy-owned conversation DBs in `~/.gemini/antigravity-cli/conversations/`
- Unified session registry: `~/.pi-web-ui/session-registry.json`

## Key Files

- `client/src/store/sessionStore.ts` — main frontend session state
- `client/src/hooks/useWebSocket.ts` — client WebSocket actions
- `client/src/components/Session/NewSessionModal.tsx` — runtime picker
- `server/src/websocket/connection.ts` — main runtime router and event fanout
- `server/src/websocket/protocol.ts` — shared WebSocket message types
- `server/src/pi/multi-session-manager.ts` — Pi Coding Agent lifecycle / cleanup / pinning
- `server/src/claude/claude-service.ts` — Claude runtime lifecycle and backend selection
- `server/src/opencode/opencode-service.ts` — OpenCode lifecycle and replay
- `server/src/antigravity/antigravity-service.ts` — Antigravity lifecycle, prompt dispatch, and replay
- `server/src/session-registry.ts` — unified cross-runtime session index
- `server/src/routes/models.ts` / `server/src/routes/health.ts` — runtime-aware REST endpoints

## Non-Negotiable Security Rules

- Add `cookieAuthMiddleware` to protected REST routes.
- Validate inputs with Zod or equivalent schema checks.
- Validate file paths before file access.
- Run prompt-injection detection before forwarding user text to any runtime.
- Preserve origin, auth, and CSRF protections when changing WebSocket or auth code.

See [`SECURITY.md`](./SECURITY.md) for the canonical security model.

## Debugging Entry Points

- **WebSocket / routing:** `server/src/websocket/connection.ts`, `server/src/websocket/session-websocket.ts`
- **Auth / CSRF:** `server/src/security/auth.ts`, `server/src/security/csrf.ts`, `server/src/middleware/auth.ts`
- **Pi Coding Agent path:** `server/src/pi/multi-session-manager.ts`, `server/src/workers/worker-pool.ts`
- **Claude runtime:** `server/src/claude/claude-service.ts`, `server/src/claude/claude-process-pool.ts`, `server/src/claude/claude-channel-service.ts`, `server/src/claude/claude-channel-process-manager.ts`
- **OpenCode:** `server/src/opencode/opencode-service.ts`, `server/src/opencode/opencode-process-manager.ts`, `server/src/opencode/opencode-client.ts`
- **Antigravity:** `server/src/antigravity/antigravity-service.ts`, `server/src/antigravity/antigravity-session-store.ts`, `server/src/antigravity/antigravity-history-replay.ts`
- **Registry / persistence:** `server/src/session-registry.ts`
- **Health / config:** `server/src/routes/health.ts`, `server/src/routes/config.ts`, `server/src/routes/models.ts`

Use [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) for practical debugging commands, log locations, and session-file lookup.

## UI / Product Conventions

- The app uses a **light theme**.
- Keep runtime differences understandable, but avoid noisy raw tool chatter unless the feature explicitly needs it.
- Keep the unified-session UX intact across Pi Coding Agent, the Claude runtime family, and OpenCode.
- Do not rely on historical test counts in old docs; run the current checks.

## Handy Commands

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run debug:where -- <session-id-or-runtime-session-id-or-path>
npm run opencode:refresh-models   # refresh OpenCode model catalogue (Kilo/Zen), see docs/OPENCODE-MODEL-AUTOMATION.md
```

### Live Validation

After making runtime-related changes, run the browserless live-validation
runner before pushing:

```bash
npm run validate:live -- --runtime claude --scenario smoke
```

For Claude channel-specific work, also run:

```bash
npm run validate:live -- --runtime claude --scenario channel-heartbeat
npm run validate:live -- --runtime claude --scenario tool-visibility
npm run validate:live -- --runtime claude --scenario session-info
npm run validate:live -- --runtime claude --scenario follow-up
```

The runner uses the Internal API over the local Unix socket, auto-loads the
internal API token, creates ephemeral sessions, streams normalized events, and
cleans up afterwards — no browser login required. For runtime debugging, start
with `npm run debug:where -- <session-id-or-runtime-session-id-or-path>`, then
read [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md). See also
[`docs/LIVE-VALIDATION.md`](./docs/LIVE-VALIDATION.md),
[`docs/CLAUDE-BACKENDS.md`](./docs/CLAUDE-BACKENDS.md), and
[`docs/ANTIGRAVITY-INTEGRATION.md`](./docs/ANTIGRAVITY-INTEGRATION.md).

## Final Rule

If a topic is already documented deeply elsewhere, **link to the canonical doc instead of duplicating it here**.
