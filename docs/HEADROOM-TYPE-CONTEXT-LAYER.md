# Headroom-Type Context Layer for Pi Web UI

> Status: design note — feasibility researched, risks identified, Phase 1 pre-conditions defined
>
> Purpose: capture what we may want to borrow from Headroom-style context compression work, with concrete per-runtime feasibility assessments, a Phase 1 scope, and an explicit account of risks and what must be validated before building. Updated after two independent critical reviews to reflect failure modes that the original exploration underweighted.

## Start here

Before implementing anything, inspect the original Headroom project and its current issues/docs:

- GitHub repo: <https://github.com/chopratejas/headroom>
- Docs: <https://headroom-docs.vercel.app/docs>

Do not assume the README alone is enough. Inspect the current repo shape, integration docs, open issues, and any runtime-specific caveats before making design decisions.

## The core problem

In a long coding session, tool outputs accumulate in the context window. A single directory listing can return thousands of lines. A `cat` of a large file fills thousands of tokens. A bash build output or search result can be enormous. These artefacts are useful once — when the model first reads them — but become noise in every subsequent turn.

As the context window fills with this noise, two things happen:

1. **Auto-compaction triggers early.** Claude Code (and other runtimes) detect that the context is near its limit and run a compaction step. Compaction summarises earlier content. But compaction is coarse: it cannot reliably distinguish between a file read that happened to be in the same turn as a key decision, and a redundant log dump. Task-relevant history can be lost alongside the noise.

2. **The model's effective attention degrades before compaction.** Even before the limit is hit, a context packed with noisy artefacts leaves less room for the parts of the conversation that actually matter: the user's goal, earlier decisions, the current task state.

**Token billing is a side effect, not the goal.** The goal is sessions that stay accurate and coherent for longer, because the context window is used for task-relevant content rather than noisy artefacts.

## Why this document exists

Pi Web UI already unifies four very different runtime paths behind one browser UI:

1. **Pi SDK**
2. **Claude runtime**
3. **OpenCode Direct**
4. **Antigravity**

That makes Pi Web UI a strong place to build a **runtime-aware context mediation layer** that can be benchmarked across all four harnesses, rather than trying to force a third-party proxy product unchanged into every path.

## Intent

The intent is to build a **custom, local-first context layer** that:

- reduces noisy context before it reaches the model
- preserves the important parts of tool outputs, logs, file reads, search results, and history
- keeps the original content retrievable when needed
- integrates with each runtime at its natural control point, rather than forcing every path through the same mechanism
- exposes common metrics, replay, and benchmark surfaces through Pi Web UI

The goal is not "compression for its own sake". The goal is to make long-running, tool-heavy coding sessions more effective by using less context on boilerplate and repetition, preserving more room for the task-relevant parts of the conversation, and improving session continuity.

**Where this has landed after feasibility and risk work:** The idea is worth building, but the dominant risk is not "can we reduce tokens?" — it is "can we reduce tokens without removing the one detail the model needed, while keeping replay, debugging, and security understandable?" The architecture (runtime-differentiated, library-not-proxy, PostToolUse hook) is correct. The Phase 1 plan needs more pre-conditions and conservative scoping than the original exploration assumed.

## Real benefit we are after

If built well, this could give Pi Web UI:

- **more usable context window** for real work, not just lower billed tokens — directly achievable for Pi SDK and Claude channel-backed
- **better handling of noisy artefacts** such as logs, large search results, directory listings, diagnostics, and long files
- **reversible retrieval** of originals when the agent really needs them — via CCR/`headroom_retrieve`
- **common observability** across all four runtimes — measurable even where live compression is not possible (OpenCode, Antigravity)
- **benchmarkable policies** instead of anecdotal prompt tweaking

## What we would borrow from Headroom

### 1. Content-type-aware compression
Different artefacts should not be compressed the same way.

Examples:
- logs and test output
- code and diffs
- JSON / structured tool results
- search results
- directory listings
- long markdown or docs
- replay/history chunks

**Important caveat:** Code files and structured output are the highest-risk compression targets. For code, a safe first policy is to preserve imports, exported symbols, function/class boundaries, error-proximate lines, and first/last N lines — not generic summarisation. Generic summarisation of source code can drop the exact type signature, return value, or neighbouring context the model needed.

### 2. Reversible compression
If content is compressed, the original should remain retrievable by hash, key, or other stable reference. This is one of the most valuable ideas because it makes compression safer — the model can ask for the original rather than operating on false confidence.

### 3. Compression at the artefact level
The biggest wins tend to come from shrinking tool outputs, file reads, fetched docs, logs, and large structured results — rather than only compressing conversation history after the fact.

### 4. Unified metrics and benchmarking
Measure:
- before/after estimated token size
- compression ratio
- retrieval frequency
- task success impact (not just token count)
- failure modes by runtime and artefact type

### 5. Local-first operation
For this project, local control and local observability are strong advantages.

## What we should *not* borrow too literally

### 1. Proxy-first thinking
A single proxy is not the right centre of gravity for this codebase. Claude can behave differently when pointed at non-native base URLs. OpenCode has its own provider/config patterns. Antigravity is subprocess-per-turn. Pi is easier to influence from inside the SDK/runtime path than from outside via proxy indirection.

### 2. Assuming one integration method fits every harness
The correct interception point differs by runtime.

### 3. Treating "memory", "learning", and "compression" as one inseparable system
Those concerns may interact, but they should remain separable enough to benchmark independently.

### 4. Wrapper-heavy design as the main architecture

### 5. Optimising only for billed-token savings
The more meaningful optimisation target is **effective working context** and **task success**, not upstream billing.

## Pre-build validation gates

These must be answered before Phase 1 build work begins. They are not implementation details — they are foundational assumptions that could invalidate the plan if wrong.

### Gate 1 (highest priority): Does Pi Web UI's PostToolUse hook actually support output replacement?

Pi Web UI's current hook server responds to Claude's hook calls with `{ ok: true }`. It observes and broadcasts; it does not currently return `updatedToolOutput`. Claude Code's `PostToolUse` hook spec supports returning a modified tool result, but whether the channel-backed interactive path in Pi Web UI actually threads this replacement through to Claude's context has not been confirmed.

**Required validation:** Spend ~1 hour wiring the hook server to return a dummy modified string, then confirm Claude's next message reasons from the modified string and not the original.

**If this fails:** The Claude adapter drops from "live compression" to "observability only" — same category as OpenCode and Antigravity. Phase 1 must be redesigned before any compression work starts.

### Gate 2: Does `headroom-ai`'s `compress()` run fully locally with no network calls?

The design depends on `compress()` being a pure local call with no telemetry, no network dependency, and no external API calls. Verify by installing `headroom-ai` in a scratch project, running `compress()` on a sample tool output with network access blocked, and inspecting the library source for any remote calls.

**If this fails:** The library either cannot be used or must be audited more deeply before any production server dependency is added. Alternatively, build a lightweight custom compressor as a fallback.

### Gate 3: Does hook registration coexist with existing Pi Web UI hook configuration?

Pi Web UI already manages Claude hooks in `~/.claude/settings.json` via `claude-channel-hooks-config.ts`. Adding a compression hook must not clobber user-defined hooks or break the existing hook routing. Verify the hook server can handle multiple `PostToolUse` handlers and that the compression hook can be added without modifying or overwriting existing hook entries.

## Risks and failure modes

These are the reasons compression can make sessions worse, not better, if handled incorrectly.

### 1. Silent correctness failures (highest severity)

Lossy compression of tool output can remove exactly the detail the model needed. Common cases:
- a failed bash command whose error is on line 800; compression drops the error, model believes the command succeeded
- a file read where the relevant line is structurally similar to lines that get elided
- a JSON response where a "repeated" key actually had a different value the nth time
- stack frames, line numbers, type signatures, or import paths dropped as "redundant"

A session that produces a wrong fix confidently is worse than a slower session that read more tokens. This is the dominant risk.

**Mitigation required:**
- content-type-specific compression policies (logs compress aggressively; code preserves structure)
- a circuit breaker: if N tool calls in a session return unexpected results or the model asks for things it should know, disable compression for the rest of the session
- a passthrough fallback when `compress()` throws, times out, or returns output larger than the original
- shadow mode for initial validation runs

### 2. The three-version-of-truth problem

After Phase 1, there are potentially three versions of any large tool result:
1. The original (stored in the artefact store)
2. The compressed form (what Claude saw)
3. What Pi Web UI's replay/browser UI shows the user

Without explicit modelling, debugging becomes: the user sees thing A, Claude acted on thing B, the original was thing C. This must be modelled explicitly in the event stream from the start, not added later.

**Required event fields for any tool result where compression was applied:**
- `compressionApplied: boolean`
- `compressionKey: string` (stable artefact store key)
- `originalTokenEstimate: number`
- `compressedTokenEstimate: number`
- `modelVisibleResult: string` (what Claude actually received)

### 3. Model false-confidence without a retrieval signal

If a compressed result is passed to the model with no indication that it was compressed, the model treats the summary as the full truth. It may make confident edits based on incomplete information.

**Required even in Phase 1:** Prepend a standard delimiter to all compressed results:
```
[COMPRESSED — ~{N} tokens omitted. Artefact key: {key}. Use retrieve_original({key}) to expand.]
```
Even if the `retrieve_original` tool doesn't exist yet, the preamble tells the model to treat the content as a summary rather than the full text.

### 4. Double-compaction: Claude's own compaction vs Pi Web UI's

Claude Code runs its own compaction when the context window fills. If Pi Web UI pre-compresses tool outputs, Claude's compaction now summarises already-compressed summaries. The result may be lower-quality than either system would produce independently. The original artefacts (in Pi's store) are not visible to Claude's compaction, so retrieval chains can be severed.

This interaction needs explicit reasoning before Phase 1 ships. Options:
- accept it (pre-compression reduces the chance Claude's compaction triggers at all; the interaction may be net positive)
- inject session metadata that Claude's compaction respects ("this section is a managed summary; do not further compact")
- measure and revisit in Phase 2

### 5. Latency on the agent loop path

Compression runs synchronously in the PostToolUse hook — on every tool call above the threshold. Slow compression makes long sessions feel worse.

**Required before Phase 1 ships:**
- hard timeout (e.g. 500ms; pass through original on timeout)
- max input size cap (do not attempt to compress inputs beyond N bytes)
- fail-open: never fail the session on a compression error
- benchmark cold and warm `compress()` latency on representative input sizes

### 6. Artefact store as a security surface

The reversible store holds raw, original tool output for every compressed call — including file reads that may contain credentials, API keys, PII, proprietary code, or student data.

**Required design decisions (before writing the store):**
- storage format and location (e.g. `~/.pi-web-ui/compression-artefacts/` with 0700 permissions)
- retention policy: artefacts expire or are deleted when their session is deleted
- hash keys must not encode file paths, session metadata, or secrets
- `.gitignore` coverage for the store directory
- session delete must trigger artefact cleanup

### 7. Prompt injection via compressed summaries

A malicious file or log output could be crafted to influence what `compress()` produces. The compressed representation should clearly delimit untrusted content as-received, not as a trusted summary.

### 8. Cache invalidation for changed files

If a file changes after a compressed `Read`, a `retrieve_original` call returns stale content. Artefact metadata should include file path and modification time so retrieval can flag staleness.

### 9. Pi extension global scope

A Pi SDK extension installed in `~/.pi/agent/extensions/` is active across all Pi sessions globally — including unrelated projects and sessions where the user has not opted into compression. The compression extension should be project-local by default (`.pi/extensions/`) or require explicit opt-in, not be globally installed.

## The four runtime paths and integration strategy

### 1. Pi SDK runtime

**Feasibility:** Most feasible. Build a standard Pi coding agent extension using the `pi-extension` skill. Extensions are auto-loaded in both Pi CLI and Pi Web UI without Pi Web UI server code changes.

**Interception point:** `pi.on("tool_result", handler)` — fires after tool execution and before the result enters the model's context. Returning `{ content: [...] }` from the handler replaces what the model sees.

**Scope note:** Install project-local by default. Do not install globally until opt-in scope is resolved.

**Build approach:** Custom-build (not Headroom library). The Pi runtime path is internal enough that compression logic is written directly. Can be benchmarked against Headroom's published ratios without depending on Headroom's architecture.

### 2. Claude runtime (channel-backed path only)

**Feasibility:** Live compression feasible if Gate 1 passes. Falls back to observability-only if it fails.

**Interception point:** `PostToolUse` hook in `server/src/claude/claude-channel-hooks-config.ts`. Returns `updatedToolOutput` to Claude's context — but this must be validated (see Gate 1).

**Build approach:** Use Headroom's `compress()` library as the compression engine inside Pi Web UI's own hook. Do not use Headroom's proxy or `headroom wrap claude` — Pi Web UI already owns Claude Code's launch process, and two competing wrappers would break PTY supervision and channel hooks.

**Legacy direct path:** No hook surface on the legacy `claude -p` path. Compression is channel-backed only.

### 3. OpenCode Direct

**Feasibility:** Observability and system-prompt shaping only. `tool.execute.after` cannot replace tool output — mutations to `output.output` are silently ignored (upstream issues #13574, #3384). Until those are fixed, OpenCode is a benchmarking and metrics target, not a compression target.

**What is feasible:**
- system prompt injection via `experimental.chat.system.transform`
- compaction preservation via `experimental.session.compacting`
- observability via `tool.execute.after` and `event` hooks

### 4. Antigravity

**Feasibility:** Compression not feasible. Observability only. Each turn is an `agy -p` subprocess; there is no hook or interception surface between the prompt and Gemini's context window. Pi-owned turn logs are available for post-hoc size measurement and benchmarking.

## High-level architecture

> This section describes the logical components needed. For the two buildable runtimes, these components map to different concrete implementations — see the "Headroom out-of-the-box vs custom-build" section for the full breakdown.

### 1. Core context engine

A local engine that classifies artefact types, estimates size/cost, compresses or reshapes content, and applies heuristics for relevance and retention.

*For Claude (channel-backed): provided by `headroom-ai` library (`compress()` runs fully locally, no proxy required — but verify Gate 2). For Pi SDK: custom-build using the same content-type heuristics.*

### 2. Reversible artefact store

A local store that keeps original artefacts, records compressed forms, tracks metadata (path, mtime, session ID, turn index, tool call ID), and supports later expansion or filtered retrieval.

*For Claude (channel-backed): Headroom's CCR store; `headroom_retrieve` MCP tool requires the Headroom local proxy as a sidecar (optional — Phase 2). For Pi SDK: custom local artefact store (hash → original file on disk).*

*Security requirements for the store: see "Risks and failure modes" section above.*

### 3. Runtime adapters

- **Pi adapter** — Pi coding agent extension using `pi.on("tool_result", ...)`. Project-local scope.
- **Claude adapter** — `PostToolUse` hook calling `compress()`; includes preamble injection, artefact storage, timeout, fail-open, and the event fields described in the three-version-of-truth section.
- **OpenCode adapter** — observability and system-prompt shaping only until upstream issues fixed.
- **Antigravity adapter** — post-hoc metrics only.

### 4. Pi Web UI observability layer

A shared UI/backend surface for metrics, replay, evals, and per-runtime behaviour inspection. Deferred to Phase 2 but the event fields required for it (compression metadata) must be emitted from Phase 1.

## Why Pi Web UI is a particularly good home for this

Pi Web UI already gives us:
- one unified frontend across four backends
- session persistence and replay concepts
- runtime-aware service boundaries
- a browserless internal API and validation surface
- a natural place to compare runtime-specific outcomes

That makes it a much better home for a **benchmarkable context layer** than a one-size-fits-all external wrapper.

## Success criteria

This work is worth pursuing if it can show that, across one or more runtimes, it improves some combination of:
- effective context use (sessions that last longer before compaction)
- task completion quality (not just token reduction)
- resilience in long sessions
- usefulness of replay/history
- ability to recover full originals when needed
- clarity of runtime-level metrics in Pi Web UI

**The test that matters for Phase 1:** Take a real coding session that previously hit compaction and caused the model to lose task context. Run it with Phase 1 compression active. Does the model complete the task without asking the user to re-explain something it already read? If yes, Phase 1 worked. If no, adjust the threshold or algorithm before Phase 2.

**Token reduction alone is not a success criterion.** Compression might reduce context while increasing retries, tool calls, or wrong edits. Success metrics must include task completion, number of follow-up retrieval calls, number of failed edits or tests, and whether the model asks for information that was compressed away.

## Phase 1 scope

### Pre-conditions (must be resolved before starting Phase 1 build)

1. Gate 1: PostToolUse hook output replacement confirmed working in Pi Web UI's channel-backed path.
2. Gate 2: `headroom-ai`'s `compress()` confirmed standalone with no network calls.
3. Gate 3: Hook registration coexists with existing Pi Web UI hook config.

### Target runtime

Claude channel-backed path only.

### Target content types

Large bash output and log/test output (anything over ~8000 characters by UTF-8 byte count — use character length as the threshold estimator, not a tokenizer call). These are the noisiest artefacts in a typical coding session and lowest risk to compress.

Code file reads are explicitly excluded from Phase 1. Code at this size is information-dense and the failure mode (model makes wrong edits based on incomplete understanding) is higher severity than the benefit.

### Mechanism

1. Add a `PostToolUse` hook in `server/src/claude/claude-channel-hooks-config.ts`
2. When tool output exceeds the threshold and is bash/log content (not a code file read), call `compress()` with a timeout
3. On success: replace tool result with compressed form + preamble (`[COMPRESSED — ~{N} chars omitted. Artefact key: {key}]`)
4. On timeout or compression error: pass through the original unchanged; log the failure
5. Store the original artefact keyed by `{sessionId}/{toolCallId}` in a session-scoped local store with appropriate permissions
6. Emit compression event metadata alongside the normal tool result event

### Shadow mode

Include a `COMPRESSION_SHADOW_MODE` flag. In shadow mode, compression runs and metrics are logged but the original (uncompressed) result is what Claude receives. Use shadow mode for the first validation runs to verify compression quality before enabling live replacement.

### Artefact store (required for Phase 1, not Phase 2)

- Location: `~/.pi-web-ui/compression-artefacts/{sessionId}/`
- Permissions: directory 0700
- Cleanup: triggered on session delete
- Gitignored: yes
- Metadata per artefact: tool name, tool call ID, session ID, timestamp, original byte count, compressed byte count, file path if applicable (for cache invalidation)

### Logging (Phase 1)

Log to a per-session file: original char count, compressed char count, tool name, session ID, compression key, latency, timeout/error status. This is the basis for Phase 2 observability UI.

### Exit criterion

In at least 5 real coding sessions with large bash output or test output (not code reads), run with shadow mode first, then live compression:
- context usage measurably decreases (estimated char count before vs. after compression)
- the model completes tasks correctly (not just "continues" — specific outcome verified)
- at least one session is a regression test where the compressed content contained a known-required detail

### What is explicitly out of scope for Phase 1

- Code file read compression
- Pi SDK adapter
- CCR / `headroom_retrieve` MCP tool (but originals must be stored — see above)
- Observability UI in Pi Web UI
- OpenCode or Antigravity
- Any compression of content under the threshold
- Any compression of very recent turns (last 2 tool calls in a session)

## Non-goals for the first iteration

- A universal drop-in proxy for all runtimes
- Perfect live transparency across all four harnesses
- Compression, memory, planning, and learning shipping together

## Headroom out-of-the-box vs custom-build

> Based on Headroom v0.25.0, June 2026 (Apache 2.0, actively maintained).

### What Headroom offers

- Content-type-aware compression: JSON (70–90%), logs (80–95%), code/AST (40–70%), text (40–60%)
- CCR: originals stored locally, LLM can fetch via `headroom_retrieve` MCP tool
- Integration paths: proxy, library (`compress()`), MCP server, SDK wrappers, `headroom wrap claude`

### Why `headroom wrap claude` does not fit

`headroom wrap claude` relaunches Claude Code with modified launch args and `ANTHROPIC_BASE_URL` pointed at its proxy. Pi Web UI already owns Claude Code's launch process via `claude-channel-process-manager.ts` and PTY supervision. Two competing wrappers would break PTY supervision, channel hooks, and the plugin bridge. The proxy also carries risk that Claude Code behaves differently when pointed at a non-native base URL.

**Verdict: `headroom wrap claude` / proxy mode is not compatible with the channel-backed path.**

### The right fit: Headroom as a library inside Pi Web UI's PostToolUse hook

`compress()` runs fully locally — no proxy needed for compression itself. The proxy is only needed for `headroom_retrieve` MCP tool support (optional, Phase 2).

Integration:
1. `npm install headroom-ai` as a Pi Web UI server dependency (Node 18+) — after Gate 2 is passed
2. Call `compress(toolOutput)` inside the PostToolUse hook with a timeout
3. Store compressed form + original using a session-scoped local store
4. Optionally run Headroom proxy as a sidecar in Phase 2 to enable `headroom_retrieve`

### Pi SDK: custom-build

For Pi SDK, the interception point is inside the Pi runtime path, not at the Anthropic API call level. Headroom's proxy doesn't fit. A custom artefact compression layer using the Pi extension tool-wrapping surface is more natural and can be benchmarked against Headroom's ratios without coupling to Headroom's architecture.

### Summary

| Approach | Pi SDK | Claude (channel-backed) |
|---|---|---|
| `headroom wrap claude` / proxy | ❌ Wrong fit — Pi Web UI owns the runtime | ❌ Conflicts with PTY supervision and channel hooks |
| Headroom library (`compress()`) in hook | Could be used for algorithm parity | ✅ Best fit after Gate 1/2 pass |
| Full custom-build | ✅ Best fit — natural control point | Could be done, but no need to rewrite Headroom's compression algorithms |

**Pragmatic path: custom-build for Pi SDK; Headroom library (not proxy) inside Pi Web UI's PostToolUse hook for Claude.**

## Related internal docs

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/INTERNAL-API.md`](./INTERNAL-API.md)
- [`docs/OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`docs/ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)
- [`docs/PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md)
