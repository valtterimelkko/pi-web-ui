# Whole-Codebase Hardening and Efficiency Implementation Plan

**Status:** implemented and archived. The scoped hardening work was completed
and independently reviewed; see [`CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md`](./CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md)
(Phase J) for authoritative evidence and current operator consequences. The
future-tense checklist below is retained as planning history, not an outstanding
implementation request.

> Current validation safety is defined by [`../LIVE-VALIDATION.md`](../LIVE-VALIDATION.md)
> and [`../LONG-HORIZON-VALIDATION.md`](../LONG-HORIZON-VALIDATION.md). Use
> explicit disposable socket/token paths; do not copy historical no-argument
> validation commands from this plan, and use `--allow-production` only after
> explicit authorisation.

**Plan baseline:** `5e3fa6dfecce3be945861f7544c98b0eb730f723` (`5e3fa6d`) on 2026-07-17

**Review inputs:** the 707 tracked files at the baseline, the untracked local review ledger, and the two latest commits

**Latest commits reconciled:** `ff2fc4a feat: harden lightweight observability`; `5e3fa6d test: await notification shutdown cleanup`

## 1. Objective

Implement the still-valid findings from the whole-codebase review without changing the visible UI, removing functionality, weakening security, changing supported protocol semantics, or degrading backend, frontend, Internal API, mobile, or laptop performance.

This is a local-first, self-hosted, primarily single-operator application. The plan deliberately avoids enterprise infrastructure such as Redis, external queues, distributed tracing, a new database, or multi-tenant policy machinery. Prefer small in-process fixes, bounded collections, atomic local files, lifecycle cleanup, and existing project abstractions.

The plan is complete only when **every in-scope task below has objective evidence** and every final gate passes. Compilation, a subset of tests, an assertion that a change is “safe”, or a report that most tasks are done is not completion.

## 2. Non-goals and invariants

The implementation must preserve all of the following:

- The current browser appearance and responsive behaviour.
- The browser WebSocket and Internal API contracts, except for additive validation detail where existing clients remain compatible.
- Cross-runtime session creation, replay, prompt, transfer, pinning, Drive Mode, notifications, and live validation.
- The local Unix-socket + bearer-token Internal API security model.
- Existing auth, origin, CSRF, prompt-injection, path-validation, and rate-limit protections.
- Browser reconnect behaviour completed in `ff2fc4a`.
- The lightweight observability architecture completed in `ff2fc4a`.
- Notification shutdown cleanup completed in `5e3fa6d`.
- The ability for sessions to continue while a browser is disconnected.
- Existing persisted data formats unless a backwards-compatible migration and rollback test is supplied.

Do **not** use this plan as permission for:

- blanket `React.memo`, `useMemo`, or `useCallback` additions;
- blanket parallelisation or concurrency increases;
- a rewrite of `sessionStore`, WebSocket routing, runtime adapters, or persistence;
- a streaming rewrite where bounded reads are already sufficient;
- speculative retention caps without measured evidence;
- lowering security checks, coverage thresholds, or test expectations merely to make a command pass;
- cosmetic UI or formatting changes unrelated to an in-scope task.

## 3. Reconciliation with the two latest commits

The table accounts for all 28 findings in the review ledger. “Narrowed” means the completed part is explicitly excluded and only the stated residue remains.

| Review item | Disposition at `5e3fa6d` | Plan task |
|---|---|---|
| 1. Worktree REST auth and shell interpolation | Still open | `S1` |
| 2. WebSocket upgrade guards on every path | Still open; browser reconnect work does not fix server upgrade bypasses | `S2` |
| 3. Internal API runtime/batch validation | Still open | `S3` |
| 4. Alternate prompt/path/rate-limit protections | Still open | `S4` |
| 5. Vulnerable bcrypt dependency chain | Still open; audit still reports 2 high vulnerabilities | `S5` |
| 6. WebSocket timers and disconnected Pi handlers | Still open | `L1` |
| 7. Worker pool terminated entries and spawn metadata | **Narrowed:** real spawn metadata was added in `ff2fc4a`; only capacity release, idempotent cleanup, and timer ownership remain | `L2` |
| 8. Session worker/RPC retention | Still open | `L3` |
| 9. Whole-store Zustand subscriptions | Still open | `F1` |
| 10. Incomplete message memo comparators | Still open | `F2` |
| 11. Long-horizon atomic persistence | Still open | `P1` |
| 12. Notification persistence/lifecycle races | **Narrowed:** ingress reservation, opt-in rollback, reconciliation, retry metrics, browser opt-out rollback, and shutdown-await coverage were completed by the two commits. Only terminal transition rollback/coherence on persistence failure remains | `P2` |
| 13. Claude process-pool timer/subscriber lifecycle | Still open | `L4` |
| 14. App-level listener cleanup | Still open | `L5` |
| 15. Antigravity retry timers after abort | Still open | `L6` |
| 16. Pi model-cache truthiness/concurrency | Still open | `R1` |
| 17. Terminal listener accumulation | Still open | `L7` |
| 18. File-read buffer allocation | Still open | `P3` |
| 19. OpenCode parser/dedup duplication | Still open | `R2` |
| 20. Per-key write-chain maps | **Narrowed:** do not alter the notification store’s fixed three-file write-chain map. Session-keyed run-receipt/watch chains remain in scope | `P4` |
| 21. Antigravity JSONL append/chmod path | Still open | `P5` |
| 22. Duplicate client persistence paths | Still open; the new diagnostics path is not a substitute | `F3` |
| 23. Synchronous validation-script scanner | Still open | `T1` |
| 24. ESLint wildcard configuration/warning signal | Still open | `Q1` |
| 25. Duplicate CSS rules | Still open | `Q2` |
| 26. Small component cleanup | Still open | `Q3` |
| 27. Test/coverage configuration | Still open | `Q4` |
| 28. Claude channel per-event logs/history retention | Still measure-first. Gate noisy logs, collect bounded local evidence, and do not cap history without proof | `M1` |

### Explicitly excluded completed work

Do not reimplement or redesign any of these `ff2fc4a`/`5e3fa6d` outcomes:

- browser diagnostic bundles, React error-boundary export, or protocol-drift diagnostics;
- intentional-disconnect vs abnormal WebSocket reconnect semantics;
- diagnostic redaction, correlation, operational metrics, or runtime-health matrices;
- notification ingress reservations, canonical manager state, opt-in/opt-out rollback already covered by tests, retry observability, capture-channel isolation, or shutdown awaiting;
- worker spawn timestamps and the observability added around worker/session anomalies;
- live-validation absolute deadlines, proxy evidence hardening, or failure-verdict changes;
- adapter-drop observability or logger namespace work.

If an implementation task collides with those areas, preserve the completed behaviour and extend the existing test rather than replacing the design.

## 4. Mandatory execution protocol

### 4.1 Baseline and working-tree isolation

Before changing production code:

```bash
git status --short
git log -3 --oneline --decorate
git rev-parse HEAD
npm run docs:check-agent-guides
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Record command, exit code, test counts, warning count, audit counts, and Vite bundle sizes in a new execution report:

`docs/plans/CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md`

At this plan’s baseline the expected facts are:

- HEAD is `5e3fa6d` unless later legitimate commits have landed; if it differs, revalidate every task against the new source before coding.
- `npm run docs:check-agent-guides`, typecheck, tests, and build pass.
- Lint passes but emits 1,144 warnings; this is a baseline to ratchet down, not an acceptable target to increase.
- Server + client tests total 3,101 at the review baseline.
- `npm audit --omit=dev` reports 2 high vulnerabilities through `bcrypt@5.1.1 -> @mapbox/node-pre-gyp -> tar@6.2.1`.
- The reviewed Vite build emitted a 745.84 kB initial JS asset, 207.20 kB gzip, and warned that `client/src/lib/api.ts` is both statically and dynamically imported.
- `.code-review-ledger.md` is a pre-existing untracked local file. Do not edit, delete, stage, or commit it.

A changed baseline is not automatically a failure. It requires a written reconciliation showing which tasks became obsolete, conflicted, or changed shape. Never fake RED evidence for behaviour that a newer commit already fixed.

### 4.2 RED → GREEN → REFACTOR is required

For every behaviour-changing task, execute one small behaviour at a time:

1. Add the smallest regression test that expresses the required behaviour through a public boundary or the narrowest legitimate test seam.
2. Run that exact test and capture the expected assertion failure **before any production-file edit for that behaviour**.
3. Confirm it failed because the defect exists, not because of a syntax/setup error.
4. Implement the minimum production change.
5. Run the same test and capture PASS without weakening or deleting its assertion.
6. Run the entire affected test file and adjacent subsystem tests.
7. Refactor only while tests remain green, then start a new RED cycle for the next behaviour.

No production code may precede its failing test. If exploratory code is needed, discard it before starting the recorded TDD cycle. The execution report must capture the focused RED command/output while the diff contains only the test/report change; a later recollection that “the test was red” is not evidence.

Use the correct test-first pattern for the kind of work:

- **Defect or changed boundary:** add a regression test that fails on the current defect and passes with the fix.
- **Semantics-preserving refactor:** first add/confirm a passing characterisation test for behaviour that must not change, then add a focused failing assertion for the actual defect being removed (for example duplicate invocation, leaked timer, unbounded cardinality, or redundant allocation). Do not manufacture RED by temporarily breaking production code.
- **Performance work:** RED must be a deterministic count/bound/lifecycle assertion; wall-clock benchmarks are supporting evidence only.
- **Configuration/tooling work:** a command-level RED state is acceptable, but capture the exact failing command and prove GREEN does not come from excluding files, lowering thresholds, or disabling a rule.
- **Already-fixed work on a newer baseline:** mark it `not applicable` with source and existing-test evidence. Do not invent a failing test or reimplement it.

Tests must assert externally meaningful results and side-effect absence, not merely that a mock was called. Mocks/fake timers are acceptable at process, clock, provider, and filesystem boundaries when real dependencies would make the test unsafe or nondeterministic. A test may be corrected after RED only for a demonstrated test defect; the report must explain the correction. Never change expected behaviour merely to match the implementation.

### 4.3 Per-task definition of done

A task is not complete unless its report row contains all of these:

- source baseline/commit;
- files changed;
- RED test name, command, expected failure, and captured exit code;
- GREEN command and captured exit code;
- adjacent regression commands and results;
- security/adversarial cases where applicable;
- lifecycle/cardinality evidence where applicable;
- before/after performance or allocation evidence where applicable;
- compatibility and rollback note;
- documentation changed or an explicit “no documentation change” justification;
- `git diff --check` result;
- commit hash containing only that task or a clearly declared tightly coupled task group.

“Covered by existing tests”, “looks correct”, “typecheck passes”, “no UI changes intended”, and “should not regress” are not evidence.

### 4.4 Commit discipline

- Implement phases in order. Security tasks may be split into one commit each.
- Do not mix unrelated cleanup into security, lifecycle, runtime, or persistence commits.
- Before every commit run:

```bash
git status --short
git diff --stat
git diff --check
git diff --cached --stat
git diff --cached
```

- Explicitly inspect staged files for secrets, tokens, cookies, auth dumps, session JSONL, validation state, screenshots containing private data, and local-machine paths.
- A phase may not be marked complete while it has failing or skipped required gates.

## 5. Phase A — boundary and dependency hardening (Priority 0)

These tasks are first because they protect privileged local operations and public-facing upgrade routes.

### S1. Protect worktree routes and eliminate shell interpolation

**Affected areas**

- `server/src/routes/worktrees.ts`
- `server/src/pi/parallel/worktree-manager.ts`
- `server/src/pi/parallel/plan-parser.ts`
- `server/src/app.ts`
- `server/tests/unit/pi/parallel/worktree-manager.test.ts`
- add/extend route tests for worktree authentication and path validation
- `SECURITY.md` only if the documented boundary changes

**Required changes**

- Apply `cookieAuthMiddleware` to the entire browser REST router.
- Validate request, query, and parameter shapes with strict bounded schemas.
- Validate `repoPath` and `planPath` before filesystem access. Resolve canonical paths and reject unsafe/non-repository inputs; do not rely on a TypeScript type or Git’s eventual error.
- Replace shell-command construction with `execFile`/`spawn` argument arrays and explicit `cwd`.
- Treat branch names, task IDs, worktree IDs, merge messages, and paths as data. Use `--` where supported and reject values that cannot be represented safely.
- Preserve response shapes and supported merge/sync/create/orchestrate behaviour.

**RED tests**

- Every route rejects a request without the auth cookie.
- A valid authenticated request still reaches its handler.
- Inputs containing shell metacharacters, command substitution, leading flags, newlines, and spaces do not execute a marker command and are either safely passed as one argument or rejected.
- Relative traversal and symlink inputs are canonicalised before read/exec and cannot escape whatever root policy the route explicitly adopts. Do not invent a narrower root policy that breaks the current ability to manage an operator-selected local repository; safely resolved valid repositories must remain supported.
- Valid repository paths and branch names continue to work in a temporary Git repository.

**Focused gates**

```bash
npm test --workspace=server -- server/tests/unit/pi/parallel/worktree-manager.test.ts
npm test --workspace=server -- server/tests/unit/routes/worktrees.test.ts
npm test --workspace=server -- server/tests/unit/routes
```

If the route test file is named differently during implementation, record the actual path. The marker file used by the injection test must not exist after the test.

**Rollback/compatibility**

Rollback is the single S1 commit. Do not restore shell interpolation to recover a corner case; add an explicit argument-safe path. Existing unauthenticated callers are intentionally rejected because browser worktree operations are privileged.

### S2. Apply one WebSocket upgrade guard to all upgrade paths

**Affected areas**

- `server/src/index.ts`
- `server/src/websocket/connection.ts`
- `server/src/websocket/session-websocket.ts`
- `server/src/terminal/terminal-websocket.ts`
- `server/src/security/rate-limit.ts`
- `server/tests/unit/websocket/connection.test.ts`
- `server/tests/unit/websocket/session-websocket.test.ts`
- `server/tests/unit/routes/terminal.test.ts`
- `docs/PROTOCOL.md`, `SECURITY.md`

**Required changes**

- Ensure `/ws`, both accepted session spellings if both remain supported, and `/ws/terminal` all pass through the same pre-upgrade origin, cookie-authentication, and upgrade-rate-limit decision.
- Perform checks before `WebSocketServer.handleUpgrade`; rejected sockets must not emit `connection` or create session/terminal resources.
- Preserve the post-upgrade CSRF handshake for the browser protocol. Do not confuse cookie authentication at upgrade with CSRF authentication after connection.
- Preserve supported paths and error/close behaviour; centralise only the guard, not the runtime routers.

**RED adversarial tests**

For every accepted path, assert all three rejection classes independently:

1. missing/invalid cookie;
2. absent or disallowed `Origin`;
3. rate limit exceeded.

Also assert valid auth + allowed origin upgrades exactly once, unknown paths are destroyed, URL-encoded path tricks cannot bypass matching, and rejected terminal/session upgrades allocate no manager/session resources.

**Focused gates**

```bash
npm test --workspace=server -- server/tests/unit/websocket/connection.test.ts
npm test --workspace=server -- server/tests/unit/websocket/session-websocket.test.ts
npm test --workspace=server -- server/tests/unit/routes/terminal.test.ts
npm test --workspace=server -- server/tests/unit/websocket
```

Run browser-WebSocket validation against a disposable server, never production:

```bash
node scripts/ws-validate.mjs --base http://localhost:<validation-port> \
  --origin <allowed-origin> --password <validation-password> \
  --session '<validation-session-path>' --step prompt --text 'Reply with one word.'
```

Capture one successful valid-path verdict plus rejected-cookie and rejected-origin evidence from an automated test. Do not print or commit the cookie/hash.

### S3. Strictly validate Internal API session and batch inputs; bound fan-out

**Affected areas**

- `server/src/internal-api/routes/sessions.ts`
- `server/src/internal-api/routes/batch-helpers.ts`
- `server/src/internal-api/types.ts`
- `server/src/internal-api/request-body.ts`
- relevant `server/tests/unit/internal-api/session-routes-*.test.ts`
- `docs/INTERNAL-API.md`, `docs/INTERNAL-API-CONTRACT.md`, `docs/INTERNAL-API-ORCHESTRATION.md`

**Required changes**

- Parse create-session, batch-create, and batch-prompt bodies at runtime with Zod or an equivalent strict schema.
- Accept only the four documented runtimes. Remove the fallback that turns an unknown runtime into Pi.
- Validate runtime-specific model/thinking/cwd/pin fields, non-empty arrays, item counts, string lengths, boolean fields, and per-entry shapes before any session is created or prompt dispatched.
- Preserve the current maximum of 50 items unless evidence supports a separately documented change.
- Replace unbounded `Promise.all` fan-out with an in-process concurrency limiter. Preserve result ordering and current partial-success response semantics. Select a conservative limit from existing worker/runtime capacity rather than creating a new service.
- Reject malformed input atomically before side effects. A valid item in a structurally invalid batch must not run.

**RED tests**

- Unknown, case-mangled, null, numeric, and missing runtime values produce `400 INVALID_REQUEST` and create zero Pi sessions.
- Empty, over-50, malformed, and mixed-invalid batches produce `400` before dispatch.
- At most the configured concurrency limit is active under a 50-item synthetic batch.
- Results remain in request order even when completion order differs.
- Valid single and batch calls preserve response fields, pins, model/thinking selection, and partial runtime-unavailable reporting.

**Focused gates**

```bash
npm test --workspace=server -- server/tests/unit/internal-api/session-routes-orchestration.test.ts
npm test --workspace=server -- server/tests/unit/internal-api/session-routes-live-validation.test.ts
npm test --workspace=server -- server/tests/unit/internal-api/request-body.test.ts
npm test --workspace=server -- server/tests/unit/internal-api
```

Live validate on a disposable server:

```bash
npm run validate:server -- --dir <short-temp-dir> --port 0
# The final bounded smoke matrix in section 11.5 supplies the valid create/turn check.
# Add one fast live malformed-input request against the same disposable socket:
TOKEN="$(cat <token>)"
curl --silent --show-error --unix-socket <sock> \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST http://localhost/api/v1/sessions -d '{"runtime":"not-a-runtime"}'
```

The malformed request must return `400` with `INVALID_REQUEST` and create no session. Do not print or persist the token. A capability skip is evidence only for an unsupported runtime scenario, not for malformed-input or bounded-concurrency tests.

### S4. Unify protection for all prompt-like browser paths

**Affected areas**

- `server/src/websocket/connection.ts`
- `server/src/routes/sessions.ts`
- `server/src/routes/files.ts`
- `server/src/security/prompt-injection.ts`
- `server/src/security/rate-limit.ts`
- WebSocket/session route tests and shared protocol tests
- `SECURITY.md`, `docs/PROTOCOL.md` if behaviour documentation changes

**Required changes**

Inventory every path that forwards user-controlled text or media to a runtime: prompt, follow-up, steer, transfer/handoff injection, image-bearing prompt, and alternate REST/browser paths. Route them through one explicit protection sequence:

1. authenticated and CSRF-valid where applicable;
2. bounded request/message and image payload;
3. prompt-injection detection on every user-controlled text field that reaches a runtime;
4. per-client/session rate-limit accounting;
5. validated/canonical file references before file access.

Do not scan internal runtime-generated events as if they were user prompts. Preserve existing error codes and current successful flows.

**RED adversarial tests**

- The same malicious fixture is rejected on prompt, follow-up, steer, transfer/handoff, and image-caption/alternate paths.
- A bypass split across alternate message fields is rejected if those fields are concatenated/forwarded.
- Rate limits cannot be bypassed by alternating equivalent prompt message types.
- Oversized text/image collections and invalid file paths fail before runtime invocation.
- Benign code/security discussion fixtures remain accepted to guard false positives.
- All four runtimes use the same boundary checks before their adapter is called.

**Focused gates**

```bash
npm test --workspace=server -- server/tests/unit/websocket/connection.test.ts
npm test --workspace=server -- server/tests/unit/websocket/session-transfer-routing.test.ts
npm test --workspace=server -- server/tests/unit/routes/sessions.test.ts
npm test --workspace=server -- server/tests/unit/routes/files-crud.test.ts
npm test --workspace=server -- server/tests/unit/websocket
```

### S5. Remove the vulnerable bcrypt dependency chain without weakening auth

**Affected areas**

- `server/package.json`
- `package-lock.json`
- `server/src/routes/auth.ts`
- auth/config tests and deployment documentation if compatibility changes

**Required changes**

- Upgrade bcrypt in an isolated commit, preferably to the current compatible v6 line, and verify Node `>=22.19.0` installation/build support.
- Preserve verification of existing bcrypt hashes. Do not silently migrate to plaintext, reduce work factors, or accept malformed hashes.
- Preserve production rejection of plaintext `AUTH_PASSWORD` and development-only behaviour exactly as documented.
- Do not run a blind `npm audit fix` that changes unrelated runtime packages.

**RED/compatibility tests**

- Add/confirm fixtures for an existing bcrypt 5-generated `$2b$` hash, wrong password, malformed hash, missing config, and production plaintext rejection.
- Demonstrate the dependency audit failure before the package change and success after it.

**Focused gates**

```bash
npm test --workspace=server -- server/tests/unit/routes/auth.test.ts
npm test --workspace=server -- server/tests/unit/routes
npm run build --workspace=server
npm audit --omit=dev
npm ls bcrypt @mapbox/node-pre-gyp tar
```

**Expected outcome:** zero high/critical production vulnerabilities, no `@mapbox/node-pre-gyp`/vulnerable `tar@6.2.1` path through bcrypt, and all existing hashes still authenticate.

## 6. Phase B — lifecycle, timer, and retention correctness (Priority 1)

### L1. Own and clear WebSocket status timers; remove disconnected Pi handlers

**Affected areas:** `server/src/websocket/connection.ts`, `server/src/pi/pi-service.ts`, `server/src/pi/session-broadcaster.ts`, and related tests.

- Store the status-broadcast interval handle; expose an idempotent manager shutdown/dispose path; clear it during server shutdown and in tests.
- Remove each client’s Pi event handler on disconnect/error exactly once.
- Ensure reconnect creates one handler and one status loop, not duplicates.
- Preserve background session execution and replay after browser disconnect.

**Required tests/evidence**

- Fake-timer test: construct/start/dispose repeatedly; timer count returns to baseline.
- Disconnect test: handler cardinality returns to zero while session state survives.
- Double close/error/dispose is harmless.
- Status broadcasts stop after dispose and do not duplicate after reinitialisation.

```bash
npm test --workspace=server -- server/tests/unit/websocket/connection.test.ts
npm test --workspace=server -- server/tests/unit/pi-service.test.ts
npm test --workspace=server -- server/tests/unit/websocket
```

### L2. Release worker capacity and make worker-pool cleanup idempotent

**Affected areas:** `server/src/workers/worker-pool.ts`, `server/src/workers/session-worker.ts`, `server/src/observability/operational-metrics.ts` only if existing counters need preserved wiring, and worker tests.

- Delete or replace terminated workers so they do not occupy `PI_MAX_WORKERS` capacity.
- Keep the real spawn timestamps added by `ff2fc4a`; do not reintroduce fabricated metadata.
- Ensure termination, exit, crash, explicit delete, idle sweep, and pool shutdown converge on one idempotent cleanup path.
- Own and clear the pool cleanup interval.

**Required tests/evidence**

- With max workers = 1: terminate worker A, then worker B can spawn.
- Repeated terminate/exit/delete changes capacity only once.
- Spawn metadata remains the original timestamp.
- Churn at least 100 synthetic workers; live map size, listener count, and timer count return to baseline.
- Existing crash/anomaly metrics still increment once, not twice.

```bash
npm test --workspace=server -- server/tests/unit/workers/worker-pool.test.ts
npm test --workspace=server -- server/tests/unit/workers/session-worker.test.ts
npm test --workspace=server -- server/tests/unit/workers
```

### L3. Bound session-worker buffers and clear RPC pending state

**Affected areas:** `server/src/workers/session-worker.ts`, `server/src/workers/session-rpc-client.ts`, worker/RPC tests.

- Bound incomplete stdout/stderr framing buffers by bytes and define deterministic overflow handling without emitting partial forged protocol messages.
- Remove pending RPC entries and all timeout handles on resolve, reject, timeout, worker exit, and shutdown.
- Reject outstanding calls once on process death; late replies must not resurrect entries.
- Preserve valid fragmented and multibyte UTF-8 JSON-RPC framing.

**Required tests/evidence**

- Fragmented valid message across chunks succeeds.
- Unterminated oversized output is bounded and yields one controlled error.
- Timeout/process-exit race settles once and leaves pending count/timers at zero.
- 1,000 request/resolve and timeout cycles show no growth in pending-map cardinality or active timers.

```bash
npm test --workspace=server -- server/tests/unit/workers/session-worker.test.ts
npm test --workspace=server -- server/tests/unit/workers/session-rpc-client.test.ts
npm test --workspace=server -- server/tests/unit/workers
```

### L4. Make Claude process-pool timers and subscribers disposable

**Affected areas:** `server/src/claude/claude-process-pool.ts`, `server/src/claude/claude-service.ts`, relevant Claude subscriber/pool tests.

- Track and clear retry, timeout, idle, and health handles at terminal states and shutdown.
- Remove subscriber sets when the last subscriber leaves and the session is no longer active/pinned.
- Ensure abort/exit races settle once and do not schedule a later retry.
- Preserve direct, SDK, and channel backend selection and replay.

**Required tests/evidence**

- Repeated subscribe/unsubscribe and process churn returns maps/listeners/timers to baseline.
- Abort immediately before retry fires prevents respawn.
- A pinned or running session is not prematurely removed.
- Follow-up and replay tests remain green for all Claude backends.

```bash
npm test --workspace=server -- server/tests/unit/claude/claude-process-pool.test.ts
npm test --workspace=server -- server/tests/unit/claude/claude-process-pool-resilience.test.ts
npm test --workspace=server -- server/tests/unit/claude/claude-session-subscribers.test.ts
npm test --workspace=server -- server/tests/unit/claude
```

### L5. Unregister app-level watchers/listeners on shutdown

**Affected areas:** `server/src/index.ts`, session watcher/registry wiring, shutdown tests.

- Give every process-level/session-watcher callback an owner and symmetric cleanup.
- Preserve fatal-error handlers’ “register exactly once” design from the observability work.
- Ensure repeated initialisation in tests does not multiply listeners.

**Required tests/evidence:** start/stop twice, listener counts return to baseline, no post-shutdown broadcast, fatal handlers still register once.

```bash
npm test --workspace=server -- server/tests/unit/internal-api/server-shutdown.test.ts
npm test --workspace=server -- server/tests/unit/pi/session-watcher.test.ts
npm test --workspace=server -- server/tests/integration/process-isolation.test.ts
```

### L6. Cancel Antigravity retry waits on abort

**Affected areas:** `server/src/antigravity/antigravity-service.ts`, tests under `server/tests/unit/antigravity/`.

- Associate retry delays with the active turn’s abort signal/generation.
- Abort cancels pending delay and prevents a later subprocess spawn.
- A new turn must not inherit the old turn’s cancellation state.

**Required tests/evidence:** fake-timer abort-before-retry, abort/spawn race, new-turn recovery, zero timers after completion.

```bash
npm test --workspace=server -- server/tests/unit/antigravity/antigravity-service.test.ts
npm test --workspace=server -- server/tests/unit/antigravity
```

Disposable validation mode intentionally disables Antigravity because `agy` cannot isolate its real conversation store. Do not target production. Record unit/integration evidence and this limitation; perform a live Antigravity check only with explicit user permission for that non-isolated store.

### L7. Prevent terminal listener accumulation

**Affected areas:** `server/src/terminal/terminal-manager.ts`, `server/src/terminal/terminal-websocket.ts`, terminal tests.

- Attach one data/exit listener per terminal owner or remove previous listeners before replacement.
- Clear idle timers and WebSocket references on close, exit, and manager shutdown.
- Preserve terminal output ordering and reconnect behaviour.

**Required tests/evidence:** 100 connect/disconnect cycles, stable listener count, one output delivery per chunk, no idle timer after exit.

```bash
npm test --workspace=server -- server/tests/unit/terminal/terminal-manager.test.ts
npm test --workspace=server -- server/tests/unit/routes/terminal.test.ts
```

## 7. Phase C — runtime hot paths and durable local persistence (Priority 1)

### R1. Make Pi model-cache loading concurrency-safe

**Affected areas:** `server/src/pi/pi-service.ts`, `server/tests/unit/pi-service-model.test.ts`, `server/tests/unit/pi-service.test.ts`.

- Distinguish “not loaded” from a valid empty catalogue; do not use truthiness as cache state.
- Coalesce concurrent first loads into one promise.
- Clear the in-flight promise after success/failure; define whether a failure is retryable and test it.
- Preserve model ordering, default selection, OpenRouter refresh integration, and no-provider behaviour.

**Tests:** empty-cache reuse, 50 concurrent callers invoke loader once, failure then retry, refresh invalidation.

```bash
npm test --workspace=server -- server/tests/unit/pi-service-model.test.ts
npm test --workspace=server -- server/tests/unit/pi-service.test.ts
```

### R2. Remove duplicate OpenCode event parsing/dedup work

**Affected areas:** `server/src/opencode/opencode-event-adapter.ts`, `server/src/opencode/opencode-history-replay.ts`, `server/src/opencode/opencode-service.ts`, OpenCode adapter/replay tests.

- Identify one owner for event identity and deduplication.
- Avoid parsing/normalising the same payload multiple times on the hot path.
- Keep the bounded drop/anomaly metrics added in `ff2fc4a`.
- Preserve event order, replay/live overlap handling, tool phases, message deltas, and permission events.

**Tests/evidence:** replay/live duplicate emitted once, distinct same-text events retained, out-of-order/tool events preserved, parser invocation count reduced in a synthetic stream, no increase in adapter-drop count.

```bash
npm test --workspace=server -- server/tests/unit/opencode/opencode-event-adapter.test.ts
npm test --workspace=server -- server/tests/unit/opencode/opencode-history-replay.test.ts
npm test --workspace=server -- server/tests/unit/opencode/opencode-service.test.ts
npm test --workspace=server -- server/tests/unit/opencode
```

### P1. Make long-horizon runner state writes atomic and serialised

**Affected areas:** `server/src/live-validation/long-horizon-runner.ts`, `scripts/long-horizon-validate.ts`, long-horizon tests, `docs/LONG-HORIZON-VALIDATION.md`.

- Write to an owner-only temporary file in the same directory, fsync/close as appropriate, then rename.
- Serialise writes for one state path so older state cannot overwrite newer state.
- Clean temporary files after failure when safe.
- Preserve the existing state schema and ability to resume old state files.

**RED tests**

- Simulated mid-write failure leaves the previous valid JSON readable.
- Concurrent slow/fast writes end with the newest state.
- File mode remains private.
- Existing state created before the change resumes unchanged.

```bash
npm test --workspace=server -- server/tests/unit/live-validation/long-horizon-runner.test.ts
npm test --workspace=server -- server/tests/unit/live-validation
```

Run a disposable `start` → `once` resume check with a short deterministic condition; never use the production socket.

### P2. Roll back in-memory notification terminal transitions when persistence fails

**Affected areas:** `server/src/notifications/notification-store.ts`, `server/src/notifications/notification-manager.ts` only if caller semantics require it, notification store/lifecycle tests.

This task is intentionally narrow. Do not redo the notification architecture from `ff2fc4a`.

- On `markSent` and terminal `recordFailure`, if the terminal-log write fails, restore the prior in-memory outbox/log state so the item remains retryable and `getById` does not falsely report a durable terminal state.
- If the terminal log succeeds but outbox cleanup fails, preserve the documented “terminal wins on restart” reconciliation.
- Keep per-file write ordering and idempotency.

**RED tests**

- Inject failure before terminal-log persistence: in-memory and reloaded state remain pending.
- Inject failure after terminal log but before outbox write: restart reconciles to exactly one terminal record.
- Concurrent status lookup never sees an impossible duplicate/vanished item.
- Existing ingress reservation, opt-in rollback, retry, and shutdown tests remain unchanged and green.

```bash
npm test --workspace=server -- server/tests/unit/notifications/notification-store.test.ts
npm test --workspace=server -- server/tests/unit/notifications/notification-manager.test.ts
npm test --workspace=server -- server/tests/integration/notifications-lifecycle.test.ts
```

### P3. Allocate file-read buffers to actual bounded size

**Affected areas:** `server/src/routes/files.ts`, `server/tests/unit/routes/files-crud.test.ts`.

- Allocate/read `min(actual size, configured limit plus only the byte needed to determine truncation)` rather than the full maximum for tiny files.
- Preserve UTF-8 boundary handling, `truncated`, read-only behaviour for truncated files, path validation, and response shape.
- Do not stream/rewrite the endpoint unless measurement proves necessary.

**Tests/evidence:** tiny/empty/exact-limit/over-limit/multibyte-boundary files, bounded allocation spy or injected reader, no extra full-file read.

```bash
npm test --workspace=server -- server/tests/unit/routes/files-crud.test.ts
```

### P4. Remove settled session-keyed write chains

**Affected areas:** `server/src/internal-api/run-receipts/run-receipt-store.ts`, `server/src/internal-api/watch/watch-store.ts`, corresponding tests.

- Delete a settled map entry in `finally` only if it still points to that exact chain promise.
- Preserve serial ordering after a failed write and while a newer write is queued.
- Do not modify `NotificationStore.writeChains`; it has only three bounded filename keys after the latest commits.

**Tests/evidence:** 1,000 unique session keys settle to map size zero; two writes for one key remain ordered; first-write rejection does not poison the second; no unhandled rejection.

```bash
npm test --workspace=server -- server/tests/unit/internal-api/run-receipt-store.test.ts
npm test --workspace=server -- server/tests/unit/internal-api/watch-store.test.ts
```

### P5. Avoid repeated chmod on every Antigravity JSONL append

**Affected areas:** `server/src/antigravity/antigravity-session-store.ts`, its tests.

- Create/open the file with private mode and repair permissions only when creating or when an existing file is demonstrably wrong.
- Preserve append ordering and cross-call serialisation.
- Do not weaken `0600` file and `0700` directory requirements.

**Tests/evidence:** repeated append performs one create/permission setup, existing unsafe mode is repaired, concurrent appends remain valid ordered JSONL, restart/replay works.

```bash
npm test --workspace=server -- server/tests/unit/antigravity/antigravity-session-store.test.ts
npm test --workspace=server -- server/tests/unit/antigravity/antigravity-history-replay.test.ts
```

## 8. Phase D — frontend render and persistence efficiency (Priority 1)

No visible styling or interaction change is allowed in this phase. Follow the local `webapp-testing` workflow for browser validation.

### F1. Narrow Zustand subscriptions in high-frequency components

**Affected areas**

- `client/src/components/Chat/ChatView.tsx`
- `client/src/components/Chat/VirtualizedMessageList.tsx`
- `client/src/components/Sidebar/Sidebar.tsx`
- `client/src/components/Session/NewSessionModal.tsx`
- `client/src/components/Files/FilesTab.tsx`
- `client/src/components/Usage/TokenUsageDashboard.tsx`
- related component/store tests and benchmarks

**Required changes**

- Replace whole-store subscriptions with the smallest selectors needed by each component.
- Use stable shallow equality only where selector results are composite.
- Do not move actions/state or rewrite the store.
- Preserve streaming cadence, auto-scroll, modal state, file edits, token display, and sidebar status.

**RED tests/evidence**

- Instrument render counts: unrelated store updates do not rerender each target component.
- Relevant updates still rerender exactly as needed.
- Streaming message deltas remain visible and ordered.
- Before/after benchmark medians are captured on the same machine and process conditions.

```bash
npm test --workspace=client -- client/tests/unit/store/sessionStore.test.ts
npm test --workspace=client -- client/tests/unit/store/sessionStore-handlemessage.test.ts
npm test --workspace=client -- client/tests/unit/components/Chat/VirtualizedMessageList.test.tsx
npm run benchmark:quick
```

### F2. Complete memo comparator correctness before optimising rerenders

**Affected areas:** `client/src/components/Chat/MessageBubble.tsx`, `client/src/components/Tools/CollapsibleToolCard.tsx`, component tests.

- Enumerate every prop/context/store-derived value that affects rendered output or callbacks.
- Fix or remove custom comparators that can retain stale content, status, usage, tool result, expanded state, or callbacks.
- Prefer default React comparison over a fragile hand-maintained comparator when evidence does not show a benefit.

**RED tests:** change each render-affecting prop independently and assert DOM/callback updates; unchanged equivalent props do not rerender when memoisation remains.

```bash
npm test --workspace=client -- client/tests/unit/components/Chat/MessageBubble.test.tsx
npm test --workspace=client -- client/tests/unit/components/Tools/CollapsibleToolCard.test.tsx
npm test --workspace=client -- client/tests/unit/components/Chat
```

### F3. Establish one canonical client persistence path

**Affected areas:** `client/src/store/sessionStore.ts`, persisted settings/state helpers, store tests, `docs/SHARP-EDGES.md` if persistence semantics need clarification.

- Inventory Zustand `persist` writes and custom throttled/local-storage writes.
- Assign each persisted key one writer and one hydration owner.
- Preserve key names/data schema or provide a tested one-time migration.
- Preserve cross-tab synchronisation and the browser storage-failure diagnostics added in `ff2fc4a`.
- Coalesce writes without delaying state needed for safe reload beyond the current contract; flush on lifecycle boundaries where required.

**RED tests**

- One logical state change causes one canonical write.
- Hydration does not overwrite newer in-memory state.
- Cross-tab update still propagates once without a write loop.
- Quota/storage errors keep in-memory state and emit bounded diagnostics without chat/session content.
- Existing persisted data hydrates after the change.

```bash
npm test --workspace=client -- client/tests/unit/store/sessionStore.test.ts
npm test --workspace=client -- client/tests/unit/store/sessionStore-dual.test.ts
npm test --workspace=client -- client/tests/unit/store/sessionStore-handlemessage.test.ts
```

### Frontend phase performance/UX gate

Run the same benchmark command at least five times before and after this phase. Compare medians, not the best run. No named render/typing/session-switch metric may regress by more than 5%; any regression above normal noise blocks completion until explained and fixed. Bundle gzip size may not increase by more than 1% without a file-level explanation and explicit approval.

Run local browser checks at both laptop and mobile dimensions:

- 1366 × 768: session creation, switch, streaming response, sidebar, Files tab, notifications toggle.
- 390 × 844: the same reachable flows plus scrolling, input focus, and no horizontal overflow.

Then run:

```bash
npm run test:e2e -- --project=chromium tests/e2e/core.spec.ts tests/e2e/mobile.spec.ts \
  tests/e2e/session-persistence.spec.ts tests/e2e/cross-tab-state.spec.ts \
  tests/e2e/session-stress.spec.ts
npm run build --workspace=client
```

Capture screenshots only as local test artifacts; do not commit them unless the repository already expects that exact artifact.

## 9. Phase E — tooling, style deduplication, and test-signal quality (Priority 2)

### T1. Make the thinking-validation scanner asynchronous

**Affected areas:** `scripts/validate-thinking-e2e.ts` and a new/appropriate script test.

- Replace synchronous recursive file reads with bounded asynchronous traversal or targeted repository search.
- Avoid duplicate imports and unbounded parallel file opens.
- Preserve scanner findings, exclusions, exit codes, and human-readable output.

**Tests/evidence:** fixture tree parity test, unreadable file handling, bounded concurrency, event-loop heartbeat continues during a large synthetic scan.

```bash
npm test --workspace=server -- server/tests/unit/scripts/validate-thinking-e2e.test.ts
npx tsx scripts/validate-thinking-e2e.ts --help
```

Do not call live providers merely to test the scanner portion.

### Q1. Repair ESLint configuration and ratchet warning signal

**Affected areas:** `.eslintrc.json`, narrowly related files only.

- Replace ineffective wildcard override/exclusion patterns with valid ESLint configuration.
- Keep server `no-console` enforcement and observability logger usage.
- Do not disable rules globally to reduce the count.
- Record baseline warning categories; fix only warnings touched by this plan plus clear configuration defects.
- Final warning count must be no higher than the recorded baseline and no changed production file may introduce a new warning.

**Command-level RED/GREEN**

```bash
npx eslint --print-config server/src/index.ts > /tmp/server-eslint.json
npx eslint --print-config client/src/store/sessionStore.ts > /tmp/client-eslint.json
npm run lint
```

The report must show that intended overrides are present in printed config and that the previous wildcard problem is absent. A passing exit code with thousands of newly ignored files is a failure.

### Q2. Deduplicate exact CSS rules without visual change

**Affected area:** `client/src/index.css` and any tests specifically needed to prove the affected classes.

- Remove exact duplicate declarations/rules only after proving cascade/order equivalence.
- Do not redesign colours, spacing, typography, or breakpoints.
- For conflicting duplicates, choose the current effective declaration and preserve specificity/order.

**Evidence:** CSS duplicate scan before/after, computed-style assertions for affected selectors, laptop/mobile screenshots with no unexpected difference.

```bash
npm run build --workspace=client
npm run test:e2e -- --project=chromium tests/e2e/core.spec.ts tests/e2e/mobile.spec.ts
```

### Q3. Perform only evidence-backed small component cleanup

**Affected areas:** `client/src/components/Chat/CodeBlock.tsx`, `client/src/hooks/useCopyShortcut.ts`, and any exact dead code identified during revalidation.

- Remove confirmed duplicate copy-state/listener logic or dead imports; retain one tested owner.
- Do not create a new abstraction unless it removes real duplication across at least two current call sites without changing timing or accessibility.
- Preserve copy keyboard shortcut, feedback timing, cleanup on unmount, code rendering, and mobile behaviour.

```bash
npm test --workspace=client -- client/tests/unit/components/Chat/CodeBlock.test.tsx
npm run test:e2e -- --project=chromium tests/e2e/copy-message.spec.ts tests/e2e/copy-path.spec.ts
```

### Q4. Make test discovery and coverage truthful

**Affected areas:** `server/vitest.config.ts`, `client/vitest.config.ts`, coverage scripts/docs, and tests needed to meet retained thresholds.

- Define explicit production-source coverage include globs, not only test include globs and excludes.
- Prove both workspace suites are discovered and machine-readable reports remain generated.
- Do not lower thresholds merely because corrected instrumentation exposes previously unmeasured files. Add high-value tests or propose a separately reviewed truthful ratchet with exact baseline evidence.
- Ensure an intentionally failing temporary fixture makes the command fail; remove the fixture before commit.
- Keep log suppression opt-out via `VITEST_LOG=1` and preserve assertion output.

**Command-level RED/GREEN**

```bash
npm test --workspace=server
npm test --workspace=client
npm run test:coverage --workspace=server
npm run test:coverage --workspace=client
```

Inspect `server/test-results.json`, `client/test-results.json`, and coverage JSON for expected test/source files. These generated files must remain ignored and unstaged.

## 10. Phase F — measure-first Claude channel decision (Priority 2)

### M1. Gate noisy channel logs and measure replay depth before any retention change

**Affected areas:** `pi-claude-channel/server.ts`, channel tests/tooling, and `docs/CLAUDE-BACKENDS.md` or observability docs if operator controls change.

**Required now**

- Keep lifecycle/failure logs visible at appropriate levels.
- Make per-event payload/activity lines opt-in behind a debug control; never log prompts, tool payloads, tokens, cookies, or credentials.
- Use a bounded local measurement script/test to record history depth/bytes for representative short, long, reconnect, and compaction sessions.
- Measure handler latency with debug logging off and on.

**Decision gate**

- Do **not** add a replay-history cap in this plan unless evidence demonstrates material memory/latency growth and existing reconnect/replay semantics can be preserved.
- If no material problem is found, record “no retention change justified” and close M1 with the measurement evidence.
- If a cap is justified, stop and create a separate compatibility plan covering reconnect, pagination/resume, compaction, and old clients. Do not silently change retention semantics in this implementation series.

**Required tests/evidence:** debug-off suppresses event-granular lines; warnings/errors remain; redaction holds; reconnect receives the same history as before; measurement data contains no transcript content.

## 11. Phase and final quality gates

### 11.1 Gates after every phase

Run all of the following, not just focused tests:

```bash
npm run docs:check-agent-guides
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

Expected outcomes:

- every command exits 0;
- test count does not unexpectedly fall below the revalidated baseline; explain legitimate test consolidation by listing old/new test names;
- no unhandled rejection, open-handle warning, flaky retry, React act warning, or unexpected application error appears;
- lint warnings never increase and changed production files add none;
- Vite bundle-size comparison is recorded;
- generated JSON/coverage/build artifacts are not staged.

### 11.2 Security/adversarial suite gate

Before final completion, rerun together:

- unauthenticated and wrong-origin requests for every REST/WS route changed;
- shell metacharacter/leading-flag/path traversal/symlink cases for worktree and file paths;
- malformed/oversized/unknown-runtime Internal API bodies;
- prompt-injection and rate-limit bypass attempts across equivalent message types;
- production plaintext-password rejection and existing bcrypt-hash compatibility;
- diagnostics/log redaction tests from `ff2fc4a` to prove hardening did not leak new fields.

A test that only checks status code without proving the privileged operation was not invoked is insufficient.

### 11.3 Lifecycle/leak gate

Use deterministic fake timers and exposed test seams rather than relying only on `process._getActiveHandles()`. For every changed manager/store:

- run at least 100 create/close cycles (1,000 for cheap map/promise paths);
- assert timer, listener, subscriber, pending-request, worker, and write-chain cardinalities return to baseline;
- assert cleanup is idempotent under duplicate close/error/abort events;
- assert no late callback creates work after shutdown;
- run the relevant existing stress/process-isolation tests.

Any monotonically growing collection without a documented hard bound blocks completion.

### 11.4 Performance gate

Use the same machine, Node version, build mode, fixture, and background-load conditions for before/after measurements.

```bash
node --version
npm run benchmark:quick
npm run benchmark
npm run build --workspace=client
```

Requirements:

- compare at least five quick-benchmark runs by median;
- no named UI benchmark regression over 5% without rerun-confirmed evidence and explicit approval;
- no client gzip bundle increase over 1% without explicit explanation/approval;
- bounded-concurrency changes must show peak active work is capped and ordinary 1-item latency is not materially worse;
- file/cache/parser changes must show fewer allocations, reads, parses, or writes in deterministic tests—not only wall-clock claims;
- debug logging off must not add per-event formatting/I/O work;
- mobile and laptop E2E flows remain functionally identical.

Do not claim an improvement from a single noisy timing sample.

### 11.5 Bounded mandatory live-validation gate

Live validation is mandatory, but it is a **small smoke gate**, not a second exhaustive test suite. Unit/integration/E2E tests carry the edge-case matrix; live validation proves that the built server can still complete real work through its actual Internal API and browser WebSocket boundaries.

Read `docs/LIVE-VALIDATION.md` before running. Boot **one** disposable server, reuse it for all checks below, and use only its printed socket/token/port. Never use production defaults or `--allow-production` without explicit user permission.

#### Required bounded matrix

1. **Internal API runtime smoke:** one `smoke` scenario for each runtime available on the disposable server. This is intentionally `--scenario smoke`, not `--scenario all`.
2. **Exact browser WebSocket path:** one authenticated browser-protocol prompt using `scripts/ws-validate.mjs` against one available runtime/session. This covers the upgrade/auth/origin/routing path changed by S2/S4.
3. **Internal API rejection path:** the single unknown-runtime request in S3 must return `400 INVALID_REQUEST` without creating a session.
4. **Long-horizon persistence path:** because P1 directly changes this runner, perform one short `start` → `once` resume with `--interval 2 --max-wait 120`. Do not run an hour-long watch.

```bash
# Process 1: one isolated server for the whole matrix.
npm run validate:server -- --dir <short-temp-dir> --port <free-port>

# Process 2: at most one real turn per available runtime.
npm run validate:live -- --socket <sock> --token-path <token> \
  --runtime all --scenario smoke --json

# One exact browser-WebSocket prompt; use the session/password setup from S2.
node scripts/ws-validate.mjs --base http://127.0.0.1:<free-port> \
  --origin <allowed-origin> --password <validation-password> \
  --session '<validation-session-path>' --step prompt \
  --text 'Reply with exactly: LIVE-SMOKE-OK' --timeout 180000

# One short resumability check; use a cheap deterministic text condition.
npm run validate:long-horizon -- --socket <sock> --token-path <token> \
  --subject <available-runtime> --seed 'Reply with exactly: LH-OK' \
  --watch-text LH-OK --interval 2 --max-wait 120 --mode start \
  --state <short-temp-dir>/lh-state.json
npm run validate:long-horizon -- --socket <sock> --token-path <token> \
  --mode once --state <short-temp-dir>/lh-state.json --json
```

The `once` check may initially report “still running”; poll it at the declared two-second cadence until it passes or the 120-second absolute budget expires. Successful task-level runs from S2, S3, or P1 count toward this final matrix and must not be repeated just for ceremony.

#### Time and retry budget

- Target total elapsed time: **30 minutes or less** after the disposable server is ready.
- Run only the four checks above. Do not add `scenario all`, wire proxies, profile matrices, concurrency suites, hour-long watches, or production validation unless a failure specifically requires diagnosis or the user requests them.
- Retry one failed smoke once after checking the captured error. Do not loop indefinitely.
- At least one Internal API real-runtime turn **and** the browser-WebSocket turn must pass. Unit tests cannot substitute for both live boundaries.
- Record pass/fail/skip, duration, runtime/backend identity, and bounded scrubbed evidence in the implementation report.
- Capability skips and unavailable runtimes must be reported as `skipped/unavailable`, never as passes. A provider outage after one controlled retry is an explicit external blocker for that runtime, not a reason to keep the whole scheme running forever.
- Antigravity remains the documented exception: disposable mode disables it because `agy` cannot isolate its conversation store. Do not target production; use the L6 unit/integration evidence unless the user separately authorises a non-isolated live check.

After the matrix, stop the disposable server, confirm its port/socket are gone, and remove the temporary directory. Failure to tear it down fails this gate.

### 11.6 Full browser gate

For local UI changes use the project-required `webapp-testing` workflow, with automatic lifecycle management for an isolated local server. The repository Playwright config does **not** start a server, so a direct E2E run is valid only after separately starting an isolated test server with a known test-only password and pointing `TEST_URL` at its printed port; never fall through to the running production service.

```bash
# Terminal/process 1: isolated server; use a short temporary state directory.
AUTH_PASSWORD='<bcrypt-hash-of-the-repo-test-password>' \
  npm run validate:server -- --dir <short-temp-dir> --port <free-port>

# Terminal/process 2: exact isolated URL from process 1.
TEST_URL='http://127.0.0.1:<free-port>' \
  npm run test:e2e -- --project=chromium
```

The execution report must record the server PID, state directory, `TEST_URL`, and teardown confirmation without recording the password/hash. Verify the port is free and delete the temporary state directory after the run.

Required manual/automated viewports are 1366×768 and 390×844. Validate auth, new session, switching, streaming, copy, files, cross-tab persistence, mobile navigation, and no horizontal overflow. No visual redesign is expected; any visible difference requires investigation.

### 11.7 Coverage and dependency gate

```bash
npm run test:coverage
npm audit --omit=dev
npm ls --all
```

Expected:

- both workspace coverage suites pass truthful production-source thresholds;
- zero high or critical production vulnerabilities;
- no invalid/extraneous dependency tree;
- no unrelated lockfile churn.

### 11.8 Documentation gate

Update canonical docs only where contracts or operational behaviour changed:

- `SECURITY.md`
- `docs/PROTOCOL.md`
- `docs/INTERNAL-API*.md`
- `docs/LIVE-VALIDATION.md`
- `docs/LONG-HORIZON-VALIDATION.md`
- `docs/OBSERVABILITY.md`
- `docs/SHARP-EDGES.md`
- `tests/README.md`

Do not expand `AGENTS.md` with deep topic detail. If it must change, keep `AGENTS.md` and `CLAUDE.md` byte-identical by running:

```bash
npm run docs:sync-agent-guides
npm run docs:check-agent-guides
```

### 11.9 Final diff, secret, and completion audit

Before the final commit/push:

```bash
git status --short
git diff --stat
git diff --check
git diff --cached --stat
git diff --cached
git log --oneline --decorate <baseline>..HEAD
```

The implementation report must include a final matrix for `S1`–`S5`, `L1`–`L7`, `R1`–`R2`, `P1`–`P5`, `F1`–`F3`, `T1`, `Q1`–`Q4`, and `M1`. Every row must be one of:

- **complete** with links to RED/GREEN evidence and a commit;
- **not applicable** with source evidence showing a later commit already solved it;
- **blocked** with a concrete external blocker.

If any row is blocked, the whole plan is **not complete** unless the user explicitly accepts reduced scope. “Deferred”, “follow-up”, “mostly complete”, or “tests should cover it” cannot be used to declare victory.

Explicitly verify no secrets, tokens, cookies, auth dumps, transcripts/session files, notification payloads, validation state, local environment files, or `.code-review-ledger.md` are staged. Review each changed file rather than relying only on a regex scan.

Finally rerun, in this order, and paste the exact exit-code summary into the report:

```bash
npm run docs:check-agent-guides
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run test:e2e -- --project=chromium
npm audit --omit=dev
git diff --check
```

Only after all required commands and evidence pass may the implementation report status change to **complete** and the implementation branch be pushed.

## 12. Recommended commit sequence

1. `fix(security): protect worktree operations`
2. `fix(security): guard every websocket upgrade path`
3. `fix(internal-api): validate and bound batch dispatch`
4. `fix(security): unify prompt boundary checks`
5. `chore(deps): upgrade bcrypt without auth regression`
6. `fix(lifecycle): dispose websocket and worker resources`
7. `fix(lifecycle): dispose runtime and terminal resources`
8. `fix(runtime): coalesce model loads and opencode parsing`
9. `fix(persistence): make state transitions atomic and bounded`
10. `perf(client): narrow subscriptions and persistence writes`
11. `chore(tooling): improve scanner lint and coverage signal`
12. `chore(channel): gate event logs and record replay measurements`
13. `docs(validation): record hardening evidence`

Split a suggested commit when RED/GREEN evidence or rollback boundaries are clearer separately. Do not squash security, dependency, and lifecycle work into one unreviewable commit.

## 13. Completion statement template

A valid final statement should be evidence-based and short:

> All in-scope tasks in `CODEBASE-HARDENING-IMPLEMENTATION-PLAN.md` are complete at `<commit>`. The report contains captured test-first RED/GREEN proof for every behaviour change. Full lint, typecheck, 3,xxx+ tests, truthful coverage, build, Chromium E2E, the bounded disposable live smoke matrix, dependency audit, lifecycle churn checks, and before/after performance gates passed. Audit reports zero high/critical production vulnerabilities. No UI/protocol compatibility change, secret, session artifact, or untracked review ledger was committed. M1 resulted in `<no retention change | separate approved compatibility plan>` based on recorded measurements.

If that statement cannot be filled with actual captured evidence, do not claim completion.
