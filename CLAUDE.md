# AGENTS.md — pi-web-ui

> `AGENTS.md` and `CLAUDE.md` are byte-identical. Edit `AGENTS.md`, then `cp AGENTS.md CLAUDE.md`.

## Purpose

Pi Web UI is a **standardisation and orchestration layer** over five runtime families — Pi Coding Agent, Claude Code,
OpenCode, Antigravity and Command Code (behind the `COMMAND_CODE_ENABLED` gate): one session registry, an Internal API
for orchestrating children across harnesses, and a runtime-agnostic browser UI. It is the production control plane on
this host, and the repo is treated as permanently public. Public positioning: `README.md`,
`docs/ORCHESTRATION-OVERVIEW.md`.

## Binding rules

1. **Session-ID troubleshooting.** When troubleshooting starts from a session ID, runtime-native ID, registry path, or "this session is broken" report, do not begin with a repository-wide grep: run `npm run debug:where -- --json <id-or-path>` first, then use the authenticated `GET /api/v1/sessions/:id/evidence` bundle.
2. **Required workflow.** Use TDD for code changes. Keep diffs minimal. Prefer canonical docs over duplicating repo knowledge here.
3. **Localhost UI changes:** use `webapp-testing`.
4. **Live/external browser validation only:** use `playwright-cli`.
5. **Talker gate.** Voice Mode's talker harness is a mechanical confirm-gated relay: **never widen the gate's reachability**.
6. **Internal API contract bump:** keep the downstream Agent OS mirror in step before merging — see `docs/INTERNAL-API-CONTRACT.md` → "Downstream mirrors" (the version source of truth, the three mirror files, and the cross-repo sync test that catches drift).
7. **Non-negotiable security and correctness rules:**
   - Add `cookieAuthMiddleware` to protected REST routes.
   - Validate request/input shapes with Zod or equivalent.
   - Validate file paths before file access.
   - Run prompt-injection detection before forwarding user text to any runtime.
   - Preserve auth, origin, and CSRF protections when changing WebSocket or auth code.
   - Treat the repo as permanently public; never commit live env files, real tokens, cookies, or transcript/session dumps.
8. **Runtime-aware validation.** Use production only with explicit user permission plus `--allow-production`; Antigravity needs a separately authorised workflow because it is disabled in disposable mode, and Command Code is outside disposable `all`.
9. **Final rule.** If a topic is already documented deeply elsewhere, **link to the canonical doc instead of expanding this file**.

## Start here

| If you need … | Read … |
|---|---|
| A 2-minute orientation | `docs/AGENT-ORIENTATION.md` |
| The maintainer index | `docs/MAINTAINER-INDEX.md` |
| To change a specific area (task → files → doc) | `AGENT-REFERENCE.md` (`## If you need to change X, read Y`) |
| The architecture, codebase map or event pipeline | `docs/ARCHITECTURE.md`, `docs/CODEBASE-MAP.md`, `docs/EVENT-PIPELINE.md` |
| The protocol (WebSocket / runtime) | `docs/PROTOCOL.md` |
| Security musts | `SECURITY.md` |
| Deployment and ops | `DEPLOYMENT.md` |
| To diagnose a session or read logs | `docs/TROUBLESHOOTING.md` (its session-ID evidence ladder first) |
| Observability: logging, diagnostics, error codes | `docs/OBSERVABILITY.md` |
| Known sharp edges | `docs/SHARP-EDGES.md` |
| Internal API, orchestration or live validation | `docs/INTERNAL-API.md`, `docs/INTERNAL-API-ORCHESTRATION.md`, `docs/LIVE-VALIDATION.md` |
| A surface the command centre (Wheelhouse) consumes (Internal API routes, the session registry, notifications, `packages/session-core` and `packages/session-ui`) | `/root/command-centre` — its DEPENDENCIES.md |
| Voice Mode | `docs/VOICE-MODE-INDEX.md` |
| Cross-repo strategic context and current status | `AGENT-REFERENCE.md` (`## Cross-repo strategic context`) |
| The high-signal file map and runtime validation shortcuts | `AGENT-REFERENCE.md` (`## High-signal file map`, `## Runtime-aware validation shortcuts`) |
| The public overview and the orchestration story | `README.md`, `docs/ORCHESTRATION-OVERVIEW.md` |

## Validate & commit

- Docs: `npm run docs:check-agent-guides`, `npm run docs:check-links`; `npm run docs:check-status` after touching a Voice Mode document.
- Code: `npm run lint`, `npm run typecheck`, `npm run build`, relevant tests (`npm test`, workspace tests, E2E or runtime validation as appropriate).
- Runtime validation: read `docs/LIVE-VALIDATION.md` and run the relevant scenario(s); disposable/local only unless the owner gives explicit permission plus `--allow-production`.
- Guide edits: `guide-check repo .` before committing; keep `AGENTS.md` and `CLAUDE.md` byte-identical.
- Deploy/restart: follow `DEPLOYMENT.md`; a live production change needs the owner's approval.
- Push rule: commit and push completed changes on the current branch; stage explicit paths, never a dirty tree wholesale.

## Current state

Current status and cross-repo strategic context: `AGENT-REFERENCE.md` (`## Cross-repo strategic context`) and the canonical plans it names (`docs/plans/ORCHESTRATION-SCALING-READINESS-PLAN.md`, `docs/plans/PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md`).
