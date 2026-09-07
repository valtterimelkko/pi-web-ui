# Four-angle improvement sequence: trustworthy proof, bounded diagnostics, less repeated work

**Status: PLAN ONLY — implementation has not been authorised by this document.**

**Owner request:** 7 September 2026; make the four-angle audit executable by another agent, with clear measurements and minimal machinery.

**Audit/source baseline:** `368829773fecab3b484092e7ef6dacb48724b0d5`. Reconcile against current HEAD before execution.

**Scope:** Pi Web UI code/test effectiveness, performance, observability and autonomous-agent verification.

**Execution entrypoint:** this file. It contains the findings needed to execute without the originating conversation.

## 1. Intent, victory and limits

Make it easier for an agent to answer **“did my actual change work, on the intended build, without leaving damage behind?”** Reduce avoidable work as sessions grow. Do not build another agent framework.

Victory is all of the following:

1. The advertised full gate discovers every intended workspace/test location. A broken real handler, omitted required test, unexpected skip, wrong target, stale build or failed cleanup cannot produce a clean acceptance verdict.
2. Ordinary logs and API diagnostics apply the same bounded safety projection. Missing evidence is explicit. All five runtime families appear correctly in API receipt metrics. Unreadable persisted state is not reported as a healthy empty registry.
3. An ordinary, non-crashing browser can export useful private diagnostics. Server/browser/test evidence identifies the source/build and process being examined.
4. The repeated-work targets pass the **operation-count and correctness gates in §§7–9**, with representative before/after measurements. Large architectural changes are unnecessary if the small repairs meet those gates.
5. Every audit ID in §12 has a disposition, evidence and remaining limits. Mandatory repairs are done; conditional work either meets its gate or has a documented, measured deferral. An unimplemented mandatory repair is not “not worthwhile”.
6. The final candidate passes applicable repository gates and independent entrypoint verification. Source completion, merge/push, external-consumer synchronisation and production deployment are reported separately.

**Not victory:** more tests counted, green checks on mock reimplementations, more wrappers, a long report, lower synthetic benchmark numbers, a watch firing, or a commit alone.

### Hard scope boundaries

- No production restart/deploy/reload/configuration/credential changes or production validation without fresh explicit owner permission. Do not edit real session files to reproduce faults.
- No new scheduler, watchdog, database, queue service, telemetry backend, MCP service, event-sourcing system, universal validator framework or dependency on Agent OS implementation. The vault remains shared memory, not product policy/code authority.
- No blanket cleanup of `any`, small factories, runtime adapters, aliases or compatibility shapes. No whole-file formatting churn or large router/store rewrite.
- Do not revive resource-scaling Phases 8–9. Read the **Programme pause** in the [resource plan](PI-WEB-UI-RESOURCE-SCALING-AND-LIFECYCLE-HARDENING-PLAN.md).
- No automatic deletion of retained prototypes or removal of the intentionally visible Tasks/Soon tab. Keep the current UI choice unless the owner separately chooses otherwise.
- No optional analysis dependency is required. Use existing Vitest, Testing Library, Supertest, Playwright and Node profiling first. Knip/Stryker/fast-check are optional only if a concrete task becomes simpler; no repo-wide tool rollout.

### Existing work that must not be duplicated

At planning time `pi-astraorchestrationfix-149` owns goal continuation/pause, watch restore/fork/cancellation, watch-generation CAS/migration/DELETE parsing, Pi pause-reason projection, model-free deadline wakes, and their restart/actual-compaction/two-child-fan-in proof and skills. Source is undergoing final review in an isolated Pi Web UI tree; it is not this plan's work.

Host-side continuity, if still present: `/root/.pi-web-ui/operations/orchestration-repair-20260907/STATE.md` and `B/server-brief.md`. These are private operational pointers, **not required inputs to the public plan**: when absent, resolve the owner through board/worklog and current Git/docs. Reuse the owner's accepted proof; do not implement or re-audit its programme as a prerequisite for unrelated tasks.

Also excluded: the just-landed capacity/permit/steer/SSE backpressure and validation-server process-group teardown repairs; parallel Board/Worklog work in Agent OS; parallel compaction/subagent-persistence repairs in `pi-enhancement`.

Preserve their invariants when changing adjacent integration. This plan's **scenario cleanup verdict**, **compiled-entrypoint mode** and **replay retention budget** are distinct improvements, not permission to replace those owners' lifecycle logic. If a step touches an actively owned path/hunk, mark it `blocked-needs-owner` and do not edit it until coordination explicitly releases that seam. Continue disjoint steps meanwhile. The other owner's accepted proof can protect an unchanged dependency, but cannot substitute for evidence that this plan's new behaviour is implemented.

## 2. Start here: resources, authority and execution discipline

### Canonical reading map

Read [AGENTS.md](../../AGENTS.md), then [Maintainer index](../MAINTAINER-INDEX.md), [Architecture](../ARCHITECTURE.md) and [Codebase map](../CODEBASE-MAP.md). Read relevant rows before their step, not every historical plan:

| Work | Canonical resources |
|---|---|
| Test discovery/CI/test quality | [Test guide](../../tests/README.md), root/workspace `package.json`, `server/vitest.config.ts`, `client/vitest.config.ts`, `shared/vitest.config.ts`, `packages/internal-api-mcp/vitest.config.ts`, `.github/workflows/` |
| Diagnostics/security | [Observability](../OBSERVABILITY.md), [Troubleshooting](../TROUBLESHOOTING.md), [Security](../../SECURITY.md), `server/src/logging/`, `server/src/observability/`, `server/src/internal-api/diagnostics-buffer.ts` |
| API fields and compatibility | [Internal API](../INTERNAL-API.md), [Contract/version authority](../INTERNAL-API-CONTRACT.md), [Protocol](../PROTOCOL.md), `shared/src/protocol-types.ts`, `server/src/internal-api/types.ts` |
| Disposable proof and teardown | [Live validation](../LIVE-VALIDATION.md), [Long-horizon validation](../LONG-HORIZON-VALIDATION.md), [Durability matrix](../DURABILITY-MATRIX.md), `scripts/validation-server*.ts`, `scripts/validation-server-stop.mjs`, `server/src/live-validation/validation-server-env.ts`, `server/src/live-validation/validation-safety.ts`, `scripts/ws-validate.mjs`, `playwright.config.ts` |
| Frontend state/replay | [Event pipeline](../EVENT-PIPELINE.md), [Session metadata](../SESSION-METADATA.md), `client/src/store/sessionStore.ts`, `client/src/lib/websocket.ts`, `client/src/lib/browserDiagnostics.ts` |
| Runtime fixture | [Command Code integration](../COMMAND-CODE-INTEGRATION.md), `server/src/live-validation/command-code-fixture.ts`, `server/src/live-validation/scenarios.ts` |
| Avoid repeating solved work | [Sharp edges](../SHARP-EDGES.md), [Recent changes](../RECENT-CHANGES.md), final **Phase J**, not superseded early claims, in the [hardening report](CODEBASE-HARDENING-IMPLEMENTATION-REPORT.md) |
| Final operational boundary | [Deployment](../../DEPLOYMENT.md); production and consumer changes remain separately authorised |

The originating audit is at `/root/.pi-web-ui/notes/PI-WEB-UI-FOUR-ANGLE-AUDIT-2026-09-07.md` on the operator's host. It has fuller discussion, but this plan reproduces all actionable findings and acceptance gates. Do not require that private file in tests or CI. This plan supplements completed historical hardening; it does not reopen the archived [T3 receipt plan](PLAN-T3-CODE-BENCHMARK-IMPROVEMENTS.md).

Use the available skills: Agent OS recall + packet at start; board/worklog for ownership; systematic-debugging and TDD for repairs; `pi-web-ui-live-validation` for runtime proof; `webapp-testing` for localhost UI; `pi-sdk`/`pi-extension` only if the relevant integration actually changes; capture at useful handoffs. Read current canonical SDK docs if touching SDK interfaces. Skills/companion source edits need their own scope and canonical-source workflow.

### Step 0 — reconcile, baseline and record ownership

Before modifying implementation:

1. Read whole board plus repo/worktree-filtered worklog; a canonical-path-only board filter missed the active isolated owner during the audit. Inspect declared brief/checkpoint and current changed paths. Never treat silence/staleness as release.
2. Record current HEAD, clean/dirty owned paths, Node/dependency versions, current contract, relevant landed fixes and gate results. The audit baseline had two **unowned** dirty Command Code catalogue/effort files; never stage/stash/reset these or presume they are yours now.
3. Read current package scripts/configuration before running commands. Tests may inherit `NODE_ENV=production` or operator-disabled runtimes. Use an explicit fixture/test environment and pinned clocks; never source a production env file wholesale merely to get a test green. Permission failures under root need deterministic injected `EACCES`, not ineffective chmod-only fixtures.
4. Reproduce still-present findings with the actual entrypoint. Classify already-fixed items with current evidence, not a redundant implementation. Pin time-dependent test clocks; the repository has previously had fixed-date receipt fixtures age into retention pruning failures.
5. Create one concise execution report, e.g. `docs/plans/FOUR-ANGLE-IMPROVEMENT-REPORT.md`: step/ID, status, RED command/exit, GREEN command/exit, real call path, measurement, commit, limits. Private run artefacts belong outside Git. Update this plan in place only for adjudicated intent changes; do not create competing revised plans.

**Step 0 gate:** explicit owned/no-touch paths; all 22 IDs classified for execution; baseline fingerprint and commands recorded. A baseline failure gets a root cause and owner/plan disposition before it can be dismissed as unrelated.

### TDD and handback rules for every step

- Defect: write the failing behavioural regression, observe RED, minimally implement GREEN, then refactor.
- Refactor: first pin the real behaviour, prove the test catches a controlled behavioural break in an isolated copy, restore it, then extract without changing behaviour.
- Tooling/test repair: prove the old gate misses a deliberately failing subject and the new gate rejects it. Do not leave deliberate failures committed.
- Performance: first reproduce excess operation counts and save a real-path baseline; implement only after equivalence tests and the cost witness exist. Tests written afterwards are not RED evidence.
- New validator/rule: exercise the actual command/route that enforces it, including a rejected input. A helper unit test or model-written success sentence is not enforcement proof.
- Keep providers mocked at the external boundary, **not the router/store/adapter being repaired**. Use real temporary files, HTTP, child-process and browser boundaries where those are what can fail.
- Commit only task-owned changes on the authorised current branch after status/diff/staged-path/security review; no new branch unless authorised. Concurrent delegated writers require isolated ownership/worktrees and explicit integration authority. Prefer one executor; at most 2–3 disjoint children if useful, with a parent-owned final review. Never have two writers in `sessionStore.ts`, registry/diagnostics or shared route glue.
- Preserve first failures, retries, missing capabilities and unconfirmed cleanup in the report. Use completion wakes and pause before genuinely idling; never turn supervision into a polling loop.

## 3. Sequence overview

Proceed in this order. Each row is a bounded deliverable; do not begin with a universal verification runner.

| Step | Outcome | Depends on | Audit IDs |
|---|---|---|---|
| 0 | Reconciled baseline and ownership | Owner execution approval | All |
| 1 | Tests exercise real code; complete discovery; basic CI and lint ratchet | 0 | S1, S2, S6, V1, V2 |
| 2 | Safe, bounded, truthful diagnostics and registry failure state | 1 | O1–O4 |
| 3 | Build identity, verified disposable target and strict proof records | 1–2 | O5 identity, V3–V5 |
| 4 | Honest browser tests and normal-UI diagnostic export | 3 | S3, O6 |
| 5 | Representative measurements and small bounded history | 3–4 | S4, O5 history |
| 6 | Less registry/discovery work | 2, 5 | P1, P2 |
| 7 | Less streaming/replay state work | 4–5 | P3, P4, S6 |
| 8 | Bounded aggregate broker replay retention | 3, 5; owner seam released | P5 |
| 9 | Proven dead-code cleanup and minimal policy deduplication | Relevant earlier proof | S5, S6 |
| 10 | Integrated evidence, review, docs and gated handoff | 1–9 dispositions | All |

Steps 6 and 7 may run independently with separate owned paths; step 8 must not race the current orchestration owner. Keep the final single candidate/review under one conductor.

## 4. Step 1 — make the cheapest checks trustworthy

### 1A. Repair discovery and test the production subject

**Observed gap:** root `npm test`/coverage omitted shared; `shared/vitest.config.ts` includes `src/**/*.test.ts` but not `shared/tests/child-surfacing.test.ts`. Six source test files plus that external test existed at audit time. Inventory current files rather than pinning that historical count.

- Wire shared tests into the root command and its discovery configuration. Add shared coverage with explicit production-source inclusion; match the installed Vitest coverage version. Record the truthful baseline and set a ratchet no lower than that newly measured baseline minus one percentage point. Preserve existing server/client/MCP thresholds; do not lower them to make this plan pass.
- Test discovery against the intended source/test roots with an explicit, reviewed exclusions list. Use runner discovery/output, not a second hand-maintained test-name list. A temporary failing test in each previously omitted location must make the root command fail.
- Replace inline Express handlers in `server/tests/unit/routes/models.test.ts` with the real `server/src/routes/models.ts` router. Cover Pi success, failure, auth, disabled optional runtime, and actual PUT contract. Reuse neighbouring real-router tests/fixtures rather than duplicate them.
- Replace the claimed component performance proof in `client/tests/unit/store/phase-d-characterization.test.tsx`: render real Sidebar/NewSessionModal/FilesTab with controlled dependencies. Unrelated store updates cause **zero additional target renders**; a relevant visible update changes the rendered result. Record StrictMode configuration. The source regex may remain only as a clearly labelled supplementary check.

**Victory:** compare a machine-readable filesystem/config-derived intended-file inventory with the runner's actual execution report. Every required file is present and executes at least one non-skipped test; absent, zero-test or all-skipped required files/workspaces fail. Optional files require an explicit capability-based classification, not silent omission. A real model-route mutation and a real target subscription regression both fail the repaired tests. No copied implementation remains in these tests. Type-only tests use compile-time assertions for all five runtime variants where appropriate, not assertions of fields they just assigned themselves.

### 1B. Basic CI and selective warning ratchet

**Observed gap:** `.github/workflows/agent-guides-sync.yml` was the only tracked workflow. Root lint exited 0 with 1,685 warnings: 1,359 test, 265 implementation-source, 61 tooling. These numbers are a historical measurement, not a new defect count or a threshold to blindly copy after other work lands.

- Add a credential-free application CI job using locked dependencies, explicit Node version and the same repo commands agents run. Start with docs checks, lint, typecheck, build, tests and coverage. Add the deterministic smoke from step 3 once available; no provider-backed calls on public CI.
- Ratchet warning counts against the reconciled baseline and reject new warnings on changed implementation lines/new files. A minimal ESLint JSON comparison keyed by path/rule/location in the changed hunks is sufficient; normalise shifted lines using the Git diff. Test inserted lines/renames so moving old warnings neither creates false new warnings nor hides newly added ones.
- No arbitrary repository-wide `--max-warnings=0` cleanup, per-file blanket disables or replace-all casts. Existing warnings may remain with the baseline recorded.

**Victory:** an intentionally broken application test fails the actual CI gate command; a newly introduced unused implementation variable fails the ratchet; existing unchanged warnings do not. Document checked-in CI versus locally proven command results; do not claim a GitHub run happened unless its result was read. Branch protection/settings changes need separate approval.

## 5. Step 2 — safe, bounded and truthful observability

### 2A. One safe logging projection, two destinations

**Observed gaps:** `server/src/logging/logger.ts` taps a record then renders the unsanitised original/raw message; `internal-api/diagnostics-buffer.ts` redacts a clone. Synthetic token text was redacted in diagnostics but retained in the normal sink. `workers/session-worker.ts` forwards stderr through this logger. The 1,000-record diagnostics ring retained a single 1 MiB message intact.

- Put the pure bounded projection in the existing logging layer (one small helper if needed), avoiding a logger↔diagnostics import cycle. Apply it to ordinary pretty/JSON sinks and diagnostics. No pretty-render path may reuse the original unsafe string.
- Bound before expensive formatting/traversal; handle circular values, throwing accessors and error objects without logging failure recursion. Do not leak a credential prefix by cutting a secret at a truncation boundary. Unknown arbitrary payloads are not a reason to preserve whole objects.
- **Initial implementation budgets:** at most 8 KiB UTF-8 serialised record, 2 MiB total retained diagnostic records, and 1,000 records; traversal depth 6 and at most 256 visited fields/elements per record. These are proposed local guardrails, not measured requirements. Tighten if fixtures allow; loosening requires recorded evidence and reviewer agreement before changing the gate.
- Keep useful request/run/session/runtime/component/error classification. Apply explicit truncation/redaction markers. Track evicted/truncated/insertion-failed counts without recursively invoking the failing logger.
- Expose retained-window bounds, process-local/reset semantics and loss counters separately from query-filtered counts. Bound the ordinary diagnostics JSON response to 1 MiB, trimming returned records with explicit omitted-count/truncation metadata; retain any stricter existing compact-evidence response limit. Response trimming must not mutate the ring or falsify total matching counts. Never imply that zero matching records proves no activity.

**RED/verification:** actual `createLogger` with both formats and diagnostic tap; synthetic secrets in nested context/error/URL/stderr, long multibyte text, cycles and boundary-cut secrets. Actual worker stderr forwarding must reach the safe sink. Flood 10,000 small records plus oversized inputs: count/byte limits always hold, counters reflect loss, a normal subsequent error still appears. Actual diagnostics HTTP response respects its documented byte budget; no raw prompt or synthetic secret survives.

**Victory:** safe output at every checked sink; bounded traversal/retention/response; **zero silent insertion failures** (each is counted); retained-window and loss metadata explain incomplete evidence. This does not claim regexes can discover every possible secret in arbitrary prose—keep the data allowlist conservative.

### 2B. Five-runtime counters and honest data-source state

- Fix the four-runtime list in `observability/operational-metrics.ts`; use an exhaustive typed mapping/source. Record accepted/terminal outcomes for all five families, retain low cardinality and private-session visibility. Label the scope as API receipt outcomes, not all browser/native turns. Do not redo permit accounting.
- Drive the actual receipt manager and diagnostics route with the provider-free Command Code fixture: a single new run increments accepted/completed once; an idempotent replay does not double-count. Probe all five variants at module level, not with five paid model calls.
- Separate registry **missing/new**, **valid/empty**, and **unreadable/corrupt** in `session-registry.ts`; preserve existing corrupt bytes and refuse writes based on a fabricated empty registry. Do not repair, delete or overwrite the operator's real registry automatically.
- Make failure visible through diagnostics/evidence and the affected actual routes. Replace `catch(() => [])` healthy-zero fallbacks in `internal-api/routes/diagnostics.ts` with explicit bounded source-unavailable state. Fail closed for session visibility. If a route requires registry truth to mutate, a failed write/read cannot be acknowledged as successful.
- Preserve documented compatibility wherever possible. If an existing authoritative recovery rule/test requires destructive reset or contradictory status behaviour, ask for the authority to supersede it; do not silently rewrite the policy.

**Victory:** corrupt/schema-invalid/EACCES fixtures return an explicit unavailable/degraded result, their original bytes remain identical after a rejected mutation, and ENOENT alone can initialise a new registry. Recovery after fixing the fixture is tested (no permanently cached false emptiness). Valid empty state remains distinguishable. Existing privacy filters still prevent hidden session disclosure.

## 6. Step 3 — prove the intended candidate on a safe target

### 3A. Build/process identity, not a version label

**Observed gap:** health exposed contract/uptime; browser build version defaulted to package version/dev. Neither proves that a particular fix is running. Production runs compiled `server/dist/index.js`; disposable validation loads source under tsx.

- Add a small build manifest generated from declared build inputs: revision, source/config/lockfile fingerprint, build mode and necessary component versions. Include dirty **owned** candidate input contents in the fingerprint; never embed a Git diff, env values, auth material or unredacted host paths. Document included/excluded inputs and unknown identity behaviour.
- Embed/copy identity into built server/client artefacts; do not infer the running build from current checkout HEAD or a caller-supplied environment label. Add a new process boot ID/start time at launch. Source mode must say source, not claim compiled identity.
- Extend existing health/diagnostic/browser bundle surfaces minimally. Source fingerprint, not a package/contract version, ties evidence to the candidate. Documentation-only commits may differ if relevant fingerprints remain identical and the report records the relationship.
- Add a compiled-entrypoint option to the **existing** disposable launcher/proof path, retaining dedicated process-group ownership and the verified stopper. No second launcher or cleanup daemon. Prove that code loaded from dist is actually executing, not a source import reached by accident.

**Victory:** two source changes produce distinct build identities; two boots of one build retain build identity but differ in boot identity; stale client/server or report/candidate mismatches are detected. Breaking only a compiled fixture makes compiled smoke fail even when source mode works. Readiness metadata alone is not the functional smoke: perform authenticated HTTP/WS and one provider-free Command Code turn/replay.

### 3B. Verified browser target and strict acceptance results

- Use the existing disposable launcher and explicit printed socket/token/ports. Browser preferences, session/registry/runtime stores and test workspace must be private. Check both `PI_AGENT_DIR` and the installed SDK's actual agent-directory override (currently `PI_CODING_AGENT_DIR`) where resource isolation is required; verify effective paths, not variable names alone. Shared credentials are not disposable.
- The default provider-free fixture child uses an allowlisted environment and private test homes. Exclude/reject inherited production auth/provider secrets before startup; never copy or modify shared auth files/profiles. Supply only a transient synthetic fixture login credential, replace fixed login values in the required E2E helpers, and never persist that credential in public artefacts. Separately authorised real-provider validation must be an explicit different mode with its actual shared-credential boundary reported, not a fallback from failed fixture startup.
- Add one thin test wrapper which verifies backend build/boot identity **before login or mutation**, sets `TEST_URL`, and routes Vite to that exact backend. A localhost frontend proxying to port 3456 is not isolation. Do not change the normal dev target globally to get a test green.
- Reuse `validation-server-stop.mjs`; record its result and an independent check of the owned listener/group. Never broad-kill processes. Preserve ownership evidence if shutdown is uncertain. Do not delete directories containing unresolved cleanup evidence.
- Extend the existing live runner or add a thin strict acceptance wrapper around it. Required checks must be explicitly named. In strict mode: missing required scenarios, zero required executions, unexpected skips, failed assertions, missing required evidence, or cleanup uncertainty yield non-zero/non-clean verdict. Exploratory `all` may retain its documented optional skips; it must not masquerade as strict acceptance.
- Distinguish `passed`, `failed`, `skipped/unsupported`, and `indeterminate`. Preserve first-attempt failure/retry evidence; retries must not erase it. The strict final browser smoke uses retries disabled.

**Negative controls:** an unrelated server on the expected port, stale manifest, mismatched Vite proxy, wrong build, missing fixture capability, all-skipped matrix and injected session-deletion failure must each fail the actual wrapper **before forbidden actions or before a clean verdict**, as appropriate. Existing auth/origin/CSRF protections remain enabled.

### 3C. Small run-scoped proof record

Reuse `server/src/live-validation/types.ts`, existing test JSON and launcher records. Add only the missing orchestration of checks, not a plugin system or general shell execution engine. A static recipe table for `core`, `browser`, `runtime-fixture`, `performance` is sufficient; do not execute arbitrary commands supplied by a manifest.

A private, schema-versioned manifest must contain candidate/build/boot identities; declared input fingerprints; checks and exits; expected/executed/skipped matrix; attempts; actual entrypoints; fixture-versus-real-runtime scope; bounded artefact references/hashes; cleanup disposition; remaining limits. Summary maximum 256 KiB; no secrets, prompt bodies or session dumps. Keep full test output in private run-specific files using bounded output capture, and mark truncation explicitly. Missing required evidence is indeterminate, not success. No automatic external upload of runtime logs.

**Victory:** the real wrapper invokes real checks and creates the record; intentionally stale fingerprints, absent artifacts and unconfirmed cleanup are rejected. A subsequent run cannot overwrite the prior run's evidence. One agent can read and re-run another's exact commands without reconstructing paths or assuming its narrative is true. The record is evidence, not a replacement run-receipt store or an automatic semantic judge.

## 7. Step 4 — browser tests with real assertions; useful manual diagnostics

**Start:** `tests/e2e/dual-sdk-session-creation.spec.ts`, `cross-tab-state.spec.ts`, relevant copy/persistence/runtime suites; `client/src/components/ErrorBoundary.tsx`, `lib/browserDiagnostics.ts`, existing help/settings UI.

- Seed required state through disposable fixtures. Missing New Session/tab/message controls in required cases are failures. Optional-runtime skips depend on explicit capability evidence, not a failed selector.
- Replace “isDisabled returns boolean” with expected enabled/disabled results under two controlled capability states. Require authentication complete before further assertions.
- Separate app-panel switching from real browser-tab persistence. Prove the latter with two pages in the same isolated browser context: update an archive/pin/name, observe both views converge, reload and verify persisted state. Exercise the actual metadata route/storage event mechanism, not only local state setters.
- Rename console-only “no memory leaks” checks to what they prove. If retaining a leak claim, measure owned resource counts/retained heap on a repeatable fixture; console silence is not its oracle. Require zero unexpected console/page errors in the deterministic core suite, using a narrow documented allowlist rather than a permissive count.
- Expose existing copy/download diagnostics in the normal help/settings surface. Do not redesign navigation. Add safe async-error/component fingerprints and bounded connection outcomes, not raw stacks/URLs/payloads. No automatic upload. Follow existing cardinality limits and add an explicit byte bound (initial bundle maximum 128 KiB).

**Victory:** removing a core control or breaking persistence turns the real browser suite RED; desktop 1280×720 and mobile 375×812 required smoke both pass without retries or unexpected skips. Non-crashing reconnect/async-error cases can export distinguishable useful bundles. Synthetic secrets/chat text are absent; export failure is visible; repeated listener setup/disposal returns counts to baseline. Use before/after screenshots to prove the small UI change; visual taste changes beyond this need the operator's review-branch workflow and approval.

## 8. Step 5 — measure production paths, not sleeps

**Observed gap:** `tests/benchmarks/index.ts` implements its own fake cache with a 50 ms delay; mobile benches use fixed waits; memory benches estimate JSON size and sometimes return zero for unsupported heap measurement. Those are not evidence of application latency/leak freedom.

1. Label retained synthetic benches honestly; remove them from app acceptance claims. Unsupported measurements must say unsupported. No fabricated baseline or claimed speed-up from comparing two hardcoded waits.
2. Add **a small fixed workload set** importing the real parser/registry/store and driving the real disposable browser transport. Reuse existing fixtures. Do not make a performance lab product.
3. Record revision, workload hash, Node/browser versions, CPU/resource limits, warm/cold mode, sample count, raw samples and medians/p95. Two warmups, then ten samples per candidate for timing. Compare baseline/candidate on the same isolated environment with alternating order. Use injected clocks only for logical timing tests, never to fake performance.
4. Keep CI's mandatory cost gates based on deterministic operation counts and output equivalence. Timing is a controlled local acceptance check, not a flaky shared-runner stopwatch. Before/after optimisations must not regress another measured path's p95 by more than 10% beyond measured run-to-run variation. If noise prevents a conclusion, report indeterminate and take one bounded profiling pass; do not keep re-running until green or silently widen tolerance.
5. Use existing Node CPU/heap profiling and browser long-task/React commit evidence when operation counts do not explain cost. No real provider calls needed to generate fixture traffic. Do not profile production by default.

### Fixed workloads and measurements

| Workload | Initial fixture sizes | Capture |
|---|---|---|
| Parser/discovery | 1 MiB and 16 MiB valid JSONL; burst notifications and sustained append; one replacement/truncate | Full parses, bytes read, pending work, CPU, metadata correctness |
| Registry/diagnostics | 1,000 and 10,000 entries; 100 concurrent updates; scoped/global diagnostics | Entry comparisons/lookup count, snapshot writes/bytes, queue depth, request time, durable final state |
| Streaming | 1,000 initial messages; 1,000 text/thinking/tool deltas; current/background switch | Store publications, full-size recalculations, final content, React commits/long tasks/heap |
| Replay | 1,000 and 10,000 events including reused/id-less IDs and tool results | Lookup work, elapsed/heap, exact folded output |
| Broker churn | 2,000 distinct keys with small fixture events; subscribe/unsubscribe/reconnect/delete | Total retained bytes/keys, active delivery, loss indication, post-cleanup counts |

Run only the relevant workloads during each targeted change; run the complete fixed set once for final integration, rather than every full matrix after every edit. Keep at most one heavy server/browser/profile run per executor; use bounded resources independent of the live service. Larger fixtures require a demonstrated reason, not a desire to hit an impressive number.

### Bounded history (O5)

Reuse the existing event-loop monitor rather than add a sampler daemon. Keep a 60-second rolling window of at most 120 lag samples at the existing 500 ms cadence; expose count/max/p95/window/reset semantics. Use a ring, not an ever-growing list. Any extra latency family must be low-cardinality and justify a real consumer; do not instrument every function.

**Victory:** a seeded lag spike remains visible for the window after a quiet sample, then expires; memory/sample count stay bounded; old process samples cannot be mistaken for the new boot. Existing shed thresholds and admission policy remain unchanged.

## 9. Steps 6–8 — small performance repairs with clear stopping points

### Step 6A. Registry and diagnostics: remove repeated whole-list work (P2)

**Start:** `server/src/session-registry.ts`, `internal-api/routes/diagnostics.ts`, its wiring in `internal-api/server.ts`, existing metadata and registry tests.

- Reuse one request-local visibility snapshot for diagnostic records and aggregate counts; preserve fail-closed privacy. Do not cache a private-session access decision indefinitely.
- Keep the ordered registry entries for public ordering/serialization; add maps for exact ID/path/native-ID lookup inside the current registry owner. Preserve existing alias/first-match semantics and reject/handle collisions as current policy requires. Update indexes on mutation, reload, deletion and ID/path changes.
- Coalesce compatible queued snapshot saves in the same owner. A fulfilled mutation must be represented durably by the saved state or a documented later superseding value; no early “saved” acknowledgment. Write failures reject affected waiters and preserve recovery/retry semantics. Do not remove freshness updates simply because the status string is unchanged.

**RED/victory:** one diagnostics request enumerates/resolves visibility at most once per entry and does not call a linear registry search per entry. Looking up all N IDs requires O(N) total indexed work after O(N) initialisation, not O(N²). For the deterministic concurrency fixture, submit all 100 compatible mutations without awaiting them, hold the first disk write on an explicit test latch until all mutations are registered, then release and drain the owner's queue. At most **two snapshots** are written in that defined batch; reload contains all acknowledged deltas or later superseding values. Do not use wall-clock sleeps to define the batch or require two writes for 100 independently awaited sequential mutations. Rejected writes never produce success; later retries work. Compare metadata/ordering/private visibility against the prior implementation on valid fixtures.

No SQLite, append journal or cross-process cache is required. Do not change same-host multi-process ownership semantics without a separately demonstrated problem.

### Step 6B. Watcher: coalesce expensive parses first (P1)

**Start:** `server/src/pi/session-watcher.ts`: `handleChange`, `readSessionInfo`, add/unlink metadata and lifecycle tests. The current implementation begins full parsing before the debounce, so timer coalescing alone does not coalesce reads.

- Keep the current watcher as sole owner. Preserve bounded header identity capture needed for add→unlink races; move/share the expensive full read so notifications within a debounce burst share work. At most one expensive read in flight per path, plus one pending invalidation/re-read. No unbounded promise backlog.
- First implement coalescing/header caching, not an incremental parser. Compare against a complete-file oracle for ID, cwd, first non-skill message, counts and timestamps. Test changes during a read, unlink, stop/restart, short-lived add/unlink, malformed/partial last lines and file replacement.

**Mandatory victory:** use a controlled scheduler and explicit read latch: ten notifications arrive within each debounce window, then the window/read/invalidation work drains fully before the next burst. Ten such bursts permit at most **one initial full metadata read plus one invalidation re-read per burst** (20 total); bounded header reads are counted separately. Report the reduction versus the reproduced old behaviour (80% or more if it did 100 full reads), rather than treating that historical percentage as a universal gate. No reads occur while idle after settling; no post-stop cache resurrection; final metadata equals the oracle. Exercise at least one actual chokidar/temp-file append path in addition to method-level deterministic tests.

**Conditional incremental step:** only if the sustained-append fixture still spends over 10% of one CPU core in metadata parsing during its measured window, or fails the non-regression gate, add a minimal per-file append offset/cache. Record that trigger before implementation. Then require bytes read after the initial scan to be proportional to appended bytes (at most 2× append bytes plus bounded header reads); partial-line carry, truncation/replacement and restart force the correct rescan. If coalescing meets the gates and the trigger is absent, retain full parsing and explicitly defer incremental complexity with the measurements. Do not discard huge valid lines silently to make the metric pass.

### Step 7A. One atomic live update; incremental size bookkeeping (P3)

**Start:** `client/src/store/sessionStore.ts`: `updateMessageInSession`, `updateMessage`, live `session_event/message_update`, `estimateMessageSize/estimateMessagesSize`; message rendering and store tests.

- One action updates the target message and necessary current/cache projections atomically. Preserve public selectors, persistence keys, two-session LRU and optimistic state. Do not consolidate every store representation in this step.
- Update message-size accounting from the changed message, not every message. Avoid mutating prior content-part objects used by memoised rendering.
- Do not add RAF batching initially. Consider it only after profiling shows this simple change still misses the browser non-regression gate; flush terminal/control events correctly and record any added latency policy before implementation.

**Victory:** after stream setup, feed one text/thinking `message_update` frame at a time through the actual handler, with no independent status/control events. Observe subscriptions to the affected content/projection tuple: each delta causes at most **one publication of that tuple**, with no intermediate inconsistent view; **zero full-transcript size scans per delta**. Count unrelated lifecycle events separately; use deterministic event input, not timing assumptions. Unchanged message objects retain identity. Current/background caches agree after switching. Exact final text/thinking/tool output matches baseline for reused Command Code IDs, id-less Pi updates, late events and replay/live boundaries. Run the actual browser transport fixture, not just setters; memory does not retain evicted sessions through the new indexes.

### Step 7B. Indexed replay target lookup (P4)

Use a per-fold storage-ID lookup alongside the existing wire-ID→latest storage-ID mapping. Retain duplicate-ID suffixing, latest-turn resolution and id-less fallback. Avoid a global cache or changing the history format.

**Victory:** N messages plus E targeted update/tool events require O(N+E) lookup work rather than repeated array scans. Existing storage-ID allocation collisions are a separate operation—measure/report them rather than conceal them in the lookup claim. Folded results are exactly equal on 1k/10k fixtures, including chunk boundaries and background switching. One known extra linear scan introduced into a copy must be caught by the cost witness. No new replay protocol is required.

### Step 8. Aggregate broker replay budget, not another lifecycle controller (P5)

**Start:** `server/src/internal-api/event-broker.ts`, its deletion/disposal consumers in session routes and the snapshot/evidence/SSE replay consumers. Coordinate route seams after the existing orchestration owner releases them.

- First expose aggregate retained byte/key counts through existing bounded metrics. Per-session 50-event/8 MiB defaults do not bound the sum across sessions.
- Add a global replay-byte budget inside the broker. **Initial default: 32 MiB serialised retained event bytes**, while preserving existing stricter per-session limits. Use cached byte sizes, not repeated stringify during eviction. Serialised bytes are a deterministic bound, not a claim of exact V8 heap consumption.
- Bound idle/cold bookkeeping keys to **1,000**. Active subscriber/rate state can scale with actual active observed keys; report that separately. Evict cold metadata consistently across replay/rate/warning/pending maps so one supposedly bounded map does not hide another unbounded one. Never retain a pending delta indefinitely without a subscriber or a bounded flush/expiry policy.
- Never evict live subscribers or suppress live terminal/control delivery to preserve replay. Old replay events may be evicted under the budget; consumers must know historical evidence is incomplete.
- Reuse existing truncation/replay-status metadata where available. If absent, add only a minimal bounded completeness status to the affected snapshot/evidence and replay-subscription response path. A cold/evicted history is not proof that no output occurred. No durable cursor store, full history transport or new scheduler. Document old-client best-effort recent replay compatibility.

**Victory:** 2,000-key churn keeps retained replay bytes ≤ configured budget and cold metadata keys ≤1,000, with total key accounting ≤ active observed keys + cold allowance. With a tiny injected test budget, eviction and its consumer-visible incompleteness signal are reliably exercised. Active subscribers receive all required terminal/control events; reconnect uses available replay or explicit gap status; exact deletion/disposal clears owned state and late callbacks cannot resurrect it. Measure heap plateau after bounded GC-assisted churn separately; do not claim that 32 MiB serialised equals 32 MiB heap.

If honest eviction signalling would require a broad incompatible protocol change, stop this step with the measured problem and one narrow owner question. Do not silently drop replay, or call the boundedness repair complete with metrics alone.

## 10. Step 9 — remove only proven waste

**Start:** `client/src/components/Tools/ToolCallCard.tsx`, `Tools/index.ts`, todo branches in `CollapsibleToolCard.tsx`, `Chat/MessageBubble.tsx`, `lib/messageAdapter.ts`, `Navigation/IntegratedHeader.tsx`, metadata derivation in `server/src/routes/session-meta.ts` and `client/src/store/sessionStore.ts`.

- Confirm private production import/mount consumers before removal. Remove unconsumed ToolCallCard/export and unused settings prop if still unused. The normal todo path already uses TodoToolCard; consolidate/remove bypassed duplicate parsing while preserving TodoWrite/TodoRead alias routing.
- Do not call the unmounted OrchestrationPage a live broken workflow. Keep it clearly marked inactive or remove only with proven private non-use and no conflicting retention decision. Keep Tasks/Soon unchanged absent an owner product decision; record that intentional disposition.
- Pin legacy preference derivation with the same fixtures on both sides: all five runtimes, legacy keys, missing values, renamed entries, LWW conflicts and optimistic updates. Extract **one shared pure helper only if the logical transformation is actually identical**. Otherwise retain and document the distinct responsibilities; do not force unlike semantics into a generic abstraction.
- Large files are not mandatory split targets. Permit at most a small domain/helper extraction needed by these fixes, preserving public entrypoints; no new registry of handlers merely to reduce line counts. Do not remove Claude thinking-level fallbacks: the client already prefers matching server-advertised levels.

**Victory:** each removal has an import/mount inventory plus green real message/nav behaviour; no retained prototype is misrepresented as shipped functionality. Shared transformation, if extracted, has equivalent outputs at both real consumers. Changed source adds no lint warnings. Compare this programme's gzip bundle delta against a baseline carrying the same unrelated teammate changes; do not charge their changes to this programme. Growth above 1% is an owner-review threshold: explain the measured cause and seek approval before acceptance, rather than silently weakening the gate or automatically deleting useful behaviour to meet it. Test consolidation lists the old/new behaviour coverage, not only a new count.

## 11. Step 10 — integrated gates, resources and handoff

### Required final gates

Run against the final candidate, with commands/exits and fingerprint in the execution report:

```text
npm run docs:check-agent-guides
npm run docs:check-links
npm run lint
npm run typecheck
npm run build
npm test
npm run test:coverage
```

Plus the newly implemented discovery/ratchet/strict wrapper, deterministic compiled-server HTTP/WS/Command Code fixture smoke, required no-retry desktop/mobile browser suite and §§8–9 performance correctness/cost measurements. Use configured worker/resource limits; do not run several full suites/servers simultaneously on the live host. Existing truthful thresholds stay in force. New shared coverage has its recorded truthful ratchet; never change discovery or coverage excludes to hide difficult production files.

Keep source/build/runtime claims distinct:
- Real handler + fake provider is component integration proof.
- Real server/process/browser + deterministic fixture is platform-path proof.
- It is **not** proof of every current native CLI/provider/model.
- For changed runtime behaviour, run the relevant bounded real-runtime scenario on a disposable server when authorised and routed through current capabilities/models/headroom. Prefer one Pi and the actually affected optional runtime, not an exhaustive paid matrix. If no exact eligible route or authority exists, ask once and preserve the limitation; do not silently substitute a premium model.
- Antigravity lacks fully disposable native state; never treat `--runtime all` as authority to use it. Shared credentials/extension persistence remain live unless explicitly isolated. No global auth/model edits as a validation shortcut.
- For unchanged orchestration/compaction behaviour, reference the other owner's accepted proof and run the impacted deterministic regressions only; do not commission another full long-horizon programme.

### Independent final review

A fresh read-only reviewer checks the **diff, actual consumers, RED evidence, negative controls, budgets, benchmark subjects and final reports**. The executor independently reruns pointed checks, reproduces real findings and repairs them test-first. One bounded question batch for genuine unresolved points; no ceremonial repeated review loop.

The acceptance matrix must say for each ID: `fixed`, `already-fixed-and-reverified`, `measured-conditional-deferral`, `intentional-retained`, or `blocked-needs-owner`. Deferral is allowed only where this plan explicitly makes it conditional. Any blocked mandatory item prevents full completion. Confirm no unowned diffs, secrets, auth/session data, browser profiles, local manifests or generated runtime artefacts are staged.

### Documentation and contract handling

- Update the canonical test, observability, troubleshooting, live-validation and metadata docs where behaviour changed; add this plan/report to the maintainer index when coordinated ownership allows. Keep README short. AGENTS/CLAUDE remain byte-identical if touched.
- New API fields/statuses/replay completeness need the repository's additive versioning process and capability treatment as appropriate. **Do not reserve a version from this plan.** Baseline canonical code was 1.34.0; the active worktree already used 1.35.0 at planning time. Re-read current contract/history and coordinate before selecting the next value. Internal-only helper changes need no gratuitous version bump.
- Agent OS is a separate consumer. Prepare the precise contract delta and request explicit permission/coordination before editing its mirror/client or validating it. Do not use an archived plan's older cross-repo instruction as current approval. Mark consumer resynchronisation pending until its owner confirms it.
- Skills only need updates if a canonical operational command or factual workflow changed. Use the canonical shared skills source and skill-creator workflow; no skill evals required. Obtain scope for those cross-repo edits; do not duplicate repo docs into skills.
- Publish owned code/docs according to the authorised Git workflow. Never start/restart production to make deployed/source parity tests green. Report `source tested`, `committed/pushed`, `consumer synchronised`, and `deployed` independently. Production release and externally visible GitHub settings/submissions remain fresh-approval gates.

### Handoff must include

1. Baseline/final fingerprints and commits; owned changes and no-touch verification.
2. All 22 dispositions, concrete acceptance measurements and evidence pointers.
3. RED→GREEN commands/exits and independently exercised entrypoints.
4. Required/optional tests, retries/skips, fixture/real-provider boundaries and cleanup status.
5. Before/after performance raw samples and operation counts; conditional steps not taken and why.
6. Any blocked owner decision, consumer/deployment status and exact next resource to open.
7. Capture distinct grounded outcomes through the regular **“Identify and submit candidate-worthy outcomes that may help future work”** process. Prefer generous coverage of useful results/resources/constraints, not duplicate restatements or speculation. Pending evidence/candidates only; nothing approved/promoted by the executor. Notify the owner once at completion or when a consequential question blocks progress.

## 12. Complete audit disposition map

| Audit ID | Finding in brief | Planned disposition / victory owner |
|---|---|---|
| S1 | Copied model handlers in tests | Mandatory step 1A: real router; mutation caught |
| S2 | Source regex/synthetic render proof | Mandatory 1A: real targets and zero unrelated renders |
| S3 | Conditional/tautological E2E and misleading leak claims | Mandatory 4: seeded, outcome-based required tests |
| S4 | Synthetic benchmarks used as app proof | Mandatory 5: labels corrected and real-path workloads |
| S5 | Orphan/bypassed UI code and placeholders | Step 9: proven waste removed; intentional Tasks/prototypes explicitly retained as appropriate |
| S6 | Multi-domain hotspots, duplicate projections, warning drift | Mandatory 1B/7 ratchet and repeated-update repair; 9 pure dedup conditional; wholesale splitting excluded |
| P1 | Full JSONL parse before debounce | Mandatory 6B coalescing; incremental parsing only on the stated measurement trigger |
| P2 | Registry rewrite/lookup and diagnostics amplification | Mandatory 6A indexed/single-pass reads and durability-safe coalescing |
| P3 | Duplicate streaming state/size work | Mandatory 7A single atomic update and no full size scan per delta |
| P4 | Repeated linear replay target search | Mandatory 7B per-fold lookup and exact output equality |
| P5 | No aggregate broker replay/key bound | Mandatory 8 bounded retention with honest consumer signals; blocked, not quietly deferred, if compatibility authority needed |
| O1 | Sink/diagnostics redaction mismatch | Mandatory 2A safe projection at both sinks |
| O2 | Count-only bounds and unexplained evidence loss | Mandatory 2A byte/traversal/window/loss limits |
| O3 | Missing Command Code snapshot counters | Mandatory 2B exhaustive runtime and actual receipt-path proof |
| O4 | Unreadable state becomes healthy empty state | Mandatory 2B non-destructive unavailable/recovery semantics |
| O5 | Weak build identity and no useful lag history | Mandatory 3A identity and 5 bounded history |
| O6 | Diagnostics mainly accessible after React crash | Mandatory 4 normal-UI private export and async evidence |
| V1 | Shared/root test discovery omissions | Mandatory 1A all intended locations and failing sentinels |
| V2 | Guide-only CI | Mandatory 1B core CI, completed with 3 deterministic smoke |
| V3 | Unmanaged/unverified E2E target | Mandatory 3B identity-verified isolated wrapper |
| V4 | Source/dist proof gap and weak artefact provenance | Mandatory 3A/3C built smoke and run-scoped record |
| V5 | Exit 0 despite unexpected skips/cleanup uncertainty | Mandatory 3B strict acceptance negatives |

**Do not start execution from a bare “optimise everything” instruction.** On explicit owner go, begin at step 0, reconcile active work, and execute this sequence with the simple defaults above. Ask only when a consequential boundary or contradictory authoritative requirement needs a decision; ordinary engineering choices are the execution agent's job.
