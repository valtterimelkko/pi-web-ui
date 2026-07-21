# Pi Web UI Docs

> **What's new?** See [`RECENT-CHANGES.md`](./RECENT-CHANGES.md) for a rolling summary of doc-relevant changes. Recent highlights include the Internal API `1.10.0` compact session-evidence surface plus the `1.9.0` runtime-health/diagnostics surface, durable run-aware troubleshooting, first-class Claude SDK `AskUserQuestion` support, an Antigravity inactivity stall watchdog with bounded retry, and a Markdown source editor with GFM live preview in the Files tab.

This folder supports **four distinct reading paths**. Choose by task instead of reading the documentation linearly.

| Reader/task | Start here | Then |
|---|---|---|
| New adopter wanting first success | [`FIRST-RUN.md`](./FIRST-RUN.md) | [`GETTING-STARTED.md`](./GETTING-STARTED.md), [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md) |
| Local API consumer or orchestrator | [`INTERNAL-API-QUICKSTART.md`](./INTERNAL-API-QUICKSTART.md) | [`INTERNAL-API-RECIPES.md`](./INTERNAL-API-RECIPES.md), [`INTERNAL-API.md`](./INTERNAL-API.md) |
| Operator troubleshooting a symptom | [`TROUBLESHOOTING-DECISION-TREE.md`](./TROUBLESHOOTING-DECISION-TREE.md) | [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md), [`OBSERVABILITY.md`](./OBSERVABILITY.md) |
| Maintainer or coding agent changing the repo | [`MAINTAINER-INDEX.md`](./MAINTAINER-INDEX.md) | [`../AGENTS.md`](../AGENTS.md), [`CODEBASE-MAP.md`](./CODEBASE-MAP.md) |

The detailed subsystem documents remain canonical. The shorter guides above are task-oriented entrances, not replacements.

### If an operator gives you a session identifier

Do not search the whole filesystem first. From the repo root run:

```bash
npm run debug:where -- --json <internal-id|runtime-native-id|registry-path|conversation-id>
```

Then use the resolved internal id with `GET /api/v1/sessions/<id>/evidence`. Follow with the low-noise screen projection at `GET /api/v1/sessions/<id>/transcript?view=screen`, durable receipts, and scoped diagnostics. The locator output identifies relevant runtime-owned files. See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md#session-id-evidence-ladder).

---

## Public / adopter path

### Start here

- [`../README.md`](../README.md) — public landing page
- [`FIRST-RUN.md`](./FIRST-RUN.md) — one blessed Linux + one-runtime path
- [`GETTING-STARTED.md`](./GETTING-STARTED.md) — broader clone → configure → first-session guide
- [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md) — choose a runtime and understand trade-offs
- [`PLATFORM-SUPPORT.md`](./PLATFORM-SUPPORT.md) — Linux vs macOS support tiers and hosting expectations
- [`FEATURE-MATRIX.md`](./FEATURE-MATRIX.md) — distinguish core, runtime, and companion behavior

### Day-to-day features

- [`FILES-TAB.md`](./FILES-TAB.md) — file browsing, Markdown editing, truncation and save safety
- [`NOTIFICATIONS.md`](./NOTIFICATIONS.md) — automatic per-session Telegram notifications
- [`SELF-NOTIFICATIONS.md`](./SELF-NOTIFICATIONS.md) — explicit terminal-agent/script notifications
- [`DURABILITY-MATRIX.md`](./DURABILITY-MATRIX.md) — what survives browser refresh and server restart

### Understand the project

- [`PROJECT-STORY.md`](./PROJECT-STORY.md) — why this exists and how the runtime mix evolved
- [`VISION.md`](./VISION.md) — local automation and cross-runtime direction
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — high-level system structure and runtime boundaries
- [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md) — how Pi extensions and OpenCode plugins fit
- [`GOAL-EXTENSION-UI.md`](./GOAL-EXTENSION-UI.md) — goal UI ownership and lifecycle boundary

### Automation and integration

- [`../API.md`](../API.md) — REST / WebSocket / automation API index
- [`INTERNAL-API-QUICKSTART.md`](./INTERNAL-API-QUICKSTART.md) — shortest safe automation loop
- [`INTERNAL-API-RECIPES.md`](./INTERNAL-API-RECIPES.md) — durable dispatch, fan-out, evidence, transfer, notifications
- [`INTERNAL-API.md`](./INTERNAL-API.md) — canonical local automation API documentation
- [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) — compatibility and versioning rules
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md) — multi-runtime child-session patterns
- [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) — browserless single-turn runtime validation
- [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md) — durable watches and autonomous validation

### Deployment and trust

- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — self-hosting, reverse proxy, always-on deployment
- [`../SECURITY.md`](../SECURITY.md) — security posture and operator caveats

### Runtime-specific deep dives

- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md)
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)

---

## Maintainer / contributor / LLM-agent path

If you are changing code, debugging a runtime, or operating this repo as a live runbook, start here:

- [`MAINTAINER-INDEX.md`](./MAINTAINER-INDEX.md)
- [`TROUBLESHOOTING-DECISION-TREE.md`](./TROUBLESHOOTING-DECISION-TREE.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`CODEBASE-MAP.md`](./CODEBASE-MAP.md)
- [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md)
- [`PROTOCOL.md`](./PROTOCOL.md)
- [`OBSERVABILITY.md`](./OBSERVABILITY.md)
- [`SHARP-EDGES.md`](./SHARP-EDGES.md)
- [`DOCS-GOVERNANCE.md`](./DOCS-GOVERNANCE.md) — source-of-truth hierarchy and documentation-impact checklist

LLM coding agents should also read [`../AGENTS.md`](../AGENTS.md) or its byte-identical mirror [`../CLAUDE.md`](../CLAUDE.md).

## Historical plans and reports

Plans and validation reports preserve implementation rationale and evidence, but they are not automatically current contracts. Prefer canonical subsystem docs and emitted API capabilities. When adding or revisiting a plan, follow the status and canonical-link rules in [`DOCS-GOVERNANCE.md`](./DOCS-GOVERNANCE.md).
