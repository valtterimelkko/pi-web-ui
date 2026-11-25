# Internal API queued delivery and alert robustness

Status: EXECUTING — owner activated 25 November 2026, 00:22 UTC. Pre-execution/design gates first; implementation not yet accepted.

## Intent and rationale

Reduce false failures, unsafe retries and noisy health warnings without weakening cancellation, cessation, admission, absolute budgets or restart safety. Evidence: the private five-day audit at `/root/orch-ops/internal-api-audit-20261124/REPORT.md` (34 automatic messages; eight Devin queued-wake start timeouts, capacity debt mistaken for leaks, command-induced Pi stalls, recovered lag). This plan contains no private logs or session dumps.

Canonical discovery: this plan → execution strategy and current checkpoint under `/root/orch-ops/api-robustness-20261125/`. Existing programme context: [orchestration scaling](ORCHESTRATION-SCALING-READINESS-PLAN.md), [parent machinery](PARENT-ORCHESTRATION-MACHINERY-PLAN.md), [Antigravity post-turn work](ANTIGRAVITY-POST-TURN-WORK-PLAN.md). Reuse their C2/I2/J3/L1 invariants; do not rebuild them. Agent OS's unified-coordination plan records absorbed/delivered phases; the older Pi copy is not fresh work.

## Authority and boundaries

Owner: “Write recommended actions as a plan. Then, do pre-execution & execution of that plan.” Also: “You have my permission during this session for production flush restarts.” Parent records full authority in STATE. Governed locked build/drain/restart, checkout guard and post-restart identity checks still apply. Prefer settled drain; default timeout abort, never casually cut off peers. No Claude Remote Control restart, gateway change, upstream/dependency patch, PAYG inference or architecture pivot. No production test traffic beyond separately authorised scope: use disposable validation and read-only production health/readback.

## Strategy and ownership

Parent: design, gate adjudication, integration, contract/docs and mirror glue, own probes, sole deployment/sign-off. Isolated worktrees per writer; at most two implementation workers and one consultant/reviewer concurrently; one heavy suite/disposable server at a time. Fresh cross-family reviewers; Claude Sonnet reviews safety-critical queue/cessation/admission changes. Read-only Fable whole-plan critic before design approval. Live model/quota/capacity discovery before dispatch; no silent substitution. Implementation goals only after their planned design gate.

| Lane | Bounded outcome | Owned paths | Dependency |
|---|---|---|---|
| A delivery | Receipt-owned Devin queue lifecycle and truthful no-activity notices; inspect Pi steer separately | Devin service/queue, internal-api/routes/sessions, run-receipts and dedicated tests | Design approval R0; serialise shared route changes with C |
| B debt | Separate attributable terminal debt from unexplained admission mismatch, keep genuine leak alert | observability health alerts/readings, new focused accounting seam and tests | R0; propose any run-manager/server seam in design, parent reserves/integrates it |
| C quota | Typed Devin quota/reset errors using existing vocabulary and conservative retry guidance | Devin error classifier, quota integration and tests | After A accepted; shared service/routes must not overlap writers |
| D operations | Runbook corrections for scoped searches/model-free waits; record unresolved Pi stalls and lag triggers | canonical troubleshooting/defect ledger/plan status docs | Parent after R1; no new global enforcement or generic tool keepalive without validated design |
| V validation | Independent integrated real-runtime disposable rerun | validation script/scenarios and private proof directory | A/B/C integrated and code-reviewed |

## Waves and review points

### W0 — pre-execution and R0 design review

Create strategy, STATE, frozen common/lane briefs, base commit and worktrees, recorded routes/leases/watches. Known-good supervision is parent local watch-wake plus model-free deadline; never depend on busy Devin wakes being repaired. Ask Fable to critique the entire plan. A and B stop at `01-design.md` with exact seams, invariants, cancellation race/state transitions and tests. Parent independently checks critiques and designs, amends downstream scope/order and answers in numbered files. No implementation before approval. Record any scope conflict as a question, not a silent override.

### W1 — A/B implementation, independent lane review, R1

A: RED on actual busy follow-up entry points, including server watch wakes and ordinary prompts; two uniquely identified FIFO items (also identical text), wait past start threshold, actual queued→dispatch lifecycle, one execution each, no false NEVER_STARTED. Receipt-scoped cancellation must settle dequeue race; terminalisation must not leave an item silently executable while advising retry. Unknown delivery remains unknown. Preserve late evidence separately from decision-time evidence. Validate Pi steer attribution before changing it; do not exempt every busy session from watchdogs.

B: RED on active + draining/quarantined debt + injected unowned permit, mixed runtimes, missing/stale source and release race. Correct ownership classification must not free permits or hide a real leak. Prefer identity-aligned snapshot; if reliable attribution unavailable preserve unknown/raw mismatch with honest wording. Existing grouping/recovery semantics survive.

Each worker: strict RED/GREEN, changed-path lint, focused tests/typecheck, clean local commit, frozen complete.md, verify.sh and evidence. Parent reads diff, reruns gates and authors independent probe before reviewer. Fresh Sonnet safety review; one correction and same-reviewer closure maximum, then parent final correction/verification if necessary. R1 evaluates what last changed and whether C/V need amended seams or extra correction lanes; no rubber-stamping green tests.

### W2 — C/D, R2

C: reproduce recorded Devin rate-limit shape using sanitised fixtures; classify quota vs transient vs other without capturing tokens or leaking private provider traces. Reuse existing provider-error receipt fields; carry reset information where safely established. Unknown stays unknown. No automatic retry loop, provider reroute or spend. Route-level coverage and targeted tests. Fresh cross-family review after parent verification. Parent owns any public contract bump and Agent OS downstream mirror sync before merge; avoid bump for internal-only changes but never hide changed public semantics.

D: update existing troubleshooting/recurring-defect guidance rather than a parallel manual. Specify no searches rooted at `/`, and no in-turn sleep/poll supervision. Two unresolved historical Pi stalls stay unresolved; no unsupported blanket Pi pending-tool deferral. Lag: retain current thresholds; document bounded profiling trigger on recurrence, not an architecture migration.

R2 reviews whether A/B resolved the causal cascade and whether C provides actionable reset guidance. Remove speculative work, add named interim lane for reproduced blockers; record rationale in this file.

### W3 — integration, independent live rerun, R3 release gate

Parent integrates frozen reviewed lanes in scratch integration worktree, hunk-level conflict resolution and line-survival checks. Against pre-programme base: diff check, changed-file lint, workspace typecheck/build, relevant server integration/client tests and full suite under resource cap. Diagnose failures, reproduce against base where needed; do not dismiss as flaky without evidence.

V is a fresh reviewer, not an implementation author: disposable built server with isolated state and agent directories, placement environment removed, bounded memory scope, approved subscription routes only. Arms fixed before running:
1. Busy Devin actual queue with two wakes outliving shortened start window; each tool side effect exactly once, receipt/events matched to item. Negative: genuinely undelivered item still detected honestly.
2. Cancellation/dequeue boundary and late events; no execution after confirmed targeted removal; no unrelated active turn aborted. Restart/disconnect persistence where supported; otherwise documented conservative unknown.
3. Pi normal turn and joined steer negative/positive controls; no regression in goal/watch completion semantics.
4. Debt and injected leak: debt fenced/classified, real leak alert and recovery proven. Missing-data arm stays unknown.
5. Quota fixture through real service/adapter boundary; real subscription smoke without forcing quota exhaustion. No Antigravity live validation or production fixture traffic.

Real runtime with deterministic provider/ACP fixture is labelled accurately, not external model capability. Add small real subscription route smoke where safe; at least one proof uses the actual runtime queue, not a mock of the queue under repair. Record final build commit, identity, counts, side effects, resource peak, teardown verification. Parent independently checks proof and any omissions before R3.

### W4 — deployment and R4 close-out

Recheck board/checkout/base branch, current HEAD, clean build inputs and peers. Notify deployment milestone. Serialised production lock wraps fresh build → drain-restart (timeout abort unless separately adjudicated) → authenticated readiness. Record old/new PID and health buildIdentity revision matching merged SHA, expected contract, drain idle/capacity and journal. Reconcile owned watches/children after restart. No unapproved synthetic production tests. Push only integrated green current branch; never lane branches. Rollback uses recorded known-good commit/build and same lock/drain protocol, never discard foreign work.

R4 compares delivered claims with original intent: code-reviewed, disposable-live-validated and production-activated are separate states. Report residuals explicitly; arrange bounded read-only later-traffic comparison if needed without claiming incident reduction from absence of short-window alerts. Release watches/leases, clean owned resources, update STATE/plan and capture evidence-backed outcomes. Telegram completion only once verified.

## Stop boundaries and quality gates

Ask owner only for genuine product/authority conflict, destructive recovery, non-permitted provider/dependency changes or unrecoverable resource exhaustion. Routine review, correction, integration and sequencing are autonomous. Every natural review point reconsiders findings against remaining work and records any amendment here. No blanket timeout increase, global busy keepalive, loss of quiescence fence, blind debt subtraction, raw evidence in public git, or silence-labelled success.

## Waiting on the owner

| Item | Since | Ref |
|---|---|---|

## Execution record

- 2026-11-25: activated; W0 starts. All acceptance and deployment claims pending. Initial base ecb090a58517774c932ee1004f6890733c17f7c2.
