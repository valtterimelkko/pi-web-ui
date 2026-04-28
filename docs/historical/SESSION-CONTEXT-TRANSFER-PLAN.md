# HISTORICAL — Session Context Transfer Plan

> Status: **IMPLEMENTED** — kept for historical reference only.
>
> The session context transfer feature described here has already been implemented. This document is a design-history record, not the current source of truth.
>
> For current behaviour, read:
> - [`../PROTOCOL.md`](../PROTOCOL.md) (transfer protocol messages)
> - [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
>
> Audience: maintainers and coding agents implementing cross-runtime session context transfer.
>
> Scope note: this plan is intentionally **backend- and protocol-focused**. It defines the frontend contract and UX requirements where necessary, but it does **not** break down frontend implementation tasks in detail.

## 1. Purpose

Add a **cross-runtime session context transfer** capability that lets a user transfer the **default visible transcript** of one session into another session, including across the three runtime paths:

1. **Pi SDK**
2. **Claude Direct**
3. **OpenCode Direct**

The transfer is initiated from the session list UX via drag-and-drop, but the essential architectural goal is deeper than the gesture:

- let a user move from a lighter / cheaper / faster agent to a stronger reasoning agent
- let a user move from a smaller context window to a larger one
- let a user continue work across runtime boundaries without importing raw SDK verbosity
- preserve only what the user would reasonably consider the conversation itself
- avoid treating this as compaction, summarisation, or hidden internal state transfer

## 2. Product Intent

This section is intentionally explicit. Implementers must preserve this intent, not just the mechanics.

### 2.1 What this feature is

This feature is a **visible handoff**.

It takes the **default rendered session transcript** from a source session and injects it into a target session as a **visible user-facing handoff message**.

The target agent is told:
- this is transferred context from another session
- it reflects only visible conversation context
- internal reasoning and full tool internals may be omitted
- it should **not act yet**
- it should **wait for the user’s next instruction**

### 2.2 What this feature is not

This feature is **not**:
- raw transcript migration
- hidden chain-of-thought transfer
- SDK-native state cloning
- worker/session process migration
- compaction
- automatic AI summarisation by default
- backend replay export of everything the runtime produced

### 2.3 Why “visible transcript” matters

All three runtimes can produce more internal chatter than the user actually sees:
- verbose CLI / SDK events
- hidden reasoning or thinking content
- full tool input/output payloads
- skill-loading or system noise
- runtime-specific replay artefacts

The system must therefore transfer a **curated, deterministic, low-bloat transcript** aligned with the current product philosophy of filtering and reducing noisy chatter.

## 3. Scope

## 3.1 In scope

- cross-runtime transfer between any two sessions supported by the unified session list
- transfer into:
  - an existing target session
  - a newly-created target session
- backend generation of a **canonical visible transfer payload**
- protocol support for transfer requests and responses
- confirmation-aware transfer flow support
- runtime-specific source transcript extraction
- deterministic framing/instruction wrapper for imported context
- transfer scope options for MVP:
  - **Recent visible context**
  - **Full visible context**
- source metadata in the handoff message:
  - source display name from the sidebar/session list naming layer
  - source runtime
  - source cwd
  - transfer timestamp
- CWD mismatch surfaced in confirmation metadata
- protection against transfer into a busy/streaming target session
- full backend/unit/integration/E2E test plan for the new behaviour

## 3.2 Out of scope for this plan

- detailed frontend drag-and-drop implementation breakdown
- custom transfer ranges in MVP
- AI summarisation as a required transfer step
- hidden/context-only injection that is invisible to the user
- transferring attachments/images/files as first-class imported assets
- transferring backend runtime identity, process state, approvals, or continuation handles
- literal per-browser expanded/collapsed card state transfer

## 4. Key Design Decisions

1. **Canonical transfer source = default rendered transcript**, not raw session storage and not current browser expansion state.
2. **Transfer is visible** in the target session.
3. **Transfer is framed** as informational handoff only.
4. **Target agent must be told not to act yet**.
5. **No mandatory AI summarisation** in MVP.
6. **Busy target sessions are blocked** in MVP.
7. **Source transcript construction happens server-side**, not in the browser.
8. **Frontend remains a consumer of a backend-defined transfer contract**, not the source of truth for what counts as transferable context.

## 5. High-Level Architecture

The feature should be implemented as a new explicit backend workflow, not as ad-hoc prompt injection from current UI state.

```text
source session
  -> runtime-specific history loader / replay extractor
    -> normalized events/messages
      -> visible transcript builder
        -> transfer framing builder
          -> target runtime prompt dispatch
            -> visible handoff message appears in target session
```

## 5.1 Architectural principle

The backend must define a reusable concept such as:
- `visible transcript`
- `transferable session transcript`
- `session handoff payload`

This object becomes the single server-side representation of “what should be transferred”.

That object must be independent of:
- current browser tab state
- client-only collapse/expand state
- runtime-specific raw replay format

## 6. Proposed Backend Module Decomposition

This section is the recommended module decomposition for parallel implementation.

## 6.1 New module family

Create a new backend module family under:

- `server/src/session-transfer/`

Recommended files:

- `server/src/session-transfer/types.ts`
- `server/src/session-transfer/visible-transcript.ts`
- `server/src/session-transfer/transfer-framing.ts`
- `server/src/session-transfer/transfer-service.ts`
- `server/src/session-transfer/transfer-validation.ts`
- `server/src/session-transfer/transfer-formatters.ts`

Optional if complexity grows:

- `server/src/session-transfer/source-loaders.ts`
- `server/src/session-transfer/target-dispatch.ts`
- `server/src/session-transfer/tool-visibility.ts`

## 6.2 Why a separate module family

Do **not** bury this logic directly inside `server/src/websocket/connection.ts`.

Reasons:
- keeps transfer logic runtime-neutral
- lets all three runtime paths feed one canonical transcript builder
- makes testing much easier
- reduces the chance that frontend-visible transcript rules drift between replay and transfer

## 7. Canonical Data Model

Define explicit types for the transfer workflow.

## 7.1 Recommended types

### `TransferScope`
```ts
'visible_recent' | 'visible_full'
```

### `TransferSourceRef`
```ts
{
  sessionId: string;
  sdkType: 'pi' | 'claude' | 'opencode';
  pathOrRuntimeId: string;
}
```

### `TransferTargetRef`
```ts
{
  targetSessionId?: string;
  createNew?: boolean;
  sdkType?: 'pi' | 'claude' | 'opencode';
  cwd?: string;
}
```

### `VisibleTranscriptItem`
```ts
{
  kind: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp?: number;
  toolName?: string;
  toolPrimaryArg?: string;
}
```

### `VisibleTranscript`
```ts
{
  source: {
    sessionId: string;
    displayName: string;
    sdkType: 'pi' | 'claude' | 'opencode';
    cwd: string;
    createdAt?: string;
    lastActivity?: string;
  };
  scope: 'visible_recent' | 'visible_full';
  itemCount: number;
  truncated: boolean;
  items: VisibleTranscriptItem[];
}
```

### `TransferHandoffPayload`
```ts
{
  header: string;
  body: string;
  metadata: {
    sourceDisplayName: string;
    sourceSdkType: 'pi' | 'claude' | 'opencode';
    sourceCwd: string;
    transferTimestamp: string;
    scope: 'visible_recent' | 'visible_full';
  };
  fullText: string;
}
```

## 8. What Counts as “Visible Transcript”

This is one of the most important implementation sections.

## 8.1 Source of truth

The server must reproduce the **default visible transcript**, not literally scrape the DOM.

## 8.2 Inclusion rules

Include:
- user messages
- assistant messages
- selected tool cards that are visible in default chat rendering

Exclude:
- hidden reasoning / chain-of-thought
- invisible runtime metadata
- raw NDJSON/SSE internals
- non-visible tool chatter
- approval plumbing events
- compaction bookkeeping
- rate-limit/internal status chatter unless already rendered as a normal user/assistant-visible message

## 8.3 Tool inclusion rule for MVP

Mirror the current UI philosophy:
- include only tool types that are already intended to be visible in default UI
- include only **brief/default-visible summaries**, not fully expanded output

Suggested MVP tool inclusion behaviour:
- include tool name
- include a primary parameter if meaningful and available
  - path / command / url / query / pattern / first string arg
- include short result summary / truncated output
- apply the same or equivalent truncation strategy used for collapsed tool cards

Do **not** transfer full tool outputs by default.

## 8.4 Skill content handling

Preserve existing filtering behaviour:
- if skill content is transformed to a placeholder in the UI, transfer the placeholder, not raw skill markup/content

## 8.5 Default rendered state

The transfer engine must model **default rendered state**, not current client interaction state.

Meaning:
- no dependence on which cards the user happened to expand in this browser tab
- no dependence on viewport size
- no dependence on local component state

## 9. Runtime-Specific Source Extraction Strategy

The transfer feature must support all three runtime families without assuming a single storage model.

## 9.1 Pi SDK source extraction

Primary relevant files:
- `server/src/websocket/connection.ts` (`loadSessionMessages`)
- `server/src/pi/event-forwarder.ts`
- Pi session storage under `~/.pi/agent/sessions/`

Recommended approach:
- reuse or extract logic from `loadSessionMessages()` where appropriate for user/assistant visible message loading
- add a server-side transcript builder that can also incorporate visible tool messages where required
- avoid duplicating filtering logic in multiple places; centralize it under `session-transfer/`

Important note:
- current `loadSessionMessages()` only returns user/assistant messages
- transfer needs selected visible tool summaries as well
- therefore a new canonical builder is required; `loadSessionMessages()` can be a partial source, not the full solution

## 9.2 Claude Direct source extraction

Primary relevant files:
- `server/src/claude/claude-service.ts`
- `server/src/claude/claude-history-replay.ts`
- `server/src/claude/claude-event-normalizer.ts`

Recommended approach:
- load Claude history via existing Claude session store/replay pathway
- convert stored entries to replay events using `historyToReplayEvents()` or equivalent normalized reconstruction
- then feed those replay events into the canonical visible transcript builder

Do not build a second Claude-specific transfer formatter if avoidable.

## 9.3 OpenCode Direct source extraction

Primary relevant files:
- `server/src/opencode/opencode-service.ts`
- `server/src/opencode/opencode-history-replay.ts`
- `server/src/opencode/opencode-event-adapter.ts`

Recommended approach:
- use `OpenCodeService.getReplayEvents(sessionId)` as the main source for transfer reconstruction
- feed replay events into the canonical visible transcript builder
- ensure OpenCode-specific tool/reasoning noise remains filtered per transfer rules

## 9.4 Preferred unifying approach

The best long-term design is:

```text
runtime-specific history source
  -> normalized replay events
    -> common visible transcript builder
      -> transfer handoff payload
```

This is preferable to three independent transfer formatters.

## 10. Transfer Framing Requirements

Every transfer must generate an explicit framing wrapper.

## 10.1 Required framing content

The framing must state that:
- this content was transferred from another session
- it contains only visible/default-rendered context
- hidden reasoning, internal tool details, or omitted runtime internals may not be included
- the agent should treat it as prior context only
- the agent should **not take action yet**
- the agent should **wait for the user’s next instruction**

## 10.2 Required source metadata in the visible handoff

Include:
- source display name from the sidebar/session list naming layer
- source runtime
- source cwd
- transfer timestamp
- transfer scope used

## 10.3 Example framing shape

This is illustrative, not mandatory wording.

```text
Transferred context from another session.

Source session: <display name>
Source runtime: <pi|claude|opencode>
Source workspace: <cwd>
Transferred: <timestamp>
Scope: <recent visible context|full visible context>

The following reflects only the visible/default-rendered conversation context from the source session. Hidden reasoning, internal runtime details, and full tool internals may be omitted.

Do not act on this yet. Wait for my next instruction.

--- BEGIN TRANSFERRED CONTEXT ---
...
--- END TRANSFERRED CONTEXT ---
```

## 11. Target Dispatch Strategy

## 11.1 Existing target session

If the transfer targets an existing session:
- preserve the target runtime exactly as it already exists
- do not create a new session
- inject the handoff into that target session as a normal visible prompt/message turn

## 11.2 New target session

If the transfer targets a new session:
- runtime must be explicitly chosen before creation
- cwd must be explicitly chosen before creation
- scope must be explicitly chosen before confirmation
- then create the new target session and inject the handoff

## 11.3 Busy target sessions

MVP rule:
- if target session is busy/streaming, block the transfer
- return a deterministic error/status to the UI
- do not queue silently

## 11.4 No automatic follow-up prompt

The injected handoff itself is the only transfer action.

The system must **not** automatically append a second instruction such as “continue”, “analyse”, or “act on this”.

## 12. Backend Protocol Additions

The browser implementation is out of scope here, but the backend protocol is not.

## 12.1 Add new client → server message(s)

Recommended message family:

### `transfer_session_context`
```ts
{
  type: 'transfer_session_context';
  sourceSessionId: string;
  targetSessionId?: string;
  createNew?: boolean;
  targetSdkType?: 'pi' | 'claude' | 'opencode';
  targetCwd?: string;
  scope: 'visible_recent' | 'visible_full';
  sourceDisplayName?: string;
}
```

Notes:
- `sourceDisplayName` may be provided by the browser because the sidebar name is user-customizable UI state
- server must validate but may trust this for visible labelling if no server-owned display-name registry exists
- if omitted, server should fall back to registry/session name/first message

## 12.2 Add server → client message(s)

Recommended:

### `session_transfer_preview`
Optional if the frontend wants a server-generated preview before final confirmation.

### `session_transfer_completed`
```ts
{
  type: 'session_transfer_completed';
  sourceSessionId: string;
  targetSessionId: string;
  createdNewSession: boolean;
}
```

### `session_transfer_failed`
```ts
{
  type: 'session_transfer_failed';
  sourceSessionId: string;
  targetSessionId?: string;
  message: string;
  code: string;
}
```

## 12.3 Protocol docs to update

If implementation proceeds, update:
- `docs/PROTOCOL.md`
- `server/src/websocket/protocol.ts`
- any shared protocol type package definitions

## 13. Backend Integration Points

Primary server files likely to change:

- `server/src/websocket/protocol.ts`
- `server/src/websocket/connection.ts`
- `server/src/session-registry.ts` (only if new metadata needs persistence)
- `server/src/pi/pi-service.ts` or Pi session helpers if new dispatch utility is needed
- `server/src/claude/claude-service.ts`
- `server/src/opencode/opencode-service.ts`
- new `server/src/session-transfer/*`
- `docs/PROTOCOL.md`
- this plan or follow-up architecture docs if implementation materially diverges

## 14. Recommended Execution Breakdown

This section is designed for **maximum parallelisation** while respecting real dependencies.

## 14.1 Workstream map

### Workstream A — transfer architecture and types
Deliver:
- canonical transfer types
- visible transcript interfaces
- framing interfaces
- dependency map for runtime loaders

Dependencies:
- none

Parallelisability:
- can start immediately

### Workstream B — common visible transcript builder
Deliver:
- server-side transcript builder that converts replay/messages into canonical visible items
- tool inclusion/truncation rules
- skill placeholder handling
- recent/full scope slicing rules

Dependencies:
- Workstream A types

Parallelisability:
- can start once type shapes are stable

### Workstream C — Pi source adapter
Deliver:
- Pi source extraction feeding the common transcript builder
- any required refactor of `loadSessionMessages()` or adjacent code

Dependencies:
- Workstream A
- ideally Workstream B contract

Parallelisability:
- can proceed in parallel with Claude/OpenCode adapters after shared contract is set

### Workstream D — Claude source adapter
Deliver:
- Claude history-to-transfer adapter based on replay reconstruction

Dependencies:
- Workstream A
- ideally Workstream B contract

Parallelisability:
- parallel with C and E

### Workstream E — OpenCode source adapter
Deliver:
- OpenCode replay-to-transfer adapter based on `getReplayEvents()`

Dependencies:
- Workstream A
- ideally Workstream B contract

Parallelisability:
- parallel with C and D

### Workstream F — transfer framing and target dispatch
Deliver:
- handoff text builder
- target session validation
- target runtime dispatch orchestration
- creation of new target session when requested

Dependencies:
- Workstream A
- partial dependency on B, C/D/E for transcript input

Parallelisability:
- can begin once interfaces are stable; final wiring waits for source adapters

### Workstream G — WebSocket/protocol integration
Deliver:
- new protocol message handling in `connection.ts`
- validation, error codes, success notifications

Dependencies:
- Workstream F

Parallelisability:
- mostly blocked on F

### Workstream H — tests
Deliver:
- module-level tests
- runtime-specific tests
- websocket routing tests
- integration tests
- E2E coverage

Dependencies:
- can begin with test scaffolding early
- final assertions depend on all workstreams above

## 14.2 Dependency summary

Hard dependencies:
- A before B/C/D/E/F
- B contract before final C/D/E implementations
- F before G
- G before complete integration/E2E verification

Soft dependencies:
- H can scaffold in parallel from the start
- docs/protocol updates can happen once G is stable

## 15. Phase Plan

## Phase 0 — design lock and acceptance criteria

Goals:
- confirm transfer scope enum and framing text policy
- confirm tool visibility/truncation rules
- confirm display-name sourcing strategy
- confirm no-AI default policy

Deliverables:
- locked type definitions
- acceptance criteria document embedded in code comments/tests

## Phase 1 — common transfer foundation

Goals:
- create `session-transfer/` module family
- define core types
- implement validation helpers
- implement transfer framing builder

Acceptance criteria:
- transfer payload can be built from synthetic transcript items
- validation rejects malformed targets/scopes

## Phase 2 — common visible transcript builder

Goals:
- convert normalized events / source messages into canonical visible transcript items
- centralize tool-visibility logic
- centralize skill placeholder behaviour
- centralize recent/full slicing rules

Acceptance criteria:
- same input replay always yields same visible transcript
- hidden reasoning excluded
- non-visible tools excluded
- visible tools truncated deterministically

## Phase 3 — runtime-specific source adapters

Goals:
- Pi source adapter
- Claude source adapter
- OpenCode source adapter

Acceptance criteria:
- each runtime can produce a `VisibleTranscript`
- source adapter tests cover replay quirks and edge cases

## Phase 4 — target dispatch orchestration

Goals:
- validate source/target relationship
- block busy targets
- create new target session when requested
- inject framed handoff into target runtime

Acceptance criteria:
- transfer into existing Pi/Claude/OpenCode targets works through one orchestration service
- transfer into new target session works for all supported target runtimes
- no automatic second prompt is sent

## Phase 5 — protocol integration

Goals:
- add transfer WebSocket messages
- route transfer requests in `connection.ts`
- emit success/failure messages

Acceptance criteria:
- transfer requests are authenticated, validated, and routed correctly
- explicit failure codes are returned for invalid or blocked transfers

## Phase 6 — test suite expansion and docs

Goals:
- complete test coverage across unit/integration/E2E layers
- update protocol docs
- add operational notes if required

Acceptance criteria:
- all relevant existing and new tests pass
- docs reflect the final protocol behaviour

## 16. Testing Strategy

This section is mandatory for execution agents. Use TDD per repo rules.

## 16.1 Root verification commands

Minimum checks before finishing any implementation phase:

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

For flows affecting user-visible behaviour, also run:

```bash
npm run test:e2e
```

## 16.2 New unit test modules

Recommended new test files:

### Common transfer tests
- `server/tests/unit/session-transfer/visible-transcript.test.ts`
- `server/tests/unit/session-transfer/transfer-framing.test.ts`
- `server/tests/unit/session-transfer/transfer-validation.test.ts`
- `server/tests/unit/session-transfer/transfer-service.test.ts`

What to test:
- default visible transcript conversion
- recent/full scope slicing
- stable truncation logic
- framing content
- metadata inclusion
- busy-target rejection
- invalid source/target combinations

### Pi-specific tests
Recommended:
- `server/tests/unit/pi/pi-visible-transcript.test.ts`
- or `server/tests/unit/session-transfer/pi-source-adapter.test.ts`

What to test:
- user/assistant extraction from Pi session history
- visible tool summary inclusion
- skill placeholder transformation
- exclusion of hidden/non-visible content

### Claude-specific tests
Recommended:
- `server/tests/unit/claude/claude-transfer-adapter.test.ts`

What to test:
- replay conversion from Claude stored history
- coalesced assistant content remains coherent in transfer
- PascalCase tool names normalize into visible transfer rules correctly
- tool results truncated correctly

### OpenCode-specific tests
Recommended:
- `server/tests/unit/opencode/opencode-transfer-adapter.test.ts`

What to test:
- OpenCode replay events build correct visible transcript
- reasoning parts remain excluded
- visible tool summary behaviour is correct

### WebSocket routing tests
Recommended:
- `server/tests/unit/websocket/session-transfer-routing.test.ts`

What to test:
- protocol validation
- routing to transfer service
- creation vs existing-target flows
- success/failure message emission
- busy target handling
- missing source / invalid target / invalid scope errors

## 16.3 Existing test modules that should be updated

These should be reviewed and extended, not merely left untouched.

### `server/tests/unit/websocket/*`
Add transfer routing and protocol coverage alongside existing runtime routing tests.

### `server/tests/unit/claude/claude-history-replay.test.ts`
Potentially extend with assertions that replay outputs remain sufficient for transfer building.

### `server/tests/unit/opencode/opencode-history-replay.test.ts`
Potentially extend with assertions that replay outputs remain suitable for transfer building.

### `server/tests/unit/pi/event-forwarder.test.ts`
Review if any visible transcript filtering logic is extracted/shared.

### `server/tests/unit/session-registry.test.ts`
Only if new registry metadata is introduced.

## 16.4 Integration tests

Recommended new files:

- `server/tests/integration/session-transfer-cross-runtime.test.ts`
- `server/tests/integration/session-transfer-new-target.test.ts`
- `server/tests/integration/session-transfer-busy-target.test.ts`

What to test:
- Pi -> Claude transfer
- Claude -> Pi transfer
- Pi -> OpenCode transfer
- OpenCode -> Claude transfer
- existing target session transfer
- new target session creation + transfer
- busy target rejection
- CWD mismatch metadata survives into transfer payload

## 16.5 E2E tests

Even though frontend implementation is out of scope in this document, E2E tests must still cover user-visible outcomes.

Recommended new files:
- `tests/e2e/session-transfer-existing-session.spec.ts`
- `tests/e2e/session-transfer-new-session.spec.ts`
- `tests/e2e/session-transfer-cross-runtime.spec.ts`

Minimum E2E assertions:
- transfer confirmation appears
- recent/full scope choices work
- source metadata appears in target message
- handoff message is visible in target chat
- target agent does not auto-act beyond acknowledging the imported handoff turn mechanics
- busy target transfer is blocked with a clear message

## 16.6 Non-functional tests

Add at least lightweight verification for:
- long source sessions with large visible history
- truncation determinism
- no runaway payload growth from visible tools
- no inclusion of hidden reasoning blocks

## 17. Edge Cases and Failure Modes

Execution agents must explicitly handle these.

## 17.1 Source session not found

Expected behaviour:
- fail clearly
- do not create target session as side effect
- emit `SESSION_NOT_FOUND`-style error

## 17.2 Target session not found

Expected behaviour:
- fail clearly
- do not silently create a replacement unless request explicitly asked for `createNew`

## 17.3 Source equals target

Expected behaviour:
- reject in MVP
- avoid self-transfer recursion/noise

## 17.4 Busy/streaming target

Expected behaviour:
- reject transfer in MVP
- do not queue silently
- return explicit error code/status

## 17.5 Empty or near-empty source session

Expected behaviour:
- either reject as nothing useful to transfer
- or create a minimal framed handoff stating there was no visible transcript

Preferred MVP behaviour:
- reject with a user-facing “Nothing visible to transfer” style error

## 17.6 Very long visible transcript

Expected behaviour:
- apply scope rules correctly
- if full visible transcript becomes too large, either:
  - truncate deterministically with explicit note in payload, or
  - fail with a clear message if target constraints prevent safe injection

Do not silently pass massive raw content through.

## 17.7 Source/target cwd mismatch

Expected behaviour:
- include source and target cwd in confirmation metadata
- do not block solely because of mismatch
- preserve source cwd in the framed handoff

## 17.8 Runtime unavailable during new target creation

Examples:
- Claude Direct unavailable
- OpenCode unavailable

Expected behaviour:
- fail before any partial transfer dispatch
- return runtime-specific availability error

## 17.9 Tool-heavy sessions

Expected behaviour:
- transfer remains readable and bounded
- only visible summary-level tool info survives

## 17.10 Skill-heavy sessions

Expected behaviour:
- raw skill dumps do not leak into transfer
- only placeholders survive where applicable

## 17.11 Hidden reasoning present in source

Expected behaviour:
- do not transfer hidden thinking/reasoning blocks
- unless a reasoning block is already intentionally part of visible default rendering, treat it as excluded

## 17.12 Partial failure after new target creation

Example:
- target session created successfully
- handoff injection fails

Expected behaviour:
- return explicit failure referencing created target session ID
- do not hide the existence of the new empty session
- leave cleanup policy explicit; MVP may keep the created session for auditability

## 18. Security and Validation Requirements

All transfer work must preserve existing security rules.

## 18.1 Authentication and CSRF

Transfer endpoints/messages must remain behind existing:
- cookie auth
- CSRF validation
- origin protections

## 18.2 Input validation

Validate:
- source session ID
- target session ID
- target sdk type for new session
- target cwd
- scope enum
- optional display name length/format

Use Zod or equivalent schema validation where appropriate.

## 18.3 Prompt-injection considerations

The generated handoff is system-generated, but it still becomes prompt content for the target runtime.

Required safeguards:
- framing must clearly mark the content as historical context
- target agent must be told to wait for further user instructions
- do not let user-controlled metadata bypass prompt-injection checks on unrelated freeform fields

## 18.4 Path handling

Any cwd/path supplied for new target creation must use existing safe path validation mechanisms.

## 19. Git Strategy

The user requested git strategy guidance without prescribing branches/worktrees.

## 19.1 Commit strategy

Use small, reviewable commits grouped by module family:

1. transfer types + scaffolding
2. visible transcript builder
3. Pi adapter
4. Claude adapter
5. OpenCode adapter
6. target dispatch/orchestration
7. protocol integration
8. tests
9. docs

## 19.2 Commit hygiene

Before every commit checkpoint:

```bash
git status --short
git diff --stat
npm run lint
npm run typecheck
npm run build
npm test
```

For protocol-visible behaviour or end-to-end transfer flows, also run:

```bash
npm run test:e2e
```

## 19.3 Review strategy

Each commit should be understandable on its own and avoid mixing:
- runtime adapter work
- protocol plumbing
- unrelated refactors

Keep refactors strictly in support of transfer implementation.

## 20. Acceptance Criteria

The feature is ready for merge when all of the following are true:

1. A source session’s **default visible transcript** can be reconstructed server-side for Pi, Claude, and OpenCode sessions.
2. A transfer can target an existing session across runtime boundaries.
3. A transfer can target a newly-created session for each supported runtime.
4. The transferred handoff is **visible** in the target session.
5. The handoff includes source display name, source runtime, source cwd, transfer timestamp, and scope.
6. The handoff framing explicitly says the target agent should **not act yet** and should **wait for the user’s next instruction**.
7. Hidden reasoning and raw verbose tool internals are not transferred.
8. Busy target sessions are rejected in MVP.
9. Recent/full scope options work deterministically.
10. All relevant unit, integration, and E2E tests pass.

## 21. Suggested Post-MVP Extensions

Not for the initial implementation, but worth documenting now.

- custom range selection
- AI-assisted optional compression for oversized visible transfers
- server-generated preview content before confirmation
- queued transfer when target becomes idle
- transfer export/import as standalone artefact
- transfer provenance history attached to sessions
- richer workspace mismatch warnings

## 22. Recommended First Execution Order

For a fresh execution agent set, the best order is:

1. Read:
   - `README.md`
   - `docs/ARCHITECTURE.md`
   - `docs/PROTOCOL.md`
   - this plan
2. Implement transfer type scaffolding in `server/src/session-transfer/`
3. Implement common visible transcript builder + unit tests
4. Implement runtime adapters in parallel:
   - Pi
   - Claude
   - OpenCode
5. Implement transfer framing + orchestration
6. Integrate into WebSocket/protocol handling
7. Add integration tests
8. Add E2E coverage
9. Update protocol docs and any architecture notes
10. Run full verification suite

## 23. Final Implementation Notes

- Prefer extracting and centralizing existing visibility/filtering logic over duplicating it.
- Keep the transfer contract deterministic and server-owned.
- Treat this as a **handoff feature**, not a replay/migration feature.
- When in doubt, choose the lower-bloat, more explicit, more user-auditable behaviour.
- Preserve the product intent: **move visible conversation context across runtime boundaries without dragging raw runtime verbosity with it.**
