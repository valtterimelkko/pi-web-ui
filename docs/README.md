# Docs Index

Reading order for LLM coding agents working on Pi Web UI.

If you are debugging anything runtime-related, start with [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) and `npm run debug:where -- <session-id-or-runtime-session-id-or-path>` before reading deeper architecture docs.

## 1. Agent quick start
- [`AGENTS.md`](../AGENTS.md) — Kimi / PAI agent entry point
- [`CLAUDE.md`](../CLAUDE.md) — Claude Code agent entry point (same content as `AGENTS.md`)

## 2. First-stop debugging
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — Fastest path to logs, session files, registry inspection, and runtime-specific diagnosis
- `npm run debug:where -- <session-id-or-runtime-session-id-or-path>` — quickest session-to-log/session-file locator

## 3. System structure
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — High-level architecture, runtime paths, responsibilities
- [`CODEBASE-MAP.md`](./CODEBASE-MAP.md) — Granular file-to-purpose index
- [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md) — How native events from Pi, Claude, OpenCode, and Antigravity converge into one frontend stream

## 4. WebSocket contract
- [`PROTOCOL.md`](./PROTOCOL.md) — Message types, connection lifecycle, error codes

## 5. Runtime deep-dives
- [`PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md) — Pi SDK worker architecture
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md) — Claude legacy-direct vs channel-backed backend modes, logs, and failure modes
- [`CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN.md`](./CLAUDE-CHANNEL-NATIVE-HOOK-ROUTING-DESIGN.md) — Proposed safer design for routing richer native Claude hook events into the Web UI
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md) — OpenCode Direct architecture
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md) — Antigravity / `agy` architecture, logs, and failure modes

## 6. Integration & extension
- [`ADDING-A-RUNTIME.md`](./ADDING-A-RUNTIME.md) — Checklist for adding a new runtime
- [`SHARP-EDGES.md`](./SHARP-EDGES.md) — Known traps and brittle patterns

## 7. Operations
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — Fastest path to logs, session files, and runtime-specific diagnosis
- [`DEPLOYMENT.md`](../DEPLOYMENT.md) — Production runbook, systemd, nginx
- [`SECURITY.md`](../SECURITY.md) — Security model, threat mitigations, rules
- [`API.md`](../API.md) — REST API surface index

## 8. Tests
- [`tests/README.md`](../tests/README.md) — Test layers, running commands

## 9. Features
- [`DRIVE-MODE.md`](./DRIVE-MODE.md) — current Drive Mode feature overview
