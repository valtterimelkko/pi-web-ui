# Agent Instructions for Pi Web UI

> Root quick guide for agents working on Pi Web UI itself. Keep this file concise and follow the canonical docs it links to.

## Sync rule

- `AGENTS.md` and `CLAUDE.md` are intended to stay **byte-identical**.
- Treat `AGENTS.md` as the maintainer source in normal workflow.
- After editing this file, regenerate/check with:
  - `npm run docs:sync-agent-guides`
  - `npm run docs:check-agent-guides`

## Start here

- **Maintainer index:** [`docs/MAINTAINER-INDEX.md`](./docs/MAINTAINER-INDEX.md)
- **Public overview:** [`README.md`](./README.md)
- **Architecture:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Codebase map:** [`docs/CODEBASE-MAP.md`](./docs/CODEBASE-MAP.md)
- **Event pipeline:** [`docs/EVENT-PIPELINE.md`](./docs/EVENT-PIPELINE.md)
- **Protocol:** [`docs/PROTOCOL.md`](./docs/PROTOCOL.md)
- **Security:** [`SECURITY.md`](./SECURITY.md)
- **Deployment:** [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- **Troubleshooting / logs / session files:** [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)
- **Observability (logging/diagnostics/errors):** [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md)
- **Sharp edges:** [`docs/SHARP-EDGES.md`](./docs/SHARP-EDGES.md)

## What this repo is now

Pi Web UI is a **runtime-agnostic browser UI** over four runtime families:

- **Pi Coding Agent**
- **Claude Code**
- **OpenCode**
- **Antigravity**

Core architectural themes:

- keep the **frontend mostly runtime-neutral**
- keep **runtime-specific complexity on the server**
- unify sessions through a **shared registry** and **common replay/event model**
- treat the **Internal API / orchestration surface** as a first-class backend boundary, not a side utility
- preserve cross-runtime product surfaces such as **session transfer** and **Drive Mode**
- distinguish **core repo behavior** from companion-powered behavior; see [`docs/RUNTIME-COMPANIONS.md`](./docs/RUNTIME-COMPANIONS.md)

## If you need to change X, read Y

| Task | Read first |
|---|---|
| WebSocket message / protocol change | `shared/src/protocol-types.ts`, `server/src/websocket/protocol.ts`, `client/src/store/sessionStore.ts`, [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) |
| Runtime-specific replay / event normalization | `server/src/<runtime>/<runtime>-event-*.ts`, `server/src/<runtime>/<runtime>-history-replay.ts`, [`docs/EVENT-PIPELINE.md`](./docs/EVENT-PIPELINE.md) |
| Pi session lifecycle / cleanup / pinning | `server/src/pi/multi-session-manager.ts`, [`docs/PROCESS-ISOLATION-DESIGN.md`](./docs/PROCESS-ISOLATION-DESIGN.md) |
| Claude backend behavior | `server/src/claude/*`, [`docs/CLAUDE-BACKENDS.md`](./docs/CLAUDE-BACKENDS.md) |
| Claude provider profiles / backend switching | `server/src/claude/claude-profiles.ts`, `server/src/claude/claude-sdk-service.ts`, [`docs/CLAUDE-PROVIDER-PROFILES.md`](./docs/CLAUDE-PROVIDER-PROFILES.md) |
| OpenCode integration / model automation | `server/src/opencode/*`, [`docs/OPENCODE-DIRECT-INTEGRATION.md`](./docs/OPENCODE-DIRECT-INTEGRATION.md), [`docs/OPENCODE-MODEL-AUTOMATION.md`](./docs/OPENCODE-MODEL-AUTOMATION.md) |
| Pi runtime: OpenRouter model automation | `server/src/pi/pi-openrouter-refresh.ts`, `server/src/pi/pi-service.ts`, [`docs/PI-OPENROUTER-MODEL-AUTOMATION.md`](./docs/PI-OPENROUTER-MODEL-AUTOMATION.md) |
| Antigravity integration | `server/src/antigravity/*`, [`docs/ANTIGRAVITY-INTEGRATION.md`](./docs/ANTIGRAVITY-INTEGRATION.md) |
| Session transfer | `server/src/session-transfer/*`, [`docs/CODEBASE-MAP.md`](./docs/CODEBASE-MAP.md) |
| Drive Mode | `client/src/components/DriveMode/*`, `client/src/store/driveModeStore.ts`, [`docs/CODEBASE-MAP.md`](./docs/CODEBASE-MAP.md) |
| Internal API / orchestration / live validation | `server/src/internal-api/*`, `scripts/live-validate.ts`, [`docs/INTERNAL-API.md`](./docs/INTERNAL-API.md), [`docs/INTERNAL-API-ORCHESTRATION.md`](./docs/INTERNAL-API-ORCHESTRATION.md), [`docs/LIVE-VALIDATION.md`](./docs/LIVE-VALIDATION.md) |
| Long-horizon validation / durable watches | `server/src/internal-api/watch/*`, `server/src/live-validation/long-horizon-runner.ts`, `scripts/long-horizon-validate.ts`, [`docs/LONG-HORIZON-VALIDATION.md`](./docs/LONG-HORIZON-VALIDATION.md) |
| Notifications (Telegram on `agent_end`) | `server/src/notifications/*`, `server/src/internal-api/routes/notifications.ts`, `server/src/live-validation/scenarios.ts`, [`docs/NOTIFICATIONS.md`](./docs/NOTIFICATIONS.md) |
| Add a REST route | `server/src/routes/*.ts` and `cookieAuthMiddleware`; then read [`SECURITY.md`](./SECURITY.md) |
| Auth / CSRF / prompt-injection / path validation | `server/src/security/*`, `server/src/middleware/auth.ts`, [`SECURITY.md`](./SECURITY.md) |
| Config / env vars / ops | `server/src/config.ts`, `.env.example`, [`DEPLOYMENT.md`](./DEPLOYMENT.md) |
| Fast log or session-file lookup | [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md), `npm run debug:where -- <id-or-path>` |
| Logging / levels / namespaces / correlation / diagnostics / error codes | `server/src/logging/*`, `server/src/internal-api/error-codes.ts`, `server/src/internal-api/diagnostics-buffer.ts`, [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) |

## High-signal file map

- `client/src/store/sessionStore.ts` — main session state and replay handling
- `client/src/store/filesStore.ts` + `components/Files/MarkdownEditor.tsx` — Files tab: file tree + Markdown source editor with GFM live preview (explicit Save via `/api/files/write`; truncated files read-only)
- `client/src/hooks/useWebSocket.ts` — browser WebSocket actions
- `server/src/websocket/connection.ts` — main runtime-aware router
- `server/src/session-registry.ts` — unified cross-runtime session index
- `server/src/pi/multi-session-manager.ts` — Pi lifecycle / pinning / cleanup
- `server/src/claude/claude-service.ts` — Claude lifecycle and backend selection
- `server/src/claude/claude-profiles.ts` — provider profile schema, validation, and launch resolution
- `server/src/claude/claude-sdk-service.ts` — SDK backend (preferred for profiles)
- `server/src/opencode/opencode-service.ts` — OpenCode lifecycle / replay / permissions
- `server/src/antigravity/antigravity-service.ts` — Antigravity lifecycle / replay
- `server/src/session-transfer/*` — cross-runtime transcript transfer
- For broader discovery, use [`docs/CODEBASE-MAP.md`](./docs/CODEBASE-MAP.md)

## Required workflow

1. **Use TDD for code changes.**
2. **Keep diffs minimal.**
3. **Prefer canonical docs over duplicating repo knowledge here.**
4. **Run relevant validation before finishing:**
   - `npm run docs:check-agent-guides`
   - `npm run lint`
   - `npm run typecheck`
   - `npm run build`
   - relevant tests (`npm test`, workspace tests, E2E, or runtime validation as appropriate)
5. **For localhost UI changes:** use `webapp-testing`.
6. **For live/external browser validation only:** use `playwright-cli`.
7. **Before commit/push:** inspect `git status --short`, `git diff --stat`, and `git diff --cached --stat`.
8. **Before commit/push:** explicitly verify no secrets, tokens, cookies, auth dumps, session artifacts, or local machine files are being added.

## Non-negotiable security and correctness rules

- Add `cookieAuthMiddleware` to protected REST routes.
- Validate request/input shapes with Zod or equivalent.
- Validate file paths before file access.
- Run prompt-injection detection before forwarding user text to any runtime.
- Preserve auth, origin, and CSRF protections when changing WebSocket or auth code.
- Treat the repo as permanently public; never commit live env files, real tokens, cookies, or transcript/session dumps.

## Runtime-aware validation shortcuts

- General checks: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`
- Browserless runtime validation: start `npm run validate:server`, then run `npm run validate:live -- --socket <validation.sock> --token-path <validation-token> --runtime <pi|claude|opencode|antigravity|all> --scenario <id>`; use production only with explicit user permission plus `--allow-production`.
- Claude provider profile validation: start a profiles-enabled validation server, then run `npm run validate:claude-profiles -- --socket <sock> --token-path <token> --glm-profile <id> --native-profile <id>`; see [`docs/CLAUDE-PROVIDER-PROFILES.md`](./docs/CLAUDE-PROVIDER-PROFILES.md).
- Long-horizon (autonomous, restart-surviving) validation: start `npm run validate:server`, then run `npm run validate:long-horizon -- --socket <validation.sock> --token-path <validation-token> --subject <runtime> --seed "<prompt>" --watch-text <substr> --interval <seconds>` — see [`docs/LONG-HORIZON-VALIDATION.md`](./docs/LONG-HORIZON-VALIDATION.md)
- Fast runtime/session lookup: `npm run debug:where -- <session-id-or-runtime-id-or-path>`
- OpenCode model catalogue refresh: `npm run opencode:refresh-models`
- Pi runtime OpenRouter catalogue refresh: `npm run pi:refresh-models` (see [`docs/PI-OPENROUTER-MODEL-AUTOMATION.md`](./docs/PI-OPENROUTER-MODEL-AUTOMATION.md))

If you touch runtime behavior, read [`docs/LIVE-VALIDATION.md`](./docs/LIVE-VALIDATION.md) and run the relevant scenario(s).

## Final rule

If a topic is already documented deeply elsewhere, **link to the canonical doc instead of expanding this file**.
