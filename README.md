# Pi Web UI

**A standardisation layer for coding agents: one session model and one local API across Pi Coding Agent, Claude Code, OpenCode, Antigravity and Command Code — so a parent agent can orchestrate children on any harness. It also comes with a browser UI over the same sessions.**

I use it mostly as an orchestration layer now. A strong model in one harness plans the work and fans it out to cheaper children running in *other* harnesses, waits without burning tokens, reads normalised results and checks them before accepting. The browser UI is where it started, and I still use it, but less and less.

It is a working personal system made public. It is messy in places and honest about it, and it is meant to be adopted piece by piece.

> **New here?** Read [`docs/ORCHESTRATION-OVERVIEW.md`](./docs/ORCHESTRATION-OVERVIEW.md) (what it is, how I use it, how to adopt it), then [`docs/INTERNAL-API-QUICKSTART.md`](./docs/INTERNAL-API-QUICKSTART.md) for a first call.

## What it does

- **Multi-harness, multi-runtime orchestration.** A parent creates, prompts, watches, reads and verifies child sessions across five harness families through one local HTTP API (a Unix socket on the same machine). The parent can be any of them; mine is usually Claude Code.
- **One session model.** One registry, one model catalogue, one set of run receipts, transcripts and completion blocks, whichever harness answers.
- **Waiting without polling.** Watches and long-poll waits wake the parent when a child ends. Children can outlive the parent's turn and are cleaned up by an owner lease.
- **Verification, not trust.** A child's claimed commits, files and tests are re-checked against git and the filesystem.
- **A browser UI over the same sessions**, for mobile, desktop and laptop: live streaming, replay, voice and Drive Mode, files, notifications.

## The harnesses

| Harness | Integration | Caveat level |
|---|---|---|
| **Pi Coding Agent** | Native SDK, in-process. Also reaches OpenRouter models and the `openai-codex` subscription provider | Lowest |
| **Claude Code** | Claude Agent SDK with provider profiles, direct `claude -p`, or channel-backed Claude Code | Medium–higher |
| **OpenCode** | `opencode serve`, HTTP and SSE | Low–medium |
| **Antigravity** | `agy` stream-json, a persistent process per session | Higher |
| **Command Code** | One `cmd` subprocess per session, behind `COMMAND_CODE_ENABLED` (off by default), with live model and effort discovery and a private normalised replay journal | High |

These are **not equally official** upstream. Pi Coding Agent and OpenCode use supported integration surfaces; Claude Code and Antigravity are wrapper-oriented and need maintenance when upstream CLIs, auth or policy change; Command Code is the newest and is feature-gated. Claude Code keeps three backends on purpose (SDK, direct CLI, channel-backed) because upstream policy and behaviour have shifted more than once. Detail: [`docs/RUNTIME-OVERVIEW.md`](./docs/RUNTIME-OVERVIEW.md), [`docs/COMMAND-CODE-INTEGRATION.md`](./docs/COMMAND-CODE-INTEGRATION.md).

## How I use it

A top-tier model is the parent: it plans, splits the work and judges the result. A great deal of the work goes to children on much cheaper or higher-quota models — DeepSeek V4.1 Flash and GLM 5.3 Flash are the ones I use most — in whichever harness suits the task. I call them children to a parent. Spreading the load this way is a large part of why I could stay on a smaller Claude Code plan. In one 30-day stretch I counted 1,116 sessions.

The story of how a browser UI turned into this is in [`docs/PROJECT-STORY.md`](./docs/PROJECT-STORY.md). The short version is below.

## The story in brief

I wanted one place to prompt agents from my phone and my laptop, with more than one subscription behind it, so I built a web UI around Pi Coding Agent. Adding Claude Code, OpenCode, Antigravity and later Command Code meant giving them one session model. To validate the UI I then needed a way for agents to drive real sessions, which became the Internal API. Over time that API, not the screen, became the thing I used most: a layer that standardises any agent in any harness so one can orchestrate the others. Full version: [`docs/PROJECT-STORY.md`](./docs/PROJECT-STORY.md); direction: [`docs/VISION.md`](./docs/VISION.md).

## Adopt as much or as little as you like

1. **The API only.** Run the server on a Linux or macOS machine you control, enable two runtimes you already use, and call the [Internal API](./docs/INTERNAL-API-QUICKSTART.md). You can ignore the browser UI.
2. **Plus a thin client.** [`pi-orch`](https://github.com/valtterimelkko/pi-orch) wraps the common loop (`spawn`, `prompt`, `wait`, `result`, `verify`, `cleanup`) in a zero-dependency CLI, so parents stop hand-writing `curl` and `sleep` loops.
3. **Plus the skills.** The [Pi Web UI orchestration pack](https://github.com/valtterimelkko/agent-workflow-skills/blob/main/packs/pi-web-ui-orchestration-pack/README.md) holds four portable `SKILL.md` files for the parent's loop, safe waiting, the child's discipline and secret scanning.
4. **The browser UI.** If you also want a persistent web shell over your agents, follow [`docs/FIRST-RUN.md`](./docs/FIRST-RUN.md).

No cloud account and no extra daemon are needed. Start with **two** runtimes, not five. The Internal API token is full control of every session on the server, so keep it on a machine you trust and read [`SECURITY.md`](./SECURITY.md) first.

## Who this is for

Medium-to-power users of agent harnesses who want to self-host a personal agent workspace, orchestrate agents across harnesses, or fork a real multi-runtime codebase. It is a single-operator, small-trusted-context tool, not a multi-tenant SaaS.

- **Tier 1: Linux** — local servers, VPS deployments, always-on use
- **Tier 2: macOS** — viable for technically comfortable users
- **Windows** — not a primary target; use a Linux host, or treat WSL as experimental

See [`docs/PLATFORM-SUPPORT.md`](./docs/PLATFORM-SUPPORT.md).

## Choose your docs path

| You want to… | Start here |
|---|---|
| Understand and adopt the orchestration layer | [`docs/ORCHESTRATION-OVERVIEW.md`](./docs/ORCHESTRATION-OVERVIEW.md) |
| Make a first API call | [`docs/INTERNAL-API-QUICKSTART.md`](./docs/INTERNAL-API-QUICKSTART.md), then [`docs/INTERNAL-API-RECIPES.md`](./docs/INTERNAL-API-RECIPES.md) |
| Run a parent properly (waves, waiting, supervision) | [`docs/INTERNAL-API-ORCHESTRATION.md`](./docs/INTERNAL-API-ORCHESTRATION.md) |
| Look up an endpoint or contract version | [`docs/INTERNAL-API.md`](./docs/INTERNAL-API.md), [`docs/INTERNAL-API-CONTRACT.md`](./docs/INTERNAL-API-CONTRACT.md) |
| Choose between harnesses | [`docs/RUNTIME-OVERVIEW.md`](./docs/RUNTIME-OVERVIEW.md) |
| Self-host the browser UI | [`docs/FIRST-RUN.md`](./docs/FIRST-RUN.md), then [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md) |
| Maintain, contribute or debug the repo | [`docs/README.md`](./docs/README.md), [`AGENTS.md`](./AGENTS.md) |

## The Internal API in more detail

The Internal API began as a way for coding agents to do **live end-to-end validation** against real runtimes while building Pi Web UI — real sessions against real backends, not just a test suite. It is now the main way I orchestrate agents, and a local backend for other tools on the same machine.

It offers: runtime health and self-service diagnostics; durable run receipts and idempotent, disconnect-safe prompt dispatch; watches that wake a parent when a child ends; goals with turn and token budgets; parent/child lineage (including for a Claude Code parent that Pi Web UI does not host); session archive and retention leases; admission control with `Retry-After`; and a read-only screen-view transcript projection. The server publishes its contract version through `/health` and `/capabilities`; the changelog is in [`docs/INTERNAL-API-CONTRACT.md`](./docs/INTERNAL-API-CONTRACT.md), which is the source of truth for the version.

Pi Web UI stays the runtime gateway. Memory and work-object concerns belong in whatever consumes the API; mine is a separate private project, Agent OS, which is **not** required.

## The browser UI

The same sessions are available in a React web app that works across mobile, desktop and laptop browsers:

- one persistent session list and replay model across all five harnesses
- **Voice Mode**, a two-lane harness for talking to an agent while it works — a confirm-gated instruction relay, an anti-duet speech arbiter and verbatim/summary/headlines reading levels ([`docs/VOICE-MODE-INTENT.md`](./docs/VOICE-MODE-INTENT.md)); and **Drive Mode** ([`docs/DRIVE-MODE.md`](./docs/DRIVE-MODE.md))
- a Files tab with Markdown editing, optional per-session Telegram notifications, and companion extensions and plugins for Pi Coding Agent and OpenCode ([`docs/RUNTIME-COMPANIONS.md`](./docs/RUNTIME-COMPANIONS.md))

## Architecture at a glance

```text
Parent agent (any harness)          Browser (React + Zustand + Vite)
  └─ pi-orch / HTTP over Unix socket   └─ WebSocket /ws + REST /api/*
       └──────────────┬─────────────────────┘
                 Express server
                  ├─ auth / CSRF / security layers
                  ├─ unified session registry + replay
                  ├─ Pi Coding Agent · Claude Code · OpenCode
                  ├─ Antigravity · Command Code (gated)
                  └─ Internal API (Unix socket): sessions, runs, watches, goals
```

Canonical architecture doc: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Companion repositories

- [`pi-orch`](https://github.com/valtterimelkko/pi-orch) — the thin parent client for the Internal API
- [`agent-workflow-skills`](https://github.com/valtterimelkko/agent-workflow-skills) — the orchestration pack and other portable skills
- [`pi-extensions-public`](https://github.com/valtterimelkko/pi-extensions-public) and [`opencode-plugins`](https://github.com/valtterimelkko/opencode-plugins) — extensions and plugins for Pi Coding Agent and OpenCode

None is needed for core sessions. See [`docs/RUNTIME-COMPANIONS.md`](./docs/RUNTIME-COMPANIONS.md).

## Installation and reference docs

**Adopters:** [`docs/ORCHESTRATION-OVERVIEW.md`](./docs/ORCHESTRATION-OVERVIEW.md) · [`docs/FIRST-RUN.md`](./docs/FIRST-RUN.md) · [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md) · [`docs/RUNTIME-OVERVIEW.md`](./docs/RUNTIME-OVERVIEW.md) · [`docs/PLATFORM-SUPPORT.md`](./docs/PLATFORM-SUPPORT.md) · [`docs/CLAUDE-BACKENDS.md`](./docs/CLAUDE-BACKENDS.md) · [`docs/CLAUDE-PROVIDER-PROFILES.md`](./docs/CLAUDE-PROVIDER-PROFILES.md) · [`docs/COMMAND-CODE-INTEGRATION.md`](./docs/COMMAND-CODE-INTEGRATION.md) · [`docs/NOTIFICATIONS.md`](./docs/NOTIFICATIONS.md) · [`DEPLOYMENT.md`](./DEPLOYMENT.md) · [`SECURITY.md`](./SECURITY.md) · [`API.md`](./API.md)

**Background:** [`docs/PROJECT-STORY.md`](./docs/PROJECT-STORY.md) · [`docs/VISION.md`](./docs/VISION.md) · [`docs/RECENT-CHANGES.md`](./docs/RECENT-CHANGES.md)

**Maintainers and agents:** [`AGENTS.md`](./AGENTS.md) · [`docs/README.md`](./docs/README.md) · [`docs/MAINTAINER-INDEX.md`](./docs/MAINTAINER-INDEX.md) · [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) · [`docs/CODEBASE-MAP.md`](./docs/CODEBASE-MAP.md) · [`docs/ADDING-A-RUNTIME.md`](./docs/ADDING-A-RUNTIME.md)

## Repo layout

```text
client/       React frontend
server/       Express server, runtime integrations, Internal API
shared/       shared protocol/types package
docs/         public docs + maintainer docs
tests/        Playwright E2E + benchmarks + utility tests
server/tests/ server unit/integration tests
scripts/      operational helpers and validation tools
```

## Security and deployment posture

Pi Web UI is a **self-hosted, operator-controlled, single-user or small-trusted-context tool**, not a turnkey multi-tenant service. You do not have to keep it on localhost, but read the deployment and security docs before exposing it more broadly: [`DEPLOYMENT.md`](./DEPLOYMENT.md), [`SECURITY.md`](./SECURITY.md).

## Credits and upstreams

This project builds on other agent ecosystems rather than replacing them. **Pi Coding Agent** is the original foundation: see [shittycodingagent.ai](https://shittycodingagent.ai/) and [the upstream codebase](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent). **Claude Code**, **OpenCode**, **Antigravity** and **Command Code** each provide their own runtime capabilities; Pi Web UI adds the session, replay, orchestration and browser layers around them.

## License

MIT
