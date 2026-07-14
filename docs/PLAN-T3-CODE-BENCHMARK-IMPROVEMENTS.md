# Plan: Run Receipts and Instance Identity (T3 Code Benchmark, Trimmed)

_Status: revised plan; supersedes and replaces the 2026-07-14 original in place. No implementation in this document._
_Date: 2026-07-14 (revision 2)_

## Purpose and intent

This plan records what Pi Web UI should actually build from the benchmark of [T3 Code](https://t3.codes/) ([pingdotgg/t3code](https://github.com/pingdotgg/t3code)).

Pi Web UI is **permanently single-operator personal tooling**. It will not gain users, and nothing here is product hardening. Every item must pass one test:

> Does this reduce the time the operator spends checking whether agents actually did the thing?

Three T3 ideas pass that test today, because they fix failures that have already happened here (silent empty sessions, duplicate-dispatch quota waste, ambiguous provider attribution):

1. **Run identity + idempotent dispatch** — one prompt execution gets a `runId`; a retried dispatch returns the existing run instead of burning quota twice.
2. **Persisted run receipts** — every accepted run ends in an explicit, disk-persisted terminal state that survives server restarts.
3. **Execution instance identity** — expose *which configured instance* (generalizing `claudeProfileId`) handled a session, not just the runtime family.

Everything else from the benchmark is **deferred reference material**, not committed scope (see below).

## What changed from the original plan, and why

This revision intentionally replaces the original five-phase program. The changes and their intent:

| Change | Intent |
|---|---|
| Five phases → one committed slice + a deferred-reference list | The full program's benefit-to-ceremony ratio only makes sense for a team product. For a single operator, only the items that cut supervision time are worth their maintenance cost. |
| Added a hard persistence requirement for receipts | The original demanded "every accepted run has a terminal or recoverable state" but never said where receipts live. Prod restarts on every deploy (`systemctl restart pi-web-ui.service`); an in-memory registry fails the plan's own definition of done on the first redeploy. |
| Added explicit reconciliation with the durable-watch layer | `server/src/internal-api/watch/` already provides disk-backed, restart-surviving session observation. Unreconciled, receipts would be a third overlapping notion of "did this finish" (watches, notification opt-ins, receipts) that can disagree. Receipts are built on the watch-store pattern and consume existing terminal signals. |
| Dropped event cursors, `DrainableWorker`, and typed receipt buses from committed scope | No current consumer needs them. `DrainableWorker` is an Effect-TS deterministic-testing idiom; this repo's known test-flakiness problems are already resolved. Kept as deferred reference only. |
| Dropped the full `ExecutionBinding` schema commitment | The slice needs three exposed fields, not a frozen interface. Committing a schema before Agent OS Step 7 exists to exercise it locks in speculation on an additively-versioned contract. |
| Dropped resume/switch-compatibility checks in each runtime service | This one bullet hid perhaps half the original program's work (Antigravity replay is not byte-stable; the Claude channel path has no `/events`). Deferred until a real resume-through-wrong-instance incident justifies it. |
| Decoupled sequencing from Agent OS | The slice is justified by consumers that exist today: long-horizon validation, orchestration-skill agent sessions, and the CLI notification bridge. The Opus-via-SDK silent failure happened with none of Agent OS involved. Ship independently; Agent OS adopts later through the versioned contract. |
| Added a TDD plan, quality gates, and scope guardrails | Make the slice buildable by a focused agent in one to two sessions without ballooning. |

## Benchmark evidence (retained)

The T3 references remain the evidence base and were verified real and accurately characterized:

- Persisted session binding: [`ProviderSessionDirectory.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Services/ProviderSessionDirectory.ts)
- Driver-vs-instance distinction: [`providerInstance.ts`](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/providerInstance.ts)
- Ordered commands and receipts: [`OrchestrationEngine.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Layers/OrchestrationEngine.ts)
- Deferred-only references: [`providerRuntime.ts`](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/providerRuntime.ts) (typed event vocabulary), [`RuntimeReceiptBus.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/RuntimeReceiptBus.ts), [`DrainableWorker.ts`](https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/DrainableWorker.ts)

Pi Web UI baseline: `docs/INTERNAL-API-ORCHESTRATION.md` ("No async job id layer yet" is this repo's own documented top limitation), `server/src/session-registry.ts` (`claudeProfileId` is today's only instance-like concept), `server/src/internal-api/watch/` (existing durable observation layer), `docs/INTERNAL-API-CONTRACT.md` (additive versioning rules).

## Committed scope — the slice

### 1. Run identity and idempotent dispatch

- Internal API prompt dispatch accepts an optional `idempotencyKey` and returns a `runId` (additive response fields; old clients unaffected).
- A duplicate dispatch (same key, within a documented scope and TTL) returns the existing run's receipt instead of starting a second prompt.
- Key scoping and TTL must be explicit in the contract docs. **Failure-mode note:** wrong dedupe silently swallows a legitimate prompt, which is worse than the duplicate it prevents — tests must cover key-collision and TTL-expiry boundaries.

### 2. Persisted run receipts

- Lifecycle: `accepted → started → completed | failed | cancelled`.
- A receipt records: `runId`, `sessionId`, runtime family, `executionInstanceId`, model where known, timestamps, terminal status, and an error code on failure. **No secrets, tokens, cookies, or transcript bodies.**
- Storage is disk-backed, modeled on `watch-store.ts`, and must survive a server restart: a run that was in flight when the server died is marked recoverable/interrupted on reload, never silently lost.
- Terminal detection **reuses existing signals** — the per-runtime turn-completion logic behind `/wait` and the `agent_end` events the notification layer already consumes. No new per-runtime plumbing.
- Receipt lookup endpoint for detached/background work.
- Retention: bounded (count- or age-pruned), documented, and covered by a test.

### 3. Execution instance identity

- Expose `executionInstanceId` in session info and receipts: Claude sessions map from `claudeProfileId`; other runtimes get one static default each (`pi-local-default`, `opencode-default`, `antigravity-default`).
- `sdkType` remains the runtime-family discriminator. No configuration UI — instances are surfaced, not managed, until more than one real instance exists outside Claude.

## TDD plan

Tests are written first, per repo policy. Order of work:

1. **Receipt store unit tests (failing first):** create/transition/terminal semantics; illegal transition rejection; persistence round-trip; restart reload marks in-flight runs recoverable; retention pruning; secret-field rejection.
2. **Idempotency unit tests:** duplicate key returns same run; distinct keys dispatch independently; TTL expiry allows reuse; missing key preserves today's behavior exactly.
3. **Terminal-detection fixture tests:** recorded event fixtures per runtime (Pi, Claude SDK, Claude channel, OpenCode, Antigravity) drive receipt completion — no live runtimes needed for the matrix.
4. **Route tests:** dispatch response includes `runId`; receipt lookup; old-client request shapes still work byte-compatibly.
5. **Implementation** to green, then docs.
6. **Live validation, deliberately narrow:** one scenario on Pi and one on a Claude profile (see `docs/LIVE-VALIDATION.md`; use a disposable GLM profile for the SDK path per known sandbox constraints). The other runtimes are covered by fixtures only — Antigravity and Claude-channel live quirks are a known session sink and are not this feature's job to debug.

## Quality gates

All must pass before commit:

- `npm run lint`, `npm run typecheck`, `npm run build`, `npm test` (server workspace at minimum), `npm run docs:check-agent-guides`.
- Contract changelog bumped **additively** in `docs/INTERNAL-API-CONTRACT.md`; `docs/INTERNAL-API.md` and `docs/INTERNAL-API-ORCHESTRATION.md` updated (the "No async job id layer yet" limitation gets resolved/annotated).
- **Contract mirror synced in the same working session:** the sibling repo's `/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md` gets the same version bump, the new endpoints/fields, and a matching version-history entry, then is committed and pushed on that repo's current branch. This is the operator's standing workflow — a contract version bump here is never left unmirrored — and it is the one deliberate cross-repo touch this plan requires.
- Grep-level check that no receipt/store code path can persist env values, auth material, or prompt/transcript bodies.
- Restart test proves receipts survive process death.
- The two live scenarios pass on an isolated validation server (`PI_AGENT_DIR` and prefs isolated — never against prod state).

## Scope guardrails — explicitly out, do not drift in

- No unification of receipts with the watch layer or the notification layer into a grand completion abstraction. Receipts sit **on** the watch-store pattern; the other two are untouched.
- No `ExecutionBinding` interface in code. It lives below as deferred reference only.
- No changes to runtime services for resume/switch compatibility.
- No event-stream envelope changes, sequence numbers, or cursor replay.
- No live validation beyond Pi + one Claude profile.
- No WebSocket protocol or client/frontend changes of any kind.

## Deferred reference (not committed; revisit only on evidence)

| Idea | Revisit when |
|---|---|
| Event cursors / snapshot-plus-events-after-cursor recovery | A real consumer demonstrably loses events it needed and the durable-watch layer cannot cover it. |
| Full `ExecutionBinding` schema (`nativeSessionId`, `resumeCursor`, continuation capabilities) | Agent OS Step 7 is being implemented and needs specific fields — decide schema then, with the consumer in the room. |
| Resume/switch compatibility enforcement per runtime | A real incident of a session resuming through the wrong instance. |
| Typed async receipt channels (`turn.quiesced`, `transfer.completed`, …) / `DrainableWorker` helpers | A concrete race or polling problem is demonstrated in tests or orchestration. |
| Instance configuration UI | More than one real configured instance exists for a non-Claude runtime. |

## Sequencing

- **Independent of Agent OS.** Build whenever convenient; the existing consumers justify it now. Expected effort: one to two focused agent sessions (calibrated against the notification layer and screen-view projection, both similar-shape additive Internal API features).
- On ship, update the contract mirror in the sibling repo (`/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md`) — the one deliberate cross-repo touch. Agent OS discovers the features at runtime via its capability-gated client and adopts them during Step 7 (owner expectation as of 2026-07-14: roughly two to four weeks out).
- Implementation sessions on this slice should run the `agent-os-capture` skill: design decisions here are exactly the real-work memory the Agent OS Step 4C dogfooding loop needs.

## Definition of done

For every Internal API dispatch, Pi Web UI can answer — including after a server restart:

1. Was this prompt dispatched exactly once for its idempotency key?
2. What is the run's terminal (or recoverable) state, and what receipt proves it?
3. Which runtime family **and configured instance** (and model, where known) executed it?

The original plan's remaining questions (resume safety, event-loss recovery) belong to the deferred items and are intentionally not part of this definition of done.

## Non-goals (unchanged from the original)

- No Effect-TS or T3 monorepo adoption; no replacement of Express, Zustand, workers, or `sdkType`; no SQL event-sourced rewrite; no import of Agent OS memory/work-object ontology; no assumption of uniform resume/model-switch/approval behavior across runtimes.
