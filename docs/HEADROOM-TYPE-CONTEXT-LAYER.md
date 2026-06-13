# Headroom-Type Context Layer for Pi Web UI

> Status: exploratory design note
>
> Purpose: capture what we may want to borrow from Headroom-style context compression work without committing to Headroom itself as a dependency or architecture.

## Start with the upstream reference

Before implementing anything here, agents should inspect the original Headroom project and its current issues/docs:

- GitHub repo: <https://github.com/chopratejas/headroom>
- Docs: <https://headroom-docs.vercel.app/docs>

Do not assume the README alone is enough. Inspect the current repo shape, integration docs, open issues, and any runtime-specific caveats before making design decisions.

## Why this document exists

Pi Web UI already unifies four very different runtime paths behind one browser UI:

1. **Pi SDK**
2. **Claude runtime**
3. **OpenCode Direct**
4. **Antigravity**

That makes Pi Web UI a strong place to build a **runtime-aware context mediation layer** that can be benchmarked across all four harnesses, rather than trying to force a third-party proxy product unchanged into every path.

## Intent

We are exploring whether to build a **custom, local-first context layer** that:

- reduces noisy context before it reaches the model
- preserves the important parts of tool outputs, logs, file reads, search results, and history
- keeps the original content retrievable when needed
- works across all four runtime paths in a way that respects how each runtime actually operates
- exposes common metrics, replay, and benchmark surfaces through Pi Web UI

The goal is not “compression for its own sake”. The goal is to make long-running, tool-heavy coding sessions more effective by:

- using less context on boilerplate and repetition
- preserving more room for the task-relevant parts of the conversation
- improving session continuity
- making cross-runtime evaluation possible
- giving the Web UI a common surface for measuring quality vs savings

## Real benefit we are after

If built well, this could give Pi Web UI:

- **more usable context window** for real work, not just lower billed tokens
- **better handling of noisy artefacts** such as logs, large search results, directory listings, diagnostics, and long files
- **reversible retrieval** of originals when the agent really needs them
- **common observability** across Pi, Claude, OpenCode, and Antigravity
- **benchmarkable policies** instead of anecdotal prompt tweaking
- **runtime-specific integrations** without forcing every harness through the same brittle proxy assumptions

## What we would borrow from Headroom

These are the strongest ideas worth learning from or reusing conceptually:

### 1. Content-type-aware compression
Different artefacts should not be compressed the same way.

Examples:
- logs
- code and diffs
- JSON / structured tool results
- search results
- directory listings
- long markdown or docs
- replay/history chunks

### 2. Reversible compression
If content is compressed, the original should remain retrievable by hash, key, or other stable reference.

This is one of the most valuable ideas because it makes compression safer.

### 3. Compression at the artefact level
The biggest wins tend to come from shrinking:

- tool outputs
- file reads
- fetched docs
- logs
- large structured results

rather than only compressing conversation history after the fact.

### 4. Unified metrics and benchmarking
Measure:

- before/after estimated token size
- compression ratio
- retrieval frequency
- task success impact
- failure modes by runtime and artefact type

### 5. Local-first operation
For this project, local control and local observability are strong advantages.

## What we should *not* borrow too literally

### 1. Proxy-first thinking
A single proxy is not the right centre of gravity for this codebase.

Reasons:
- Claude can behave differently when pointed at non-native base URLs
- OpenCode has its own provider/config patterns
- Antigravity is subprocess-per-turn and comparatively opaque
- Pi is easier to influence from inside the SDK/runtime path than from outside via proxy indirection

### 2. Assuming one integration method fits every harness
Pi Web UI is explicitly multi-runtime. The correct interception point differs by runtime.

### 3. Treating “memory”, “learning”, and “compression” as one inseparable system
Those concerns may interact, but they should remain separable enough to benchmark independently.

### 4. Wrapper-heavy design as the main architecture
CLI wrappers can be useful, but they should not be the core design assumption for this project.

### 5. Optimising only for billed-token savings
For Pi Web UI, the more meaningful optimisation target is often **effective working context** and **task success**, not only upstream billing.

## What this system would do

At a high level, a custom system here would:

- inspect large context artefacts before they are sent onward
- choose a context-shaping strategy based on artefact type
- produce a smaller, more useful representation
- store a reversible link to the original
- let runtime adapters decide how and where to inject the compressed form
- surface savings, retrievals, and quality signals through Pi Web UI

## The four runtime paths and the upper-level integration strategy

This section stays at the “where would it plug in?” level, not detailed implementation.

### 1. Pi SDK runtime
**Nature of runtime:** Pi-native SDK session execution.

**Upper-level integration approach:**
- intercept tool and context artefacts inside the Pi runtime path
- potentially use SDK/extension-level hooks and tool wrapping
- use Pi Web UI as the metric/replay surface

**Why it is promising:**
Pi is the most internally controllable path.

**Feasibility assessment:** **Most feasible of all four runtimes.** Pi Web UI owns the session lifecycle, event forwarding, and worker orchestration for this path. Tool/context artefact interception can happen at the Pi extension and runtime layers, where Pi Web UI already has natural control points. This is the primary candidate for a genuine compression implementation — the exact hook locations still need to be specified concretely before implementation begins.

### 2. Claude runtime
**Nature of runtime:** legacy `claude -p` subprocesses or the channel-backed Claude Code path.

**Upper-level integration approach:**
- intercept runtime events, tool results, and replay artefacts at the Pi Web UI orchestration layer
- potentially add retrieval/compression helpers where Claude can use them safely
- use Web UI session history and runtime control as the common surface

**Why it is promising:**
This is likely the strongest non-Pi candidate because Pi Web UI already owns significant orchestration around Claude.

**Feasibility assessment (updated):**

Claude Code (the channel-backed path) supports a `PostToolUse` hook that fires **after each tool execution and before the result is returned to the model**. This is a genuine, supported interception point for tool output compression.

Pi Web UI's channel-backed Claude path already uses hooks (`claude-channel-hooks-config.ts`). A `PostToolUse` hook could:
- inspect tool output size
- compress or truncate large results (bash output, file reads, search dumps) before they land in Claude's context
- store the original under a hash key for retrieval if needed

This is a real, working interception point — unlike OpenCode's `tool.execute.after`, which is read-only due to an upstream bug.

**What is feasible:**
- `PostToolUse` hook: compress tool output before it enters Claude's context — **yes, this works**
- System prompt injection: inject context summaries or retrieval tool descriptions — **yes**
- Custom MCP tools: register a `retrieve_original` tool so Claude can fetch full artefacts — **yes**

**What is not feasible:**
- Intercepting tool output on the legacy `claude -p` (direct) path — no hook surface there; only the channel-backed path has hooks
- Modifying Claude's own internal compaction or summarisation behaviour

### 3. OpenCode Direct
**Nature of runtime:** long-lived `opencode serve` backend with HTTP/SSE integration.

**Upper-level integration approach:**
- integrate at the OpenCode-facing service layer rather than pretending OpenCode is just another raw provider proxy
- shape replay/history and large artefacts in a runtime-aware way
- potentially combine runtime-native features with Web UI benchmarking

**Why it is promising:**
OpenCode is structured enough to support good integration, but its adapter should remain specific to OpenCode rather than being forced into a generic proxy mould.

**Feasibility assessment (updated after plugin API research):**

OpenCode has a plugin system (`@opencode-ai/plugin`) with hooks that look relevant at first glance:
- `tool.execute.before` — can modify tool *args* before execution
- `tool.execute.after` — fires after tool execution; exposes `output.output`
- `experimental.chat.system.transform` — can inject strings into the system prompt each turn
- `experimental.session.compacting` — can push context strings to preserve across compaction

**However:** `tool.execute.after` **cannot compress or replace tool output** that goes back to the model. Mutations to `output.output` in this hook are silently ignored — OpenCode reads from `result.content` (an array of content parts) internally, not from the `output.output` string the hook exposes. This is a known, open limitation tracked in [issue #13574](https://github.com/anomalyco/opencode/issues/13574) and [issue #3384](https://github.com/anomalyco/opencode/issues/3384).

**What is actually feasible via OpenCode plugins:**
- **System prompt injection** (`experimental.chat.system.transform`): can inject compression instructions, retrieval tool descriptions, or working-context summaries into the system prompt — genuinely useful, but indirect
- **Compaction hooks** (`experimental.session.compacting`): can preserve key context strings across OpenCode's own compaction cycle — useful for session continuity, not artefact compression
- **Custom tools**: can register a `retrieve_original` tool for the model to call — a retrieval surface, but the model must choose to use it
- **Observability** (`tool.execute.after`, `event`): can log/measure tool output sizes, compute compression ratios, and feed metrics to Pi Web UI — real value for benchmarking

**What is not feasible via the current plugin API:**
- Intercepting and replacing tool output before it reaches the model's context — blocked by the `output.output` mutation bug
- Transparent artefact-level compression of file reads, bash output, or search results

**Verdict:** OpenCode's plugin API supports **observability and system-prompt shaping**, not true pre-model tool output compression. Until the `tool.execute.after` output mutation path is fixed upstream, OpenCode belongs in the same category as Antigravity for this design: a benchmarking and metrics target, not a compression target. Watch upstream issues #13574 and #3384 for progress.

### 4. Antigravity
**Nature of runtime:** `agy -p` subprocess-per-turn path with weaker live observability.

**Upper-level integration approach:**
- use whatever live interception hooks are realistically available
- lean more heavily on Pi-owned turn logs, per-run log files, stored history, and post-turn benchmarking
- treat Antigravity as the hardest path and validate carefully

**Why it is still worth considering:**
Even if transparent live compression is weaker here, Antigravity logs and replay are still useful for benchmarking, policy tuning, and regression testing.

**Feasibility assessment:** **Compression not feasible; observability only.** Each turn is a `agy -p` subprocess. Pi Web UI shapes the prompt string and parses stdout — there is no plugin, hook, or interception surface between the prompt and Gemini's context window. Pi-owned turn logs (`~/.pi-web-ui/antigravity-sessions/`) are available for post-hoc size measurement and benchmarking, but no live compression is possible without changes to `agy` itself.

## High-level architecture

The likely shape is **not** “just a proxy”.

A better fit for Pi Web UI would be a layered design:

### 1. Core context engine
A local engine that:
- classifies artefact types
- estimates size/cost
- compresses or reshapes content
- applies heuristics for relevance and retention

### 2. Reversible artefact store
A local store that:
- keeps original artefacts
- records compressed forms
- tracks metadata and retrieval keys
- supports later expansion or filtered retrieval

### 3. Runtime adapters
A separate adapter per runtime family:
- Pi adapter
- Claude adapter
- OpenCode adapter
- Antigravity adapter

Each adapter integrates at the runtime’s natural control point.

### 4. Pi Web UI observability layer
A shared UI/backend surface for:
- metrics
- replay
- evals
- policy comparison
- per-runtime behaviour inspection

## Why Pi Web UI is a particularly good home for this

Pi Web UI already gives us:

- one unified frontend across four backends
- session persistence and replay concepts
- runtime-aware service boundaries
- a browserless internal API and validation surface
- a natural place to compare runtime-specific outcomes

That makes it a much better home for a **benchmarkable context layer** than a one-size-fits-all external wrapper.

## Success criteria at the idea level

This work would be worth pursuing if it can eventually show that, across one or more runtimes, it improves some combination of:

- effective context use
- task completion quality
- resilience in long sessions
- usefulness of replay/history
- ability to recover full originals when needed
- clarity of runtime-level metrics in Pi Web UI

## Non-goals for the first iteration

At the concept stage, we should not assume:

- a universal drop-in proxy for all runtimes
- perfect live transparency across all four harnesses
- that Antigravity will be as rich or observable as Pi/Claude/OpenCode
- that compression, memory, planning, and learning all need to ship together

## Related internal docs

For the runtime shapes this idea would need to respect, read:

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/INTERNAL-API.md`](./INTERNAL-API.md)
- [`docs/OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`docs/ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)
- [`docs/PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md)
