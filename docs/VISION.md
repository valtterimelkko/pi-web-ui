# Vision and Direction of Travel

Pi Web UI is already a usable self-hosted multi-runtime browser interface.

It is also, increasingly, a platform for something broader:
- live validation against real agent runtimes
- local application integration
- cross-runtime orchestration experiments

This page explains that direction without pretending the whole vision is finished today.

## What Pi Web UI already is

Today, Pi Web UI is already useful as:
- a browser UI for multiple coding-agent runtimes
- a persistent session shell across desktop and mobile
- a place where Pi Coding Agent extensions and OpenCode plugins can surface richer workflows
- a local automation surface for real end-to-end testing against those runtimes

## Where the local automation API came from

The local automation API (currently documented as the **Internal API**) did **not** begin primarily as a productized integration layer.

Its original purpose was much more practical:

> to let coding agents build, troubleshoot, and validate Pi Web UI features against **real runtime sessions**, not just against unit tests, mocks, or browser-only test environments.

That matters because many meaningful bugs in a project like this only appear when a real session is created and a real runtime is asked to do real work.

Examples:
- a new session flow that only fails with a live Claude or OpenCode backend
- replay logic that only breaks once a genuine runtime emits a real event sequence
- tool rendering or follow-up behaviour that looks correct in code but fails in practice

So the first value of the API was **live validation**.

## The second purpose: local backend integration

The API is also becoming a local backend surface for other tools running on the same machine or trusted host.

That could include things like:
- Agent OS style tooling running as a separate local project
- observer or monitoring tools
- voice interfaces
- custom frontends
- automation helpers

In that model, Pi Web UI is not just a browser app. It is a runtime-aware backend that other local software can call.

The API now publishes explicit contract metadata and has a short compatibility policy in [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), because local consumers should be able to detect which Internal API surface they are using.

## The longer-term orchestration vision

The more ambitious direction is still early, and should be read as **vision, not finished product**.

The idea is this:

Instead of a parent coding agent spawning subagents only through its own native harness, Pi Web UI's local automation API could become a place where a parent agent can call **different runtime/provider paths through one integrated surface**.

In other words, a future workflow could look more like:
- one child session on a Pi Coding Agent-backed model path
- one child session on an OpenCode/GLM path
- one child session on an Antigravity/Gemini path
- one child session on a Claude Code path
- all coordinated through the same local API

That would let a parent workflow choose the best available route for each subtask, rather than assuming every child should come from the same harness.

## Why that is interesting

If this direction matures, it could support workflows such as:
- model-diverse planning and implementation loops
- cost-aware or quota-aware routing across runtimes
- dynamic workflows where different providers are better at different stages
- local tools that treat Pi Web UI as a unified multi-runtime control plane

That is the more radical possibility behind the project.

## Important caveat

This orchestration vision is **not half-finished product marketing**.

Important parts of it are still:
- incomplete
- evolving
- operationally uneven across runtimes
- limited by the different native capabilities of Pi Coding Agent, Claude Code, OpenCode, and Antigravity

So the right current public framing is:

- **already real today:** browser UI, persistence, replay, local automation API, runtime integration, live validation
- **emerging now:** local integration for other applications and more capable orchestration endpoints
- **longer-term vision:** a stronger multi-runtime orchestration layer where one parent workflow can recruit the best available path across providers and harnesses

## Why this matters to adopters

You do not need to buy into the whole vision to use the repo.

You can still adopt Pi Web UI simply as:
- a Pi Coding Agent web UI
- an OpenCode web UI
- a Claude-facing browser shell
- a Gemini/Antigravity browser shell
- a starting point for your own fork

But if you are the kind of power user who cares about where these systems could go, the longer-term direction is part of the point.

## Related docs

- [`PROJECT-STORY.md`](./PROJECT-STORY.md)
- [`INTERNAL-API.md`](./INTERNAL-API.md)
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
