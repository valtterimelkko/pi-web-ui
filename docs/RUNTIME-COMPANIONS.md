# Runtime Companions

Pi Web UI works on its own, but some of the richer workflow surfaces in this repo were designed alongside **companion Pi Coding Agent extensions** and **companion OpenCode plugins**.

This doc explains what those companion layers add, who should care, and how to think about installing them.

## Short version

- **You do not need companion repos for core session/chat usage.**
- **You may want them if you want the fuller workflow style that shaped this project.**

Core Pi Web UI features still work without them:
- session creation and switching
- chat streaming
- history replay
- runtime availability checks
- mobile-friendly session access

What becomes richer with companions:
- planning flows
- memory helpers
- autonomous goal execution
- orchestration helpers
- some status widgets and workflow-specific UI surfaces

## Why this matters

Each runtime has different extension/plugin capabilities.

- **Pi Coding Agent path** can expose custom tools, slash commands, widgets, status lines, and extension UI requests.
- **OpenCode** can expose plugin-driven state and runtime events that Pi Web UI normalizes into the common frontend model.
- **Claude** and **Antigravity** are integrated more as runtime wrappers than extension ecosystems.

So Pi Web UI can feel reasonably consistent across runtimes, but some of its most workflow-rich behaviour was shaped around Pi Coding Agent extensions and OpenCode plugins.

## Companion repositories

### Pi Coding Agent extensions
- Repo: [valtterimelkko/pi-extensions-public](https://github.com/valtterimelkko/pi-extensions-public)
- Best for: Pi Coding Agent-first users who want planning, memory, orchestration, subagents, and goal execution

Highlights in that repo include:
- enhanced planning flows
- safer subagent delegation
- persistent memory
- goal execution
- web helpers
- todo/task helpers
- orchestration tools

### OpenCode plugins
- Repo: [valtterimelkko/opencode-plugins](https://github.com/valtterimelkko/opencode-plugins)
- Best for: OpenCode users who want memory, orchestration, and goal-driven session behaviour

Highlights in that repo include:
- goal execution
- memory helpers
- parallel orchestration helpers

## Who should install them?

### Probably yes
Install the companions if you want Pi Web UI to feel closer to the maintainer's own richer workflow environment.

### Probably not yet
Skip them initially if you are just trying to:
- verify the repo works
- adopt a single runtime first
- keep your first setup simple

A good path is:
1. get Pi Web UI working with one runtime
2. confirm the core UI/session flow is good for you
3. add companion layers once you know you want the richer workflow style

## Core vs optional

### Definitely core
- session creation and switching
- chat streaming
- history replay
- auth/security layers
- runtime availability checks
- basic cross-runtime UI

### Optional / richer with companion packs
- goal-engine-specific status widgets
- extension/plugin-specific workflow UI
- some slash-command-oriented flows
- some status and approval surfaces originally designed around Pi Coding Agent extensions and then reused elsewhere

## Install shape

### Pi Coding Agent extensions
Pi Coding Agent discovers extensions from `~/.pi/agent/extensions/`.

See the companion repo for the exact folders and current install details:
- [pi-extensions-public](https://github.com/valtterimelkko/pi-extensions-public)

### OpenCode plugins
OpenCode plugins are distributed as small ESM packages.

See the plugin directories and current installation instructions in:
- [opencode-plugins](https://github.com/valtterimelkko/opencode-plugins)

## Practical recommendation

### If you want the simplest adoption
Start without companions.

### If you want the fuller Pi Web UI philosophy
Add:
- Pi Coding Agent companion extensions for Pi Coding Agent-first workflows
- OpenCode companion plugins for OpenCode-first workflows

## Related docs

- [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`PROJECT-STORY.md`](./PROJECT-STORY.md)
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)
