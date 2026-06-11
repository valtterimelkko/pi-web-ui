# Runtime Companions

Pi Web UI can run on its own, but some of its richer workflow surfaces were designed alongside companion Pi extensions and OpenCode plugins.

## Why this matters

The browser UI aims to keep multiple runtimes feeling consistent, but each runtime has different extension/plugin capabilities.

- **Pi SDK path** can expose custom tools, slash commands, widgets, status lines, and extension UI requests.
- **OpenCode Direct** can expose plugin-driven state and runtime events that Pi Web UI normalizes into the common frontend model.
- **Claude** and **Antigravity** are integrated more as runtime wrappers than extension ecosystems.

That means the UI can degrade gracefully in some cases, but certain workflow niceties only appear when the companion layer exists.

## Pi runtime companions

The Pi runtime is the richest path for custom augmentation.

Typical companion capabilities include:
- planning and approval flows
- subagent discovery and evaluation
- persistent memory helpers
- goal execution/status widgets
- web search/fetch tools
- todo/task management
- parallel orchestration helpers

If those extensions are missing, the Pi runtime still works as a chat/tool environment, but some command lists, status widgets, or workflow-specific affordances will be reduced.

## OpenCode runtime companions

The OpenCode runtime can be enhanced with plugins for:
- goal execution
- memory
- parallel orchestration

Pi Web UI includes status and replay logic that can surface plugin-emitted state where available. Without those plugins, the OpenCode path still works, but it behaves more like a plain runtime connection and less like a tailored workflow environment.

## What is definitely core vs optional

### Core
- session creation and switching
- chat streaming
- history replay
- runtime availability checks
- auth/security layers
- mobile-friendly session access

### Optional / richer with companion packs
- goal-engine-specific status widgets
- extension/plugin-specific UI statuses
- some slash-command-oriented workflow patterns
- some approval/status surfaces originally designed for Pi extensions and reused elsewhere

## Recommendation for adopters

If you only want a browser shell around a single runtime, start with the runtime itself and Pi Web UI.

If you want the fuller experience that motivated this project, install the relevant companion extension/plugin packs for the runtime(s) you care about.

## Companion repositories

The public companion repositories are:

- **Pi extensions:** [valtterimelkko/pi-extensions-public](https://github.com/valtterimelkko/pi-extensions-public)
- **OpenCode plugins:** [valtterimelkko/opencode-plugins](https://github.com/valtterimelkko/opencode-plugins)

These repos contain the extension/plugin layers referenced in this document.

## Related docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`PROJECT-STORY.md`](./PROJECT-STORY.md)
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)
