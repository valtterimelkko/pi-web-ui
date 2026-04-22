# Session Context Transfer Frontend Plan

> Status: **proposed**
>
> Audience: frontend maintainers and coding agents implementing the browser/UI side of session context transfer.
>
> Companion document: [`SESSION-CONTEXT-TRANSFER-PLAN.md`](./SESSION-CONTEXT-TRANSFER-PLAN.md)
>
> Scope note: this plan is intentionally **frontend-focused**. It defines user-visible behaviour, interaction flows, state expectations, and test expectations. It does **not** prescribe exact component code, exact hook structure, or exact drag-and-drop library usage.

## 1. Purpose

This document defines how the **web UI** should expose session context transfer to the user.

The backend plan defines how visible transcript transfer should be built and dispatched across runtimes. This document defines how the browser should let the user:

- initiate transfer from the session list
- choose an existing session or a new session as target
- confirm the transfer deliberately
- understand what will be transferred
- choose transfer scope
- choose runtime/CWD for new target sessions
- see failure states clearly
- understand that the transfer is **informational only** and that the target agent should **wait for further instructions**

## 2. Product Intent for the Frontend

The UI must communicate the feature as a **handoff** rather than as:
- merge
- clone
- replay
- migration
- compaction
- silent context injection

The frontend must reinforce these ideas:
- only the **default visible transcript** is transferred
- this is designed to reduce context bloat, not carry full backend verbosity
- the transfer is **visible** in the target session
- the target agent is being informed, not instructed to act
- the user remains in control and must confirm the operation

## 3. Core UX Principles

## 3.1 Deliberate, not accidental

Drag-and-drop is the initiation gesture, but transfer must **always** require confirmation.

No transfer should happen instantly on drop.

## 3.2 Source and target should be obvious

At all times during the flow, the UI should make it clear:
- which session is the source
- which session is the target
- whether the target is existing or new
- what runtime the target uses
- what CWD/workspace the target uses
- what scope will be transferred

## 3.3 The wording must reflect “visible context”

The UI must not imply that the system is transferring:
- hidden reasoning
- all tool internals
- full raw transcript state
- native backend session continuation state

Use language like:
- “visible context”
- “visible transcript”
- “default-rendered conversation”
- “handoff”

Avoid language like:
- “full context clone”
- “copy everything”
- “resume exact state”

## 3.4 The user should understand the result before confirming

The confirmation step should explain that:
- the handoff will appear visibly in the target session
- the target agent will be told **not to act yet**
- the user should then send the next instruction manually

## 4. Main User Flows

## 4.1 Flow A — drag source session onto an existing session

### Trigger
The user drags session **A** from the left-hand session list onto session **B** in the same list.

### Required UX behaviour
1. Drag affordance begins from the source session item.
2. Valid drop targets become visually identifiable.
3. On drop onto an existing session, the UI does **not** transfer immediately.
4. Instead, a **confirmation modal/dialog** opens.

### Confirmation contents
The confirmation must show:
- source session display name
- source runtime
- source CWD
- target session display name
- target runtime
- target CWD
- transfer scope selector:
  - **Recent visible context**
  - **Full visible context**
- explicit note if source and target CWD differ
- statement that the transferred handoff will be visible in the target session
- statement that the target agent will be told to wait for further instructions

### Confirm action
If the user confirms:
- the frontend sends the transfer request to the backend
- the backend performs the transfer
- the frontend then surfaces completion clearly and routes the user to the target session if appropriate

### Cancel action
If the user cancels:
- no transfer occurs
- no side effects remain

## 4.2 Flow B — drag source session onto a “New Session” drop target

### Trigger
The user drags session **A** onto a dedicated **New Session** drop target in the session list/sidebar area.

### Required UX behaviour
1. The new-session drop target must be visually discoverable when drag starts.
2. On drop, a **new-session transfer confirmation flow** opens.
3. The modal/dialog must collect:
   - target runtime
   - target CWD/workspace
   - transfer scope
4. The modal/dialog must still show source metadata clearly.

### Required form inputs
For new target creation, the UI must collect in this order conceptually:
1. **Runtime**
2. **CWD/workspace**
3. **Transfer scope**

Exact layout may vary, but the information hierarchy must remain clear.

### Confirmation contents
Show:
- source session display name
- source runtime
- source CWD
- chosen target runtime
- chosen target CWD
- chosen scope
- explicit note if source and target CWD differ
- statement that a new target session will be created
- statement that the handoff will be visible in that new session
- statement that the target agent will be told not to act yet

### Confirm action
If confirmed:
- frontend sends a create-new transfer request to backend
- backend creates the new target session and injects the handoff
- frontend should switch to or open that created target session after success

## 4.3 Flow C — busy target session rejection

### Trigger
The user attempts transfer into a target session that is currently busy/streaming.

### Required UX behaviour
- confirmation may still appear if the frontend does not already know the session is busy
- on backend rejection, the UI must show a clear error state
- message should explain that transfer to a busy session is blocked in the current version
- the UI must not imply the transfer was queued

## 4.4 Flow D — invalid or empty source

If the backend reports:
- source session not found
- nothing visible to transfer
- invalid source/target relationship

the frontend must show a clear, non-ambiguous failure state.

## 5. Frontend Functional Requirements

## 5.1 Drag source requirements

The session item in the sidebar/session list must support acting as a **drag source**.

Minimum functional requirements:
- dragging starts from the session item itself
- source session remains identifiable during drag
- the drag affordance should feel intentional, not like ordinary click-to-switch
- drag initiation must not accidentally switch sessions

## 5.2 Drop target requirements

The UI must support at least two target classes:
- existing session items
- dedicated “New Session” drop target

Drop target states should include:
- default
- drag-over/active
- invalid/unavailable
- disabled if necessary

## 5.3 Confirmation dialog requirements

The confirmation dialog is not optional. It is a core part of the product flow.

The dialog must support two variants:
- **existing target variant**
- **new target variant**

Shared fields/content:
- source display name
- source runtime
- source CWD
- transfer scope choice
- explanatory copy about visible context and no auto-action

Existing-target-only content:
- target display name
- target runtime
- target CWD

New-target-only content:
- runtime picker
- CWD/workspace picker
- any relevant availability indicators for Claude/OpenCode

## 5.4 Scope selector requirements

The UI must provide two MVP options:
- **Recent visible context**
- **Full visible context**

Recommended guidance copy:
- Recent visible context: lighter handoff for long sessions
- Full visible context: broader handoff for important/shorter sessions

The UI should encourage deliberate selection rather than hiding this choice.

## 5.5 Runtime selection requirements for new session target

When creating a new target session through transfer, the runtime selection UI should align with the mental model already used in the app.

Required behaviours:
- show available runtime options consistent with existing session creation patterns
- reflect availability state for optional runtimes
- prevent selecting unavailable runtimes
- preserve clear labels between Pi SDK / Claude Direct / OpenCode Direct

## 5.6 CWD/workspace selection requirements for new target

The new-target transfer flow must let the user choose the target CWD explicitly.

The UI may reuse or adapt existing new-session folder-selection patterns.

Required behaviours:
- let the user browse/select workspace path
- show selected CWD clearly in confirmation
- preserve source CWD display for comparison
- surface mismatch when source and target differ

## 5.7 Source display name requirement

The source session label used in the transfer UI should come from the **session list / sidebar naming layer**, not from any more obscure or less user-controlled label elsewhere in the screen.

This is important because the user may rename sessions in the sidebar for their own organisational needs.

If the frontend is the current source of truth for that display name, it should send that display name to the backend as part of the transfer request, so the visible target handoff can reflect the name the user actually recognises.

## 6. Information Architecture of the Confirmation UI

The confirmation UI should answer four questions for the user before they confirm:

1. **What is being transferred?**
   - visible context from source session
2. **Where is it going?**
   - existing target session or a new session
3. **How much is being transferred?**
   - recent vs full visible context
4. **What happens next?**
   - visible handoff appears; target agent waits for next instruction

## 6.1 Recommended content blocks

A strong confirmation UI will likely contain these blocks:

### Block A — Source
- source display name
- source runtime
- source CWD

### Block B — Target
- existing target display name/runtime/CWD
- or new target runtime/CWD selectors

### Block C — Scope
- recent/full selector
- short explanation of each

### Block D — Important note
- only visible/default-rendered context is transferred
- hidden reasoning and full tool internals are not transferred
- target agent will be told not to act yet

### Block E — Workspace mismatch note
If source and target CWD differ, show a visual warning or informational callout.

## 7. Frontend State Requirements

The exact state location is up to the implementer, but the frontend must model these conceptual states.

## 7.1 Drag state

State must represent:
- whether a drag is in progress
- source session ID
- source display name
- source runtime
- source CWD
- current hover target type
- current hover target ID if applicable

## 7.2 Transfer modal state

State must represent:
- whether confirmation is open
- source session metadata
- target mode: existing vs new
- existing target metadata if applicable
- selected target runtime if new
- selected target CWD if new
- selected transfer scope
- any mismatch state
- submission/pending state
- error state

## 7.3 Transfer execution state

State must represent:
- submitting transfer request
- transfer succeeded
- transfer failed
- new target session ID if created

## 7.4 Post-transfer navigation state

If the backend creates a new target session or confirms an existing target transfer, the UI should know whether it should:
- stay in source session
- switch to target session
- highlight/open target session

Recommended product behaviour:
- after successful transfer, switch to the target session or otherwise make it immediately accessible/visible

## 8. Frontend-to-Backend Contract

This plan assumes the backend contract defined in the companion backend plan.

The frontend should be prepared to send a request containing conceptually:
- source session ID
- target session ID or create-new intent
- target runtime for new session
- target CWD for new session
- transfer scope
- source display name from sidebar naming layer

The frontend should also be prepared to handle responses conceptually such as:
- transfer succeeded
- transfer failed
- created target session ID

## 8.1 Required frontend-supplied metadata

The frontend should supply the source session display name if that name exists only in frontend UI state and differs from backend registry/session storage.

This is necessary so the target handoff can display the source name the user actually recognises.

## 8.2 Failure handling expectations

The frontend must map backend errors into clear user-facing messages. At minimum handle:
- source session not found
- target session not found
- invalid transfer target
- busy target session
- runtime unavailable for new target
- nothing visible to transfer
- generic transfer failure

## 9. Existing-vs-New Target Behaviour Expectations

## 9.1 Existing target

When targeting an existing session:
- the runtime is inherited from that session
- the user should not be asked to choose runtime
- the user should be shown the target runtime
- the user should be shown the target CWD

## 9.2 New target

When targeting a new session:
- the UI must ask for runtime
- the UI must ask for CWD
- the UI must ask for scope
- then confirmation should clearly restate those choices before execution

## 10. Copy/Content Requirements

The frontend copy should preserve the product framing.

## 10.1 Required conceptual copy

The UI should communicate something equivalent to:
- only visible/default-rendered context will be transferred
- full internal reasoning and full tool internals are not included
- the transfer will appear visibly in the target session
- the target agent will be told to wait for the user’s next instruction

## 10.2 Avoid misleading copy

Do not imply:
- exact session continuation
- full internal state preservation
- hidden memory import
- automatic next-step action by the target agent

## 11. Error UX Requirements

## 11.1 Blocking errors

Blocking errors should be shown prominently in the modal or in a clearly visible toast + inline surface.

Examples:
- selected runtime unavailable
- no target CWD chosen
- source equals target
- busy target session

## 11.2 Recoverable errors

If the user can fix the problem, the modal should stay open when reasonable.

Examples:
- missing CWD
- unavailable runtime selection

## 11.3 Terminal errors

If the transfer cannot proceed because the backend rejected the source or target, the UI may close the modal after surfacing the error, but must make the failure clear.

## 12. Accessibility and Usability Requirements

The transfer UI must not rely on drag-and-drop alone for comprehension.

Even if drag-and-drop is the initiation gesture, the rest of the flow must remain understandable through explicit labels and dialog controls.

Minimum expectations:
- modal/dialog is keyboard accessible
- confirmation/cancel controls are clear
- selected target/runtime/scope are readable without relying only on colour
- drag-over states should have visible contrast cues
- warnings such as CWD mismatch should be readable and not colour-only

## 13. Suggested Frontend Module/Task Breakdown

This is designed for parallelisation without prescribing exact code structure.

## 13.1 Workstream F1 — drag-and-drop interaction layer

Deliver:
- session item drag source behaviour
- existing session drop target behaviour
- new-session drop target behaviour
- drag-state visual feedback

Dependencies:
- minimal dependency on modal contract
- can begin early

## 13.2 Workstream F2 — transfer confirmation UX

Deliver:
- existing-target confirmation variant
- new-target confirmation variant
- scope selection UI
- mismatch display
- submission/error states

Dependencies:
- backend request shape should be known conceptually

## 13.3 Workstream F3 — new target runtime/CWD selection reuse

Deliver:
- runtime selection behaviour aligned with existing session creation
- CWD selection behaviour aligned with existing folder picker/session creation flows
- integration into transfer confirmation flow

Dependencies:
- F2
- existing new session creation patterns

## 13.4 Workstream F4 — transport/store integration

Deliver:
- frontend action to dispatch transfer request
- success/failure handling
- target session navigation/update behaviour
- use of sidebar display name as source metadata

Dependencies:
- backend protocol implementation readiness
- F2 decisions

## 13.5 Workstream F5 — frontend tests

Deliver:
- component/unit tests
- interaction tests
- E2E coverage additions

Dependencies:
- all workstreams above for final assertions

## 14. Dependency Summary for Frontend Work

Hard dependencies:
- F2 before final F4 wiring
- F3 before complete new-target transfer flow
- backend protocol readiness before final success-path integration

Soft dependencies:
- F1 and F2 can proceed in parallel with stubs/mocks
- F5 can scaffold early

## 15. Frontend Test Plan

Even though this document does not prescribe exact file edits, a fresh coding agent should extend the test suite to cover the feature end-to-end from the user’s perspective.

## 15.1 Component/unit test coverage expectations

Add or extend tests for:
- session items becoming drag sources
- existing session drop target highlighting
- new-session drop target highlighting
- confirmation modal opening on drop
- correct source/target metadata shown
- scope selector defaults and changes
- runtime selector behaviour in new-target flow
- CWD selector behaviour in new-target flow
- mismatch warning display
- confirmation submit/cancel behaviour
- busy target error rendering
- transfer success handling/navigation

## 15.2 Store/hook/integration test coverage expectations

Add or extend tests for:
- drag state transitions
- modal state transitions
- request payload generation
- source display name sourced from sidebar/session naming layer
- response handling for success/failure
- new target session success updating session list / current session

## 15.3 E2E coverage expectations

E2E tests should verify at minimum:
- drag source session to existing target opens confirmation
- selecting recent/full scope affects request path
- drag source session to new-session target opens runtime/CWD/scope flow
- target metadata shown correctly
- CWD mismatch surfaced
- transfer success leads user to visible target handoff
- busy target transfer fails clearly
- cancel leaves everything unchanged

## 16. Edge Cases for Frontend Behaviour

## 16.1 Drop on self

If the user drags a session onto itself:
- prevent or reject the drop
- show clear feedback if necessary

## 16.2 Drop outside valid target

If the user drops outside a valid target:
- no modal should open
- no side effect should occur

## 16.3 Source session renamed in sidebar

The transferred source label shown in the UI should reflect the sidebar-renamed name, not a less familiar internal title.

## 16.4 Runtime unavailable for new target

The UI should visibly disable unavailable runtime options and explain why.

## 16.5 CWD not selected

The confirm action for new target must remain blocked until CWD is validly selected.

## 16.6 Transfer fails after user confirms

If the backend fails after confirmation:
- show explicit error
- do not silently close as if successful
- do not switch sessions unless the backend confirms success

## 16.7 New target created but transfer injection fails

If backend reports partial failure:
- surface that clearly
- if a new target session was created, make it discoverable rather than hiding it

## 17. Acceptance Criteria for Frontend

Frontend implementation is complete when all of the following are true:

1. A user can initiate transfer by dragging a session from the sidebar/session list.
2. A user can drop onto an existing session and receive a confirmation dialog.
3. A user can drop onto a new-session target and receive a runtime/CWD/scope flow.
4. Confirmation is always required before transfer.
5. The confirmation UI clearly explains that only visible/default-rendered context is transferred.
6. The confirmation UI clearly explains that the transfer will appear visibly in the target session.
7. The confirmation UI clearly explains that the target agent will be told to wait for further instructions.
8. The source session name shown in the flow comes from the sidebar/session naming layer.
9. Source runtime, source CWD, target runtime, target CWD, and mismatch state are visible where applicable.
10. Recent/full scope can be selected.
11. Busy target transfers fail clearly.
12. Successful transfer makes the target session and handoff clearly accessible to the user.
13. All added/updated frontend tests and E2E tests pass.

## 18. Suggested Execution Order for a Fresh Frontend Agent

1. Read:
   - `README.md`
   - `docs/ARCHITECTURE.md`
   - `docs/PROTOCOL.md`
   - `docs/SESSION-CONTEXT-TRANSFER-PLAN.md`
   - this document
2. Inspect current session list/sidebar/new-session modal flows
3. Implement drag state and drop targets
4. Implement confirmation UX for existing target
5. Implement new-target runtime/CWD/scope flow
6. Wire transfer request dispatch and response handling
7. Add/extend component/store tests
8. Add/extend E2E tests
9. Run full verification

## 19. Final Notes

- The frontend should make the feature feel **safe, deliberate, and low-bloat**.
- The UI’s job is not just to expose a backend capability; it is to preserve the product intent behind the capability.
- When in doubt, prefer clarity over cleverness.
- The user should always understand that this is a **visible handoff of visible context**, and that the next real instruction still comes from them.
