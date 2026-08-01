# Orchestrated run liveness and recovery — intent and rationale

> **Status:** design intent and rationale; not a shipped contract, schema, implementation plan, or release commitment
>
> **Audience:** Pi Web UI maintainers, runtime-adapter authors, Internal API consumers, and orchestration clients
>
> **Current contract authority:** [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md)
>
> **Related current behaviour:** [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md), [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md), [`OBSERVABILITY.md`](./OBSERVABILITY.md), and [`DURABILITY-MATRIX.md`](./DURABILITY-MATRIX.md)

## 1. Purpose

Pi Web UI is increasingly used as a runtime gateway for work that outlives one HTTP request, one event-stream connection, or one attentive human watch. Its current durable run receipts, detached dispatch, retention leases, normalized events, diagnostics and watchdogs provide a strong base. Lived orchestration use has nevertheless exposed a gap: a consumer can often determine that a run stopped, but not always reconstruct **why it appeared idle, what the runtime last proved, whether later terminal evidence arrived, and what partial output may remain recoverable**.

This document records the intended direction for improving that generic runtime evidence. It explains why the distinctions matter and the qualities a future design should preserve. It deliberately does not choose endpoint fields, storage layouts, migration steps, timeout defaults or release sequencing. Any shipped change must be specified separately, reflected in the versioned Internal API contract and capabilities, and validated per runtime.

## 2. The motivating incident pattern

A representative orchestration failure can span several individually reasonable mechanisms:

1. an accepted parent turn delegates local child work;
2. the visible parent event stream becomes quiet while nested or external activity may still exist;
3. the watchdog reaches its inactivity bound and durably terminates the accepted turn with `TURN_STALLED` so capacity is not held forever;
4. useful files or partial output may already exist;
5. a later runtime event, transcript update, or terminal signal may arrive after the watchdog decision;
6. an external orchestrator observes the receipt later and must decide whether to inspect, retry, abandon or ask an owner for a recovery decision.

The watchdog is not the defect in this chain. An accepted turn needs a bounded failure mode. Nor should Pi Web UI keep a run alive merely because a session is retained or a process exists. The missing quality is **truthful, attributable, durable liveness and recovery evidence around the boundary**.

A runtime gateway should help a caller distinguish:

- “the runtime produced no attributable activity for the configured idle interval”;
- “the run exceeded an absolute execution bound”;
- “the observer checked late, but the run had already terminated”;
- “a later terminal signal arrived after a stall decision”;
- “the receipt is terminal, but recoverable artefacts may exist”;
- “the runtime cannot prove whether work continues elsewhere”.

Those are not equivalent states and should not be collapsed into “timed out”, “completed”, or “still running”.

## 3. Boundary: what Pi Web UI should and should not own

Pi Web UI should remain a **generic multi-runtime session and execution gateway**.

It owns or can truthfully project:

- accepted dispatch identity (`sessionId`, `runId`, `requestId`, and execution-instance identity where supported);
- runtime/session lifecycle and normalized event evidence;
- run-receipt state and terminal reason;
- source-owned runtime retention;
- watchdog decisions and the activity evidence used by them;
- bounded transcripts, screen projections, diagnostics and runtime-owned artefact locators;
- what survives browser disconnect or server restart.

It should not acquire an external orchestrator's ontology or authority. In particular, Pi Web UI should not own:

- project/workspace exclusivity leases;
- work objects, mission checkpoints or acceptance criteria;
- delegation hierarchy policy;
- semantic acceptance or sign-off;
- owner/proxy authority decisions;
- whether partial output is good enough to merge;
- recovery decisions such as rework, abandon, reconcile or force release in another system.

A consumer such as Agent OS may combine Pi Web UI evidence with repository state, work objects and owner decisions. Pi Web UI's responsibility is to make its portion generic, durable and honest—not to decide the consumer's verdict.

## 4. Core intent

### 4.1 Report evidence, not confidence theatre

Liveness should be grounded in attributable events or runtime evidence. A periodic timer emitted only to prevent a timeout is not progress. Durable retention preserves recoverability, while resident retention or pinning may keep a runtime loaded; none of them proves execution. An open process is not necessarily making progress. A changed file may be useful evidence but does not prove the accepted turn is complete.

Future surfaces should prefer statements such as “last normalized tool event at …” or “runtime adapter last observed output at …” over an unqualified “alive”. Where the runtime cannot expose reliable progress, the contract should say so.

### 4.2 Distinguish inactivity from absolute duration

An **idle/inactivity bound** answers: “How long has it been since attributable run activity?”

An **absolute execution bound** answers: “How long may this accepted run consume capacity regardless of activity?”

They serve different safety goals. A healthy long turn might repeatedly show attributable activity and still exceed an absolute policy limit. A dead turn might hit the idle limit quickly. A future model should preserve that distinction—for example through a conceptual `stallReason` of `idle` versus `absolute`—without this document prescribing the exact field name or wire shape.

### 4.3 Make the activity clock attributable

A useful activity timestamp needs a defined source. The conceptual evidence may include:

- a durable `lastActivityAt` for the accepted run;
- the last attributed normalized event type;
- the runtime/backend that supplied it;
- whether the signal was source-native, adapter-derived, synthetic but evidence-backed, or unavailable;
- the activity policy/version used by the watchdog.

Not every event should reset an inactivity clock. Observer attachment, receipt polling, session retention, generic health checks and blind periodic heartbeats are not run progress. Current normalized events are primarily session-scoped, while receipts belong only to accepted Internal API runs; an event that cannot be bound to the active run/execution instance must not reset that run's watchdog. Replayed, duplicate, previous-turn and cross-run events are likewise ineligible. Runtime adapter evidence such as tool lifecycle, token/output progress, a validated PTY busy signal, bounded subprocess log movement, or a native terminal event may qualify only under explicit per-runtime attribution semantics.

### 4.4 Preserve late evidence without rewriting history

Distributed and subprocess-backed systems can deliver evidence out of order. A late `agent_end`, transcript append, worker result or adapter callback should not silently erase a prior watchdog decision. Equally, an earlier `TURN_STALLED` record should not force Pi Web UI to discard stronger later evidence.

Terminality remains monotonic. In particular, current `failed/TURN_STALLED` receipts remain terminal and their capacity stays released. Late evidence may annotate the chronology; it must not reopen, re-admit, resume billing/capacity ownership, or silently convert the run to success.

The desired behaviour is an auditable chronology:

- what the watchdog knew when it acted;
- which terminal decision it durably recorded;
- what later evidence arrived and when;
- whether that evidence was compatible, supplemental or contradictory;
- which state remains canonical under the versioned contract.

The exact representation is open. The invariant is not: history should be additive and truthful, and contradictory terminal evidence should be diagnosable rather than overwritten.

### 4.5 Keep retention separate from execution liveness

A retention lease protects source-owned recoverability for a bounded interval. Durable retention and current runtime residency are separate: a retained session need not be materialized or loaded, while a resident claim says only that Pi Web UI currently holds that runtime resource. Neither authorises unlimited execution, resets inactivity, or proves progress. Explicit session deletion remains a stronger destructive operation and may remove files despite prior retention, according to the current contract. Conversely, a stalled or terminal run may still need short-lived retention so a consumer can inspect transcripts, evidence or recovered artefacts.

Any future liveness surface should therefore display durable retention, current residency and execution as separate dimensions. This prevents a dangerous failure mode in which an orchestrator believes “retained” means “live” or “safe to wait indefinitely”.

### 4.6 Admit uncertainty explicitly

Some runtimes expose rich native events; others expose a batch subprocess and heuristic activity. Nested agents may not surface child events to the parent adapter. Server restart can preserve receipts while losing process-local diagnostics. A truthful generic contract must support `unknown` and explain why evidence is incomplete.

Unknown is preferable to a synthetic heartbeat that hides a deadlock or to a terminal label that implies no useful output exists.

### 4.7 Make partial artefact survivability honest

A terminal run receipt is an execution record, not a transaction over the filesystem. A stalled or aborted turn can leave useful edits, generated files, logs or runtime-native transcript evidence. Pi Web UI should not judge those artefacts semantically, but a future evidence surface may help an orchestrator locate and inspect what survived.

The intent is to expose bounded, privacy-safe facts such as known runtime output locators, transcript availability, worktree/session path identity already permitted by the contract, and whether a final bounded evidence snapshot could be produced. Locators are source-specific observations, not existence guarantees: cleanup, retention expiry, explicit deletion, runtime-native pruning or later filesystem change can invalidate them. It is not to claim that files still exist, or that they are correct, complete, committed, accepted or safe to reuse.

## 5. Conceptual run lifecycle

The current versioned receipt contract remains authoritative. For future reasoning, it is useful to treat a run as several related dimensions rather than one overloaded status:

1. **Admission** — was the prompt accepted, rejected, deduplicated or prevented by capacity/busy-state checks?
2. **Execution** — did the runtime start, and what attributable activity was observed?
3. **Supervision** — did an idle or absolute watchdog decision occur, under which policy and evidence?
4. **Terminal observation** — which runtime/adapter terminal signal was observed, and when?
5. **Recovery evidence** — what durable transcript, diagnostics or bounded artefact locators remain available?
6. **Retention/residency** — which source preserves recoverability, whether a resident claim currently keeps the runtime loaded, and until when?

These dimensions should be correlatable through stable run/session/request/execution-instance identities. They should not imply an external consumer's semantic completion, acceptance or authority.

## 6. Runtime diversity and attribution

A single liveness vocabulary must not pretend all runtimes provide identical evidence.

### Pi Coding Agent

Pi can expose rich model/tool/session events, but work may occur in worker processes and runtime-local subagents may not always project every child action into the parent's normalized stream. Future attribution should clarify whether activity belongs to the accepted parent run, a known nested execution, or only the surrounding session. Worker crash/return and late `agent_end` ordering deserve explicit evidence.

### Claude backends

Claude SDK, direct subprocess and channel-backed modes have different activity and completion signals. Channel PTY activity is heuristic; SDK events may be richer; direct subprocess behavior is turn-shaped. A generic contract should identify evidence quality/source rather than flatten these into identical guarantees.

### OpenCode

OpenCode provides SSE-backed events but requires deduplication and careful observer fan-out. Duplicate events must not create false progress, and source event identity should remain sufficient to explain activity attribution.

### Antigravity

Antigravity output is batch-shaped and currently relies on bounded log/activity evidence plus a stall watchdog and retry policy. Periodic `stream_activity` is live UI activity, not durable run progress; Antigravity's actual stall watchdog is grounded in subprocess/log activity. The UI signal must never reset a durable run watchdog, be described as completion, or become a blind keepalive. The distinction between subprocess/log movement and user-visible output is especially important here.

A future design may therefore expose a common minimum plus runtime-specific evidence metadata. Uniform field names are useful only when their semantics remain honest.

## 7. Durability and restart intent

Orchestration recovery often begins after the original observer has disconnected or the server has restarted. The most useful liveness evidence should therefore align with the durability of run receipts rather than exist only in process-local diagnostics.

Under the current contract, receipts left queued or active by a server restart are recovered as terminal `interrupted` with `SERVER_RESTART`; they are not automatically retried. Runtime-specific stores may separately retain incomplete transcript/session records, but those records do not reopen the receipt.

The intended durability principles are:

- accepted/started/terminal identity and watchdog decisions remain durable;
- the last durable attributed activity needed to explain a stall should survive restart if it becomes part of the receipt/recovery truth;
- process-local diagnostics remain explicitly process-local and bounded;
- reloaded receipts must not claim live observation resumed automatically;
- late evidence after reload is appended or reconciled through defined rules;
- persistence failure must not report a terminal transition that was not durably written;
- migrations remain additive and old receipts stay readable.

This does not imply that in-flight processes survive server restart. They generally do not. Recovery evidence should make that limitation easier to reason about, not obscure it.

## 8. Observer and orchestration semantics

### Detached execution remains the durable path

The current disconnect-safe path is specifically `detach:true` with `verbosity=answers`, subject to runtime/watchdog policy. Streaming `tasks`/`full` requests are supervisory and are cancelled when that caller disconnects. Streaming clients remain supervisors, not the persistence owner of a detached turn; see [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md).

### Polling late must not manufacture a timeout

An orchestrator may poll a receipt after its own check-in time. Pi Web UI should provide enough durable chronology for that client to distinguish “I observed late” from “the runtime completed late” and “the runtime was stopped by policy”. External supervision deadlines are not Pi Web UI terminal state unless the client explicitly requests an abort through the supported contract.

### Watchers should consume, not redefine, run truth

Long-horizon watchers, notifications and external conductor loops may react to run events. Their observer lifecycle and ledgers should remain separate from canonical receipt state. A detached/reloaded watch cannot imply that the underlying run is active, and deletion of a watch must not rewrite receipt history.

### Recovery recommendations belong to the consumer

Pi Web UI may expose evidence that makes “inspect partial output” or “run may need manual attention” a sensible client action. The actual recommendation and any owner question belong to the orchestrator. Pi Web UI should not infer permission to retry, merge, abandon or release another system's lease.

## 9. Safety, privacy and abuse resistance

Richer recovery evidence can increase leakage risk. The existing trust boundary must remain:

- Internal API authentication remains mandatory except for documented health exceptions;
- prompts, transcript bodies, tool payloads, secrets and private paths are not added to diagnostics merely for convenience;
- bounded evidence expansion stays explicit;
- persisted activity metadata is low-cardinality and secret-scrubbed;
- file/artefact locators are canonicalized and exposed only where the existing contract permits them;
- no caller-controlled event can reset a watchdog without attribution and validation;
- duplicate/replayed runtime events cannot extend execution indefinitely;
- an external consumer cannot forge a native terminal event or execution-instance identity;
- retention renewal remains source-owned and bounded;
- contradictory evidence fails visibly rather than choosing the most convenient success state.

## 10. Desired operator and maintainer experience

When a run appears stuck, an operator or agent should be able to answer, with bounded reads:

1. Was the prompt admitted, and under which run/session/execution identity?
2. What was the last attributable activity, from which source, and when?
3. Did an idle or absolute watchdog act, and using which policy?
4. Was a terminal signal observed before or after that decision?
5. Did later evidence arrive?
6. What transcript/diagnostic/artefact evidence survives?
7. Is the session retained, by which source, and until when?
8. Which facts are unknown because the adapter or restart boundary cannot prove them?

The session evidence bundle is the natural diagnostic doorway, but this document does not prescribe whether future evidence belongs there, in run receipts, in event metadata, or in an additive endpoint. The versioned design should avoid forcing callers to reconstruct liveness from unbounded logs.

## 11. Relationship to notifications and frontend state

A terminal notification should reflect the canonical run event available at notification time and retain correlation to later recovery evidence. It should not promise exactly-once delivery or semantic completion.

The browser's `agent_end` handling remains a UI unlock mechanism. A late or synthetic `agent_end` must be reconciled with durable receipt truth so the frontend does not remain falsely busy or display a stalled run as successful. The UI may show liveness details, but it should not become the sole owner of them; browser refresh must not erase the evidence needed by an orchestrator.

## 12. Compatibility and capability discovery

Any future fields or endpoints should be additive, versioned and advertised through `GET /api/v1/capabilities`. Existing consumers must continue to operate against older receipts. New consumers must not infer support from server version strings alone or assume undocumented fields.

Potential conceptual capabilities include:

- durable attributed run activity;
- idle-versus-absolute stall classification;
- late-terminal chronology;
- bounded recovery/artefact evidence.

These are capability ideas, not assigned names or commitments. Exact semantics belong in the future contract change that ships them.

## 13. Success qualities

A future improvement is successful if it makes the following statements reliably distinguishable across supported runtimes:

- “no attributable activity was available” versus “activity was observed”;
- “idle bound fired” versus “absolute bound fired”;
- “watcher observed after its own deadline” versus “runtime stopped at that time”;
- “receipt terminal” versus “external acceptance complete”;
- “session retained” versus “turn live”;
- “partial evidence survives” versus “work is correct and complete”;
- “late compatible evidence arrived” versus “terminal evidence conflicts”;
- “known unsupported evidence” versus “healthy silence”.

It should also preserve current dispatch safety: bounded accepted turns, truthful busy/admission behavior, durable receipts, restart recovery, and capacity release after stalls.

## 14. Non-goals

This direction does not seek to:

- eliminate watchdogs or make timeouts unbounded;
- keep all sessions resident indefinitely;
- treat any periodic heartbeat as progress;
- guarantee visibility into arbitrary child processes or nested agents;
- provide distributed transactions over repository files;
- judge semantic task completion or artefact quality;
- own project/workspace leases or external sign-off;
- make every Pi subagent a separately addressable Internal API run;
- replace runtime-native logs and transcripts with one universal event fiction;
- expose raw private output in diagnostics;
- promise process continuity across server restart.

## 15. Open questions

The following questions should remain open until runtime-specific evidence and negative controls support a contract decision:

1. Which normalized event classes are sufficiently attributable to reset an idle clock for each backend?
2. Should activity chronology live inside each run receipt, in a bounded adjacent ledger, or as a derived evidence-bundle view?
3. How much chronology is needed to explain a stall without creating an unbounded event store?
4. How should a late terminal signal interact with an already persisted `TURN_STALLED` terminal state while preserving compatibility and capacity accounting?
5. Which contradictions require a new terminal substate, and which are best represented as additive annotations/evidence?
6. Can Pi runtime-local subagent activity be attributed safely to the parent accepted run without making each child a first-class run?
7. What evidence can distinguish a quiet long model call from a dead worker without blind keepalives?
8. Should absolute execution bounds be global, runtime-specific, request-selectable within policy, or some combination?
9. Which activity evidence deserves durability, and what retention/privacy bound should apply?
10. What bounded artefact locators can be exposed consistently without leaking arbitrary filesystem state?
11. How should notifications communicate a later terminal update after an earlier stall notification?
12. How should restart reconciliation handle a receipt that was active while its runtime process did not survive?
13. What capability granularity lets clients degrade safely without coupling to one Pi Web UI release?
14. Which disposable live-validation scenarios can reproduce late `agent_end`, nested silence and restart ordering deterministically across runtimes?

## 16. Evidence and validation principles for a future design

A later implementation proposal should be grounded in synthetic, disposable scenarios including:

- normal long work with genuine attributed activity;
- silent/dead work stopped by an idle bound;
- continuously active work stopped by an absolute bound;
- a late terminal signal after `TURN_STALLED`;
- server restart between accepted, started and terminal phases;
- duplicate/out-of-order events;
- runtime-local nested activity that is visible, invisible or contradictory;
- partial artefacts without semantic completion;
- retention expiry/renewal independent of liveness;
- event-stream client disconnect during detached execution;
- secret-bearing tool output that does not leak into recovery metadata.

Negative controls must prove that browser polling, receipt reads, retention, observer attachment, health checks and blind heartbeats do not reset liveness. Validation should use disposable servers and synthetic workspaces, never production sessions or private transcripts.

## 17. Canonical implementation touchpoints

These paths describe current ownership and are starting points for future investigation, not a prescribed change list:

- `server/src/internal-api/run-receipts/run-receipt-manager.ts` — durable receipt transitions and watchdog handling;
- `server/src/internal-api/run-receipts/run-receipt-store.ts` — persistence;
- `server/src/internal-api/routes/sessions.ts` — prompt/session Internal API surface;
- runtime services/adapters under `server/src/` — source-specific activity and terminal evidence;
- [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md) — normalized event flow;
- [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) — exact shipped semantics and capability/version authority;
- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — diagnostic durability and privacy boundaries;
- [`DURABILITY-MATRIX.md`](./DURABILITY-MATRIX.md) — restart truth;
- [`SHARP-EDGES.md`](./SHARP-EDGES.md) — runtime-specific traps.

Until a future contract change is implemented and advertised, consumers must continue to follow the current Internal API contract and treat the concepts in this document as intent only.
