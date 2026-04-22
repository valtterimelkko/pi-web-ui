# OpenCode Direct Parallel Orchestrator — Implementation Plan

> Status: **planned**
>
> Audience: maintainers planning to port the Pi SDK `parallel-orchestrator` extension to OpenCode Direct.

## Context

The Pi SDK has a **parallel-orchestrator extension** at `~/.pi/agent/extensions/parallel-orchestrator/`. This extension provides git worktree-based parallel task orchestration:

1. **Worktree Management** — Create, list, delete, and check status of isolated git worktrees for parallel development tasks
2. **Plan-Based Orchestration** — Parse plan files (markdown with `## Task` headers) and automatically create worktrees for parallelizable tasks
3. **Merge Integration** — Merge worktree branches back with support for merge, squash, and rebase strategies, including conflict detection

The extension registers 3 tools (`worktree`, `orchestrate`, `merge_worktree`) and 4 slash commands (`/worktrees`, `/orchestrate`, `/merge`, `/abort-worktree`).

## Why This Matters for OpenCode Direct

Parallel orchestration enables a fundamentally different workflow:

- Work on multiple features simultaneously without context switching
- Each worktree has its own isolated branch and working directory
- Plan a project, then execute all independent tasks in parallel
- Merge results back systematically with conflict awareness

This is especially valuable for larger projects and multi-file changes where tasks don't depend on each other.

## Reference Implementation

**Read the Pi extension source** at `~/.pi/agent/extensions/parallel-orchestrator/`. Key files:

- `index.ts` — Main extension: registers tools and commands, manages in-memory state for worktrees and orchestrations
- Core logic is standard git operations (`git worktree add/list/remove`, `git merge/squash/rebase`)

### Core Operations

The extension uses these git commands:

| Operation | Git Commands |
|---|---|
| Create worktree | `git worktree add <path> -b <branch>` |
| List worktrees | `git worktree list --porcelain` |
| Delete worktree | `git worktree remove <path>` |
| Status check | `git status --porcelain` in worktree directory |
| Merge worktree | `git merge`, `git merge --squash`, or `git rebase` |
| Conflict detection | Check merge exit code and `.git/MERGE_MSG` |

### Pi SDK APIs Used

| Pi SDK Hook | Purpose | OpenCode Equivalent (research needed) |
|---|---|---|
| `pi.registerTool()` | Registers `worktree`, `orchestrate`, `merge_worktree` tools | OpenCode plugin `tool()` helper |
| `pi.registerCommand()` | Registers `/worktrees`, `/orchestrate`, `/merge`, `/abort-worktree` | OpenCode custom commands |
| `pi-tui` imports (Box, Text) | TUI rendering | Not needed for OpenCode |

### What's Portable

The core logic is **highly portable** — it's primarily:

- In-memory state management (Maps for worktree and orchestration tracking)
- Plan file parsing (extracting `## Task` sections from markdown)
- Git command execution via `execSync` or `spawn`
- Merge strategy selection (merge/squash/rebase)

The Pi-specific parts are minimal: only `pi.registerTool()`, `pi.registerCommand()`, and some TUI rendering imports that aren't essential to the core logic.

## Implementation Approach

### Phase 1: Research OpenCode Plugin System

The implementor **must research** the same OpenCode plugin ecosystem as described in `OPENCODE-MEMORY-EXTENSION-PLAN.md`. Additionally:

1. **OpenCode custom tools with schema** — How to define tools with structured input schemas (the worktree tool has multiple actions: `create`, `list`, `delete`, `status`)
2. **OpenCode custom commands** — How to register `/worktrees`, `/orchestrate`, `/merge` as slash commands
3. **Working directory awareness** — How the OpenCode runtime manages working directories, since worktree paths need to be resolved relative to the project root
4. **Process execution in OpenCode plugins** — How to safely run git commands from within a plugin (equivalent to `execSync('git worktree ...')`)

Useful starting points:
- OpenCode docs: https://opencode.ai
- OpenCode GitHub: https://github.com/anomalyco/opencode
- Existing global skill: `/root/.skills-global/skills-global/opencode-api/SKILL.md`
- The Pi extension's `index.ts` for the exact tool schemas and command definitions

### Phase 2: Port Core Logic

The following components can be reused with minimal changes:

1. **Worktree state management** — In-memory Maps tracking worktree metadata (path, branch, task, status)
2. **Plan file parser** — Extracts tasks from markdown files using `## Task` header pattern
3. **Git command wrappers** — Functions for worktree CRUD, merge, and status checking
4. **Merge strategy logic** — Merge/squash/rebase with conflict detection

### Phase 3: Implement OpenCode Plugin

Create an OpenCode plugin that:

1. Registers `worktree` tool with actions: `create`, `list`, `delete`, `status`
2. Registers `orchestrate` tool that parses plan files and creates parallel worktrees
3. Registers `merge_worktree` tool with merge strategies
4. Registers `/worktrees`, `/orchestrate`, `/merge` commands

### Phase 4: Integration with Pi Web UI

Like the memory extension, if implemented as an OpenCode plugin, Pi Web UI gets parallel orchestration for free. The tool calls flow through the existing permission bridge.

Consider also:
- Whether Pi Web UI should show worktree status in the session sidebar
- Whether the orchestrate tool needs any Pi Web UI-specific UI (progress indicators, worktree status cards)

## Compatibility Considerations

- The plan file format (markdown with `## Task` headers) should remain the same for cross-runtime compatibility
- Worktree paths and branch naming conventions should follow the same pattern as the Pi extension
- The in-memory state management means orchestration state doesn't persist across server restarts — this is acceptable and matches the Pi behavior

## Non-Goals

- Porting TUI rendering (not applicable to OpenCode)
- Persisting orchestration state to disk (follows Pi behavior of in-memory state)
- Automatic merge conflict resolution (same limitation as Pi extension)

## Success Criteria

- Can create and manage git worktrees from an OpenCode Direct session
- Can parse plan files and create parallel worktrees for independent tasks
- Can merge worktree branches with merge/squash/rebase strategies
- Conflict detection works correctly
- Tool calls flow through Pi Web UI's permission bridge as expected
