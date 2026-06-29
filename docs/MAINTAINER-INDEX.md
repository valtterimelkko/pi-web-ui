# Maintainer Docs Index

Reading order for contributors, operators, and LLM coding agents working **on Pi Web UI itself**.

Many docs below intentionally contain concrete paths, socket locations, service names, and maintainer runbook commands because this repository doubles as a live operational manual.

If you are debugging anything runtime-related, start with [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) and `npm run debug:where -- <session-id-or-runtime-session-id-or-path>` before reading deeper architecture docs.

## Recent major doc-relevant changes
- **Internal API contract `1.5.0`** — adds notification endpoints for opt-in/out, state, explicit emit, and recent deliveries; previous `1.4.0` screen-view transcript projection remains current
- **Observability/introspection endpoints (`1.3.0`)** — `GET /api/v1/diagnostics`, `GET /api/v1/sessions/:id/diagnostics`, and `GET /api/v1/events/types`
- **Pi runtime OpenRouter model automation** — Pi can now surface a broader OpenRouter-backed model catalogue; see [`PI-OPENROUTER-MODEL-AUTOMATION.md`](./PI-OPENROUTER-MODEL-AUTOMATION.md)
- **Notification layer (Telegram on `agent_end`)** — one-way operator notifications when an agent yields control, across all 4 runtimes, with a durable outbox; see [`NOTIFICATIONS.md`](./NOTIFICATIONS.md)
- **Fast delta summary:** [`RECENT-CHANGES.md`](./RECENT-CHANGES.md)

## 1. Agent quick start
- [`../AGENTS.md`](../AGENTS.md) — agent entry point; canonical source for the root guide
- [`../CLAUDE.md`](../CLAUDE.md) — Claude Code agent entry point; kept byte-identical to `AGENTS.md` via `npm run docs:sync-agent-guides`

## 2. First-stop debugging
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — fastest path to logs, session files, registry inspection, and runtime-specific diagnosis
- `npm run debug:where -- <session-id-or-runtime-session-id-or-path>` — quickest session-to-log/session-file locator

## 3. System structure
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — high-level architecture, runtime paths, responsibilities
- [`CODEBASE-MAP.md`](./CODEBASE-MAP.md) — granular file-to-purpose index
- [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md) — how native events from Pi, Claude, OpenCode, and Antigravity converge into one frontend stream
- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — logging (levels/namespaces/format), correlation IDs, diagnostics endpoint, error-code catalog, request logging, fatal-error handlers

## 4. WebSocket contract
- [`PROTOCOL.md`](./PROTOCOL.md) — message types, connection lifecycle, error codes

## 5. Runtime deep dives
- [`PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md) — Pi Coding Agent worker architecture
- [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md) — which behaviours are core vs enhanced by companion Pi extensions / OpenCode plugins
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md) — all three Claude backend modes (SDK, legacy direct, channel), env vars, logs, and failure modes
- [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md) — operator reference for the provider profile system: field reference, examples (native Claude, GLM 5.2), secrets, safety invariants, validation runner
- [`CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN.md`](./CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN.md) — proposed safer design for routing richer native Claude hook events into the Web UI
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md) — OpenCode architecture, provider auth storage, credential-safe model routing, and the provider allowlist
- [`OPENCODE-MODEL-AUTOMATION.md`](./OPENCODE-MODEL-AUTOMATION.md) — analysis/proposal for keeping the OpenCode model list current (Kilo Gateway, OpenCode Zen) automatically
- [`PI-OPENROUTER-MODEL-AUTOMATION.md`](./PI-OPENROUTER-MODEL-AUTOMATION.md) — keeping the Pi runtime model list current with the OpenRouter gateway automatically (weekly refresh, no secrets stored)
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md) — Antigravity / `agy` architecture, logs, and failure modes

## 6. Internal API and orchestration
- [`INTERNAL-API.md`](./INTERNAL-API.md) — canonical local automation API reference (including transcript vs screen-view vs history read paths)
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md) — task-oriented guide for spawning, monitoring, and collecting child sessions across runtimes
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) — browserless runtime validation runner built on top of the local automation API
- [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md) — durable watches + headless `validate:long-horizon` runner for autonomous, restart-surviving, long-running validation

## 7. Integration & extension
- [`ADDING-A-RUNTIME.md`](./ADDING-A-RUNTIME.md) — checklist for adding a new runtime
- [`SHARP-EDGES.md`](./SHARP-EDGES.md) — known traps and brittle patterns

## 8. Operations
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — production runbook, reverse proxy, service management
- [`../SECURITY.md`](../SECURITY.md) — security model, threat mitigations, rules
- [`../API.md`](../API.md) — WebSocket / REST / local automation API surface index

## 9. Tests
- [`../tests/README.md`](../tests/README.md) — test layers, running commands

## 10. Public-facing context
When you are changing docs or product positioning, also read:
- [`../README.md`](../README.md)
- [`PROJECT-STORY.md`](./PROJECT-STORY.md)
- [`VISION.md`](./VISION.md)
- [`PLATFORM-SUPPORT.md`](./PLATFORM-SUPPORT.md)
