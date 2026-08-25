# Internal API orchestration — defects from a consuming agent's seat

_Recorded 2026-08-25 against contract **1.24.0** (`stability: beta`), from a real orchestration session that
created four sessions, dispatched two long-running children on different runtimes and models, and watched
both to completion. Everything below was **observed**, not inferred from reading the contract._

> **What this document is.** A user-experience report, deliberately containing **no proposed
> implementation**. It says what was asked for, what actually happened, what it cost or nearly cost, and
> what "working properly" would have felt like from the consuming side. How to achieve that is for the
> people who own this codebase to decide — they know constraints this consumer cannot see.
>
> **What it is not.** A criticism of the design. The Internal API did the hard part well: two children ran
> for 89 and 60+ minutes, detached, across a parent usage-window interruption, and both produced correct
> work. Everything below is friction around a core that worked.

---

## 1. A model request can be silently ignored, and the response says it succeeded

**Severity: highest. This is the one that costs money.**

Creating a session with `model: "gpt-5.6-sol"` returned `200` and echoed `"model": "gpt-5.6-sol"` back. The
session had actually bound to **`zai/glm-5.3`** — the model used by the *previous* session. The requested
model was never applied and nothing said so.

The only ways to find out were `GET /sessions/:id/info`, which disagreed with the create response, and the
session file on disk, whose `model_change` records showed the default binding and no second change.

Qualifying the selector as `openai-codex/gpt-5.6-sol` worked correctly, so the request form was the problem
— but an unresolvable model produced a **silent inheritance**, not an error.

**Why it mattered here.** The operator had explicitly excluded GLM for that time window because it bills at
3× rate. Had the create response been trusted — which is the natural thing to do when it echoes your
request back at you — a ~90 minute job would have run on the excluded model and the first anyone knew would
have been the invoice.

**What robust feels like from here:** a create response that reports what the session is *actually bound
to*, or refuses. An unresolvable model should be a loud failure. Inheriting the previous session's model as
a silent fallback is the single most surprising behaviour encountered in this session, because the failure
is invisible at exactly the moment a consumer is deciding whether to proceed.

## 2. `/info` reports `retention: null` for a session that holds a durable lease

`POST /sessions` returned a retention object with a `leaseId` and an `expiresAt` eight hours out. The very
next call to `GET /sessions/:id/info` reported `retention: null`.

**Why it mattered:** the whole point of durable retention is confidence that a long detached job will not be
reaped. The endpoint a consumer would naturally use to *confirm* that protection says the protection is not
there. It was carried on faith for six hours instead, on the basis that the create response was the more
credible of two contradictory answers — an uncomfortable position given §1 above, where the create response
was the one that lied.

**What robust feels like:** one authoritative answer to "is this session protected, and until when?"

## 3. The capability flags the orchestration guidance tells you to gate on do not exist

`/capabilities` advertises `retentionLeases`, `durableRetention`, `residentRetention`,
`executionAdmission`, `runLivenessEvidence`, `sessionRecoveryEvidence`, `capacityEndpoint` and
`piProviderPolicy`.

The `pi-web-ui-internal-api-orchestration` skill instructs consumers to capability-gate on
`supportsFollowUp`, `followUpSemantics`, `supportsSteer`, `supportsSteerWhileBusy`,
`supportsThinkingLevel`, `supportsApprovals`, `supportsInteractiveQuestions` and `supportsReplayHistory`.
**None of those eight are present in the response.**

**Why it mattered:** the documented discovery step is unfollowable, so a consumer told to "gate rather than
assume" has to assume anyway, then discover behaviour by trying it. That is the exact posture the guidance
exists to prevent.

Whether the drift belongs to the server or to the skill is not something this consumer can judge — but
whichever is authoritative, the two disagree, and the consumer is the one who finds out.

## 4. Profile identifiers and labels disagree about which model they are

`/capabilities` lists, among others:

| id | label |
|---|---|
| `glm52-claude-sdk-native-profile` | GLM **5.3** — Claude SDK |
| `glm52-claude-cli-direct` | GLM **5.3** — Claude CLI direct fallback |

The id says 5.2; the label says 5.3. Additionally **every** profile reports `claudeModel: null`, while the
orchestration guidance instructs consumers to select a Claude profile by reading `backend` **and**
`claudeModel`, and states that a missing field means *unknown*, never a licence to fill it in from memory.

**Why it mattered:** taken together, a consumer following the documented procedure literally cannot satisfy
the selection predicate, and the two human-readable signals that remain contradict each other. Given §1 —
where a wrong model binds silently — a consumer has no reliable way to be sure which model a profile route
will actually produce.

**What robust feels like:** an id, a label and a model field that agree, or an explicit statement that the
id is opaque and only one field is authoritative.

## 5. A run reporting `completed` does not mean the work finished

A child returned `status: "completed"` with an `agent_end` event. Its actual task was still running — it
had dispatched its own worker and yielded its turn to await a wake. Reporting "done" on that basis would
have been wrong, and the only reason it was not is that this consumer independently checked files on disk
before believing the status.

The response does carry `cessation: { state: "unconfirmed", basis: "terminal_signal" }`, which is honest.
But `status: "completed"` is the field a consumer reads first, and the qualifier that contradicts it is
nested two levels down in a large object.

**What robust feels like:** the headline status distinguishing "this turn ended" from "this work finished",
since for any orchestration built on detached children those are entirely different questions.

## 6. There is no way to ask "is my child still working?"

`GET /sessions` returned a list of historical sessions with `model: null` and `status: idle`, and did not
surface the session that was demonstrably running at that moment. Determining whether a dispatched child
was alive required combining `/capacity`'s global `activeTurns` count with timestamps of files the child
happened to be writing.

The absence of a parent-child index is documented and understood. The narrower gap is that even for a
session whose id you already hold, there is no dependable "is this one busy right now" answer.

**Why it mattered:** a false "it has stalled" conclusion was reached and had to be retracted — the worker
was healthy and producing a result every fifty seconds. The wrong conclusion came from having to infer
liveness indirectly.

## 7. "Dispatch and walk away" does not hold for every supported harness

Watch-wake can wake a Pi parent. A bare Claude CLI parent has no wake path at all — documented in the
skill's `walk-away.md`, and confirmed in practice.

The workaround was a background polling loop that exits when the run reaches a terminal state, using the
harness's own process-completion signal as a substitute wake. It works, and it worked across a parent usage
interruption. But it means the headline capability is runtime-conditional in a way a consumer only
discovers by reading a reference file, and every Claude-based orchestrator must reinvent the same loop.

## 8. Getting a child's final answer takes several attempts

Retrieving what a child actually *said* required trying `/runs/:runId/output`, `/sessions/:id/transcript`
and `/sessions/:id/messages`, which return different shapes. `transcript` reported
`scope: "visible_recent"` with a fixed twenty items regardless of the `limit` passed, and its items use
`kind`/`text` while other surfaces use `role`/`content`.

**Why it mattered:** the final summary is the entire point of dispatching a child. Three attempts and a
shape-discovery step stand between a consumer and the one piece of output they care about most.

---

## Severity, from the consuming side

1. **§1 — silent model fallback.** Everything else is friction; this one produces wrong, billable work while
   reporting success. It is the only item here that could have caused real harm, and it nearly did.
2. **§4 and §3 — discovery that cannot be trusted or followed.** These compound §1: when selection metadata
   is contradictory and the documented gating fields are absent, a consumer has no independent way to catch
   a mis-binding before dispatch.
3. **§2 and §5 — status fields that disagree with reality.** Both are survivable by verifying elsewhere, but
   both punish the consumer who trusts the obvious field.
4. **§6, §7, §8 — friction.** Real cost in time and in one retracted wrong conclusion, no risk of incorrect
   work.

## What worked well, and is worth not breaking

- Detached dispatch survived a parent that stopped watching for a long period, twice.
- Durable retention held for six hours across an interruption, and lease renewal worked every time.
- `/capacity` was accurate and useful whenever consulted.
- `POST /models/refresh` was never needed — the catalogue was live and correct, and the one model that
  could not be selected was a selector-form problem, not a catalogue gap.
- The Pi provider policy blocking metered providers by default is exactly right, and visible in
  `/capabilities` where a consumer will actually see it.
