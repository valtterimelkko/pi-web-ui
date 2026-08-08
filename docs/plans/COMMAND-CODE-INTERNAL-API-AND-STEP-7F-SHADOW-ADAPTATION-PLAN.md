# Command Code Internal API adapter and Agent OS Step 7F shadow-cohort plan

> **Status:** implementation-ready plan; no production enablement is authorised by this document
>
> **Primary repository:** Pi Web UI (`/root/pi-web-ui`)
>
> **Consumer repository:** Agent OS (`/root/agent-os`)
>
> **Public runtime id:** `commandcode`
>
> **Exact initial model allowlist:** `qwen/qwen3.8-max` and `meta/muse-spark-1.2-contributor`
>
> **Initial product boundary:** local authenticated Internal API only; no browser, WebSocket, shared `SdkType`, notifications, transfer, or ordinary user-session integration
>
> **Decision window:** the two routes are non-policy-deciding Step 7F shadow routes. Sol and K3 remain the only Step 7G finalists.

## 1. Purpose and outcome

This plan adds Command Code as a feature-gated, server-local execution runtime behind Pi Web UI's existing Internal API and uses two exact Command Code model routes as a shadow cohort during Agent OS Step 7F:

- `qwen/qwen3.8-max` — Qwen 3.8 Max;
- `meta/muse-spark-1.2-contributor` — Muse Spark 1.2 Contributor.

The work has two linked outcomes:

1. **Pi Web UI:** create a production-shaped Command Code adapter that uses Command Code's documented headless NDJSON subprocess interface while preserving the existing `/api/v1` session, run, evidence, transcript, abort, delete, capability, model, health, admission, receipt, and cessation contracts.
2. **Agent OS:** bind the two exact routes into the fresh Step 7F mission as shadow-scored, P1-compliant conductors. They receive the same mission, baseline, budgets, evidence collection, and scoring treatment as the finalists, but their scores cannot select or alter the Sol/K3 Step 7G primary/fallback verdict.

This is not a disposable wrapper around `cmd`. The first implementation must establish the lifecycle, evidence, containment, and route-identity foundations needed for a later, separately approved browser-runtime promotion. It must nevertheless keep the initial blast radius narrow.

## 2. Governing boundaries

Read and preserve these sources before implementation:

### Pi Web UI

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- [`../ADDING-A-RUNTIME.md`](../ADDING-A-RUNTIME.md)
- [`../EVENT-PIPELINE.md`](../EVENT-PIPELINE.md)
- [`../INTERNAL-API.md`](../INTERNAL-API.md)
- [`../INTERNAL-API-CONTRACT.md`](../INTERNAL-API-CONTRACT.md)
- [`../INTERNAL-API-ORCHESTRATION.md`](../INTERNAL-API-ORCHESTRATION.md)
- [`../LIVE-VALIDATION.md`](../LIVE-VALIDATION.md)
- [`../PROCESS-ISOLATION-DESIGN.md`](../PROCESS-ISOLATION-DESIGN.md)
- [`../../SECURITY.md`](../../SECURITY.md)
- [`PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md`](./PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md)

### Agent OS

- `docs/CURRENT-STATE.md`
- `docs/ARCHITECTURE-BOUNDARIES.md`
- `docs/execution/STEP-P1-TASK-BRIEF.md`
- `docs/execution/STEP-7F-TASK-BRIEF.md`
- `docs/execution/STEP-7G-TASK-BRIEF.md`

The repository boundary remains unchanged:

- **Agent OS owns** mission decomposition, role assignment, model routing, owner authority, hierarchical child admission, acceptance, scoreability, and policy verdicts.
- **Pi Web UI owns** runtime process execution, containment, normalized events, sessions, receipts, evidence, transcripts, abort, deletion, health, availability, and resource truth.
- **Command Code owns** its authentication and native transcript persistence. Pi Web UI must not parse, copy, log, migrate, or re-store `~/.commandcode/auth.json`.

## 3. Locked decisions

Implementation may refine mechanics but must not silently reopen these decisions.

### 3.1 Runtime transport

Use the documented Command Code 1.14.1 headless interface as a subprocess:

```bash
<absolute-cmd-path> -p \
  --output-format json \
  --model <exact-allowlisted-id> \
  --max-turns <server-bounded-value> \
  --trust \
  --skip-onboarding \
  --no-auto-update
```

The prompt is written to stdin and then stdin is closed. Stdout is parsed incrementally as NDJSON. Stderr is captured separately as bounded diagnostics. Do not use an embedded package API, private import, reverse-engineered module, interactive TTY automation, or Command Code Mod as the event transport.

Command Code's installed npm package declares `UNLICENSED` and exposes no supported embedding API. Treat the CLI as an operator-installed external executable: do not vendor, redistribute, copy, import, patch, or derive adapter code from its bundled implementation. Only the documented process contract and observed public CLI output may be consumed. Re-check redistribution/terms before any packaging or permanent browser promotion.

For a follow-up turn, add:

```bash
--resume <stored-exact-native-session-id>
```

Never use `--continue`: it chooses the latest headless session in the current directory and can attach the wrong Pi Web UI session.

### 3.2 Runtime and route identity

- Internal API runtime id: `commandcode`.
- Source directory/file prefix: `server/src/command-code/command-code-*`.
- Execution instance id: `commandcode-default` initially.
- The `/models` entries use the exact lowercase CLI-discovered ids above.
- Matching is exact and case-sensitive. Friendly names, aliases, provider-family names, prefixes, and the differently cased generated-doc spelling `Qwen/Qwen3.8-Max` do not satisfy the route binding.
- The initial server allowlist contains exactly those two ids. A caller or environment variable cannot broaden it.
- A fresh startup availability probe must confirm the installed CLI still advertises both exact ids. Missing or ambiguous routes are unavailable, not substituted.

### 3.3 Initial product boundary

The first slice adds `commandcode` only to server-local Internal API types and routing. It does **not** add it to:

- `shared/src/types.ts` `SdkType`;
- `shared/src/protocol-types.ts`;
- browser WebSocket routing;
- `server/src/session-registry.ts`'s browser-facing `RegistryEntry` union;
- the session picker or any client store/component;
- session transfer;
- browser notifications;
- Drive Mode;
- the default disposable `--runtime all` set.

This is a deliberate staged exception to the full runtime checklist in `ADDING-A-RUNTIME.md`, not permission to bypass its lifecycle invariants. The later browser-promotion phase closes the exception.

### 3.4 Step 7F authority

- Sol and K3 remain the only policy-deciding finalists.
- Qwen and Muse are a labelled shadow cohort.
- Their route-level results may inform later model-landscape work but cannot change, veto, break a tie in, or supply fallback evidence for the Step 7G Sol/K3 verdict.
- Mixed harnesses are an intentional route characteristic. The evidence unit is the model-plus-runtime route, as it was for earlier Claude/Opus work. Harness differences are recorded, not used to invalidate the shadow comparison.
- A shadow route that cannot satisfy P1 role separation is non-scoreable. It does not fall back to direct implementation.

### 3.5 Permission profiles

Permission profile selection is server/Agent-OS-owned and is not accepted from an Internal API request body.

1. **`agent-os-7f-root-readonly`**
   - no mutable product lease or mutable product worktree;
   - read-only source view;
   - Command Code plan/read-only mode, no `--yolo`;
   - no direct product edits, mutating shell, commit, push, or native Command Code implementation sub-agent;
   - may return one strict Agent OS hierarchical child proposal through the retained-turn handoff protocol;
   - any observed root mutation or attempted substitution of a Command Code-native child for a first-class Agent OS child records a role-separation violation and makes the route non-scoreable.

2. **`implementation-child-wide`**
   - isolated, disjoint, attempt-bound worktree with an ordinary Agent OS mutable lease;
   - widest practical Command Code permissions, including `--yolo --trust --skip-onboarding --no-auto-update`;
   - bounded process group/cgroup, cwd, duration, turns, output, concurrency, and cleanup;
   - no expansion beyond the admitted repository/worktree envelope;
   - normal secret scanning, path, auth, prompt-injection, evidence, and sign-off controls still apply.

`--yolo` widens Command Code tool execution; it does not waive OS containment, Pi Web UI admission, Agent OS leases, acceptance criteria, repository boundaries, or public-repository secret rules.

## 4. Target architecture

```text
Agent OS plan / route binding / P1 hierarchy
  -> Pi Web UI authenticated Unix-socket Internal API
    -> internal session resolver
      -> existing browser SessionRegistry-backed runtimes
      -> CommandCodeInternalSessionStore
    -> CommandCodeService
      -> CommandCodeProcessRunner
        -> absolute `cmd -p --output-format json` subprocess
      -> CommandCodeNdjsonParser
      -> CommandCodeEventAdapter
      -> existing run receipt / evidence / transcript / watch plumbing
```

### 4.1 New Pi Web UI module family

Create a narrow server module family:

```text
server/src/command-code/
  command-code-types.ts
  command-code-config.ts
  command-code-model-catalog.ts
  command-code-process-runner.ts
  command-code-ndjson-parser.ts
  command-code-event-adapter.ts
  command-code-session-store.ts
  command-code-event-journal.ts
  command-code-session-resolver.ts
  command-code-service.ts
  command-code-health.ts
```

The final file split may combine very small modules, but the following responsibilities must remain independently testable:

- command construction and profile selection;
- model allowlist/discovery;
- process spawn, stdout/stderr, abort, timeout, and process-group cleanup;
- incremental NDJSON framing and validation;
- native-event normalization and duplicate filtering;
- private session mapping/persistence;
- append-only normalized event journaling and replay;
- runtime service lifecycle;
- health/readiness classification.

### 4.2 Internal session identity and store

Because initial Command Code sessions are intentionally absent from shared/browser `SdkType`, do not force them into `SessionRegistry` with casts. Add an Internal-API-only composite session resolver and a private `CommandCodeInternalSessionStore`.

Each stored record should bind at minimum:

```ts
interface CommandCodeInternalSessionRecord {
  schemaVersion: 1;
  sessionId: string;                 // Pi Web UI canonical internal id
  runtime: 'commandcode';
  nativeSessionId?: string;          // exact Command Code id after first resolution
  cwd: string;                       // canonical, validated worktree/source path
  modelSelector: 'qwen/qwen3.8-max' | 'meta/muse-spark-1.2-contributor';
  executionInstanceId: 'commandcode-default';
  permissionProfile: 'agent-os-7f-root-readonly' | 'implementation-child-wide';
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  eventJournalRef: string;           // private Pi Web UI normalized-event journal
  state: 'created' | 'running' | 'idle' | 'failed' | 'aborted' | 'deleted';
  lastResult?: {
    subtype: 'success' | 'error' | 'max_turns';
    stopReason?: string;
    exitCode?: number;
  };
}
```

Requirements:

- Use a private, owner-only Pi Web UI state path with atomic write/rename and schema validation.
- Store only identifiers and bounded metadata needed by the Internal API; do not duplicate the native transcript or credentials.
- Persist each accepted normalized event to a private append-only, schema-validated, size-bounded event journal before exposing terminal completion. The journal is Pi Web UI's restart-safe replay/screen-transcript source and follows existing Internal API retention/redaction policy.
- Canonicalise and validate cwd before persistence and again before spawn/resume.
- Refuse model, cwd, permission-profile, runtime, or native-session drift on resume.
- Recover records after server restart without assuming an old subprocess still exists.
- Treat persisted `running` without a live owned process as interrupted/unknown until receipt reconciliation; never fabricate success.
- Delete removes Pi Web UI's mapping/evidence subject to normal retention rules. Native Command Code transcript deletion is not part of the initial contract and must be reported honestly.

### 4.3 Composite resolver

Refactor Internal API session lookup behind a resolver interface rather than spreading runtime casts through `routes/sessions.ts`. The resolver must support the operations required by the standard API:

- get/list by canonical id;
- create metadata;
- update run/native id/state;
- resolve runtime and execution instance;
- delete mapping;
- runtime-native id lookup for evidence/debug integration;
- enumerate bounded diagnostics.

Existing runtimes continue to delegate to `SessionRegistry`; Command Code delegates to the private store. Browser/WebSocket code remains on `SessionRegistry` and therefore cannot discover initial Command Code sessions.

The list endpoint must include Command Code sessions only when the Internal API feature is enabled and the authenticated Internal API caller uses the standard route. No browser endpoint gains them accidentally.

### 4.4 Process ownership and containment

`CommandCodeProcessRunner` must:

- resolve and validate one absolute executable path at startup; do not rely on mutable per-request `PATH` lookup;
- use argv arrays with `shell: false`;
- use stdin for prompt bytes;
- set cwd to the canonical attempt path;
- construct a minimal controlled environment while preserving only what Command Code needs to locate its own auth/config;
- never expose environment values in API responses, receipts, diagnostics, or logs;
- assign a process group and, where the existing isolation layer supports it, an attempt/session cgroup;
- enforce one active turn per Command Code session;
- integrate with the shared admission controller and runtime concurrency limit;
- enforce server-owned prompt-byte, `--max-turns`, wall-time, stdout-line, stdout-byte, stderr-byte, and unknown-event bounds;
- stream stdout line by line without buffering the complete run;
- retain only a bounded stderr tail after secret redaction;
- on abort/timeout/shutdown send graceful termination to the whole process group, wait a bounded grace period, then hard-kill the whole group;
- reap the child and release admission exactly once on every path;
- never treat process exit alone as successful completion.

Suggested conservative initial defaults are one active Command Code turn globally, one per session, a server-capped turn count, and the existing Internal API prompt bounds. Exact values should be set with resource-plan evidence rather than copied from Command Code's unbounded/default limits.

### 4.5 Authentication and quota/error truth

Command Code remains the credential owner. Pi Web UI may execute `cmd` under the service account and classify documented exit codes, but must not inspect the credential file.

Map at least these exit codes to typed, redacted diagnostics and terminal receipts:

| Exit | Command Code meaning | Internal handling |
|---:|---|---|
| 0 | success | valid only with a parsed terminal result |
| 1 | general error | failed receipt, retry classification based on evidence |
| 3 | not authenticated | runtime unavailable/auth-required; no credential dump |
| 4 | permission denied | profile/policy failure; root violation assessment where relevant |
| 5 | rate limited | quota/resource blocker, retry-after only if observed |
| 6 | network failure | recoverable transport failure if bounded policy permits |
| 7 | provider 5xx | recoverable provider failure if bounded policy permits |
| 8 | max turns | explicit max-turns terminal state; partial output preserved |
| 9 | no model response | empty-output cessation evidence; never synthesize success |
| 10 | insufficient credits | quota blocker; no fallback model substitution |
| 130 | interrupted | aborted/interrupted, correlated to abort/termination evidence |

`/health`, `/capabilities`, and `/models` must distinguish disabled, executable missing, auth-required, exact-model missing, rate-limited/credit-blocked when observable, degraded, and available states. Generic top-level health must not hide runtime-specific truth.

## 5. NDJSON ingestion and event contract

### 5.1 Frame grammar

Stdout accepts exactly two top-level shapes:

```json
{"type":"event","event":{"type":"..."}}
{"type":"result","subtype":"success|error|max_turns", ...}
```

Parser requirements:

- parse incrementally by newline;
- bound individual line and aggregate bytes;
- reject non-object JSON and malformed known frames;
- tolerate and retain bounded unknown event types as diagnostics;
- permit exactly one terminal result and require it to be last;
- treat EOF without a terminal result as incomplete/failed even when exit code is zero;
- treat a result/exit-code contradiction as a protocol failure and preserve both facts;
- treat `sessionId` and `stopReason` as optional on early error results;
- bind the first observed native `sessionId` atomically to the canonical session and reject later drift;
- redact sensitive values before logging malformed-line context.

### 5.2 Normalization policy

The adapter should consume the complete observed Command Code event vocabulary and map semantically useful events into Pi Web UI's normalized event/replay model. At minimum preserve:

- assistant thinking/reasoning deltas where exposed;
- assistant text deltas/final text;
- tool start, tool identity, bounded arguments/description;
- tool result, error, and completion;
- model request/response timing and usage signals;
- compaction/context lifecycle events;
- run/session lifecycle;
- the final result subtype, stop reason, usage, duration, error class, and native session id.

Unknown events are retained in bounded diagnostics/evidence with event type and redacted metadata. They must not crash the run or disappear silently.

### 5.3 Duplicate suppression

Live probing found cumulative `message_update` snapshots dominate the stream and duplicate direct deltas. The adapter must establish one canonical text/thinking stream:

1. consume direct deltas when present;
2. track the last cumulative snapshot by message/content identity;
3. emit only the unseen suffix when a snapshot is the sole source;
4. suppress exact/replayed cumulative content already emitted;
5. preserve a counter of suppressed duplicates in diagnostics;
6. ensure replay and live paths produce the same operator-visible text once, in order.

Golden tests must use a captured, sanitised fixture that includes direct deltas plus cumulative updates.

### 5.4 Terminality

Every accepted prompt must end in exactly one Internal API terminal run receipt. Terminality requires reconciliation of:

- terminal NDJSON result, if any;
- process exit code/signal;
- abort/timeout/shutdown cause;
- normalized `agent_end` emission;
- usage/final text evidence;
- native session identity.

Rules:

- synthesize one `agent_end` for normalized consumers if Command Code does not emit the equivalent itself;
- never emit two terminal events;
- `subtype:error`, max turns, exit 9, EOF-without-result, malformed result, timeout, and forced kill are not success;
- partial text/tool evidence remains available on failure;
- an empty successful `finalText` is explicitly recorded and is not converted to useful output;
- receipt completion occurs only after parser/process reconciliation and evidence flush;
- late lines after terminality are diagnostic protocol violations and cannot reopen the run.

## 6. Standard Internal API integration

Do not add a parallel `/command-code/*` API. Extend the normal authenticated `/api/v1` surface.

### 6.1 Contract version

Bump the additive contract from `1.16.0` to `1.18.0` to cover the feature-gated runtime and its run-scoped terminal usage evidence in:

- `server/src/internal-api/types.ts`;
- `docs/INTERNAL-API-CONTRACT.md` changelog and examples;
- `docs/INTERNAL-API.md` examples;
- `docs/INTERNAL-API-ORCHESTRATION.md` capability guidance;
- contract and consumer fixture tests, including Agent OS's mirrored minimum/fixtures where required.

The changelog must state that `commandcode` is an optional Internal-API-only runtime and that old clients may ignore the additive runtime/capability/model entries.

### 6.2 Capabilities, models, health, diagnostics

When disabled, expose a truthful disabled/unavailable capability without advertising runnable models. When enabled:

- add `commandcode` runtime capabilities to the Internal API response;
- publish exact execution instance `commandcode-default`;
- advertise only the two exact models that pass live discovery;
- advertise model-specific thinking/effort levels only when the exact CLI route reports and the adapter can enforce them; Muse must not inherit Qwen effort levels;
- add a runtime-specific health entry;
- add admission/capacity data for Command Code;
- include bounded runtime/session/process diagnostics;
- add error codes for CLI missing, auth required, exact model unavailable, protocol malformed/incomplete, no response, max turns, credits, rate limit, resume identity drift, and role/profile refusal where these do not already map cleanly.

No capability may be inferred solely from the binary existing.

### 6.3 Sessions

`POST /api/v1/sessions` accepts `runtime: "commandcode"` only when feature enabled, healthy enough to create, and the exact model is allowlisted/advertised. It must preserve existing:

- request authentication;
- Zod validation and unknown-field rejection policy;
- cwd/path validation;
- prompt-injection handling on subsequent prompts;
- admission/capacity response semantics;
- idempotency and correlation conventions;
- canonical internal session id response.

The public request must not accept `permissionProfile`, `yolo`, executable path, arbitrary argv, environment, native session id, auth path, or model alias. Add one generic, typed orchestration field such as `invocationRole: "conductor-root" | "implementation-child"` to the standard create-session contract and immutable run/session evidence. For `commandcode`, require it; map it server-side to the two fixed profiles and reject every other value. Agent OS may choose the invocation role only from its confirmed immutable plan, revalidate that role immediately before dispatch, and bind its plan/attempt authority through existing correlation/evidence references. Pi Web UI owns the argv/profile mapping; neither Agent OS nor another caller can send raw permissions. A root-role create against a mutable execution worktree or a child-role create without the Agent OS-admitted child/worktree evidence required by the dispatch workflow must fail closed before prompt execution.

### 6.4 Prompt and runs

`POST /api/v1/sessions/:id/prompt` must:

- resolve the private Command Code session through the composite resolver;
- reject concurrent turns;
- run prompt-injection detection before forwarding text;
- resume only by the stored exact native id after turn one;
- create the same run/receipt/correlation records as other runtimes;
- feed live events to watches and terminal detection;
- return existing asynchronous run semantics, not hold the HTTP request for the subprocess lifetime;
- preserve generation fencing and abort races.

`GET /runs/:runId` and the session run listing must return standard receipt state, usage, timestamps, errors, execution instance, model selector, terminality, and cessation evidence.

### 6.5 Evidence and transcripts

`GET /api/v1/sessions/:id/evidence` is the first diagnostic bundle. It should include bounded:

- canonical and native ids;
- runtime/model/execution instance/profile label (not raw flags);
- run/receipt state and correlation ids;
- result subtype, stop reason, exit code/signal, duration, usage;
- duplicate-suppression and unknown-event counters;
- process termination/cleanup evidence;
- redacted stderr tail and protocol diagnostics;
- native transcript locator as an opaque/private locator only when safe, not transcript contents by default.

`GET /api/v1/sessions/:id/transcript` must support the standard raw and `view=screen` projections from Pi Web UI's private normalized event journal, including after server restart. Initial implementation must not require reading the Command Code native JSONL to answer ordinary transcript requests. If journal validation/replay fails, return a typed evidence gap/error and preserve the journal for diagnosis; never return an invented empty transcript.

### 6.6 Abort, delete, shutdown

- `POST /abort` (or the existing route shape) terminates the current process group, records interrupted terminality, and is idempotent.
- Delete refuses or first aborts an active turn according to existing route semantics, removes the private mapping, releases Pi-owned retention/admission resources, and records what native Command Code data remains.
- Server shutdown aborts/reaps all owned Command Code process groups within a bounded deadline.
- Restart never assumes ownership of stale PIDs without identity proof.
- Late completion after abort/delete cannot resurrect the session or overwrite the abort receipt.

### 6.7 Watches and long-horizon behavior

The initial adapter must feed Internal API prompt-originated events into run receipts and watches. Browser-originated observation is out of scope because browser Command Code sessions do not yet exist.

Do not add Command Code to default disposable `all`. Add an explicit `commandcode` validation runtime/scenario that is disabled unless the operator opts in and Command Code credentials/credits are available. Long-horizon validation is separately invoked and must preserve durable watch semantics.

## 7. Agent OS Step 7F shadow integration

The Agent OS amendment is governed by `docs/execution/STEP-7F-TASK-BRIEF.md`; this section defines the cross-repository implementation needed to make it executable.

### 7.1 Model landscape and route binding

Add two exact, temporary Step 7F shadow route keys in `src/conductor/model-landscape.ts` and associated tests. Each route must bind:

- Pi Web UI runtime `commandcode`;
- exact model selector;
- exact execution instance `commandcode-default`;
- supported effort/thinking level as freshly advertised;
- current quota/availability evidence;
- invocation role `conductor-root` for the root session;
- a Command Code root binding only: the implementation child is **not** forced to the Command Code route. The root emits requirements with the `agent-os-selected` sentinel, and Agent OS selects one exact ordinary specialist child from the owner-approved common envelope (Luna, Sonnet, GLM 5.2, Terra or Opus) using semantic fit, fresh `/models` capability, specialist-child authority and authenticated subscription-quota evidence; the selected child carries the ordinary `specialist-child` role and its exact route-selection evidence; optional reviewers remain separately frozen by the common envelope;
- `policyDeciding: false` or an equivalent typed shadow authority marker;
- the Step 7F owner-evidence and canonical mission hash.

Do not make either route automatically eligible for ordinary child/conductor routing, Step 7G selection, or fallback. Their temporary authority closes with the Step 7F rerun window just like finalist exception authority.

### 7.2 Plan schema and scoreability

Update `src/conductor/plan-store.ts` and tests so a comparison cohort can contain:

- two policy-deciding finalist routes (Sol/K3);
- zero or more explicitly non-policy-deciding shadow routes;
- identical mission/acceptance/evidence projections;
- route-specific runtime/profile bindings;
- a frozen `mixedHarnessAccepted` decision/evidence reference;
- a verdict-authority projection that excludes shadow routes.

Fail closed when:

- a shadow route is accidentally marked policy deciding;
- a Step 7G verdict cites a shadow score as selection evidence;
- mission, baseline, prompt hash, owner envelope, or scoring rubric differs without a predeclared runtime-capability reason;
- root/child evidence is missing or conflated;
- a Command Code alias/family/case variant is substituted;
- the root forces a concrete child route, the selected child is outside the amended common envelope, or either runtime silently substitutes another model after Agent OS selection.

### 7.3 Turn-based P1 child bridge

Do not make Command Code Mods the event transport and do not let a root implement directly. Use the existing P1 structured-proposal protocol as a retained, turn-based bridge:

1. Agent OS creates and confirms the depth-0 root plan with no mutable product repository/lease.
2. Pi Web UI starts the Command Code root using `agent-os-7f-root-readonly` against a read-only source view.
3. The root's first terminal `finalText` must contain exactly one strict `HierarchicalChildProposal` payload, must carry `routeSelection: "agent-os"` and `routeKey: "agent-os-selected"`, and must contain no claimed implementation result.
4. Agent OS parses it with `parseHierarchicalChildProposal(...)`, selects one exact route from the D10 common envelope using semantic routing, fresh capability and authenticated quota gates, persists computed validation evidence, creates the ordinary depth-1 child plan with the selected thinking/route binding, and calls `admitHierarchicalChildPlan(...)`/`agent-os conductor child-admit` with the exact parent plan/task/confirmation/root-session binding.
5. If in envelope, Agent OS dispatches the selected Pi/Claude child through `dispatchConfirmedPlan(...)` as an ordinary first-class attempt in its own disjoint mutable worktree. Command Code native child delegation remains forbidden; no root-proposed, Sol/K3, direct-pay or out-of-envelope runtime/model fallback is permitted.
6. The child produces its own session, run receipt, evidence, handback, and lease release/reconciliation.
7. The existing recovery runner creates one bounded root wake. Pi Web UI resumes the exact retained Command Code native session id and supplies the evidence-bound handback.
8. The root returns criterion dispositions/recommendation; Agent OS persists `child-disposition` and scores only after all P1 evidence and quiescence gates pass.

Command Code's native `agent` tool/sub-agents do not satisfy this protocol because they do not create Agent OS child admission, lease, receipt, handback, wake, or disposition evidence. For a 7F root, observing an attempted native implementation child is a typed role-separation event: abort/freeze as policy dictates and mark non-scoreable. A future narrow MCP/Mod control tool may be considered only if the retained final-output/wake protocol proves inadequate; it must expose proposal submission only, carry attempt-bound credentials, and still call the same Agent OS admission path.

### 7.4 Dispatch, recovery, and quota code

Expected Agent OS touch points include:

- `src/conductor/model-landscape.ts` — exact temporary routes and capability identity;
- `src/conductor/plan-store.ts` — shadow authority, cohort invariants, scoreability;
- `src/conductor/dispatch.ts` — runtime/profile binding and no-model-fallback checks;
- `src/conductor/recovery.ts` — exact retained Command Code root wake and result classification;
- Pi Web UI client/capability/quota code — `commandcode` parsing and version gate;
- CLI/validation scripts — cohort launch, evidence freeze, cessation controls;
- relevant B13, Step 7F, dispatch, recovery, model-identity, and contract tests.

No Agent OS code may read Command Code auth/session files directly. It consumes Pi Web UI contract evidence.

### 7.5 Symmetry and mixed harness

All four routes receive the same:

- owner mission and canonical prompt bytes except predeclared runtime framing;
- source baseline and equivalent isolated worktree state;
- P1 hierarchy depth, child count/concurrency ceiling, repository envelope, wall/token budget, and required evidence kinds;
- staged/natural blocker;
- runner restart exercise;
- scorecard rubric, evaluator freeze, and cessation accounting;
- opportunity for one bounded implementation child and permitted reviewer if the frozen mission allows it.

Record runtime-specific facts—model context, effort vocabulary, event schema, pricing/usage, and harness overhead—as route metadata. Do not normalize away real route behavior, and do not re-litigate the owner's accepted route-level mixed-harness evidence unit.

### 7.6 Shadow scoreability and cessation gates

A Qwen or Muse route receives a score only if it has:

- exact route identity proven by fresh `/models`, create response, session evidence, and receipt;
- non-empty useful root proposal output;
- a first-class admitted implementation child;
- separate root and child sessions/runs/receipts;
- `child-attempt-admission`, `child-run-receipt`, `child-handback`, and `child-disposition` evidence;
- zero root-authored product mutation;
- bounded root wake on the exact retained native session;
- complete terminality and cessation accounting;
- all frozen mission criteria disposed.

Record every empty/zero-usage assistant turn, exit 9, early result, missing final result, max-turns result, timeout, and premature cessation. No route-specific rescue or silent retry is allowed. Any retry must be the same typed, bounded policy available to all routes and must remain visible in the scorecard.

## 8. TDD implementation sequence

Every code work package starts with a failing test and records RED before implementation and GREEN after. A test first observed only after implementation does not satisfy this plan.

Maintain a compact implementation evidence ledger containing:

- work package/test name;
- exact failing command and relevant failure output;
- implementation commit/diff reference;
- exact passing command;
- any refactor-only pass;
- live evidence locator where applicable.

### WP0 — freeze fixtures and contract assumptions

RED tests:

- exact model allowlist rejects aliases/case variants/third models;
- NDJSON fixture parser does not yet exist;
- server-local `SessionRuntime` lacks `commandcode` while shared `SdkType` remains unchanged.

Deliverables:

- sanitised NDJSON fixtures from a harmless probe, including success, malformed line, cumulative updates, tool call/result, early error without session id, max turns/no response, and unknown event;
- documented Command Code version/output evidence;
- contract bump test expectation.

### WP1 — parser and event adapter

Write failing unit/golden tests for:

- chunk-split and multi-line framing;
- line/aggregate bounds;
- malformed JSON/known frame rejection;
- unknown event retention;
- duplicate cumulative snapshot suppression;
- text/thinking/tool ordering;
- result-last/exactly-once rule;
- EOF without result;
- optional result fields on early errors;
- exit/result contradiction;
- one `agent_end` and one terminal receipt projection.

Implement parser/adapter until green, then refactor without changing fixtures.

### WP2 — command builder and process runner

Write failing tests for:

- absolute binary, `shell:false`, stdin prompt;
- exact model argv;
- first turn vs exact `--resume` turn;
- absence of `--continue` in every path;
- root profile never contains `--yolo`;
- child profile contains expected wide flags;
- request bodies cannot inject flags/profile/env/native id;
- process group termination and escalation;
- timeout/abort/shutdown races;
- stdout/stderr limits and redaction;
- admission release and child reap exactly once;
- documented exit-code mapping.

Use a fake executable fixture for deterministic tests; do not spend model credits for unit coverage.

### WP3 — private store and composite resolver

Write failing tests for:

- atomic validated persistence;
- canonical cwd/model/profile/native-id binding;
- restart recovery of idle/ambiguous-running records;
- native id drift refusal;
- internal list/get/delete behavior;
- browser `SessionRegistry` remains unchanged and cannot list Command Code;
- deletion/late-event race;
- no auth or native-transcript content copied into the metadata store;
- append-only normalized event journal ordering, bounds, redaction, restart replay, corruption handling, and retention cleanup.

### WP4 — service and lifecycle

Write failing tests for:

- create, first prompt, exact resume, running guard;
- result/process reconciliation;
- partial failure evidence;
- abort idempotency;
- delete/shutdown cleanup;
- restart interruption truth;
- normalized replay/screen projection;
- no-response/max-turns/auth/quota classification;
- unknown events do not break terminality.

### WP5 — Internal API routes and contract

Write failing route/contract tests for:

- feature gate disabled/enabled;
- capability/model/health truth;
- exact model create validation;
- standard session/prompt/run/evidence/transcript/abort/delete flows;
- authentication, Zod, path, prompt-injection, request bounds, admission, and correlation invariants;
- permission profile is not caller-selectable;
- `runtime=commandcode` remains absent from browser/shared protocol types;
- additive contract version and old-client tolerance;
- default `all` disposable validation does not broaden.

### WP6 — Agent OS route and P1 integration

In `/root/agent-os`, write failing tests for:

- exact Qwen/Muse root identity plus Agent OS-selected ordinary child route from the D10 common envelope; root and child runtime/model/instance identities must remain distinct and exactly bound;
- shadow routes cannot be policy deciding;
- mixed-harness decision is bound and immutable;
- identical mission/envelope/rubric projection;
- strict proposal parse/admission/dispatch/handback/wake/disposition chain;
- no mutable lease for root and a distinct lease for child;
- native Command Code child is forbidden/non-substitutive/non-scoreable; a root may not force a concrete child route;
- root mutation, zero-child, missing receipt/handback/disposition, and identity drift fail closed;
- Step 7G verdict cannot cite shadow scores;
- temporary authority closure;
- no fallback model on auth/quota/empty response.

### WP7 — disposable live validation

Only after deterministic tests pass, run credit-conscious live probes in a disposable server/worktree:

1. capability/health/model discovery for both exact ids;
2. harmless read-only create→prompt→run→evidence→screen transcript→delete for Qwen;
3. same for Muse;
4. exact two-turn resume for each model, proving native session continuity;
5. abort a bounded long-running harmless prompt and prove process-group cessation/quiescence;
6. restart between turns and prove private mapping recovery/exact resume, or freeze the explicit blocker;
7. one isolated selected Pi/Claude child-profile write in a disposable fixture worktree, proving wide permissions stay inside the worktree and the root cannot select the child model/runtime;
8. one full P1 disposable hierarchy per route: read-only Command Code root proposal with the Agent OS selection sentinel, exact common-envelope child selection evidence, first-class ordinary child, receipt, handback, root wake, disposition, zero root mutation;
9. negative controls for forbidden model, profile injection, wrong native id, malformed fake stream, missing result, and disabled feature.

Do not target production without explicit owner permission. Keep auth/tokens/transcripts out of committed artifacts. Record canonical session ids, run ids, request ids, evidence bundle paths, and sanitised validation reports.

## 9. Test and validation map

Expected Pi Web UI test areas include:

```text
server/tests/unit/command-code/*
server/tests/unit/internal-api/*command-code*
server/tests/integration/internal-api/*command-code*
server/tests/unit/internal-api/run-receipts/*
server/tests/unit/internal-api/watch/*
shared/src/types-dual.test.ts              # negative boundary assertion only
scripts/live-validate.ts / scenario tests
```

Expected Agent OS test areas include:

```text
tests/conductor-step7f*.test.ts
tests/conductor-step-p1-role-separation.test.ts
tests/conductor-dispatch*.test.ts
tests/conductor-step7d-recovery.test.ts
tests/model-identity*.test.ts
src/validate/stages/stage-b13-dispatch.ts and stage tests
```

Use repository conventions rather than creating duplicate suites when an existing file is the canonical home.

## 10. Quality gates

### Gate A — deterministic adapter correctness

Required:

- all parser, adapter, runner, store, service, API, security, and Agent OS unit/integration tests green;
- RED→GREEN ledger complete;
- exact identity/permission/terminality negative controls bite;
- no shared/browser type expansion.

### Gate B — repository quality

Pi Web UI:

```bash
npm run docs:check-agent-guides
npm run lint
npm run typecheck
npm run build
npm test
```

Agent OS: run its documented lint/typecheck/build/test and B13 validation commands from the current package scripts. Do not invent substitute commands if the scripts differ.

### Gate C — disposable runtime proof

Required:

- both exact models complete standard Internal API lifecycle probes;
- exact resume is proven;
- abort/delete/shutdown leave no owned process or lease;
- evidence/transcript/receipt correlation is complete;
- auth and secrets are absent from reports;
- one P1 root→child→handback→wake proof per shadow route;
- negative controls fail closed.

### Gate D — Step 7F launch readiness

Before the real shadow window:

- current Command Code CLI version and both exact model ids are rediscovered;
- runtime health/auth/credits/quota are sufficient;
- current Pi Web UI contract/capacity is recorded;
- fresh Agent OS plans and owner authority bind the shadow marker;
- all four route baselines/worktrees/prompt hashes/envelopes/rubrics are frozen;
- child worktrees are disjoint and roots have no mutable product lease;
- cessation/role-separation monitors are armed;
- rollback/feature-disable command is rehearsed.

### Gate E — commit and public-repository hygiene

Before each commit/push:

```bash
git status --short
git diff --stat
git diff --cached --stat
```

Explicitly inspect staged files for secrets, tokens, cookies, auth dumps, native transcripts, session artifacts, local paths that should be private, and generated model output. Commit Pi Web UI and Agent OS separately with clear cross-references, then push only after all applicable gates pass.

## 11. Observability and evidence

Use existing structured logging/correlation conventions. Add Command Code namespaces for service, process, parser, events, and health. Every run should be traceable through:

- canonical session id;
- native session id after safe resolution;
- run id;
- request id;
- runtime/model/execution instance;
- process generation and pid identity while live;
- receipt/evidence references;
- Agent OS plan/attempt/child admission ids where supplied through generic correlation fields.

Never log:

- prompt or final text at normal operational levels;
- raw environment;
- auth/config file contents;
- tokens/cookies/credentials;
- unbounded tool arguments/results;
- complete stderr/stdout lines before redaction.

Diagnostics should answer: which exact route ran, whether the native id was bound, whether a terminal result arrived, why a run stopped, whether the process group is gone, and where the bounded evidence lives.

## 12. Security review checklist

- Internal API cookie/token/Unix-socket protections unchanged.
- All request shapes validated.
- Prompt-injection detection before runtime forwarding.
- cwd canonicalised, allowlisted, and bound to the attempt.
- executable absolute and server-owned.
- argv built without a shell.
- caller cannot pass flags, env, native ids, auth paths, permission profiles, or alternate models.
- root profile and absence of mutable lease enforced independently.
- child `--yolo` confined by worktree, process group/cgroup, admission, timeout, and evidence gates.
- resume id exact and stored; no `--continue`.
- output/event/line/stderr/tool-payload bounds enforced before persistence/logging.
- unknown events retained safely.
- auth file neither read nor copied by Pi Web UI.
- evidence secret-scanned/redacted before Agent OS persistence.
- no native transcript/session dump committed.

## 13. Rollout and rollback

### 13.1 Feature gates

Introduce a default-off server feature flag such as `PI_INTERNAL_API_COMMANDCODE_ENABLED`. Configuration names must follow `server/src/config.ts` conventions and be documented in `.env.example`/deployment docs without containing credentials.

Additional server-owned controls may include absolute executable path, state root, runtime concurrency, time/turn/output caps, and validation opt-in. Permission profiles and model allowlist are code/policy, not arbitrary caller configuration.

### 13.2 Rollout sequence

1. merge disabled adapter and deterministic tests;
2. validate capabilities show disabled truth;
3. enable only on a disposable validation server;
4. complete Gate C for both exact routes;
5. enable for the bounded Agent OS Step 7F shadow window;
6. close temporary Agent OS authority and disable after evidence freeze unless separately approved;
7. review operational evidence before considering ongoing Internal API availability.

### 13.3 Immediate rollback

If identity, containment, terminality, resource, credential, or role-separation evidence fails:

- stop new admission;
- disable the feature gate;
- abort and reap owned process groups;
- preserve bounded receipts/evidence and mark ambiguous runs non-scoreable;
- release/reconcile Pi Web UI admission/retention and Agent OS mutable leases only after quiescence proof;
- do not delete native transcripts as an unrecorded cleanup side effect;
- do not substitute another model/runtime;
- revert the adapter commit only after evidence required for diagnosis is safely retained outside git.

Because browser/shared types are untouched initially, rollback does not require a frontend protocol migration.

## 14. Future browser-runtime promotion

Permanent browser adoption is a separate owner-approved phase after Internal API soak evidence. The initial architecture must make it possible without pretending it is already delivered.

### Promotion prerequisites

- sustained lifecycle/resource evidence under the resource-scaling plan;
- stable native replay or a durable normalized replay source;
- proven multi-viewer event fanout;
- no unresolved credential/session-retention boundary;
- product decision on which Command Code models/profiles are user-selectable;
- security review for interactive permission mediation versus server-owned profiles;
- live validation showing prompt, resume, abort, restart, replay, and deletion behavior is fit for ordinary sessions.

### Promotion work

1. Add `commandcode` to shared `SdkType` and protocol types with compatibility tests.
2. Migrate private Internal API records into `SessionRegistry` through an explicit, idempotent schema migration; remove the composite-store exception only after verification.
3. Add native-id lookup and replay/history adapter backed by stable Command Code session semantics.
4. Add subscriber fanout and service-level observers.
5. Add WebSocket create/prompt/abort/switch/restore/status/availability routing.
6. Add client availability/session/model state and a runtime option in the new-session UI.
7. Define interactive permission UX; never expose a raw `--yolo` toggle without policy/containment design.
8. Add session transfer source/target adapters only after transcript fidelity and prompt-boundary semantics are tested.
9. Add notifications and Drive Mode only after observer and terminality parity.
10. Extend `debug:where`, troubleshooting, health/readiness, deployment, event-pipeline, architecture, and runtime-companion documentation.
11. Add browser E2E with `webapp-testing` for localhost and the appropriate authorised live validation.
12. Decide explicitly whether Command Code joins disposable `all`; do not inherit membership automatically.
13. Remove the “Internal-API-only” capability marker and bump the contract/protocol as required.

## 15. Documentation deliverables

The implementation PR/commits should update at least:

- `docs/INTERNAL-API-CONTRACT.md`;
- `docs/INTERNAL-API.md`;
- `docs/INTERNAL-API-ORCHESTRATION.md`;
- `docs/LIVE-VALIDATION.md`;
- `docs/OBSERVABILITY.md`;
- `docs/TROUBLESHOOTING.md`;
- `docs/ADDING-A-RUNTIME.md` with the staged Internal-API-only pattern if it proves reusable;
- `.env.example` and `DEPLOYMENT.md` for non-secret feature/config controls;
- Agent OS `docs/execution/STEP-7F-TASK-BRIEF.md` and any current model-routing/validation reference whose contract actually changes.

Do not claim Command Code as a fifth browser runtime in `README.md` or architecture overviews until the browser promotion is complete.

## 16. Definition of done

The adaptation is complete only when:

1. Pi Web UI exposes `commandcode` through the standard authenticated Internal API lifecycle with a documented additive contract version.
2. Only the two exact model ids are accepted and freshly proven; aliases and fallbacks fail closed.
3. Sessions resume only by stored exact native id; `--continue` is absent.
4. NDJSON events are incrementally parsed, meaningfully normalized, deduplicated, bounded, and reconciled into exactly one terminal receipt/`agent_end`.
5. Abort, delete, timeout, shutdown, and restart paths preserve truthful evidence and leave no owned process/admission leak.
6. Root and child permission profiles are server-owned; roots cannot mutate and children may use wide permissions only inside isolated leased worktrees.
7. The standard session, prompt, run, evidence, transcript, abort, and delete endpoints work in disposable live validation for both models.
8. Agent OS can execute a genuine P1 root→first-class child→handback→wake→disposition chain for each shadow route with zero root-authored product mutation.
9. Shadow scores are frozen under the same rubric but are mechanically excluded from the Sol/K3 Step 7G verdict.
10. RED→GREEN evidence, deterministic test suites, repository quality checks, disposable live reports, and negative controls all pass.
11. No secrets, credentials, native transcripts, or session artifacts are committed.
12. Pi Web UI and Agent OS changes are committed and pushed separately with cross-referenced commit hashes after validation.

## 17. Stop conditions

Stop and escalate rather than weakening the plan if any of these occur:

- either exact model disappears or resolves ambiguously;
- Command Code's documented headless contract no longer matches observed frames;
- auth would require Pi Web UI to ingest credentials;
- exact resume cannot be proven;
- process-group/cgroup cessation cannot be proven;
- standard Internal API receipts/evidence cannot represent truthful terminality;
- P1 cannot distinguish root from child mutation/session/receipt evidence;
- a shadow route requires direct root implementation to complete;
- fair frozen mission/envelope/scoring treatment cannot be maintained;
- implementation would require premature shared/browser `SdkType` expansion;
- quality or secret-scanning gates fail.

A stopped/non-scoreable shadow route is valid evidence. Silent substitution, direct implementation, invented terminality, or changing the Step 7G authority boundary is not.
