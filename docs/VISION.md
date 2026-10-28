# Vision and Direction of Travel

Pi Web UI started as a multi-runtime browser UI. It has become, in daily use, a **standardisation and orchestration layer** for coding agents, with the browser UI as one client of it.

This page says what is already real, what is still rough, and where I want to take it. For the practical picture, read [`ORCHESTRATION-OVERVIEW.md`](./ORCHESTRATION-OVERVIEW.md); for the history, [`PROJECT-STORY.md`](./PROJECT-STORY.md).

## What is real today

- **Multi-harness orchestration.** A parent agent can create, prompt, watch, read and verify children across Pi Coding Agent, Claude Code, OpenCode, Antigravity and Command Code through one local API, and I do this daily. The parent can be any of those harnesses.
- **One session model.** One registry, model catalogue, run-receipt format, transcript and completion block, whichever harness answers.
- **Waiting, retention and cleanup that work without polling.** Watches wake a parent when a child ends; leases let a child outlive the turn that created it.
- **Verification.** A child's claims about commits, files and tests can be re-checked read-only against git and the filesystem.
- **A browser UI** over the same sessions, for mobile and desktop, including voice.
- **Live validation** against real runtime sessions, on a disposable server, which is where the API started.

## Where the API came from

The local API (the **Internal API**) did not begin as a product. Its original purpose was to let coding agents build, troubleshoot and validate Pi Web UI against **real runtime sessions**, not only unit tests or mocks. Many meaningful bugs in a project like this only appear when a real runtime does real work: a new-session flow that fails only with a live Claude or OpenCode backend, a replay path that breaks on a genuine event sequence, a tool rendering that looks right in code and fails in practice.

Giving agents a way to drive those sessions also gave them a way to drive each other. That second use is now the larger one.

## What the layer is for

It lets a parent workflow choose the best route for each subtask instead of assuming every child comes from the same harness:

- model-diverse planning, implementation and review loops
- cost- and quota-aware routing, with cheap children doing the bulk of the work
- the right harness for the right model, since the same model can behave differently in different harnesses
- other local software (voice interfaces, monitors, custom front ends, coordination tools) treating Pi Web UI as a runtime-aware backend

The API publishes explicit contract metadata and a short compatibility policy in [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), so local consumers can tell which surface they are talking to. Pi Web UI stays the **runtime gateway**: memory, planning and work-object concerns belong to whatever consumes it.

## Still rough

- The harnesses are operationally uneven. What a child can do mid-turn (steering, approvals, live events) differs by runtime, and the capabilities endpoint is the honest answer, not this page.
- Claude Code and Antigravity are wrapper-oriented and need upkeep when upstream CLIs, auth or policy change.
- Command Code is feature-gated and newer than the rest.
- It is a trusted, same-host, single-operator interface. There is no per-client access control inside the API.
- The repo is a living system and carries a lot of operational documentation. Expect rough edges.

## Direction

No fixed roadmap, but the principles are stable:

- Keep harness differences behind the API, so a parent written today keeps working when a child's harness or model is swapped.
- Keep the orchestration discipline portable: the skills and client should work with any harness that can read a `SKILL.md` and run a shell command.
- Keep adoption incremental, so someone can take the API, the client or the skills alone.

## Why this matters to adopters

You do not need the whole vision. You can adopt Pi Web UI as just the API, as the API plus a thin client, as the skills on their own, or purely as a browser shell for one runtime. Forking it as a starting point for your own provider and harness mix is a feature, not a misuse.

## Related docs

- [`ORCHESTRATION-OVERVIEW.md`](./ORCHESTRATION-OVERVIEW.md)
- [`PROJECT-STORY.md`](./PROJECT-STORY.md)
- [`INTERNAL-API.md`](./INTERNAL-API.md)
- [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
