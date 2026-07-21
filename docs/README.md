# Pi Web UI Docs

> **What's new?** See [`RECENT-CHANGES.md`](./RECENT-CHANGES.md) for a rolling summary of doc-relevant changes. Recent highlights include the Internal API `1.10.0` compact session-evidence surface plus the `1.9.0` runtime-health/diagnostics surface, durable run-aware troubleshooting, first-class Claude SDK `AskUserQuestion` support, an Antigravity inactivity stall watchdog with bounded retry, and a Markdown source editor with GFM live preview in the Files tab.

This folder supports **two different reading paths**:

1. **Public/adopter docs** — for people deciding whether to use, self-host, extend, or fork Pi Web UI
2. **Maintainer/agent docs** — for contributors and LLM coding agents fixing bugs, tracing architecture, and troubleshooting runtime behaviour

If you arrived here from the public GitHub repo, start with the **public/adopter path** below.

### If an operator gives you a session identifier
Do not search the whole filesystem first. From the repo root run:

```bash
npm run debug:where -- <internal-id|runtime-native-id|registry-path|conversation-id>
```

Then use the resolved internal id with the session-scoped diagnostics/API routes, or read the low-noise screen projection with `GET /api/v1/sessions/<id>/transcript?view=screen`. The locator output tells you which runtime-owned files and logs are relevant. The maintainer path in [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md#session-id-evidence-ladder) explains the fallbacks.

---

## Public / adopter path

### Start here
- [`../README.md`](../README.md) — public landing page
- [`GETTING-STARTED.md`](./GETTING-STARTED.md) — clone → configure → first working session
- [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md) — choose a runtime path and understand the trade-offs
- [`PLATFORM-SUPPORT.md`](./PLATFORM-SUPPORT.md) — Linux vs macOS support tiers, 24/7 hosting expectations, VPS guidance

### Understand the project
- [`PROJECT-STORY.md`](./PROJECT-STORY.md) — why this exists and how the runtime mix evolved
- [`VISION.md`](./VISION.md) — where the platform could go, especially around local automation and cross-runtime orchestration
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — high-level system structure and runtime boundaries
- [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md) — how Pi extensions and OpenCode plugins fit into the fuller workflow

### Automation and integration
- [`../API.md`](../API.md) — REST / WebSocket / automation API index
- [`INTERNAL-API.md`](./INTERNAL-API.md) — local automation API for live validation, integration, and orchestration experiments
- [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) — compatibility/versioning rules for local consumers such as Agent OS style tooling
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md) — patterns for spawning and collecting child sessions across runtimes
- [`NOTIFICATIONS.md`](./NOTIFICATIONS.md) — optional per-session Telegram notifications and the related Internal API/browser routes
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) — browserless single-turn runtime validation, including the dedicated Claude profile validation runner
- [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md) — durable watches + the headless runner for autonomous, long-running validation

### Deployment and trust
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — self-hosting, reverse proxy, always-on deployment, Caddy/Nginx examples
- [`../SECURITY.md`](../SECURITY.md) — security posture and important operator caveats

### Runtime-specific deep dives
These are deeper technical reads once you already know you care about a given runtime path:
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md)
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)

Maintainer-only deeper internals such as Pi worker isolation live in the maintainer path.

---

## Maintainer / contributor / LLM-agent path

If you are changing code, debugging a runtime, or operating this repo as a live runbook, start here instead:

- [`MAINTAINER-INDEX.md`](./MAINTAINER-INDEX.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — including the session-ID evidence ladder; use this before raw log searches
- [`CODEBASE-MAP.md`](./CODEBASE-MAP.md)
- [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md)
- [`PROTOCOL.md`](./PROTOCOL.md)
- [`SHARP-EDGES.md`](./SHARP-EDGES.md)

### If you are an LLM fixing the repo, read only this first
- [`MAINTAINER-INDEX.md`](./MAINTAINER-INDEX.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`CODEBASE-MAP.md`](./CODEBASE-MAP.md)
- [`OBSERVABILITY.md`](./OBSERVABILITY.md)
- [`INTERNAL-API.md`](./INTERNAL-API.md) — if the issue touches runtime routing, orchestration, diagnostics, or transcript readback

LLM coding agents should also read:
- [`../AGENTS.md`](../AGENTS.md)
- [`../CLAUDE.md`](../CLAUDE.md)
