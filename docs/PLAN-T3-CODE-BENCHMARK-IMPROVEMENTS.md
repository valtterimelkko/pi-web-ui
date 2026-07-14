# Plan: Improvements Borrowed from the T3 Code Benchmark

_Status: proposed plan; no implementation in this document._
_Date: 2026-07-14_

## Purpose

This plan records the concrete improvements Pi Web UI may borrow from the benchmark of [T3 Code](https://t3.codes/) and [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The conclusion of the benchmark is **not** to copy T3 Code or replace Pi Web UI's architecture. Pi Web UI already has a broader runtime surface: Pi Coding Agent, Claude, OpenCode, and Antigravity, with replay, transfer, pinning, Internal API orchestration, live validation, and runtime-specific security controls.

The useful T3 ideas are control-plane mechanics:

1. configured runtime instances separate from runtime families;
2. immutable session-to-runtime bindings and explicit continuation rules;
3. a distinct run/dispatch identity with idempotent completion receipts;
4. richer event correlation and replay cursors;
5. typed asynchronous completion signals and deterministic worker drains.

## Evidence and benchmark references

### T3 Code

- Website positioning: [T3 Code](https://t3.codes/)
- Runtime adapter boundary: [`ProviderAdapter.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Services/ProviderAdapter.ts)
- Cross-provider routing and recovery: [`ProviderService.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Layers/ProviderService.ts)
- Adapter lookup: [`ProviderAdapterRegistry.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Services/ProviderAdapterRegistry.ts)
- Persisted runtime binding: [`ProviderSessionDirectory.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Services/ProviderSessionDirectory.ts)
- Driver-vs-instance distinction: [`providerInstance.ts`](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/providerInstance.ts)
- Typed runtime events: [`providerRuntime.ts`](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/providerRuntime.ts)
- Project/thread/turn contracts and sequence-aware subscriptions: [`orchestration.ts`](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestration.ts)
- Ordered orchestration and command receipts: [`OrchestrationEngine.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Layers/OrchestrationEngine.ts)
- Deterministic worker completion: [`DrainableWorker.ts`](https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/DrainableWorker.ts)
- Typed async receipts: [`RuntimeReceiptBus.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/RuntimeReceiptBus.ts)
- Architecture overview: [`docs/architecture/overview.md`](https://github.com/pingdotgg/t3code/blob/main/docs/architecture/overview.md)

### Pi Web UI baseline

- Runtime boundary and current four-runtime architecture: `docs/ARCHITECTURE.md`
- Event pipeline and current `NormalizedEvent` contract: `docs/EVENT-PIPELINE.md`, `shared/src/protocol-types.ts`
- Unified registry: `server/src/session-registry.ts`
- Claude configured profiles: `server/src/claude/claude-profiles.ts`, `server/src/claude/claude-service.ts`
- Internal API contract and additive-versioning rules: `docs/INTERNAL-API-CONTRACT.md`
- Internal API orchestration surface and current limitations: `docs/INTERNAL-API-ORCHESTRATION.md`
- Worker/session isolation: `docs/PROCESS-ISOLATION-DESIGN.md`

## Target boundary

```text
Agent OS
  work objects, context packets, routing policy, quota, approval, acceptance
        |
        | generic execution intent + idempotency key
        v
Pi Web UI Internal API
  capabilities, runtime-instance resolution, session lifecycle,
  native resume rules, events, receipts, transcripts, usage
        |
        v
Pi / Claude / OpenCode / Antigravity adapters
```

Pi Web UI remains the runtime gateway. It must not import Agent OS memory or work-object ontology.

## Proposed concepts

### 1. Runtime family versus runtime instance

Keep the existing `sdkType` as the runtime-family discriminator:

```text
pi | claude | opencode | antigravity
```

Add an optional generic execution-instance identity. Initially, existing Claude profiles provide the first concrete implementation:

```text
claude-native-subscription
claude-glm-sdk
claude-channel
opencode-zai-default
pi-local-default
antigravity-default
```

A session binding should eventually record:

```text
sessionId
runtimeFamily
executionInstanceId
adapter/backend kind
model selection
cwd/worktree
native session/conversation id
resume cursor or equivalent continuation state
continuation capabilities
```

The instance is the stable owner of a continuation. A session must not silently resume through a different profile, provider, endpoint, or backend.

### 2. Execution binding

Introduce an internal, versioned binding model before changing public behaviour:

```ts
interface ExecutionBinding {
  sessionId: string;
  runtime: SdkType;
  executionInstanceId: string;
  adapterKind: string;
  model?: string;
  cwd: string;
  nativeSessionId?: string;
  resumeCursor?: unknown;
  continuation: {
    canResume: boolean;
    canSwitchModel: boolean;
    compatibleInstanceIds?: string[];
    reasonIfDenied?: string;
  };
}
```

The exact final schema should be decided through tests and compatibility review; this is a planning shape, not an implementation mandate.

### 3. Run identity and terminal receipt

A long-lived session and one prompt execution are different objects. Add a distinct run identity for Internal API dispatch:

```text
accepted -> started -> completed | failed | cancelled
```

A receipt should include the session binding, terminal timestamp, final status, error code if applicable, and a transcript/event cursor reference where available.

This addresses the current Internal API limitation that it is session-oriented and has no generic job/run registry.

### 4. Event correlation and replay

Retain the existing `NormalizedEvent` shape for WebSocket compatibility, but add an additive internal/event-stream envelope with:

```text
eventId
sequence
runId
turnId
requestId
causation/correlation id
runtime instance id
terminal outcome where applicable
```

The Internal API should eventually support snapshot-plus-events-after-cursor recovery rather than relying only on a short in-memory event tail.

### 5. Typed async receipts and drains

Use narrow receipt channels for meaningful milestones, for example:

```text
turn.quiesced
transcript.persisted
session.recovered
transfer.completed
checkpoint.completed
notification.delivered
```

Use drainable workers only around asynchronous side effects where tests or orchestration currently depend on timing, sleeps, or indirect status inference.

## Phased implementation plan

### Phase 0 — contract and evidence first

- Write an ADR for runtime family, runtime instance, execution binding, run identity, and continuation compatibility.
- Inventory every existing runtime-specific registry field and native resume path.
- Define invariants and failure cases before implementation:
  - no silent instance switching on resume;
  - missing/disabled instance fails explicitly;
  - no secrets in bindings, events, or receipts;
  - old API clients continue to work;
  - every accepted detached run has a terminal or recoverable state.
- Add unit fixtures for native Claude, Claude profile, OpenCode, Pi, and Antigravity bindings.

### Phase 1 — internal session binding

- Add a generic binding representation behind the existing `SessionRegistryManager`.
- Map `claudeProfileId` to `executionInstanceId` without removing legacy fields.
- Give other runtimes one default instance ID initially; do not create a configuration UI until multiple real instances exist.
- Add explicit resume/switch compatibility checks in each runtime service.

### Phase 2 — run and receipt layer

- Add optional `idempotencyKey` and returned `runId` to Internal API prompt dispatch.
- Add receipt lookup for detached/background work.
- Make duplicate dispatches return the existing run receipt rather than starting a second prompt.
- Preserve `/wait`, `/transcript`, `/history`, and existing error-code semantics.
- Update `docs/INTERNAL-API.md`, `docs/INTERNAL-API-ORCHESTRATION.md`, and the contract changelog additively.

### Phase 3 — event cursor and deterministic completion

- Add monotonic event sequence and run/session correlation fields.
- Add snapshot-plus-cursor replay for reconnecting local consumers.
- Introduce typed completion receipts for selected asynchronous flows.
- Add `DrainableWorker`-style helpers only where a concrete race or polling problem is demonstrated.

### Phase 4 — Agent OS integration

- Extend the Agent OS client contract to consume run IDs, receipts, instance identity, and event/transcript evidence.
- Add live and restart validation for:
  - same-instance resume;
  - disabled-instance failure;
  - duplicate dispatch idempotency;
  - reconnect after missed events;
  - terminal receipt persistence.

## Non-goals

- No Effect-TS or T3 monorepo adoption.
- No wholesale replacement of Express, Zustand, workers, or current runtime services.
- No replacement of `sdkType`.
- No import of Agent OS memory/work-object concepts into Pi Web UI.
- No full SQL event-sourced rewrite unless real recovery evidence justifies it.
- No assumption that every runtime supports the same resume, model-switch, approval, or streaming behaviour.

## Definition of done for this plan

The work is successful when Pi Web UI can answer, for every orchestrated execution:

1. Which runtime family and configured instance handled it?
2. Which model/backend/provider configuration was active?
3. Can the native session be resumed safely, and why?
4. Was this prompt dispatched exactly once?
5. What reliable receipt proves completion or failure?
6. Can a reconnecting consumer recover without losing or duplicating events?

All additions must remain compatible with the existing local-only Internal API boundary and Agent OS's separate ownership of durable work state.
