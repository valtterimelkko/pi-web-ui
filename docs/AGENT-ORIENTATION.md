# Agent orientation — /root/pi-web-ui

You are an agent working **on** Pi Web UI: a runtime-agnostic browser UI over five agent runtimes (Pi, Claude Code, OpenCode, Antigravity, Command Code). Repo guide: [`../AGENTS.md`](../AGENTS.md).

## Layout
- `server/` — Express/Node API: runtimes under `server/src/<runtime>/`, Internal API under `server/src/internal-api/`, WebSocket router `server/src/websocket/connection.ts`.
- `client/` — Vite/React UI (`client/src/`): stores in `store/`, voice surface in `components/DriveMode/`.
- `shared/` — wire contract types (`shared/src/protocol-types.ts` is **the contract**).
- `packages/internal-api-mcp/` — inactive MCP experiment; do not enable.

## Logs
`journalctl -u pi-web-ui` (systemd journal). Session lookup first: `npm run debug:where -- <id-or-path>`.

## Observability
- `GET /api/v1/diagnostics` — bounded scrubbed records + `.operational` counters (voice: `.operational.voice`).
- `GET /api/v1/capacity` — active turns / admission headroom.
- Canonical: [`OBSERVABILITY.md`](./OBSERVABILITY.md); troubleshooting ladder: [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).

## Test & verify
`npm test` · `npm run lint:ratchet` (ceiling policy: [`../tests/README.md`](../tests/README.md)) · `npm run validate:server` + `validate:live` (real runtimes, disposable server) · `npm run docs:check-links` and `docs:check-agent-guides` after doc edits.

## Safety boundaries
- **NEVER edit the host Caddyfile or Authelia config without explicit operator approval** — they front production auth.
- Validate ONLY against disposable servers (`npm run validate:server`). NEVER production, and never `--allow-production` without the operator's explicit permission.
- Never commit secrets, tokens, cookies, transcripts, or env files. Secrets live outside the repo (see [`../SECURITY.md`](../SECURITY.md) §Secrets hygiene).
- TDD for behaviour changes; restart of the production service is owner-gated.

## Docs map
- **Inward (you, maintainer):** `AGENTS.md` → [`MAINTAINER-INDEX.md`](./MAINTAINER-INDEX.md) → canonical docs (`ARCHITECTURE`, `CODEBASE-MAP`, `EVENT-PIPELINE`, `PROTOCOL`, `OBSERVABILITY`, `SHARP-EDGES`, per-runtime deep dives).
- **Outward (adopters/integrators):** root `README.md`, `docs/GETTING-STARTED.md`, `docs/RUNTIME-OVERVIEW.md`, `API.md`, `docs/INTERNAL-API*.md`, `DEPLOYMENT.md`, `SECURITY.md`.
- History: `docs/archive/` (indexed) and `docs/plans/` — never cite these as current behaviour; canonical facts live in canonical docs.
