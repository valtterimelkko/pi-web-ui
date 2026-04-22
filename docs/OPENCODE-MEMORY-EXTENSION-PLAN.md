# OpenCode Direct Memory Extension — Implementation Plan

> Status: **planned**
>
> Audience: maintainers planning to port the Pi SDK `memory` extension to OpenCode Direct.

## Context

The Pi SDK has a **3-layer persistent memory extension** at `~/.pi/agent/extensions/memory/`. This extension provides:

1. **Session Memory** — Auto-extracted summary of the current conversation that survives context compaction. Stored per-session at `~/.pi/agent/session-memory/<hash>.md`.
2. **Auto-Memory** — Durable project knowledge in `MEMORY.md` at `~/.pi/agent/memory/<project-slug>/MEMORY.md`. Automatically extracted from decisions and facts discovered during conversation. Loaded every turn via system prompt injection.
3. **Memory Tool** — An explicit `memory` tool with actions: `save`, `search`, `show`, `list`, `edit`, `clear`. The LLM can deliberately store and retrieve facts.

Extraction uses heuristic pattern matching (no LLM calls) to detect decisions, facts, and file operations from assistant text and tool calls.

## Why This Matters for OpenCode Direct

Without memory, OpenCode Direct sessions in Pi Web UI start from scratch every time. Users lose accumulated project knowledge across sessions. The memory extension solves this by:

- Persisting project-level decisions and patterns
- Providing cross-session knowledge continuity
- Enabling explicit fact storage and retrieval
- Surviving context compaction with session summaries

## Reference Implementation

**Read the Pi extension source** at `~/.pi/agent/extensions/memory/`. Key files:

- `index.ts` — Main extension: registers the `memory` tool and `/memory` command, sets up event hooks
- `storage.ts` — File-based memory storage layer (pure Node.js, no Pi dependencies)
- `extractor.ts` — Heuristic extraction of decisions, facts, and file operations from conversation turns

### Pi SDK APIs Used

The extension uses these Pi-specific hooks that need OpenCode equivalents:

| Pi SDK Hook | Purpose | OpenCode Equivalent (research needed) |
|---|---|---|
| `pi.registerTool()` | Registers `memory` tool with execute/render | OpenCode plugin `tool()` helper |
| `pi.registerCommand()` | Registers `/memory` command | OpenCode custom commands (`.opencode/commands/`) |
| `pi.on("session_start")` | Load memories at session start | OpenCode plugin lifecycle hooks |
| `pi.on("before_agent_start")` | Inject memory block into system prompt | OpenCode `tool.execute.before` hook or session middleware |
| `pi.on("turn_end")` | Extract and store turn info | OpenCode `tool.execute.after` hook |
| `pi.on("tool_call")` / `pi.on("tool_result")` | Track tool usage for extraction | OpenCode `tool.execute.before/after` hooks |
| `pi.on("session_before_compact")` | Save session memory pre-compaction | OpenCode `experimental.session.compacting` hook |
| `pi.on("session_shutdown")` | Persist on shutdown | OpenCode plugin cleanup |
| `ctx.sessionManager.getSessionFile()` | Session file path | OpenCode session directory |

## Implementation Approach

### Phase 1: Research OpenCode Plugin System

Before writing any code, the implementor **must research**:

1. **OpenCode plugin format and installation** — How to write, build, and install plugins for `opencode`. Check `@opencode-ai/plugin` npm package.
2. **OpenCode plugin hooks** — Specifically: `tool.execute.before`, `tool.execute.after`, `experimental.session.compacting`, `shell.env`, and any session lifecycle hooks.
3. **OpenCode custom tools** — How to register a `memory` tool via the plugin API with execute, render, and schema definition.
4. **OpenCode custom commands** — How to register `/memory` as a slash command.
5. **OpenCode session directory** — Where OpenCode stores session data, and how to get the session path from within a plugin.
6. **OpenCode system prompt injection** — How to inject content into the system prompt at the start of each turn (equivalent to Pi's `before_agent_start`).

Useful starting points:
- OpenCode docs: https://opencode.ai
- OpenCode GitHub: https://github.com/anomalyco/opencode
- Existing global skill: `/root/.skills-global/skills-global/opencode-api/SKILL.md` (OpenCode server API reference)
- The `opencode-api` skill in the global skills folder has comprehensive API documentation

### Phase 2: Port Storage Layer

The storage layer (`storage.ts`, `extractor.ts`) is pure Node.js with **no Pi SDK dependencies**. It can be reused as-is or with minimal adaptation:

- Memory file format: Markdown files with YAML frontmatter
- Storage paths: Adapt from `~/.pi/agent/memory/` to `~/.opencode/memory/` or keep the same paths for cross-runtime compatibility
- The extraction heuristics are entirely portable

### Phase 3: Implement OpenCode Plugin

Wrap the storage layer in an OpenCode plugin that:

1. Registers a `memory` tool with actions: `save`, `search`, `show`, `list`, `edit`, `clear`
2. Hooks into `tool.execute.after` to extract decisions and facts after each turn
3. Hooks into session lifecycle to load auto-memory into context
4. Handles compaction by saving session summaries before context compression

### Phase 4: Integration with Pi Web UI

If the plugin is installed at the OpenCode level, Pi Web UI gets memory for free — no Pi Web UI code changes needed. The memory is handled entirely within the OpenCode runtime.

If system prompt injection is needed from Pi Web UI's side, consider:
- Loading the project's `MEMORY.md` in `opencode-service.ts` and injecting it via the prompt body
- This is a fallback only if the plugin approach doesn't support prompt injection

## Non-Goals

- Porting the Pi extension's TUI rendering (`renderCall`, `renderResult`) — OpenCode has its own rendering
- Porting the `/memory` command's interactive UI — OpenCode's command system is different
- Shared memory between Pi SDK and OpenCode Direct sessions — this is a future consideration

## Success Criteria

- OpenCode Direct sessions can persist project knowledge across sessions
- The `memory` tool is available and functional in OpenCode sessions
- Auto-memory is loaded at the start of each session
- Session memory survives context compaction
