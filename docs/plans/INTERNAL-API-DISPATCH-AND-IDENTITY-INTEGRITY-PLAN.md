# Internal API — Dispatch Truthfulness and Session-Identity Integrity

**Status:** ready for execution (no code written yet)
**Plan baseline:** `1b41f19` (`docs(internal-api): complete retention and admission guidance`)
**Contract at baseline:** `pi-web-ui-internal-api` v1, contract `1.12.0`
**Target contract after execution:** `1.13.0`
**Primary repo:** `/root/pi-web-ui`
**Companion repo:** `/root/agent-os` (Phase 5 — separate commit, separate push)

> **Read this first.** Every defect below was observed on the **production**
> server (`~/.pi-web-ui/internal-api.sock`) during the Agent OS Step 7C
> conductor comparison on 2026-07-29. Each has durable evidence recorded in
> §2. Do not re-derive the incident; reproduce the defect with a failing test
> and fix it.

---

## 1. Intent and rationale

### 1.1 What broke

Agent OS drove three conductor routes through the Internal API. Two of the three
stalled. Neither stall was a model or conductor failure — both were Internal API
defects, and in both cases **the API told the caller the operation had
succeeded when it had not**.

- A Pi session was sent a continuation with `mode=follow_up`. The API returned
  `202 Accepted` with a `runId`. The message was never delivered, never
  executed, and **never even written to the session file**. The run receipt is
  still `started` at the time of writing.
- A Claude SDK session asked its operator three questions. The relayed answers
  were POSTed to `/approvals/:requestId/respond`, which returned
  `200 {"success":true,"approved":true}`. The answers reached nothing. Thirty
  minutes later the model received *"The user did not answer the questions."*

### 1.2 Why this matters more than the individual bugs

Pi Web UI's Internal API is the **runtime control plane for autonomous
orchestration**. An orchestrator cannot supervise what it cannot observe, and it
cannot recover from a failure it is told did not happen. Every defect in this
plan is an instance of one class:

> **The API reports success for work that was silently discarded, and reports
> nothing at all for work that is permanently stuck.**

A hang is recoverable — a supervisor eventually notices. A false success is not:
the orchestrator writes `ownerAnswerDeliveredAt`, moves to the next gate, and
the error becomes unattributable. Two hours of Step 7C evidence were scored
against models for what was API behaviour.

The unifying principle for this work:

> **Every accepted request must either do what it said, or say what it did
> instead. No operation may be silently dropped, and no run may occupy capacity
> indefinitely without a terminal state.**

### 1.3 Why the browser never saw this

The operator has driven the same conductor flows through the web UI without
incident. That is not luck:

| | Browser (`connection.ts`) | Internal API (`routes/sessions.ts`) |
|---|---|---|
| Sending a message | `agentSession.prompt()` — the SDK's own dispatcher, which checks `isStreaming` and picks new-turn vs queue | `agentSession.followUp()` / `.steer()` called **directly**, bypassing the dispatcher |
| Busy guard | applied to every message (`connection.ts:982`) | applied only when `mode === 'prompt'` (`sessions.ts:1404`) |
| Answering a question | `requestId` read straight off the live WebSocket event | must be recovered out-of-band; the only durable carrier exposes `toolCallId` |

The Internal API is the divergent surface. This plan brings it to parity with
the dispatcher semantics the browser already gets for free.

### 1.4 Non-goals

- **No behavioural change to the browser/WebSocket path** beyond the shared
  identity fix in Phase 3. The browser path is currently correct.
- **No full Pi session-directory rescan.** Pi session loading already scans
  hundreds of MB per open; eager per-file indexing would worsen a known
  performance problem. Registry discoverability is addressed incrementally
  (Task 13) and the boot-time rescan is explicitly out of scope.
- **No retroactive repair of the Step 7C sessions.** The two wedged Pi runs and
  the corrupted `019faefc-2b64-…` file are evidence. Leave them.
- **No removal of `mode: "follow_up"`.** It is part of a published beta contract
  with a live consumer, and it is correct today for OpenCode. See §3.1 for the
  decision record.

---

## 2. Evidence (durable, already captured)

Reference these when writing tests. Do not depend on the live prod state — it
will change.

| # | Claim | Evidence |
|---|---|---|
| E1 | Idle Pi `follow_up` is accepted and lost | `journalctl -u pi-web-ui.service`: `18:19:23 Prompt dispatched: runtime=pi … mode=follow_up runId=b5f29420-…`; session JSONL `--root-step7c-worktrees-7c-a-sol--/…_019faf06-….jsonl` ends `18:12:42` with no later entry |
| E2 | The lost runs never terminalise and leak capacity | `~/.pi-web-ui/run-receipts/b5f29420-….json` and `857bb140-….json` both `"status":"started"`, no `terminalAt`; `GET /api/v1/capacity` → `{"activeTurns":2,"runtimes":{"pi":{"activeTurns":2}}}` ~25 min after both sessions went idle |
| E3 | `followUp()` only drains inside a live agent loop | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1006` — *"Queue a follow-up message to be processed after the agent finishes. Delivered only when agent has no more tool calls or steering messages"*; `_queueFollowUp` (`:1034`) pushes + emits `queue_update` only |
| E4 | `prompt()` self-dispatches correctly | same file `:833` — `if (this.isStreaming) { …streamingBehavior… } else { …run turn… }` |
| E5 | Busy guard skips non-`prompt` modes | `server/src/internal-api/routes/sessions.ts:1404` and `:1457` — `if (isBusy && mode === 'prompt')` |
| E6 | Claude `follow_up` accepted while running, then fails | journal `18:28:49 Detached prompt failed for 2ce58b64-…: Error: Claude session is already running`; `claude-service.ts:383` throws; surfaced as `RUNTIME_ERROR` |
| E7 | Wrong approval id returns false success | `sessions.ts:2011` falls through to `claudeService.sendPermissionResponse()` (`claude-service.ts:123`, channel-only) and then `sessions.ts:2022` sends `200 {success:true}` |
| E8 | The answer never reached the model | `~/.pi-web-ui/claude-sessions/2ce58b64-….jsonl`: `{"type":"tool_result","toolCallId":"toolu_01Q3yFLqb2Q4xbgiySCvkdHh","toolOutput":"The user did not answer the questions.","timestamp":1785349966319}`; journal `18:32:46 AskUserQuestion timed out (requestId=9d567195-f867-4dc1-9af4-965ce1c55845)` |
| E9 | The correct id is not recoverable | transcript carries only `toolCallId`; `GET /approvals/pending` is a hard-coded `approvals: []` stub (`sessions.ts:3061`); broker replay buffer is 100 events (`sessions.ts:221`) and the session had 239 |
| E10 | Rehydration mints a new identity **and overwrites the file** | journal `17:49:38 Rehydrating session from disk: …_019faefc-2b64-….jsonl` → `Session rehydrated: 019faeff-0cf6-…`; that file's header is now `{"type":"session","id":"019faeff-0cf6-…","timestamp":"…T17:49:38.422Z"}` — filename ID ≠ header ID, original transcript destroyed. Mechanism: `pi-service.ts:205-217`, `fileExists=false` → `SessionManager.create()` (new ULID) → `setSessionFile(oldPath)` → `forceFlushSessionManager` |
| E11 | Pi sessions are largely invisible to the evidence ladder | 35 of 44 `sdkType:"pi"` registry entries have a **directory** path with a synthetic UUID; 68 of 70 JSONLs under `--root-agent-os--` have no entry; `npm run debug:where -- 019faeda-…` and `GET /sessions/:id/evidence` both fail on a session the browser can open |
| E12 | The caller hard-codes the broken mode | `/root/agent-os/src/conductor/dispatch.ts:897` — `const requestShape = { message: input.prompt, verbosity: 'answers', mode: 'follow_up', detach: true }` |
| E13 | The defect was seen before and misfiled | `docs/plans/CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md:631` records it as *"turn 2 arrives before the Pi session is idle… Not a hardening regression."* The causality is inverted: turn 2 arrives **because** the session is idle |
| E14 | The live-validation scenario reproduces it and was written off | `server/src/live-validation/scenarios.ts:1053-1062` awaits turn 1 to completion, then sends `mode:'follow_up'` to an idle session — i.e. the exact failing case, recorded as a runtime quirk rather than failed |

---

## 3. Decision records

### 3.1 `follow_up` on an idle session: promote, don't reject

**Decision:** when `mode: "follow_up"` arrives and the session is idle, the API
**promotes it to a normal turn** and reports that it did so. It does not reject,
and it does not queue into the void.

**Rationale:**
- It matches the SDK's own dispatcher (E4). `AgentSession.prompt()` has always
  meant "queue if streaming, else run" — the Internal API is the only caller
  that split those semantics apart.
- It is non-breaking for the published contract and for the live Agent OS
  consumer, which uses `follow_up` to mean "continue this conversation."
- Rejecting would convert a silent data-loss bug into a hard failure for every
  existing caller. Promotion converts it into correct behaviour.
- No message is ever lost under promotion. That is the invariant we care about.

**Honesty requirement:** promotion must be *visible*. The run receipt and the
prompt response both carry `dispatchMode` (what actually happened) alongside the
requested `mode`. A caller that genuinely requires queue-into-active-turn
semantics opts in with `"requireActiveTurn": true` and gets
`409 SESSION_NOT_STREAMING` when idle.

**Rejected alternative:** *"replace `follow_up` with an explicitly named queue
operation, or reject it until its lifecycle is correctly implemented."* Rejected
as over-broad — `follow_up` is already correct for OpenCode (it streamed fully
in the Phase H validation), and removing a published beta contract mode with a
live consumer is a larger blast radius than the bug.

### 3.2 Unified prompt-mode semantics

This table is the contract after this plan. Implement to it exactly.

| Mode | Meaning | Pi | Claude / OpenCode / Antigravity |
|---|---|---|---|
| `prompt` | Start a new turn | `409 SESSION_BUSY` if busy; else run | `409 SESSION_BUSY` if running; else run |
| `follow_up` | Deliver after the current turn | busy → queue via `followUp()`, receipt status `queued`; idle → **promote** to a new turn, `dispatchMode:"prompt"` | no queue exists → running → `409 SESSION_BUSY` with `Retry-After`; idle → new turn |
| `steer` | Interrupt the active turn | requires an active turn → idle gives `409 SESSION_NOT_STREAMING` | `UNSUPPORTED_OPERATION` (unchanged) |

`requireActiveTurn: true` turns the `follow_up` idle-promotion into
`409 SESSION_NOT_STREAMING` on every runtime.

### 3.3 Watchdog shape: idle-timeout, not absolute cap

An absolute per-turn cap punishes legitimate long turns (a turn containing a
30-minute `AskUserQuestion` plus real work). Use **both**:

- **Idle timeout** (`INTERNAL_API_TURN_IDLE_TIMEOUT_MS`, default `900000` = 15
  min): no event of any kind observed for this run → terminalise
  `failed` / `TURN_STALLED`, release the admission lease.
- **Absolute ceiling** (`INTERNAL_API_TURN_MAX_MS`, default `21600000` = 6 h):
  backstop against a run that emits heartbeats forever.

The Step 7C wedge emitted exactly one `queue_update` and then nothing, so the
idle timeout is what catches it. Both values must be env-overridable so tests
can drive them at millisecond scale.

### 3.4 Missing Pi session file: fail closed

`pi-service.ts` currently recreates a *new* session at a *requested* path when
the file is absent (E10). That path exists to support first-write of a
newly-created session, but it also silently resurrects deleted sessions under a
stale identity and destroys evidence.

**Decision:** creating a session at a caller-supplied `sessionPath` whose file
does not exist is only permitted when the caller explicitly asks for creation
(`allowCreate: true`, used by the genuine create path). A *rehydration* request
for a missing file fails closed with `SESSION_FILE_MISSING`, and the browser
surfaces "this session no longer exists" rather than opening an empty
impostor.

**Additional invariant:** never persist a Pi session whose header `id`
disagrees with the session id encoded in its filename. Assert on both read and
write.

---

## 4. Phases and tasks

Each task is **TDD-mandatory**: write the failing test first, capture the RED
output in the execution report, then implement to GREEN. A task without recorded
RED output is not complete.

Test locations follow existing convention:
- Internal API route behaviour → `server/tests/unit/internal-api/`
- Pi lifecycle/identity → `server/tests/unit/pi/` (create if absent)
- Live scenarios → `server/src/live-validation/scenarios.ts`

---

### Phase 1 — P0: stop losing work (blocking)

#### Task 1 — Pi `follow_up`/`steer` dispatch through session state

**Files:** `server/src/internal-api/routes/sessions.ts:2119-2145`

Replace the direct `agentSession.followUp()` / `.steer()` calls with a
state-aware dispatcher implementing §3.2. Determine liveness from
`multiSessionManager.getSessionStatus(path)?.status` (`busy` | `streaming`),
which the route already consults for the busy check.

**RED tests** (`session-routes-prompt-modes.test.ts`, new):
1. `follow_up` on an **idle** Pi session runs a turn and the response carries
   `dispatchMode: "prompt"` — currently only `queue_update` is emitted and the
   promise never settles.
2. `follow_up` on a **streaming** Pi session calls `followUp()` and the receipt
   reaches status `queued`.
3. `follow_up` + `requireActiveTurn: true` on an idle Pi session →
   `409 SESSION_NOT_STREAMING`.
4. `steer` on an idle Pi session → `409 SESSION_NOT_STREAMING` (today it is
   accepted and silently dropped).
5. `steer` on a streaming Pi session still calls `steer()`.

#### Task 2 — Busy pre-flight applies to every mode

**Files:** `server/src/internal-api/routes/sessions.ts:1394-1407`, `:1439-1466`

Remove `&& mode === 'prompt'` from both busy checks and replace with a
mode-aware predicate implementing §3.2. For Claude/OpenCode/Antigravity, a
`follow_up` against a running session must be refused **before** the run is
reserved, with `409 SESSION_BUSY` and a `Retry-After` header — never
`202 Accepted` followed by a background `RUNTIME_ERROR` (E6).

Also map `Claude session is already running` (`claude-service.ts:383`) to
`SESSION_BUSY` rather than the generic `RUNTIME_ERROR`, so a caller that loses
the race still gets an actionable code.

**RED tests** (same file):
6. `follow_up` on a running Claude session → `409 SESSION_BUSY` **and no run
   receipt is created** — today it returns `202` and creates a receipt that
   fails 2 ms later.
7. `Retry-After` is present on that 409.
8. A racing "already running" throw after reservation terminalises the receipt
   with `SESSION_BUSY`, not `RUNTIME_ERROR`.

#### Task 3 — `/approvals/:requestId/respond` may never lie

**Files:** `server/src/internal-api/routes/sessions.ts:1968-2016`,
`server/src/claude/claude-service.ts:123-147`,
`server/src/claude/claude-sdk-service.ts:509-562`

Three changes:

a. **Delete the fall-through.** For a Claude session, only reach
   `sendPermissionResponse()` when `claudeService.hasChannelSession(sessionId)`
   is true. Otherwise an unmatched id returns
   `404 APPROVAL_REQUEST_NOT_FOUND` (new error code) — never `200`.

b. **Accept `toolCallId` as an alias.** `PendingAskUserQuestion` already stores
   `toolCallId` (`claude-sdk-service.ts:93`). Add
   `resolveAskUserQuestionKey(idOrToolCallId)` and use it in
   `isPendingAskUserQuestion` / `respondToAskUserQuestion` /
   `wasRecentlyResolvedAskUserQuestion`. This alone would have prevented the
   entire Opus incident, because `toolu_…` is the only id the transcript
   exposes (E8, E9).

c. **Bind to the session.** Verify the resolved pending request's `sessionId`
   matches the path parameter; mismatch → `404`. Today the lookup is global.

Success responses become explicit:
```json
{ "success": true, "resolved": true, "kind": "ask_user_question",
  "requestId": "9d567195-…", "toolCallId": "toolu_01Q3…" }
```

**RED tests** (extend `session-routes-ask-user-question.test.ts`):
9. Responding with an **unknown** requestId on an SDK session → `404`, and
    `sendPermissionResponse` is **not** called — today: `200 {"success":true}`.
10. Responding with the `toolCallId` resolves the pending question and the SDK
    receives the answers.
11. Responding with a valid requestId but the **wrong sessionId** → `404`.
12. A channel-backed session still routes to `sendPermissionResponse`
    (no regression).
13. The success body carries `resolved`, `requestId` and `toolCallId`.

#### Task 4 — A run may only be terminalised by its own turn

**Files:** `server/src/internal-api/routes/sessions.ts:2094-2152`

The `endObserver` is attached to the **sessionPath**, so with two overlapping
runs the first `agent_end` resolves whichever observers are attached — a queued
run can be marked `completed` on another run's evidence. This is the inverse of
E2 and strictly worse, because it is a silent false success.

Implement:
- a **per-session dispatch mutex** so two API-driven turns cannot overlap on
  one session (Task 2 makes this cheap: concurrent `prompt`s are already 409'd);
- a **monotonic turn token** captured at dispatch; the observer ignores any
  `agent_end` whose token does not match;
- `queued` follow-up receipts do **not** attach an `agent_end` observer at all —
  they terminalise on the watchdog or on their own delivery.

**RED tests:**
14. Two overlapping Pi runs on one session: the first `agent_end` terminalises
    only run A; run B remains non-terminal.
15. A `queued` receipt is not completed by the in-flight turn's `agent_end`.

#### Task 5 — Stalled-run reconciliation and capacity release

**Files:** `server/src/internal-api/routes/sessions.ts:1228-1300`,
`server/src/internal-api/run-receipts/*`,
`server/src/internal-api/admission-controller.ts`

Implement §3.3. Requirements:
- a run with no observed event for `INTERNAL_API_TURN_IDLE_TIMEOUT_MS`
  terminalises `failed` with `errorCode: TURN_STALLED` (new code);
- the admission lease is released on **every** terminal path, including the
  watchdog — today `executePromptWithReceipt` can never return for a wedged Pi
  run, so `finally` never executes (E2);
- `GET /api/v1/capacity` gains `stalledRuns` and `oldestActiveRunStartedAt` so
  a leak is visible before it exhausts capacity;
- the watchdog is cancelled cleanly on normal completion (no timer leak).

**RED tests:**
16. A run that emits one event then nothing terminalises `TURN_STALLED` after
    the configured idle timeout (drive with a millisecond-scale env override).
17. Admission `activeTurns` returns to zero after a stalled run is reaped.
18. A run emitting periodic events is **not** reaped before the absolute
    ceiling.
19. `/capacity` reports `stalledRuns`.

---

### Phase 2 — P1: make the state observable

#### Task 6 — Real `GET /sessions/:id/approvals/pending`

**Files:** `server/src/internal-api/routes/sessions.ts:3040-3068`,
`server/src/claude/claude-sdk-service.ts`

Replace the empty stub (E9). Expose from `ClaudeSdkService` a bounded read of
`pendingAskUserQuestions` filtered to the session:

```json
{ "sessionId": "…", "runtime": "claude", "status": "running",
  "approvals": [{ "requestId": "…", "toolCallId": "toolu_…",
                  "kind": "ask_user_question",
                  "questions": [ … ], "openedAt": "…", "expiresAt": "…" }] }
```

Keep the OpenCode permission path returning its existing shape. Drop the
misleading `note` field once the list is real.

**RED tests:** 20. a pending SDK question appears with both ids and an
`expiresAt`; 21. it disappears once answered; 22. a session with no pending
interaction returns `approvals: []` **without** the stub note.

#### Task 7 — Receipts and evidence record what actually happened

**Files:** `server/src/internal-api/run-receipts/*`,
`server/src/internal-api/routes/sessions.ts` (evidence bundle)

- Persist `mode` **and** `dispatchMode` on the receipt. Today neither is
  written, so a stuck run cannot be diagnosed after the fact (verified against
  `~/.pi-web-ui/run-receipts/b5f29420-….json`).
- Include `ask_user_question_request` / `ask_user_question_closed` in the
  evidence bundle's control-event section, carrying `requestId` **and**
  `toolCallId`, plus the close reason (`answered` | `cancelled` | `timeout` |
  `aborted` | `disconnected`).
- Log successful approval resolution at info with session/request/tool ids.

**RED tests:** 23. receipt round-trips `mode` and `dispatchMode`; 24. the
evidence bundle surfaces a pending question with both ids; 25. a closed
question records its reason.

#### Task 8 — `/wait` agrees with the receipts

**Files:** `server/src/internal-api/routes/sessions.ts:2224-2245`

`checkStatus` reads Pi liveness from `entry.status` in the registry, which
reported `idle` for the whole Step 7C wedge while the receipt said `started`.
Two surfaces must not contradict each other. Make the Pi branch consider
in-flight receipts for the session, and report `running` when either the
runtime or a non-terminal receipt says so.

**RED test:** 26. a session with a non-terminal receipt and an idle registry
entry reports `running`, not `idle`.

#### Task 9 — Capabilities stop over-promising

**Files:** `server/src/internal-api/routes/capabilities.ts:44-95`,
`server/src/internal-api/types.ts`

`supportsFollowUp: true` is hard-coded for all four runtimes with no statement
of the required session state — which is precisely the misreading that produced
E12. Add, without removing the existing field (additive contract change):

- `followUpSemantics`: `"queue_while_busy"` (Pi) | `"new_turn"` (Claude,
  OpenCode, Antigravity)
- `supportsSteerWhileBusy`: boolean
- `supportsInteractiveQuestions`: boolean (Claude SDK backend true)
- `supportsStructuredQuestionResponse`: boolean

**RED test:** 27. capabilities report per-runtime `followUpSemantics` matching
§3.2.

---

### Phase 3 — P1: session-identity integrity

#### Task 10 — Never mint a new identity at an existing canonical path

**Files:** `server/src/pi/pi-service.ts:188-217`,
`server/src/pi/multi-session-manager.ts:697-768`

Implement §3.4:
- `createSession({ sessionPath })` gains an explicit `allowCreate` flag. The
  genuine create path passes `true`; `rehydrateSession` passes `false`.
- With `allowCreate: false` and a missing file → throw `SESSION_FILE_MISSING`.
  `multi-session-manager` propagates it; the WebSocket layer sends a
  `SESSION_NOT_FOUND` error and the client removes the entry rather than
  opening an impostor.
- After open, assert the header `id` matches the id encoded in the filename.
  On mismatch: log an error, **do not write**, and surface
  `SESSION_IDENTITY_MISMATCH`. Never silently adopt a divergent id.

**RED tests** (`server/tests/unit/pi/session-identity.test.ts`, new):
28. Rehydrating a **deleted** session path throws `SESSION_FILE_MISSING` and
    writes nothing to disk — today it writes a fresh session header at that
    exact filename (E10).
29. Opening a file whose header id ≠ filename id raises
    `SESSION_IDENTITY_MISMATCH` and does not rewrite the file.
30. The genuine create path (`allowCreate: true`) still writes the file with a
    header id matching its filename.

> **Guard rail:** Task 10 touches the shared browser path. Run the browser
> WebSocket validation (§6, option 3) before declaring it done — a regression
> here breaks ordinary session switching.

---

### Phase 4 — P2: discoverability, docs, scenarios

#### Task 11 — Make the evidence ladder work for Pi sessions

**Files:** `scripts/debug-where.mjs`, `server/src/session-registry.ts`

`CLAUDE.md` instructs every agent to start troubleshooting with
`npm run debug:where`. For a Pi session created outside the Internal API that
returns nothing (E11), which is exactly how this investigation began.

Two bounded changes — **no boot-time rescan** (§1.4):
- `debug:where` falls back to a **direct filename glob** over
  `$PI_AGENT_DIR/sessions/*/*_<id>.jsonl` when the registry misses. Cheap,
  no scan, and it fixes the ladder immediately.
- The session watcher upserts a per-file registry entry on `add`/`change` for
  files it is *already* watching. Incremental only.

**RED tests:** 31. `debug:where` resolves an on-disk Pi session absent from the
registry; 32. the watcher upserts an exact entry on add without triggering a
directory-wide scan (assert scan-count).

#### Task 12 — Fix the live-validation scenario that already reproduced this

**Files:** `server/src/live-validation/scenarios.ts:1037-1073`

The existing `follow-up` scenario sends `follow_up` to an idle session (E14) —
it *is* the failing case, and its degraded result was written off as a runtime
quirk. Split it and add coverage for the new behaviour:

| Scenario | Asserts |
|---|---|
| `follow-up` (rewritten) | idle `follow_up` **promotes**: a real turn runs, response text matches, `dispatchMode: "prompt"` |
| `follow-up-strict` | `requireActiveTurn: true` on an idle session → `409 SESSION_NOT_STREAMING` |
| `prompt-mode-busy` | `follow_up` against a running Claude session → `409 SESSION_BUSY`, no receipt created |
| `approval-wrong-id` | POSTing an unknown requestId → `404`, and the pending question is still pending afterwards |
| `approval-by-toolcall-id` | POSTing the `toolCallId` resolves the question and the turn resumes |
| `stalled-run-reaped` | with a short idle timeout, a stalled run terminalises `TURN_STALLED` and `/capacity` returns to zero |

Register each in the scenario table and in `docs/LIVE-VALIDATION.md`.

#### Task 13 — Documentation

- `docs/INTERNAL-API.md` — the §3.2 mode table verbatim; `requireActiveTurn`;
  `dispatchMode`; the new error codes; the real `/approvals/pending` shape; the
  documented note that **`toolCallId` is accepted wherever `requestId` is**.
- `docs/INTERNAL-API-ORCHESTRATION.md` — a "continuing a session after a
  completed turn" recipe that shows `mode: "prompt"` as the default choice, and
  an answer-delivery ladder: *accepted → resolved → assistant resumed → turn
  terminal*.
- `docs/INTERNAL-API-CONTRACT.md` + `INTERNAL_API_CONTRACT_VERSION` →
  `1.13.0`, with a changelog entry naming the behaviour changes (idle
  `follow_up` promotion; `follow_up`/`steer` now busy-checked; approval
  responses now 404 on unknown ids).
- `docs/TROUBLESHOOTING.md` — a "run receipt stuck in `started`" entry pointing
  at `/capacity` `stalledRuns`.
- `docs/plans/CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md:631` — append a
  correction note: the Phase H diagnosis was inverted (E13). Do not rewrite
  history; annotate it.
- `AGENTS.md` / `CLAUDE.md` only if a link target changes; then run
  `npm run docs:sync-agent-guides`.

---

### Phase 5 — companion repo `/root/agent-os`

Do this **after** Phase 1 is green in `pi-web-ui`. Separate commit, separate
push, same no-new-branch rule.

#### Task 14 — Stop hard-coding the broken mode

**File:** `/root/agent-os/src/conductor/dispatch.ts:897`

`dispatchConfirmedFollowUp` sends `mode: 'follow_up'` unconditionally, and does
so *precisely after* proving the parent session is terminal and quiescent —
deterministically selecting the one mode Pi could not consume (E12). Change to
`mode: 'prompt'` for a continuation after a proven-terminal turn, and reserve
`follow_up` for genuine mid-turn queueing.

The Pi Web UI fix makes this work either way; fixing both means the intent is
recorded at the call site rather than relying on server-side promotion.

#### Task 15 — Type the two Claude identifiers apart

Wherever Agent OS stores `questionRequestId`, store both `requestId` and
`toolCallId` as distinct branded types. The Step 7C failure was a
straight conflation (E8): the `toolu_…` value was written into the
`questionRequestId` slot and POSTed as a path parameter.

#### Task 16 — Confirm delivery, don't assume it

`ownerAnswerDeliveredAt` must only be written after the API confirms
`resolved: true` (Task 3). Track the ladder distinctly: *answer prepared →
HTTP accepted → SDK resolved → assistant resumed → turn terminal → timed
out/rejected*. Add the corresponding tests in the Agent OS suite.

---

## 5. Quality gates

### 5.1 Baseline capture (before any edit)

Record **measured** values; do not copy numbers from this plan.

```bash
git rev-parse --short HEAD                 # expect 1b41f19 or a documented successor
npm run docs:check-agent-guides            # exit 0
npm run typecheck                          # exit 0
npm run lint                               # record the warning count → ceiling
npm test                                   # record server + client pass counts → floor
npm run build                              # record client gzip size → +1% ceiling
```

If HEAD has moved past `1b41f19`, diff the delta and note whether any task is
invalidated before starting.

### 5.2 Per-task gate

- Failing test written **first**; RED output pasted into the execution report.
- Implementation to GREEN; no other test regresses.
- Diff stays minimal and local to the task.

### 5.3 Exit gate (all must pass)

| Gate | Command | Requirement |
|---|---|---|
| Agent guides | `npm run docs:check-agent-guides` | exit 0, byte-identical |
| Lint | `npm run lint` | exit 0, warning count **≤ baseline** |
| Typecheck | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0, client gzip ≤ baseline + 1% |
| Tests | `npm test` | exit 0, pass count ≥ baseline + 32 new tests |
| Live validation | §6 | all listed scenarios pass or skip-with-reason |
| Secrets | `git diff --cached --stat` + manual review | no tokens, cookies, session dumps, `.env`, or transcript artifacts |

### 5.4 Invariants that must hold at exit

1. No accepted request is silently dropped — every `2xx` corresponds to work
   performed or work explicitly reported as queued/promoted.
2. No run occupies an admission slot without a terminal state, bounded by the
   watchdog.
3. No approval response returns `2xx` unless something was actually resolved.
4. No Pi session file is written with a header id that disagrees with its
   filename.
5. The browser path behaves exactly as before, except that opening a deleted
   session now errors instead of silently creating a new one.

---

## 6. Live validation (disposable server — mandatory)

**Production is not a validation target.** Everything below runs against a
disposable server. Use `--allow-production` only with explicit, recorded
operator permission — which this plan does not grant.

Per `docs/LIVE-VALIDATION.md`:

```bash
# Background task (do not foreground-wait on it)
VALIDATION_DIR="$(mktemp -d /tmp/pi-validation-XXXXXX)"
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0 \
  --env-file .env.production --env-key GLM_CODING_PLAN_TOKEN \
  >"$VALIDATION_DIR/server.log" 2>&1 &

PI_WEB_UI_WAIT_SOCKET="$VALIDATION_DIR/internal-api.sock" npm run internal-api:wait
```

Then, per phase:

```bash
# Phase 1 — dispatch truthfulness
npm run validate:live -- --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime pi --scenario follow-up
npm run validate:live -- … --runtime pi --scenario follow-up-strict
npm run validate:live -- … --runtime claude --scenario prompt-mode-busy
npm run validate:live -- … --runtime claude --scenario approval-wrong-id
npm run validate:live -- … --runtime claude --scenario approval-by-toolcall-id
npm run validate:live -- … --runtime pi --scenario stalled-run-reaped

# Regression sweep across the disposable-safe runtimes
npm run validate:live -- … --runtime all --scenario all
```

Known environment constraints (do not rediscover them):
- Antigravity is disabled in disposable mode; a skip there is expected evidence,
  not a failure.
- Native Anthropic SDK profiles hang in this sandbox (the launcher strips
  `ANTHROPIC_AUTH_TOKEN` → OAuth capacity failure). Use a **GLM profile**
  (`authTokenEnv=ANTHROPIC_AUTH_TOKEN`, z.ai base URL) via `CLAUDE_PROFILES_PATH`
  for the Claude SDK scenarios.
- The disposable server does **not** isolate `PI_AGENT_DIR` by default. For
  Task 10 and Task 11, launch with
  `PI_AGENT_DIR="$VALIDATION_DIR/pi-agent"` so identity and registry
  experiments cannot touch the operator's live sessions or `web-ui-prefs.json`.
  Prod prefs are actively edited by the operator — never restore a snapshot
  over them.
- Avoid `pkill -f`/`pgrep -f` patterns that match the validator's own command
  line.

**Phase 3 additionally requires the browser-WebSocket path** (option 3 in
`docs/LIVE-VALIDATION.md`) to prove ordinary session switching still works, plus
one manual check: switching to a **deleted** session must produce a clean
"session not found" error and must not create a file.

Record for each run: scenario id, runtime, pass/skip/fail, and the `runId`.

---

## 7. Execution order and risk

| Phase | Risk | Notes |
|---|---|---|
| 1 | Medium | Touches the hot dispatch path. Tasks 1–2 must land together; Task 4's mutex depends on Task 2's busy check. |
| 2 | Low | Additive surfaces and fields. |
| 3 | **High** | Shared with the browser. Land alone, validate on the WS path, commit separately. |
| 4 | Low | Docs, scripts, scenarios. |
| 5 | Low | Separate repo; depends on Phase 1 being deployed. |

Suggested commits: one per phase (Phase 1 may be two — dispatch, then
receipts/watchdog). Conventional-commit prefixes, matching repo history.

---

## 8. Deliverable

Write `docs/plans/INTERNAL-API-DISPATCH-AND-IDENTITY-INTEGRITY-REPORT.md`
alongside execution, following the structure of
`CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md`: measured baseline table, per-task
RED→GREEN evidence, live-validation results table with runIds, exit-gate table,
and an explicit list of anything deferred and why.

Report honestly. If a task is blocked or a gate fails, say so with the output —
do not narrow the scope silently. Scaling this work down is the operator's
decision, not the executing agent's.
