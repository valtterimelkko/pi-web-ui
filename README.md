# Pi Web UI

> **Latest work:** the Internal API now exposes a compact alias-resolving session evidence bundle (`1.10.0`) alongside additive runtime-health and filtered diagnostics, while Claude SDK `AskUserQuestion` is supported first-class in the browser, Antigravity has an inactivity stall watchdog with bounded retry, and the Files tab has a Markdown source editor with a GFM live preview (explicit Save, truncated files stay read-only). See [`docs/RECENT-CHANGES.md`](./docs/RECENT-CHANGES.md) for details.

Built for a simple reality: **one agent runtime and one subscription is often not enough.**

Pi Web UI is a self-hosted browser interface for running multiple coding-agent runtimes from one place. It works across mobile, desktop, and laptop browsers, so you can keep the same agent workspace available at a desk or on the go.

Built around [Pi Coding Agent](https://shittycodingagent.ai/) (via its SDK mode), Pi Web UI lets you use **Pi Coding Agent**, **Claude Code**, **OpenCode**, and **Antigravity** through a single persistent UI with unified sessions, replay, and a local automation API.

It is built for people who want more than one vendor-owned coding surface: different runtime strengths, different provider access, different subscription economics, and one persistent session UI across them.

Currently supported runtime paths:

- **Pi Coding Agent**
- **Claude Code** (SDK/profile-backed, direct `claude -p`, or channel-backed Claude Code)
- **OpenCode**
- **Antigravity** (`agy -p` / Gemini)

## Why this exists

Pi Web UI started as a practical response to a simple problem: one coding harness and one subscription was not enough.

Some tasks deserved the strongest available runtime. Others only needed a cheaper or higher-quota path. I also wanted:

- one persistent browser UI instead of several terminals
- session continuity across desktop and mobile
- a place to extend Pi Coding Agent with custom extensions and OpenCode with custom plugins
- a local automation surface for live validation and cross-runtime orchestration experiments

For the fuller origin story, read [`docs/PROJECT-STORY.md`](./docs/PROJECT-STORY.md).

## What makes it different

- **Four runtime families behind one UI**
- **Unified session list and replay model** across runtimes with very different backends
- **Local automation API** for live validation, integrations, and orchestration experiments
- **Optional per-session Telegram notifications** when an agent yields control back to you
- **Companion extension/plugin ecosystem** for Pi Coding Agent and OpenCode workflows
- **Honest documentation** about what is native, what is wrapper-like, and what is still evolving

## Runtime overview

| Runtime family | Integration style | Best for | Caveat level |
|---|---|---|---|
| **Pi Coding Agent** | Native Pi Coding Agent integration via its SDK path | Pi Coding Agent workflows, extensions, custom tools, and now a much broader optional OpenRouter-backed model catalogue | Lowest |
| **Claude Code** | Claude Agent SDK (profiles), `claude -p`, or channel-backed Claude Code | Harder coding work on Claude Code; multi-provider access via provider profiles | Medium–higher |
| **OpenCode** | `opencode serve` + HTTP/SSE | OpenCode-backed workflows, especially OpenCode/Z.AI setups | Low–medium |
| **Antigravity** | `agy -p` subprocess-per-turn | Gemini/Antigravity workflows in the same UI | Higher |

The important truth is that these paths are **not equally official in the eyes of their upstreams**:

- **Pi Coding Agent** and **OpenCode** use supported integration surfaces.
- **Claude** and **Antigravity** are more wrapper-oriented and may need maintenance when upstream CLI behaviour, auth, or policy changes.

For Claude specifically, Pi Web UI now keeps **three usable backend paths** available on purpose:
- **SDK backend** — preferred, especially for explicit provider profiles
- **direct CLI backend** — a practical fallback when SDK behaviour regresses
- **channel-backed backend** — an escape hatch for richer Claude Code semantics when you accept the extra moving parts

That is not accidental complexity. It is deliberate flexibility in response to changing upstream policy/economic constraints and real-world runtime behaviour — including the fact that GLM 5.2 has proven more effective inside the Claude Code harness than in some other harnesses.

For a fuller chooser, read [`docs/RUNTIME-OVERVIEW.md`](./docs/RUNTIME-OVERVIEW.md).

## Who this is for

Pi Web UI is aimed at **medium-to-power users**, not absolute beginners to agentic tooling.

Typical good fits:

- you already use Pi Coding Agent, Claude Code, OpenCode, or Antigravity and want one browser surface around them
- you want to self-host a personal coding-agent workspace
- you want to fork a real multi-runtime UI and adapt it to your own harness/provider mix
- you want a local automation/orchestration API that can talk to real agent runtimes

## Support tiers

Pi Web UI is not pretending every operating system is equally supported.

- **Tier 1: Linux** — first-class target for local servers, VPS deployments, and always-on use
- **Tier 2: macOS** — viable for technically comfortable users, especially local development and personal always-on machines such as Mac minis
- **Windows** — not a primary target today; use a Linux host or treat WSL as experimental

Read [`docs/PLATFORM-SUPPORT.md`](./docs/PLATFORM-SUPPORT.md) before planning a deployment.

## Choose your docs path

- **Adopting / self-hosting / evaluating the repo?** Start with [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md)
- **Choosing between runtime families?** Read [`docs/RUNTIME-OVERVIEW.md`](./docs/RUNTIME-OVERVIEW.md)
- **Integrating programmatically or orchestrating agents?** Read [`docs/INTERNAL-API.md`](./docs/INTERNAL-API.md)
- **Maintaining, contributing, or debugging the repo itself?** Start with [`docs/README.md`](./docs/README.md)

## Quick start paths

Do **not** try to adopt everything at once unless you already know you need it.

### Option A — Start with one runtime
Best for most adopters.

Choose one of:
- **Pi Coding Agent-focused setup**
- **OpenCode-focused setup**
- **Claude Code-focused setup**
- **Antigravity-focused setup**

Then add more runtimes later.

### Option B — Full multi-runtime setup
Best if you already use several of these tools and want Pi Web UI to become your main browser shell.

## Fastest path to first success

1. Read [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md)
2. Choose one runtime from [`docs/RUNTIME-OVERVIEW.md`](./docs/RUNTIME-OVERVIEW.md)
3. Copy `.env.example` to `.env`
4. Set your login password and other minimum config
5. Run `npm ci --include=dev` and `npm run dev`
6. Open the local UI and create your first session

## Companion ecosystem

Pi Web UI is stronger when paired with the public companion repositories:

- **Pi Coding Agent extensions:** [valtterimelkko/pi-extensions-public](https://github.com/valtterimelkko/pi-extensions-public)
- **OpenCode plugins:** [valtterimelkko/opencode-plugins](https://github.com/valtterimelkko/opencode-plugins)

These are not mandatory for core chat/session flows, but they add a lot of the richer planning, memory, goal, orchestration, and status behaviour that shaped the project in practice.

Read [`docs/RUNTIME-COMPANIONS.md`](./docs/RUNTIME-COMPANIONS.md).

## Local automation API

Despite the current filename, the **Internal API** is one of the most important power-user features in this repo.

It began as a way for coding agents to do **live end-to-end validation** against real runtimes while building or troubleshooting Pi Web UI — not just by running a test suite, but by initiating real sessions against real agent backends.

It is now also becoming:

- a **local backend API** for other tools or applications on the same machine
- a **growing orchestration surface** for cross-runtime workflows

Current docs:
- [`docs/INTERNAL-API.md`](./docs/INTERNAL-API.md)
- [`docs/INTERNAL-API-CONTRACT.md`](./docs/INTERNAL-API-CONTRACT.md)
- [`docs/INTERNAL-API-ORCHESTRATION.md`](./docs/INTERNAL-API-ORCHESTRATION.md)

Recent power-user additions worth knowing about:
- **runtime health** and filtered, secret-scrubbed **self-service diagnostics** with a bounded process-local operational snapshot
- durable **run receipts**, idempotent prompt dispatch, and explicit disconnect-safe detached answer-mode prompts
- a read-only **screen-view transcript projection** (`view=screen`) for fetching what the user sees without browser automation
- optional **Pi runtime OpenRouter model refresh** via `npm run pi:refresh-models`; see [`docs/PI-OPENROUTER-MODEL-AUTOMATION.md`](./docs/PI-OPENROUTER-MODEL-AUTOMATION.md)

The API now publishes contract metadata through `/health` and `/capabilities` because trusted local consumers may use Pi Web UI as a runtime backend. One such consumer under separate design is Agent OS; Pi Web UI should remain the runtime gateway rather than absorbing Agent OS memory/work-object concerns.

Longer-term direction:
- [`docs/VISION.md`](./docs/VISION.md)

## Architecture at a glance

```text
Browser (React + Zustand + Vite)
  └─ WebSocket /ws + REST /api/*
       └─ Express server
            ├─ auth / CSRF / security layers
            ├─ unified session registry
            ├─ Pi Coding Agent path
            ├─ Claude Code path
            ├─ OpenCode runtime path
            ├─ Antigravity runtime path
            └─ local automation API over a Unix socket
```

Canonical architecture doc:
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

## Installation and adoption docs

### Public/adopter path
- **Getting started:** [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md)
- **Runtime chooser:** [`docs/RUNTIME-OVERVIEW.md`](./docs/RUNTIME-OVERVIEW.md)
- **Platform support:** [`docs/PLATFORM-SUPPORT.md`](./docs/PLATFORM-SUPPORT.md)
- **Project story:** [`docs/PROJECT-STORY.md`](./docs/PROJECT-STORY.md)
- **Vision / direction of travel:** [`docs/VISION.md`](./docs/VISION.md)
- **Claude backend modes:** [`docs/CLAUDE-BACKENDS.md`](./docs/CLAUDE-BACKENDS.md)
- **Claude provider profiles / GLM routing:** [`docs/CLAUDE-PROVIDER-PROFILES.md`](./docs/CLAUDE-PROVIDER-PROFILES.md)
- **Companion repos:** [`docs/RUNTIME-COMPANIONS.md`](./docs/RUNTIME-COMPANIONS.md)
- **Automation API:** [`docs/INTERNAL-API.md`](./docs/INTERNAL-API.md)
- **Automation API contract:** [`docs/INTERNAL-API-CONTRACT.md`](./docs/INTERNAL-API-CONTRACT.md)
- **Notifications:** [`docs/NOTIFICATIONS.md`](./docs/NOTIFICATIONS.md)
- **Deployment:** [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- **Security:** [`SECURITY.md`](./SECURITY.md)
- **API index:** [`API.md`](./API.md)
- **Docs hub:** [`docs/README.md`](./docs/README.md)
- **Recent doc-relevant changes:** [`docs/RECENT-CHANGES.md`](./docs/RECENT-CHANGES.md)

### Maintainer / contributor / LLM-agent path
- **Agent instructions:** [`AGENTS.md`](./AGENTS.md)
- **Maintainer docs index:** [`docs/MAINTAINER-INDEX.md`](./docs/MAINTAINER-INDEX.md)
- **Troubleshooting:** [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)
- **Codebase map:** [`docs/CODEBASE-MAP.md`](./docs/CODEBASE-MAP.md)
- **Event pipeline:** [`docs/EVENT-PIPELINE.md`](./docs/EVENT-PIPELINE.md)
- **Add a runtime:** [`docs/ADDING-A-RUNTIME.md`](./docs/ADDING-A-RUNTIME.md)

## Repo layout

```text
client/       React frontend
server/       Express server and runtime integrations
shared/       shared protocol/types package
docs/         public docs + maintainer docs
tests/        Playwright E2E + benchmarks + utility tests
server/tests/ server unit/integration tests
extensions/   local extension code
scripts/      operational helpers and validation tools
```

## Security and deployment posture

Pi Web UI is best understood first as a **self-hosted, operator-controlled, single-user or small-trusted-context tool**, not as a turnkey multi-tenant SaaS product.

That does not mean it must stay private to localhost, but it does mean you should read the deployment and security docs carefully before exposing it more broadly.

- [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- [`SECURITY.md`](./SECURITY.md)

## Credits and upstreams

This project builds on top of other agent ecosystems rather than replacing them.

- **Pi Coding Agent** is the original foundation and inspiration for the first runtime path. See [shittycodingagent.ai](https://shittycodingagent.ai/) and [the upstream codebase](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent).
- **Claude Code**, **OpenCode**, and **Antigravity** each provide their own runtime capabilities; Pi Web UI adds a browser layer, persistence layer, replay layer, and cross-runtime UX around them.

## License

MIT
