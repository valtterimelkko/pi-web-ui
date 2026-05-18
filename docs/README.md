# Docs Index

Reading order for LLM coding agents working on Pi Web UI.

## 1. Agent quick start
- [`AGENTS.md`](../AGENTS.md) — Kimi / PAI agent entry point
- [`CLAUDE.md`](../CLAUDE.md) — Claude Code agent entry point (same content as `AGENTS.md`)

## 2. System structure
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — High-level architecture, runtime families, responsibilities
- [`CODEBASE-MAP.md`](./CODEBASE-MAP.md) — Granular file-to-purpose index
- [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md) — How native events from Pi, Claude, and OpenCode converge into one frontend stream

## 3. WebSocket contract
- [`PROTOCOL.md`](./PROTOCOL.md) — Message types, connection lifecycle, error codes

## 4. Runtime deep-dives
- [`PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md) — Pi SDK worker architecture
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md) — Claude legacy-direct vs channel-backed backend modes, logs, and failure modes
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md) — OpenCode Direct architecture
- [`CLAUDE-DIRECT-UX-ISSUES.md`](./CLAUDE-DIRECT-UX-ISSUES.md) — historical pre-channel analysis of the older Claude direct path

## 5. Integration & extension
- [`ADDING-A-RUNTIME.md`](./ADDING-A-RUNTIME.md) — Checklist for adding a new runtime
- [`SHARP-EDGES.md`](./SHARP-EDGES.md) — Known traps and brittle patterns

## 6. Operations
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — Fastest path to logs, session files, and runtime-specific diagnosis
- [`DEPLOYMENT.md`](../DEPLOYMENT.md) — Production runbook, systemd, nginx
- [`SECURITY.md`](../SECURITY.md) — Security model, threat mitigations, rules
- [`API.md`](../API.md) — REST API surface index

## 7. Tests
- [`tests/README.md`](../tests/README.md) — Test layers, running commands

## 8. Features
- [`DRIVE-MODE.md`](./DRIVE-MODE.md) — current Drive Mode feature overview

## 9. Historical records
- [`historical/`](./historical/) — implemented design plans kept for reference only
- [`DRIVE-MODE-PLAN.md`](./DRIVE-MODE-PLAN.md) — historical Drive Mode execution plan

## 10. Future concepts (not active code)
- [`agent-os/`](../agent-os/) — Pre-implementation intent for a future Agent OS layer
