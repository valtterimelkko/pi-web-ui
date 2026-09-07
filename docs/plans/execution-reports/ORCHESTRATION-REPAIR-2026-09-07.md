# Orchestration repair — 7 September 2026

Status: implementation, independent review/correction and disposable composition
verified; parent acceptance complete for source delivery. No production deployment
by this task. This report records evidence, not permission to restart a service
or load extensions. Git history records the integration/delivery commits.

## Intent and scope

Make parent/child supervision robust at the existing boundaries rather than add
another scheduler: cancellable Goal Engine continuation, honest pause state,
owner/generation-safe watches, bounded local deadlines, and current operational
guidance. Capacity/admission/SSE/validation teardown repairs were a separate
programme; this work starts from its accepted `3688297` baseline and preserves it.

All implementation children used Pi through the Internal API: Sol/medium for goal
and watch work, Luna/max for the deadline core. A/B local work and C's core were
independently reviewed. Pi Web UI changes used a detached worktree; shared
extension/skill commits were parent-owned and path-limited. The parent retained
its known-good wake relay and independent backstop until candidate activation
could be separately authorised.

## Delivered source

- Pi Enhancement: `aa9346c` goal lifecycle; `078806d`/`0bbb559` local watch lifecycle;
  `44fd9dd` deadline core; `c091af3` deadline host; `c0d4df6` capability-gated CAS
  client; `32a6744` makes in-run tool resume start a distinct governed run, and
  `4ef26a3` preserves fresh-generation events that arrive before acknowledgement.
  Earlier transport bootstrap `f5fb7d6` and real-Pi tool proof `4504185`.
- Server: `79b5167` generation preconditions and plain Pi pause reasons;
  `011b78c` malformed-body/migration correction; `9914bb2` immutable durable-cache
  rollback correction; `a4f239b` preserves rejected replacements, fences late
  completion and normalises wake targets; `67304d3` activates the committed
  observer before awaited claim rotation. Contract metadata is 1.35.0.
- Canonical skills: `e49306e` and `f15b62a`, preserving intervening capacity,
  steering, native-discovery and multi-phase guidance rather than applying a
  stale draft. No skill evals were requested or performed.

The [watch contract](../../INTERNAL-API.md#watch-long-horizon-validation) and
[contract changelog](../../INTERNAL-API-CONTRACT.md) are the protocol references.
The [watch-wake companion](https://github.com/valtterimelkko/pi-enhancement/tree/master/watch-wake)
is authoritative for the local tool and its activation/legacy limits.

## TDD and independent correction evidence

Parent probes were added before fixes, not merely after a child's green report:

- disposed deadline cancellation could append into an old host; a queued stale
  callback could hide a replacement timer from disposal;
- shutdown during local startup/capability discovery could allow later work to
  mutate or persist through a closed factory;
- a DELETE generation JSON body needed explicit Node HTTP framing to reach the
  server; unit-level argument inspection alone missed this;
- malformed/null chunked DELETE could become unconditional legacy deletion;
- failed legacy migration could be skipped on retry because cache already looked
  migrated;
- durable rollback could capture a mutable record after I/O rather than the
  serialized payload, or overwrite cache owned by a newer queued write.

Focused acceptance at server `9914bb2`: 14 new tests plus 113 adjacent tests and
server typecheck passed. The extension gate covers core deadlines, actual loaded
factory/tools, Unix transport, generation-aware client behaviour, existing watch
regressions and persistent real Pi tool execution. Source/store parity remains a
separate activation check; accepted source differing from an undeployed mirror
is not permission to deploy merely to make that test green.

## Independent review and final correction

One fresh read-only Sol/medium review returned NEEDS-CORRECTION. Parent reproduced
all four findings before fixes: paused-wake in-run resume accounting, failed
replacement destroying the prior observer, late one-shot completion crossing a
replacement, and padded target identity. One bounded pointed revalidation then
confirmed all four resolved, but found a new event-loss handover window.

Parent reproduced that exact window by holding replacement claim rotation after
the new generation was durable, then publishing a terminal broker event. Moving
activation before the awaited rotation retained it. A complementary client RED
showed response-count baselining could still discard that new-generation event;
fresh-generation cursor zero fixed it. Actual registered-tool Unix polling then
delivered the early event. This last bounded correction was parent-verified;
do not misrepresent the reviewer's earlier NEEDS-CORRECTION as an unconditional
ACCEPT of later commits. Final sign-off is the parent's evidence-backed verdict.

The goal correction required more than a boolean accounting guard: actual Pi
can drain shared follow-ups inside one low-level run. Explicit tool resume now
stays in the cancellable engine queue until true idle. The real Pi regression
charges 4,000 fixture input tokens rather than the historical 6,000, excludes the
paused wake, performs the resumed artefact write and completes in six requests.

## Full disposable real-runtime composition

The parent executed a real Pi Web UI server and three persistent Pi AgentSessions
with deterministic **local provider responses**. This tests real runtime/protocol
behaviour, not external model judgement, and makes no subscription calls for the
fixture. After corrections, the final scenario passed again at server `67304d3`
/ extension `4ef26a3`:

1. Parent writes a useful artefact, registers two child watches and a deadline,
   then deliberately pauses its goal.
2. A child's question/pause wakes the parent without auto-resuming its goal or
   spending paused goal turns.
3. Watch replacement changes generation; stale server preconditions and an old
   local cancellation handle cannot delete the replacement.
4. An isolated API restart preserves generation/firings as detached history,
   plus the parent's paused goal and local deadline.
5. Actual Pi compaction completes while the parent remains paused.
6. Both children achieve and produce artefacts; **two individually matched**
   registrations each consume a firing. No vacuous empty-list assertion.
7. Explicit **in-run model-facing tool resume**, not just an idle API command,
   starts one new governed run (counter 1→2), completes the goal and cancels its
   current watches and deadline.

The proof records actual compaction entries/input size, source commits, per-child
watch witnesses and actual process environments. Both owned server groups were
verified gone by the repaired stopper and independently checked again; temporary
fixture directories and dependency links were removed. No production validation.

Harness corrections were kept separate from product defects: the driver itself
needed DELETE Content-Length, and private SDK settings required
`PI_CODING_AGENT_DIR` **as well as** server `PI_AGENT_DIR`. Goal home, ownership
leases and browser preferences were private too; actual process environment was
checked rather than inferred from requested options.

Private bounded evidence/checkpoint: `orchestration-repair-20260907` under the
operator's Pi Web UI operations directory, especially `parent/ACCEPTANCE.md`,
`parent/composition-result.json`, the RED/GREEN logs and per-child frozen reports.
Raw sessions, runtime state, credentials and fixture artefacts are not committed.

## Final gates and limits

- Legacy clients can omit preconditions; their operations remain non-CAS.
  Conditional operations are atomic inside one server, not distributed consensus.
- A local deadline cannot rescue a blocked event loop/dead parent. Channel
  acceptance is not processing; a crash before persistence can replay a wake.
- Reusing a child goal can emit an old-goal clear during start. Operational
  guidance filters goal identity and retains a recovery backstop; a first firing
  is never acceptance.
- No extra orchestration daemon/job store was added: existing goals, watches,
  deadlines, receipts and a checkpoint provide the needed mechanical surface.
- Final server suite: **3,423 tests passed** across 289 files. Unchanged client,
  shared and MCP suites passed **941 +197 +71** tests respectively: 4,632 checks
  across the release surfaces. Bounded test-worker concurrency and explicit test
  environment avoided the initial six environment-sensitive admission/OpenCode
  failures; no production admission reservation was lowered.
- Full application typecheck/build pass; lint has zero errors and 1,690 warnings,
  plus the existing large-client-chunk build warning. Documentation guides and
  links pass. Logs are retained in the private evidence directory.
- An ad-hoc direct TypeScript invocation on Goal Engine files reports seven
  compatibility diagnostics identical on the pre-fix baseline and corrected
  source. It is not claimed green. Actual Pi loader/runtime tests and the
  relevant goal/compaction suites pass; this task did not expand into an
  unrelated TypeBox/legacy API compatibility rewrite.
- Production extension activation and service deployment remain separately
  permission-gated. A source commit, copied file or passing fixture does not
  prove that an already-running host loaded the new code.
